package poison

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

// SharedOptions wires the coordinator to the rest of the application. Every
// dependency is optional: a nil Plan or Probe degrades to "no model known" /
// "inconclusive" instead of inventing a verdict.
type SharedOptions struct {
	// Plan freezes the most-used model per eligible account (Model lane).
	Plan SharedPlanFunc
	// Probe runs one read-only upstream probe through the given proxy.
	Probe SharedProbeFunc
	// Snapshot returns the live configuration snapshot.
	Snapshot func() *Snapshot
	// RefreshAccounts is called after a committed switch so in-memory account
	// caches and scheduler snapshots follow the new binding.
	RefreshAccounts func(context.Context, []int64) error
	// ValidateProxy performs the (network) egress validation of a candidate.
	ValidateProxy func(context.Context, RotationCandidate) error
}

// SharedCoordinator owns the shared proxy pointer, the atomic all-account switch
// and the resumable verification/ release state machine.
//
// It deliberately talks to PostgreSQL directly instead of going through the
// service layer: the switch must rewrite dozens of accounts inside one
// transaction with row locks, which AccountService.Update (whole-row rewrite) can
// not do safely.
type SharedCoordinator struct {
	db   *sql.DB
	opts SharedOptions

	// Interval is the worker poll interval; LeaseTTL bounds a claim; BackoffBase
	// is the first retry delay (doubling, capped at BackoffMax).
	Interval    time.Duration
	LeaseTTL    time.Duration
	BackoffBase time.Duration
	BackoffMax  time.Duration

	mu      sync.Mutex
	cancel  context.CancelFunc
	done    chan struct{}
	started bool
	owner   string
}

// ErrSharedDisabled blocks verification rounds while the feature is off.
var ErrSharedDisabled = errors.New("shared proxy mode disabled")

func NewSharedCoordinator(db *sql.DB, opts SharedOptions) *SharedCoordinator {
	return &SharedCoordinator{
		db:          db,
		opts:        opts,
		Interval:    30 * time.Second,
		LeaseTTL:    90 * time.Second,
		BackoffBase: 2 * time.Second,
		BackoffMax:  5 * time.Minute,
		owner:       sharedLeaseOwner(),
	}
}

// Owner exposes the lease token for diagnostics only.
func (s *SharedCoordinator) Owner() string {
	if s == nil {
		return ""
	}
	return s.owner
}

