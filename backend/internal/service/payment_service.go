package service

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"entgo.io/ent/dialect"
	"entgo.io/ent/dialect/sql"
	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/ent/paymentauditlog"
	"github.com/Wei-Shaw/sub2api/ent/paymentorder"
	"github.com/Wei-Shaw/sub2api/ent/paymentproviderinstance"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	"github.com/Wei-Shaw/sub2api/internal/payment/provider"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

// --- Order Status Constants ---

const (
	OrderStatusPending           = payment.OrderStatusPending
	OrderStatusPaid              = payment.OrderStatusPaid
	OrderStatusRecharging        = payment.OrderStatusRecharging
	OrderStatusCompleted         = payment.OrderStatusCompleted
	OrderStatusExpired           = payment.OrderStatusExpired
	OrderStatusCancelled         = payment.OrderStatusCancelled
	OrderStatusFailed            = payment.OrderStatusFailed
	OrderStatusRefundRequested   = payment.OrderStatusRefundRequested
	OrderStatusRefunding         = payment.OrderStatusRefunding
	OrderStatusRefundPending     = payment.OrderStatusRefundPending
	OrderStatusPartiallyRefunded = payment.OrderStatusPartiallyRefunded
	OrderStatusRefunded          = payment.OrderStatusRefunded
	OrderStatusRefundFailed      = payment.OrderStatusRefundFailed
)

const (
	// defaultMaxPendingOrders and defaultOrderTimeoutMin are defined in
	// payment_config_service.go alongside other payment configuration defaults.
	paymentGraceMinutes = 5

	defaultPageSize    = 20
	maxPageSize        = 100
	topUsersLimit      = 10
	amountToleranceCNY = 0.01

	orderIDPrefix = "sub2_"
)

const paymentResumeSigningKeyEnv = "PAYMENT_RESUME_SIGNING_KEY"

// --- Types ---

// generateOutTradeNo creates a unique external order ID for payment providers.
// Format: sub2_20250409aB3kX9mQ (prefix + date + 8-char random)
func generateOutTradeNo() string {
	date := time.Now().Format("20060102")
	rnd := generateRandomString(8)
	return orderIDPrefix + date + rnd
}

func generateRandomString(n int) string {
	const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = charset[rand.IntN(len(charset))]
	}
	return string(b)
}

type CreateOrderRequest struct {
	UserID                   int64
	Amount                   float64
	PaymentType              string
	OpenID                   string
	ClientIP                 string
	IsMobile                 bool
	IsWeChatBrowser          bool
	SrcHost                  string
	SrcURL                   string
	ReturnURL                string
	PaymentSource            string
	OrderType                string
	RequestedNetwork         string
	EpusdtBalanceMultiplier  float64
	EpusdtGraceMinutes       int
	EpusdtAutoCreditDeadline time.Time
	PlanID                   int64
	Locale                   string
}

type CreateOrderResponse struct {
	OrderID                       int64                           `json:"order_id"`
	Amount                        float64                         `json:"amount"`
	PayAmount                     float64                         `json:"pay_amount"`
	FeeRate                       float64                         `json:"fee_rate"`
	BonusAmount                   float64                         `json:"bonus_amount"`
	Status                        string                          `json:"status"`
	ResultType                    payment.CreatePaymentResultType `json:"result_type,omitempty"`
	PaymentType                   string                          `json:"payment_type"`
	OutTradeNo                    string                          `json:"out_trade_no,omitempty"`
	PayURL                        string                          `json:"pay_url,omitempty"`
	QRCode                        string                          `json:"qr_code,omitempty"`
	ClientSecret                  string                          `json:"client_secret,omitempty"`
	IntentID                      string                          `json:"intent_id,omitempty"`
	Currency                      string                          `json:"currency,omitempty"`
	CountryCode                   string                          `json:"country_code,omitempty"`
	PaymentEnv                    string                          `json:"payment_env,omitempty"`
	OAuth                         *payment.WechatOAuthInfo        `json:"oauth,omitempty"`
	JSAPI                         *payment.WechatJSAPIPayload     `json:"jsapi,omitempty"`
	JSAPIPayload                  *payment.WechatJSAPIPayload     `json:"jsapi_payload,omitempty"`
	ExpiresAt                     time.Time                       `json:"expires_at"`
	PaymentMode                   string                          `json:"payment_mode,omitempty"`
	ResumeToken                   string                          `json:"resume_token,omitempty"`
	AlipayMobilePrecreateDeepLink bool                            `json:"alipay_mobile_precreate_deep_link,omitempty"`
}

