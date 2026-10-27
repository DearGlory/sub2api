//go:build unit

package poison

import (
	"context"
	"sync"
	"testing"
)

// sharedSwitchFixture builds a pool where proxy 1 is the current shared target,
// proxy 2 is already used by another account (occupied but allowed), 3 is idle,
// 4 is disabled, 5 is soft-deleted and 6 is blacklisted.
type sharedSwitchFixture struct {
	h        *sharedTestDB
	co       *SharedCoordinator
	probe    *probeScript
	validMu  sync.Mutex
	validate []int64
	snapMu   sync.Mutex
	snap     *Snapshot
	eligible []int64
	mismatch int64
	deleted  int64
	disabled int64
	noSched  int64
}

func newSharedSwitchFixture(t *testing.T) *sharedSwitchFixture {
	t.Helper()
	h := newSharedTestDB(t)
	p1 := h.addProxy("10.0.0.1", 8080, "active", false)
	p2 := h.addProxy("10.0.0.2", 8080, "active", false)
	p3 := h.addProxy("10.0.0.3", 8080, "active", false)
	_ = p3
	p4 := h.addProxy("10.0.0.4", 8080, "disabled", false)
	_ = p4
	p5 := h.addProxy("10.0.0.5", 8080, "active", true)
	_ = p5
	p6 := h.addProxy("10.0.0.6", 8080, "active", false)
	h.exec(`INSERT INTO poison_blocked_egress(outbound_ip,proxy_id,reason) VALUES('10.0.0.6',$1,'seed')`, p6)

	base := "https://kedaya.ai"
	one, two := p1, p2
	f := &sharedSwitchFixture{h: h}
	active := h.addAccount(sharedAcct{BaseURL: base + "/v1", ProxyID: &one})
	active2 := h.addAccount(sharedAcct{BaseURL: base, ProxyID: &one})
	active3 := h.addAccount(sharedAcct{BaseURL: base + "/v1/messages", ProxyID: &one})
	f.disabled = h.addAccount(sharedAcct{BaseURL: base, ProxyID: &one, Status: "disabled"})
	f.noSched = h.addAccount(sharedAcct{BaseURL: base, ProxyID: &one, Unschedule: true})
	f.mismatch = h.addAccount(sharedAcct{BaseURL: "https://other.example", ProxyID: &one})
	f.deleted = h.addAccount(sharedAcct{BaseURL: base, ProxyID: &one, Deleted: true})
	occupied := h.addAccount(sharedAcct{BaseURL: base, ProxyID: &two})
	f.eligible = []int64{active, active2, active3, f.disabled, f.noSched, occupied}

	probe := &probeScript{script: map[string]SharedProbeResult{}}
	f.probe = probe
	f.snap = sharedTestSnapshot()
	f.co = NewSharedCoordinator(h.db, SharedOptions{
		// Every admitted account gets one frozen model, mirroring the model lane.
		Plan: func(ctx context.Context, _ *Snapshot) ([]SharedAccount, error) {
			rows, err := h.db.QueryContext(ctx, `SELECT id FROM accounts WHERE deleted_at IS NULL ORDER BY id`)
			if err != nil {
				return nil, err
			}
			defer rows.Close()
			var out []SharedAccount
			for rows.Next() {
				var id int64
				if err := rows.Scan(&id); err != nil {
					return nil, err
				}
				out = append(out, SharedAccount{ID: id, Model: "claude-sonnet-4", ModelRequests: 42})
			}
			return out, rows.Err()
		},
		Probe:    probe.fn,
		Snapshot: f.snapshot,
		ValidateProxy: func(_ context.Context, c RotationCandidate) error {
			f.validMu.Lock()
			f.validate = append(f.validate, c.ID)
			f.validMu.Unlock()
			return nil
		},
	})
	if err := f.co.Reconcile(context.Background()); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	return f
}

func (f *sharedSwitchFixture) snapshot() *Snapshot {
	f.snapMu.Lock()
	defer f.snapMu.Unlock()
	return f.snap
}

func (f *sharedSwitchFixture) setSharedEnabled(on bool) {
	f.snapMu.Lock()
	defer f.snapMu.Unlock()
	snap := *f.snap
	snap.SharedEnabled = on
	f.snap = &snap
}

