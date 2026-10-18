//go:build unit

package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/Wei-Shaw/sub2api/internal/payment/provider"
	"github.com/stretchr/testify/require"
)

func TestEpusdtCNYCreatedSnapshotToSignedCallbackCreditsOnce(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	user, err := client.User.Create().SetEmail("cny-acceptance@example.test").SetPasswordHash("test-only").Save(ctx)
	require.NoError(t, err)
	var received map[string]any
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rates/cny.json" {
			fmt.Fprintf(w, `{"cny":{"usdt":0.14925373134328357},"source":"binance-p2p","trade_type":"BUY","cny_per_usdt":6.7,"fetched_at":%q,"expires_at":%q}`, time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano), time.Now().Add(59*time.Second).UTC().Format(time.RFC3339Nano))
			return
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			http.Error(w, "bad test request", 400)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"status_code": 200, "message": "success", "data": map[string]any{
			"trade_id": "cny-integration-trade", "order_id": received["order_id"], "currency": "CNY", "token": "USDT", "amount": 67, "actual_amount": 10, "payment_url": "/pay/test",
		}})
	}))
	defer server.Close()
	previousTransport := http.DefaultTransport
	http.DefaultTransport = server.Client().Transport
	defer func() { http.DefaultTransport = previousTransport }()
	cfg := map[string]string{"pid": "1000", "secretKey": "local-test-only-key", "apiBase": server.URL, "notifyUrl": "https://shop.example.test/notify", "returnUrl": "https://shop.example.test/payment/result", "token": "USDT", "network": "tron", "networks": "tron,ethereum", "currency": "CNY"}
	cfgSvc := &PaymentConfigService{rateHTTPClient: server.Client()}
	quote, err := cfgSvc.fetchEpusdtRate(ctx, cfg)
	require.NoError(t, err)
	require.InDelta(t, 10.0, 67*quote.USDTPerUnit, 1e-12)
	sel := &payment.InstanceSelection{InstanceID: "cny-test", ProviderKey: payment.TypeEpusdt, Config: cfg}
	req := CreateOrderRequest{UserID: user.ID, Amount: 67, PaymentType: payment.TypeEpusdt, OrderType: payment.OrderTypeBalance, RequestedNetwork: "tron", EpusdtBalanceMultiplier: 1, EpusdtGraceMinutes: 5, QuoteSource: quote.Source, QuoteUSDTPerUnit: quote.USDTPerUnit, QuoteFetchedAt: quote.FetchedAt, QuoteExpiresAt: quote.ExpiresAt}
	credited := 0.0
	userRepo := &mockUserRepo{getByIDUser: &User{ID: user.ID}}
	userRepo.updateBalanceFn = func(_ context.Context, _ int64, amount float64) error { credited += amount; return nil }
	redeem := NewRedeemService(&paymentFulfillmentRedeemRepo{}, userRepo, nil, &paymentFulfillmentRedeemCacheStub{}, nil, client, nil, nil)
	svc := &PaymentService{entClient: client, redeemService: redeem, userRepo: userRepo}
	settings := &PaymentConfig{MaxPendingOrders: 3, OrderTimeoutMin: 30}
	order, err := svc.createOrderInTx(ctx, req, &User{ID: user.ID, Email: user.Email}, nil, settings, calculateCreditedBalance(67, 1), 67, 0, 67, 0, sel)
	require.NoError(t, err)
	_, err = svc.invokeProvider(ctx, order, req, settings, 67, "67.00", 67, nil, sel)
	require.NoError(t, err)
	require.Equal(t, "CNY", received["currency"])
	require.Equal(t, "tron", received["network"])
	require.Equal(t, float64(67), received["amount"])
	persisted := mustGetPaymentOrder(t, ctx, client, order.ID)
	require.Equal(t, "CNY", PaymentOrderCurrency(persisted))
	require.Equal(t, 67.0, persisted.Amount)
	require.Equal(t, 10.0, psOrderProviderSnapshot(persisted).GatewayExpectedUSDT)
	stale := clonePaymentOrderSnapshot(persisted.ProviderSnapshot)
	stale["expires_at"] = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano)
	expiredOrder, err := client.PaymentOrder.UpdateOneID(order.ID).SetProviderSnapshot(stale).Save(ctx)
	require.NoError(t, err)
	received = nil
	_, err = svc.invokeProvider(ctx, expiredOrder, req, settings, 67, "67.00", 67, nil, sel)
	require.Error(t, err)
	require.Nil(t, received, "expired quote must fail before calling gateway")
	_, err = client.PaymentOrder.UpdateOneID(order.ID).SetProviderSnapshot(persisted.ProviderSnapshot).Save(ctx)
	require.NoError(t, err)
	gateway, err := provider.NewEPUSDT("cny-test", cfg)
	require.NoError(t, err)
	values := map[string]any{"pid": "1000", "order_id": order.OutTradeNo, "trade_id": "cny-integration-trade", "amount": 67, "actual_amount": 10, "token": "USDT", "status": 2, "block_transaction_id": "test-cny-block"}
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, key+"="+fmt.Sprint(values[key]))
	}
	mac := hmac.New(sha256.New, []byte(cfg["secretKey"]))
	mac.Write([]byte(strings.Join(parts, "&")))
	values["signature"] = hex.EncodeToString(mac.Sum(nil))
	body, err := json.Marshal(values)
	require.NoError(t, err)
	notification, err := gateway.VerifyNotification(ctx, string(body), nil)
	require.NoError(t, err)
	require.Equal(t, payment.NotificationStatusSuccess, notification.Status)
	for i := 0; i < 3; i++ {
		require.NoError(t, svc.HandlePaymentNotification(ctx, notification, payment.TypeEpusdt))
	}
	require.Equal(t, 67.0, credited)
	require.Equal(t, OrderStatusCompleted, mustGetPaymentOrder(t, ctx, client, order.ID).Status)
}
