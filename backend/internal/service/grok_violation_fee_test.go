//go:build unit

package service

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

// ===========================================================================
// Grok violation-fee settings: defaults / read-back / clamping / validation
//
// xAI charges an extra usage-guidelines violation fee when a request is
// blocked by its safety check. The caller-facing ledger must be configurable
// so an operator can tune or disable it without rebuilding.
// ===========================================================================

func newViolationFeeSettingService() (*SettingService, *mockSettingRepo) {
	repo := newMockSettingRepo()
	return NewSettingService(repo, &config.Config{}), repo
}

func TestGetGrokViolationFeeSettings_DefaultsWhenNotSet(t *testing.T) {
	svc, _ := newViolationFeeSettingService()

	settings, err := svc.GetGrokViolationFeeSettings(context.Background())
	require.NoError(t, err)
	require.NotNil(t, settings)
	// Production currently charges 0.5 per detected violation on the Grok
	// channel; the code default must match that live behaviour.
	require.True(t, settings.Enabled)
	require.Equal(t, 0.5, settings.Amount)
}

func TestGetGrokViolationFeeSettings_ReadsFromDB(t *testing.T) {
	svc, repo := newViolationFeeSettingService()
	repo.data[SettingKeyGrokViolationFeeSettings] = `{"enabled":false,"amount":2.25}`

	settings, err := svc.GetGrokViolationFeeSettings(context.Background())
	require.NoError(t, err)
	require.False(t, settings.Enabled)
	require.Equal(t, 2.25, settings.Amount)
}

func TestGetGrokViolationFeeSettings_ClampsOutOfRange(t *testing.T) {
	svc, repo := newViolationFeeSettingService()

	t.Run("negative amount clamps to zero", func(t *testing.T) {
		repo.data[SettingKeyGrokViolationFeeSettings] = `{"enabled":true,"amount":-3}`
		settings, err := svc.GetGrokViolationFeeSettings(context.Background())
		require.NoError(t, err)
		require.Equal(t, 0.0, settings.Amount)
	})

	t.Run("absurd amount clamps to max", func(t *testing.T) {
		repo.data[SettingKeyGrokViolationFeeSettings] = `{"enabled":true,"amount":999999}`
		settings, err := svc.GetGrokViolationFeeSettings(context.Background())
		require.NoError(t, err)
		require.Equal(t, grokViolationFeeMaxAmount, settings.Amount)
	})
}

func TestGetGrokViolationFeeSettings_MalformedFallsBackToDefaults(t *testing.T) {
	svc, repo := newViolationFeeSettingService()
	repo.data[SettingKeyGrokViolationFeeSettings] = "not-json"

	settings, err := svc.GetGrokViolationFeeSettings(context.Background())
	require.NoError(t, err)
	require.Equal(t, DefaultGrokViolationFeeSettings(), settings)
}

func TestSetGrokViolationFeeSettings_RejectsOutOfRangeWhenEnabled(t *testing.T) {
	svc, _ := newViolationFeeSettingService()
	ctx := context.Background()

	err := svc.SetGrokViolationFeeSettings(ctx, &GrokViolationFeeSettings{Enabled: true, Amount: 999999})
	require.Error(t, err)
	require.Contains(t, err.Error(), "amount")

	err = svc.SetGrokViolationFeeSettings(ctx, &GrokViolationFeeSettings{Enabled: true, Amount: -1})
	require.Error(t, err)
}

func TestSetGrokViolationFeeSettings_NormalizesWhenDisabled(t *testing.T) {
	svc, _ := newViolationFeeSettingService()
	ctx := context.Background()

	require.NoError(t, svc.SetGrokViolationFeeSettings(ctx, &GrokViolationFeeSettings{Enabled: false, Amount: -5}))

	got, err := svc.GetGrokViolationFeeSettings(ctx)
	require.NoError(t, err)
	require.False(t, got.Enabled)
	require.Equal(t, DefaultGrokViolationFeeSettings().Amount, got.Amount)
}

func TestSetGrokViolationFeeSettings_RoundTrips(t *testing.T) {
	svc, _ := newViolationFeeSettingService()
	ctx := context.Background()

	require.NoError(t, svc.SetGrokViolationFeeSettings(ctx, &GrokViolationFeeSettings{Enabled: true, Amount: 0.75}))

	raw, err := svc.settingRepo.GetValue(ctx, SettingKeyGrokViolationFeeSettings)
	require.NoError(t, err)
	var decoded GrokViolationFeeSettings
	require.NoError(t, json.Unmarshal([]byte(raw), &decoded))
	require.True(t, decoded.Enabled)
	require.Equal(t, 0.75, decoded.Amount)
}

// ===========================================================================
// Grok 403 cooldown settings: defaults / read-back / clamping / validation
//
// issue #7398: an unrecognised 403 cools the account for a hard-coded 30
// minutes, and one request can cool up to max_account_switches accounts.
// The duration must be operator-configurable, with an explicit off switch.
// ===========================================================================

