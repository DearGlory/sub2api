package service

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"

	"entgo.io/ent/dialect"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/paymentauditlog"
	"github.com/Wei-Shaw/sub2api/ent/paymentorder"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
	"github.com/Wei-Shaw/sub2api/internal/pkg/servertiming"
)

// ErrOrderNotFound is returned by HandlePaymentNotification when the webhook
// references an out_trade_no that does not exist in our DB. Callers (webhook
// handlers) should treat this as a terminal, non-retryable condition and still
// respond with a 2xx success to the provider — otherwise the provider will keep
// retrying forever (e.g. when a foreign environment's webhook endpoint is
// misconfigured to point at us, or when our orders table has been wiped).
var ErrOrderNotFound = errors.New("payment order not found")

const paymentFulfillmentLeaseDuration = 5 * time.Minute

type paymentFulfillmentLease struct {
	version time.Time
}

// --- Payment Notification & Fulfillment ---

func (s *PaymentService) HandlePaymentNotification(ctx context.Context, n *payment.PaymentNotification, pk string) error {
	if n.Status != payment.NotificationStatusSuccess {
		return nil
	}
	// Look up order by out_trade_no (the external order ID we sent to the provider)
	order, err := s.entClient.PaymentOrder.Query().Where(paymentorder.OutTradeNo(n.OrderID)).Only(ctx)
	if err != nil {
		// Fallback only for true legacy "sub2_N" DB-ID payloads when the
		// current out_trade_no lookup genuinely did not find an order.
		if oid, ok := parseLegacyPaymentOrderID(n.OrderID, err); ok {
			return s.confirmPayment(ctx, oid, n.TradeNo, n.Amount, pk, n.Metadata)
		}
		if dbent.IsNotFound(err) {
			return fmt.Errorf("%w: out_trade_no=%s", ErrOrderNotFound, n.OrderID)
		}
		return fmt.Errorf("lookup order failed for out_trade_no %s: %w", n.OrderID, err)
	}
	return s.confirmPayment(ctx, order.ID, n.TradeNo, n.Amount, pk, n.Metadata)
}

// ConfirmNotificationUpstream asks providers that implement
// payment.NotificationConfirmer to confirm a verified success notification
// against the upstream order, using the same instance that verified it.
// Failures are recorded on the order's audit trail and returned so the webhook
// answers non-success and the gateway retries.
func (s *PaymentService) ConfirmNotificationUpstream(ctx context.Context, prov payment.Provider, n *payment.PaymentNotification) error {
	confirmer, ok := prov.(payment.NotificationConfirmer)
	if !ok || n == nil || n.Status != payment.NotificationStatusSuccess {
		return nil
	}
	notifiedTradeNo := n.TradeNo
	finishProviderCall := servertiming.ObserveDependency(ctx, "payment")
	err := confirmer.ConfirmNotification(ctx, n)
	finishProviderCall()
	if err == nil {
		return nil
	}
	if order, lookupErr := s.entClient.PaymentOrder.Query().Where(paymentorder.OutTradeNo(n.OrderID)).Only(ctx); lookupErr == nil {
		s.writeAuditLog(ctx, order.ID, "PAYMENT_UPSTREAM_UNCONFIRMED", prov.ProviderKey(), map[string]any{
			"detail":  err.Error(),
			"tradeNo": notifiedTradeNo,
			"amount":  n.Amount,
		})
	}
	return err
}