// Reconcile converges the persisted pointer with the live account set: it picks
// an initial target when none is set, re-selects when the current one became
// unusable, and makes every admitted account follow the pointer (new accounts
// included) while leaving their running state untouched.
func (s *SharedCoordinator) Reconcile(ctx context.Context) error {
	if !s.sharedEnabled() {
		return ErrSharedDisabled
	}
	observed, err := s.readState(ctx)
	if err != nil {
		return err
	}
	cands, err := s.activeProxies(ctx, s.db)
	if err != nil {
		return err
	}
	ips, blocked, err := s.blockedSets(ctx, s.db)
	if err != nil {
		return err
	}
	var chosen *RotationCandidate
	needTarget := observed.SharedProxyID == nil || !usableProxy(*observed.SharedProxyID, cands, ips, blocked)
	if needTarget {
		accounts, err := s.eligibleAccounts(ctx, s.db, false)
		if err != nil {
			return err
		}
		remaining := append([]RotationCandidate(nil), cands...)
		for attempts := 0; attempts < s.rotationBudget() && len(remaining) > 0; attempts++ {
			candidate := pickInitial(accounts, remaining, ips, blocked)
			if candidate == nil {
				break
			}
			if err := s.validate(ctx, *candidate); err == nil {
				chosen = candidate
				break
			} else if ctx.Err() != nil {
				return ctx.Err()
			}
			filtered := remaining[:0]
			for _, c := range remaining {
				if c.endpoint() != candidate.endpoint() {
					filtered = append(filtered, c)
				}
			}
			remaining = filtered
		}
	}
	var changed []int64
	err = s.withState(ctx, func(tx *sql.Tx, st *SharedState) error {
		if st.Generation != observed.Generation || !sameSharedProxy(st.SharedProxyID, observed.SharedProxyID) {
			return ErrStaleIncident
		}
		st.Enabled = true
		accounts, err := s.eligibleAccounts(ctx, tx, true)
		if err != nil {
			return err
		}
		ids := accountIDs(accounts)
		if len(ids) == 0 {
			return nil
		}
		freshCands, err := s.activeProxies(ctx, tx)
		if err != nil {
			return err
		}
		freshIPs, freshBlocked, err := s.blockedSets(ctx, tx)
		if err != nil {
			return err
		}
		if needTarget {
			if chosen == nil {
				st.WaitingForProxy = true
				st.LastReason = "no_verified_candidate"
				return nil
			}
			currentProxy, err := s.loadProxy(ctx, tx, chosen.ID)
			if err != nil || currentProxy.Deleted || currentProxy.Status != "active" || currentProxy.Candidate != *chosen || !usableProxy(chosen.ID, freshCands, freshIPs, freshBlocked) {
				return ErrStaleIncident
			}
			newGen, err := nextSharedGeneration(st.Generation, accounts)
			if err != nil {
				return err
			}
			if _, err = writeAccounts(ctx, tx, ids, chosen.ID, newGen); err != nil {
				return err
			}
			if err = enqueueBulkChange(ctx, tx, accounts); err != nil {
				return err
			}
			id := chosen.ID
			st.SharedProxyID = &id
			st.Generation = newGen
			st.WaitingForProxy = false
			if run := st.waitingRun(); run != nil {
				run.CutBack = true
				run.TargetProxyID = &id
				run.ProxyIDAfterSwitch = id
				run.WaitingForCandidate = false
				run.Generation = newGen
				run.UpdatedAt = time.Now().UTC()
			}
			st.UpdatedAt = time.Now().UTC()
			changed = ids
			return nil
		}
		if st.SharedProxyID == nil || !usableProxy(*st.SharedProxyID, freshCands, freshIPs, freshBlocked) {
			return ErrStaleIncident
		}
		var drift []sharedAccount
		for _, acc := range accounts {
			if acc.ProxyID == nil || *acc.ProxyID != *st.SharedProxyID || acc.Generation != st.Generation {
				drift = append(drift, acc)
			}
		}
		if len(drift) == 0 {
			return nil
		}
		if _, err = writeAccounts(ctx, tx, accountIDs(drift), *st.SharedProxyID, st.Generation); err != nil {
			return err
		}
		if err = enqueueBulkChange(ctx, tx, drift); err != nil {
			return err
		}
		changed = accountIDs(drift)
		st.UpdatedAt = time.Now().UTC()
		return nil
	})
	if err != nil {
		return err
	}
	s.refresh(ctx, changed)
	return nil
}

func sameSharedProxy(a, b *int64) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}
func nextSharedGeneration(current int64, accounts []sharedAccount) (int64, error) {
	if current < 0 || current >= MaxRestoreEpoch {
		return 0, errors.New("invalid shared generation")
	}
	for _, account := range accounts {
		if account.Generation < 0 || account.Generation >= MaxRestoreEpoch {
			return 0, errors.New("invalid account shared generation")
		}
		if account.Generation > current {
			current = account.Generation
		}
	}
	return current + 1, nil
}
func (s *SharedCoordinator) rotationBudget() int {
	snap := s.snapshot()
	if snap == nil || snap.RotateMax <= 0 {
		return 0
	}
	if snap.RotateMax > 3 {
		return 3
	}
	return snap.RotateMax
}
func (s *SharedCoordinator) validate(ctx context.Context, c RotationCandidate) error {
	if s.opts.ValidateProxy == nil {
		return nil
	}
	return s.opts.ValidateProxy(ctx, c)
}

