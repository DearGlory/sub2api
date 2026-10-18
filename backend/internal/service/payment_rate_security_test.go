//go:build unit

package service

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestEpusdtRateRejectsRedirectAndDoesNotReachTarget(t *testing.T) {
	var hits atomic.Int32
	target := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		fmt.Fprintf(w, `{"cny":{"usdt":0.14925373134328357},"source":"binance-p2p","trade_type":"BUY","cny_per_usdt":6.7,"fetched_at":%q,"expires_at":%q}`, time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), time.Now().Add(time.Minute).UTC().Format(time.RFC3339Nano))
	}))
	defer target.Close()
	redirect := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer redirect.Close()
	svc := &PaymentConfigService{rateHTTPClient: redirect.Client()}
	_, err := svc.fetchEpusdtRate(context.Background(), map[string]string{"currency": "CNY", "apiBase": redirect.URL})
	require.Error(t, err)
	require.Zero(t, hits.Load())
}

func TestEpusdtRateRejectsWrongSourceAndReciprocal(t *testing.T) {
	now := time.Date(2026, 10, 18, 10, 0, 30, 0, time.UTC)
	valid := `{"cny":{"usdt":0.14925373134328357},"source":"binance-p2p","trade_type":"BUY","cny_per_usdt":6.7,"fetched_at":"2026-10-18T10:00:00Z","expires_at":"2026-10-18T10:01:00Z"}`
	for _, body := range []string{
		strings.Replace(valid, "binance-p2p", "unknown", 1),
		strings.Replace(valid, "6.7", "67", 1),
		strings.Replace(valid, "10:01:00Z", "11:00:00Z", 1),
	} {
		_, err := parseEpusdtRateDocument([]byte(body), now)
		require.Error(t, err)
	}
}
