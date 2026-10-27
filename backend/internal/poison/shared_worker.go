package poison

import (
	"context"
	"database/sql"
	"sort"
	"strings"
	"time"
)

// claimedCell is the lease the worker took before probing. The probe itself runs
// outside every transaction: a slow upstream must never hold the rotation lock.
type claimedCell struct {
	RunID     string
	AccountID int64
	Model     string
	ProxyID   *int64
	Attempt   int
}

// Tick performs one worker pass: claim a single (run, account) cell, probe it with
// the run's proxy, then commit the verdict and any run transition. Returning nil
// without work is normal.
func (s *SharedCoordinator) Tick(ctx context.Context) error {
	if !s.sharedEnabled() {
		// Off means off: no query, no probe, no lease.
		return nil
	}
	claim, err := s.claim(ctx)
	if err != nil || claim == nil {
		return err
	}
	result, probeErr := s.probe(ctx, claim)
	return s.finish(ctx, claim, result, probeErr)
}

// claim leases one cell. Runs are visited round-robin (cursor in ActiveRun) and
// cells are taken least-attempted first, so one permanently failing account can
// never delay the first attempt of the others, and a second instance cannot drive
// a run whose lease is still alive.
func (s *SharedCoordinator) claim(ctx context.Context) (*claimedCell, error) {
	now := time.Now().UTC()
	leaseTTL := s.LeaseTTL
	if leaseTTL <= 0 {
		leaseTTL = 90 * time.Second
	}
	var out *claimedCell
	err := s.withState(ctx, func(tx *sql.Tx, st *SharedState) error {
		if !st.Enabled {
			return nil
		}
		for _, idx := range runOrder(st, st.ActiveRun) {
			run := &st.Runs[idx]
			if run.Terminal() {
				continue
			}
			if run.LeaseOwner != "" && run.LeaseOwner != s.owner && run.LeaseUntil.After(now) {
				continue
			}
			cellIdx := claimableCell(run, now)
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
			out = &claimedCell{RunID: run.ID, AccountID: cell.AccountID, Model: cell.Model, ProxyID: proxyID, Attempt: cell.Attempts}
			return nil
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// runOrder returns run indexes starting right after the cursor, preferring runs
// with queued work, then wrapping around.
func runOrder(st *SharedState, cursor string) []int {
	total := len(st.Runs)
	if total == 0 {
		return nil
	}
	start := 0
	for i := range st.Runs {
		if st.Runs[i].ID == cursor {
			start = (i + 1) % total
			break
		}
	}
	order := make([]int, 0, total)
	for i := 0; i < total; i++ {
		order = append(order, (start+i)%total)
	}
	return order
}

// claimableCell picks the least-attempted cell whose retry time has come. Expired
// leases are reclaimable, which is what makes a restart resume instead of hang.
func claimableCell(run *SharedRun, now time.Time) int {
	best := -1
	for i := range run.Cells {
		cell := &run.Cells[i]
		if cell.Verdict == SharedCellClean || cell.Verdict == SharedCellPoison {
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
// read-only check) and the cell model, then calls the injected probe.
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
					return fail("plan_write_failed"), nil
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
	res, err := s.opts.Probe(ctx, SharedProbeRequest{AccountID: claim.AccountID, Model: model, Proxy: proxy.Candidate, Snapshot: s.snapshot()})
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
// frozen account list intact.
func (s *SharedCoordinator) setCellModel(ctx context.Context, claim *claimedCell, model string) error {
	return s.withState(ctx, func(_ *sql.Tx, st *SharedState) error {
		run := st.run(claim.RunID)
		if run == nil || run.Terminal() {
			return nil
		}
		for i := range run.Cells {
			if run.Cells[i].AccountID == claim.AccountID && run.Cells[i].Model == "" {
				run.Cells[i].Model = model
				return nil
			}
		}
		return nil
	})
}

// finish writes the verdict back and advances the run. Every write is bound to the
// lease owner and the attempt number, so a restarted or competing worker cannot
// apply a stale observation.
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
			// Failures are never treated as clean; they are re-queued with backoff.
			cell.Status = SharedCellPending
			cell.NextAttemptAt = now.Add(s.backoff(cell.Attempts))
		} else {
			cell.Status = SharedCellDone
			cell.NextAttemptAt = time.Time{}
		}
		run.LeaseOwner = ""
		run.LeaseUntil = time.Time{}
		run.UpdatedAt = now
		run.Recount()
		if run.AnyPoison() {
			// One confirmed poison is enough: the row stays blocked, no cut-back.
			run.State = SharedRunConfirmed
			run.ReleaseReason = "poison_confirmed"
			run.Recount()
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
	accounts, err := s.eligibleAccounts(ctx, tx, false)
	if err != nil {
		return nil, err
	}
	frozenEpoch := map[int64]int64{}
	for i := range run.Cells {
		frozenEpoch[run.Cells[i].AccountID] = run.Cells[i].RestoreEpoch
	}
	ids := make([]int64, 0, len(accounts))
	var toRefresh []sharedAccount
	skipped := 0
	for _, acc := range accounts {
		if epoch, ok := frozenEpoch[acc.ID]; ok && epoch != acc.RestoreEpoch {
			// An administrator rebound this account after the run was frozen.
			skipped++
			continue
		}
		ids = append(ids, acc.ID)
		toRefresh = append(toRefresh, acc)
	}
	if len(ids) == 0 {
		run.ReleaseReason += "|cutback_no_accounts"
		return nil, nil
	}
	if _, err := lockAccounts(ctx, tx, ids); err != nil {
		return nil, err
	}
	newGen := st.Generation + 1
	if _, err := writeAccounts(ctx, tx, ids, *run.ProxyID, newGen); err != nil {
		return nil, err
	}
	if err := enqueueBulkChange(ctx, tx, toRefresh); err != nil {
		return nil, err
	}
	st.Generation = newGen
	sharedID := *run.ProxyID
	st.SharedProxyID = &sharedID
	st.WaitingForProxy = false
	run.State = SharedRunReleased
	run.ReleaseReason = "all_clean|cut_back"
	if skipped > 0 {
		run.ReleaseReason += "|epoch_protected"
	}
	return ids, nil
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