// Handle applies one poisoning incident: blacklist the old egress, move the whole
// admitted fleet to the next shared proxy and freeze a verification run for the
// old proxy. Network validation happens before the transaction; the transaction
// only re-validates and writes.
func (s *SharedCoordinator) Handle(ctx context.Context, inc Incident) (Disposition, error) {
	d := Disposition{
		AccountID: inc.AccountID, RequestID: inc.RequestID, EvidenceID: inc.EvidenceID, EvidencePath: inc.EvidencePath,
		Outcome: "deferred", Reason: "shared_preflight",
		Blacklist:  BlacklistDisposition{Status: "not_attempted"},
		Selections: []CandidateSelection{}, Attempts: []RotationAttempt{},
	}
	if !s.sharedEnabled() {
		d.Reason = "shared_disabled"
		return d, nil
	}
	if inc.ProxyID == nil {
		d.Reason = "incident_proxy_unknown"
		return d, nil
	}
	old, err := s.loadProxy(ctx, s.db, *inc.ProxyID)
	if err != nil {
		d.Reason = "deferred_incident_proxy_query"
		return d, nil
	}
	egress, dynamic := "", false
	if host := NormalizeBaseURL(old.Candidate.Host); host != "" {
		if net.ParseIP(host) != nil {
			egress = host
		} else {
			dynamic = true
		}
	}
	target, selection, selErr := s.selectTarget(ctx, *inc.ProxyID, old.Candidate.endpoint())
	d.Selections = append(d.Selections, selection)
	if selErr != nil {
		d.Reason = "deferred_" + rotationReason(selErr)
	}
	planned := s.planAccounts(ctx)

	var refreshed []int64
	txErr := s.withState(ctx, func(tx *sql.Tx, st *SharedState) error {
		st.Enabled = true
		accounts, err := s.eligibleAccounts(ctx, tx, true)
		if err != nil {
			return err
		}
		var source *sharedAccount
		for i := range accounts {
			if accounts[i].ID == inc.AccountID {
				source = &accounts[i]
				break
			}
		}
		if source == nil || inc.SharedGeneration < 0 || inc.RestoreEpoch < 0 || source.Generation != inc.SharedGeneration || st.Generation != inc.SharedGeneration || source.RestoreEpoch != inc.RestoreEpoch || source.ProxyID == nil || *source.ProxyID != *inc.ProxyID || source.Status != "active" || !source.Schedulable {
			d.Outcome, d.Reason = "stale", "incident_generation_or_restore_changed"
			return nil
		}
		if st.SharedProxyID != nil && *st.SharedProxyID != *inc.ProxyID {
			// The fleet already moved off this proxy: record the verdict but never
			// blacklist or switch again from an outdated observation.
			d.Outcome, d.Reason = "stale", "incident_proxy_superseded"
			st.LastOutcome, st.LastReason = d.Outcome, d.Reason
			return nil
		}
		before, err := captureBeforeImage(ctx, tx, egress)
		if err != nil {
			return err
		}
		if egress != "" {
			if err := hitBlacklist(ctx, tx, egress, inc.ProxyID, inc.AccountID, dynamic, inc.Reason); err != nil {
				return err
			}
			// The release token describes our committed hit, including an upsert
			// onto an older row. A later hit changes this token and prevents release.
			before, err = captureBeforeImage(ctx, tx, egress)
			if err != nil {
				return err
			}
			d.Blacklist = BlacklistDisposition{Status: "saved", Attempts: 1}
		} else {
			d.Blacklist = BlacklistDisposition{Status: "egress_unknown"}
		}
		if target != nil {
			fresh, err := s.loadProxy(ctx, tx, target.ID)
			if err != nil || fresh.Deleted || fresh.Status != "active" {
				target = nil
				if d.Reason == "" {
					d.Reason = "candidate_invalidated"
				}
			} else if fresh.Candidate.endpoint() == old.Candidate.endpoint() {
				target = nil
			} else {
				ips, blocked, err := s.blockedSets(ctx, tx)
				if err != nil {
					return err
				}
				if fresh.Candidate != *target || !usableProxy(target.ID, []RotationCandidate{fresh.Candidate}, ips, blocked) {
					target = nil
				}
			}
		}
		ids := accountIDs(accounts)
		if target != nil {
			newGen, err := nextSharedGeneration(st.Generation, accounts)
			if err != nil {
				return err
			}
			if _, err := writeAccounts(ctx, tx, ids, target.ID, newGen); err != nil {
				return err
			}
			if err := enqueueBulkChange(ctx, tx, accounts); err != nil {
				return err
			}
			st.Generation = newGen
			sharedID := target.ID
			st.SharedProxyID = &sharedID
			st.WaitingForProxy = false
			d.Outcome, d.Reason = "shared_switched", "shared_target_bound"
			d.Attempts = append(d.Attempts, RotationAttempt{ProxyID: target.ID, Outcome: "rotated", Reason: "shared_bound"})
			refreshed = ids
		} else {
			// No usable candidate: keep the fleet where it is but accept the event
			// once (generation bump) so duplicate incidents cannot loop forever.
			newGen, err := nextSharedGeneration(st.Generation, accounts)
			if err != nil {
				return err
			}
			if _, err = writeAccounts(ctx, tx, ids, *inc.ProxyID, newGen); err != nil {
				return err
			}
			if err = enqueueBulkChange(ctx, tx, accounts); err != nil {
				return err
			}
			st.Generation = newGen
			oldID := *inc.ProxyID
			st.SharedProxyID = &oldID
			refreshed = ids
			st.WaitingForProxy = true
			d.Outcome, d.Reason = "shared_waiting", "no_candidate"
		}
		if err := s.freezeRun(ctx, tx, st, inc, old.Candidate, egress, dynamic, before, target, planned); err != nil {
			return err
		}
		now := time.Now().UTC()
		st.UpdatedAt = now
		st.LastOutcome, st.LastReason = d.Outcome, d.Reason
		return nil
	})
	if txErr != nil {
		d.Outcome, d.Reason = "deferred", "shared_commit_failed"
		return d, txErr
	}
	s.refresh(ctx, refreshed)
	return d, nil
}

