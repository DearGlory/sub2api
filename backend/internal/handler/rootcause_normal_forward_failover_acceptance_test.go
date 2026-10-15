//go:build unit

package handler

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// 本文件 fixture 自包含；不调用其他测试 lane 的 helper，也不替换 Forward/Responses。
type normalForwardHandlerAccounts struct {
	service.AccountRepository
	accounts       []service.Account
	mu             sync.Mutex
	selectionCalls int
}

func (r *normalForwardHandlerAccounts) GetByID(_ context.Context, id int64) (*service.Account, error) {
	for _, account := range r.accounts {
		if account.ID == id {
			copy := account
			return &copy, nil
		}
	}
	return nil, service.ErrNoAvailableAccounts
}
func (r *normalForwardHandlerAccounts) ListSchedulableByPlatform(_ context.Context, platform string) ([]service.Account, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.selectionCalls++
	var out []service.Account
	for _, account := range r.accounts {
		if account.Platform == platform && account.IsSchedulable() {
			out = append(out, account)
		}
	}
	return out, nil
}
func (r *normalForwardHandlerAccounts) ListSchedulableByGroupIDAndPlatform(ctx context.Context, _ int64, platform string) ([]service.Account, error) {
	return r.ListSchedulableByPlatform(ctx, platform)
}
func (r *normalForwardHandlerAccounts) ListSchedulableUngroupedByPlatform(ctx context.Context, platform string) ([]service.Account, error) {
	return r.ListSchedulableByPlatform(ctx, platform)
}
func (r *normalForwardHandlerAccounts) ListSchedulableByGroupID(_ context.Context, _ int64) ([]service.Account, error) {
	return append([]service.Account(nil), r.accounts...), nil
}
func (r *normalForwardHandlerAccounts) ListByGroup(_ context.Context, _ int64) ([]service.Account, error) {
	return append([]service.Account(nil), r.accounts...), nil
}
func (r *normalForwardHandlerAccounts) ListModelAvailabilityCandidates(_ context.Context, _ *int64, _ []string, _ bool) ([]service.Account, error) {
	return append([]service.Account(nil), r.accounts...), nil
}

type normalForwardHandlerSlots struct{ service.ConcurrencyCache }

func (*normalForwardHandlerSlots) AcquireUserSlot(context.Context, int64, int, string) (bool, error) {
	return true, nil
}
func (*normalForwardHandlerSlots) ReleaseUserSlot(context.Context, int64, string) error { return nil }
func (*normalForwardHandlerSlots) AcquireAccountSlot(context.Context, int64, int, string) (bool, error) {
	return true, nil
}
func (*normalForwardHandlerSlots) ReleaseAccountSlot(context.Context, int64, string) error {
	return nil
}
func (*normalForwardHandlerSlots) IncrementWaitCount(context.Context, int64, int) (bool, error) {
	return true, nil
}
func (*normalForwardHandlerSlots) DecrementWaitCount(context.Context, int64) error { return nil }
func (*normalForwardHandlerSlots) IncrementAccountWaitCount(context.Context, int64, int) (bool, error) {
	return true, nil
}
func (*normalForwardHandlerSlots) DecrementAccountWaitCount(context.Context, int64) error { return nil }

type normalForwardHandlerAttempt struct {
	accountID           int64
	body                []byte
	path                string
	header              http.Header
	downstreamBytes     int
	responseStatus      int
	responseContentType string
	responseBody        []byte
}
type normalForwardHandlerMode string

const (
	normalHandlerNativeCompact                 normalForwardHandlerMode = ""
	normalHandlerLegacySameModelSSEUnsupported normalForwardHandlerMode = "legacy_same_model_sse_unsupported"
	normalHandlerLegacyHTTPFailover            normalForwardHandlerMode = "legacy_http_failover"
)

type normalForwardHandlerUpstream struct {
	service.HTTPUpstream
	mu                   sync.Mutex
	attempts             []normalForwardHandlerAttempt
	postOutput           bool
	mode                 normalForwardHandlerMode
	recorder             *httptest.ResponseRecorder
	ingressSessionHash   string
	completedSessionHash string
}

