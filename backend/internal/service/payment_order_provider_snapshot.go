package service

import (
	"context"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	dbent "github.com/Wei-Shaw/sub2api/ent"
	"github.com/Wei-Shaw/sub2api/internal/payment"
)

type paymentOrderProviderSnapshot struct {
	SchemaVersion       int
	ProviderInstanceID  string
	ProviderKey         string
	PaymentMode         string
	MerchantAppID       string
	MerchantID          string
	Currency            string
	Asset               string
	RequestedNetwork    string
	GraceMinutes        int
	GraceMinutesSet     bool
	AutoCreditDeadline  time.Time
	QuoteSource         string
	USDTPerUnit         float64
	QuoteFetchedAt      time.Time
	QuoteExpiresAt      time.Time
	GatewayExpectedUSDT float64
}

func psOrderProviderSnapshot(order *dbent.PaymentOrder) *paymentOrderProviderSnapshot {
	if order == nil || len(order.ProviderSnapshot) == 0 {
		return nil
	}

	snapshot := &paymentOrderProviderSnapshot{
		SchemaVersion:       psSnapshotIntValue(order.ProviderSnapshot["schema_version"]),
		ProviderInstanceID:  psSnapshotStringValue(order.ProviderSnapshot["provider_instance_id"]),
		ProviderKey:         psSnapshotStringValue(order.ProviderSnapshot["provider_key"]),
		PaymentMode:         psSnapshotStringValue(order.ProviderSnapshot["payment_mode"]),
		MerchantAppID:       psSnapshotStringValue(order.ProviderSnapshot["merchant_app_id"]),
		MerchantID:          psSnapshotStringValue(order.ProviderSnapshot["merchant_id"]),
		Currency:            psSnapshotStringValue(order.ProviderSnapshot["currency"]),
		Asset:               psSnapshotStringValue(order.ProviderSnapshot["asset"]),
		RequestedNetwork:    psSnapshotStringValue(order.ProviderSnapshot["requested_network"]),
		GraceMinutes:        psSnapshotIntValue(order.ProviderSnapshot["grace_minutes"]),
		GraceMinutesSet:     hasPaymentOrderSnapshotKey(order.ProviderSnapshot, "grace_minutes"),
		AutoCreditDeadline:  psSnapshotTimeValue(order.ProviderSnapshot["auto_credit_deadline"]),
		QuoteSource:         psSnapshotStringValue(order.ProviderSnapshot["quote_source"]),
		USDTPerUnit:         psSnapshotFloatValue(order.ProviderSnapshot["usdt_per_unit"]),
		QuoteFetchedAt:      psSnapshotTimeValue(order.ProviderSnapshot["fetched_at"]),
		QuoteExpiresAt:      psSnapshotTimeValue(order.ProviderSnapshot["expires_at"]),
		GatewayExpectedUSDT: psSnapshotFloatValue(order.ProviderSnapshot["gateway_expected_usdt"]),
	}
	if snapshot.SchemaVersion == 0 &&
		snapshot.ProviderInstanceID == "" &&
		snapshot.ProviderKey == "" &&
		snapshot.PaymentMode == "" &&
		snapshot.MerchantAppID == "" &&
		snapshot.MerchantID == "" &&
		snapshot.Currency == "" &&
		snapshot.Asset == "" &&
		snapshot.RequestedNetwork == "" &&
		!snapshot.GraceMinutesSet &&
		snapshot.AutoCreditDeadline.IsZero() &&
		snapshot.QuoteSource == "" &&
		snapshot.USDTPerUnit == 0 &&
		snapshot.QuoteFetchedAt.IsZero() &&
		snapshot.QuoteExpiresAt.IsZero() &&
		snapshot.GatewayExpectedUSDT == 0 {
		return nil
	}
	return snapshot
}

func psSnapshotFloatValue(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err == nil {
			return parsed
		}
	}
	return 0
}

func clonePaymentOrderSnapshot(snapshot map[string]any) map[string]any {
	if len(snapshot) == 0 {
		return nil
	}
	clone := make(map[string]any, len(snapshot))
	for key, value := range snapshot {
		clone[key] = value
	}
	return clone
}

func hasPaymentOrderSnapshotKey(snapshot map[string]any, key string) bool {
	_, ok := snapshot[key]
	return ok
}

func psSnapshotStringValue(value any) string {
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	default:
		return ""
	}
}

func psSnapshotTimeValue(value any) time.Time {
	text := psSnapshotStringValue(value)
	if text == "" {
		return time.Time{}
	}
	parsed, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return time.Time{}
	}
	return parsed
}

func psSnapshotIntValue(value any) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int32:
		return int(typed)
	case int64:
		return int(typed)
	case float32:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		n, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil {
			return n
		}
	}
	return 0
}

