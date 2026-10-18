package service

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/Wei-Shaw/sub2api/ent/paymentproviderinstance"
	"github.com/Wei-Shaw/sub2api/internal/payment"
	infraerrors "github.com/Wei-Shaw/sub2api/internal/pkg/errors"
)

const (
	epusdtRatePath        = "/rates/cny.json"
	epusdtRateMaxBody     = 64 << 10
	epusdtRateHTTPTimeout = 5 * time.Second
)

// EpusdtRateQuote is the validated quote used by the checkout and order paths.
type EpusdtRateQuote struct {
	Currency    string    `json:"currency"`
	Asset       string    `json:"asset"`
	USDTPerUnit float64   `json:"usdt_per_unit"`
	Source      string    `json:"source"`
	FetchedAt   time.Time `json:"fetched_at"`
	ExpiresAt   time.Time `json:"expires_at"`
	TradeType   string    `json:"trade_type"`
}

type epusdtRateDocument struct {
	CNY        *epusdtRateCNY `json:"cny"`
	Source     *string        `json:"source"`
	TradeType  *string        `json:"trade_type"`
	CNYPerUSDT *float64       `json:"cny_per_usdt"`
	FetchedAt  *string        `json:"fetched_at"`
	ExpiresAt  *string        `json:"expires_at"`
}

type epusdtRateCNY struct {
	USDT *float64 `json:"usdt"`
}

// GetEpusdtRate returns the current quote for the selected enabled EPUSDT
// instance. USD instances retain the gateway's historical 1:1 quote.
func (s *PaymentConfigService) GetEpusdtRate(ctx context.Context) (*EpusdtRateQuote, error) {
	if s == nil || s.entClient == nil {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable")
	}
	instances, err := s.entClient.PaymentProviderInstance.Query().
		Where(paymentproviderinstance.EnabledEQ(true), paymentproviderinstance.ProviderKeyEQ(payment.TypeEpusdt)).
		Order(paymentproviderinstance.BySortOrder()).All(ctx)
	if err != nil {
		return nil, fmt.Errorf("query enabled EPUSDT providers: %w", err)
	}
	if len(instances) == 0 {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable")
	}
	cfg, err := s.decryptConfig(instances[0].Config)
	if err != nil {
		return nil, fmt.Errorf("decrypt EPUSDT config: %w", err)
	}
	return s.fetchEpusdtRate(ctx, cfg)
}

func (s *PaymentConfigService) fetchEpusdtRateForSelection(ctx context.Context, sel *payment.InstanceSelection) (*EpusdtRateQuote, error) {
	if sel == nil || payment.GetBasePaymentType(sel.ProviderKey) != payment.TypeEpusdt {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable")
	}
	return s.fetchEpusdtRate(ctx, sel.Config)
}

func (s *PaymentConfigService) fetchEpusdtRate(ctx context.Context, cfg map[string]string) (*EpusdtRateQuote, error) {
	now := time.Now().UTC()
	currency := paymentProviderConfigCurrency(payment.TypeEpusdt, cfg)
	if currency == "USD" {
		return &EpusdtRateQuote{
			Currency:    "USD",
			Asset:       "USDT",
			USDTPerUnit: 1,
			Source:      "gateway-usd-peg",
			FetchedAt:   now,
			ExpiresAt:   now.Add(5 * time.Minute),
			TradeType:   "PEG",
		}, nil
	}
	if currency != "CNY" {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable")
	}
	endpoint, err := epusdtRateURL(cfg)
	if err != nil {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable").WithMetadata(map[string]string{"reason": err.Error()})
	}
	client := &http.Client{}
	if s.rateHTTPClient != nil {
		*client = *s.rateHTTPClient
	}
	client.Timeout = epusdtRateHTTPTimeout
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error {
		return http.ErrUseLastResponse
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable")
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable")
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, epusdtRateMaxBody+1))
	if err != nil || len(body) > epusdtRateMaxBody || resp.StatusCode < http.StatusOK || resp.StatusCode >= http.StatusMultipleChoices {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable")
	}
	quote, err := parseEpusdtRateDocument(body, time.Now().UTC())
	if err != nil {
		return nil, infraerrors.ServiceUnavailable("EPUSDT_RATE_UNAVAILABLE", "EPUSDT rate is unavailable")
	}
	return quote, nil
}

func epusdtRateURL(cfg map[string]string) (string, error) {
	apiBase := strings.TrimSpace(providerConfigValue(cfg, "apiBase"))
	base, err := url.Parse(apiBase)
	if err != nil || base.Scheme != "https" || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return "", fmt.Errorf("apiBase must be HTTPS without credentials, query, or fragment")
	}
	rawRateAPI := strings.TrimSpace(providerConfigValue(cfg, "rateApi"))
	if rawRateAPI == "" {
		rawRateAPI = base.Scheme + "://" + base.Host + epusdtRatePath
	}
	rateURL, err := url.Parse(rawRateAPI)
	if err != nil || rateURL.Scheme != "https" || rateURL.Host == "" || rateURL.User != nil || rateURL.RawQuery != "" || rateURL.Fragment != "" {
		return "", fmt.Errorf("rateApi must be HTTPS without credentials, query, or fragment")
	}
	if !strings.EqualFold(rateURL.Host, base.Host) {
		return "", fmt.Errorf("rateApi host must match apiBase")
	}
	if strings.TrimRight(rateURL.Path, "/") != epusdtRatePath {
		return "", fmt.Errorf("rateApi path must be %s", epusdtRatePath)
	}
	rateURL.Path = epusdtRatePath
	rateURL.RawPath = ""
	return rateURL.String(), nil
}

