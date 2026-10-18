//go:build unit

package service

import (
	"context"
	"fmt"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/paymentauditlog"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/stretchr/testify/require"
)

func TestEpusdtCNYAmountEvidenceAndCredit(t *testing.T) {
	for _, tc := range []struct {
		name     string
		actual   string
		expected float64
		accepted bool
	}{
		{"matches", "10", 10, true},
		{"underpaid", "9.99", 10, false},
		{"changed", "10.01", 10, false},
		{"missing_frozen_amount", "10", 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			client := newPaymentConfigServiceTestClient(t)
			ensureEpusdtPaymentClaimsTable(t, ctx, client)
			order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_cny_"+tc.name, "")
			var err error
			order, err = client.PaymentOrder.UpdateOneID(order.ID).SetAmount(67).SetPayAmount(67).
				SetProviderSnapshot(map[string]any{
					"schema_version": 2, "provider_key": payment.TypeEpusdt,
					"merchant_id": "1000", "asset": "USDT", "currency": "CNY",
					"gateway_expected_usdt": tc.expected,
					"auto_credit_deadline":  time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano),
				}).Save(ctx)
			require.NoError(t, err)
			credited := 0.0
			userRepo := &mockUserRepo{getByIDUser: &User{ID: order.UserID}}
			userRepo.updateBalanceFn = func(_ context.Context, _ int64, value float64) error { credited += value; return nil }
			redeem := NewRedeemService(&paymentFulfillmentRedeemRepo{}, userRepo, nil, &paymentFulfillmentRedeemCacheStub{}, nil, client, nil, nil)
			svc := &PaymentService{entClient: client, redeemService: redeem, userRepo: userRepo}
			metadata := map[string]string{"pid": "1000", "token": "USDT", "actual_amount": tc.actual, "block_transaction_id": "block-cny-" + tc.name, "network_verification": "gateway_signed"}
			err = svc.toPaidEpusdt(ctx, order, "trade-cny-"+tc.name, 67, payment.TypeEpusdt, metadata)
			require.NoError(t, err)
			got := mustGetPaymentOrder(t, ctx, client, order.ID)
			if tc.accepted {
				require.Equal(t, OrderStatusCompleted, got.Status)
				require.Equal(t, 67.0, credited)
				require.NoError(t, svc.toPaidEpusdt(ctx, order, "trade-cny-"+tc.name, 67, payment.TypeEpusdt, metadata))
				require.Equal(t, 67.0, credited)
			} else {
				require.Equal(t, OrderStatusPending, got.Status)
				require.Zero(t, credited)
				exists, err := client.PaymentAuditLog.Query().Where(paymentauditlog.OrderIDEQ(fmt.Sprint(order.ID)), paymentauditlog.ActionEQ(PaymentManualReviewAction)).Exist(ctx)
				require.NoError(t, err)
				require.True(t, exists)
			}
		})
	}
}

func TestEpusdtFailedUnpaidOrderCannotBeCredited(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_failed_creation", "")
	order, err := client.PaymentOrder.UpdateOneID(order.ID).SetStatus(OrderStatusFailed).Save(ctx)
	require.NoError(t, err)
	credited := 0.0
	userRepo := &mockUserRepo{getByIDUser: &User{ID: order.UserID}}
	userRepo.updateBalanceFn = func(_ context.Context, _ int64, value float64) error { credited += value; return nil }
	redeem := NewRedeemService(&paymentFulfillmentRedeemRepo{}, userRepo, nil, &paymentFulfillmentRedeemCacheStub{}, nil, client, nil, nil)
	svc := &PaymentService{entClient: client, redeemService: redeem, userRepo: userRepo}
	err = svc.toPaidEpusdt(ctx, order, "unpaid-trade", 10, payment.TypeEpusdt, map[string]string{"pid": "1000", "token": "USDT", "actual_amount": "10", "block_transaction_id": "unpaid-block"})
	require.Error(t, err)
	require.Zero(t, credited)
	require.Equal(t, OrderStatusFailed, mustGetPaymentOrder(t, ctx, client, order.ID).Status)
}