func effectiveEpusdtAutoCreditDeadline(order *dbent.PaymentOrder, snapshot *paymentOrderProviderSnapshot) (time.Time, bool) {
	if order == nil || snapshot == nil {
		return time.Time{}, false
	}
	if !snapshot.AutoCreditDeadline.IsZero() {
		return snapshot.AutoCreditDeadline, true
	}
	if snapshot.GraceMinutesSet {
		graceMinutes := snapshot.GraceMinutes
		if graceMinutes < 0 {
			graceMinutes = 0
		}
		return order.ExpiresAt.Add(time.Duration(graceMinutes) * time.Minute), true
	}
	return order.ExpiresAt.Add(30 * time.Minute), true
}
func freezeEpusdtAutoCreditDeadline(order *dbent.PaymentOrder, finalStatus string, now time.Time) map[string]any {
	if order == nil || payment.GetBasePaymentType(order.PaymentType) != payment.TypeEpusdt || len(order.ProviderSnapshot) == 0 {
		return nil
	}
	snapshot := make(map[string]any, len(order.ProviderSnapshot))
	for key, value := range order.ProviderSnapshot {
		snapshot[key] = value
	}
	parsed := psOrderProviderSnapshot(order)
	if parsed == nil {
		return nil
	}
	graceMinutes := parsed.GraceMinutes
	if !parsed.GraceMinutesSet {
		graceMinutes = 30
	}
	if graceMinutes < 0 {
		graceMinutes = 0
	}
	base := now
	if finalStatus == OrderStatusExpired {
		base = order.ExpiresAt
	}
	candidate := base.Add(time.Duration(graceMinutes) * time.Minute)
	if parsed.AutoCreditDeadline.IsZero() || candidate.Before(parsed.AutoCreditDeadline) {
		snapshot["auto_credit_deadline"] = candidate.UTC().Format(time.RFC3339Nano)
	}
	return snapshot
}

func (s *PaymentService) resolveSnapshotOrderProviderInstance(ctx context.Context, order *dbent.PaymentOrder, snapshot *paymentOrderProviderSnapshot) (*dbent.PaymentProviderInstance, error) {
	if s == nil || s.entClient == nil || order == nil || snapshot == nil {
		return nil, nil
	}

	snapshotInstanceID := strings.TrimSpace(snapshot.ProviderInstanceID)
	columnInstanceID := strings.TrimSpace(psStringValue(order.ProviderInstanceID))
	if snapshotInstanceID == "" {
		snapshotInstanceID = columnInstanceID
	}
	if snapshotInstanceID == "" {
		return nil, fmt.Errorf("order %d provider snapshot is missing provider_instance_id", order.ID)
	}
	if columnInstanceID != "" && snapshot.ProviderInstanceID != "" && !strings.EqualFold(columnInstanceID, snapshot.ProviderInstanceID) {
		return nil, fmt.Errorf("order %d provider snapshot instance mismatch: snapshot=%s order=%s", order.ID, snapshot.ProviderInstanceID, columnInstanceID)
	}

	instID, err := strconv.ParseInt(snapshotInstanceID, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("order %d provider snapshot instance id is invalid: %s", order.ID, snapshotInstanceID)
	}

	inst, err := s.entClient.PaymentProviderInstance.Get(ctx, instID)
	if err != nil {
		if dbent.IsNotFound(err) {
			return nil, fmt.Errorf("order %d provider snapshot instance %s is missing", order.ID, snapshotInstanceID)
		}
		return nil, err
	}

	if snapshot.ProviderKey != "" && !strings.EqualFold(strings.TrimSpace(inst.ProviderKey), snapshot.ProviderKey) {
		return nil, fmt.Errorf("order %d provider snapshot key mismatch: snapshot=%s instance=%s", order.ID, snapshot.ProviderKey, inst.ProviderKey)
	}

	return inst, nil
}

func expectedNotificationProviderKeyForOrder(registry *payment.Registry, order *dbent.PaymentOrder, instanceProviderKey string) string {
	if order == nil {
		return strings.TrimSpace(instanceProviderKey)
	}

	orderProviderKey := psStringValue(order.ProviderKey)
	if snapshot := psOrderProviderSnapshot(order); snapshot != nil && snapshot.ProviderKey != "" {
		orderProviderKey = snapshot.ProviderKey
	}

	return expectedNotificationProviderKey(registry, order.PaymentType, orderProviderKey, instanceProviderKey)
}