// freezeRun creates (or merges into) the verification run for the proxy that was
// just abandoned. Cells freeze every admitted account and the most-used model,
// so a later account-set change cannot shrink the round.
func (s *SharedCoordinator) freezeRun(ctx context.Context, tx *sql.Tx, st *SharedState, inc Incident, old RotationCandidate, egress string, dynamic bool, before *SharedBlockedBeforeImage, target *RotationCandidate, planned map[int64]SharedAccount) error {
	now := time.Now().UTC()
	targetID := int64(0)
	if target != nil {
		targetID = target.ID
	}
	var run *SharedRun
	if existing := st.pendingRunFor(*inc.ProxyID); existing != nil {
		run = existing
		// Keep the earliest before-image: it is the observation a release must prove.
		if run.Before == nil && before != nil {
			run.Before = before
		}
		if targetID != 0 {
			run.CutBack = true
		}
	} else {
		id := fmt.Sprintf("%s-%d", SharedRunAuto, now.UnixNano())
		proxyID := *inc.ProxyID
		run = &SharedRun{
			ID: id, Kind: SharedRunAuto, State: SharedRunPending,
			ProxyID: &proxyID, ProxyName: old.Name, Endpoint: old.endpoint(),
			OutboundIP: egress, Dynamic: dynamic,
			Generation: st.Generation, CutBack: targetID != 0,
			WaitingForCandidate: targetID == 0, Before: before,
			CreatedAt: now, UpdatedAt: now,
		}
		if targetID != 0 {
			run.TargetProxyID = &targetID
		}
		accounts, err := s.eligibleAccounts(ctx, tx, false)
		if err != nil {
			return err
		}
		run.Cells = buildCells(accounts, planned)
		run.Recount()
		if st.SharedProxyID != nil {
			run.ProxyIDAfterSwitch = *st.SharedProxyID
		}
		st.Runs = append(st.Runs, *run)
		return nil
	}
	// Merge path: fill in models that the plan now knows, keep recorded verdicts.
	accounts, err := s.eligibleAccounts(ctx, tx, false)
	if err != nil {
		return err
	}
	seen := map[int64]int{}
	for i := range run.Cells {
		seen[run.Cells[i].AccountID] = i
	}
	for _, acc := range accounts {
		if idx, ok := seen[acc.ID]; ok {
			if run.Cells[idx].Model == "" {
				if p, ok := planned[acc.ID]; ok && p.Model != "" {
					run.Cells[idx].Model = p.Model
					run.Cells[idx].ModelRequests = p.ModelRequests
					run.Cells[idx].PlanError = p.PlanError
				}
			}
			continue
		}
		run.Cells = append(run.Cells, buildCells([]sharedAccount{acc}, planned)...)
	}
	if targetID != 0 && run.ProxyIDAfterSwitch != targetID {
		run.ProxyIDAfterSwitch = targetID
	}
	run.UpdatedAt = now
	run.Recount()
	return nil
}