func (u *normalForwardHandlerUpstream) Do(req *http.Request, _ string, accountID int64, _ int) (*http.Response, error) {
	body, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	if err := req.Body.Close(); err != nil {
		return nil, err
	}
	u.mu.Lock()
	written := 0
	if u.recorder != nil {
		written = u.recorder.Body.Len()
	}
	u.attempts = append(u.attempts, normalForwardHandlerAttempt{accountID: accountID, body: bytes.Clone(body), path: req.URL.Path, header: req.Header.Clone(), downstreamBytes: written})
	n := len(u.attempts)
	u.mu.Unlock()
	status, contentType := http.StatusOK, "text/event-stream"
	payload := "event: response.completed\n" + `data: {"type":"response.completed","response":{"id":"resp_normal_handler_B","status":"completed","model":"gpt-5.5","service_tier":"default","output":[],"usage":{"input_tokens":11,"output_tokens":7}}}` + "\n\n"
	if u.mode == normalHandlerLegacyHTTPFailover {
		// legacy /compact 初跳已映射 gpt-5.4；HTTP 500 触发 A -> B，
		// 不先伪造一次 gpt-5.5 unsupported，也不伪造同账号 fallback。
		contentType = "application/json"
		if accountID == 801 {
			status = http.StatusInternalServerError
			payload = `{"error":{"type":"server_error","message":"temporary upstream server failure"}}`
		} else {
			payload = `{"id":"resp_normal_handler_B","object":"response.compaction","status":"completed","model":"gpt-5.4","service_tier":"default","output":[],"usage":{"input_tokens":11,"output_tokens":7}}`
		}
	} else if accountID == 801 {
		// 原生 streaming/post-output 与原 non-stream SSE 失败输入保持原样。
		if n == 1 {
			payload = "event: response.failed\n" + `data: {"type":"response.failed","response":{"status":"failed","error":{"code":"unsupported_model","message":"unsupported model"}}}` + "\n\n"
			if u.postOutput {
				payload = "event: response.output_text.delta\n" + `data: {"type":"response.output_text.delta","delta":"A-visible-before-error","output_index":0,"content_index":0}` + "\n\n" + payload
			}
		} else {
			status, contentType = http.StatusInternalServerError, "application/json"
			payload = `{"error":{"type":"server_error","message":"temporary upstream server failure"}}`
		}
	}
	u.mu.Lock()
	u.attempts[n-1].responseStatus = status
	u.attempts[n-1].responseContentType = contentType
	u.attempts[n-1].responseBody = []byte(payload)
	u.mu.Unlock()
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{contentType}, "X-Request-Id": []string{fmt.Sprintf("normal-handler-%d", n)}}, Body: io.NopCloser(strings.NewReader(payload)), Request: req}, nil
}
func (u *normalForwardHandlerUpstream) snapshot() []normalForwardHandlerAttempt {
	u.mu.Lock()
	defer u.mu.Unlock()
	return append([]normalForwardHandlerAttempt(nil), u.attempts...)
}

