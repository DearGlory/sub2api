//go:build unit

package poison

import (
	"context"
	"testing"
	"time"
)

func TestSharedParentWorkerStartsWithReconcile(t *testing.T) {
	h := newSharedTestDB(t)
	p := h.addProxy("10.0.0.1", 8080, "active", false)
	q := h.addProxy("10.0.0.2", 8080, "active", false)
	a := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &p})
	b := h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &q})
	co := NewSharedCoordinator(h.db, SharedOptions{Snapshot: sharedTestSnapshot})
	co.Interval = 20 * time.Millisecond
	co.Start(context.Background())
	defer co.Stop()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		st, err := co.State(context.Background())
		if err == nil && st.SharedProxyID != nil && *h.accountProxy(a) == *h.accountProxy(b) && h.accountGeneration(a) > 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("worker never initialized the shared binding")
}
func TestSharedParentWorkerContinuesReadyCells(t *testing.T) {
	f := newSharedSwitchFixture(t)
	inc := parentCurrentIncident(f)
	if _, err := f.co.Handle(context.Background(), inc); err != nil {
		t.Fatal(err)
	}
	f.co.Interval = time.Second
	f.co.Start(context.Background())
	defer f.co.Stop()
	deadline := time.Now().Add(800 * time.Millisecond)
	for time.Now().Before(deadline) {
		if len(f.probe.snapshot()) >= len(f.eligible) {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("ready cells slept per poll interval: %d/%d", len(f.probe.snapshot()), len(f.eligible))
}
func TestSharedParentStartDisabledHasNoWorker(t *testing.T) {
	f := newSharedSwitchFixture(t)
	f.setSharedEnabled(false)
	f.co.Start(context.Background())
	defer f.co.Stop()
	f.co.mu.Lock()
	started := f.co.started
	f.co.mu.Unlock()
	if started {
		t.Fatal("disabled shared mode launched worker")
	}
}