func validateProviderSnapshotMetadata(order *dbent.PaymentOrder, providerKey string, metadata map[string]string) error {
	if order == nil || len(metadata) == 0 {
		return nil
	}

	snapshot := psOrderProviderSnapshot(order)
	if snapshot == nil {
		return nil
	}

	switch strings.TrimSpace(providerKey) {
	case payment.TypeWxpay:
		if expected := strings.TrimSpace(snapshot.MerchantAppID); expected != "" {
			actual := strings.TrimSpace(metadata["appid"])
			if actual == "" {
				return fmt.Errorf("wxpay notification missing appid")
			}
			if !strings.EqualFold(expected, actual) {
				return fmt.Errorf("wxpay appid mismatch: expected %s, got %s", expected, actual)
			}
		}
		if expected := strings.TrimSpace(snapshot.MerchantID); expected != "" {
			actual := strings.TrimSpace(metadata["mchid"])
			if actual == "" {
				return fmt.Errorf("wxpay notification missing mchid")
			}
			if !strings.EqualFold(expected, actual) {
				return fmt.Errorf("wxpay mchid mismatch: expected %s, got %s", expected, actual)
			}
		}
		if expected := strings.TrimSpace(snapshot.Currency); expected != "" {
			actual := strings.ToUpper(strings.TrimSpace(metadata["currency"]))
			if actual == "" {
				return fmt.Errorf("wxpay notification missing currency")
			}
			if !strings.EqualFold(expected, actual) {
				return fmt.Errorf("wxpay currency mismatch: expected %s, got %s", expected, actual)
			}
		}
		if actual := strings.TrimSpace(metadata["trade_state"]); actual != "" && !strings.EqualFold(actual, "SUCCESS") {
			return fmt.Errorf("wxpay trade_state mismatch: expected SUCCESS, got %s", actual)
		}
	case payment.TypeAlipay:
		if expected := strings.TrimSpace(snapshot.MerchantAppID); expected != "" {
			actual := strings.TrimSpace(metadata["app_id"])
			if actual == "" {
				return fmt.Errorf("alipay app_id missing")
			}
			if !strings.EqualFold(expected, actual) {
				return fmt.Errorf("alipay app_id mismatch: expected %s, got %s", expected, actual)
			}
		}
	case payment.TypeEasyPay:
		if expected := strings.TrimSpace(snapshot.MerchantID); expected != "" {
			actual := strings.TrimSpace(metadata["pid"])
			if actual == "" {
				return fmt.Errorf("easypay pid missing")
			}
			if !strings.EqualFold(expected, actual) {
				return fmt.Errorf("easypay pid mismatch: expected %s, got %s", expected, actual)
			}
		}
	case payment.TypeStripe:
		if expected := strings.TrimSpace(snapshot.Currency); expected != "" {
			actual := strings.ToUpper(strings.TrimSpace(metadata["currency"]))
			if actual == "" {
				return fmt.Errorf("stripe notification missing currency")
			}
			if !strings.EqualFold(expected, actual) {
				return fmt.Errorf("stripe currency mismatch: expected %s, got %s", expected, actual)
			}
		}
	case payment.TypeEpusdt:
		if actual := strings.TrimSpace(metadata["pid"]); actual == "" {
			return fmt.Errorf("epusdt notification missing pid")
		} else if expected := strings.TrimSpace(snapshot.MerchantID); expected != "" && !strings.EqualFold(expected, actual) {
			return fmt.Errorf("epusdt pid mismatch: expected %s, got %s", expected, actual)
		}
		if actual := strings.TrimSpace(metadata["token"]); !strings.EqualFold(actual, "USDT") {
			return fmt.Errorf("epusdt notification token mismatch: expected USDT, got %s", actual)
		}
		if actual := strings.TrimSpace(metadata["actual_amount"]); actual == "" {
			return fmt.Errorf("epusdt notification missing actual amount")
		} else if amount, err := strconv.ParseFloat(actual, 64); err != nil || amount <= 0 || math.IsNaN(amount) || math.IsInf(amount, 0) {
			return fmt.Errorf("epusdt notification actual amount is invalid")
		}
		if actual := strings.TrimSpace(metadata["block_transaction_id"]); actual == "" {
			return fmt.Errorf("epusdt notification missing blockchain transaction")
		}
	case payment.TypeAirwallex:
		if expected := strings.TrimSpace(snapshot.MerchantID); expected != "" {
			actual := strings.TrimSpace(metadata["account_id"])
			if actual == "" {
				return fmt.Errorf("airwallex account_id missing")
			}
			if !strings.EqualFold(expected, actual) {
				return fmt.Errorf("airwallex account_id mismatch: expected %s, got %s", expected, actual)
			}
		}
		if expected := strings.TrimSpace(snapshot.Currency); expected != "" {
			actual := strings.ToUpper(strings.TrimSpace(metadata["currency"]))
			if actual == "" {
				return fmt.Errorf("airwallex notification missing currency")
			}
			if !strings.EqualFold(expected, actual) {
				return fmt.Errorf("airwallex currency mismatch: expected %s, got %s", expected, actual)
			}
		}
		if actual := strings.TrimSpace(metadata["status"]); actual != "" && !strings.EqualFold(actual, "SUCCEEDED") {
			return fmt.Errorf("airwallex status mismatch: expected SUCCEEDED, got %s", actual)
		}
	}

	return nil
}

func providerMerchantIdentityMetadata(prov payment.Provider) map[string]string {
	if prov == nil {
		return nil
	}
	reporter, ok := prov.(payment.MerchantIdentityProvider)
	if !ok {
		return nil
	}
	return reporter.MerchantIdentityMetadata()
}