type OrderListParams struct {
	Page        int
	PageSize    int
	Status      string
	OrderType   string
	PaymentType string
	Keyword     string
}

const (
	PaymentManualReviewAction   = "PAYMENT_MANUAL_NETWORK_REVIEW"
	PaymentManualApprovedAction = "PAYMENT_MANUAL_REVIEW_APPROVED"
	PaymentManualRejectedAction = "PAYMENT_MANUAL_REVIEW_REJECTED"
)

type PaymentManualReview struct {
	OrderID          int64     `json:"order_id"`
	OutTradeNo       string    `json:"out_trade_no"`
	UserID           int64     `json:"user_id"`
	Amount           float64   `json:"amount"`
	PayAmount        float64   `json:"pay_amount"`
	Currency         string    `json:"currency"`
	RequestedNetwork string    `json:"requested_network"`
	TradeNo          string    `json:"trade_no"`
	Status           string    `json:"status"`
	Detail           string    `json:"detail"`
	CreatedAt        time.Time `json:"created_at"`
	Operator         string    `json:"operator"`
}

type PaymentManualReviewPage struct {
	Items    []PaymentManualReview `json:"items"`
	Total    int                   `json:"total"`
	Page     int                   `json:"page"`
	PageSize int                   `json:"page_size"`
}

type RefundPlan struct {
	OrderID         int64
	Order           *dbent.PaymentOrder
	RefundAmount    float64
	GatewayAmount   float64
	Reason          string
	Force           bool
	DeductBalance   bool
	DeductionType   string
	BalanceToDeduct float64
	SubDaysToDeduct int
	SubscriptionID  int64
	// deductionHeld 表示扣减已在进入 REFUND_PENDING 前执行并保留，终态收敛时不再重复扣减。
	deductionHeld bool
}

type RefundResult struct {
	Success         bool    `json:"success"`
	Warning         string  `json:"warning,omitempty"`
	RequireForce    bool    `json:"require_force,omitempty"`
	BalanceDeducted float64 `json:"balance_deducted,omitempty"`
	SubDaysDeducted int     `json:"subscription_days_deducted,omitempty"`
}

type DashboardStats struct {
	TodayAmount   CurrencyAmounts `json:"today_amount"`
	TotalAmount   CurrencyAmounts `json:"total_amount"`
	TodayCount    int             `json:"today_count"`
	TotalCount    int             `json:"total_count"`
	AvgAmount     CurrencyAmounts `json:"avg_amount"`
	PendingOrders int             `json:"pending_orders"`

	DailySeries    []DailyStats        `json:"daily_series"`
	PaymentMethods []PaymentMethodStat `json:"payment_methods"`
	TopUsers       TopUsersByCurrency  `json:"top_users"`
}

// CurrencyAmounts holds payment amounts keyed by their ISO 4217 currency.
// Amounts in different currencies must never be added together.
type CurrencyAmounts map[string]float64

type DailyStats struct {
	Date   string          `json:"date"`
	Amount CurrencyAmounts `json:"amount"`
	Count  int             `json:"count"`
}

type PaymentMethodStat struct {
	Type   string          `json:"type"`
	Amount CurrencyAmounts `json:"amount"`
	Count  int             `json:"count"`
}

type TopUserStat struct {
	UserID int64   `json:"user_id"`
	Email  string  `json:"email"`
	Amount float64 `json:"amount"`
}

// TopUsersByCurrency contains an independent ranked user list for each
// currency. A single cross-currency leaderboard would be misleading.
type TopUsersByCurrency map[string][]TopUserStat

// --- Service ---

type PaymentService struct {
	providerMu               sync.Mutex
	providersLoaded          bool
	entClient                *dbent.Client
	registry                 *payment.Registry
	loadBalancer             payment.LoadBalancer
	redeemService            *RedeemService
	subscriptionSvc          *SubscriptionService
	configService            *PaymentConfigService
	userRepo                 UserRepository
	groupRepo                GroupRepository
	resumeService            *PaymentResumeService
	affiliateService         *AffiliateService
	notificationEmailService *NotificationEmailService
}