func TestEpusdtAutomaticSettlementRequiresBalanceAndFrozenMerchant(t *testing.T) {
	for _, bad := range []string{"merchant", "order_type"} {
		t.Run(bad, func(t *testing.T) {
			ctx := context.Background()
			client := newPaymentConfigServiceTestClient(t)
			ensureEpusdtPaymentClaimsTable(t, ctx, client)
			order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_bad_"+bad, "")
			update := client.PaymentOrder.UpdateOneID(order.ID)
			if bad == "merchant" {
				snapshot := clonePaymentOrderSnapshot(order.ProviderSnapshot)
				delete(snapshot, "merchant_id")
				update.SetProviderSnapshot(snapshot)
			} else {
				update.SetOrderType(payment.OrderTypeSubscription)
			}
			order, err := update.Save(ctx)
			require.NoError(t, err)
			userRepo := &mockUserRepo{getByIDUser: &User{ID: order.UserID}}
			redeem := NewRedeemService(&paymentFulfillmentRedeemRepo{}, userRepo, nil, &paymentFulfillmentRedeemCacheStub{}, nil, client, nil, nil)
			svc := &PaymentService{entClient: client, redeemService: redeem, userRepo: userRepo}
			err = svc.toPaidEpusdt(ctx, order, "trade-invalid", 10, payment.TypeEpusdt, map[string]string{"pid": "1000", "token": "USDT", "actual_amount": "10", "block_transaction_id": "invalid-block"})
			require.Error(t, err)
			require.Equal(t, OrderStatusPending, mustGetPaymentOrder(t, ctx, client, order.ID).Status)
		})
	}
}

func TestEpusdtRechargingCallbackRecoversExpiredFulfillmentLease(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_recharging_recovery", "")
	credited := 0.0
	userRepo := &mockUserRepo{getByIDUser: &User{ID: order.UserID}}
	userRepo.updateBalanceFn = func(_ context.Context, _ int64, amount float64) error { credited += amount; return nil }
	redeem := NewRedeemService(&paymentFulfillmentRedeemRepo{}, userRepo, nil, &paymentFulfillmentRedeemCacheStub{}, nil, client, nil, nil)
	svc := &PaymentService{entClient: client, redeemService: redeem, userRepo: userRepo}
	metadata := map[string]string{"pid": "1000", "token": "USDT", "actual_amount": "10", "block_transaction_id": "lease-recovery-block"}
	require.NoError(t, svc.toPaidEpusdt(ctx, order, "lease-recovery-trade", 10, payment.TypeEpusdt, metadata))
	_, err := client.PaymentOrder.UpdateOneID(order.ID).SetStatus(OrderStatusRecharging).SetUpdatedAt(time.Now().Add(-2 * paymentFulfillmentLeaseDuration)).ClearCompletedAt().Save(ctx)
	require.NoError(t, err)
	require.NoError(t, svc.toPaidEpusdt(ctx, order, "lease-recovery-trade", 10, payment.TypeEpusdt, metadata))
	require.Equal(t, order.Amount, credited)
	require.Equal(t, OrderStatusCompleted, mustGetPaymentOrder(t, ctx, client, order.ID).Status)
}

func TestDailyLimitCurrencyIsolationIsEpusdtOnly(t *testing.T) {
	usd := &dbent.PaymentOrder{OrderType: payment.OrderTypeBalance, PaymentType: payment.TypeAlipay, PayAmount: 10, ProviderSnapshot: map[string]any{"currency": "USD"}}
	require.True(t, dailyLimitUsesOrderInCurrency(usd, payment.TypeAlipay, "CNY"), "ordinary channels keep existing aggregation")
	usd.PaymentType = payment.TypeEpusdt
	require.False(t, dailyLimitUsesOrderInCurrency(usd, payment.TypeEpusdt, "CNY"))
	require.True(t, dailyLimitUsesOrderInCurrency(usd, payment.TypeEpusdt, "USD"))
}
