package poison

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"
	"time"
)

// claimedCell is the lease the worker took before probing. The probe itself runs
// outside every transaction: a slow upstream must never hold the rotation lock.
//
// LeaseUntil is the deadline the claim was granted under. finish refuses a verdict
// that arrives after it, because by then a peer may own the same cell.
type claimedCell struct {
	RunID      string
	AccountID  int64
	Model      string
	ProxyID    *int64
	Attempt    int
	LeaseUntil time.Time
}

// errLeaseLost means this worker no longer owns the cell it is about to touch.
var errLeaseLost = errors.New("shared verification lease lost")

// Tick performs one worker pass: claim a single (run, account) cell, probe it with
// the run's proxy, then commit the verdict and any run transition. Returning nil
// without work is normal.
func (s *SharedCoordinator) Tick(ctx context.Context) error {
	if !s.sharedEnabled() {
		// Off means off: no query, no probe, no lease.
		return nil
	}
	// A round can be fully observed without a transition having been committed:
	// the feature was switched off mid-probe, or the process died between the
	// verdict write and the release. Converge those rounds before probing.
	if err := s.finalize(ctx); err != nil {
		return err
	}
	claim, err := s.claim(ctx)
	if err != nil || claim == nil {
		return err
	}
	result, probeErr := s.probe(ctx, claim)
	return s.finish(ctx, claim, result, probeErr)
}