func NewPaymentService(entClient *dbent.Client, registry *payment.Registry, loadBalancer payment.LoadBalancer, redeemService *RedeemService, subscriptionSvc *SubscriptionService, configService *PaymentConfigService, userRepo UserRepository, groupRepo GroupRepository, affiliateService *AffiliateService) *PaymentService {
	svc := &PaymentService{entClient: entClient, registry: registry, loadBalancer: newVisibleMethodLoadBalancer(loadBalancer, configService), redeemService: redeemService, subscriptionSvc: subscriptionSvc, configService: configService, userRepo: userRepo, groupRepo: groupRepo, affiliateService: affiliateService}
	svc.resumeService = psNewPaymentResumeService(configService)
	return svc
}

func (s *PaymentService) SetNotificationEmailService(notificationEmailService *NotificationEmailService) {
	s.notificationEmailService = notificationEmailService
}

// --- Provider Registry ---

// EnsureProviders lazily initializes the provider registry on first call.
func (s *PaymentService) EnsureProviders(ctx context.Context) {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	if !s.providersLoaded {
		s.loadProviders(ctx)
		s.providersLoaded = true
	}
}

// RefreshProviders clears and re-registers all providers from the database.
func (s *PaymentService) RefreshProviders(ctx context.Context) {
	s.providerMu.Lock()
	defer s.providerMu.Unlock()
	s.registry.Clear()
	s.loadProviders(ctx)
	s.providersLoaded = true
}

func (s *PaymentService) loadProviders(ctx context.Context) {
	instances, err := s.entClient.PaymentProviderInstance.Query().
		Where(paymentproviderinstance.EnabledEQ(true)).
		All(ctx)
	if err != nil {
		slog.Error("[PaymentService] failed to query provider instances", "error", err)
		return
	}
	for _, inst := range instances {
		cfg, err := s.loadBalancer.GetInstanceConfig(ctx, int64(inst.ID))
		if err != nil {
			slog.Warn("[PaymentService] failed to decrypt config for instance", "instanceID", inst.ID, "error", err)
			continue
		}
		if inst.PaymentMode != "" {
			cfg["paymentMode"] = inst.PaymentMode
		}
		instID := fmt.Sprintf("%d", inst.ID)
		p, err := provider.CreateProvider(inst.ProviderKey, instID, cfg)
		if err != nil {
			slog.Warn("[PaymentService] failed to create provider for instance", "instanceID", inst.ID, "key", inst.ProviderKey, "error", err)
			continue
		}
		s.registry.Register(p)
	}
}

// --- Helpers ---

func psIsRefundStatus(s string) bool {
	switch s {
	case OrderStatusRefundRequested, OrderStatusRefunding, OrderStatusRefundPending, OrderStatusPartiallyRefunded, OrderStatusRefunded, OrderStatusRefundFailed:
		return true
	}
	return false
}

