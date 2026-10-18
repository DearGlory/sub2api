//go:build unit

package service

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"testing"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/paymentauditlog"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/stretchr/testify/require"
)

type paymentConfirmTestProvider struct {
	paymentFulfillmentTestProvider
	err   error
	calls *int
}

func (p paymentConfirmTestProvider) ConfirmNotification(_ context.Context, n *payment.PaymentNotification) error {
	*p.calls++
	if p.err == nil && n.TradeNo == "" {
		n.TradeNo = "upstream-trade"
	}
	return p.err
}

func TestConfirmNotificationUpstreamRecordsAuditOnFailure(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	user, err := client.User.Create().
		SetEmail("confirm-upstream@example.com").
		SetPasswordHash("hash").
		SetUsername("confirm-upstream-user").
		Save(ctx)
	require.NoError(t, err)
	order, err := client.PaymentOrder.Create().
		SetUserID(user.ID).
		SetUserEmail(user.Email).
		SetUserName(user.Username).
		SetAmount(10).
		SetPayAmount(10).
		SetFeeRate(0).
		SetRechargeCode("PAY-CONFIRM-UPSTREAM").
		SetOutTradeNo("sub2_confirm_upstream").
		SetPaymentType(payment.TypeAlipay).
		SetPaymentTradeNo("").
		SetOrderType(payment.OrderTypeBalance).
		SetStatus(OrderStatusPending).
		SetExpiresAt(time.Now().Add(time.Hour)).
		SetClientIP("127.0.0.1").
		SetSrcHost("api.example.com").
		Save(ctx)
	require.NoError(t, err)

	svc := &PaymentService{entClient: client}
	calls := 0
	prov := paymentConfirmTestProvider{
		paymentFulfillmentTestProvider: paymentFulfillmentTestProvider{key: payment.TypeEasyPay},
		err:                            errors.New("easypay confirm: upstream reports order sub2_confirm_upstream as not paid"),
		calls:                          &calls,
	}
	n := &payment.PaymentNotification{OrderID: order.OutTradeNo, TradeNo: "T-unconfirmed", Amount: 10, Status: payment.NotificationStatusSuccess}

	err = svc.ConfirmNotificationUpstream(ctx, prov, n)
	require.Error(t, err)
	require.Equal(t, 1, calls)

	count, err := client.PaymentAuditLog.Query().
		Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(order.ID, 10)), paymentauditlog.ActionEQ("PAYMENT_UPSTREAM_UNCONFIRMED")).
		Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, count)

	reloaded, err := client.PaymentOrder.Get(ctx, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderStatusPending, reloaded.Status)
}

func TestConfirmNotificationUpstreamPassThrough(t *testing.T) {
	svc := &PaymentService{}
	n := &payment.PaymentNotification{OrderID: "sub2_x", Amount: 10, Status: payment.NotificationStatusSuccess}

	// Providers without the confirmer capability keep their existing flow.
	require.NoError(t, svc.ConfirmNotificationUpstream(context.Background(), paymentFulfillmentTestProvider{key: payment.TypeStripe}, n))

	calls := 0
	prov := paymentConfirmTestProvider{paymentFulfillmentTestProvider: paymentFulfillmentTestProvider{key: payment.TypeEasyPay}, calls: &calls}

	// Non-success notifications are never fulfilled, so they are not queried.
	failed := &payment.PaymentNotification{OrderID: "sub2_x", Status: payment.ProviderStatusFailed}
	require.NoError(t, svc.ConfirmNotificationUpstream(context.Background(), prov, failed))
	require.Equal(t, 0, calls)

	require.NoError(t, svc.ConfirmNotificationUpstream(context.Background(), prov, n))
	require.Equal(t, 1, calls)
	require.Equal(t, "upstream-trade", n.TradeNo)
}

