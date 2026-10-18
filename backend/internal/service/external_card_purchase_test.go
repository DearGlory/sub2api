//go:build unit

package service

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/stretchr/testify/require"
)

func TestSettingService_ExternalCardPurchaseSettingsRoundTrip(t *testing.T) {
	settings := &SystemSettings{
		ExternalCardPurchaseEnabled:     true,
		ExternalCardPurchaseURL:         "https://catfk.com/shop/GloryCode",
		ExternalCardPurchaseName:        "余额码商城",
		ExternalCardPurchaseDescription: "购买余额码后回本站兑换。",
		ExternalCardPurchaseDisplayMode: ExternalCardPurchaseDisplayModeNewWindow,
	}

	repo := &settingUpdateRepoStub{}
	service := NewSettingService(repo, &config.Config{})
	require.NoError(t, service.UpdateSettings(context.Background(), settings))
	require.Equal(t, "true", repo.updates["external_card_purchase_enabled"])
	require.Equal(t, "https://catfk.com/shop/GloryCode", repo.updates["external_card_purchase_url"])
	require.Equal(t, "余额码商城", repo.updates["external_card_purchase_name"])
	require.Equal(t, "购买余额码后回本站兑换。", repo.updates["external_card_purchase_description"])
	require.Equal(t, "new_window", repo.updates["external_card_purchase_display_mode"])
}

func TestSettingService_GetFrameSrcOrigins_ExternalCardPurchaseIsOptIn(t *testing.T) {
	const externalURL = "https://catfk.com/shop/GloryCode"

	enabledService := NewSettingService(&settingPublicRepoStub{values: map[string]string{
		"external_card_purchase_enabled": "true",
		"external_card_purchase_url":     externalURL,
	}}, &config.Config{})
	origins, err := enabledService.GetFrameSrcOrigins(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"https://catfk.com"}, origins)

	disabledService := NewSettingService(&settingPublicRepoStub{values: map[string]string{
		"external_card_purchase_enabled": "false",
		"external_card_purchase_url":     externalURL,
	}}, &config.Config{})
	origins, err = disabledService.GetFrameSrcOrigins(context.Background())
	require.NoError(t, err)
	require.Empty(t, origins)
}

func TestSettingService_GetPublicSettings_ExposesExternalCardPurchaseFields(t *testing.T) {
	settings, err := NewSettingService(&settingPublicRepoStub{values: map[string]string{
		SettingKeyExternalCardPurchaseEnabled:     "true",
		SettingKeyExternalCardPurchaseURL:         "https://shop.example.test/cards",
		SettingKeyExternalCardPurchaseName:        "Cards",
		SettingKeyExternalCardPurchaseDescription: "Buy and redeem here.",
		SettingKeyExternalCardPurchaseDisplayMode: ExternalCardPurchaseDisplayModeNewWindow,
	}}, &config.Config{}).GetPublicSettings(context.Background())
	require.NoError(t, err)
	require.True(t, settings.ExternalCardPurchaseEnabled)
	require.Equal(t, "https://shop.example.test/cards", settings.ExternalCardPurchaseURL)
	require.Equal(t, "Cards", settings.ExternalCardPurchaseName)
	require.Equal(t, "Buy and redeem here.", settings.ExternalCardPurchaseDescription)
	require.Equal(t, ExternalCardPurchaseDisplayModeNewWindow, settings.ExternalCardPurchaseDisplayMode)
}

func TestSettingService_GetFrameSrcOrigins_RejectsUnsafeExternalCardPurchaseURL(t *testing.T) {
	origins, err := NewSettingService(&settingPublicRepoStub{values: map[string]string{
		SettingKeyExternalCardPurchaseEnabled: "true",
		SettingKeyExternalCardPurchaseURL:     "http://shop.example.test/cards",
	}}, &config.Config{}).GetFrameSrcOrigins(context.Background())
	require.NoError(t, err)
	require.Empty(t, origins)
}

func TestExternalCardPurchaseDisplayModeNormalizesToSupportedValues(t *testing.T) {
	require.Equal(t, ExternalCardPurchaseDisplayModeEmbed, NormalizeExternalCardPurchaseDisplayMode("embed"))
	require.Equal(t, ExternalCardPurchaseDisplayModeNewWindow, NormalizeExternalCardPurchaseDisplayMode("new_window"))
	require.Equal(t, ExternalCardPurchaseDisplayModeBoth, NormalizeExternalCardPurchaseDisplayMode("both"))
	require.Equal(t, ExternalCardPurchaseDisplayModeBoth, NormalizeExternalCardPurchaseDisplayMode("unknown"))
}

func TestValidateExternalCardPurchaseURL_RequiresSafeHTTPSTarget(t *testing.T) {
	for _, raw := range []string{
		"",
		"http://catfk.com/shop/GloryCode",
		"https://user:password@catfk.com/shop/GloryCode",
		"https://catfk.com/shop/GloryCode#token",
		"javascript:alert(1)",
	} {
		require.Error(t, ValidateExternalCardPurchaseURL(raw), "url=%q", raw)
	}
	require.NoError(t, ValidateExternalCardPurchaseURL("https://catfk.com/shop/GloryCode"))
}
