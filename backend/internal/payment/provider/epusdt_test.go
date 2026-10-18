//go:build unit

package provider

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/stretchr/testify/require"
)

const epusdtTestSecret = "test-epusdt-secret"

func newTestEPUSDT(t *testing.T, server *httptest.Server) *EPUSDT {
	t.Helper()
	prov, err := NewEPUSDT("test", map[string]string{
		"pid":       "1000",
		"secretKey": epusdtTestSecret,
		"apiBase":   "https://ep.example.test",
		"notifyUrl": "https://shop.example.test/api/v1/payments/callback",
		"returnUrl": "https://shop.example.test",
		"token":     "USDT",
		"network":   "bsc",
		"networks":  "bsc,trc20",
		"currency":  "USD",
	})
	require.NoError(t, err)
	prov.config["apiBase"] = server.URL
	prov.httpClient = server.Client()
	return prov
}

func TestNewEPUSDTValidatesHTTPSConfigAndExposesType(t *testing.T) {
	_, err := NewEPUSDT("test", map[string]string{
		"pid": "1000", "secretKey": epusdtTestSecret,
		"apiBase": "http://ep.example.test", "notifyUrl": "https://shop.example.test/callback",
		"returnUrl": "https://shop.example.test", "token": "USDT", "network": "bsc", "currency": "USD",
	})
	require.ErrorContains(t, err, "HTTPS")

	provider, err := NewEPUSDT("test", map[string]string{
		"pid": "1000", "secretKey": epusdtTestSecret,
		"apiBase": "https://ep.example.test", "notifyUrl": "https://shop.example.test/callback",
		"returnUrl": "https://shop.example.test", "token": "USDT", "network": "bsc", "currency": "USD",
	})
	require.NoError(t, err)
	require.Equal(t, payment.TypeEpusdt, provider.ProviderKey())
	require.Equal(t, []payment.PaymentType{payment.TypeEpusdt}, provider.SupportedTypes())
	require.Equal(t, "USD", provider.MerchantIdentityMetadata()["currency"])
}

func TestNewEPUSDTRejectsNonUSDTAssetOrCurrency(t *testing.T) {
	base := map[string]string{
		"pid":       "1000",
		"secretKey": epusdtTestSecret,
		"apiBase":   "https://ep.example.test",
		"notifyUrl": "https://shop.example.test/callback",
		"returnUrl": "https://shop.example.test",
		"token":     "USDT",
		"network":   "bsc",
		"currency":  "USD",
	}

	invalidToken := cloneStringMap(base)
	invalidToken["token"] = "USDC"
	_, err := NewEPUSDT("test", invalidToken)
	require.ErrorContains(t, err, "USDT")

	invalidCurrency := cloneStringMap(base)
	invalidCurrency["currency"] = "EUR"
	_, err = NewEPUSDT("test", invalidCurrency)
	require.ErrorContains(t, err, "USD or CNY")

	cnyConfig := cloneStringMap(base)
	cnyConfig["currency"] = "CNY"
	provider, err := NewEPUSDT("test", cnyConfig)
	require.NoError(t, err)
	require.Equal(t, "CNY", provider.MerchantIdentityMetadata()["currency"])
}

func TestEPUSDTCreatePaymentSignsRequestedNetworkAndReturnsRedirect(t *testing.T) {
	var received map[string]interface{}
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, epusdtCreatePath, r.URL.Path)
		require.Equal(t, "application/json", r.Header.Get("Content-Type"))
		body, err := io.ReadAll(r.Body)
		require.NoError(t, err)
		require.NoError(t, json.Unmarshal(body, &received))
		require.Equal(t, "1000", received["pid"])
		require.Equal(t, "order-123", received["order_id"])
		require.Equal(t, "USD", received["currency"])
		require.Equal(t, "USDT", received["token"])
		require.Equal(t, "trc20", received["network"])
		require.Equal(t, float64(12.34), received["amount"])
		require.Equal(t, expectedEPUSDTSignature(received, epusdtTestSecret), received["signature"])
		_, _ = w.Write([]byte(`{"status_code":200,"message":"success","data":{"trade_id":"trade-123","order_id":"order-123","amount":12.34,"payment_url":"/pay/trade-123"}}`))
	}))
	defer server.Close()

	prov := newTestEPUSDT(t, server)
	resp, err := prov.CreatePayment(context.Background(), payment.CreatePaymentRequest{
		OrderID: "order-123", Amount: "12.34", Subject: "充值", RequestedNetwork: "trc20",
		ReturnURL: "https://shop.example.test/payment/result?order_id=123&status=success",
	})
	require.NoError(t, err)
	require.Equal(t, "trade-123", resp.TradeNo)
	require.Equal(t, server.URL+"/pay/trade-123", resp.PayURL)
	require.Equal(t, "USD", resp.Currency)
	require.Equal(t, payment.CreatePaymentResultOrderCreated, resp.ResultType)
}