func buildCells(accounts []sharedAccount, planned map[int64]SharedAccount) []SharedCell {
	cells := make([]SharedCell, 0, len(accounts))
	for _, acc := range accounts {
		cell := SharedCell{
			AccountID: acc.ID, Status: SharedCellPending,
			RestoreEpoch: acc.RestoreEpoch,
		}
		if p, ok := planned[acc.ID]; ok {
			cell.Model = p.Model
			cell.ModelRequests = p.ModelRequests
			cell.PlanError = p.PlanError
		} else {
			cell.PlanError = "plan_missing"
		}
		cells = append(cells, cell)
	}
	return cells
}

// planAccounts freezes the most-used model per account. It is only called when a
// new run is created (never from the polling loop), so the usage aggregation is
// not repeated on every tick.
func (s *SharedCoordinator) planAccounts(ctx context.Context) map[int64]SharedAccount {
	out := map[int64]SharedAccount{}
	if s.opts.Plan == nil {
		return out
	}
	planned, err := s.opts.Plan(ctx, s.snapshot())
	if err != nil {
		return out
	}
	for _, p := range planned {
		out[p.ID] = p
	}
	return out
}

// selectTarget walks the candidate ring right after the current proxy and returns
// the first one whose egress validates. Occupied proxies are valid targets.
func (s *SharedCoordinator) selectTarget(ctx context.Context, current int64, currentEndpoint string) (*RotationCandidate, CandidateSelection, error) {
	audit := CandidateSelection{Excluded: map[string]int{}, Candidates: []CandidateDecision{}}
	if s.db == nil {
		return nil, audit, rotationError("db_unavailable", ErrRotationUnavailable)
	}
	cands, err := s.activeProxies(ctx, s.db)
	if err != nil {
		audit.Error = "active_query"
		return nil, audit, rotationError("active_query", err)
	}
	audit.Total = len(cands)
	blockedIPs, blockedProxies, err := s.blockedSets(ctx, s.db)
	if err != nil {
		audit.Error = "blocked_query"
		return nil, audit, rotationError("blocked_query", err)
	}
	ring := candidateRing(cands, &current, currentEndpoint, blockedIPs, blockedProxies)
	audit.Eligible = len(ring)
	audit.Complete = true
	for i := range ring {
		if i >= s.rotationBudget() {
			return nil, audit, rotationError("attempt_budget", ErrRotationUnavailable)
		}
		c := ring[i]
		if s.opts.ValidateProxy != nil {
			if err := s.opts.ValidateProxy(ctx, c); err != nil {
				audit.Candidates = append(audit.Candidates, CandidateDecision{ProxyID: c.ID, Reason: rotationReason(err)})
				audit.Excluded["validation"]++
				if errorsIsContext(err) {
					return nil, audit, err
				}
				continue
			}
		}
		audit.Candidates = append(audit.Candidates, CandidateDecision{ProxyID: c.ID, Reason: "verified"})
		return &ring[i], audit, nil
	}
	return nil, audit, nil
}

