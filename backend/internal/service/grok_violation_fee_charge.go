package service

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ip"
	"github.com/gin-gonic/gin"
)

// grokViolationFeeRequestIDSuffix keeps the fee row on its own billing key so it
// can never collide with (or be deduplicated against) the request's normal usage
// row. The usage-billing repository applies each key at most once.
const grokViolationFeeRequestIDSuffix = ":violation_fee"

// GrokViolationFeeInput describes a detected xAI safety-check violation that must
// be billed to the calling credential.
type GrokViolationFeeInput struct {
	RequestID    string
	Model        string
	StatusCode   int
	Stream       bool
	APIKey       *APIKey
	Account      *Account
	Subscription *UserSubscription
	// Inbound/Upstream endpoint and request metadata are recorded on the fee row
	// so the charge is traceable in the normal usage log view.
	InboundEndpoint    string
	UpstreamEndpoint   string
	UserAgent          string
	IPAddress          string
	SessionID          string
	RequestPayloadHash string
	APIKeyService      APIKeyQuotaUpdater
}

// ChargeGrokViolationFeeIfNeeded bills the caller for one detected xAI
// usage-guidelines violation.
//
// Why a separate charge: xAI charges the account holder an extra fee for a
// request its safety check blocks. Without this, that cost is invisible on the
// caller-facing ledger. The amount is operator-configurable
// (grok_violation_fee_settings) and multiplied by the caller's group rate, so a
// violation costs the same proportion as normal usage.
//
// It is deliberately idempotent per request: the billing key is
// "<request_id>:violation_fee", so a retried refusal inside the same request
// cannot double-charge.
func (s *OpenAIGatewayService) ChargeGrokViolationFeeIfNeeded(ctx context.Context, in GrokViolationFeeInput) bool {
	if s == nil || in.APIKey == nil || in.APIKey.User == nil || s.usageBillingRepo == nil {
		return false
	}
	requestID := strings.TrimSpace(in.RequestID)
	model := strings.TrimSpace(in.Model)
	if requestID == "" || model == "" {
		return false
	}

	amount := s.grokViolationFeeAmount(ctx)
	if amount <= 0 {
		return false
	}

	multiplier := 1.0
	if in.APIKey.Group != nil {
		groupID := int64(0)
		if in.APIKey.GroupID != nil {
			groupID = *in.APIKey.GroupID
		}
		multiplier = s.ResolveUserGroupRateMultiplier(
			ctx, in.APIKey.User.ID, groupID, in.APIKey.Group.RateMultiplier)
	}
	if multiplier < 0 {
		multiplier = 0
	}
	cost := amount * multiplier

	var accountID int64
	if in.Account != nil {
		accountID = in.Account.ID
	}
	var subscriptionID *int64
	if in.Subscription != nil {
		subscriptionID = &in.Subscription.ID
	}

	cmd := &UsageBillingCommand{
		RequestID:       requestID + grokViolationFeeRequestIDSuffix,
		APIKeyID:        in.APIKey.ID,
		UserID:          in.APIKey.User.ID,
		AccountID:       accountID,
		SubscriptionID:  subscriptionID,
		Model:           model,
		BillingType:     BillingTypeBalance,
		BalanceCost:     cost,
		APIKeyQuotaCost: cost,
	}
	if _, err := s.usageBillingRepo.Apply(ctx, cmd); err != nil {
		slog.Warn("grok_violation_fee_apply_failed",
			"request_id", requestID, "model", model, "error", err)
		return false
	}

	s.recordGrokViolationFeeUsageLog(ctx, in, cost, multiplier)
	return true
}