// drainTicks runs worker passes until the run is terminal or the budget is spent.
func (f *sharedSwitchFixture) drainTicks(t *testing.T, budget int) *SharedRun {
	t.Helper()
	for i := 0; i < budget; i++ {
		if err := f.co.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
		state, err := f.co.State(context.Background())
		if err != nil {
			t.Fatalf("state: %v", err)
		}
		if len(state.Runs) == 0 {
			return nil
		}
		if state.Runs[len(state.Runs)-1].Terminal() {
			last := state.Runs[len(state.Runs)-1]
			return &last
		}
	}
	state, _ := f.co.State(context.Background())
	if len(state.Runs) == 0 {
		return nil
	}
	last := state.Runs[len(state.Runs)-1]
	return &last
}

func (f *sharedSwitchFixture) validated() []int64 {
	f.validMu.Lock()
	defer f.validMu.Unlock()
	return append([]int64(nil), f.validate...)
}

// TestSharedSwitchRewritesEveryEligibleAccount pins the atomic all-account switch:
// occupied targets are allowed, inactive/unschedulable accounts follow, disabled,
// soft-deleted and blacklisted proxies are never selected, and only the proxy,
// generation marker and outbox row change.
func TestSharedSwitchRewritesEveryEligibleAccount(t *testing.T) {
	f := newSharedSwitchFixture(t)
	ctx := context.Background()

	oldProxy := int64(1)
	inc := Incident{AccountID: f.eligible[0], ProxyID: &oldProxy, ProxyHost: "10.0.0.1", ProxyPort: 8080, Reason: "veto:kedaya", RequestID: "req-1"}
	disp, err := f.co.Handle(ctx, inc)
	if err != nil {
		t.Fatalf("handle: %v", err)
	}
	if disp.Outcome != "shared_switched" {
		t.Fatalf("outcome=%q reason=%q", disp.Outcome, disp.Reason)
	}
	if got := f.validated(); len(got) != 1 || got[0] != 2 {
		t.Fatalf("validated candidates = %v, want [2]", got)
	}
	for _, id := range f.eligible {
		if got := f.h.accountProxy(id); got == nil || *got != 2 {
			t.Fatalf("account %d proxy=%v, want 2", id, got)
		}
		if got := f.h.accountGeneration(id); got != 1 {
			t.Fatalf("account %d generation=%d, want 1", id, got)
		}
	}
	// Business state and unrelated extra keys must survive the switch.
	if got := f.h.one(`SELECT status FROM accounts WHERE id=$1`, f.disabled); got != "disabled" {
		t.Fatalf("inactive account status=%q", got)
	}
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE schedulable=false AND proxy_id=2`); n != 1 {
		t.Fatalf("unschedulable account did not follow: %d", n)
	}
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE extra->>'keep_me'='yes' AND proxy_id=2`); n != len(f.eligible) {
		t.Fatalf("extra merge lost keep_me on %d accounts, want %d", n, len(f.eligible))
	}
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE credentials->>'api_key'='sk-secret-must-not-leak'`); n != 8 {
		t.Fatalf("credentials rewritten, api_key rows=%d", n)
	}
	// Non-eligible rows stay where they were.
	if got := f.h.accountProxy(f.mismatch); got == nil || *got != 1 {
		t.Fatalf("base_url-mismatched account moved: %v", got)
	}
	if got := f.h.accountProxy(f.deleted); got == nil || *got != 1 {
		t.Fatalf("deleted account moved: %v", got)
	}
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE deleted_at IS NOT NULL AND proxy_id=2`); n != 0 {
		t.Fatalf("deleted account joined the shared target")
	}
	// Exactly one outbox burst covering every eligible account.
	ids := f.h.lastOutboxBulk()
	set := map[int64]bool{}
	for _, id := range ids {
		set[id] = true
	}
	for _, id := range f.eligible {
		if !set[id] {
			t.Fatalf("outbox missing account %d (got %v)", id, ids)
		}
	}
	if len(ids) != len(f.eligible) {
		t.Fatalf("outbox ids=%v, want exactly %d", ids, len(f.eligible))
	}
	// Old egress is blacklisted once and a cut-back run is frozen with every account.
	if blocked := f.h.blockedIPs(); blocked["10.0.0.1"] != 1 {
		t.Fatalf("blacklist=%v", blocked)
	}
	state, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if state.Generation != 1 || state.SharedProxyID == nil || *state.SharedProxyID != 2 {
		t.Fatalf("state gen=%d pointer=%v", state.Generation, state.SharedProxyID)
	}
	if len(state.Runs) != 1 {
		t.Fatalf("runs=%d", len(state.Runs))
	}
	run := state.Runs[0]
	if run.Kind != SharedRunAuto || !run.CutBack || run.OutboundIP != "10.0.0.1" {
		t.Fatalf("run=%+v", run)
	}
	if len(run.Cells) != len(f.eligible) || run.Counts.Expected != len(f.eligible) {
		t.Fatalf("cells=%d expected=%d want %d", len(run.Cells), run.Counts.Expected, len(f.eligible))
	}
	if f.probe.callsFor(0, 0) != 0 {
		t.Fatalf("probe must not run during switch")
	}
}

