//go:build unit

package poison

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"
)

// TestSharedPoisonStillCoversEveryAccount pins the user-facing rule: one hit is
// enough to keep the blacklist, but the round is still a full round — the run may
// only become terminal once every frozen account carries a definitive
// clean/poison observation. A poison in the first cell must not skip the rest.
func TestSharedPoisonStillCoversEveryAccount(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	// First cell (lowest account id) poisons; every other account must still run.
	victim := run.Cells[0].AccountID
	f.probe.mu.Lock()
	f.probe.behave = func(call probeCall, _ int) SharedProbeResult {
		if call.AccountID == victim {
			return SharedProbeResult{Verdict: SharedCellPoison, Reason: "veto", Matched: []string{"kedaya"}}
		}
		return SharedProbeResult{Verdict: SharedCellClean}
	}
	f.probe.mu.Unlock()
	f.co.BackoffBase = time.Millisecond

	// One pass only: a terminal-by-poison run would stop probing immediately.
	for i := 0; i < len(run.Cells); i++ {
		if err := f.co.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	seen := map[int64]bool{}
	for _, c := range f.probe.snapshot() {
		if c.ProxyID != 1 {
			t.Fatalf("probe used proxy %d, want the failed proxy 1", c.ProxyID)
		}
		seen[c.AccountID] = true
	}
	for _, cell := range run.Cells {
		if !seen[cell.AccountID] {
			t.Fatalf("account %d never probed after an earlier poison", cell.AccountID)
		}
	}
	done := f.drainTicks(t, 20)
	if done == nil || done.State != SharedRunConfirmed {
		t.Fatalf("state=%v, want confirmed once the whole round is observed", done)
	}
	if done.Counts.Expected != len(f.eligible) || done.Counts.Poison != 1 || done.Counts.Clean != len(f.eligible)-1 {
		t.Fatalf("counts=%+v", done.Counts)
	}
	if done.Counts.Completed != len(f.eligible) {
		t.Fatalf("completed=%d, want %d definitive observations", done.Counts.Completed, len(f.eligible))
	}
	if got := f.h.blockedIPs(); got["10.0.0.1"] != 1 {
		t.Fatalf("blacklist=%v, the poisoned egress must stay", got)
	}
}

// TestSharedConfirmedRoundRetriesInconclusive: an inconclusive attempt is neither
// clean nor completed. The round finishes only after the failed account is
// re-probed successfully, and the poison observed meanwhile is preserved.
func TestSharedConfirmedRoundRetriesInconclusive(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	poisoned := run.Cells[0].AccountID
	flaky := run.Cells[1].AccountID
	f.co.BackoffBase = time.Millisecond
	f.co.BackoffMax = 2 * time.Millisecond
	f.probe.mu.Lock()
	f.probe.behave = func(call probeCall, nth int) SharedProbeResult {
		switch call.AccountID {
		case poisoned:
			return SharedProbeResult{Verdict: SharedCellPoison, Reason: "veto"}
		case flaky:
			if nth == 1 {
				return SharedProbeResult{Verdict: SharedCellInconclusive, Reason: "timeout"}
			}
		}
		return SharedProbeResult{Verdict: SharedCellClean}
	}
	f.probe.mu.Unlock()

	for i := 0; i < len(run.Cells); i++ {
		if err := f.co.Tick(context.Background()); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	st, err := f.co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	mid := st.Runs[0]
	if mid.Terminal() {
		t.Fatalf("round finished with an inconclusive cell: %+v", mid.Counts)
	}
	if mid.Counts.Inconclusive != 1 {
		t.Fatalf("inconclusive=%d, want 1 (%+v)", mid.Counts.Inconclusive, mid.Counts)
	}
	if mid.Counts.Completed != len(run.Cells)-1 {
		t.Fatalf("completed=%d, an inconclusive attempt must not count as completed (%+v)", mid.Counts.Completed, mid.Counts)
	}
	if got := f.h.blockedIPs(); got["10.0.0.1"] != 1 {
		t.Fatalf("blacklist=%v, it must stay while a cell is unverified", got)
	}
	f.co.BackoffBase = time.Millisecond
	done := f.drainTicks(t, 30)
	if done == nil || done.State != SharedRunConfirmed {
		t.Fatalf("state=%v after the retry", done)
	}
	if f.probe.callsFor(flaky, 1) < 2 {
		t.Fatalf("inconclusive account was not retried: %d probes", f.probe.callsFor(flaky, 1))
	}
	if done.Counts.Inconclusive != 0 || done.Counts.Poison != 1 {
		t.Fatalf("final counts=%+v", done.Counts)
	}
}

// TestSharedExpiredLeaseCannotWriteBack: a worker whose lease already expired must
// not apply its verdict, and the cell must stay claimable so a live worker (or the
// same one after a restart) can redo it.
func TestSharedExpiredLeaseCannotWriteBack(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	ctx := context.Background()
	claim, err := f.co.claim(ctx)
	if err != nil || claim == nil {
		t.Fatalf("claim: %v", err)
	}
	target := claim.AccountID
	// The claiming worker took 90s and the probe outlived its lease.
	expired := time.Now().Add(-time.Minute)
	f.h.patchState(func(st *SharedState) {
		st.Runs[0].LeaseOwner = f.co.Owner()
		st.Runs[0].LeaseUntil = expired
		for i := range st.Runs[0].Cells {
			cell := &st.Runs[0].Cells[i]
			if cell.AccountID == target {
				cell.Status = SharedCellRunning
				cell.LeaseOwner = f.co.Owner()
				cell.LeaseUntil = expired
			}
		}
	})
	stale := *claim
	stale.LeaseUntil = expired
	if err := f.co.finish(ctx, &stale, SharedProbeResult{Verdict: SharedCellClean}, nil); err != nil {
		t.Fatalf("expired finish: %v", err)
	}
	st, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.Runs[0].Counts.Clean != 0 {
		t.Fatalf("expired lease wrote a clean verdict: %+v", st.Runs[0].Counts)
	}
	for _, cell := range st.Runs[0].Cells {
		if cell.AccountID != target {
			continue
		}
		if cell.Verdict != "" || cell.Status == SharedCellDone {
			t.Fatalf("expired lease finalized cell %d: status=%s verdict=%s", cell.AccountID, cell.Status, cell.Verdict)
		}
	}
	// Still claimable: the orphaned attempt is resumed inside the first round, not
	// queued behind retry backoff.
	for i := 0; i < len(run.Cells)+2 && f.probe.callsFor(target, 1) == 0; i++ {
		if err := f.co.Tick(ctx); err != nil {
			t.Fatalf("reclaim tick %d: %v", i, err)
		}
	}
	if got := f.probe.callsFor(target, 1); got < 1 {
		t.Fatalf("cell with an expired lease was not reclaimed: %d probes", got)
	}
}

// TestSharedForeignLeaseCannotWriteBack: a peer that took over the cell wins; the
// stale attempt and a foreign owner are both refused.
func TestSharedForeignLeaseCannotWriteBack(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	ctx := context.Background()
	claim, err := f.co.claim(ctx)
	if err != nil || claim == nil {
		t.Fatalf("claim: %v", err)
	}
	target := claim.AccountID
	f.h.patchState(func(st *SharedState) {
		st.Runs[0].LeaseOwner = "peer"
		st.Runs[0].LeaseUntil = time.Now().Add(time.Minute)
		for i := range st.Runs[0].Cells {
			cell := &st.Runs[0].Cells[i]
			if cell.AccountID == target {
				cell.LeaseOwner = "peer"
				cell.LeaseUntil = time.Now().Add(time.Minute)
				cell.Attempts = 2
			}
		}
	})
	claim.Attempt = 1
	if err := f.co.finish(ctx, claim, SharedProbeResult{Verdict: SharedCellPoison}, nil); err != nil {
		t.Fatalf("foreign finish: %v", err)
	}
	st, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.Runs[0].Counts.Poison != 0 || st.Runs[0].Counts.Clean != 0 {
		t.Fatalf("foreign/stale attempt wrote back: %+v", st.Runs[0].Counts)
	}
	_ = run
	_ = target
}

// TestSharedAllCleanStillCutsBack is the happy path under the completion change:
// every account clean -> exact unblock -> fleet returns, generation advances.
func TestSharedAllCleanStillCutsBack(t *testing.T) {
	f := newSharedSwitchFixture(t)
	f.switchTo(t)
	before := f.state(t)
	f.co.BackoffBase = time.Millisecond
	done := f.drainTicks(t, 40)
	if done == nil || done.State != SharedRunReleased {
		t.Fatalf("state=%v, want released", done)
	}
	if done.Counts.Clean != len(f.eligible) || done.Counts.Completed != len(f.eligible) {
		t.Fatalf("counts=%+v", done.Counts)
	}
	if _, still := f.h.blockedIPs()["10.0.0.1"]; still {
		t.Fatalf("verified egress was not released: %v", f.h.blockedIPs())
	}
	st := f.state(t)
	if st.Generation != before.Generation+1 || st.SharedProxyID == nil || *st.SharedProxyID != 1 {
		t.Fatalf("gen=%d (before %d) pointer=%v", st.Generation, before.Generation, st.SharedProxyID)
	}
}

// TestSharedDisabledWorkerDoesNotFinalizeRelease: switching the feature off while a
// probe is in flight must not clear the blacklist or move the fleet — the round
// stays open and resumes when shared mode is enabled again.
func TestSharedDisabledWorkerDoesNotFinalizeRelease(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	ctx := context.Background()
	f.co.BackoffBase = time.Millisecond
	last := run.Cells[len(run.Cells)-1].AccountID
	f.probe.mu.Lock()
	f.probe.behave = func(call probeCall, nth int) SharedProbeResult {
		if call.AccountID == last && nth == 1 {
			// The operator disabled shared mode while this probe was running.
			f.setSharedEnabled(false)
		}
		return SharedProbeResult{Verdict: SharedCellClean}
	}
	f.probe.mu.Unlock()
	for i := 0; i < len(run.Cells); i++ {
		if err := f.co.Tick(ctx); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	st, err := f.co.State(ctx)
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	if st.Runs[0].State == SharedRunReleased || st.Runs[0].State == SharedRunReleasedOld {
		t.Fatalf("release was finalized while shared mode was off: %+v", st.Runs[0])
	}
	if got := f.h.blockedIPs(); got["10.0.0.1"] != 1 {
		t.Fatalf("blacklist=%v, a disabled worker must not release", got)
	}
	if st.SharedProxyID == nil || *st.SharedProxyID != 2 {
		t.Fatalf("pointer moved while disabled: %v", st.SharedProxyID)
	}
	// Re-enabling resumes the round and completes it.
	f.setSharedEnabled(true)
	// Cancellation left the last claim unresolved. Resume after its lease expires.
	f.h.patchState(func(state *SharedState) {
		for i := range state.Runs {
			state.Runs[i].LeaseUntil = time.Now().Add(-time.Second)
			for j := range state.Runs[i].Cells {
				state.Runs[i].Cells[j].LeaseUntil = time.Now().Add(-time.Second)
			}
		}
	})
	done := f.drainTicks(t, 20)
	if done == nil || done.State != SharedRunReleased {
		t.Fatalf("resumed state=%v", done)
	}
}

// TestSharedCutBackAbortsOnBindingDrift: one frozen account already sits on a
// different binding, so a partial cut-back would split the fleet and Reconcile
// would then overwrite the manual change. The release must therefore skip the
// cut-back entirely while still removing the proven-clean blacklist row.
func TestSharedCutBackAbortsOnBindingDrift(t *testing.T) {
	f := newSharedSwitchFixture(t)
	run := f.switchTo(t)
	ctx := context.Background()
	before := f.state(t)
	moved := run.Cells[1].AccountID
	// Moved by hand onto another proxy under a different shared generation.
	f.h.exec(`UPDATE accounts SET proxy_id=3,
		extra = jsonb_set(COALESCE(extra,'{}'::jsonb), ARRAY[$2]::text[], to_jsonb($3::bigint), true)
		WHERE id=$1`, moved, SharedGenerationKey, before.Generation+99)
	f.co.BackoffBase = time.Millisecond
	done := f.drainTicks(t, 60)
	if done == nil || done.State != SharedRunReleasedOld {
		t.Fatalf("state=%v reason=%s, want a release without a cut-back", done, done.ReleaseReason)
	}
	if !strings.Contains(done.ReleaseReason, "binding_drift") {
		t.Fatalf("reason=%q, want the binding drift to be recorded", done.ReleaseReason)
	}
	if _, still := f.h.blockedIPs()["10.0.0.1"]; still {
		t.Fatalf("proven-clean egress was not unblocked: %v", f.h.blockedIPs())
	}
	if got := f.h.accountProxy(moved); got == nil || *got != 3 {
		t.Fatalf("manually moved account was overwritten: %v", got)
	}
	for _, id := range f.eligible {
		if id == moved {
			continue
		}
		if got := f.h.accountProxy(id); got == nil || *got != 2 {
			t.Fatalf("account %d was cut back over a drifted fleet: %v", id, got)
		}
	}
	st := f.state(t)
	if st.Generation != before.Generation || st.SharedProxyID == nil || *st.SharedProxyID != 2 {
		t.Fatalf("pointer moved over a drifted fleet: gen=%d (before %d) pointer=%v", st.Generation, before.Generation, st.SharedProxyID)
	}
	_ = ctx
}

// state reloads the coordination document for assertions.
func (f *sharedSwitchFixture) state(t *testing.T) SharedState {
	t.Helper()
	st, err := f.co.State(context.Background())
	if err != nil {
		t.Fatalf("state: %v", err)
	}
	return st
}

// TestSharedBackfillRoundOrderPerProxy: the historical sweep finishes the whole
// first round of one proxy before starting the next one, and a permanently failing
// account does not stop the other proxies' first rounds.
func TestSharedBackfillRoundOrderPerProxy(t *testing.T) {
	h := newSharedTestDB(t)
	base := "https://kedaya.ai"
	p1 := h.addProxy("10.0.0.1", 8080, "active", false)
	p2 := h.addProxy("10.0.0.2", 8080, "active", false)
	h.exec(`INSERT INTO poison_blocked_egress(outbound_ip,proxy_id,reason) VALUES('10.0.0.1',$1,'legacy')`, p1)
	h.exec(`INSERT INTO poison_blocked_egress(outbound_ip,proxy_id,reason) VALUES('10.0.0.2',$1,'legacy2')`, p2)
	var accounts []int64
	for i := 0; i < 5; i++ {
		one := p1
		accounts = append(accounts, h.addAccount(sharedAcct{BaseURL: base, ProxyID: &one}))
	}
	probe := &probeScript{script: map[string]SharedProbeResult{}}
	failing := accounts[0]
	probe.behave = func(call probeCall, _ int) SharedProbeResult {
		if call.AccountID == failing {
			return SharedProbeResult{Verdict: SharedCellInconclusive, Reason: "timeout"}
		}
		return SharedProbeResult{Verdict: SharedCellClean}
	}
	co := NewSharedCoordinator(h.db, SharedOptions{
		Plan: func(_ context.Context, _ *Snapshot) ([]SharedAccount, error) {
			var out []SharedAccount
			for _, id := range accounts {
				out = append(out, SharedAccount{ID: id, Model: "claude-sonnet-4"})
			}
			return out, nil
		},
		Probe:    probe.fn,
		Snapshot: sharedTestSnapshot,
	})
	co.BackoffBase = time.Hour // keep the retry out of the first-round window
	co.BackoffMax = time.Hour
	ctx := context.Background()
	if err := co.Reconcile(ctx); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if _, err := co.EnqueueBackfill(ctx); err != nil {
		t.Fatalf("backfill: %v", err)
	}
	for i := 0; i < 2*len(accounts); i++ {
		if err := co.Tick(ctx); err != nil {
			t.Fatalf("tick %d: %v", i, err)
		}
	}
	calls := probe.snapshot()
	if len(calls) != 2*len(accounts) {
		t.Fatalf("probe calls=%d, want %d first attempts", len(calls), 2*len(accounts))
	}
	// Every first attempt happens before the retry: run 1 (proxy 1) covers all of
	// its accounts consecutively, then run 2 (proxy 2) does the same.
	var firstProxy int64
	for i, c := range calls {
		if i == 0 {
			firstProxy = c.ProxyID
			continue
		}
		if i < len(accounts) && c.ProxyID != firstProxy {
			t.Fatalf("proxy %d interleaved into the first round of proxy %d: %v", c.ProxyID, firstProxy, calls)
		}
		if i >= len(accounts) && c.ProxyID == firstProxy {
			t.Fatalf("second round of proxy %d started before proxy 2's first round: %v", firstProxy, calls)
		}
	}
	if probe.callsFor(failing, firstProxy) != 1 {
		t.Fatalf("failing account retried inside the first-round window: %d", probe.callsFor(failing, firstProxy))
	}
}

// TestSharedLedgerKeepsWholeBatches: trimming is unit-based. A historical batch is
// either kept whole or dropped whole; an open batch is never cut and an empty round
// never counts as success.
func TestSharedLedgerKeepsWholeBatches(t *testing.T) {
	now := time.Now().UTC()
	st := &SharedState{}
	for i := 0; i < 19; i++ {
		st.Runs = append(st.Runs, SharedRun{
			ID: fmt.Sprintf("backfill-%d", i), Kind: SharedRunBackfill, State: SharedRunReleasedOld,
			BatchID: "batch-a", CreatedAt: now.Add(time.Duration(i) * time.Second),
			Cells: []SharedCell{{AccountID: int64(i), Status: SharedCellDone, Verdict: SharedCellClean}},
		})
	}
	// A newer open batch whose first run is still running.
	st.Runs = append(st.Runs, SharedRun{
		ID: "backfill-open", Kind: SharedRunBackfill, State: SharedRunRunning,
		BatchID: "batch-b", CreatedAt: now.Add(time.Minute),
		Cells: []SharedCell{{AccountID: 1, Status: SharedCellPending}},
	})
	// Plus finished auto rounds and expired history.
	for i := 0; i < 25; i++ {
		st.Runs = append(st.Runs, SharedRun{
			ID: fmt.Sprintf("auto-%d", i), Kind: SharedRunAuto, State: SharedRunConfirmed,
			CreatedAt: now.Add(time.Duration(i) * time.Minute),
			Cells:     []SharedCell{{AccountID: 1, Status: SharedCellDone, Verdict: SharedCellPoison}},
		})
	}
	st.Runs = append(st.Runs, SharedRun{
		ID: "auto-old", Kind: SharedRunAuto, State: SharedRunReleased,
		CreatedAt: now.Add(-30 * 24 * time.Hour), UpdatedAt: now.Add(-30 * 24 * time.Hour),
		Cells: []SharedCell{{AccountID: 1, Status: SharedCellDone, Verdict: SharedCellClean}},
	})
	raw, err := encodeSharedState(st)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	out, err := decodeSharedState(raw)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	kept := map[string]bool{}
	for _, r := range out.Runs {
		kept[r.ID] = true
	}
	for i := 0; i < 19; i++ {
		if !kept[fmt.Sprintf("backfill-%d", i)] {
			t.Fatalf("historical batch was cut mid-way: run %d missing", i)
		}
	}
	if !kept["backfill-open"] {
		t.Fatalf("open batch was trimmed")
	}
	if kept["auto-old"] {
		t.Fatalf("expired terminal auto run was not trimmed")
	}
	if len(out.Runs) >= 19+1+25+1 {
		t.Fatalf("ledger was not trimmed at all: %d runs", len(out.Runs))
	}
	// An empty round is never a clean round.
	empty := &SharedRun{}
	if empty.AllClean() || empty.FullyObserved() {
		t.Fatalf("empty round reported a complete clean observation")
	}
}