func TestGetGrok403CooldownSettings_DefaultsMatchLegacyBehaviour(t *testing.T) {
	svc, _ := newViolationFeeSettingService()

	settings, err := svc.GetGrok403CooldownSettings(context.Background())
	require.NoError(t, err)
	require.NotNil(t, settings)
	// Legacy hard-coded value was 30 minutes; default must not silently change it.
	require.True(t, settings.Enabled)
	require.Equal(t, 30, settings.CooldownMinutes)
}

func TestGetGrok403CooldownSettings_ReadsFromDB(t *testing.T) {
	svc, repo := newViolationFeeSettingService()
	repo.data[SettingKeyGrok403CooldownSettings] = `{"enabled":true,"cooldown_minutes":5}`

	settings, err := svc.GetGrok403CooldownSettings(context.Background())
	require.NoError(t, err)
	require.Equal(t, 5, settings.CooldownMinutes)
}

func TestGetGrok403CooldownSettings_ClampsOutOfRange(t *testing.T) {
	svc, repo := newViolationFeeSettingService()

	repo.data[SettingKeyGrok403CooldownSettings] = `{"enabled":true,"cooldown_minutes":0}`
	settings, err := svc.GetGrok403CooldownSettings(context.Background())
	require.NoError(t, err)
	require.Equal(t, 1, settings.CooldownMinutes)

	repo.data[SettingKeyGrok403CooldownSettings] = `{"enabled":true,"cooldown_minutes":99999}`
	settings, err = svc.GetGrok403CooldownSettings(context.Background())
	require.NoError(t, err)
	require.Equal(t, grok403CooldownMaxMinutes, settings.CooldownMinutes)
}

func TestSetGrok403CooldownSettings_RejectsOutOfRangeWhenEnabled(t *testing.T) {
	svc, _ := newViolationFeeSettingService()

	err := svc.SetGrok403CooldownSettings(context.Background(), &Grok403CooldownSettings{Enabled: true, CooldownMinutes: 0})
	require.Error(t, err)
	require.Contains(t, err.Error(), "cooldown_minutes")
}

func TestResolveGrok403Cooldown_DisabledMeansNoAccountPenalty(t *testing.T) {
	svc, _ := newViolationFeeSettingService()

	// Off switch: an operator must be able to answer #7398 by never penalising
	// the account for an unrecognised 403.
	require.NoError(t, svc.SetGrok403CooldownSettings(context.Background(), &Grok403CooldownSettings{Enabled: false, CooldownMinutes: 0}))

	svcWithSettings := &OpenAIGatewayService{settingService: svc}
	cooldown, apply := svcWithSettings.resolveGrok403Cooldown(context.Background())
	require.False(t, apply, "disabled cooldown must not penalise the account")
	require.Zero(t, cooldown)
}

func TestResolveGrok403Cooldown_UsesConfiguredMinutes(t *testing.T) {
	svc, _ := newViolationFeeSettingService()
	require.NoError(t, svc.SetGrok403CooldownSettings(context.Background(), &Grok403CooldownSettings{Enabled: true, CooldownMinutes: 7}))

	svcWithSettings := &OpenAIGatewayService{settingService: svc}
	cooldown, apply := svcWithSettings.resolveGrok403Cooldown(context.Background())
	require.True(t, apply)
	require.Equal(t, 7, int(cooldown.Minutes()))
}

func TestResolveGrok403Cooldown_FallsBackToDefaultWithoutSettingService(t *testing.T) {
	svc := &OpenAIGatewayService{}
	cooldown, apply := svc.resolveGrok403Cooldown(context.Background())
	require.True(t, apply)
	require.Equal(t, 30, int(cooldown.Minutes()))
}

// ===========================================================================
// Violation detection: only a real safety-check rejection is billable
// ===========================================================================

func TestGrokViolationFeeDetection_RequiresSafetyMarker(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		want       bool
	}{
		{
			name:       "marker present",
			statusCode: http.StatusForbidden,
			body:       `{"error":{"message":"I'm sorry, I can't help with that request. Failed check: SAFETY_CHECK_TYPE","type":"invalid_request_error"}}`,
			want:       true,
		},
		{
			name:       "plain refusal without marker is not billable",
			statusCode: http.StatusForbidden,
			body:       `{"error":{"message":"I'm sorry, I can't help with that request.","type":"invalid_request_error"}}`,
			want:       false,
		},
		{
			name:       "marker wrapped inside a 503 auth_unavailable body",
			statusCode: http.StatusServiceUnavailable,
			body:       `{"error":{"message":"auth_unavailable: no auth available (providers=xai, model=grok-4.7-build-fast; last upstream error: I'm sorry, I can't help with that request. Failed check: SAFETY_CHECK_TYPE)"}}`,
			want:       true,
		},
		{
			name:       "entitlement 403 is not a violation",
			statusCode: http.StatusForbidden,
			body:       `{"error":{"message":"grok access or entitlement denied","type":"permission-denied"}}`,
			want:       false,
		},
		{
			name:       "empty body",
			statusCode: http.StatusForbidden,
			body:       "",
			want:       false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			require.Equal(t, tt.want, isGrokViolationFeeRejection(tt.statusCode, []byte(tt.body)))
		})
	}
}