func errorsIsContext(err error) bool {
	return err != nil && (errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded))
}

func usableProxy(id int64, cands []RotationCandidate, blockedIPs map[string]struct{}, blockedProxies map[int64]struct{}) bool {
	for _, c := range cands {
		if c.ID != id {
			continue
		}
		if _, bad := blockedProxies[c.ID]; bad {
			return false
		}
		if ip := strings.TrimSpace(c.Host); net.ParseIP(ip) != nil {
			if _, dirty := blockedIPs[ip]; dirty {
				return false
			}
		}
		return true
	}
	return false
}

func accountIDs(accounts []sharedAccount) []int64 {
	ids := make([]int64, len(accounts))
	for i := range accounts {
		ids[i] = accounts[i].ID
	}
	return ids
}

func (s *SharedCoordinator) refresh(ctx context.Context, ids []int64) {
	if len(ids) == 0 || s.opts.RefreshAccounts == nil {
		return
	}
	_ = s.opts.RefreshAccounts(ctx, ids)
}

// State returns the non-secret coordination view.
func (s *SharedCoordinator) State(ctx context.Context) (SharedState, error) {
	st, err := s.readState(ctx)
	if err != nil {
		return SharedState{}, err
	}
	st.Enabled = s.sharedEnabled()
	if st.UpdatedAt.IsZero() {
		st.UpdatedAt = time.Now().UTC()
	}
	if s.db != nil {
		if n, err := blockedRowCount(ctx, s.db); err == nil {
			st.BlockedCount = n
		}
	}
	if st.Runs == nil {
		st.Runs = []SharedRun{}
	}
	for i := range st.Runs {
		st.Runs[i].Recount()
	}
	return *st, nil
}

// EnqueueBackfill freezes one verification run per existing blacklist row against
// the current admitted account set. Historical runs never cut back.
func (s *SharedCoordinator) EnqueueBackfill(ctx context.Context) (string, error) {
	if s == nil || s.db == nil {
		return "", ErrRotationUnavailable
	}
	if !s.sharedEnabled() {
		return "", ErrSharedDisabled
	}
	batch := fmt.Sprintf("%s-%d", SharedRunBackfill, time.Now().UTC().UnixNano())
	planned := s.planAccounts(ctx)
	created := 0
	err := s.withState(ctx, func(tx *sql.Tx, st *SharedState) error {
		rows, err := loadBlockedRows(ctx, tx)
		if err != nil {
			return err
		}
		accounts, err := s.eligibleAccounts(ctx, tx, false)
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		for _, row := range rows {
			proxyID := row.ProxyID
			endpoint := ""
			name := ""
			if proxyID == nil {
				if resolved, err := resolveProxyByHost(ctx, tx, row.OutboundIP); err == nil && resolved != nil {
					proxyID = resolved
				}
			}
			if proxyID != nil {
				if p, err := s.loadProxy(ctx, tx, *proxyID); err == nil {
					endpoint = p.Candidate.endpoint()
					name = p.Candidate.Name
				}
			}
			if st.hasOpenBackfill(row.OutboundIP) {
				continue
			}
			run := SharedRun{
				ID:   fmt.Sprintf("%s-%s-%d", SharedRunBackfill, sanitizeID(row.OutboundIP), now.UnixNano()),
				Kind: SharedRunBackfill, State: SharedRunPending,
				ProxyID: proxyID, ProxyName: name, Endpoint: endpoint,
				OutboundIP: row.OutboundIP, Dynamic: row.Image != nil && row.Image.IsDynamic,
				Generation: st.Generation, CutBack: false,
				Before: row.Image, BatchID: batch,
				CreatedAt: now, UpdatedAt: now,
			}
			run.Cells = buildCells(accounts, planned)
			run.Recount()
			st.Runs = append(st.Runs, run)
			created++
		}
		return nil
	})
	if err != nil {
		return "", err
	}
	if created == 0 {
		batch = ""
	}
	return batch, nil
}

