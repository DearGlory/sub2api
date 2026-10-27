package poison

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net"
	"strings"
)

var (
	ErrEgressBlocked          = errors.New("candidate egress blocked")
	ErrRotationUnavailable    = errors.New("rotation dependency unavailable")
	ErrBlacklistCommitUnknown = errors.New("blacklist commit outcome unknown")
)

// RotationError preserves the cause for errors.Is without putting credentials in audit output.
type RotationError struct {
	Kind  string
	Cause error
}

func (e *RotationError) Error() string             { return e.Kind }
func (e *RotationError) Unwrap() error             { return e.Cause }
func rotationError(kind string, cause error) error { return &RotationError{Kind: kind, Cause: cause} }
func rotationReason(err error) string {
	if errors.Is(err, context.Canceled) {
		return "context_canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "context_deadline"
	}
	if errors.Is(err, ErrEgressBlocked) {
		return "egress_blocked"
	}
	if errors.Is(err, ErrRotationUnavailable) {
		return "dependency_unavailable"
	}
	var typed *RotationError
	if errors.As(err, &typed) {
		return typed.Kind
	}
	return "operation_failed"
}

type CandidateDecision struct {
	ProxyID int64  `json:"proxy_id"`
	Reason  string `json:"reason"`
}
type CandidateSelection struct {
	Total      int                 `json:"total"`
	Eligible   int                 `json:"eligible"`
	Complete   bool                `json:"complete"`
	Excluded   map[string]int      `json:"excluded"`
	Candidates []CandidateDecision `json:"candidates"`
	Error      string              `json:"error,omitempty"`
}
type RotationAttempt struct {
	ProxyID int64  `json:"proxy_id"`
	Outcome string `json:"outcome"`
	Reason  string `json:"reason"`
}
type BlacklistDisposition struct {
	Status   string `json:"status"`
	Attempts int    `json:"attempts"`
}

// Disposition contains only allowlisted identifiers and enums; never proxy URLs or raw errors.
type Disposition struct {
	AccountID    int64                `json:"account_id"`
	RequestID    string               `json:"request_id"`
	EvidenceID   string               `json:"evidence_id"`
	EvidencePath string               `json:"evidence_path"`
	Outcome      string               `json:"outcome"`
	Reason       string               `json:"reason"`
	Retryable    bool                 `json:"retryable"`
	Blacklist    BlacklistDisposition `json:"blacklist"`
	Selections   []CandidateSelection `json:"selections"`
	Attempts     []RotationAttempt    `json:"attempts"`
}

func (h *Handler) report(inc Incident, d Disposition) {
	d.Retryable = d.Outcome == "deferred"
	b, _ := json.Marshal(d)
	log.Printf("[poison] disposition %s", b)
	if h != nil && h.ReportDisposition != nil {
		func() {
			defer func() {
				if recover() != nil {
					log.Printf("[poison] disposition evidence_id=%s error=callback_panic", inc.EvidenceID)
				}
			}()
			h.ReportDisposition(inc, d)
		}()
	}
}

// recordIncidentBlacklist distinguishes a safely rolled-back attempt from an
// ambiguous Commit. Replaying the latter could increment a successful hit twice.
// Keep the permanent upsert and rotation lock identical to EgressStore.Record.
func recordIncidentBlacklist(ctx context.Context, s *EgressStore, ip string, inc Incident, dynamic bool) error {
	if s == nil || s.db == nil {
		return ErrRotationUnavailable
	}
	ip = strings.TrimSpace(ip)
	if net.ParseIP(ip) == nil {
		return rotationError("invalid_egress", ErrRotationUnavailable)
	}
	reason := inc.Reason
	if len(reason) > 255 {
		reason = reason[:255]
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "SELECT pg_advisory_xact_lock($1)", RotationLockKey); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO poison_blocked_egress (outbound_ip, proxy_id, account_id, is_dynamic, reason)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (outbound_ip) DO UPDATE SET
			hit_count = poison_blocked_egress.hit_count + 1,
			last_hit_at = NOW(),
			is_dynamic = poison_blocked_egress.is_dynamic OR EXCLUDED.is_dynamic
	`, ip, inc.ProxyID, &inc.AccountID, dynamic, reason)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return errors.Join(ErrBlacklistCommitUnknown, err)
	}
	return nil
}