func newNormalForwardHandlerFixture(t *testing.T, postOutput bool) (*gin.Engine, *normalForwardHandlerUpstream, *normalHandlerBillingSink, *normalHandlerUsageSink, *normalForwardHandlerAccounts) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	cfg := &config.Config{RunMode: config.RunModeStandard}
	cfg.Gateway.MaxAccountSwitches = 3
	cfg.Gateway.OpenAICompactModel = "gpt-5.4"
	cfg.Default.RateMultiplier = 1
	groupID := int64(901)
	repo := &normalForwardHandlerAccounts{}
	for i, name := range []string{"A", "B"} {
		repo.accounts = append(repo.accounts, service.Account{ID: int64(801 + i), Name: name, Platform: service.PlatformOpenAI, Type: service.AccountTypeAPIKey, Status: service.StatusActive, Schedulable: true, Concurrency: 1, Priority: i + 1, Credentials: map[string]any{"api_key": "sk-test-" + name, "base_url": "https://upstream.example/v1"}, Extra: map[string]any{"openai_passthrough": false}})
	}
	for _, account := range repo.accounts {
		require.False(t, account.IsOpenAIPassthroughEnabled())
	}
	ledger := &normalHandlerBillingSink{balance: 100, seen: make(map[string]string)}
	usage := &normalHandlerUsageSink{}
	upstream := &normalForwardHandlerUpstream{postOutput: postOutput}
	billing := service.NewBillingCacheService(nil, ledger, nil, nil, nil, nil, cfg, nil)
	t.Cleanup(billing.Stop)
	gateway := service.NewOpenAIGatewayService(repo, usage, ledger, ledger, nil, nil, nil, cfg, nil, nil, service.NewBillingService(cfg, nil), nil, billing, upstream, &service.DeferredService{}, nil, nil, nil, nil, nil, nil, nil)
	h := NewOpenAIGatewayHandler(gateway, service.NewConcurrencyService(&normalForwardHandlerSlots{}), billing, &service.APIKeyService{}, nil, nil, nil, nil, cfg)
	key := &service.APIKey{ID: 902, GroupID: &groupID, User: &service.User{ID: 903, Status: service.StatusActive, Balance: 100}, Group: &service.Group{ID: groupID, Platform: service.PlatformOpenAI, Status: service.StatusActive, RateMultiplier: 1}}
	require.NoError(t, gateway.BindOpenAIHTTPResponseOwner(context.Background(), groupID, "resp_normal_handler_previous", key.User.ID, key.ID))
	router := gin.New()
	router.Use(func(c *gin.Context) {
		c.Set(string(middleware.ContextKeyAPIKey), key)
		c.Set(string(middleware.ContextKeyUser), middleware.AuthSubject{UserID: key.User.ID, Concurrency: 1})
		upstream.ingressSessionHash = gateway.GenerateSessionHash(c, nil)
		c.Next()
		upstream.completedSessionHash = gateway.GenerateSessionHash(c, nil)
	})
	router.POST("/openai/v1/responses", h.Responses)
	return router, upstream, ledger, usage, repo
}

func newNormalForwardHandlerNonStreamFixture(t *testing.T, mode normalForwardHandlerMode) (*gin.Engine, *normalForwardHandlerUpstream, *normalHandlerBillingSink, *normalHandlerUsageSink, *normalForwardHandlerAccounts) {
	t.Helper()
	require.Contains(t, []normalForwardHandlerMode{normalHandlerLegacySameModelSSEUnsupported, normalHandlerLegacyHTTPFailover}, mode)
	router, upstream, ledger, usage, repo := newNormalForwardHandlerFixture(t, false)
	upstream.mode = mode
	return router, upstream, ledger, usage, repo
}

// 只实现生产仓储已有接口，不伪造计费 hook。内存 ledger 并非数据库事务集成证明。
type normalHandlerBillingSink struct {
	service.UserRepository
	service.UsageBillingRepository
	mu           sync.Mutex
	balance      float64
	balanceReads int
	commands     []service.UsageBillingCommand
	debits       int
	seen         map[string]string
}

func (s *normalHandlerBillingSink) GetByID(_ context.Context, id int64) (*service.User, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if id != 903 {
		return nil, fmt.Errorf("unexpected user %d", id)
	}
	s.balanceReads++
	return &service.User{ID: id, Status: service.StatusActive, Balance: s.balance}, nil
}
func (*normalHandlerBillingSink) DeductBalance(context.Context, int64, float64) error {
	return fmt.Errorf("unexpected legacy billing path")
}
func (s *normalHandlerBillingSink) Apply(_ context.Context, cmd *service.UsageBillingCommand) (*service.UsageBillingApplyResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if cmd == nil || cmd.RequestID == "" || cmd.RequestFingerprint == "" || cmd.UserID != 903 {
		return nil, fmt.Errorf("invalid billing command %+v", cmd)
	}
	s.commands = append(s.commands, *cmd)
	key := fmt.Sprintf("%d:%s", cmd.APIKeyID, cmd.RequestID)
	if previous, ok := s.seen[key]; ok {
		if previous != cmd.RequestFingerprint {
			return nil, service.ErrUsageBillingRequestConflict
		}
		return &service.UsageBillingApplyResult{Applied: false}, nil
	}
	s.seen[key] = cmd.RequestFingerprint
	if cmd.BalanceCost > 0 {
		s.balance -= cmd.BalanceCost
		s.debits++
	}
	balance := s.balance
	return &service.UsageBillingApplyResult{Applied: true, NewBalance: &balance}, nil
}