func psErrMsg(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func psNilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func (s *PaymentService) paymentResume() *PaymentResumeService {
	if s.resumeService != nil {
		return s.resumeService
	}
	return psNewPaymentResumeService(s.configService)
}

func NewLegacyAwarePaymentResumeService(legacyKey []byte) *PaymentResumeService {
	return newLegacyAwarePaymentResumeService(legacyKey)
}

func psNewPaymentResumeService(configService *PaymentConfigService) *PaymentResumeService {
	return newLegacyAwarePaymentResumeService(psResumeLegacyVerificationKey(configService))
}

func newLegacyAwarePaymentResumeService(legacyKey []byte) *PaymentResumeService {
	signingKey, verifyFallbacks := resolvePaymentResumeSigningKeys(legacyKey)
	return NewPaymentResumeService(signingKey, verifyFallbacks...)
}

func psResumeLegacyVerificationKey(configService *PaymentConfigService) []byte {
	if configService == nil {
		return nil
	}
	return configService.encryptionKey
}

func resolvePaymentResumeSigningKeys(legacyKey []byte) ([]byte, [][]byte) {
	signingKey := parsePaymentResumeSigningKey(os.Getenv(paymentResumeSigningKeyEnv))
	if len(signingKey) == 0 {
		if len(legacyKey) == 0 {
			return nil, nil
		}
		return legacyKey, nil
	}
	if len(legacyKey) == 0 || bytes.Equal(legacyKey, signingKey) {
		return signingKey, nil
	}
	return signingKey, [][]byte{legacyKey}
}

func parsePaymentResumeSigningKey(raw string) []byte {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if len(raw) >= 64 && len(raw)%2 == 0 {
		if decoded, err := hex.DecodeString(raw); err == nil && len(decoded) > 0 {
			return decoded
		}
	}
	return []byte(raw)
}

func psSliceContains(sl []string, s string) bool {
	for _, v := range sl {
		if v == s {
			return true
		}
	}
	return false
}

// Subscription validity period unit constants.
const (
	validityUnitWeek   = "week"
	validityUnitWeeks  = "weeks"
	validityUnitMonth  = "month"
	validityUnitMonths = "months"
)

func psComputeValidityDays(days int, unit string) int {
	switch unit {
	case validityUnitWeek, validityUnitWeeks:
		return days * 7
	case validityUnitMonth, validityUnitMonths:
		return days * 30
	default:
		return days
	}
}

func psStartOfDayUTC(t time.Time) time.Time {
	y, m, d := t.UTC().Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func applyPagination(pageSize, page int) (size, pg int) {
	size = pageSize
	if size <= 0 {
		size = defaultPageSize
	}
	if size > maxPageSize {
		size = maxPageSize
	}
	pg = page
	if pg < 1 {
		pg = 1
	}
	return size, pg
}

func (s *PaymentService) ListPaymentManualReviews(ctx context.Context, page, pageSize int) (*PaymentManualReviewPage, error) {
	size, pg := applyPagination(pageSize, page)
	logs, err := s.entClient.PaymentAuditLog.Query().Where(paymentauditlog.ActionEQ(PaymentManualReviewAction)).Order(paymentauditlog.ByCreatedAt(sql.OrderDesc())).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("list payment manual reviews: %w", err)
	}
	items := make([]PaymentManualReview, 0, len(logs))
	seen := make(map[string]bool)
	for _, log := range logs {
		if seen[log.OrderID] {
			continue
		}
		seen[log.OrderID] = true
		decisions, queryErr := s.entClient.PaymentAuditLog.Query().Where(paymentauditlog.OrderIDEQ(log.OrderID), paymentauditlog.ActionIn(PaymentManualApprovedAction, PaymentManualRejectedAction)).Limit(1).All(ctx)
		if queryErr != nil {
			return nil, queryErr
		}
		if len(decisions) != 0 {
			continue
		}
		oid, parseErr := strconv.ParseInt(log.OrderID, 10, 64)
		if parseErr != nil {
			continue
		}
		o, getErr := s.entClient.PaymentOrder.Get(ctx, oid)
		if getErr != nil {
			continue
		}
		items = append(items, PaymentManualReview{
			OrderID:          o.ID,
			OutTradeNo:       o.OutTradeNo,
			UserID:           o.UserID,
			Amount:           o.Amount,
			PayAmount:        o.PayAmount,
			Currency:         PaymentOrderCurrency(o),
			RequestedNetwork: manualReviewRequestedNetwork(o),
			TradeNo:          manualReviewTradeNo(log.Detail),
			Status:           o.Status,
			Detail:           log.Detail,
			CreatedAt:        log.CreatedAt,
			Operator:         log.Operator,
		})
	}
	total := len(items)
	start := (pg - 1) * size
	if start > total {
		start = total
	}
	end := start + size
	if end > total {
		end = total
	}
	return &PaymentManualReviewPage{Items: items[start:end], Total: total, Page: pg, PageSize: size}, nil
}

func (s *PaymentService) ApprovePaymentManualReview(ctx context.Context, orderID int64, operator, note string) error {
	note = strings.TrimSpace(note)
	if note == "" {
		return infraerrors.BadRequest("REVIEW_NOTE_REQUIRED", "approval note is required")
	}

	tx, err := s.entClient.Tx(ctx)
	if err != nil {
		return fmt.Errorf("begin approve manual payment review: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	txCtx := dbent.NewTxContext(ctx, tx)
	client := tx.Client()
	o, err := paymentOrderForManualReviewUpdate(txCtx, tx, orderID)
	if err != nil {
		if dbent.IsNotFound(err) {
			return infraerrors.NotFound("NOT_FOUND", "order not found")
		}
		return fmt.Errorf("load manual payment review order: %w", err)
	}
	if payment.GetBasePaymentType(o.PaymentType) != payment.TypeEpusdt {
		return infraerrors.BadRequest("INVALID_PROVIDER", "manual review is only available for USDT orders")
	}
	decision, checkErr := manualReviewDecisionWithClient(txCtx, client, orderID)
	if checkErr != nil {
		return checkErr
	}
	if decision == PaymentManualApprovedAction {
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("commit existing approved manual payment review: %w", err)
		}
		return s.executeFulfillment(ctx, orderID)
	}
	if decision != "" {
		return nil
	}
	review, reviewErr := latestManualReviewWithClient(txCtx, client, orderID)
	if reviewErr != nil {
		return reviewErr
	}
	tradeNo := manualReviewTradeNo(review.Detail)
	if tradeNo == "" {
		return infraerrors.BadRequest("MANUAL_REVIEW_EVIDENCE_MISSING", "manual review has no upstream trade")
	}
	evidenceAmount, evidenceAmountErr := manualReviewAmount(review.Detail)
	if evidenceAmountErr != nil || !isValidProviderAmount(evidenceAmount) || math.Abs(evidenceAmount-o.PayAmount) > paymentAmountToleranceForCurrency("USD") {
		return infraerrors.BadRequest("MANUAL_REVIEW_AMOUNT_MISMATCH", "manual review evidence amount does not match the order")
	}
	evidenceActualAmount, evidenceActualAmountErr := manualReviewActualAmount(review.Detail)
	if evidenceActualAmountErr != nil || !isValidProviderAmount(evidenceActualAmount) {
		return infraerrors.BadRequest("MANUAL_REVIEW_EVIDENCE_MISSING", "manual review has no valid actual amount evidence")
	}
	evidenceBlock := manualReviewBlockTransactionID(review.Detail)
	blockID, blockErr := normalizeEpusdtBlockTransactionID(evidenceBlock)
	if blockErr != nil {
		return infraerrors.BadRequest("MANUAL_REVIEW_EVIDENCE_MISSING", "manual review has no valid blockchain transaction")
	}
	claimedOrderID, claimErr := claimEpusdtBlockTransaction(txCtx, client, blockID, orderID, tradeNo, evidenceAmount, evidenceActualAmount)
	if claimErr != nil {
		return fmt.Errorf("approve manual payment review: claim blockchain transaction: %w", claimErr)
	}
	if claimedOrderID != orderID {
		return infraerrors.Conflict("MANUAL_REVIEW_TRADE_REUSED", "blockchain transaction is already bound to another order")
	}
	if existing, queryErr := client.PaymentOrder.Query().Where(paymentorder.PaymentTypeEQ(payment.TypeEpusdt), paymentorder.PaymentTradeNoEQ(tradeNo), paymentorder.IDNEQ(orderID)).Exist(txCtx); queryErr != nil {
		return queryErr
	} else if existing {
		return infraerrors.Conflict("MANUAL_REVIEW_TRADE_REUSED", "upstream trade is already bound to another order")
	}
	update := client.PaymentOrder.Update().Where(
		paymentorder.IDEQ(orderID),
		paymentorder.StatusIn(OrderStatusPending, OrderStatusCancelled, OrderStatusExpired),
	).SetStatus(OrderStatusPaid).SetPayAmount(o.PayAmount).SetPaidAt(time.Now())
	if strings.TrimSpace(o.PaymentTradeNo) == "" {
		update.SetPaymentTradeNo(tradeNo)
	}
	updated, err := update.Save(txCtx)
	if err != nil {
		return fmt.Errorf("approve manual payment review: %w", err)
	}
	if updated == 0 {
		return infraerrors.Conflict("MANUAL_REVIEW_STATE_CHANGED", "order is no longer awaiting manual review")
	}
	if err := writePaymentAuditLogErr(txCtx, client, orderID, PaymentManualApprovedAction, operator, map[string]any{"note": note, "amount": o.PayAmount, "tradeNo": tradeNo}); err != nil {
		return fmt.Errorf("approve manual payment review: write audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit approved manual payment review: %w", err)
	}
	return s.executeFulfillment(ctx, orderID)
}

func (s *PaymentService) RejectPaymentManualReview(ctx context.Context, orderID int64, operator, note string) error {
	note = strings.TrimSpace(note)
	if note == "" {
		return infraerrors.BadRequest("REVIEW_NOTE_REQUIRED", "rejection note is required")
	}

	tx, err := s.entClient.Tx(ctx)
	if err != nil {
		return fmt.Errorf("begin reject manual payment review: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	txCtx := dbent.NewTxContext(ctx, tx)
	client := tx.Client()
	o, err := paymentOrderForManualReviewUpdate(txCtx, tx, orderID)
	if err != nil {
		if dbent.IsNotFound(err) {
			return infraerrors.NotFound("NOT_FOUND", "order not found")
		}
		return fmt.Errorf("load manual payment review order: %w", err)
	}
	if payment.GetBasePaymentType(o.PaymentType) != payment.TypeEpusdt {
		return infraerrors.BadRequest("INVALID_PROVIDER", "manual review is only available for USDT orders")
	}
	decision, checkErr := manualReviewDecisionWithClient(txCtx, client, orderID)
	if checkErr != nil {
		return checkErr
	}
	if decision != "" {
		return nil
	}
	if _, reviewErr := latestManualReviewWithClient(txCtx, client, orderID); reviewErr != nil {
		return reviewErr
	}
	updated, err := client.PaymentOrder.Update().Where(paymentorder.IDEQ(orderID), paymentorder.StatusIn(OrderStatusPending, OrderStatusCancelled, OrderStatusExpired)).SetStatus(OrderStatusFailed).SetFailedAt(time.Now()).SetFailedReason("manual payment review rejected").Save(txCtx)
	if err != nil {
		return fmt.Errorf("reject manual payment review: %w", err)
	}
	if updated == 0 {
		return infraerrors.Conflict("MANUAL_REVIEW_STATE_CHANGED", "order is no longer awaiting manual review")
	}
	if err := writePaymentAuditLogErr(txCtx, client, orderID, PaymentManualRejectedAction, operator, map[string]any{"note": note}); err != nil {
		return fmt.Errorf("reject manual payment review: write audit: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit rejected manual payment review: %w", err)
	}
	return nil
}

func paymentOrderForManualReviewUpdate(ctx context.Context, tx *dbent.Tx, orderID int64) (*dbent.PaymentOrder, error) {
	query := tx.Client().PaymentOrder.Query().Where(paymentorder.IDEQ(orderID))
	if tx.Client().Driver().Dialect() != dialect.SQLite {
		return query.ForUpdate().Only(ctx)
	}
	return query.Only(ctx)
}

func latestManualReviewWithClient(ctx context.Context, client *dbent.Client, orderID int64) (*dbent.PaymentAuditLog, error) {
	log, err := client.PaymentAuditLog.Query().Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(orderID, 10)), paymentauditlog.ActionEQ(PaymentManualReviewAction)).Order(paymentauditlog.ByCreatedAt(sql.OrderDesc())).Limit(1).Only(ctx)
	if err != nil {
		if dbent.IsNotFound(err) {
			return nil, infraerrors.NotFound("MANUAL_REVIEW_NOT_FOUND", "no pending manual review for this order")
		}
		return nil, err
	}
	return log, nil
}

func manualReviewDecisionWithClient(ctx context.Context, client *dbent.Client, orderID int64) (string, error) {
	decision, err := client.PaymentAuditLog.Query().
		Where(paymentauditlog.OrderIDEQ(strconv.FormatInt(orderID, 10)), paymentauditlog.ActionIn(PaymentManualApprovedAction, PaymentManualRejectedAction)).
		Order(paymentauditlog.ByCreatedAt(sql.OrderDesc())).
		First(ctx)
	if err != nil {
		if dbent.IsNotFound(err) {
			return "", nil
		}
		return "", err
	}
	return decision.Action, nil
}

func manualReviewRequestedNetwork(order *dbent.PaymentOrder) string {
	if snap := psOrderProviderSnapshot(order); snap != nil {
		return snap.RequestedNetwork
	}
	return ""
}

func manualReviewTradeNo(detail string) string {
	var value map[string]any
	if json.Unmarshal([]byte(detail), &value) == nil {
		if trade, ok := value["tradeNo"].(string); ok {
			return trade
		}
	}
	return ""
}

func manualReviewAmount(detail string) (float64, error) {
	var value map[string]any
	if err := json.Unmarshal([]byte(detail), &value); err != nil {
		return 0, err
	}
	switch amount := value["amount"].(type) {
	case float64:
		return amount, nil
	case string:
		return strconv.ParseFloat(strings.TrimSpace(amount), 64)
	case json.Number:
		return amount.Float64()
	default:
		return 0, fmt.Errorf("manual review amount is missing")
	}
}

func manualReviewActualAmount(detail string) (float64, error) {
	var value map[string]any
	if err := json.Unmarshal([]byte(detail), &value); err != nil {
		return 0, err
	}
	switch amount := value["actualAmount"].(type) {
	case float64:
		return amount, nil
	case string:
		return strconv.ParseFloat(strings.TrimSpace(amount), 64)
	case json.Number:
		return amount.Float64()
	default:
		return 0, fmt.Errorf("manual review actual amount is missing")
	}
}
