package service

import (
	"fmt"
	"net/url"
	"strings"

	"github.com/Wei-Shaw/sub2api/internal/config"
)

const (
	ExternalCardPurchaseDisplayModeEmbed     = "embed"
	ExternalCardPurchaseDisplayModeNewWindow = "new_window"
	ExternalCardPurchaseDisplayModeBoth      = "both"
)

func NormalizeExternalCardPurchaseDisplayMode(raw string) string {
	switch strings.TrimSpace(raw) {
	case ExternalCardPurchaseDisplayModeEmbed,
		ExternalCardPurchaseDisplayModeNewWindow,
		ExternalCardPurchaseDisplayModeBoth:
		return strings.TrimSpace(raw)
	default:
		return ExternalCardPurchaseDisplayModeBoth
	}
}

// ValidateExternalCardPurchaseURL accepts only an absolute HTTPS URL without
// embedded credentials or a fragment. The URL is used as an iframe and link
// target, so it must not be able to smuggle browser credentials or a fragment.
func ValidateExternalCardPurchaseURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if err := config.ValidateAbsoluteHTTPURL(raw); err != nil {
		return err
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Fragment != "" {
		return fmt.Errorf("external card purchase URL must be an absolute HTTPS URL without credentials or fragment")
	}
	return nil
}

func externalCardPurchaseURL(raw string) string {
	if value := strings.TrimSpace(raw); value != "" {
		return value
	}
	return ExternalCardPurchaseDefaultURL
}

func externalCardPurchaseName(raw string) string {
	if value := strings.TrimSpace(raw); value != "" {
		return value
	}
	return ExternalCardPurchaseDefaultName
}

func externalCardPurchaseDescription(raw string) string {
	if value := strings.TrimSpace(raw); value != "" {
		return value
	}
	return ExternalCardPurchaseDefaultDescription
}
