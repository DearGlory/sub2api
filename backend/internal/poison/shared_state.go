package poison

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"time"
)

// SettingSharedState stores the whole shared-proxy coordination document.
//
// Everything shared between instances lives in this single settings row so one
// transaction (advisory lock + row lock) can advance the pointer, freeze a
// verification run and record verdicts atomically. No new table, no migration.
const SettingSharedState = "poison_guard_shared_state"

// sharedRunRetention bounds the ledger kept in the settings row.
const sharedRunRetention = 20

// sharedRunRetentionAge drops terminal ledger units older than this even when the
// retention count is not exceeded, so a long-idle deployment does not accumulate
// a stale document. Trimming is always unit-based (see trimRuns).
const sharedRunRetentionAge = 7 * 24 * time.Hour

// Run kinds.
const (
	SharedRunAuto     = "auto"
	SharedRunBackfill = "backfill"
)

// Run states.
const (
	SharedRunPending     = "pending"
	SharedRunRunning     = "running"
	SharedRunConfirmed   = "confirmed"
	SharedRunReleased    = "released"
	SharedRunReleasedOld = "released_no_switch"
	SharedRunSuperseded  = "superseded"
)

// Cell states.
const (
	SharedCellPending      = "pending"
	SharedCellRunning      = "running"
	SharedCellDone         = "done"
	SharedCellClean        = "clean"
	SharedCellPoison       = "poison"
	SharedCellInconclusive = "inconclusive"
)

// SharedState is the non-secret, serializable view served to the admin API.
type SharedState struct {
	Enabled         bool        `json:"enabled"`
	SharedProxyID   *int64      `json:"shared_proxy_id"`
	Generation      int64       `json:"generation"`
	WaitingForProxy bool        `json:"waiting_for_proxy,omitempty"`
	ActiveRun       string      `json:"active_run,omitempty"`
	LastOutcome     string      `json:"last_outcome,omitempty"`
	LastReason      string      `json:"last_reason,omitempty"`
	UpdatedAt       time.Time   `json:"updated_at"`
	Runs            []SharedRun `json:"runs,omitempty"`
	BlockedCount    int         `json:"blocked_count,omitempty"`
	Notes           []string    `json:"notes,omitempty"`
}

// SharedRunCounts is the per-run progress ledger.
//
// Completed counts only definitive observations (clean or poison). An
// inconclusive attempt is recorded in Inconclusive but never as completed: it is
// re-queued and the round stays open until a real verdict lands.
type SharedRunCounts struct {
	Expected     int `json:"expected"`
	Completed    int `json:"completed"`
	Pending      int `json:"pending"`
	Clean        int `json:"clean"`
	Poison       int `json:"poison"`
	Inconclusive int `json:"inconclusive"`
}

// SharedBlockedBeforeImage is the exact blacklist row captured before a hit, so a
// later release can prove it is deleting the same observation and not a new hit.
type SharedBlockedBeforeImage struct {
	ID         int64     `json:"id"`
	OutboundIP string    `json:"outbound_ip"`
	ProxyID    *int64    `json:"proxy_id,omitempty"`
	AccountID  *int64    `json:"account_id,omitempty"`
	IsDynamic  bool      `json:"is_dynamic"`
	Reason     string    `json:"reason"`
	HitCount   int       `json:"hit_count"`
	FirstHitAt time.Time `json:"first_hit_at,omitempty"`
	LastHitAt  time.Time `json:"last_hit_at"`
}

// SharedCell is one frozen (account, model) probe. RestoreEpoch is the value the
// account had when the run was frozen; a changed epoch means an administrator
// rebound the account and the run must not overwrite it.
type SharedCell struct {
	AccountID     int64     `json:"account_id"`
	Model         string    `json:"model"`
	ModelRequests int64     `json:"model_requests,omitempty"`
	PlanError     string    `json:"plan_error,omitempty"`
	RestoreEpoch  int64     `json:"restore_epoch"`
	Status        string    `json:"status"`
	Attempts      int       `json:"attempts"`
	NextAttemptAt time.Time `json:"next_attempt_at,omitempty"`
	LeaseOwner    string    `json:"lease_owner,omitempty"`
	LeaseUntil    time.Time `json:"lease_until,omitempty"`
	Verdict       string    `json:"verdict,omitempty"`
	Reason        string    `json:"reason,omitempty"`
	Matched       []string  `json:"matched,omitempty"`
	HTTPStatus    int       `json:"http_status,omitempty"`
	ReceivedBytes int64     `json:"received_bytes,omitempty"`
	ResponseSHA   string    `json:"response_sha256,omitempty"`
	StartedAt     time.Time `json:"started_at,omitempty"`
	FinishedAt    time.Time `json:"finished_at,omitempty"`
}