func providerConfigValue(cfg map[string]string, want string) string {
	for key, value := range cfg {
		if strings.EqualFold(strings.TrimSpace(key), want) {
			return value
		}
	}
	return ""
}

func parseEpusdtRateDocument(data []byte, now time.Time) (*EpusdtRateQuote, error) {
	if len(data) == 0 || len(data) > epusdtRateMaxBody {
		return nil, fmt.Errorf("rate response is empty or too large")
	}
	if err := rejectDuplicateJSON(data); err != nil {
		return nil, err
	}
	var doc epusdtRateDocument
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&doc); err != nil {
		return nil, fmt.Errorf("decode rate response: %w", err)
	}
	if doc.CNY == nil || doc.CNY.USDT == nil || !finitePositive(*doc.CNY.USDT) {
		return nil, fmt.Errorf("cny.usdt must be positive")
	}
	if doc.Source == nil || *doc.Source != "binance-p2p" {
		return nil, fmt.Errorf("source must be binance-p2p")
	}
	if doc.TradeType == nil || strings.TrimSpace(*doc.TradeType) != "BUY" {
		return nil, fmt.Errorf("trade_type must be BUY")
	}
	if doc.CNYPerUSDT == nil || !finitePositive(*doc.CNYPerUSDT) {
		return nil, fmt.Errorf("cny_per_usdt must be positive")
	}
	if math.Abs(*doc.CNY.USDT**doc.CNYPerUSDT-1) > 1e-12 {
		return nil, fmt.Errorf("rate directions are inconsistent")
	}
	if doc.FetchedAt == nil || doc.ExpiresAt == nil {
		return nil, fmt.Errorf("fetched_at and expires_at are required")
	}
	fetchedAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*doc.FetchedAt))
	if err != nil {
		return nil, fmt.Errorf("fetched_at is invalid")
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(*doc.ExpiresAt))
	if err != nil {
		return nil, fmt.Errorf("expires_at is invalid")
	}
	now = now.UTC()
	if fetchedAt.After(now) {
		return nil, fmt.Errorf("fetched_at is in the future")
	}
	if !expiresAt.After(fetchedAt) || !expiresAt.After(now) || expiresAt.Sub(fetchedAt) > 5*time.Minute || now.Sub(fetchedAt) > 5*time.Minute {
		return nil, fmt.Errorf("rate quote is expired")
	}
	return &EpusdtRateQuote{
		Currency:    "CNY",
		Asset:       "USDT",
		USDTPerUnit: *doc.CNY.USDT,
		Source:      strings.TrimSpace(*doc.Source),
		FetchedAt:   fetchedAt,
		ExpiresAt:   expiresAt,
		TradeType:   strings.TrimSpace(*doc.TradeType),
	}, nil
}

func rejectDuplicateJSON(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if _, err := consumeJSONValue(decoder); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("trailing JSON value")
		}
		return err
	}
	return nil
}

func consumeJSONValue(decoder *json.Decoder) (any, error) {
	token, err := decoder.Token()
	if err != nil {
		return nil, err
	}
	switch delimiter := token.(type) {
	case json.Delim:
		switch delimiter {
		case '{':
			values := map[string]any{}
			for decoder.More() {
				keyToken, err := decoder.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fmt.Errorf("object key is not a string")
				}
				if _, exists := values[key]; exists {
					return nil, fmt.Errorf("duplicate JSON field %q", key)
				}
				value, err := consumeJSONValue(decoder)
				if err != nil {
					return nil, err
				}
				values[key] = value
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return values, nil
		case '[':
			values := []any{}
			for decoder.More() {
				value, err := consumeJSONValue(decoder)
				if err != nil {
					return nil, err
				}
				values = append(values, value)
			}
			if _, err := decoder.Token(); err != nil {
				return nil, err
			}
			return values, nil
		default:
			return nil, fmt.Errorf("unexpected JSON delimiter %q", delimiter)
		}
	default:
		return token, nil
	}
}

func finitePositive(value float64) bool {
	return value > 0 && !math.IsNaN(value) && !math.IsInf(value, 0)
}

func calculateEpusdtGatewayUSDT(cnyAmount float64, quote EpusdtRateQuote) float64 {
	if !finitePositive(cnyAmount) || !finitePositive(quote.USDTPerUnit) {
		return 0
	}
	return cnyAmount * quote.USDTPerUnit
}