// recordGrokViolationFeeUsageLog writes the audit row for a charged fee. Failures
// are logged and never propagated: the balance was already applied above, and a
// missing audit row must not turn a billing success into a request error.
func (s *OpenAIGatewayService) recordGrokViolationFeeUsageLog(
	ctx context.Context,
	in GrokViolationFeeInput,
	cost, multiplier float64,
) {
	if s == nil || s.usageLogRepo == nil {
		return
	}
	requestedModel := strings.TrimSpace(in.Model)
	entry := &UsageLog{
		UserID:           in.APIKey.User.ID,
		APIKeyID:         in.APIKey.ID,
		RequestID:        strings.TrimSpace(in.RequestID),
		Model:            requestedModel,
		RequestedModel:   requestedModel,
		TotalCost:        cost,
		ActualCost:       cost,
		RateMultiplier:   multiplier,
		BillingType:      BillingTypeBalance,
		RequestType:      RequestTypeCyberBlocked,
		Stream:           in.Stream,
		InboundEndpoint:  optionalTrimmedString(in.InboundEndpoint),
		UpstreamEndpoint: optionalTrimmedString(in.UpstreamEndpoint),
		UserAgent:        optionalTrimmedString(in.UserAgent),
		IPAddress:        optionalTrimmedString(in.IPAddress),
		SessionID:        optionalTrimmedString(in.SessionID),
		CreatedAt:        time.Now(),
	}
	if in.Account != nil {
		entry.AccountID = in.Account.ID
	}
	if in.APIKey.GroupID != nil {
		entry.GroupID = in.APIKey.GroupID
	}
	if _, err := s.usageLogRepo.Create(ctx, entry); err != nil {
		slog.Warn("grok_violation_fee_usage_log_failed",
			"request_id", in.RequestID, "error", err)
	}
}

// GrokViolationFeeInputFromGin assembles the billing input from the live request.
// It returns ok=false when the caller identity is unavailable, in which case the
// violation is observed but not charged.
func GrokViolationFeeInputFromGin(c *gin.Context, model string, statusCode int, stream bool) (GrokViolationFeeInput, bool) {
	if c == nil {
		return GrokViolationFeeInput{}, false
	}
	apiKey := getAPIKeyFromContext(c)
	if apiKey == nil || apiKey.User == nil {
		return GrokViolationFeeInput{}, false
	}
	in := GrokViolationFeeInput{
		RequestID:       grokViolationFeeRequestIDFrom(c),
		Model:           strings.TrimSpace(model),
		StatusCode:      statusCode,
		Stream:          stream,
		APIKey:          apiKey,
		InboundEndpoint: inboundPathFromGin(c),
		UserAgent:       strings.TrimSpace(c.GetHeader("User-Agent")),
		IPAddress:       strings.TrimSpace(clientIPFromGin(c)),
		SessionID:       ExtractClientSessionID(c),
	}
	if in.RequestID == "" || in.Model == "" {
		return GrokViolationFeeInput{}, false
	}
	return in, true
}

// grokViolationFeeRequestIDFrom resolves the request id for the fee row.
//
// The request context is authoritative: the request-id middleware installs it
// before any handler runs, so it is always populated. Reading only the response
// writer header is not enough — at the moment a refusal is handled nothing has
// been written yet, so that header is still empty. That empty value silently
// cancelled every charge in the first 0.2.14 rollout.
func grokViolationFeeRequestIDFrom(c *gin.Context) string {
	if c == nil {
		return ""
	}
	if c.Request != nil {
		if id, _ := c.Request.Context().Value(ctxkey.RequestID).(string); strings.TrimSpace(id) != "" {
			return strings.TrimSpace(id)
		}
		if id, _ := c.Request.Context().Value(ctxkey.ClientRequestID).(string); strings.TrimSpace(id) != "" {
			return strings.TrimSpace(id)
		}
	}
	// Fallbacks: the writer header is populated once a response has been
	// started, and a client-supplied correlation id is a last resort.
	return firstNonEmpty(
		c.Writer.Header().Get("X-Request-Id"),
		c.Writer.Header().Get("x-request-id"),
		c.GetHeader("X-Request-Id"),
		c.GetHeader("X-Client-Request-ID"),
	)
}

// inboundPathFromGin reads the client-facing request path. The service layer
// cannot import the handler package, so the path comes straight from the request
// instead of the handler's endpoint helper.
func inboundPathFromGin(c *gin.Context) string {
	if c == nil || c.Request == nil || c.Request.URL == nil {
		return ""
	}
	return c.Request.URL.Path
}

func clientIPFromGin(c *gin.Context) string {
	if c == nil {
		return ""
	}
	return ip.GetClientIP(c)
}

func optionalTrimmedString(v string) *string {
	trimmed := strings.TrimSpace(v)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}