// SharedRun is one verification round for one proxy. Automatic runs (created by
// a hit) cut back on all-clean; historical backfill runs never do.
type SharedRun struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	State      string `json:"state"`
	ProxyID    *int64 `json:"proxy_id,omitempty"`
	ProxyName  string `json:"proxy_name,omitempty"`
	Endpoint   string `json:"endpoint,omitempty"`
	OutboundIP string `json:"outbound_ip,omitempty"`
	Dynamic    bool   `json:"dynamic,omitempty"`
	// Generation is the shared generation that existed when the run was frozen.
	Generation int64 `json:"generation"`
	// CutBack records the intent; the actual cut-back re-checks the generation.
	CutBack bool `json:"cut_back,omitempty"`
	// PoisonConfirmed records the verdict (one hit is enough to keep the row)
	// independently of completion: the run only becomes terminal once every cell
	// has a definitive observation.
	PoisonConfirmed bool `json:"poison_confirmed,omitempty"`
	// TargetProxyID is the proxy the fleet moved to when the run was created.
	TargetProxyID *int64 `json:"target_proxy_id,omitempty"`
	// ProxyIDAfterSwitch is the pointer value right after the switch, used as part
	// of the cut-back CAS.
	ProxyIDAfterSwitch  int64     `json:"proxy_id_after_switch,omitempty"`
	WaitingForCandidate bool      `json:"waiting_for_candidate,omitempty"`
	ReleaseReason       string    `json:"release_reason,omitempty"`
	BatchID             string    `json:"batch_id,omitempty"`
	CreatedAt           time.Time `json:"created_at"`
	UpdatedAt           time.Time `json:"updated_at"`
	LeaseOwner          string    `json:"lease_owner,omitempty"`
	LeaseUntil          time.Time `json:"lease_until,omitempty"`
	// Before is the release token: the row as it exists after this run's own hit
	// upsert, so a later all-clean round deletes exactly this observation.
	Before *SharedBlockedBeforeImage `json:"before_image,omitempty"`
	// Previous keeps the pre-upsert row for audit, so a confirmed hit can still
	// show what was already on record before this run touched it.
	Previous *SharedBlockedBeforeImage `json:"previous_blacklist,omitempty"`
	Cells    []SharedCell              `json:"cells"`
	Counts   SharedRunCounts           `json:"counts"`
}

// Terminal reports whether the run no longer needs probe work.
func (r *SharedRun) Terminal() bool {
	if r == nil {
		return true
	}
	switch r.State {
	case SharedRunConfirmed, SharedRunReleased, SharedRunReleasedOld, SharedRunSuperseded:
		return true
	}
	return false
}

// Recount refreshes the derived counters from the cells.
//
// Clean/Poison/Inconclusive describe the last observation of every cell, while
// Pending counts the cells that still need another attempt. A cell can therefore
// be "inconclusive" (last attempt failed) and "pending" (will be retried) at the
// same time, which is exactly the state a release must not mistake for clean.
func (r *SharedRun) Recount() {
	c := SharedRunCounts{Expected: len(r.Cells)}
	for i := range r.Cells {
		cell := &r.Cells[i]
		if cell.Status == SharedCellPending || cell.Status == SharedCellRunning {
			c.Pending++
		}
		switch cell.Verdict {
		case SharedCellClean:
			c.Clean++
			c.Completed++
		case SharedCellPoison:
			c.Poison++
			c.Completed++
		case SharedCellInconclusive:
			c.Inconclusive++
		}
	}
	r.Counts = c
}

// FullyObserved reports whether every frozen cell carries a definitive
// observation (clean or poison) and no retry is outstanding. An empty round is
// never considered observed: no coverage, no verdict.
func (r *SharedRun) FullyObserved() bool {
	if r == nil || len(r.Cells) == 0 {
		return false
	}
	for i := range r.Cells {
		cell := &r.Cells[i]
		if cell.Status != SharedCellDone {
			return false
		}
		switch cell.Verdict {
		case SharedCellClean, SharedCellPoison:
		default:
			return false
		}
	}
	return true
}

// AllClean reports a fully covered round with no poison and nothing inconclusive.
// Every cell must be done: an empty or partially observed round never releases.
func (r *SharedRun) AllClean() bool {
	if !r.FullyObserved() {
		return false
	}
	r.Recount()
	return r.Counts.Expected > 0 && r.Counts.Clean == r.Counts.Expected &&
		r.Counts.Poison == 0 && r.Counts.Inconclusive == 0 && r.Counts.Pending == 0
}

// AnyPoison reports a confirmed poisoning observation.
func (r *SharedRun) AnyPoison() bool {
	r.Recount()
	return r.Counts.Poison > 0
}

func (s *SharedState) run(id string) *SharedRun {
	for i := range s.Runs {
		if s.Runs[i].ID == id {
			return &s.Runs[i]
		}
	}
	return nil
}