func TestEPUSDTCreatePaymentCNYReturnsActualUSDT(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status_code":200,"message":"success","data":{"trade_id":"trade-cny","order_id":"order-cny","amount":67,"currency":"CNY","actual_amount":10,"receive_address":"TTest","token":"USDT","status":1,"expiration_time":1713264600,"payment_url":"/pay/trade-cny"}}`))
	}))
	defer server.Close()

	prov := newTestEPUSDT(t, server)
	prov.config["currency"] = "CNY"
	resp, err := prov.CreatePayment(context.Background(), payment.CreatePaymentRequest{
		OrderID: "order-cny", Amount: "67", RequestedNetwork: "trc20",
	})
	require.NoError(t, err)
	require.Equal(t, "trade-cny", resp.TradeNo)
	require.Equal(t, "CNY", resp.Currency)
	require.Equal(t, 10.0, resp.GatewayExpectedUSDT)
}

func TestEPUSDTCreatePaymentCNYRejectsMissingActualUSDT(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status_code":200,"message":"success","data":{"trade_id":"trade-cny","order_id":"order-cny","amount":67,"currency":"CNY","token":"USDT","status":1,"payment_url":"/pay/trade-cny"}}`))
	}))
	defer server.Close()

	prov := newTestEPUSDT(t, server)
	prov.config["currency"] = "CNY"
	_, err := prov.CreatePayment(context.Background(), payment.CreatePaymentRequest{
		OrderID: "order-cny", Amount: "67", RequestedNetwork: "trc20",
	})
	require.ErrorContains(t, err, "actual USDT")
}

func TestEPUSDTCreatePaymentCNYRequiresMatchingOrderID(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status_code":200,"message":"success","data":{"trade_id":"trade-cny","order_id":"","amount":67,"currency":"CNY","actual_amount":10,"token":"USDT","status":1,"payment_url":"/pay/trade-cny"}}`))
	}))
	defer server.Close()

	prov := newTestEPUSDT(t, server)
	prov.config["currency"] = "CNY"
	_, err := prov.CreatePayment(context.Background(), payment.CreatePaymentRequest{
		OrderID: "order-cny", Amount: "67", RequestedNetwork: "trc20",
	})
	require.ErrorContains(t, err, "order id mismatch")
}

func TestEPUSDTVerifyNotificationRejectsNonUSDTToken(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	prov := newTestEPUSDT(t, server)

	payload := map[string]interface{}{
		"pid": "1000", "trade_id": "trade-123", "order_id": "order-123",
		"amount": 12.34, "actual_amount": 12.34, "token": "USDC", "status": 2,
		"block_transaction_id": "0xabc",
	}
	payload["signature"] = expectedEPUSDTSignature(payload, epusdtTestSecret)
	body, err := json.Marshal(payload)
	require.NoError(t, err)
	_, err = prov.VerifyNotification(context.Background(), string(body), nil)
	require.ErrorContains(t, err, "token must be USDT")
}

func TestEPUSDTRejectsUnsupportedRequestedNetwork(t *testing.T) {
	server := httptest.NewTLSServer(http.NotFoundHandler())
	defer server.Close()
	prov := newTestEPUSDT(t, server)
	_, err := prov.CreatePayment(context.Background(), payment.CreatePaymentRequest{
		OrderID: "order-123", Amount: "1", RequestedNetwork: "erc20",
	})
	require.ErrorContains(t, err, "network")
}