func (s *PaymentService) RecordPaymentManualReview(ctx context.Context, n *payment.PaymentNotification) error {
	if s == nil || s.entClient == nil || n == nil {
		return fmt.Errorf("record payment manual review: missing service or notification")
	}
	order, err := s.entClient.PaymentOrder.Query().Where(paymentorder.OutTradeNo(n.OrderID)).Only(ctx)
	if err != nil {
		if dbent.IsNotFound(err) {
			return fmt.Errorf("%w: out_trade_no=%s", ErrOrderNotFound, n.OrderID)
		}
		return fmt.Errorf("record payment manual review: lookup order: %w", err)
	}
	if order.Status != OrderStatusPending && order.Status != OrderStatusCancelled && order.Status != OrderStatusExpired {
		return nil
	}
	snapshot := psOrderProviderSnapshot(order)
	if snapshot == nil || snapshot.ProviderKey != payment.TypeEpusdt {
		return fmt.Errorf("record payment manual review: provider snapshot mismatch")
	}
	if columnKey := strings.TrimSpace(psStringValue(order.ProviderKey)); columnKey != "" && !strings.EqualFold(columnKey, payment.TypeEpusdt) {
		return fmt.Errorf("record payment manual review: provider mismatch")
	}
	if snapshot.MerchantID == "" || !strings.EqualFold(snapshot.MerchantID, strings.TrimSpace(n.Metadata["pid"])) {
		return fmt.Errorf("record payment manual review: merchant mismatch")
	}
	orderCurrency := PaymentOrderCurrency(order)
	if order.OrderType != payment.OrderTypeBalance || (orderCurrency != "USD" && orderCurrency != "CNY") || !strings.EqualFold(snapshot.Asset, "USDT") {
		return fmt.Errorf("record payment manual review: unsupported order currency, asset, or type")
	}
	if !isValidProviderAmount(n.Amount) || math.Abs(n.Amount-order.PayAmount) > paymentAmountToleranceForCurrency(orderCurrency) {
		return fmt.Errorf("record payment manual review: amount mismatch")
	}
	actualAmountText := strings.TrimSpace(n.Metadata["actual_amount"])
	actualAmount, actualAmountErr := strconv.ParseFloat(actualAmountText, 64)
	if actualAmountErr != nil || !isValidProviderAmount(actualAmount) {
		return fmt.Errorf("record payment manual review: invalid actual amount")
	}
	if !strings.EqualFold(strings.TrimSpace(n.Metadata["token"]), "USDT") || strings.TrimSpace(n.TradeNo) == "" {
		return fmt.Errorf("record payment manual review: missing USDT asset or upstream trade")
	}
	blockTransactionEvidence := strings.TrimSpace(n.Metadata["block_transaction_id"])
	blockTransactionID, blockErr := normalizeEpusdtBlockTransactionID(blockTransactionEvidence)
	if blockErr != nil {
		return fmt.Errorf("record payment manual review: missing blockchain transaction")
	}
	tradeNo := strings.TrimSpace(n.TradeNo)
	if tradeNo == "" || strings.IndexFunc(tradeNo, unicode.IsControl) >= 0 || len(tradeNo) > 128 {
		return fmt.Errorf("record payment manual review: invalid upstream trade")
	}
	tx, err := s.entClient.Tx(ctx)
	if err != nil {
		return fmt.Errorf("record payment manual review: begin transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	txCtx := dbent.NewTxContext(ctx, tx)
	current, err := paymentOrderForManualReviewUpdate(txCtx, tx, order.ID)
	if err != nil {
		return fmt.Errorf("record payment manual review: lock order: %w", err)
	}
	if current.Status != OrderStatusPending && current.Status != OrderStatusCancelled && current.Status != OrderStatusExpired {
		return nil
	}
	claimed, err := claimEpusdtBlockTransactionForCurrency(txCtx, tx.Client(), blockTransactionID, current.ID, tradeNo, n.Amount, actualAmount, orderCurrency)
	if err != nil {
		return fmt.Errorf("record payment manual review: claim blockchain transaction: %w", err)
	}
	if claimed != current.ID {
		return fmt.Errorf("record payment manual review: blockchain transaction already belongs to another order")
	}
	detail := map[string]any{
		"tradeNo":             n.TradeNo,
		"amount":              n.Amount,
		"blockTransactionID":  blockTransactionEvidence,
		"networkVerification": n.Metadata["network_verification"],
		"configuredNetworks":  n.Metadata["configured_networks"],
		"requestedNetwork":    snapshot.RequestedNetwork,
		"actualAmount":        actualAmountText,
	}
	review, reviewErr := latestManualReviewWithClient(txCtx, tx.Client(), current.ID)
	if reviewErr != nil && !infraerrors.IsNotFound(reviewErr) {
		return fmt.Errorf("record payment manual review: lookup audit: %w", reviewErr)
	}
	if review == nil {
		if err := writePaymentAuditLogErr(txCtx, tx.Client(), current.ID, PaymentManualReviewAction, payment.TypeEpusdt, detail); err != nil {
			return fmt.Errorf("record payment manual review: write audit: %w", err)
		}
	} else {
		existingBlock, existingBlockErr := normalizeEpusdtBlockTransactionID(manualReviewBlockTransactionID(review.Detail))
		if existingBlockErr != nil || existingBlock != blockTransactionID {
			return fmt.Errorf("record payment manual review: order already has different blockchain evidence")
		}
		encoded, marshalErr := json.Marshal(detail)
		if marshalErr != nil {
			return fmt.Errorf("record payment manual review: marshal audit: %w", marshalErr)
		}
		if _, err := tx.Client().PaymentAuditLog.UpdateOneID(review.ID).SetDetail(string(encoded)).SetOperator(payment.TypeEpusdt).Save(txCtx); err != nil {
			return fmt.Errorf("record payment manual review: update audit: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("record payment manual review: commit transaction: %w", err)
	}
	return nil
}

func normalizeEpusdtBlockTransactionID(value string) (string, error) {
	original := strings.TrimSpace(value)
	if original == "" || len(original) > 255 || strings.IndexFunc(original, unicode.IsSpace) >= 0 || strings.IndexFunc(original, unicode.IsControl) >= 0 {
		return "", errors.New("invalid blockchain transaction")
	}
	hexValue := original
	prefixed := strings.HasPrefix(strings.ToLower(original), "0x")
	if prefixed {
		hexValue = original[2:]
	}
	if (prefixed || len(hexValue) == 64) && len(hexValue) > 0 && len(hexValue)%2 == 0 {
		if _, err := hex.DecodeString(hexValue); err == nil {
			return "0x" + strings.ToLower(hexValue), nil
		}
	}
	return original, nil
}

func manualReviewBlockTransactionID(detail string) string {
	var value map[string]any
	if json.Unmarshal([]byte(detail), &value) != nil {
		return ""
	}
	block, _ := value["blockTransactionID"].(string)
	return block
}

func claimEpusdtBlockTransaction(ctx context.Context, client *dbent.Client, blockID string, orderID int64, tradeNo string, amount, actualAmount float64) (int64, error) {
	return claimEpusdtBlockTransactionForCurrency(ctx, client, blockID, orderID, tradeNo, amount, actualAmount, "USD")
}

func claimEpusdtBlockTransactionForCurrency(ctx context.Context, client *dbent.Client, blockID string, orderID int64, tradeNo string, amount, actualAmount float64, currency string) (int64, error) {
	if client == nil {
		return 0, errors.New("nil payment client")
	}
	historicalOrderID, err := historicalEpusdtBlockClaim(ctx, client, blockID)
	if err != nil {
		return 0, err
	}
	if historicalOrderID != 0 && historicalOrderID != orderID {
		return historicalOrderID, nil
	}
	if err := claimEpusdtTradeNumber(ctx, client, blockID, orderID, tradeNo); err != nil {
		return 0, err
	}
	var query string
	var args []any
	if paymentAuditDialect(client) == dialect.Postgres {
		query = `INSERT INTO epusdt_payment_claims (block_transaction_id, order_id, trade_no, amount, actual_amount, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, NOW(), NOW()) ON CONFLICT (block_transaction_id) DO NOTHING`
		args = []any{blockID, orderID, tradeNo, amount, actualAmount}
	} else {
		query = `INSERT INTO epusdt_payment_claims (block_transaction_id, order_id, trade_no, amount, actual_amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT (block_transaction_id) DO NOTHING`
		args = []any{blockID, orderID, tradeNo, amount, actualAmount}
	}
	result, err := client.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	if inserted, rowsErr := result.RowsAffected(); rowsErr != nil {
		return 0, rowsErr
	} else if inserted > 0 {
		return orderID, nil
	}

	selectQuery := `SELECT order_id, trade_no, amount, actual_amount FROM epusdt_payment_claims WHERE block_transaction_id = ?`
	selectArgs := []any{blockID}
	if paymentAuditDialect(client) == dialect.Postgres {
		selectQuery = `SELECT order_id, trade_no, amount, actual_amount FROM epusdt_payment_claims WHERE block_transaction_id = $1`
	}
	rows, err := client.QueryContext(ctx, selectQuery, selectArgs...)
	if err != nil {
		return 0, err
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return 0, err
		}
		return 0, errors.New("blockchain transaction claim disappeared")
	}
	var claimedOrderID int64
	var claimedTradeNo string
	var claimedAmount, claimedActualAmount float64
	if err := rows.Scan(&claimedOrderID, &claimedTradeNo, &claimedAmount, &claimedActualAmount); err != nil {
		return 0, err
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if claimedOrderID != orderID {
		return claimedOrderID, nil
	}
	if math.Abs(claimedAmount-amount) > paymentAmountToleranceForCurrency(currency) || math.Abs(claimedActualAmount-actualAmount) > paymentAmountToleranceForCurrency("USD") {
		return 0, errors.New("blockchain transaction evidence amount changed")
	}
	if claimedTradeNo != tradeNo {
		updateQuery := `UPDATE epusdt_payment_claims SET trade_no = ?, updated_at = CURRENT_TIMESTAMP WHERE block_transaction_id = ? AND order_id = ?`
		updateArgs := []any{tradeNo, blockID, orderID}
		if paymentAuditDialect(client) == dialect.Postgres {
			updateQuery = `UPDATE epusdt_payment_claims SET trade_no = $1, updated_at = NOW() WHERE block_transaction_id = $2 AND order_id = $3`
		}
		if _, err := client.ExecContext(ctx, updateQuery, updateArgs...); err != nil {
			return 0, err
		}
	}
	return claimedOrderID, nil
}

// claimEpusdtTradeNumber runs inside the caller's transaction and never releases
// an earlier callback trade when a gateway parent order gains another trade.
func claimEpusdtTradeNumber(ctx context.Context, client *dbent.Client, blockID string, orderID int64, tradeNo string) error {
	tradeNo = strings.TrimSpace(tradeNo)
	if tradeNo == "" || len(tradeNo) > 128 || strings.IndexFunc(tradeNo, unicode.IsControl) >= 0 {
		return errors.New("invalid upstream trade number")
	}
	exists, err := client.PaymentOrder.Query().Where(paymentorder.PaymentTypeEQ(payment.TypeEpusdt), paymentorder.PaymentTradeNoEQ(tradeNo), paymentorder.IDNEQ(orderID)).Exist(ctx)
	if err != nil {
		return err
	}
	if exists {
		return errors.New("upstream trade number already belongs to another order")
	}
	logs, err := client.PaymentAuditLog.Query().Where(paymentauditlog.ActionIn(PaymentManualReviewAction, PaymentManualApprovedAction)).All(ctx)
	if err != nil {
		return err
	}
	for _, log := range logs {
		if strings.TrimSpace(manualReviewTradeNo(log.Detail)) == tradeNo && log.OrderID != strconv.FormatInt(orderID, 10) {
			return errors.New("upstream trade number belongs to another historical order")
		}
	}
	insert := `INSERT INTO epusdt_payment_trade_claims (trade_no, order_id, block_transaction_id) VALUES (?, ?, ?) ON CONFLICT (trade_no) DO NOTHING`
	query := `SELECT order_id, block_transaction_id FROM epusdt_payment_trade_claims WHERE trade_no = ?`
	if paymentAuditDialect(client) == dialect.Postgres {
		insert = `INSERT INTO epusdt_payment_trade_claims (trade_no, order_id, block_transaction_id) VALUES ($1, $2, $3) ON CONFLICT (trade_no) DO NOTHING`
		query = `SELECT order_id, block_transaction_id FROM epusdt_payment_trade_claims WHERE trade_no = $1`
	}
	if _, err := client.ExecContext(ctx, insert, tradeNo, orderID, blockID); err != nil {
		return err
	}
	rows, err := client.QueryContext(ctx, query, tradeNo)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return err
		}
		return errors.New("upstream trade claim disappeared")
	}
	var owner int64
	var claimedBlock string
	if err := rows.Scan(&owner, &claimedBlock); err != nil {
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if owner != orderID || claimedBlock != blockID {
		return errors.New("upstream trade number already has different payment evidence")
	}
	return nil
}

// historicalEpusdtBlockClaim protects the first post-247 callback from
// reusing evidence that was recorded before the durable claim table existed.
// The table remains the concurrent admission gate; this lookup only bridges
// pre-migration audit rows.
func historicalEpusdtBlockClaim(ctx context.Context, client *dbent.Client, blockID string) (int64, error) {
	logs, err := client.PaymentAuditLog.Query().Where(paymentauditlog.ActionEQ(PaymentManualReviewAction)).All(ctx)
	if err != nil {
		return 0, err
	}
	var matchedOrderID int64
	for _, log := range logs {
		historicalBlock, normalizeErr := normalizeEpusdtBlockTransactionID(manualReviewBlockTransactionID(log.Detail))
		if normalizeErr != nil || historicalBlock != blockID {
			continue
		}
		orderID, parseErr := strconv.ParseInt(strings.TrimSpace(log.OrderID), 10, 64)
		if parseErr != nil || orderID <= 0 {
			continue
		}
		if matchedOrderID != 0 && matchedOrderID != orderID {
			return 0, fmt.Errorf("blockchain transaction evidence belongs to multiple historical orders")
		}
		matchedOrderID = orderID
	}
	return matchedOrderID, nil
}

func parseLegacyPaymentOrderID(orderID string, lookupErr error) (int64, bool) {
	if !dbent.IsNotFound(lookupErr) {
		return 0, false
	}
	orderID = strings.TrimSpace(orderID)
	if !strings.HasPrefix(orderID, orderIDPrefix) {
		return 0, false
	}
	trimmed := strings.TrimPrefix(orderID, orderIDPrefix)
	if trimmed == "" || trimmed == orderID {
		return 0, false
	}
	oid, err := strconv.ParseInt(trimmed, 10, 64)
	if err != nil || oid <= 0 {
		return 0, false
	}
	return oid, true
}

func (s *PaymentService) confirmPayment(ctx context.Context, oid int64, tradeNo string, paid float64, pk string, metadata map[string]string) error {
	o, err := s.entClient.PaymentOrder.Get(ctx, oid)
	if err != nil {
		slog.Error("order not found", "orderID", oid)
		return nil
	}
	instanceProviderKey := ""
	if inst, instErr := s.getOrderProviderInstance(ctx, o); instErr == nil && inst != nil {
		instanceProviderKey = inst.ProviderKey
	}
	expectedProviderKey := expectedNotificationProviderKeyForOrder(s.registry, o, instanceProviderKey)
	if expectedProviderKey != "" && strings.TrimSpace(pk) != "" && !strings.EqualFold(expectedProviderKey, strings.TrimSpace(pk)) {
		s.writeAuditLog(ctx, o.ID, "PAYMENT_PROVIDER_MISMATCH", pk, map[string]any{
			"expectedProvider": expectedProviderKey,
			"actualProvider":   pk,
			"tradeNo":          tradeNo,
		})
		return fmt.Errorf("provider mismatch: expected %s, got %s", expectedProviderKey, pk)
	}
	if err := validateProviderNotificationMetadata(o, pk, metadata); err != nil {
		s.writeAuditLog(ctx, o.ID, "PAYMENT_PROVIDER_METADATA_MISMATCH", pk, map[string]any{
			"detail":  err.Error(),
			"tradeNo": tradeNo,
		})
		return err
	}
	if payment.GetBasePaymentType(o.PaymentType) == payment.TypeEpusdt {
		return s.toPaidEpusdt(ctx, o, tradeNo, paid, pk, metadata)
	}
	if !isValidProviderAmount(paid) {
		s.writeAuditLog(ctx, o.ID, "PAYMENT_INVALID_AMOUNT", pk, map[string]any{
			"expected": o.PayAmount,
			"paid":     paid,
			"tradeNo":  tradeNo,
		})
		return fmt.Errorf("invalid paid amount from provider: %v", paid)
	}
	if math.Abs(paid-o.PayAmount) > paymentAmountToleranceForCurrency(PaymentOrderCurrency(o)) {
		s.writeAuditLog(ctx, o.ID, "PAYMENT_AMOUNT_MISMATCH", pk, map[string]any{"expected": o.PayAmount, "paid": paid, "tradeNo": tradeNo})
		return fmt.Errorf("amount mismatch: expected %s, got %s", strconv.FormatFloat(o.PayAmount, 'f', -1, 64), strconv.FormatFloat(paid, 'f', -1, 64))
	}
	return s.toPaid(ctx, o, tradeNo, paid, pk, metadata)
}

func paymentAmountToleranceForCurrency(currency string) float64 {
	minorUnit := payment.CurrencyMinorUnit(currency)
	if minorUnit <= 2 {
		return amountToleranceCNY
	}
	return math.Pow10(-minorUnit) / 2
}

func isValidProviderAmount(amount float64) bool {
	return amount > 0 && !math.IsNaN(amount) && !math.IsInf(amount, 0)
}

func validateProviderNotificationMetadata(order *dbent.PaymentOrder, providerKey string, metadata map[string]string) error {
	return validateProviderSnapshotMetadata(order, providerKey, metadata)
}

func expectedNotificationProviderKey(registry *payment.Registry, orderPaymentType string, orderProviderKey string, instanceProviderKey string) string {
	if key := strings.TrimSpace(instanceProviderKey); key != "" {
		return key
	}
	if key := strings.TrimSpace(orderProviderKey); key != "" {
		return key
	}
	if registry != nil {
		if key := strings.TrimSpace(registry.GetProviderKey(payment.PaymentType(orderPaymentType))); key != "" {
			return key
		}
	}
	return strings.TrimSpace(orderPaymentType)
}

func (s *PaymentService) toPaid(ctx context.Context, o *dbent.PaymentOrder, tradeNo string, paid float64, pk string, metadata map[string]string) error {
	if payment.GetBasePaymentType(o.PaymentType) == payment.TypeEpusdt {
		return s.toPaidEpusdt(ctx, o, tradeNo, paid, pk, metadata)
	}
	previousStatus := o.Status
	now := time.Now()
	grace := now.Add(-paymentGraceMinutes * time.Minute)
	statusPredicate := paymentorder.Or(
		paymentorder.StatusEQ(OrderStatusPending),
		paymentorder.StatusEQ(OrderStatusCancelled),
		paymentorder.And(
			paymentorder.StatusEQ(OrderStatusExpired),
			paymentorder.UpdatedAtGTE(grace),
		),
	)
	c, err := s.entClient.PaymentOrder.Update().Where(
		paymentorder.IDEQ(o.ID),
		statusPredicate,
	).SetStatus(OrderStatusPaid).SetPayAmount(paid).SetPaymentTradeNo(tradeNo).SetPaidAt(now).ClearFailedAt().ClearFailedReason().Save(ctx)
	if err != nil {
		return fmt.Errorf("update to PAID: %w", err)
	}
	if c == 0 {
		return s.alreadyProcessed(ctx, o)
	}
	if previousStatus == OrderStatusCancelled || previousStatus == OrderStatusExpired {
		slog.Info("order recovered from webhook payment success",
			"orderID", o.ID,
			"previousStatus", previousStatus,
			"tradeNo", tradeNo,
			"provider", pk,
		)
		s.writeAuditLog(ctx, o.ID, "ORDER_RECOVERED", pk, map[string]any{
			"previous_status": previousStatus,
			"tradeNo":         tradeNo,
			"paidAmount":      paid,
			"reason":          "webhook payment success received after order " + previousStatus,
		})
	}
	s.writeAuditLog(ctx, o.ID, "ORDER_PAID", pk, map[string]any{"tradeNo": tradeNo, "paidAmount": paid})
	return s.executeFulfillment(ctx, o.ID)
}

func (s *PaymentService) toPaidEpusdt(ctx context.Context, o *dbent.PaymentOrder, tradeNo string, paid float64, pk string, metadata map[string]string) error {
	tx, err := s.entClient.Tx(ctx)
	if err != nil {
		return fmt.Errorf("begin USDT payment transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	txCtx := dbent.NewTxContext(ctx, tx)
	var current *dbent.PaymentOrder
	if tx.Client().Driver().Dialect() == dialect.SQLite {
		current, err = tx.PaymentOrder.Query().Where(paymentorder.IDEQ(o.ID)).Only(txCtx)
	} else {
		current, err = tx.PaymentOrder.Query().Where(paymentorder.IDEQ(o.ID)).ForUpdate().Only(txCtx)
	}
	if err != nil {
		return fmt.Errorf("lock USDT payment order: %w", err)
	}

	if payment.GetBasePaymentType(current.PaymentType) != payment.TypeEpusdt || current.OrderType != payment.OrderTypeBalance {
		return fmt.Errorf("USDT payment order has unexpected provider or order type")
	}
	if columnKey := strings.TrimSpace(psStringValue(current.ProviderKey)); columnKey != "" && !strings.EqualFold(columnKey, payment.TypeEpusdt) {
		return fmt.Errorf("USDT payment order provider column mismatch: %s", columnKey)
	}
	snapshot := psOrderProviderSnapshot(current)
	if snapshot == nil || !strings.EqualFold(snapshot.ProviderKey, payment.TypeEpusdt) || !strings.EqualFold(snapshot.Asset, "USDT") || strings.TrimSpace(snapshot.MerchantID) == "" {
		return fmt.Errorf("USDT payment order provider snapshot is invalid")
	}
	if err := validateProviderSnapshotMetadata(current, pk, metadata); err != nil {
		return fmt.Errorf("validate USDT payment metadata: %w", err)
	}
	currency := PaymentOrderCurrency(current)
	if currency != "USD" && currency != "CNY" {
		return fmt.Errorf("unsupported USDT payment currency: %s", currency)
	}
	if !isValidProviderAmount(paid) || math.Abs(paid-current.PayAmount) > paymentAmountToleranceForCurrency(currency) {
		return fmt.Errorf("USDT payment amount mismatch: expected %s, got %s", strconv.FormatFloat(current.PayAmount, 'f', -1, 64), strconv.FormatFloat(paid, 'f', -1, 64))
	}
	actualAmountText := strings.TrimSpace(metadata["actual_amount"])
	actualAmount, actualErr := strconv.ParseFloat(actualAmountText, 64)
	if actualErr != nil || !isValidProviderAmount(actualAmount) {
		return fmt.Errorf("invalid USDT actual amount")
	}
	blockEvidence := strings.TrimSpace(metadata["block_transaction_id"])
	blockID, blockErr := normalizeEpusdtBlockTransactionID(blockEvidence)
	if blockErr != nil {
		return fmt.Errorf("invalid USDT blockchain transaction")
	}
	tradeNo = strings.TrimSpace(tradeNo)
	if tradeNo == "" || strings.IndexFunc(tradeNo, unicode.IsControl) >= 0 || len(tradeNo) > 128 {
		return fmt.Errorf("invalid USDT upstream trade")
	}
	gatewaySelection := snapshot.GatewayCheckoutMode == "select_network"
	if gatewaySelection && (snapshot.GatewayCreatedTradeNo == "" || tradeNo != snapshot.GatewayCreatedTradeNo || metadata["network_verification"] != "gateway_signed") {
		return fmt.Errorf("USDT checkout receipt does not match its signed gateway order")
	}

	if current.Status == OrderStatusCompleted || current.Status == OrderStatusRefunded {
		// Terminal replay must not reserve new chain or gateway evidence.
		return nil
	}

	rejected, err := tx.Client().PaymentAuditLog.Query().
		Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(current.ID, 10)), paymentauditlog.ActionEQ(PaymentManualRejectedAction)).
		Limit(1).
		Exist(txCtx)
	if err != nil {
		return fmt.Errorf("check rejected USDT payment: %w", err)
	}
	if rejected {
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit rejected USDT payment no-op: %w", err)
		}
		return nil
	}

	previousStatus := current.Status
	now := time.Now()
	needsPaymentTransition := current.Status == OrderStatusPending || current.Status == OrderStatusCancelled || current.Status == OrderStatusExpired
	if !needsPaymentTransition {
		if current.Status != OrderStatusPaid && current.Status != OrderStatusFailed && current.Status != OrderStatusRecharging {
			return fmt.Errorf("USDT payment order cannot be fulfilled from %s", current.Status)
		}
		accepted, err := tx.Client().PaymentAuditLog.Query().Where(
			paymentauditlog.OrderIDEQ(strconv.FormatInt(current.ID, 10)),
			paymentauditlog.ActionIn("ORDER_PAID", PaymentManualApprovedAction),
		).Exist(txCtx)
		if err != nil {
			return fmt.Errorf("read accepted USDT payment audit: %w", err)
		}
		if current.PaidAt == nil || !accepted {
			return fmt.Errorf("USDT payment has no accepted receipt to resume")
		}
	}
	if needsPaymentTransition {
		deadline, hasDeadline := effectiveEpusdtAutoCreditDeadline(current, snapshot)
		// Legacy concrete orders have an initial token amount. Unified checkout
		// freezes only CNY here; the signed, trade-bound receipt supplies USDT
		// after network selection and never changes the credited balance.
		amountMismatch := currency == "CNY" && !gatewaySelection && (!finitePositive(snapshot.GatewayExpectedUSDT) || actualAmount != snapshot.GatewayExpectedUSDT)
		if !hasDeadline || now.After(deadline) || amountMismatch {
			if err := tx.Rollback(); err != nil {
				slog.Warn("rollback late USDT payment transaction failed", "orderID", current.ID, "error", err)
			}
			reviewErr := s.RecordPaymentManualReview(ctx, &payment.PaymentNotification{
				OrderID:  current.OutTradeNo,
				TradeNo:  tradeNo,
				Amount:   paid,
				Status:   payment.NotificationStatusSuccess,
				Metadata: metadata,
			})
			if reviewErr != nil {
				return fmt.Errorf("record late USDT payment for manual review: %w", reviewErr)
			}
			return nil
		}
	}

	claimed, err := claimEpusdtBlockTransactionForCurrency(txCtx, tx.Client(), blockID, current.ID, tradeNo, paid, actualAmount, currency)
	if err != nil {
		return fmt.Errorf("claim USDT payment evidence: %w", err)
	}
	if claimed != current.ID {
		return fmt.Errorf("USDT payment evidence belongs to another order")
	}

	updated := 0
	if needsPaymentTransition {
		update := tx.PaymentOrder.Update().Where(
			paymentorder.IDEQ(current.ID),
			paymentorder.StatusIn(OrderStatusPending, OrderStatusCancelled, OrderStatusExpired),
		).SetStatus(OrderStatusPaid).SetPayAmount(paid).SetPaidAt(now).ClearFailedAt().ClearFailedReason()
		if strings.TrimSpace(current.PaymentTradeNo) == "" {
			update.SetPaymentTradeNo(tradeNo)
		}
		updated, err = update.Save(txCtx)
		if err != nil {
			return fmt.Errorf("update USDT order to PAID: %w", err)
		}
		if updated == 0 {
			return fmt.Errorf("USDT order state changed before payment transition")
		}
		detail := map[string]any{
			"tradeNo":             tradeNo,
			"paidAmount":          paid,
			"actualAmount":        actualAmountText,
			"blockTransactionID":  blockEvidence,
			"networkVerification": metadata["network_verification"],
			"requestedNetwork":    snapshot.RequestedNetwork,
		}
		if previousStatus == OrderStatusCancelled || previousStatus == OrderStatusExpired {
			if err := writePaymentAuditLogErr(txCtx, tx.Client(), current.ID, "ORDER_RECOVERED", pk, map[string]any{
				"previous_status": previousStatus,
				"tradeNo":         tradeNo,
				"paidAmount":      paid,
				"reason":          "webhook payment success received after order " + previousStatus,
			}); err != nil {
				return fmt.Errorf("write USDT recovery audit: %w", err)
			}
		}
		if err := writePaymentAuditLogErr(txCtx, tx.Client(), current.ID, "ORDER_PAID", pk, detail); err != nil {
			return fmt.Errorf("write USDT paid audit: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit USDT payment transaction: %w", err)
	}
	if needsPaymentTransition || current.Status == OrderStatusPaid || current.Status == OrderStatusFailed || current.Status == OrderStatusRecharging {
		return s.executeFulfillment(ctx, current.ID)
	}
	return nil
}

func (s *PaymentService) alreadyProcessed(ctx context.Context, o *dbent.PaymentOrder) error {
	cur, err := s.entClient.PaymentOrder.Get(ctx, o.ID)
	if err != nil {
		return nil
	}
	switch cur.Status {
	case OrderStatusCompleted, OrderStatusRefunded:
		return nil
	case OrderStatusFailed:
		if payment.GetBasePaymentType(o.PaymentType) == payment.TypeEpusdt {
			return nil
		}
		return s.executeFulfillment(ctx, o.ID)
	case OrderStatusPaid, OrderStatusRecharging:
		return s.executeFulfillment(ctx, o.ID)
	case OrderStatusExpired:
		slog.Warn("webhook payment success for expired order beyond grace period",
			"orderID", o.ID,
			"status", cur.Status,
			"updatedAt", cur.UpdatedAt,
		)
		s.writeAuditLog(ctx, o.ID, "PAYMENT_AFTER_EXPIRY", "system", map[string]any{
			"status":    cur.Status,
			"updatedAt": cur.UpdatedAt,
			"reason":    "payment arrived after expiry grace period",
		})
		return nil
	default:
		return nil
	}
}

func (s *PaymentService) executeFulfillment(ctx context.Context, oid int64) error {
	o, err := s.entClient.PaymentOrder.Get(ctx, oid)
	if err != nil {
		return fmt.Errorf("get order: %w", err)
	}
	switch o.OrderType {
	case payment.OrderTypeSubscription:
		return s.ExecuteSubscriptionFulfillment(ctx, oid)
	case payment.OrderTypeBalance:
		return s.ExecuteBalanceFulfillment(ctx, oid)
	default:
		// 不支持的订单类型不履约：标记 FAILED 后正常返回，避免支付回调持续 500 重试。
		s.rejectUnsupportedOrderType(ctx, o)
		return nil
	}
}

func isSupportedPaymentOrderType(orderType string) bool {
	return orderType == payment.OrderTypeBalance || orderType == payment.OrderTypeSubscription
}

func (s *PaymentService) rejectUnsupportedOrderType(ctx context.Context, o *dbent.PaymentOrder) {
	reason := "unsupported order type: " + o.OrderType
	c, err := s.entClient.PaymentOrder.Update().
		Where(
			paymentorder.IDEQ(o.ID),
			paymentorder.StatusIn(OrderStatusPaid, OrderStatusRecharging),
		).
		SetStatus(OrderStatusFailed).SetFailedAt(time.Now()).SetFailedReason(reason).Save(ctx)
	if err != nil {
		slog.Error("mark unsupported order type FAILED", "orderID", o.ID, "error", err)
		return
	}
	if c > 0 {
		slog.Warn("payment order with unsupported order type not fulfilled", "orderID", o.ID, "orderType", o.OrderType)
		s.writeAuditLog(ctx, o.ID, "FULFILLMENT_FAILED", "system", map[string]any{"reason": reason})
	}
}

func (s *PaymentService) ExecuteBalanceFulfillment(ctx context.Context, oid int64) error {
	o, err := s.entClient.PaymentOrder.Get(ctx, oid)
	if err != nil {
		return infraerrors.NotFound("NOT_FOUND", "order not found")
	}
	if o.OrderType != payment.OrderTypeBalance {
		return infraerrors.BadRequest("INVALID_ORDER_TYPE", "order is not a balance order")
	}
	if o.Status == OrderStatusCompleted {
		return nil
	}
	if psIsRefundStatus(o.Status) {
		return infraerrors.BadRequest("INVALID_STATUS", "refund-related order cannot fulfill")
	}
	if o.Status != OrderStatusPaid && o.Status != OrderStatusFailed && o.Status != OrderStatusRecharging {
		return infraerrors.BadRequest("INVALID_STATUS", "order cannot fulfill in status "+o.Status)
	}
	lease, err := s.acquirePaymentFulfillmentLease(ctx, o)
	if err != nil {
		return err
	}
	if lease == nil {
		return nil
	}
	if err := s.doBalance(ctx, o, lease); err != nil {
		s.markFailed(ctx, oid, lease, err)
		return err
	}
	return nil
}

func (s *PaymentService) acquirePaymentFulfillmentLease(ctx context.Context, o *dbent.PaymentOrder) (*paymentFulfillmentLease, error) {
	if o == nil {
		return nil, infraerrors.BadRequest("INVALID_STATUS", "nil payment order")
	}

	now := time.Now().UTC().Truncate(time.Microsecond)
	staleBefore := now.Add(-paymentFulfillmentLeaseDuration)
	updated, err := s.entClient.PaymentOrder.Update().
		Where(
			paymentorder.IDEQ(o.ID),
			paymentorder.Or(
				paymentorder.StatusIn(OrderStatusPaid, OrderStatusFailed),
				paymentorder.And(
					paymentorder.StatusEQ(OrderStatusRecharging),
					paymentorder.UpdatedAtLTE(staleBefore),
				),
			),
		).
		SetStatus(OrderStatusRecharging).
		SetUpdatedAt(now).
		ClearFailedAt().
		ClearFailedReason().
		Save(ctx)
	if err != nil {
		return nil, fmt.Errorf("acquire fulfillment lease: %w", err)
	}
	if updated == 0 {
		current, getErr := s.entClient.PaymentOrder.Get(ctx, o.ID)
		if getErr != nil {
			return nil, fmt.Errorf("reload fulfillment lease: %w", getErr)
		}
		if current.Status == OrderStatusCompleted {
			return nil, nil
		}
		if current.Status == OrderStatusRecharging {
			return nil, infraerrors.Conflict("CONFLICT", "order is being processed")
		}
		return nil, infraerrors.Conflict("CONFLICT", "order status changed while acquiring fulfillment lease")
	}

	// Reload the persisted timestamp instead of trusting application clock precision.
	claimed, err := s.entClient.PaymentOrder.Get(ctx, o.ID)
	if err != nil {
		return nil, fmt.Errorf("reload acquired fulfillment lease: %w", err)
	}
	if claimed.Status != OrderStatusRecharging {
		return nil, infraerrors.Conflict("CONFLICT", "fulfillment lease was lost")
	}
	return &paymentFulfillmentLease{version: claimed.UpdatedAt}, nil
}

// redeemAction represents the idempotency decision for balance fulfillment.
type redeemAction int

const (
	// redeemActionCreate: code does not exist — create it, then redeem.
	redeemActionCreate redeemAction = iota
	// redeemActionRedeem: code exists but is unused — skip creation, redeem only.
	redeemActionRedeem
	// redeemActionSkipCompleted: code exists and is already used — skip to mark completed.
	redeemActionSkipCompleted
)

// resolveRedeemAction decides the idempotency action based on an existing redeem code lookup.
// existing is the result of GetByCode; lookupErr is the error from that call.
func resolveRedeemAction(existing *RedeemCode, lookupErr error) (redeemAction, error) {
	if lookupErr != nil {
		if errors.Is(lookupErr, ErrRedeemCodeNotFound) {
			return redeemActionCreate, nil
		}
		return redeemActionCreate, fmt.Errorf("lookup payment redeem code: %w", lookupErr)
	}
	if existing == nil {
		return redeemActionCreate, nil
	}
	if existing.IsUsed() {
		return redeemActionSkipCompleted, nil
	}
	return redeemActionRedeem, nil
}

func validatePaymentRedeemCode(o *dbent.PaymentOrder, code *RedeemCode) error {
	if o == nil || code == nil {
		return errors.New("payment redeem code validation requires an order and code")
	}
	if code.Code != o.RechargeCode {
		return fmt.Errorf("payment redeem code mismatch for order %d", o.ID)
	}
	if code.Type != RedeemTypeBalance {
		return fmt.Errorf("payment redeem code type mismatch for order %d: got %s", o.ID, code.Type)
	}
	if math.IsNaN(code.Value) || math.IsInf(code.Value, 0) || math.Abs(code.Value-o.Amount) > 1e-8 {
		return fmt.Errorf("payment redeem code amount mismatch for order %d: expected %.8f, got %.8f", o.ID, o.Amount, code.Value)
	}
	switch code.Status {
	case StatusUnused:
		if code.UsedBy != nil {
			return fmt.Errorf("unused payment redeem code has a user for order %d", o.ID)
		}
	case StatusUsed:
		if code.UsedBy == nil || *code.UsedBy != o.UserID {
			return fmt.Errorf("payment redeem code user mismatch for order %d", o.ID)
		}
	default:
		return fmt.Errorf("payment redeem code has invalid status for order %d: %s", o.ID, code.Status)
	}
	return nil
}

func (s *PaymentService) doBalance(ctx context.Context, o *dbent.PaymentOrder, lease *paymentFulfillmentLease) error {
	// Idempotency: check if redeem code already exists (from a previous partial run)
	existing, lookupErr := s.redeemService.GetByCode(ctx, o.RechargeCode)
	action, err := resolveRedeemAction(existing, lookupErr)
	if err != nil {
		return err
	}
	if existing != nil {
		if err := validatePaymentRedeemCode(o, existing); err != nil {
			return err
		}
	}

	switch action {
	case redeemActionSkipCompleted:
		if err := s.applyAffiliateRebateForOrder(ctx, o); err != nil {
			return err
		}
		// Code already created and redeemed — just mark completed
		return s.markCompleted(ctx, o, lease, "RECHARGE_SUCCESS")
	case redeemActionCreate:
		rc := &RedeemCode{Code: o.RechargeCode, Type: RedeemTypeBalance, Value: o.Amount, Status: StatusUnused}
		if err := s.redeemService.CreateCode(ctx, rc); err != nil {
			return fmt.Errorf("create redeem code: %w", err)
		}
	case redeemActionRedeem:
		// Code exists but unused — skip creation, proceed to redeem
	}
	if _, err := s.redeemService.redeemForPaymentFulfillment(ctx, o.UserID, o.RechargeCode); err != nil {
		return fmt.Errorf("redeem balance: %w", err)
	}
	if err := s.applyAffiliateRebateForOrder(ctx, o); err != nil {
		return err
	}
	return s.markCompleted(ctx, o, lease, "RECHARGE_SUCCESS")
}

func (s *PaymentService) markCompleted(ctx context.Context, o *dbent.PaymentOrder, lease *paymentFulfillmentLease, auditAction string) error {
	if lease == nil {
		return errors.New("missing payment fulfillment lease")
	}
	now := time.Now()
	updated, err := s.entClient.PaymentOrder.Update().Where(
		paymentorder.IDEQ(o.ID),
		paymentorder.StatusEQ(OrderStatusRecharging),
		paymentorder.UpdatedAtEQ(lease.version),
	).SetStatus(OrderStatusCompleted).SetCompletedAt(now).Save(ctx)
	if err != nil {
		return fmt.Errorf("mark completed: %w", err)
	}
	if updated == 0 {
		current, getErr := s.entClient.PaymentOrder.Get(ctx, o.ID)
		if getErr == nil && current.Status == OrderStatusCompleted {
			return nil
		}
		return infraerrors.Conflict("CONFLICT", "fulfillment lease was lost before completion")
	}
	if !s.hasAuditLog(ctx, o.ID, auditAction) {
		s.writeAuditLog(ctx, o.ID, auditAction, "system", map[string]any{
			"rechargeCode":   o.RechargeCode,
			"creditedAmount": o.Amount,
			"payAmount":      o.PayAmount,
		})
		s.dispatchPaymentFulfillmentNotification(o, auditAction)
	}
	return nil
}

func (s *PaymentService) dispatchPaymentFulfillmentNotification(o *dbent.PaymentOrder, auditAction string) {
	if s == nil || s.notificationEmailService == nil || o == nil {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), emailSendTimeout)
		defer cancel()
		var err error
		switch auditAction {
		case "RECHARGE_SUCCESS":
			err = s.sendBalanceRechargeSuccessNotification(ctx, o)
		case "SUBSCRIPTION_SUCCESS":
			err = s.sendSubscriptionPurchaseSuccessNotification(ctx, o)
		default:
			return
		}
		if err != nil {
			slog.Warn("payment fulfillment notification email failed", "order_id", o.ID, "action", auditAction, "err", err.Error())
		}
	}()
}

func (s *PaymentService) sendBalanceRechargeSuccessNotification(ctx context.Context, o *dbent.PaymentOrder) error {
	currentBalance := ""
	if s.userRepo != nil {
		if user, err := s.userRepo.GetByID(ctx, o.UserID); err == nil && user != nil {
			currentBalance = fmt.Sprintf("%.2f", user.Balance)
		}
	}
	return s.notificationEmailService.Send(ctx, NotificationEmailSendInput{
		Event:          NotificationEmailEventBalanceRechargeSuccess,
		RecipientEmail: o.UserEmail,
		RecipientName:  firstNonEmpty(o.UserName, o.UserEmail),
		UserID:         o.UserID,
		SourceType:     "payment_order",
		SourceID:       strconv.FormatInt(o.ID, 10),
		Variables: map[string]string{
			"recharge_amount": fmt.Sprintf("%.2f", o.Amount),
			"current_balance": currentBalance,
			"order_id":        strconv.FormatInt(o.ID, 10),
		},
	})
}

func (s *PaymentService) sendSubscriptionPurchaseSuccessNotification(ctx context.Context, o *dbent.PaymentOrder) error {
	variables := map[string]string{
		"subscription_group": "Subscription",
		"subscription_days":  "",
		"expiry_time":        "",
		"order_id":           strconv.FormatInt(o.ID, 10),
	}
	if o.SubscriptionDays != nil {
		variables["subscription_days"] = strconv.Itoa(*o.SubscriptionDays)
	}
	if o.SubscriptionGroupID != nil {
		if s.groupRepo != nil {
			if group, err := s.groupRepo.GetByID(ctx, *o.SubscriptionGroupID); err == nil && group != nil && strings.TrimSpace(group.Name) != "" {
				variables["subscription_group"] = group.Name
			}
		}
		if s.subscriptionSvc != nil {
			if sub, err := s.subscriptionSvc.GetActiveSubscription(ctx, o.UserID, *o.SubscriptionGroupID); err == nil && sub != nil {
				variables["expiry_time"] = sub.ExpiresAt.Format("2006-01-02 15:04")
			}
		}
	}
	return s.notificationEmailService.Send(ctx, NotificationEmailSendInput{
		Event:          NotificationEmailEventSubscriptionPurchaseSuccess,
		RecipientEmail: o.UserEmail,
		RecipientName:  firstNonEmpty(o.UserName, o.UserEmail),
		UserID:         o.UserID,
		SourceType:     "payment_order",
		SourceID:       strconv.FormatInt(o.ID, 10),
		Variables:      variables,
	})
}

func (s *PaymentService) ExecuteSubscriptionFulfillment(ctx context.Context, oid int64) error {
	o, err := s.entClient.PaymentOrder.Get(ctx, oid)
	if err != nil {
		return infraerrors.NotFound("NOT_FOUND", "order not found")
	}
	if o.Status == OrderStatusCompleted {
		return nil
	}
	if psIsRefundStatus(o.Status) {
		return infraerrors.BadRequest("INVALID_STATUS", "refund-related order cannot fulfill")
	}
	if o.Status != OrderStatusPaid && o.Status != OrderStatusFailed && o.Status != OrderStatusRecharging {
		return infraerrors.BadRequest("INVALID_STATUS", "order cannot fulfill in status "+o.Status)
	}
	if o.SubscriptionGroupID == nil || o.SubscriptionDays == nil {
		return infraerrors.BadRequest("INVALID_STATUS", "missing subscription info")
	}
	lease, err := s.acquirePaymentFulfillmentLease(ctx, o)
	if err != nil {
		return err
	}
	if lease == nil {
		return nil
	}
	if err := s.doSub(ctx, o, lease); err != nil {
		s.markFailed(ctx, oid, lease, err)
		return err
	}
	return nil
}

func (s *PaymentService) doSub(ctx context.Context, o *dbent.PaymentOrder, lease *paymentFulfillmentLease) error {
	gid := *o.SubscriptionGroupID
	days := *o.SubscriptionDays
	g, err := s.groupRepo.GetByID(ctx, gid)
	if err != nil || g.Status != payment.EntityStatusActive {
		return fmt.Errorf("group %d no longer exists or inactive", gid)
	}
	if err := s.ensurePaymentSubscriptionAssigned(ctx, o, gid, days); err != nil {
		return err
	}
	if err := s.applyAffiliateRebateForOrder(ctx, o); err != nil {
		return err
	}
	return s.markCompleted(ctx, o, lease, "SUBSCRIPTION_SUCCESS")
}

func (s *PaymentService) ensurePaymentSubscriptionAssigned(ctx context.Context, o *dbent.PaymentOrder, groupID int64, days int) error {
	if s.subscriptionSvc == nil {
		return errors.New("subscription service is unavailable")
	}

	tx, err := s.entClient.Tx(ctx)
	if err != nil {
		return fmt.Errorf("begin subscription fulfillment tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	txCtx := dbent.NewTxContext(ctx, tx)
	txClient := tx.Client()
	alreadyAssigned, err := hasPaymentSubscriptionAssignmentAudit(txCtx, txClient, o.ID)
	if err != nil {
		return fmt.Errorf("check subscription assignment audit: %w", err)
	}

	recoveredFromNote := false
	if !alreadyAssigned {
		orderNote := paymentSubscriptionOrderNote(o.ID)
		existing, lookupErr := s.subscriptionSvc.userSubRepo.GetByUserIDAndGroupID(txCtx, o.UserID, groupID)
		switch {
		case lookupErr == nil && existing != nil && hasPaymentSubscriptionOrderNote(existing.Notes, orderNote):
			recoveredFromNote = true
		case lookupErr != nil && !errors.Is(lookupErr, ErrSubscriptionNotFound):
			return fmt.Errorf("check existing subscription assignment: %w", lookupErr)
		default:
			if _, _, err := s.subscriptionSvc.assignOrExtendSubscription(txCtx, &AssignSubscriptionInput{
				UserID:       o.UserID,
				GroupID:      groupID,
				ValidityDays: days,
				AssignedBy:   0,
				Notes:        orderNote,
			}, true); err != nil {
				return fmt.Errorf("assign subscription: %w", err)
			}
		}

		detail, _ := json.Marshal(map[string]any{
			"groupID":           groupID,
			"validityDays":      days,
			"recoveredFromNote": recoveredFromNote,
		})
		if _, err := txClient.PaymentAuditLog.Create().
			SetOrderID(strconv.FormatInt(o.ID, 10)).
			SetAction("SUBSCRIPTION_ASSIGNED").
			SetDetail(string(detail)).
			SetOperator("system").
			Save(txCtx); err != nil {
			if dbent.IsConstraintError(err) {
				_ = tx.Rollback()
				claimed, checkErr := hasPaymentSubscriptionAssignmentAudit(ctx, s.entClient, o.ID)
				if checkErr == nil && claimed {
					return s.subscriptionSvc.invalidateSubscriptionCaches(o.UserID, groupID)
				}
			}
			return fmt.Errorf("record subscription assignment audit: %w", err)
		}
	} else {
		slog.Info("subscription already assigned for order, skipping", "orderID", o.ID, "groupID", groupID)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit subscription fulfillment tx: %w", err)
	}
	// Assignment cache invalidation is deferred while this transaction is open,
	// then performed synchronously against the committed subscription.
	if err := s.subscriptionSvc.invalidateSubscriptionCaches(o.UserID, groupID); err != nil {
		return fmt.Errorf("invalidate subscription cache after fulfillment: %w", err)
	}
	return nil
}

func hasPaymentSubscriptionAssignmentAudit(ctx context.Context, client *dbent.Client, orderID int64) (bool, error) {
	count, err := client.PaymentAuditLog.Query().
		Where(
			paymentauditlog.OrderIDEQ(strconv.FormatInt(orderID, 10)),
			paymentauditlog.ActionIn("SUBSCRIPTION_ASSIGNED", "SUBSCRIPTION_SUCCESS"),
		).
		Limit(1).
		Count(ctx)
	return count > 0, err
}

func paymentSubscriptionOrderNote(orderID int64) string {
	return fmt.Sprintf("payment order %d", orderID)
}

func hasPaymentSubscriptionOrderNote(notes string, orderNote string) bool {
	for _, line := range strings.Split(strings.ReplaceAll(notes, "\r\n", "\n"), "\n") {
		if strings.TrimSpace(line) == orderNote {
			return true
		}
	}
	return false
}

func (s *PaymentService) hasAuditLog(ctx context.Context, orderID int64, action string) bool {
	oid := strconv.FormatInt(orderID, 10)
	c, _ := s.entClient.PaymentAuditLog.Query().
		Where(paymentauditlog.OrderIDEQ(oid), paymentauditlog.ActionEQ(action)).
		Limit(1).Count(ctx)
	return c > 0
}

func (s *PaymentService) applyAffiliateRebateForOrder(ctx context.Context, o *dbent.PaymentOrder) error {
	baseAmount := affiliateRebateBaseAmount(o)
	if o == nil || baseAmount <= 0 {
		return nil
	}
	if s.affiliateService == nil {
		return nil
	}

	tx, err := s.entClient.Tx(ctx)
	if err != nil {
		s.writeAuditLog(ctx, o.ID, "AFFILIATE_REBATE_FAILED", "system", map[string]any{
			"error": fmt.Sprintf("begin affiliate rebate tx: %v", err),
		})
		return fmt.Errorf("begin affiliate rebate tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	txCtx := dbent.NewTxContext(ctx, tx)
	claimed, err := s.tryClaimAffiliateRebateAudit(txCtx, tx.Client(), o.ID, baseAmount)
	if err != nil {
		s.writeAuditLog(ctx, o.ID, "AFFILIATE_REBATE_FAILED", "system", map[string]any{
			"error": err.Error(),
		})
		return fmt.Errorf("claim affiliate rebate audit: %w", err)
	}
	if !claimed {
		return nil
	}

	sourceOrderID := o.ID
	rebateAmount, err := s.affiliateService.AccrueInviteRebateForOrder(txCtx, o.UserID, baseAmount, &sourceOrderID)
	if err != nil {
		s.writeAuditLog(ctx, o.ID, "AFFILIATE_REBATE_FAILED", "system", map[string]any{
			"error": err.Error(),
		})
		return fmt.Errorf("accrue affiliate rebate: %w", err)
	}

	if rebateAmount <= 0 {
		if err := s.updateClaimedAffiliateRebateAudit(txCtx, tx.Client(), o.ID, "AFFILIATE_REBATE_SKIPPED", map[string]any{
			"baseAmount": baseAmount,
			"reason":     "no inviter bound or rebate amount <= 0",
		}); err != nil {
			s.writeAuditLog(ctx, o.ID, "AFFILIATE_REBATE_FAILED", "system", map[string]any{
				"error": err.Error(),
			})
			return fmt.Errorf("update affiliate rebate skipped audit: %w", err)
		}
		if err := tx.Commit(); err != nil {
			s.writeAuditLog(ctx, o.ID, "AFFILIATE_REBATE_FAILED", "system", map[string]any{
				"error": fmt.Sprintf("commit affiliate rebate tx: %v", err),
			})
			return fmt.Errorf("commit affiliate rebate tx: %w", err)
		}
		return nil
	}

	if err := s.updateClaimedAffiliateRebateAudit(txCtx, tx.Client(), o.ID, "AFFILIATE_REBATE_APPLIED", map[string]any{
		"baseAmount":   baseAmount,
		"rebateAmount": rebateAmount,
	}); err != nil {
		s.writeAuditLog(ctx, o.ID, "AFFILIATE_REBATE_FAILED", "system", map[string]any{
			"error": err.Error(),
		})
		return fmt.Errorf("update affiliate rebate applied audit: %w", err)
	}

	if err := tx.Commit(); err != nil {
		s.writeAuditLog(ctx, o.ID, "AFFILIATE_REBATE_FAILED", "system", map[string]any{
			"error": fmt.Sprintf("commit affiliate rebate tx: %v", err),
		})
		return fmt.Errorf("commit affiliate rebate tx: %w", err)
	}
	return nil
}

func affiliateRebateBaseAmount(o *dbent.PaymentOrder) float64 {
	if o == nil {
		return 0
	}
	switch o.OrderType {
	case payment.OrderTypeBalance:
		// 返利只按实充部分计算，赠送额度不参与
		return paymentOrderAmountWithoutBonus(o)
	case payment.OrderTypeSubscription:
		return o.Amount
	default:
		return 0
	}
}

func (s *PaymentService) tryClaimAffiliateRebateAudit(ctx context.Context, client *dbent.Client, orderID int64, baseAmount float64) (bool, error) {
	if client == nil {
		return false, errors.New("nil payment client")
	}
	oid := strconv.FormatInt(orderID, 10)
	detail, _ := json.Marshal(map[string]any{
		"baseAmount": baseAmount,
		"status":     "reserved",
	})
	query, args := buildAffiliateRebateAuditClaimQuery(client, oid, string(detail))
	rows, err := client.QueryContext(ctx, query, args...)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	if !rows.Next() {
		if err := rows.Err(); err != nil {
			return false, err
		}
		return false, nil
	}
	var claimID int64
	if err := rows.Scan(&claimID); err != nil {
		return false, err
	}
	return true, nil
}

func buildAffiliateRebateAuditClaimQuery(client *dbent.Client, orderID, detail string) (string, []any) {
	nowExpr := paymentAuditCurrentTimestampExpr(client)
	if paymentAuditDialect(client) == dialect.Postgres {
		return fmt.Sprintf(`
INSERT INTO payment_audit_logs (order_id, action, detail, operator, created_at)
SELECT $1::text, 'AFFILIATE_REBATE_APPLIED', $2::text, 'system', %s
WHERE NOT EXISTS (
	SELECT 1
	FROM payment_audit_logs
	WHERE order_id = $1::text
	  AND action IN ('AFFILIATE_REBATE_APPLIED', 'AFFILIATE_REBATE_SKIPPED')
)
ON CONFLICT (order_id, action) DO NOTHING
RETURNING id`, nowExpr), []any{orderID, detail}
	}
	return fmt.Sprintf(`
INSERT INTO payment_audit_logs (order_id, action, detail, operator, created_at)
SELECT ?, 'AFFILIATE_REBATE_APPLIED', ?, 'system', %s
WHERE NOT EXISTS (
	SELECT 1
	FROM payment_audit_logs
	WHERE order_id = ?
	  AND action IN ('AFFILIATE_REBATE_APPLIED', 'AFFILIATE_REBATE_SKIPPED')
)
ON CONFLICT (order_id, action) DO NOTHING
RETURNING id`, nowExpr), []any{orderID, detail, orderID}
}

func paymentAuditCurrentTimestampExpr(client *dbent.Client) string {
	if paymentAuditDialect(client) == dialect.Postgres {
		return "NOW()"
	}
	return "CURRENT_TIMESTAMP"
}

func paymentAuditDialect(client *dbent.Client) string {
	if client == nil || client.Driver() == nil {
		return ""
	}
	return client.Driver().Dialect()
}

func (s *PaymentService) updateClaimedAffiliateRebateAudit(ctx context.Context, client *dbent.Client, orderID int64, action string, detail map[string]any) error {
	if client == nil {
		return errors.New("nil payment client")
	}
	oid := strconv.FormatInt(orderID, 10)
	detailJSON, _ := json.Marshal(detail)
	updated, err := client.PaymentAuditLog.Update().
		Where(
			paymentauditlog.OrderIDEQ(oid),
			paymentauditlog.ActionEQ("AFFILIATE_REBATE_APPLIED"),
		).
		SetAction(action).
		SetDetail(string(detailJSON)).
		SetOperator("system").
		Save(ctx)
	if err != nil {
		return err
	}
	if updated == 0 {
		return errors.New("affiliate rebate claim log not found")
	}
	return nil
}

func (s *PaymentService) markFailed(ctx context.Context, oid int64, lease *paymentFulfillmentLease, cause error) {
	if lease == nil {
		slog.Error("mark FAILED without fulfillment lease", "orderID", oid)
		return
	}
	now := time.Now()
	r := psErrMsg(cause)
	// The lease version prevents a stale worker from overwriting a newer owner.
	c, e := s.entClient.PaymentOrder.Update().
		Where(
			paymentorder.IDEQ(oid),
			paymentorder.StatusEQ(OrderStatusRecharging),
			paymentorder.UpdatedAtEQ(lease.version),
		).
		SetStatus(OrderStatusFailed).SetFailedAt(now).SetFailedReason(r).Save(ctx)
	if e != nil {
		slog.Error("mark FAILED", "orderID", oid, "error", e)
	}
	if c > 0 {
		s.writeAuditLog(ctx, oid, "FULFILLMENT_FAILED", "system", map[string]any{"reason": r})
	}
}

func (s *PaymentService) RetryFulfillment(ctx context.Context, oid int64) error {
	o, err := s.entClient.PaymentOrder.Get(ctx, oid)
	if err != nil {
		return infraerrors.NotFound("NOT_FOUND", "order not found")
	}
	if o.PaidAt == nil {
		return infraerrors.BadRequest("INVALID_STATUS", "order is not paid")
	}
	if psIsRefundStatus(o.Status) {
		return infraerrors.BadRequest("INVALID_STATUS", "refund-related order cannot retry")
	}
	if o.Status == OrderStatusCompleted {
		return infraerrors.BadRequest("INVALID_STATUS", "order already completed")
	}
	if o.Status != OrderStatusFailed && o.Status != OrderStatusPaid && o.Status != OrderStatusRecharging {
		return infraerrors.BadRequest("INVALID_STATUS", "only paid, failed, and recoverable recharging orders can retry")
	}
	if !isSupportedPaymentOrderType(o.OrderType) {
		return infraerrors.BadRequest("INVALID_ORDER_TYPE", "unsupported order type")
	}
	s.writeAuditLog(ctx, oid, "RECHARGE_RETRY", "admin", map[string]any{"detail": "admin manual retry"})
	return s.executeFulfillment(ctx, oid)
}