// finalize commits the transition of runs whose whole frozen round already has a
// definitive observation. It is a no-op (one cheap read) when nothing qualifies,
// and it never runs while shared mode is off: a disabled worker must not release.
func (s *SharedCoordinator) finalize(ctx context.Context) error {
	if !s.sharedEnabled() {
		return nil
	}
	current, err := s.readState(ctx)
	if err != nil || current == nil {
		return err
	}
	need := false
	for i := range current.Runs {
		if !current.Runs[i].Terminal() && current.Runs[i].FullyObserved() {
			need = true
			break
		}
	}
	if !need {
		return nil
	}
	now := time.Now().UTC()
	var refresh []int64
	err = s.withState(ctx, func(tx *sql.Tx, st *SharedState) error {
		if !st.Enabled {
			return nil
		}
		for i := range st.Runs {
			run := &st.Runs[i]
			if run.Terminal() || !run.FullyObserved() {
				continue
			}
			if run.LeaseOwner != "" && run.LeaseOwner != s.owner && run.LeaseUntil.After(now) {
				continue
			}
			run.Recount()
			if run.AnyPoison() {
				run.PoisonConfirmed = true
				run.ReleaseReason = "poison_confirmed"
				run.State = SharedRunConfirmed
				run.UpdatedAt = now
				continue
			}
			if !run.AllClean() {
				continue
			}
			ids, err := s.release(ctx, tx, st, run, now)
			if err != nil {
				return err
			}
			run.UpdatedAt = now
			refresh = append(refresh, ids...)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(refresh) > 0 {
		s.refresh(ctx, refresh)
	}
	return nil
}

func (s *SharedCoordinator) leaseTTL() time.Duration {
	ttl := s.LeaseTTL
	if ttl <= 0 {
		ttl = 90 * time.Second
	}
	return ttl
}

// probeTimeout keeps the probe strictly inside the lease: a probe that outlives
// its claim would let a peer take the cell while this worker still writes. The
// margin leaves room to persist the verdict before the lease expires.
func (s *SharedCoordinator) probeTimeout() time.Duration {
	ttl := s.leaseTTL()
	margin := ttl / 5
	if margin < 100*time.Millisecond {
		margin = ttl / 20
	}
	timeout := ttl - margin
	if timeout <= 0 {
		timeout = ttl
	}
	return timeout
}

// claim leases one cell. Runs are visited in ledger order starting at the active
// cursor, so the whole first round of one proxy finishes before the sweep moves to
// the next proxy, and one permanently failing account can never delay the first
// attempt of another proxy. Retries are only considered once no first-round work
// is left anywhere.
func (s *SharedCoordinator) claim(ctx context.Context) (*claimedCell, error) {
	now := time.Now().UTC()
	leaseTTL := s.leaseTTL()
	var out *claimedCell
	err := s.withState(ctx, func(tx *sql.Tx, st *SharedState) error {
		if !st.Enabled {
			return nil
		}
		for _, firstRound := range []bool{true, false} {
			for _, idx := range claimOrder(st, st.ActiveRun) {
				run := &st.Runs[idx]
				if run.Terminal() {
					continue
				}
				if run.LeaseOwner != "" && run.LeaseOwner != s.owner && run.LeaseUntil.After(now) {
					continue
				}
				cellIdx := claimableCell(run, now, firstRound)
				if cellIdx < 0 {
					continue
				}
				run.LeaseOwner = s.owner
				run.LeaseUntil = now.Add(leaseTTL)
				run.UpdatedAt = now
				cell := &run.Cells[cellIdx]
				cell.Status = SharedCellRunning
				cell.LeaseOwner = s.owner
				cell.LeaseUntil = run.LeaseUntil
				cell.Attempts++
				cell.StartedAt = now
				st.ActiveRun = run.ID
				proxyID := run.ProxyID
				out = &claimedCell{
					RunID: run.ID, AccountID: cell.AccountID, Model: cell.Model,
					ProxyID: proxyID, Attempt: cell.Attempts, LeaseUntil: cell.LeaseUntil,
				}
				return nil
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// claimOrder returns run indexes starting at the cursor (inclusive), so the run
// that just probed keeps getting its remaining cells instead of bouncing between
// proxies.
func claimOrder(st *SharedState, cursor string) []int {
	total := len(st.Runs)
	if total == 0 {
		return nil
	}
	start := 0
	for i := range st.Runs {
		if st.Runs[i].ID == cursor {
			start = i
			break
		}
	}
	order := make([]int, 0, total)
	for i := 0; i < total; i++ {
		order = append(order, (start+i)%total)
	}
	return order
}

// claimableCell picks the next cell of a run.
//
// firstRound restricts the pass to cells with no attempt yet plus attempts
// orphaned by an expired lease (a crashed worker must be resumed immediately, not
// queued behind backoff). Any expired lease is reclaimable, which is what makes a
// restart resume instead of hang; a live lease is never touched.
func claimableCell(run *SharedRun, now time.Time, firstRound bool) int {
	best := -1
	for i := range run.Cells {
		cell := &run.Cells[i]
		if cell.Verdict == SharedCellClean || cell.Verdict == SharedCellPoison {
			continue
		}
		orphaned := cell.Status == SharedCellRunning && !cell.LeaseUntil.After(now)
		if firstRound && cell.Attempts > 0 && !orphaned {
			continue
		}
		if cell.Status == SharedCellRunning && cell.LeaseUntil.After(now) {
			continue
		}
		if !cell.NextAttemptAt.IsZero() && cell.NextAttemptAt.After(now) {
			continue
		}
		if best < 0 {
			best = i
			continue
		}
		cur := &run.Cells[best]
		if cell.Attempts < cur.Attempts || (cell.Attempts == cur.Attempts && cell.AccountID < cur.AccountID) {
			best = i
		}
	}
	return best
}

// probe resolves the run's proxy (soft-deleted configuration is still usable for a
// read-only check) and the cell model, then calls the injected probe inside a
// deadline derived from the lease.
func (s *SharedCoordinator) probe(ctx context.Context, claim *claimedCell) (SharedProbeResult, error) {
	started := time.Now().UTC()
	fail := func(reason string) SharedProbeResult {
		return SharedProbeResult{Verdict: SharedCellInconclusive, Reason: reason, Model: claim.Model, StartedAt: started, FinishedAt: time.Now().UTC()}
	}
	if claim.ProxyID == nil {
		return fail("proxy_missing"), nil
	}
	proxy, err := s.loadProxy(ctx, s.db, *claim.ProxyID)
	if err != nil {
		return fail("proxy_missing"), nil
	}
	// A soft-deleted proxy keeps its configuration, so it stays verifiable; the row
	// is never re-enabled and never becomes an active selection target again (see
	// activeProxies), which is what keeps the backfill honest.
	model := claim.Model
	if model == "" {
		if planned := s.planAccounts(ctx); planned != nil {
			if p, ok := planned[claim.AccountID]; ok && p.Model != "" {
				model = p.Model
				if err := s.setCellModel(ctx, claim, model); err != nil {
					// The lease moved on: never spend a probe on a cell we no
					// longer own.
					return fail("lease_lost"), nil
				}
				claim.Model = model
			}
		}
	}
	if model == "" {
		return fail("plan_error"), nil
	}
	if s.opts.Probe == nil {
		return fail("probe_unavailable"), nil
	}
	// The probe must end before the lease does; otherwise the peer could reclaim
	// the cell while this attempt is still running.
	probeCtx, cancel := context.WithTimeout(ctx, s.probeTimeout())
	defer cancel()
	res, err := s.opts.Probe(probeCtx, SharedProbeRequest{AccountID: claim.AccountID, Model: model, Proxy: proxy.Candidate, Snapshot: s.snapshot()})
	if err != nil {
		return fail(probeFailureReason(err)), err
	}
	if res.Verdict == "" {
		res.Verdict = SharedCellInconclusive
	}
	if res.Reason == "" && res.Verdict == SharedCellInconclusive {
		res.Reason = "unclassified"
	}
	return res, nil
}

// setCellModel persists a model resolved after the run was frozen, keeping the
// frozen account list intact. The write is bound to the lease exactly like a
// verdict: a restarted worker must not mutate a cell it no longer owns.
func (s *SharedCoordinator) setCellModel(ctx context.Context, claim *claimedCell, model string) error {
	now := time.Now().UTC()
	return s.withState(ctx, func(_ *sql.Tx, st *SharedState) error {
		run := st.run(claim.RunID)
		if run == nil || run.Terminal() {
			return errLeaseLost
		}
		if run.LeaseOwner != s.owner {
			return errLeaseLost
		}
		idx := cellIndex(run, claim.AccountID)
		if idx < 0 {
			return errLeaseLost
		}
		cell := &run.Cells[idx]
		if cell.LeaseOwner != s.owner || cell.Attempts != claim.Attempt {
			return errLeaseLost
		}
		if !cell.LeaseUntil.IsZero() && !now.Before(cell.LeaseUntil) {
			return errLeaseLost
		}
		if cell.Model == "" {
			cell.Model = model
		}
		return nil
	})
}

// finish writes the verdict back and advances the run.
//
// Every write is bound to the lease owner, the attempt number and the lease
// deadline, so a restarted or competing worker cannot apply a stale observation.
// A run is only terminal once the whole frozen round has been observed: a poison
// confirms the blacklist immediately but never skips the remaining accounts, and
// an inconclusive attempt is re-queued instead of counting as completed.
func (s *SharedCoordinator) finish(ctx context.Context, claim *claimedCell, res SharedProbeResult, probeErr error) error {
	now := time.Now().UTC()
	var refresh []int64
	err := s.withState(ctx, func(tx *sql.Tx, st *SharedState) error {
		run := st.run(claim.RunID)
		if run == nil || run.Terminal() {
			return nil
		}
		if run.LeaseOwner != s.owner {
			return nil
		}
		idx := cellIndex(run, claim.AccountID)
		if idx < 0 {
			return nil
		}
		cell := &run.Cells[idx]
		if cell.LeaseOwner != s.owner || cell.Attempts != claim.Attempt {
			return nil
		}
		// An expired lease means the cell may already belong to someone else:
		// reject the write-back and leave it claimable.
		if !claim.LeaseUntil.IsZero() && !now.Before(claim.LeaseUntil) {
			return nil
		}
		if !cell.LeaseUntil.IsZero() && !now.Before(cell.LeaseUntil) {
			return nil
		}
		verdict := res.Verdict
		switch verdict {
		case SharedCellClean, SharedCellPoison, SharedCellInconclusive:
		default:
			verdict = SharedCellInconclusive
		}
		cell.Verdict = verdict
		cell.Reason = shortReason(res.Reason)
		cell.Matched = res.Matched
		cell.HTTPStatus = res.HTTPStatus
		cell.ReceivedBytes = res.ReceivedBytes
		cell.ResponseSHA = res.ResponseSHA256
		cell.StartedAt = firstNonZero(res.StartedAt, cell.StartedAt, now)
		cell.FinishedAt = now
		cell.LeaseOwner = ""
		cell.LeaseUntil = time.Time{}
		if verdict == SharedCellInconclusive {
			// Failures are never treated as clean; they are re-queued with backoff
			// and the attempt does not count as a completed observation.
			cell.Status = SharedCellPending
			cell.NextAttemptAt = now.Add(s.backoff(cell.Attempts))
		} else {
			cell.Status = SharedCellDone
			cell.NextAttemptAt = time.Time{}
		}
		// No work is in flight any more, whatever the feature flag says.
		run.LeaseOwner = ""
		run.LeaseUntil = time.Time{}
		run.UpdatedAt = now
		if !s.sharedEnabled() {
			// The operator switched shared mode off while this probe ran. Record
			// the observation but never finalize: no release, no cut-back, no
			// verdict-driven switch. The round resumes when it is re-enabled.
			run.Recount()
			return nil
		}
		run.Recount()
		if run.AnyPoison() {
			// One confirmed poison is enough to keep the row blocked, but the
			// round still covers every frozen account before it becomes terminal.
			run.PoisonConfirmed = true
			run.ReleaseReason = "poison_confirmed"
			if run.FullyObserved() {
				run.State = SharedRunConfirmed
			} else if run.State == SharedRunPending {
				run.State = SharedRunRunning
			}
			return nil
		}
		if run.AllClean() {
			ids, err := s.release(ctx, tx, st, run, now)
			if err != nil {
				return err
			}
			refresh = ids
			return nil
		}
		if run.State == SharedRunPending {
			run.State = SharedRunRunning
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(refresh) > 0 {
		s.refresh(ctx, refresh)
	}
	return nil
}

// release unblacklists the verified row and, for automatic runs, cuts the fleet
// back to it — but only when the shared generation still matches the one that
// created the run. The delete is keyed on the captured before-image, so a newer
// hit is never cleared by an older clean round.
//
// The admitted set is re-read FOR UPDATE inside this transaction. A binding/epoch
// decision taken from rows read before the lock would be stale, and rewriting only
// part of the fleet splits it: Reconcile would then drag the accounts an
// administrator had just restored straight back to the shared pointer. Therefore
// any drift aborts the cut-back for the whole fleet while the exact unblock (which
// has no binding side effect) is still applied.
func (s *SharedCoordinator) release(ctx context.Context, tx *sql.Tx, st *SharedState, run *SharedRun, now time.Time) ([]int64, error) {
	cleared, err := releaseBlacklist(ctx, tx, run.Before)
	if err != nil {
		return nil, err
	}
	run.State = SharedRunReleasedOld
	run.ReleaseReason = "all_clean"
	if run.Before != nil && !cleared {
		run.ReleaseReason = "all_clean_new_hit_retained"
	}
	if !run.CutBack || run.ProxyID == nil || run.TargetProxyID == nil {
		return nil, nil
	}
	if !cleared {
		// The egress is still (or again) blocked: never move the fleet onto it.
		return nil, nil
	}
	// CAS: nothing may have moved the fleet since this run was frozen.
	if st.Generation != run.Generation || st.SharedProxyID == nil || *st.SharedProxyID != *run.TargetProxyID {
		run.ReleaseReason += "|cutback_superseded"
		return nil, nil
	}
	target, err := s.loadProxy(ctx, tx, *run.ProxyID)
	if err != nil || target.Deleted || target.Status != "active" {
		run.ReleaseReason += "|cutback_proxy_unusable"
		return nil, nil
	}
	// Lock + re-read: only these rows may drive the epoch/binding decision.
	accounts, err := s.eligibleAccounts(ctx, tx, true)
	if err != nil {
		return nil, err
	}
	if len(accounts) == 0 {
		run.ReleaseReason += "|cutback_no_accounts"
		return nil, nil
	}
	if drift := cutBackDrift(run, accounts); drift != "" {
		run.ReleaseReason = "all_clean|cutback_" + drift + "_drift"
		return nil, nil
	}
	ids := accountIDs(accounts)
	newGen := st.Generation + 1
	if _, err := writeAccounts(ctx, tx, ids, *run.ProxyID, newGen); err != nil {
		return nil, err
	}
	if err := enqueueBulkChange(ctx, tx, accounts); err != nil {
		return nil, err
	}
	st.Generation = newGen
	sharedID := *run.ProxyID
	st.SharedProxyID = &sharedID
	st.WaitingForProxy = false
	run.State = SharedRunReleased
	run.ReleaseReason = "all_clean|cut_back"
	return ids, nil
}

// cutBackDrift reports why the fleet cannot be moved back as one unit: an
// administrator rebind (epoch), a binding that already moved (generation) or an
// account that left the admitted set since the round was frozen. An empty string
// means every frozen account is still exactly where the run left it.
func cutBackDrift(run *SharedRun, accounts []sharedAccount) string {
	frozen := make(map[int64]int64, len(run.Cells))
	for i := range run.Cells {
		frozen[run.Cells[i].AccountID] = run.Cells[i].RestoreEpoch
	}
	live := make(map[int64]sharedAccount, len(accounts))
	for _, acc := range accounts {
		live[acc.ID] = acc
	}
	for accountID, epoch := range frozen {
		acc, ok := live[accountID]
		if !ok {
			return "scope"
		}
		if epoch != acc.RestoreEpoch {
			return "epoch"
		}
		if acc.Generation != run.Generation {
			return "binding"
		}
	}
	return ""
}

func cellIndex(run *SharedRun, accountID int64) int {
	for i := range run.Cells {
		if run.Cells[i].AccountID == accountID {
			return i
		}
	}
	return -1
}

func (s *SharedCoordinator) backoff(attempts int) time.Duration {
	base := s.BackoffBase
	if base <= 0 {
		base = 2 * time.Second
	}
	max := s.BackoffMax
	if max <= 0 {
		max = 5 * time.Minute
	}
	d := base
	for i := 1; i < attempts && d < max; i++ {
		d *= 2
	}
	if d > max {
		d = max
	}
	return d
}

// shortReason keeps only a bounded category in persisted evidence.
func shortReason(reason string) string {
	reason = strings.TrimSpace(reason)
	if len(reason) > 64 {
		return reason[:64]
	}
	return reason
}

func probeFailureReason(err error) string {
	if err == nil {
		return ""
	}
	if errorsIsContext(err) {
		return "context"
	}
	return "probe_error"
}

func firstNonZero(times ...time.Time) time.Time {
	for _, t := range times {
		if !t.IsZero() {
			return t
		}
	}
	return time.Time{}
}

// PendingCellAccounts exposes the accounts still awaiting a verdict in a run; used
// by the admin view and by tests.
func PendingCellAccounts(run SharedRun) []int64 {
	var out []int64
	for _, cell := range run.Cells {
		if cell.Verdict != SharedCellClean && cell.Verdict != SharedCellPoison {
			out = append(out, cell.AccountID)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