// TestSharedDuplicateIncidentSwitchesOnce proves concurrent copies of the same hit
// converge on exactly one generation bump, one run and one binding rewrite.
func TestSharedDuplicateIncidentSwitchesOnce(t *testing.T) {
	f := newSharedSwitchFixture(t)
	ctx := context.Background()
	oldProxy := int64(1)
	inc := Incident{AccountID: f.eligible[0], ProxyID: &oldProxy, ProxyHost: "10.0.0.1", ProxyPort: 8080, Reason: "veto:kedaya"}
	var wg sync.WaitGroup
	outcomes := make([]string, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			d, err := f.co.Handle(ctx, inc)
			if err != nil {
				outcomes[i] = "error:" + err.Error()
				return
			}
			outcomes[i] = d.Outcome
		}(i)
	}
	wg.Wait()
	switched := 0
	for _, o := range outcomes {
		switch o {
		case "shared_switched":
			switched++
		case "stale":
		default:
			t.Fatalf("unexpected outcome %q (all=%v)", o, outcomes)
		}
	}
	if switched != 1 {
		t.Fatalf("outcomes=%v, want exactly one switch", outcomes)
	}
	state, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if state.Generation != 1 || len(state.Runs) != 1 {
		t.Fatalf("gen=%d runs=%d", state.Generation, len(state.Runs))
	}
	if blocked := f.h.blockedIPs(); blocked["10.0.0.1"] != 1 {
		t.Fatalf("blacklist=%v", blocked)
	}
}

// TestSharedStaleIncidentCannotRelockOrSwitch: an incident carrying an older
// generation must not blacklist, switch or create a run.
func TestSharedStaleIncidentCannotRelockOrSwitch(t *testing.T) {
	f := newSharedSwitchFixture(t)
	ctx := context.Background()
	oldProxy := int64(1)
	if _, err := f.co.Handle(ctx, Incident{AccountID: f.eligible[0], ProxyID: &oldProxy, ProxyHost: "10.0.0.1", ProxyPort: 8080, Reason: "veto:kedaya"}); err != nil {
		t.Fatalf("first switch: %v", err)
	}
	staleProxy := int64(1)
	d, err := f.co.Handle(ctx, Incident{AccountID: f.eligible[1], ProxyID: &staleProxy, ProxyHost: "10.0.0.1", ProxyPort: 8080, Reason: "veto:kedaya", SharedGeneration: 0})
	if err != nil {
		t.Fatalf("stale handle: %v", err)
	}
	if d.Outcome != "stale" {
		t.Fatalf("outcome=%q want stale", d.Outcome)
	}
	state, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if state.Generation != 1 || len(state.Runs) != 1 {
		t.Fatalf("gen=%d runs=%d", state.Generation, len(state.Runs))
	}
	if n := f.h.count(`SELECT count(*) FROM poison_blocked_egress`); n != 2 {
		t.Fatalf("stale incident wrote blacklist rows: %d", n)
	}
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE proxy_id=2`); n != len(f.eligible) {
		t.Fatalf("stale incident rebound accounts: %d", n)
	}
}