func (st *SharedState) hasOpenBackfill(ip string) bool {
	for i := range st.Runs {
		r := &st.Runs[i]
		if r.Kind != SharedRunBackfill || r.Terminal() {
			continue
		}
		if strings.EqualFold(r.OutboundIP, ip) {
			return true
		}
	}
	return false
}

type blockedRow struct {
	OutboundIP string
	ProxyID    *int64
	Image      *SharedBlockedBeforeImage
}

func loadBlockedRows(ctx context.Context, q sharedQueryer) ([]blockedRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, outbound_ip, proxy_id, account_id, is_dynamic, reason, hit_count, last_hit_at
		FROM poison_blocked_egress ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []blockedRow
	for rows.Next() {
		img := &SharedBlockedBeforeImage{}
		var proxyID, accountID sql.NullInt64
		if err := rows.Scan(&img.ID, &img.OutboundIP, &proxyID, &accountID, &img.IsDynamic, &img.Reason, &img.HitCount, &img.LastHitAt); err != nil {
			return nil, err
		}
		row := blockedRow{OutboundIP: img.OutboundIP, Image: img}
		if proxyID.Valid {
			id := proxyID.Int64
			img.ProxyID = &id
			row.ProxyID = &id
		}
		if accountID.Valid {
			id := accountID.Int64
			img.AccountID = &id
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// resolveProxyByHost maps a legacy blacklist row without proxy_id back to a proxy
// row. Soft-deleted proxies are included: their configuration is still usable for
// verification, they are simply never selected as an active target.
func resolveProxyByHost(ctx context.Context, q sharedQueryer, ip string) (*int64, error) {
	var id int64
	err := q.QueryRowContext(ctx, `SELECT id FROM proxies WHERE lower(btrim(host))=$1 ORDER BY id LIMIT 1`, strings.ToLower(strings.TrimSpace(ip))).Scan(&id)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &id, nil
}

func sanitizeID(s string) string {
	s = strings.TrimSpace(strings.ToLower(s))
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('_')
	}
	if b.Len() == 0 {
		return "unknown"
	}
	return b.String()
}

// Start launches the verification worker. It is idempotent and does nothing when
// shared mode is off, so the parent can call it unconditionally.
func (s *SharedCoordinator) Start(ctx context.Context) {
	if s == nil || s.db == nil {
		return
	}
	s.mu.Lock()
	if s.started {
		s.mu.Unlock()
		return
	}
	workerCtx, cancel := context.WithCancel(ctx)
	s.cancel = cancel
	s.started = true
	done := make(chan struct{})
	s.done = done
	s.mu.Unlock()
	go s.loop(workerCtx, done)
}

// Stop cancels the worker and waits for it to exit.
func (s *SharedCoordinator) Stop() {
	if s == nil {
		return
	}
	s.mu.Lock()
	cancel, done := s.cancel, s.done
	s.started = false
	s.cancel = nil
	s.done = nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if done != nil {
		<-done
	}
}

func (s *SharedCoordinator) loop(ctx context.Context, done chan struct{}) {
	defer close(done)
	interval := s.Interval
	if interval <= 0 {
		interval = 30 * time.Second
	}
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		if err := s.Tick(ctx); err != nil && ctx.Err() == nil {
			// Errors are retried on the next tick; nothing is marked clean on failure.
			_ = err
		}
		timer.Reset(interval)
	}
}

func sharedHostname() string {
	if h, err := os.Hostname(); err == nil && h != "" {
		return h
	}
	return "host"
}

func sharedPID() int { return os.Getpid() }
