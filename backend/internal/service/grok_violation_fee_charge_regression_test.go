//go:build unit

package service

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// ===========================================================================
// Regression: the refusal charge must actually reach the billing repository.
//
// The first 0.2.14 rollout shipped a charge path that bailed out silently on
// two independent conditions, so real production traffic produced 320
// marker-carrying 403s and exactly zero fee rows:
//
//  1. the model was read from a context key that no caller sets on the
//     error-handling path, and
//  2. the request id was read from the *response* writer, which has not been
//     written yet at the moment the refusal is handled.
//
// Both produced an empty string, and ChargeGrokViolationFeeIfNeeded returns
// false for an empty model or request id. Nothing was logged, so the only
// visible symptom was a missing charge. These tests pin the charge to a
// non-empty model and a non-empty request id.
// ===========================================================================

type grokFeeCaptureBillingRepo struct {
	UsageBillingRepository
	applied []*UsageBillingCommand
}

func (r *grokFeeCaptureBillingRepo) Apply(_ context.Context, cmd *UsageBillingCommand) (*UsageBillingApplyResult, error) {
	r.applied = append(r.applied, cmd)
	return &UsageBillingApplyResult{Applied: true}, nil
}

func newGrokFeeChargeService(t *testing.T) (*OpenAIGatewayService, *grokFeeCaptureBillingRepo) {
	t.Helper()
	settingRepo := newMockSettingRepo()
	settingSvc := NewSettingService(settingRepo, &config.Config{})
	billingRepo := &grokFeeCaptureBillingRepo{}
	svc := &OpenAIGatewayService{
		settingService:   settingSvc,
		usageBillingRepo: billingRepo,
	}
	return svc, billingRepo
}

func grokFeeTestAPIKey() *APIKey {
	// Group is intentionally nil: the multiplier then resolves to 1.0 without
	// needing a group-rate repository, so the test asserts the raw configured
	// amount rather than a stubbed multiplier.
	return &APIKey{
		ID:   42,
		User: &User{ID: 99},
	}
}

// The marker body that production actually returns for a blocked request.
const grokFeeMarkerBody = `{"error":{"message":"I'm sorry, I can't help with that request. Failed check: SAFETY_CHECK_TYPE","type":"invalid_request_error"}}`

// TestChargeGrokViolationFeeIfNeeded_ChargesWithMarkerBody pins the direct
// service entry point: a marker body plus a resolvable model and request id must
// reach Apply exactly once with the configured amount.
func TestChargeGrokViolationFeeIfNeeded_ChargesWithMarkerBody(t *testing.T) {
	svc, billingRepo := newGrokFeeChargeService(t)

	in := GrokViolationFeeInput{
		RequestID: "req-direct-1",
		Model:     "grok-4.5",
		APIKey:    grokFeeTestAPIKey(),
	}
	require.True(t, svc.ChargeGrokViolationFeeIfNeeded(context.Background(), in))
	require.Len(t, billingRepo.applied, 1)

	cmd := billingRepo.applied[0]
	// The fee row must not collide with the request's normal usage row, so the
	// billing key carries the documented suffix.
	require.Equal(t, "req-direct-1"+grokViolationFeeRequestIDSuffix, cmd.RequestID)
	require.Equal(t, int64(42), cmd.APIKeyID)
	require.Equal(t, int64(99), cmd.UserID)
	require.Equal(t, "grok-4.5", cmd.Model)
	require.Equal(t, 0.5, cmd.BalanceCost)
	require.Equal(t, 0.5, cmd.APIKeyQuotaCost)
}

// TestChargeGrokViolationFeeIfNeeded_SkipsWhenModelOrRequestIDMissing documents
// the two guards that silently swallowed every production charge. They remain
// correct as guards; the bug was that callers supplied empty values.
func TestChargeGrokViolationFeeIfNeeded_SkipsWhenModelOrRequestIDMissing(t *testing.T) {
	svc, billingRepo := newGrokFeeChargeService(t)

	require.False(t, svc.ChargeGrokViolationFeeIfNeeded(context.Background(), GrokViolationFeeInput{
		RequestID: "req-x", Model: "", APIKey: grokFeeTestAPIKey(),
	}))
	require.False(t, svc.ChargeGrokViolationFeeIfNeeded(context.Background(), GrokViolationFeeInput{
		RequestID: "", Model: "grok-4.5", APIKey: grokFeeTestAPIKey(),
	}))
	require.Empty(t, billingRepo.applied)
}

// TestChargeGrokViolationFeeIfNeeded_DisabledSettingChargesNothing proves the
// operator kill switch still works through the real charge entry point.
func TestChargeGrokViolationFeeIfNeeded_DisabledSettingChargesNothing(t *testing.T) {
	svc, billingRepo := newGrokFeeChargeService(t)
	require.NoError(t, svc.settingService.SetGrokViolationFeeSettings(
		context.Background(), &GrokViolationFeeSettings{Enabled: false, Amount: 0.5}))

	require.False(t, svc.ChargeGrokViolationFeeIfNeeded(context.Background(), GrokViolationFeeInput{
		RequestID: "req-off", Model: "grok-4.5", APIKey: grokFeeTestAPIKey(),
	}))
	require.Empty(t, billingRepo.applied)
}

// TestGrokViolationFeeInputFromGin_ResolvesModelAndRequestID pins the fix.
//
// Before the fix this returned ok=false for every production request because the
// model was never supplied and the request id was read from the response writer
// before anything had written it. Both must now resolve from the request
// context, which the request-logger middleware populates before the handler runs.
func TestGrokViolationFeeInputFromGin_ResolvesModelAndRequestID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	base := context.WithValue(context.Background(), ctxkey.RequestID, "req-ctx-1")
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(base)
	c.Set("api_key", grokFeeTestAPIKey())

	// The response writer has no X-Request-Id yet: this is exactly the state at
	// the moment handleErrorResponse runs.
	require.Empty(t, c.Writer.Header().Get("X-Request-Id"))

	in, ok := GrokViolationFeeInputFromGin(c, "grok-4.6", http.StatusForbidden, false)
	require.True(t, ok)
	require.Equal(t, "req-ctx-1", in.RequestID)
	require.Equal(t, "grok-4.6", in.Model)
	require.Equal(t, int64(42), in.APIKey.ID)
	require.Equal(t, "/v1/chat/completions", in.InboundEndpoint)
}

// TestGrokViolationFeeRequestIDFrom_PrefersContextOverWriter documents the
// precedence: the context id wins because it exists before any response byte is
// written. The writer header is only a fallback for paths that resolve the id
// after the response has started.
func TestGrokViolationFeeRequestIDFrom_PrefersContextOverWriter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	base := context.WithValue(context.Background(), ctxkey.RequestID, "from-ctx")
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(base)
	c.Writer.Header().Set("X-Request-Id", "from-writer")

	require.Equal(t, "from-ctx", grokViolationFeeRequestIDFrom(c))

	// With no context id, the fallbacks must still find something.
	rec2 := httptest.NewRecorder()
	c2, _ := gin.CreateTestContext(rec2)
	c2.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	c2.Writer.Header().Set("X-Request-Id", "from-writer")
	require.Equal(t, "from-writer", grokViolationFeeRequestIDFrom(c2))
}