func TestEPUSDTQueryOrderDoesNotInventAmount(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, epusdtStatusPath+"trade-123", r.URL.Path)
		_, _ = w.Write([]byte(`{"status_code":200,"message":"success","data":{"trade_id":"trade-123","status":2,"amount":999.99}}`))
	}))
	defer server.Close()

	resp, err := newTestEPUSDT(t, server).QueryOrder(context.Background(), "trade-123")
	require.NoError(t, err)
	require.Equal(t, payment.ProviderStatusPaid, resp.Status)
	require.Zero(t, resp.Amount, "GMPay status response has no trusted payment amount")
}

func TestEPUSDTVerifyNotificationReturnsSignedSuccess(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	prov := newTestEPUSDT(t, server)

	payload := map[string]interface{}{
		"pid": "1000", "trade_id": "trade-123", "order_id": "order-123",
		"amount": 12.34, "actual_amount": 12.34, "token": "USDT", "status": 2,
		"block_transaction_id": "0xabc",
	}
	payload["signature"] = expectedEPUSDTSignature(payload, epusdtTestSecret)
	body, err := json.Marshal(payload)
	require.NoError(t, err)

	notification, err := prov.VerifyNotification(context.Background(), string(body), nil)
	require.NoError(t, err)
	require.Equal(t, payment.NotificationStatusSuccess, notification.Status)
	require.Equal(t, "gateway_signed", notification.Metadata["network_verification"])
	require.Equal(t, "bsc,trc20", notification.Metadata["configured_networks"])
	require.NotContains(t, notification.RawData, epusdtTestSecret)
	require.NotContains(t, notification.RawData, "0xabc")

	payload["pid"] = "9999"
	body, err = json.Marshal(payload)
	require.NoError(t, err)
	_, err = prov.VerifyNotification(context.Background(), string(body), nil)
	require.ErrorContains(t, err, "pid mismatch")

	payload["pid"] = "1000"
	payload["signature"] = strings.Repeat("0", sha256.Size*2)
	body, err = json.Marshal(payload)
	require.NoError(t, err)
	_, err = prov.VerifyNotification(context.Background(), string(body), nil)
	require.ErrorContains(t, err, "signature mismatch")
}

func TestEPUSDTRejectsUntrustedPaymentURLAndRefund(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"status_code":200,"message":"success","data":{"trade_id":"trade-123","order_id":"order-123","payment_url":"https://evil.example.test/pay"}}`))
	}))
	defer server.Close()
	prov := newTestEPUSDT(t, server)
	_, err := prov.CreatePayment(context.Background(), payment.CreatePaymentRequest{OrderID: "order-123", Amount: "1"})
	require.ErrorContains(t, err, "host mismatch")
	_, err = prov.Refund(context.Background(), payment.RefundRequest{TradeNo: "trade-123"})
	require.ErrorContains(t, err, "not supported")
}

func TestCreateProviderEPUSDT(t *testing.T) {
	provider, err := CreateProvider(payment.TypeEpusdt, "instance-1", map[string]string{
		"pid": "1000", "secretKey": epusdtTestSecret,
		"apiBase": "https://ep.example.test", "notifyUrl": "https://shop.example.test/callback",
		"returnUrl": "https://shop.example.test", "token": "USDT", "network": "bsc", "currency": "USD",
	})
	require.NoError(t, err)
	require.Equal(t, payment.TypeEpusdt, provider.ProviderKey())
}

func expectedEPUSDTSignature(values map[string]interface{}, secret string) string {
	parts := make([]string, 0, len(values))
	for key, value := range values {
		if key == "signature" || value == nil {
			continue
		}
		var formatted string
		switch v := value.(type) {
		case string:
			formatted = v
		case float64:
			formatted = strconv.FormatFloat(v, 'f', -1, 64)
		case int:
			formatted = strconv.Itoa(v)
		case bool:
			formatted = strconv.FormatBool(v)
		}
		if formatted != "" {
			parts = append(parts, key+"="+formatted)
		}
	}
	sort.Strings(parts)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.Join(parts, "&")))
	return hex.EncodeToString(mac.Sum(nil))
}