func TestToPaidEpusdtAfterGraceQueuesManualReviewWithCallbackEvidence(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	user, err := client.User.Create().
		SetEmail("late-epusdt@example.com").
		SetPasswordHash("hash").
		SetUsername("late-epusdt-user").
		Save(ctx)
	require.NoError(t, err)

	order, err := client.PaymentOrder.Create().
		SetUserID(user.ID).
		SetUserEmail(user.Email).
		SetUserName(user.Username).
		SetAmount(10).
		SetPayAmount(10).
		SetFeeRate(0).
		SetRechargeCode("PAY-LATE-EPUSDT").
		SetOutTradeNo("sub2_late_epusdt").
		SetPaymentType(payment.TypeEpusdt).
		SetPaymentTradeNo("").
		SetOrderType(payment.OrderTypeBalance).
		SetStatus(OrderStatusPending).
		SetProviderKey(payment.TypeEpusdt).
		SetProviderSnapshot(map[string]any{
			"schema_version":       2,
			"provider_key":         payment.TypeEpusdt,
			"merchant_id":          "1000",
			"asset":                "USDT",
			"currency":             "USD",
			"requested_network":    "trc20",
			"grace_minutes":        0,
			"auto_credit_deadline": time.Now().Add(-time.Minute).UTC().Format(time.RFC3339Nano),
		}).
		SetExpiresAt(time.Now().Add(-time.Hour)).
		SetClientIP("127.0.0.1").
		SetSrcHost("api.example.com").
		Save(ctx)
	require.NoError(t, err)

	svc := &PaymentService{entClient: client}
	err = svc.toPaidEpusdt(ctx, order, "trade-late-epusdt", 10, payment.TypeEpusdt, map[string]string{
		"pid":                  "1000",
		"token":                "USDT",
		"actual_amount":        "12.34",
		"block_transaction_id": "0xlate",
	})
	require.NoError(t, err)

	reloaded, err := client.PaymentOrder.Get(ctx, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderStatusPending, reloaded.Status)
	review, err := client.PaymentAuditLog.Query().
		Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(order.ID, 10)), paymentauditlog.ActionEQ(PaymentManualReviewAction)).
		Only(ctx)
	require.NoError(t, err)
	require.Contains(t, review.Detail, "trade-late-epusdt")
}

func TestRecordPaymentManualReviewLeavesOrderPending(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	user, err := client.User.Create().
		SetEmail("manual-review@example.com").
		SetPasswordHash("hash").
		SetUsername("manual-review-user").
		Save(ctx)
	require.NoError(t, err)
	order, err := client.PaymentOrder.Create().
		SetUserID(user.ID).
		SetUserEmail(user.Email).
		SetUserName(user.Username).
		SetAmount(10).
		SetPayAmount(10).
		SetFeeRate(0).
		SetRechargeCode("PAY-MANUAL-REVIEW").
		SetOutTradeNo("sub2_manual_review").
		SetPaymentType(payment.TypeEpusdt).
		SetPaymentTradeNo("").
		SetOrderType(payment.OrderTypeBalance).
		SetStatus(OrderStatusPending).
		SetProviderKey(payment.TypeEpusdt).
		SetProviderSnapshot(map[string]any{
			"provider_key":      "epusdt",
			"merchant_id":       "1000",
			"asset":             "USDT",
			"requested_network": "trc20",
			"currency":          "USD",
		}).
		SetExpiresAt(time.Now().Add(time.Hour)).
		SetClientIP("127.0.0.1").
		SetSrcHost("api.example.com").
		Save(ctx)
	require.NoError(t, err)

	svc := &PaymentService{entClient: client}
	err = svc.RecordPaymentManualReview(ctx, &payment.PaymentNotification{
		OrderID: order.OutTradeNo,
		TradeNo: "trade-manual",
		Amount:  10,
		Status:  payment.ProviderStatusPending,
		Metadata: map[string]string{
			"network_verification": "manual_review",
			"configured_networks":  "bsc,trc20",
			"pid":                  "1000",
			"token":                "USDT",
			"actual_amount":        "12.34",
			"block_transaction_id": "0xabc",
		},
	})
	require.NoError(t, err)

	reloaded, err := client.PaymentOrder.Get(ctx, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderStatusPending, reloaded.Status)
	count, err := client.PaymentAuditLog.Query().
		Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(order.ID, 10)), paymentauditlog.ActionEQ("PAYMENT_MANUAL_NETWORK_REVIEW")).
		Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}

