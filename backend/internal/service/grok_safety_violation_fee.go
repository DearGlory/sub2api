package service

import (
	"context"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/tidwall/gjson"
)

// grokSafetyViolationMarker is the suffix xAI appends when a request is blocked
// by its safety check and billed as a usage-guidelines violation. The plain
// apology "I'm sorry, I can't help with that request." is a request refusal but
// is NOT billed; only the marker makes the upstream account liable for the fee.
const grokSafetyViolationMarker = "Failed check: SAFETY_CHECK_TYPE"

// isGrokViolationFeeRejection reports whether an upstream body carries xAI's
// safety-check violation marker, which is what triggers the extra fee charged to
// the account holder.
//
// The marker can arrive in two shapes:
//   - directly on a 403 `invalid_request_error` (request-scoped refusal), and
//   - wrapped inside a 503 `auth_unavailable` body produced by an upstream
//     gateway when every candidate account refused the request.
//
// Both shapes are matched, scoped to the Grok paths that call this helper. The
// check is deliberately text-based rather than model-based: xAI does not encode
// the violation in a stable field, and new model ids (grok-4.6, grok-4.7,
// grok-4.7-build-fast) reuse the same marker. Gating on a hard-coded model list
// would silently stop billing whenever xAI ships a model.
func isGrokViolationFeeRejection(statusCode int, responseBody []byte) bool {
	if len(responseBody) == 0 {
		return false
	}
	switch statusCode {
	case http.StatusForbidden, http.StatusServiceUnavailable, http.StatusBadGateway:
	default:
		return false
	}
	return grokBodyHasSafetyViolationMarker(responseBody)
}

// grokBodyHasSafetyViolationMarker searches the structured string fields first and
// falls back to the raw body, because nested gateway wrappers may embed the
// upstream error as an escaped string.
func grokBodyHasSafetyViolationMarker(body []byte) bool {
	if strings.Contains(string(body), grokSafetyViolationMarker) {
		return true
	}
	for _, candidate := range grokStructuredErrorMessageCandidates(body) {
		if strings.Contains(candidate, grokSafetyViolationMarker) {
			return true
		}
	}
	// Last resort: an escaped body inside a JSON string value.
	if escaped := gjson.GetBytes(body, "error.message").String(); escaped != "" &&
		strings.Contains(escaped, grokSafetyViolationMarker) {
		return true
	}
	return false
}

// resolveGrok403Cooldown returns the account cooldown to apply for an
// unrecognised Grok 403 (issue #7398) and whether a penalty should be applied at
// all. A nil setting service keeps the legacy 30-minute behaviour so partially
// constructed services and unit fixtures do not silently lose the penalty; an
// operator can turn the penalty off entirely from the admin API.
func (s *OpenAIGatewayService) resolveGrok403Cooldown(ctx context.Context) (time.Duration, bool) {
	fallback := time.Duration(grok403CooldownDefaultMinutes) * time.Minute
	if s == nil || s.settingService == nil {
		return fallback, true
	}
	settings, err := s.settingService.GetGrok403CooldownSettings(ctx)
	if err != nil || settings == nil {
		return fallback, true
	}
	if !settings.Enabled {
		return 0, false
	}
	minutes := settings.CooldownMinutes
	if minutes < 1 {
		minutes = grok403CooldownDefaultMinutes
	}
	return time.Duration(minutes) * time.Minute, true
}

// grokViolationFeeAmount resolves the caller-facing fee for one detected
// violation. A nil or disabled setting yields zero, which disables billing.
func (s *OpenAIGatewayService) grokViolationFeeAmount(ctx context.Context) float64 {
	if s == nil || s.settingService == nil {
		return 0
	}
	settings, err := s.settingService.GetGrokViolationFeeSettings(ctx)
	if err != nil || settings == nil || !settings.Enabled {
		return 0
	}
	if settings.Amount <= 0 {
		return 0
	}
	return settings.Amount
}

// chargeGrokViolationFeeForRefusal bills the caller when a Grok refusal body
// carries xAI's safety-check violation marker.
//
// It is the single entry point used by every refusal branch (direct 403, compat
// 403 and the raw Chat path), so the marker rule and the billing key are defined
// in exactly one place. A request that merely refused without the marker is not
// billed: that refusal costs the account holder nothing.
func (s *OpenAIGatewayService) chargeGrokViolationFeeForRefusal(
	ctx context.Context,
	c *gin.Context,
	account *Account,
	statusCode int,
	responseBody []byte,
	requestedModel ...string,
) {
	if s == nil || c == nil {
		return
	}
	if !isGrokViolationFeeRejection(statusCode, responseBody) {
		return
	}
	// The model must come from the caller: the context key that carries it on the
	// scheduling paths is not set on every error path, and reading it there yields
	// an empty string that silently cancels the charge.
	model := ""
	if len(requestedModel) > 0 {
		model = strings.TrimSpace(requestedModel[0])
	}
	if model == "" {
		model = grokRequestedModelFromCtx(ctx)
	}
	in, ok := GrokViolationFeeInputFromGin(c, model, statusCode, false)
	if !ok {
		// Never fail silently again: an unresolvable caller identity or model is
		// the exact condition that hid 320 production violations.
		slog.Warn("grok_violation_fee_skipped",
			"reason", "unresolved_model_or_request_id",
			"model", model,
			"status_code", statusCode)
		return
	}
	in.Account = account
	in.UpstreamEndpoint = GetActualOpenAIUpstreamEndpoint(c)
	s.ChargeGrokViolationFeeIfNeeded(ctx, in)
}