// pendingRunFor returns the newest unfinished run for a proxy, so a repeated hit
// merges into the existing round instead of stacking duplicates.
func (s *SharedState) pendingRunFor(proxyID int64) *SharedRun {
	for i := len(s.Runs) - 1; i >= 0; i-- {
		r := &s.Runs[i]
		if r.Terminal() {
			continue
		}
		if r.ProxyID != nil && *r.ProxyID == proxyID {
			return r
		}
	}
	return nil
}

// waitingRun returns the newest unfinished round that was frozen while no usable
// candidate existed, so a later reconciliation can finish its switch.
func (s *SharedState) waitingRun() *SharedRun {
	for i := len(s.Runs) - 1; i >= 0; i-- {
		r := &s.Runs[i]
		if r.Terminal() || r.Kind != SharedRunAuto {
			continue
		}
		if r.WaitingForCandidate {
			return r
		}
	}
	return nil
}

// runUnit is one independently trimmable slice of the ledger: a whole historical
// batch (all runs sharing BatchID) or a single automatic round.
type runUnit struct {
	key  string
	idxs []int
}

// units groups the ledger into trimmable units, preserving ledger order. A
// historical batch is one unit so a sweep of 19 proxies stays fully queryable
// instead of being decimated by the per-run retention count.
func (s *SharedState) units() []runUnit {
	order := make([]runUnit, 0, len(s.Runs))
	index := map[string]int{}
	for i := range s.Runs {
		r := &s.Runs[i]
		if r.BatchID == "" {
			// Automatic rounds are independent of each other.
			order = append(order, runUnit{key: "run:" + r.ID, idxs: []int{i}})
			continue
		}
		if at, ok := index["batch:"+r.BatchID]; ok {
			order[at].idxs = append(order[at].idxs, i)
			continue
		}
		index["batch:"+r.BatchID] = len(order)
		order = append(order, runUnit{key: "batch:" + r.BatchID, idxs: []int{i}})
	}
	return order
}

// trimRuns keeps the ledger bounded without ever cutting a unit in half.
//
// Rules:
//   - a run that is still open keeps its whole unit (batch) alive;
//   - a unit is dropped only when every run in it is terminal;
//   - a historical batch is only ever dropped as a whole, and only once it has
//     expired (older than sharedRunRetentionAge): an operator must still be able
//     to audit the full sweep that unblocked 19 proxies;
//   - automatic rounds expire by age and are otherwise capped at
//     sharedRunRetention. Automatic rounds are complete or absent: never partial.
func (s *SharedState) trimRuns() {
	units := s.units()
	if len(units) == 0 {
		return
	}
	now := time.Now().UTC()
	drop := make([]bool, len(s.Runs))
	autoUnits := 0
	for _, unit := range units {
		if !strings.HasPrefix(unit.key, "batch:") {
			autoUnits++
		}
	}
	excess := autoUnits - sharedRunRetention
	for _, unit := range units {
		batch := strings.HasPrefix(unit.key, "batch:")
		terminal := true
		newest := time.Time{}
		for _, idx := range unit.idxs {
			r := &s.Runs[idx]
			if !r.Terminal() {
				terminal = false
				break
			}
			updated := r.UpdatedAt
			if updated.IsZero() {
				updated = r.CreatedAt
			}
			if updated.After(newest) {
				newest = updated
			}
		}
		if !terminal {
			continue
		}
		expired := !newest.IsZero() && now.Sub(newest) > sharedRunRetentionAge
		if !expired && (batch || excess <= 0) {
			continue
		}
		for _, idx := range unit.idxs {
			drop[idx] = true
		}
		if !expired {
			excess--
		}
	}
	keep := make([]SharedRun, 0, len(s.Runs))
	for i := range s.Runs {
		if drop[i] {
			continue
		}
		keep = append(keep, s.Runs[i])
	}
	s.Runs = keep
}

// sortRuns keeps deterministic ordering (oldest first) for the ledger.
func (s *SharedState) sortRuns() {
	sort.SliceStable(s.Runs, func(i, j int) bool {
		if s.Runs[i].CreatedAt.Equal(s.Runs[j].CreatedAt) {
			return s.Runs[i].ID < s.Runs[j].ID
		}
		return s.Runs[i].CreatedAt.Before(s.Runs[j].CreatedAt)
	})
}

var errSharedStateCorrupt = errors.New("shared state document corrupt")

func decodeSharedState(raw string) (*SharedState, error) {
	trimmed := strings.TrimSpace(raw)
	st := &SharedState{}
	if trimmed == "" || trimmed == "null" {
		return st, nil
	}
	dec := json.NewDecoder(strings.NewReader(trimmed))
	dec.UseNumber()
	if err := dec.Decode(st); err != nil {
		return nil, errSharedStateCorrupt
	}
	return st, nil
}

func encodeSharedState(st *SharedState) (string, error) {
	st.sortRuns()
	st.trimRuns()
	b, err := json.Marshal(st)
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// CountBlocked is exported for the admin view and never leaks credentials.
func CountBlocked(rows []BlockedEgress) int { return len(rows) }
