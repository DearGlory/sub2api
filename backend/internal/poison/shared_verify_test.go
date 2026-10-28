//go:build unit

package poison

import (
	"context"
	"strings"
	"testing"
	"time"
)

// switchTo performs the first incident switch and returns the created run.
func (f *sharedSwitchFixture) switchTo(t *testing.T) *SharedRun {
	t.Helper()
	old := int64(1)
	d, err := f.co.Handle(context.Background(), Incident{
		AccountID: f.eligible[0], ProxyID: &old, ProxyHost: "10.0.0.1", ProxyPort: 8080, Reason: "veto:kedaya", SharedGeneration: 1,
	})
	if err != nil {
		t.Fatalf("handle: %v", err)
	}
	if d.Outcome != "shared_switched" {
		t.Fatalf("switch outcome=%q reason=%q", d.Outcome, d.Reason)
	}
	st, err := f.co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	run := st.Runs[len(st.Runs)-1]
	return &run
}

// TestSharedAllCleanCutsBackToOldProxy: every frozen account reports clean, so the
// egress is unblacklisted, the fleet returns to it and the generation advances
// again. The probe must never touch the account rows themselves.
func TestSharedAllCleanCutsBackToOldProxy(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	before := f.state(t)
	if run.ProxyID == nil || *run.ProxyID != 1 {
		t.Fatalf("run proxy=%v", run.ProxyID)
	}
	if got := f.h.one(`SELECT status FROM accounts WHERE id=$1`, f.disabled); got != "disabled" {
		t.Fatalf("switch changed business state")
	}
	f.co.BackoffBase = time.Millisecond
	done := f.drainTicks(t, 40)
	if done == nil || done.State != SharedRunReleased {
		t.Fatalf("run state=%v", done)
	}
	if got := f.h.blockedIPs(); len(got) != 1 {
		t.Fatalf("blacklist=%v (only the seeded 10.0.0.6 row may remain)", got)
	} else if _, still := got["10.0.0.1"]; still {
		t.Fatalf("verified egress was not unblacklisted: %v", got)
	}
	st, err := f.co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.Generation != before.Generation+1 || st.SharedProxyID == nil || *st.SharedProxyID != 1 {
		t.Fatalf("gen=%d (before %d) pointer=%v", st.Generation, before.Generation, st.SharedProxyID)
	}
	for _, id := range f.eligible {
		if got := f.h.accountProxy(id); got == nil || *got != 1 {
			t.Fatalf("account %d not cut back: %v", id, got)
		}
		if got := f.h.accountGeneration(id); got != before.Generation+1 {
			t.Fatalf("account %d generation=%d, want %d", id, got, before.Generation+1)
		}
	}
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE status='disabled' AND proxy_id=1`); n != 1 {
		t.Fatalf("inactive account lost its status: %d", n)
	}
	// Probing and cutting back are read-only with respect to everything else.
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE credentials->>'api_key'='sk-secret-must-not-leak' AND extra->>'keep_me'='yes'`); n != 8 {
		t.Fatalf("probe/cut-back rewrote account business fields: %d rows intact", n)
	}
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE schedulable=false AND proxy_id=1`); n != 1 {
		t.Fatalf("unschedulable marker lost: %d", n)
	}
	calls := f.probe.snapshot()
	if len(calls) != len(f.eligible) {
		t.Fatalf("probe calls=%d want %d", len(calls), len(f.eligible))
	}
	for _, c := range calls {
		if c.ProxyID != 1 {
			t.Fatalf("probe used proxy %d, want the old proxy 1", c.ProxyID)
		}
	}
}

// TestSharedAnyPoisonKeepsBlacklist: one confirmed hit keeps the row, blocks the
// cut-back and leaves the fleet on the new proxy.
func TestSharedAnyPoisonKeepsBlacklist(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	before := f.state(t)
	victim := run.Cells[2].AccountID
	f.probe.mu.Lock()
	f.probe.script = map[string]SharedProbeResult{
		keyOf(victim, 1): {Verdict: SharedCellPoison, Reason: "veto", Matched: []string{"kedaya"}},
	}
	f.probe.mu.Unlock()
	f.co.BackoffBase = time.Millisecond
	done := f.drainTicks(t, 80)
	if done == nil || done.State != SharedRunConfirmed {
		t.Fatalf("run state=%v", done)
	}
	if got := f.h.blockedIPs(); got["10.0.0.1"] != 1 {
		t.Fatalf("blacklist=%v, the poisoned egress must stay", got)
	}
	st, err := f.co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.Generation != before.Generation || st.SharedProxyID == nil || *st.SharedProxyID != 2 {
		t.Fatalf("confirmed poison must not cut back: gen=%d (before %d) pointer=%v", st.Generation, before.Generation, st.SharedProxyID)
	}
	if n := f.h.count(`SELECT count(*) FROM accounts WHERE proxy_id=2`); n != len(f.eligible) {
		t.Fatalf("accounts moved back despite poison: %d", n)
	}
	if done.Counts.Expected != len(f.eligible) {
		t.Fatalf("round scope shrank: expected=%d want %d", done.Counts.Expected, len(f.eligible))
	}
}

// TestSharedInconclusiveIsNeverClean proves a failed probe is re-queued, keeps the
// blacklist row, and only a later clean answer releases it.
func TestSharedInconclusiveIsNeverClean(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	var flaky int64 = run.Cells[0].AccountID
	f.probe.mu.Lock()
	f.probe.behave = func(call probeCall, nth int) SharedProbeResult {
		if call.AccountID == flaky && nth == 1 {
			return SharedProbeResult{Verdict: SharedCellInconclusive, Reason: "timeout"}
		}
		return SharedProbeResult{Verdict: SharedCellClean}
	}
	f.probe.mu.Unlock()
	f.co.BackoffBase = time.Millisecond
	f.co.BackoffMax = 2 * time.Millisecond

	// One full pass: the flaky account must be queued again, not released.
	for i := 0; i < len(f.eligible); i++ {
		if err := f.co.Tick(context.Background()); err != nil {
			t.Fatalf("tick: %v", err)
		}
	}
	st, err := f.co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	mid := st.Runs[0]
	if mid.Terminal() {
		t.Fatalf("run terminated with an inconclusive cell: %+v", mid.Counts)
	}
	if mid.Counts.Inconclusive != 1 || mid.Counts.Pending != 1 {
		t.Fatalf("counts=%+v, want one inconclusive pending cell", mid.Counts)
	}
	if got := f.h.blockedIPs(); got["10.0.0.1"] != 1 {
		t.Fatalf("inconclusive cleared the blacklist: %v", got)
	}
	if st.SharedProxyID == nil || *st.SharedProxyID != 2 {
		t.Fatalf("inconclusive cut back: %v", st.SharedProxyID)
	}
	done := f.drainTicks(t, 40)
	if done == nil || done.State != SharedRunReleased {
		t.Fatalf("final state=%v", done)
	}
	if f.probe.callsFor(flaky, 1) < 2 {
		t.Fatalf("flaky account was not retried: %d", f.probe.callsFor(flaky, 1))
	}
}

// TestSharedBackfillReleasesWithoutCuttingBack covers the historical round: every
// blacklist row is verified once (soft-deleted proxies keep their configuration),
// rows are deleted on all-clean, and the shared pointer never moves.
func TestSharedBackfillReleasesWithoutCuttingBack(t *testing.T) {
	f := newSharedSwitchFixture(t)
	ctx := context.Background()
	// Legacy row with proxy_id plus a row pointing at a soft-deleted proxy.
	f.h.exec(`INSERT INTO poison_blocked_egress(outbound_ip,proxy_id,reason) VALUES('10.0.0.1',1,'legacy')`)
	f.h.exec(`INSERT INTO poison_blocked_egress(outbound_ip,proxy_id,reason) VALUES('10.0.0.5',5,'legacy-deleted')`)
	before, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	batch, err := f.co.EnqueueBackfill(ctx)
	if err != nil {
		t.Fatalf("backfill: %v", err)
	}
	if batch == "" {
		t.Fatalf("backfill returned no batch id")
	}
	st, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	created := len(st.Runs) - len(before.Runs)
	if created != 3 {
		t.Fatalf("backfill runs=%d, want one per blacklist row (3)", created)
	}
	// Every round freezes the full admitted account set, not just the accounts that
	// happen to be on the proxy under test.
	for _, r := range st.Runs[len(before.Runs):] {
		if r.Counts.Expected != len(f.eligible) {
			t.Fatalf("run %s expected=%d, want %d", r.OutboundIP, r.Counts.Expected, len(f.eligible))
		}
	}
	// Idempotent enqueue: open backfill runs are not duplicated.
	if again, err := f.co.EnqueueBackfill(ctx); err != nil || again != "" {
		t.Fatalf("second enqueue created %q err=%v", again, err)
	}
	f.co.BackoffBase = time.Millisecond
	for i := 0; i < 200; i++ {
		if err := f.co.Tick(ctx); err != nil {
			t.Fatalf("tick: %v", err)
		}
		st, err := f.co.State(ctx)
		if err != nil {
			t.Fatalf("state: %v", err)
		}
		open := 0
		for _, r := range st.Runs {
			if r.Kind == SharedRunBackfill && !r.Terminal() {
				open++
			}
		}
		if open == 0 {
			break
		}
	}
	st, err = f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	for _, r := range st.Runs {
		if r.Kind != SharedRunBackfill {
			continue
		}
		if r.State != SharedRunReleasedOld {
			t.Fatalf("backfill run %s state=%s reason=%s", r.OutboundIP, r.State, r.ReleaseReason)
		}
		if r.CutBack {
			t.Fatalf("backfill run asked for a cut-back")
		}
	}
	if got := f.h.blockedIPs(); len(got) != 0 {
		t.Fatalf("blacklist not fully released: %v", got)
	}
	if st.Generation != before.Generation || st.SharedProxyID == nil || *st.SharedProxyID != *before.SharedProxyID {
		t.Fatalf("backfill moved the shared pointer: gen=%d pointer=%v", st.Generation, st.SharedProxyID)
	}
	for _, id := range f.eligible {
		if got := f.h.accountProxy(id); got == nil || *got != *before.SharedProxyID {
			t.Fatalf("backfill rebound account %d to %v", id, got)
		}
	}
	if f.probe.callsFor(f.eligible[0], 5) == 0 {
		t.Fatalf("soft-deleted proxy was never probed")
	}
	if got := f.h.count(`SELECT count(*) FROM proxies WHERE id=5 AND deleted_at IS NOT NULL`); got != 1 {
		t.Fatalf("deleted proxy was restored")
	}
}

// TestSharedReleaseRefusesNewerHit: a hit recorded after the run was frozen must
// survive the older clean verdict, and no cut-back may happen onto a blocked egress.
func TestSharedReleaseRefusesNewerHit(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	// Complete every cell but the last, then record a newer hit on the same egress.
	f.co.BackoffBase = time.Millisecond
	for i := 0; i < len(run.Cells)-1; i++ {
		if err := f.co.Tick(context.Background()); err != nil {
			t.Fatalf("tick: %v", err)
		}
	}
	f.h.exec(`UPDATE poison_blocked_egress SET hit_count = hit_count + 1 WHERE outbound_ip='10.0.0.1'`)
	done := f.drainTicks(t, 20)
	if done == nil {
		t.Fatalf("no run")
	}
	if done.State == SharedRunReleased {
		t.Fatalf("older clean round cut back onto a re-hit egress (reason=%s)", done.ReleaseReason)
	}
	if got := f.h.blockedIPs(); got["10.0.0.1"] != 2 {
		t.Fatalf("newer hit was cleared: %v", got)
	}
	if !strings.Contains(done.ReleaseReason, "new_hit_retained") {
		t.Fatalf("reason=%q", done.ReleaseReason)
	}
	st, err := f.co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.SharedProxyID == nil || *st.SharedProxyID != 2 {
		t.Fatalf("fleet moved onto a still-blocked egress: %v", st.SharedProxyID)
	}
}

// TestSharedWorkerLeaseBlocksPeerAndResumes verifies the persistent lease: another
// instance cannot drive a live run, an expired lease is resumed, an interrupted
// attempt is retried, and finished cells are never probed twice.
func TestSharedWorkerLeaseBlocksPeerAndResumes(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	ctx := context.Background()
	if err := f.co.Tick(ctx); err != nil {
		t.Fatalf("first tick: %v", err)
	}
	first := len(f.probe.snapshot())
	if first != 1 {
		t.Fatalf("probe calls=%d after one tick", first)
	}
	f.h.patchState(func(st *SharedState) {
		st.Runs[0].LeaseOwner = "peer-instance"
		st.Runs[0].LeaseUntil = time.Now().Add(time.Hour)
	})
	if err := f.co.Tick(ctx); err != nil {
		t.Fatalf("peer tick: %v", err)
	}
	if got := len(f.probe.snapshot()); got != first {
		t.Fatalf("a live foreign lease did not block the peer: %d -> %d", first, got)
	}
	// Crash simulation: the lease expired and the in-flight attempt was never
	// written, so the same account must be probed again.
	firstAccount := f.probe.snapshot()[0].AccountID
	f.h.patchState(func(st *SharedState) {
		st.Runs[0].LeaseOwner = ""
		st.Runs[0].LeaseUntil = time.Time{}
		for i := range st.Runs[0].Cells {
			cell := &st.Runs[0].Cells[i]
			if cell.AccountID == firstAccount {
				cell.Status = SharedCellRunning
				cell.Verdict = ""
				cell.LeaseOwner = "crashed-instance"
				cell.LeaseUntil = time.Now().Add(-time.Minute)
			}
		}
	})
	f.co.BackoffBase = time.Millisecond
	f.co.BackoffMax = time.Millisecond
	deadline := len(run.Cells) * 3
	for i := 0; i < deadline; i++ {
		if err := f.co.Tick(ctx); err != nil {
			t.Fatalf("resume tick: %v", err)
		}
	}
	if got := f.probe.callsFor(firstAccount, 1); got < 2 {
		t.Fatalf("interrupted attempt was not resumed: %d probes", got)
	}
	counts := map[int64]int{}
	for _, c := range f.probe.snapshot() {
		counts[c.AccountID]++
	}
	for account, n := range counts {
		if n > 2 {
			t.Fatalf("account %d probed %d times on a clean round: %v", account, n, counts)
		}
	}
	if len(counts) != len(run.Cells) {
		t.Fatalf("not every cell was attempted: %v", counts)
	}
}

// TestSharedStaleAttemptCannotBeWritten: a verdict arriving under a different
// attempt number is discarded, which is what protects a restarted worker.
func TestSharedStaleAttemptCannotBeWritten(t *testing.T) {
	f := newSharedSwitchFixture(t)
	f.switchTo(t)
	ctx := context.Background()
	if err := f.co.Tick(ctx); err != nil {
		t.Fatalf("tick: %v", err)
	}
	f.h.patchState(func(st *SharedState) {
		for i := range st.Runs[0].Cells {
			if st.Runs[0].Cells[i].Status == SharedCellRunning {
				st.Runs[0].Cells[i].Attempts++
			}
		}
	})
	state, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	interrupted := state.Runs[0].Cells[0].AccountID
	f.h.patchState(func(st *SharedState) {
		for i := range st.Runs[0].Cells {
			cell := &st.Runs[0].Cells[i]
			if cell.AccountID == interrupted {
				cell.Status = SharedCellRunning
				cell.Verdict = ""
				cell.Attempts = 2
				cell.LeaseOwner = f.co.Owner()
				cell.LeaseUntil = time.Now().Add(time.Minute)
			}
		}
	})
	if err := f.co.finish(ctx, &claimedCell{RunID: state.Runs[0].ID, AccountID: interrupted, Attempt: 1}, SharedProbeResult{Verdict: SharedCellClean}, nil); err != nil {
		t.Fatalf("stale finish: %v", err)
	}
	st, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.Runs[0].Counts.Clean != 0 {
		t.Fatalf("stale attempt was written: %+v", st.Runs[0].Counts)
	}
}

// TestSharedWaitingRunRecoversWhenCandidateAppears: with no usable candidate the
// fleet stays put and the round still runs; once a candidate appears the switch
// happens and the waiting run becomes a cut-back candidate.
func TestSharedWaitingRunRecoversWhenCandidateAppears(t *testing.T) {
	h := newSharedTestDB(t)
	p1 := h.addProxy("10.0.0.1", 8080, "active", false)
	base := "https://kedaya.ai"
	one := p1
	changed := true
	a1 := h.addAccount(sharedAcct{BaseURL: base, ProxyID: &one})
	a2 := h.addAccount(sharedAcct{BaseURL: base, ProxyID: &one})
	probe := &probeScript{script: map[string]SharedProbeResult{}}
	co := NewSharedCoordinator(h.db, SharedOptions{
		Plan: func(_ context.Context, _ *Snapshot) ([]SharedAccount, error) {
			return []SharedAccount{{ID: a1, Model: "claude-sonnet-4"}, {ID: a2, Model: "claude-sonnet-4"}}, nil
		},
		Probe:    probe.fn,
		Snapshot: sharedTestSnapshot,
		ValidateProxy: func(context.Context, RotationCandidate) error {
			if !changed {
				return rotationError("probe_failed", ErrRotationUnavailable)
			}
			return nil
		},
	})
	ctx := context.Background()
	if err := co.Reconcile(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	changed = false
	d, err := co.Handle(ctx, Incident{AccountID: a1, ProxyID: &one, ProxyHost: "10.0.0.1", ProxyPort: 8080, Reason: "veto", SharedGeneration: 1})
	if err != nil {
		t.Fatalf("handle: %v", err)
	}
	if d.Outcome != "shared_disabled" {
		t.Fatalf("outcome=%q reason=%q", d.Outcome, d.Reason)
	}
	st, err := co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if !st.WaitingForProxy || len(st.Runs) != 1 || !st.Runs[0].WaitingForCandidate {
		t.Fatalf("waiting state not recorded: %+v", st)
	}
	if n := h.count(`SELECT count(*) FROM accounts WHERE proxy_id=1`); n != 2 {
		t.Fatalf("accounts moved without a candidate: %d", n)
	}
	// A usable proxy appears; reconciliation must complete the deferred switch.
	changed = true
	p3 := h.addProxy("10.0.0.3", 8080, "active", false)
	if err := co.Reconcile(ctx); err != nil {
		t.Fatalf("reconcile 2: %v", err)
	}
	st, err = co.State(ctx)
	if err != nil {
		t.Fatalf("state 2: %v", err)
	}
	if st.SharedProxyID == nil || *st.SharedProxyID != p3 {
		t.Fatalf("pointer=%v, want the new candidate %d", st.SharedProxyID, p3)
	}
	if st.WaitingForProxy {
		t.Fatalf("still waiting after a candidate appeared")
	}
	for _, id := range []int64{a1, a2} {
		if got := h.accountProxy(id); got == nil || *got != p3 {
			t.Fatalf("account %d not switched to the recovered candidate: %v", id, got)
		}
	}
	if st.Generation != 3 {
		t.Fatalf("generation=%d, want 3 after the deferred switch", st.Generation)
	}
	if !st.Runs[0].CutBack || st.Runs[0].TargetProxyID == nil || *st.Runs[0].TargetProxyID != p3 {
		t.Fatalf("waiting run did not become a cut-back candidate: %+v", st.Runs[0])
	}
}

// TestSharedCutBackRespectsRestoreEpoch: an account an administrator rebound after
// the run was frozen is not dragged back with the rest of the fleet — and, since a
// partial cut-back would split the fleet (Reconcile then rewrites the restored
// account back onto the shared pointer), the cut-back is skipped for everyone
// while the proven-clean blacklist row is still removed.
func TestSharedCutBackRespectsRestoreEpoch(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	before := f.state(t)
	restored := run.Cells[1].AccountID
	// Admin restore: epoch bumps and the account is manually put back on proxy 3.
	f.h.setRestoreEpoch(restored, 1)
	f.h.exec(`UPDATE accounts SET proxy_id=3 WHERE id=$1`, restored)
	f.co.BackoffBase = time.Millisecond
	done := f.drainTicks(t, 60)
	if done == nil || done.State != SharedRunReleasedOld {
		t.Fatalf("state=%v reason=%s, want a release without a cut-back", done, done.ReleaseReason)
	}
	if got := f.h.accountProxy(restored); got == nil || *got != 3 {
		t.Fatalf("admin-restored account was overwritten: %v", got)
	}
	for _, id := range f.eligible {
		if id == restored {
			continue
		}
		if got := f.h.accountProxy(id); got == nil || *got != 2 {
			t.Fatalf("account %d was cut back over a drifted fleet: %v", id, got)
		}
	}
	if !strings.Contains(done.ReleaseReason, "epoch_drift") {
		t.Fatalf("reason=%q", done.ReleaseReason)
	}
	if _, still := f.h.blockedIPs()["10.0.0.1"]; still {
		t.Fatalf("proven-clean egress was not unblocked: %v", f.h.blockedIPs())
	}
	st := f.state(t)
	if st.Generation != before.Generation || st.SharedProxyID == nil || *st.SharedProxyID != 2 {
		t.Fatalf("pointer moved over a drifted fleet: gen=%d pointer=%v", st.Generation, st.SharedProxyID)
	}
}

// TestSharedDisabledWorkerDoesNothing: with the shared flag off there is no query,
// no probe and no state change.
func TestSharedDisabledWorkerDoesNothing(t *testing.T) {
	f := newSharedSwitchFixture(t)
	f.switchTo(t)
	f.setSharedEnabled(false)
	ctx := context.Background()
	for i := 0; i < 5; i++ {
		if err := f.co.Tick(ctx); err != nil {
			t.Fatalf("tick: %v", err)
		}
	}
	if n := len(f.probe.snapshot()); n != 0 {
		t.Fatalf("probe ran while disabled: %d calls", n)
	}
	f.co.Start(ctx)
	time.Sleep(60 * time.Millisecond)
	f.co.Stop()
	if n := len(f.probe.snapshot()); n != 0 {
		t.Fatalf("worker probed while disabled: %d calls", n)
	}
	// A disabled coordinator must also refuse new incidents.
	d, err := f.co.Handle(ctx, Incident{AccountID: f.eligible[0], ProxyID: ptrInt64(1), ProxyHost: "10.0.0.1"})
	if err != nil {
		t.Fatalf("handle: %v", err)
	}
	if d.Outcome != "deferred" || d.Reason != "shared_disabled" {
		t.Fatalf("outcome=%q reason=%q", d.Outcome, d.Reason)
	}
}

// TestSharedReconcileNewAccountFollowsPointer: a newly admitted account joins the
// shared proxy without touching its own business state, and stays put afterwards.
func TestSharedReconcileNewAccountFollowsPointer(t *testing.T) {
	f := newSharedSwitchFixture(t)
	f.switchTo(t)
	ctx := context.Background()
	two := int64(2)
	fresh := f.h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &two, Unschedule: true})
	idle := f.h.addAccount(sharedAcct{BaseURL: "https://kedaya.ai", ProxyID: &two})
	if err := f.co.Reconcile(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	for _, id := range []int64{fresh, idle} {
		if got := f.h.accountProxy(id); got == nil || *got != 2 {
			t.Fatalf("new account %d not on the shared pointer: %v", id, got)
		}
		if got := f.h.accountGeneration(id); got != 2 {
			t.Fatalf("new account %d generation=%d, want 2", id, got)
		}
	}
	if got := f.h.count(`SELECT count(*) FROM accounts WHERE id=$1 AND schedulable=false`, fresh); got != 1 {
		t.Fatalf("reconcile enabled an unschedulable account")
	}
	// A converged second pass must not publish another burst.
	before := f.h.count(`SELECT count(*) FROM scheduler_outbox`)
	if err := f.co.Reconcile(ctx); err != nil {
		t.Fatalf("reconcile 2: %v", err)
	}
	if after := f.h.count(`SELECT count(*) FROM scheduler_outbox`); after != before {
		t.Fatalf("idempotent reconcile published %d new outbox rows", after-before)
	}
}

// TestSharedFairFirstRound: a permanently failing cell must not stop the first
// attempt of every other cell in the same round.
func TestSharedFairFirstRound(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	victim := run.Cells[0].AccountID
	f.probe.mu.Lock()
	f.probe.behave = func(call probeCall, nth int) SharedProbeResult {
		if call.AccountID == victim {
			return SharedProbeResult{Verdict: SharedCellInconclusive, Reason: "timeout"}
		}
		return SharedProbeResult{Verdict: SharedCellClean}
	}
	f.probe.mu.Unlock()
	f.co.BackoffBase = 50 * time.Millisecond
	f.co.BackoffMax = 50 * time.Millisecond
	for i := 0; i < len(f.eligible); i++ {
		if err := f.co.Tick(context.Background()); err != nil {
			t.Fatalf("tick: %v", err)
		}
	}
	seen := map[int64]bool{}
	for _, c := range f.probe.snapshot() {
		seen[c.AccountID] = true
	}
	for _, cell := range run.Cells {
		if !seen[cell.AccountID] {
			t.Fatalf("a permanently failing cell blocked account %d from its first attempt", cell.AccountID)
		}
	}
	if n := f.probe.callsFor(victim, 1); n != 1 {
		t.Fatalf("failing account probed %d times inside the first pass (retry must wait for backoff)", n)
	}
}

func keyOf(accountID, proxyID int64) string {
	return itoa(int(accountID)) + "|" + itoa(int(proxyID))
}

func ptrInt64(v int64) *int64 { return &v }
