//go:build unit

package provider

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/stretchr/testify/require"
)

func TestEPUSDTUnifiedCheckoutOmitsAssetAndNetwork(t *testing.T) {
	var received map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			http.Error(w, "bad request", 400)
			return
		}
		w.Write([]byte(`{"status_code":200,"data":{"trade_id":"checkout-trade","order_id":"checkout-order","amount":67,"currency":"CNY","actual_amount":0,"token":"","status":4,"payment_url":"/pay/checkout-counter/checkout-trade"}}`))
	}))
	defer server.Close()
	p := newTestEPUSDT(t, server)
	p.config["currency"] = "CNY"
	result, err := p.CreatePayment(context.Background(), payment.CreatePaymentRequest{OrderID: "checkout-order", Amount: "67"})
	require.NoError(t, err)
	require.NotContains(t, received, "token")
	require.NotContains(t, received, "network")
	require.Equal(t, "CNY", received["currency"])
	require.Equal(t, float64(67), received["amount"])
	require.Equal(t, expectedEPUSDTSignature(received, epusdtTestSecret), received["signature"])
	require.Zero(t, result.GatewayExpectedUSDT)
	require.Equal(t, server.URL+"/pay/checkout-counter/checkout-trade", result.PayURL)
}

func TestEPUSDTUnifiedConfigurationNeedsNoNetwork(t *testing.T) {
	_, err := NewEPUSDT("test", map[string]string{
		"pid": "1000", "secretKey": epusdtTestSecret,
		"apiBase": "https://gateway.example.test", "notifyUrl": "https://shop.example.test/notify",
		"returnUrl": "https://shop.example.test", "token": "USDT", "currency": "CNY",
	})
	require.NoError(t, err)
}

func TestEPUSDTUnifiedCheckoutRejectsMalformedPlaceholder(t *testing.T) {
	for _, body := range []string{
		`{"trade_id":"t","order_id":"checkout-order","amount":67,"currency":"CNY","actual_amount":10,"token":"USDT","status":4,"payment_url":"/pay/t"}`,
		`{"trade_id":"t","order_id":"checkout-order","amount":67,"currency":"CNY","actual_amount":0,"token":"","status":1,"payment_url":"/pay/t"}`,
		`{"trade_id":"t","order_id":"checkout-order","amount":67,"currency":"USD","actual_amount":0,"token":"","status":4,"payment_url":"/pay/t"}`,
		`{"trade_id":"t","order_id":"checkout-order","amount":6.7,"currency":"CNY","actual_amount":0,"token":"","status":4,"payment_url":"/pay/t"}`,
	} {
		server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Write([]byte(`{"status_code":200,"data":` + body + `}`))
		}))
		p := newTestEPUSDT(t, server)
		p.config["currency"] = "CNY"
		_, err := p.CreatePayment(context.Background(), payment.CreatePaymentRequest{OrderID: "checkout-order", Amount: "67"})
		server.Close()
		require.Error(t, err)
	}
}
