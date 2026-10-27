package poison

import (
	"context"
	"time"
)

const SharedGenerationKey = "poison_guard_shared_generation"
const SettingSharedEnabled = "poison_guard_shared_enabled"

// SharedAccount is a frozen, non-secret target for a proxy verification round.
// Model is the most-used requested model across the account's groups.
type SharedAccount struct {
	ID               int64   `json:"account_id"`
	BaseURL          string  `json:"base_url"`
	ProxyID          *int64  `json:"proxy_id"`
	Status           string  `json:"status"`
	Schedulable      bool    `json:"schedulable"`
	RestoreEpoch     int64   `json:"restore_epoch"`
	SharedGeneration int64   `json:"shared_generation"`
	GroupIDs         []int64 `json:"group_ids"`
	Model            string  `json:"model"`
	ModelRequests    int64   `json:"model_requests"`
	PlanError        string  `json:"plan_error,omitempty"`
}

// SharedProbeRequest is runtime-only: Proxy credentials must never be persisted.
type SharedProbeRequest struct {
	AccountID int64
	Model     string
	Proxy     RotationCandidate
	Snapshot  *Snapshot
}

// SharedProbeResult is safe to persist; Reason is a short category, not a raw error.
type SharedProbeResult struct {
	Verdict        string    `json:"verdict"` // poison, clean, inconclusive
	Reason         string    `json:"reason"`
	Model          string    `json:"model"`
	Matched        []string  `json:"matched,omitempty"`
	HTTPStatus     int       `json:"http_status"`
	ReceivedBytes  int64     `json:"received_bytes"`
	ResponseSHA256 string    `json:"response_sha256,omitempty"`
	StartedAt      time.Time `json:"started_at"`
	FinishedAt     time.Time `json:"finished_at"`
}

type SharedProbeFunc func(context.Context, SharedProbeRequest) (SharedProbeResult, error)
type SharedPlanFunc func(context.Context, *Snapshot) ([]SharedAccount, error)
