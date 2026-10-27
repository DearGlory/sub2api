//go:build unit

package poison

import (
	"context"
	"sync"
	"testing"
	"time"
)

// TestSharedInitialReconcilePicksMostUsedProxy: the first bind follows the proxy
// used by the most admitted accounts; a tie resolves to the smaller proxy id, and
// blocked/deleted/disabled proxies are never chosen.
func TestSharedInitialReconcilePicksMostUsedProxy(t *testing.T) {
	h := newSharedTestDB(t)
	base := "https://kedaya.ai"
	p1 := h.addProxy("10.0.0.1", 8080, "active", false)
	p2 := h.addProxy("10.0.0.2", 8080, "active", false)
	p3 := h.addProxy("10.0.0.3", 8080, "active", false)
	h.exec(`INSERT INTO poison_blocked_egress(outbound_ip,proxy_id,reason) VALUES('10.0.0.3',$1,'seed')`, p3)
	_ = p2
	mk := func(proxy int64) int64 {
		id := proxy
		return h.addAccount(sharedAcct{BaseURL: base, ProxyID: &id})
	}
	// p1: two accounts, p2: one account -> p1 wins even though p2 is "occupied".
	a1 := mk(p1)
	a2 := mk(p1)
	a3 := mk(p2)
	probe := &probeScript{script: map[string]SharedProbeResult{}}
	co := NewSharedCoordinator(h.db, SharedOptions{
		Plan:     func(context.Context, *Snapshot) ([]SharedAccount, error) { return nil, nil },
		Probe:    probe.fn,
		Snapshot: sharedTestSnapshot,
	})
	if err := co.Reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	st, err := co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.SharedProxyID == nil || *st.SharedProxyID != p1 {
		t.Fatalf("initial pointer=%v, want the most-used proxy %d", st.SharedProxyID, p1)
	}
	if st.Generation != 1 {
		t.Fatalf("initial bind must invalidate pre-enable requests: %d", st.Generation)
	}
	for _, id := range []int64{a1, a2, a3} {
		if got := h.accountProxy(id); got == nil || *got != p1 {
			t.Fatalf("account %d=%v, want %d", id, got, p1)
		}
	}
}

// TestSharedTieBreaksToSmallerProxyID: equal usage resolves deterministically.
func TestSharedTieBreaksToSmallerProxyID(t *testing.T) {
	h := newSharedTestDB(t)
	base := "https://kedaya.ai"
	p1 := h.addProxy("10.0.0.1", 8080, "active", false)
	p2 := h.addProxy("10.0.0.2", 8080, "active", false)
	one, two := p1, p2
	h.addAccount(sharedAcct{BaseURL: base, ProxyID: &two})
	h.addAccount(sharedAcct{BaseURL: base, ProxyID: &one})
	co := NewSharedCoordinator(h.db, SharedOptions{
		Plan:     func(context.Context, *Snapshot) ([]SharedAccount, error) { return nil, nil },
		Probe:    (&probeScript{script: map[string]SharedProbeResult{}}).fn,
		Snapshot: sharedTestSnapshot,
	})
	if err := co.Reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	st, err := co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.SharedProxyID == nil || *st.SharedProxyID != p1 {
		t.Fatalf("tie resolved to %v, want the smaller id %d", st.SharedProxyID, p1)
	}
}

// TestSharedConcurrentHitReconcileAndProbe runs the three writers together and
// asserts the document stays consistent: one switch, one run, no partial binding,
// and no deadlock under -race.
func TestSharedConcurrentHitReconcileAndProbe(t *testing.T) {
	f := newSharedSwitchFixture(t)
	ctx := context.Background()
	old := int64(1)
	inc := Incident{AccountID: f.eligible[0], ProxyID: &old, ProxyHost: "10.0.0.1", ProxyPort: 8080, Reason: "veto:kedaya", SharedGeneration: 1}
	f.co.BackoffBase = time.Millisecond
	f.co.BackoffMax = 2 * time.Millisecond

	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, err := f.co.Handle(ctx, inc); err != nil {
				errs <- err
			}
		}()
	}
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := f.co.Reconcile(ctx); err != nil {
				errs <- err
			}
		}()
	}
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := f.co.Tick(ctx); err != nil {
				errs <- err
			}
		}()
	}
	done := make(chan struct{})
	go func() { wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatalf("concurrent writers deadlocked")
	}
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent error: %v", err)
	}
	st, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.Generation != 2 {
		t.Fatalf("generation=%d, want one initialization and one accepted switch", st.Generation)
	}
	if len(st.Runs) != 1 {
		t.Fatalf("runs=%d, want one frozen round", len(st.Runs))
	}
	if st.SharedProxyID == nil || *st.SharedProxyID != 2 {
		t.Fatalf("pointer=%v", st.SharedProxyID)
	}
	// Every admitted account must be on the pointer with the same generation: a
	// torn switch would leave a mix.
	for _, id := range f.eligible {
		got := f.h.accountProxy(id)
		if got == nil || *got != *st.SharedProxyID {
			t.Fatalf("account %d torn between proxies: %v (pointer %d)", id, got, *st.SharedProxyID)
		}
		if gen := f.h.accountGeneration(id); gen != st.Generation {
			t.Fatalf("account %d generation=%d pointer generation=%d", id, gen, st.Generation)
		}
	}
	if n := f.h.count(`SELECT count(*) FROM poison_blocked_egress WHERE outbound_ip='10.0.0.1'`); n != 1 {
		t.Fatalf("hit rows=%d, want one merged row", n)
	}
}