func ensureEpusdtPaymentClaimsTable(t *testing.T, ctx context.Context, client *dbent.Client) {
	t.Helper()
	_, err := client.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS epusdt_payment_claims (
    id INTEGER PRIMARY KEY,
    block_transaction_id TEXT NOT NULL UNIQUE,
    order_id INTEGER NOT NULL,
    trade_no TEXT NOT NULL,
    amount REAL NOT NULL,
    actual_amount REAL NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
)`)
	require.NoError(t, err)
}

func createEpusdtManualReviewOrder(t *testing.T, ctx context.Context, client *dbent.Client, outTradeNo, paymentTradeNo string) *dbent.PaymentOrder {
	t.Helper()
	user, err := client.User.Create().
		SetEmail(outTradeNo + "@example.com").
		SetPasswordHash("hash").
		SetUsername(outTradeNo + "-user").
		Save(ctx)
	require.NoError(t, err)
	order, err := client.PaymentOrder.Create().
		SetUserID(user.ID).
		SetUserEmail(user.Email).
		SetUserName(user.Username).
		SetAmount(10).
		SetPayAmount(10).
		SetFeeRate(0).
		SetRechargeCode("PAY-" + outTradeNo).
		SetOutTradeNo(outTradeNo).
		SetPaymentType(payment.TypeEpusdt).
		SetPaymentTradeNo(paymentTradeNo).
		SetOrderType(payment.OrderTypeBalance).
		SetStatus(OrderStatusPending).
		SetProviderKey(payment.TypeEpusdt).
		SetProviderSnapshot(map[string]any{
			"schema_version":    2,
			"provider_key":      payment.TypeEpusdt,
			"merchant_id":       "1000",
			"asset":             "USDT",
			"currency":          "USD",
			"requested_network": "trc20",
		}).
		SetExpiresAt(time.Now().Add(time.Hour)).
		SetClientIP("127.0.0.1").
		SetSrcHost("api.example.com").
		Save(ctx)
	require.NoError(t, err)
	return order
}

func epusdtManualReviewNotification(order *dbent.PaymentOrder, tradeNo, blockID string) *payment.PaymentNotification {
	return &payment.PaymentNotification{
		OrderID: order.OutTradeNo,
		TradeNo: tradeNo,
		Amount:  10,
		Status:  payment.ProviderStatusPending,
		Metadata: map[string]string{
			"network_verification": "manual_review",
			"configured_networks":  "bsc,trc20",
			"pid":                  "1000",
			"token":                "USDT",
			"actual_amount":        "12.34",
			"block_transaction_id": blockID,
		},
	}
}

func TestRecordPaymentManualReviewClaimsBlockTransactionAcrossOrdersAtomically(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	first := createEpusdtManualReviewOrder(t, ctx, client, "sub2_claim_first", "")
	second := createEpusdtManualReviewOrder(t, ctx, client, "sub2_claim_second", "")
	svc := &PaymentService{entClient: client}

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, order := range []*dbent.PaymentOrder{first, second} {
		wg.Add(1)
		go func(i int, order *dbent.PaymentOrder) {
			defer wg.Done()
			errs[i] = svc.RecordPaymentManualReview(ctx, epusdtManualReviewNotification(order, "trade-"+strconv.Itoa(i), "0xABCDEF"))
		}(i, order)
	}
	wg.Wait()

	successes := 0
	for _, err := range errs {
		if err == nil {
			successes++
		}
	}
	require.Equal(t, 1, successes, "the database claim must admit exactly one order; errors=%v", errs)
	claimRows, err := client.QueryContext(ctx, "SELECT COUNT(*) FROM epusdt_payment_claims")
	require.NoError(t, err)
	require.True(t, claimRows.Next())
	var claimCount int
	require.NoError(t, claimRows.Scan(&claimCount))
	require.NoError(t, claimRows.Close())
	require.Equal(t, 1, claimCount)
	reviewCount, err := client.PaymentAuditLog.Query().Where(paymentauditlog.ActionEQ(PaymentManualReviewAction)).Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, reviewCount)
}

func TestRecordPaymentManualReviewSameOrderRetryIsIdempotent(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_claim_retry", "")
	svc := &PaymentService{entClient: client}

	require.NoError(t, svc.RecordPaymentManualReview(ctx, epusdtManualReviewNotification(order, "trade-first", "0xAbCd")))
	require.NoError(t, svc.RecordPaymentManualReview(ctx, epusdtManualReviewNotification(order, "trade-child", "0xABCD")))

	reviewCount, err := client.PaymentAuditLog.Query().Where(
		paymentauditlog.OrderIDEQ(strconv.FormatInt(order.ID, 10)),
		paymentauditlog.ActionEQ(PaymentManualReviewAction),
	).Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, reviewCount)
	claimRows, err := client.QueryContext(ctx, "SELECT trade_no FROM epusdt_payment_claims WHERE block_transaction_id = ?", "0xabcd")
	require.NoError(t, err)
	require.True(t, claimRows.Next())
	var tradeNo string
	require.NoError(t, claimRows.Scan(&tradeNo))
	require.NoError(t, claimRows.Close())
	require.Equal(t, "trade-child", tradeNo)
}

func TestNormalizeEpusdtBlockTransactionIDPreservesBase58Case(t *testing.T) {
	got, err := normalizeEpusdtBlockTransactionID("5HueCGU8rMjxEXxiPuD5BDuRaBzGv7x1")
	require.NoError(t, err)
	require.Equal(t, "5HueCGU8rMjxEXxiPuD5BDuRaBzGv7x1", got)

	got, err = normalizeEpusdtBlockTransactionID("0xAbCd12")
	require.NoError(t, err)
	require.Equal(t, "0xabcd12", got)
}

func TestRecordPaymentManualReviewFailsClosedForHistoricalBlockClaimConflict(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	first := createEpusdtManualReviewOrder(t, ctx, client, "sub2_historical_first", "")
	second := createEpusdtManualReviewOrder(t, ctx, client, "sub2_historical_second", "")
	third := createEpusdtManualReviewOrder(t, ctx, client, "sub2_historical_third", "")
	for _, order := range []*dbent.PaymentOrder{first, second} {
		_, err := client.PaymentAuditLog.Create().
			SetOrderID(strconv.FormatInt(order.ID, 10)).
			SetAction(PaymentManualReviewAction).
			SetDetail(`{"tradeNo":"legacy-trade","amount":10,"actualAmount":"12.34","blockTransactionID":"5HueCGU8rMjxEXxiPuD5BDuRaBzGv7x1"}`).
			SetOperator(payment.TypeEpusdt).
			Save(ctx)
		require.NoError(t, err)
	}

	err := (&PaymentService{entClient: client}).RecordPaymentManualReview(ctx, epusdtManualReviewNotification(third, "new-trade", "5HueCGU8rMjxEXxiPuD5BDuRaBzGv7x1"))
	require.ErrorContains(t, err, "multiple historical orders")
	claimRows, queryErr := client.QueryContext(ctx, "SELECT COUNT(*) FROM epusdt_payment_claims")
	require.NoError(t, queryErr)
	require.True(t, claimRows.Next())
	var claimCount int
	require.NoError(t, claimRows.Scan(&claimCount))
	require.NoError(t, claimRows.Close())
	require.Zero(t, claimCount)
}

func TestRecordPaymentManualReviewRollsBackBlockClaimWhenAuditWriteFails(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	ensurePaymentAuditOrderActionUniqueIndex(t, ctx, client)
	order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_claim_rollback", "")
	_, err := client.PaymentAuditLog.Create().
		SetOrderID(strconv.FormatInt(order.ID, 10)).
		SetAction(PaymentManualReviewAction).
		SetDetail(`{"tradeNo":"old-trade","amount":10,"blockTransactionID":"0xrollback"}`).
		SetOperator("system").
		Save(ctx)
	require.NoError(t, err)
	_, err = client.ExecContext(ctx, `
CREATE TRIGGER epusdt_audit_write_failure
BEFORE UPDATE ON payment_audit_logs
WHEN NEW.action = 'PAYMENT_MANUAL_NETWORK_REVIEW'
BEGIN
    SELECT RAISE(ABORT, 'audit write failed');
END`)
	require.NoError(t, err)

	err = (&PaymentService{entClient: client}).RecordPaymentManualReview(ctx, epusdtManualReviewNotification(order, "new-trade", "0xrollback"))
	require.Error(t, err)
	claimRows, err := client.QueryContext(ctx, "SELECT COUNT(*) FROM epusdt_payment_claims")
	require.NoError(t, err)
	require.True(t, claimRows.Next())
	var claimCount int
	require.NoError(t, claimRows.Scan(&claimCount))
	require.NoError(t, claimRows.Close())
	require.Zero(t, claimCount, "a failed audit insert must roll back the durable claim")
}

func TestApprovePaymentManualReviewAllowsCreatedGatewayTradeAndIsIdempotent(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_approve_parent", "gateway-parent-trade")
	_, err := client.PaymentAuditLog.Create().
		SetOrderID(strconv.FormatInt(order.ID, 10)).
		SetAction(PaymentManualReviewAction).
		SetDetail(`{"tradeNo":"gateway-child-trade","amount":10,"actualAmount":"12.34","blockTransactionID":"0xapprove"}`).
		SetOperator(payment.TypeEpusdt).
		Save(ctx)
	require.NoError(t, err)

	redeemRepo := &paymentFulfillmentRedeemRepo{}
	userRepo := &mockUserRepo{getByIDUser: &User{ID: order.UserID, Balance: 0}}
	redeemService := NewRedeemService(redeemRepo, userRepo, nil, &paymentFulfillmentRedeemCacheStub{}, nil, client, nil, nil)
	svc := &PaymentService{entClient: client, redeemService: redeemService, userRepo: userRepo}
	require.NoError(t, svc.ApprovePaymentManualReview(ctx, order.ID, "admin", "verified on chain"))
	reloaded, err := client.PaymentOrder.Get(ctx, order.ID)
	require.NoError(t, err)
	require.Equal(t, OrderStatusCompleted, reloaded.Status)
	require.Equal(t, "gateway-parent-trade", reloaded.PaymentTradeNo)
	approvedAudit, err := client.PaymentAuditLog.Query().Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(order.ID, 10)), paymentauditlog.ActionEQ(PaymentManualApprovedAction)).Only(ctx)
	require.NoError(t, err)
	require.Contains(t, approvedAudit.Detail, "gateway-child-trade")

	// A retry after the approval audit exists must recover the completed order.
	require.NoError(t, svc.ApprovePaymentManualReview(ctx, order.ID, "admin", "retry"))
	approvedCount, err := client.PaymentAuditLog.Query().Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(order.ID, 10)), paymentauditlog.ActionEQ(PaymentManualApprovedAction)).Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, approvedCount)
}

func TestApprovePaymentManualReviewRejectsMismatchedEvidenceAmount(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_approve_amount", "gateway-parent-trade")
	_, err := client.PaymentAuditLog.Create().
		SetOrderID(strconv.FormatInt(order.ID, 10)).
		SetAction(PaymentManualReviewAction).
		SetDetail(`{"tradeNo":"gateway-child-trade","amount":11,"blockTransactionID":"0xamount"}`).
		SetOperator(payment.TypeEpusdt).
		Save(ctx)
	require.NoError(t, err)

	err = (&PaymentService{entClient: client}).ApprovePaymentManualReview(ctx, order.ID, "admin", "bad amount")
	require.Error(t, err)
	require.Equal(t, OrderStatusPending, mustGetPaymentOrder(t, ctx, client, order.ID).Status)
}

func TestRejectedEpusdtOrderCallbackDoesNotRequeueManualReview(t *testing.T) {
	ctx := context.Background()
	client := newPaymentConfigServiceTestClient(t)
	ensureEpusdtPaymentClaimsTable(t, ctx, client)
	order := createEpusdtManualReviewOrder(t, ctx, client, "sub2_rejected_callback", "")
	order, err := client.PaymentOrder.UpdateOneID(order.ID).SetStatus(OrderStatusFailed).Save(ctx)
	require.NoError(t, err)
	_, err = client.PaymentAuditLog.Create().
		SetOrderID(strconv.FormatInt(order.ID, 10)).
		SetAction(PaymentManualReviewAction).
		SetDetail(`{"tradeNo":"rejected-trade","amount":10,"blockTransactionID":"0xrejected"}`).
		SetOperator(payment.TypeEpusdt).
		Save(ctx)
	require.NoError(t, err)
	_, err = client.PaymentAuditLog.Create().
		SetOrderID(strconv.FormatInt(order.ID, 10)).
		SetAction(PaymentManualRejectedAction).
		SetDetail(`{"note":"invalid proof"}`).
		SetOperator("admin").
		Save(ctx)
	require.NoError(t, err)

	require.NoError(t, (&PaymentService{entClient: client}).RecordPaymentManualReview(ctx, epusdtManualReviewNotification(order, "callback-trade", "0xcallback")))
	count, err := client.PaymentAuditLog.Query().Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(order.ID, 10)), paymentauditlog.ActionEQ(PaymentManualReviewAction)).Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, count)
}

func mustGetPaymentOrder(t *testing.T, ctx context.Context, client *dbent.Client, orderID int64) *dbent.PaymentOrder {
	t.Helper()
	order, err := client.PaymentOrder.Get(ctx, orderID)
	require.NoError(t, err)
	return order
}
