//go:build unit

package service

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// ===========================================================================
// End-to-end regression for the refusal charge, through the two error handlers
// that production traffic actually reaches with a marker-carrying 403.
//
// These drive handleErrorResponse and handleCompatErrorResponse exactly as the
// gateway does — real gin context, request id in the request context, billing
// repository attached — and assert the fee reaches Apply. The previous release
// passed review because nothing exercised this route: the unit tests covered the
// charge function in isolation with hand-supplied model and request id, which is
// precisely the input production never delivered.
// ===========================================================================

// grokFeeMarkerUpstreamBody is the upstream 403 body shape that must be charged.
// The marker phrase is what separates a billable safety violation from a plain
// refusal.
const grokFeeMarkerUpstreamBody = `{"error":{"code":"content_filter","message":"I'm sorry, I can't help with that request. Failed check: SAFETY_CHECK_TYPE"}}`

func newGrokFeeErrorContext(t *testing.T) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	base := context.WithValue(context.Background(), ctxkey.RequestID, "req-e2e-marker")
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil).WithContext(base)
	c.Set("api_key", grokFeeTestAPIKey())
	return c, recorder
}

func newGrokFeeUpstreamResponse(body string) *http.Response {
	return &http.Response{
		StatusCode: http.StatusForbidden,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

// TestGrokMarker403ThroughHandleErrorResponseChargesFee covers the raw path.
func TestGrokMarker403ThroughHandleErrorResponseChargesFee(t *testing.T) {
	settingRepo := newMockSettingRepo()
	svc := &OpenAIGatewayService{}
	svc.settingService = NewSettingService(settingRepo, nil)
	billingRepo := &grokFeeCaptureBillingRepo{}
	svc.usageBillingRepo = billingRepo

	c, recorder := newGrokFeeErrorContext(t)
	account := &Account{ID: 9001, Platform: PlatformGrok, Type: AccountTypeOAuth}

	_, err := svc.handleErrorResponse(
		c.Request.Context(),
		newGrokFeeUpstreamResponse(grokFeeMarkerUpstreamBody),
		c,
		account,
		nil,
		"grok-4.7",
	)
	require.Error(t, err)
	require.Equal(t, http.StatusForbidden, recorder.Code)

	require.Len(t, billingRepo.applied, 1, "marker 403 must produce exactly one fee row")
	cmd := billingRepo.applied[0]
	require.Equal(t, "req-e2e-marker"+grokViolationFeeRequestIDSuffix, cmd.RequestID)
	require.Equal(t, "grok-4.7", cmd.Model)
	require.Equal(t, int64(42), cmd.APIKeyID)
	require.Equal(t, int64(9001), cmd.AccountID)
	require.Equal(t, 0.5, cmd.BalanceCost)
}

// TestGrokMarker403ThroughCompatErrorResponseChargesFee covers the compat path,
// which is the branch that wraps the request context with c.Request.Context().
func TestGrokMarker403ThroughCompatErrorResponseChargesFee(t *testing.T) {
	settingRepo := newMockSettingRepo()
	svc := &OpenAIGatewayService{}
	svc.settingService = NewSettingService(settingRepo, nil)
	billingRepo := &grokFeeCaptureBillingRepo{}
	svc.usageBillingRepo = billingRepo

	c, recorder := newGrokFeeErrorContext(t)
	account := &Account{ID: 9002, Platform: PlatformGrok, Type: AccountTypeOAuth}

	_, err := svc.handleCompatErrorResponse(
		newGrokFeeUpstreamResponse(grokFeeMarkerUpstreamBody),
		c,
		account,
		writeChatCompletionsError,
		"grok-4.7-build-fast",
	)
	require.Error(t, err)
	require.Equal(t, http.StatusForbidden, recorder.Code)

	require.Len(t, billingRepo.applied, 1, "marker 403 on the compat path must be charged too")
	cmd := billingRepo.applied[0]
	require.Equal(t, "grok-4.7-build-fast", cmd.Model)
	require.Equal(t, int64(9002), cmd.AccountID)
}

// TestGrokPlainRefusal403IsNotCharged guards the other direction: the apology
// sentence without the safety marker is a free refusal, and charging it would
// bill customers for ordinary model behaviour.
func TestGrokPlainRefusal403IsNotCharged(t *testing.T) {
	settingRepo := newMockSettingRepo()
	svc := &OpenAIGatewayService{}
	svc.settingService = NewSettingService(settingRepo, nil)
	billingRepo := &grokFeeCaptureBillingRepo{}
	svc.usageBillingRepo = billingRepo

	c, _ := newGrokFeeErrorContext(t)
	account := &Account{ID: 9003, Platform: PlatformGrok, Type: AccountTypeOAuth}
	plainBody := `{"error":{"message":"I'm sorry, I can't help with that request."}}`

	_, err := svc.handleErrorResponse(
		c.Request.Context(),
		newGrokFeeUpstreamResponse(plainBody),
		c,
		account,
		nil,
		"grok-4.7",
	)
	require.Error(t, err)
	require.Empty(t, billingRepo.applied, "a plain refusal must never be charged")
}
