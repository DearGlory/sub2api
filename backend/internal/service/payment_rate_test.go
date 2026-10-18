//go:build unit

package service

import (
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/stretchr/testify/require"
)

func TestParseEpusdtCNYRateDocumentAcceptsFreshQuote(t *testing.T) {
	now := time.Date(2026, 10, 18, 10, 1, 0, 0, time.UTC)
	quote, err := parseEpusdtRateDocument([]byte(`{
		"cny":{"usdt":0.14925373134328357},
		"source":"binance-p2p",
		"trade_type":"BUY",
		"cny_per_usdt":6.7,
		"fetched_at":"2026-10-18T10:00:00Z",
		"expires_at":"2026-10-18T10:05:00Z"
	}`), now)
	require.NoError(t, err)
	require.Equal(t, "CNY", quote.Currency)
	require.Equal(t, "USDT", quote.Asset)
	require.InDelta(t, 0.14925373134328357, quote.USDTPerUnit, 1e-15)
	require.Equal(t, "binance-p2p", quote.Source)
	require.Equal(t, "BUY", quote.TradeType)
	require.Equal(t, "2026-10-18T10:00:00Z", quote.FetchedAt.UTC().Format(time.RFC3339))
	require.Equal(t, "2026-10-18T10:05:00Z", quote.ExpiresAt.UTC().Format(time.RFC3339))
}

func TestParseEpusdtCNYRateDocumentRejectsExpiredQuote(t *testing.T) {
	now := time.Date(2026, 10, 18, 10, 5, 0, 0, time.UTC)
	_, err := parseEpusdtRateDocument([]byte(`{
		"cny":{"usdt":0.14925373134328357},
		"source":"binance-p2p",
		"trade_type":"BUY",
		"cny_per_usdt":6.7,
		"fetched_at":"2026-10-18T10:00:00Z",
		"expires_at":"2026-10-18T10:05:00Z"
	}`), now)
	require.Error(t, err)
	require.ErrorContains(t, err, "expired")
}

func TestParseEpusdtCNYRateDocumentRejectsInvalidQuote(t *testing.T) {
	now := time.Date(2026, 10, 18, 10, 1, 0, 0, time.UTC)
	_, err := parseEpusdtRateDocument([]byte(`{
		"cny":{"usdt":0},
		"source":"binance-p2p",
		"trade_type":"BUY",
		"cny_per_usdt":6.7,
		"fetched_at":"2026-10-18T10:00:00Z",
		"expires_at":"2026-10-18T10:05:00Z"
	}`), now)
	require.Error(t, err)
	require.ErrorContains(t, err, "positive")
}

func TestParseEpusdtCNYRateDocumentRejectsDuplicateFields(t *testing.T) {
	now := time.Date(2026, 10, 18, 10, 1, 0, 0, time.UTC)
	_, err := parseEpusdtRateDocument([]byte(`{
		"cny":{"usdt":0.14925373134328357},
		"source":"binance-p2p",
		"source":"forged",
		"trade_type":"BUY",
		"cny_per_usdt":6.7,
		"fetched_at":"2026-10-18T10:00:00Z",
		"expires_at":"2026-10-18T10:05:00Z"
	}`), now)
	require.Error(t, err)
	require.ErrorContains(t, err, "duplicate")
}

func TestCalculateEpusdtCNYGatewayAmountUsesNativeCNY(t *testing.T) {
	quote := EpusdtRateQuote{Currency: "CNY", Asset: "USDT", USDTPerUnit: 1 / 6.7}
	require.InDelta(t, 10.0, 67*quote.USDTPerUnit, 1e-12)
}

func TestPaymentProviderConfigCurrencyKeepsEpusdtUSDCompatibility(t *testing.T) {
	require.Equal(t, "USD", paymentProviderConfigCurrency(payment.TypeEpusdt, map[string]string{}))
	require.Equal(t, "CNY", paymentProviderConfigCurrency(payment.TypeEpusdt, map[string]string{"currency": "CNY"}))
}

func TestBuildPaymentOrderProviderSnapshotPersistsCNYQuote(t *testing.T) {
	fetched := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	expires := fetched.Add(5 * time.Minute)
	snapshot := buildPaymentOrderProviderSnapshot(&payment.InstanceSelection{
		InstanceID:  "79",
		ProviderKey: payment.TypeEpusdt,
		Config: map[string]string{
			"currency": "CNY",
		},
	}, CreateOrderRequest{
		PaymentType:      payment.TypeEpusdt,
		QuoteSource:      "binance-p2p",
		QuoteUSDTPerUnit: 1 / 6.7,
		QuoteFetchedAt:   fetched,
		QuoteExpiresAt:   expires,
	})
	require.Equal(t, "CNY", snapshot["currency"])
	require.Equal(t, "binance-p2p", snapshot["quote_source"])
	require.InDelta(t, 1/6.7, snapshot["usdt_per_unit"], 1e-15)
	require.Equal(t, fetched.Format(time.RFC3339Nano), snapshot["fetched_at"])
	require.Equal(t, expires.Format(time.RFC3339Nano), snapshot["expires_at"])
}
