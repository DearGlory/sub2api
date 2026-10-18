//go:build unit

package service

import (
	"context"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/stretchr/testify/require"
)

func TestEpusdtUnifiedInputDoesNotRequireNetwork(t *testing.T) {
	svc := &PaymentService{}
	_, err := svc.validateOrderInput(context.Background(), CreateOrderRequest{OrderType: payment.OrderTypeBalance, PaymentType: payment.TypeEpusdt, Amount: 67}, &PaymentConfig{EpusdtMinAmount: 1, EpusdtMaxAmount: 1000})
	require.NoError(t, err)
}

func TestEpusdtGatewaySelectedNetworkSettlesWithoutInitialUSDTAmount(t *testing.T) {
	for _, validTrade := range []bool{true, false} {
		t.Run(map[bool]string{true: "bound_trade", false: "wrong_trade"}[validTrade], func(t *testing.T) {
			ctx := context.Background()
			client := newPaymentConfigServiceTestClient(t)
			ensureEpusdtPaymentClaimsTable(t, ctx, client)
			order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_gateway_selection", "gateway-created-trade")
			order, err := client.PaymentOrder.UpdateOneID(order.ID).SetAmount(67).SetPayAmount(67).SetProviderSnapshot(map[string]any{
				"schema_version": 2, "provider_key": payment.TypeEpusdt, "merchant_id": "1000", "asset": "USDT", "currency": "CNY",
				"gateway_checkout_mode": "select_network", "gateway_created_trade_no": "gateway-created-trade",
				"auto_credit_deadline": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
			}).Save(ctx)
			require.NoError(t, err)
			credited := 0.0
			userRepo := &mockUserRepo{getByIDUser: &User{ID: order.UserID}}
			userRepo.updateBalanceFn = func(_ context.Context, _ int64, value float64) error { credited += value; return nil }
			redeem := NewRedeemService(&paymentFulfillmentRedeemRepo{}, userRepo, nil, &paymentFulfillmentRedeemCacheStub{}, nil, client, nil, nil)
			svc := &PaymentService{entClient: client, redeemService: redeem, userRepo: userRepo}
			trade := "gateway-created-trade"
			if !validTrade {
				trade = "unrelated-trade"
			}
			notification := &payment.PaymentNotification{OrderID: order.OutTradeNo, TradeNo: trade, Amount: 67, Status: payment.NotificationStatusSuccess, Metadata: map[string]string{
				"pid": "1000", "token": "USDT", "actual_amount": "10.03", "block_transaction_id": "gateway-selected-block", "network_verification": "gateway_signed",
			}}
			err = svc.HandlePaymentNotification(ctx, notification, payment.TypeEpusdt)
			if validTrade {
				require.NoError(t, err)
				require.Equal(t, OrderStatusCompleted, mustGetPaymentOrder(t, ctx, client, order.ID).Status)
				require.Equal(t, 67.0, credited)
				require.NoError(t, svc.HandlePaymentNotification(ctx, notification, payment.TypeEpusdt))
				require.Equal(t, 67.0, credited)
			} else {
				require.Error(t, err)
				require.Equal(t, OrderStatusPending, mustGetPaymentOrder(t, ctx, client, order.ID).Status)
				require.Zero(t, credited)
			}
		})
	}
}
