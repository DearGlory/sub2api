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

// SharedRunCounts is the per-run progress ledger. Completed counts every cell
// with a terminal observation, including inconclusive ones.
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
	// TargetProxyID is the proxy the fleet moved to when the run was created.
	TargetProxyID *int64 `json:"target_proxy_id,omitempty"`
	// ProxyIDAfterSwitch is the pointer value right after the switch, used as part
	// of the cut-back CAS.
	ProxyIDAfterSwitch  int64                     `json:"proxy_id_after_switch,omitempty"`
	WaitingForCandidate bool                      `json:"waiting_for_candidate,omitempty"`
	ReleaseReason       string                    `json:"release_reason,omitempty"`
	BatchID             string                    `json:"batch_id,omitempty"`
	CreatedAt           time.Time                 `json:"created_at"`
	UpdatedAt           time.Time                 `json:"updated_at"`
	LeaseOwner          string                    `json:"lease_owner,omitempty"`
	LeaseUntil          time.Time                 `json:"lease_until,omitempty"`
	Before              *SharedBlockedBeforeImage `json:"before_image,omitempty"`
	Cells               []SharedCell              `json:"cells"`
	Counts              SharedRunCounts           `json:"counts"`
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
			c.Completed++
		}
	}
	r.Counts = c
}

// AllClean reports a fully covered round with no poison and nothing inconclusive.
func (r *SharedRun) AllClean() bool {
	r.Recount()
	return r.Counts.Expected > 0 && r.Counts.Clean == r.Counts.Expected && r.Counts.Poison == 0 && r.Counts.Inconclusive == 0
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

// trimRuns keeps the ledger bounded: unfinished runs are never dropped, finished
// ones fall off oldest-first.
func (s *SharedState) trimRuns() {
	if len(s.Runs) <= sharedRunRetention {
		return
	}
	keep := make([]SharedRun, 0, sharedRunRetention)
	excess := len(s.Runs) - sharedRunRetention
	for i := range s.Runs {
		if excess > 0 && s.Runs[i].Terminal() {
			excess--
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