type normalHandlerUsageSink struct {
	service.UsageLogRepository
	mu   sync.Mutex
	rows []service.UsageLog
}

func (s *normalHandlerUsageSink) Create(_ context.Context, row *service.UsageLog) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if row == nil {
		return false, fmt.Errorf("nil usage row")
	}
	s.rows = append(s.rows, *row)
	return true, nil
}
func (s *normalHandlerUsageSink) snapshot() []service.UsageLog {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]service.UsageLog(nil), s.rows...)
}

func normalHandlerLargeCompactBody(t *testing.T, stream bool) ([]byte, string) {
	t.Helper()
	marker := strings.Repeat("normal-forward-handler-marker|", 80000)
	content := make([]any, 0, 320)
	for start := 0; start < len(marker); start += 8192 {
		end := start + 8192
		if end > len(marker) {
			end = len(marker)
		}
		content = append(content, map[string]any{"type": "input_text", "text": marker[start:end]})
	}
	body, err := json.Marshal(map[string]any{"model": "gpt-5.5", "stream": stream, "instructions": "preserve native compaction context", "service_tier": "default", "store": true, "prompt_cache_key": "normal-handler-session", "previous_response_id": "resp_normal_handler_previous", "reasoning": map[string]any{"effort": "medium", "context": "all_turns"}, "input": []any{map[string]any{"type": "message", "role": "user", "content": content}, map[string]any{"type": "compaction_trigger"}}})
	require.NoError(t, err)
	require.True(t, json.Valid(body))
	require.Greater(t, len(body), 2<<20) // 真实 replay memory limit 为 1 MiB。
	return body, marker
}
func normalHandlerServe(router *gin.Engine, u *normalForwardHandlerUpstream, body []byte) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/openai/v1/responses", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Session-Id", "normal-handler-session")
	req.Header.Set("X-Codex-Beta-Features", "remote_compaction_v2")
	recorder := httptest.NewRecorder()
	u.recorder = recorder
	router.ServeHTTP(recorder, req)
	return recorder
}
func requireNormalHandlerBillingOnce(t *testing.T, ledger *normalHandlerBillingSink, usage *normalHandlerUsageSink, body []byte, stream bool) {
	t.Helper()
	requireNormalHandlerBillingOnceWithUpstreamModel(t, ledger, usage, body, stream, "gpt-5.5")
}
func requireNormalHandlerBillingOnceWithUpstreamModel(t *testing.T, ledger *normalHandlerBillingSink, usage *normalHandlerUsageSink, body []byte, stream bool, upstreamModel string) {
	t.Helper()
	// nil worker pool 的生产 fallback 同步执行 RecordUsage，无需 Eventually/sleep。
	rows := usage.snapshot()
	require.Len(t, rows, 1, "必须真实抵达 usage repo，不能只验证 Forward 返回值")
	row := rows[0]
	require.Equal(t, int64(802), row.AccountID)
	require.Equal(t, int64(903), row.UserID)
	require.Equal(t, int64(902), row.APIKeyID)
	require.Equal(t, "gpt-5.5", row.Model)
	require.Equal(t, "gpt-5.5", row.RequestedModel)
	require.NotNil(t, row.UpstreamModel)
	require.Equal(t, upstreamModel, *row.UpstreamModel)
	require.NotNil(t, row.UpstreamResponseModel)
	require.Equal(t, upstreamModel, *row.UpstreamResponseModel)
	require.NotNil(t, row.ServiceTier)
	require.Equal(t, "default", *row.ServiceTier)
	require.Equal(t, 11, row.InputTokens)
	require.Equal(t, 7, row.OutputTokens)
	require.Equal(t, stream, row.Stream)
	require.Equal(t, service.BillingTypeBalance, row.BillingType)
	require.Greater(t, row.ActualCost, 0.0, "零价日志不是扣费证明")
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	require.Greater(t, ledger.balanceReads, 0, "必须通过 standard eligibility")
	require.Len(t, ledger.commands, 1, "失败 A 和 compact fallback 不得重复提交扣费")
	require.Equal(t, 1, ledger.debits)
	cmd := ledger.commands[0]
	require.Equal(t, int64(802), cmd.AccountID)
	require.Equal(t, "gpt-5.5", cmd.Model)
	require.Equal(t, int64(903), cmd.UserID)
	require.Equal(t, int64(902), cmd.APIKeyID)
	require.Equal(t, row.RequestID, cmd.RequestID)
	require.Equal(t, "default", cmd.ServiceTier)
	require.Equal(t, service.HashUsageRequestPayload(body), cmd.RequestPayloadHash)
	require.Equal(t, 11, cmd.InputTokens)
	require.Equal(t, 7, cmd.OutputTokens)
	require.Equal(t, service.QuantizeUsageBillingAmount(row.ActualCost), cmd.BalanceCost)
	require.InDelta(t, 100-cmd.BalanceCost, ledger.balance, 1e-12)
	require.Zero(t, cmd.SubscriptionCost)
}
func requireNormalHandlerReplay(t *testing.T, u *normalForwardHandlerUpstream, repo *normalForwardHandlerAccounts, body []byte, marker string, stream bool) {
	t.Helper()
	require.True(t, stream, "非流式 legacy 使用独立的 canonical /compact 断言，不套原生三跳契约")
	attempts := u.snapshot()
	require.NotEmpty(t, u.ingressSessionHash)
	require.Equal(t, u.ingressSessionHash, u.completedSessionHash, "跨账号与compact归一化不应改变原请求 session")
	require.Len(t, attempts, 3)
	require.Equal(t, []int64{801, 801, 802}, []int64{attempts[0].accountID, attempts[1].accountID, attempts[2].accountID})
	require.Equal(t, 2, repo.selectionCalls, "真实 scheduler 只选 A/B；compact 同账号重试不选号")
	require.Equal(t, "gpt-5.4", gjson.GetBytes(attempts[1].body, "model").String())
	for _, i := range []int{0, 2} {
		require.Equal(t, "gpt-5.5", gjson.GetBytes(attempts[i].body, "model").String())
	}
	for _, attempt := range attempts {
		require.Zero(t, attempt.downstreamBytes, "failover/compact retry 必须在业务输出前")
		require.True(t, json.Valid(attempt.body))
		require.Equal(t, sha256.Sum256([]byte(marker)), sha256.Sum256([]byte(normalHandlerMarker(attempt.body))))
		require.Len(t, gjson.GetBytes(attempt.body, "input").Array(), 2)
		require.True(t, service.HasCompactionTriggerInInput(attempt.body))
		require.Equal(t, "resp_normal_handler_previous", gjson.GetBytes(attempt.body, "previous_response_id").String())
		require.Equal(t, "preserve native compaction context", gjson.GetBytes(attempt.body, "instructions").String())
		require.JSONEq(t, gjson.GetBytes(body, "reasoning").Raw, gjson.GetBytes(attempt.body, "reasoning").Raw)
		require.Equal(t, "/v1/responses", attempt.path)
		require.True(t, gjson.GetBytes(attempt.body, "stream").Bool())
		require.True(t, gjson.GetBytes(attempt.body, "store").Bool())
		require.Equal(t, "normal-handler-session", gjson.GetBytes(attempt.body, "prompt_cache_key").String())
		require.Contains(t, attempt.header.Get("X-Codex-Beta-Features"), "remote_compaction_v2")
	}
	require.JSONEq(t, string(body), string(attempts[2].body), "B 必须收到完整 canonical 原正文，不只是 marker/model")
	fallback, err := sjson.SetBytes(attempts[0].body, "model", "gpt-5.4")
	require.NoError(t, err)
	require.JSONEq(t, string(fallback), string(attempts[1].body), "A compact fallback 只变 model")
}
func requireNormalHandlerLegacyCompactReplay(t *testing.T, u *normalForwardHandlerUpstream, repo *normalForwardHandlerAccounts, body []byte, marker string, accountIDs []int64) []byte {
	t.Helper()
	require.NotEmpty(t, u.ingressSessionHash)
	require.Equal(t, u.ingressSessionHash, u.completedSessionHash, "legacy 归一化/换号仍保留原请求 session")
	normalized, _, err := service.NormalizeOpenAICompactRequestBodyForTest(body)
	require.NoError(t, err)
	require.Equal(t, "gpt-5.5", gjson.GetBytes(normalized, "model").String(), "计费 canonical 保留请求模型")
	upstreamCanonical, err := sjson.SetBytes(normalized, "model", "gpt-5.4")
	require.NoError(t, err)
	attempts := u.snapshot()
	require.Len(t, attempts, len(accountIDs))
	require.Equal(t, len(accountIDs), repo.selectionCalls, "legacy 每个账号只选号一次，不伪造同模型 fallback")
	for i, attempt := range attempts {
		require.Equal(t, accountIDs[i], attempt.accountID)
		require.Zero(t, attempt.downstreamBytes, "业务输出前才允许换号")
		require.Equal(t, "/v1/responses/compact", attempt.path)
		require.True(t, json.Valid(attempt.body))
		require.JSONEq(t, string(upstreamCanonical), string(attempt.body), "每个账号收到完整 canonical；仅上游 model 映射 gpt-5.4")
		require.Equal(t, "gpt-5.4", gjson.GetBytes(attempt.body, "model").String())
		for _, field := range []string{"stream", "store", "prompt_cache_key"} {
			require.False(t, gjson.GetBytes(attempt.body, field).Exists(), field)
		}
		require.Equal(t, sha256.Sum256([]byte(marker)), sha256.Sum256([]byte(normalHandlerMarker(attempt.body))))
		require.Len(t, gjson.GetBytes(attempt.body, "input").Array(), 2)
		require.True(t, service.HasCompactionTriggerInInput(attempt.body))
		require.Equal(t, "resp_normal_handler_previous", gjson.GetBytes(attempt.body, "previous_response_id").String())
		require.Equal(t, "preserve native compaction context", gjson.GetBytes(attempt.body, "instructions").String())
		require.JSONEq(t, gjson.GetBytes(body, "reasoning").Raw, gjson.GetBytes(attempt.body, "reasoning").Raw)
	}
	return normalized
}
func TestNormalForwardResponsesHandlerNativeCompactFailoverBillsFinalAccountOnce(t *testing.T) {
	router, u, ledger, usage, repo := newNormalForwardHandlerFixture(t, false)
	body, marker := normalHandlerLargeCompactBody(t, true)
	recorder := normalHandlerServe(router, u, body)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), "response.completed")
	require.NotContains(t, recorder.Body.String(), "unsupported_model")
	require.NotContains(t, recorder.Body.String(), "temporary upstream server failure")
	requireNormalHandlerReplay(t, u, repo, body, marker, true)
	requireNormalHandlerBillingOnce(t, ledger, usage, body, true)
}
func TestNormalForwardResponsesHandlerNonStreamCompactFailoverBillsFinalAccountOnce(t *testing.T) {
	// 保留历史失败用例名称及其第一个 HTTP 200 SSE unsupported 输入。
	// 原 Linux receipt 的 expected=200/actual=502 是旧三跳预期错误，不是已证实回归。
	// handler stream=false 先提升 legacy /compact，Forward 初跳已用 gpt-5.4；
	// 同模型拒绝不会再 fallback，非流式信号返回普通 error，终止一次且不选 B。
	router, u, ledger, usage, repo := newNormalForwardHandlerNonStreamFixture(t, normalHandlerLegacySameModelSSEUnsupported)
	body, marker := normalHandlerLargeCompactBody(t, false)
	recorder := normalHandlerServe(router, u, body)
	require.Equal(t, http.StatusBadGateway, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Header().Get("Content-Type"), "application/json")
	require.JSONEq(t, `{"error":{"message":"Upstream request failed","type":"upstream_error"}}`, recorder.Body.String(), "单个终止错误，不拼接 SSE 或重复错误")
	require.NotContains(t, recorder.Body.String(), "unsupported_model")
	require.NotContains(t, recorder.Body.String(), "response.completed")
	requireNormalHandlerLegacyCompactReplay(t, u, repo, body, marker, []int64{801})
	attempt := u.snapshot()[0]
	require.Equal(t, http.StatusOK, attempt.responseStatus)
	require.Equal(t, "text/event-stream", attempt.responseContentType)
	require.Equal(t, 1, strings.Count(string(attempt.responseBody), "event: response.failed"))
	require.Contains(t, string(attempt.responseBody), "unsupported_model")
	require.NotContains(t, string(attempt.responseBody), "A-visible-before-error")
	require.Empty(t, usage.snapshot(), "未成功的同模型 SSE 不能抵达 RecordUsage 仓储")
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	require.Greater(t, ledger.balanceReads, 0, "仍走正常 standard eligibility")
	require.Empty(t, ledger.commands)
	require.Empty(t, ledger.seen)
	require.Zero(t, ledger.debits)
	require.Equal(t, 100.0, ledger.balance)
}
func TestNormalForwardResponsesHandlerNonStreamLegacyHTTPFailoverBillsFinalAccountOnce(t *testing.T) {
	router, u, ledger, usage, repo := newNormalForwardHandlerNonStreamFixture(t, normalHandlerLegacyHTTPFailover)
	body, marker := normalHandlerLargeCompactBody(t, false)
	recorder := normalHandlerServe(router, u, body)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Header().Get("Content-Type"), "application/json")
	require.True(t, json.Valid(recorder.Body.Bytes()))
	require.Equal(t, "completed", gjson.GetBytes(recorder.Body.Bytes(), "status").String())
	require.Equal(t, "resp_normal_handler_B", gjson.GetBytes(recorder.Body.Bytes(), "id").String())
	// 生产会把客户端公开模型还原为 gpt-5.5；原始上游及 usage 观测必须为 gpt-5.4。
	require.Equal(t, "gpt-5.5", gjson.GetBytes(recorder.Body.Bytes(), "model").String())
	require.NotContains(t, recorder.Body.String(), "unsupported_model")
	require.NotContains(t, recorder.Body.String(), "temporary upstream server failure")
	normalized := requireNormalHandlerLegacyCompactReplay(t, u, repo, body, marker, []int64{801, 802})
	attempts := u.snapshot()
	require.Equal(t, http.StatusInternalServerError, attempts[0].responseStatus)
	require.Equal(t, "application/json", attempts[0].responseContentType)
	require.Equal(t, "server_error", gjson.GetBytes(attempts[0].responseBody, "error.type").String())
	require.Equal(t, http.StatusOK, attempts[1].responseStatus)
	require.Equal(t, "application/json", attempts[1].responseContentType)
	require.Equal(t, "gpt-5.4", gjson.GetBytes(attempts[1].responseBody, "model").String())
	requireNormalHandlerBillingOnceWithUpstreamModel(t, ledger, usage, normalized, false, "gpt-5.4")
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	require.Len(t, ledger.seen, 1, "一次 session 请求仅产生最终 B 的一笔账")
}
func TestNormalForwardResponsesHandlerOutputThenFailureDoesNotSelectNextAccount(t *testing.T) {
	router, u, ledger, usage, repo := newNormalForwardHandlerFixture(t, true)
	body, marker := normalHandlerLargeCompactBody(t, true)
	recorder := normalHandlerServe(router, u, body)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), "A-visible-before-error")
	require.Contains(t, recorder.Body.String(), "response.failed")
	require.Equal(t, 1, strings.Count(recorder.Body.String(), "event: response.failed"), "错误终止帧不得双写")
	require.NotContains(t, recorder.Body.String(), "response.completed")
	attempts := u.snapshot()
	require.Len(t, attempts, 1, "业务输出后不得 compact fallback 或选 B")
	require.Equal(t, int64(801), attempts[0].accountID)
	require.Equal(t, 1, repo.selectionCalls)
	require.Equal(t, sha256.Sum256([]byte(marker)), sha256.Sum256([]byte(normalHandlerMarker(attempts[0].body))))
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	require.Zero(t, ledger.debits)
	require.Equal(t, 100.0, ledger.balance)
	for _, cmd := range ledger.commands {
		require.Equal(t, int64(801), cmd.AccountID)
		require.Zero(t, cmd.BalanceCost)
	}
	// 不把真实生产允许的零额 partial usage 行误称为失败 double billing。
	for _, row := range usage.snapshot() {
		require.Equal(t, int64(801), row.AccountID)
		require.Zero(t, row.InputTokens)
		require.Zero(t, row.OutputTokens)
		require.Zero(t, row.ActualCost)
	}
}

func normalHandlerMarker(body []byte) string {
	var b strings.Builder
	for _, part := range gjson.GetBytes(body, "input.0.content").Array() {
		b.WriteString(part.Get("text").String())
	}
	return b.String()
}
