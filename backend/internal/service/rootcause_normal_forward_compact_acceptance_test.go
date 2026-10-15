package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

// G01: exercise ordinary Forward, not forwardOpenAIPassthrough or the replay
// helper alone. HTTP 200 does not mean success: its first SSE terminal fails
// before client output. Both client stream modes must restore a real disk spill.
func TestRootcauseNormalForwardLargeCompactFallbackAcceptance(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, stream := range []bool{false, true} {
		t.Run(normalCompactAcceptanceStreamName(stream), func(t *testing.T) {
			body, marker := normalCompactAcceptanceBody(t, stream, "compact-session", "stale-cipher")
			original := append([]byte(nil), body...)
			upstream := &httpUpstreamRecorder{responses: []*http.Response{
				normalCompactAcceptanceFailure(),
				normalCompactAcceptanceSuccess(stream, "gpt-5.4"),
			}}
			svc, account, spill := normalCompactAcceptanceService(t, upstream)
			spill.observeResponse(upstream.responses[0], upstream, marker, "gpt-5.5", 1)
			spill.observeResponse(upstream.responses[1], upstream, marker, "gpt-5.4", 2)
			c, recorder := normalCompactAcceptanceContext(body, 71)

			result, err := svc.Forward(context.Background(), c, account, body)

			require.NoError(t, err)
			normalCompactAcceptanceResult(t, result, stream, "gpt-5.4")
			require.Len(t, upstream.bodies, 2, "one compact model fallback, no extra attempts")
			require.Empty(t, upstream.responses)
			for i, sent := range upstream.bodies {
				model := "gpt-5.5"
				if i > 0 {
					model = "gpt-5.4"
				}
				normalCompactAcceptancePayload(t, sent, marker, model, "stale-cipher", stream, "resp_previous")
				require.Equal(t, "/v1/responses", upstream.requests[i].URL.Path)
			}
			require.True(t, isOpenAINativeCompactionV2(c), "native-v2 marker survives retries")
			normalCompactAcceptanceRetryEvent(t, c, account)
			require.True(t, bytes.Equal(original, body), "caller body must not change")
			spill.assertReleased(t, 2)
			normalCompactAcceptanceOutput(t, recorder, stream)
		})
	}
}

// G02 + G05 result fields: first fail inside an HTTP-200 SSE response, restore
// the spilled body, switch model, then recover literal HTTP-400
// invalid_encrypted_content. Later turns share this exact service/state store.
// This is not a handler, usage-recording, account-failover or debit test.
func TestRootcauseNormalForwardLargeCompactEncryptedRecoverySessionAcceptance(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, stream := range []bool{false, true} {
		t.Run(normalCompactAcceptanceStreamName(stream), func(t *testing.T) {
			const session = "compact-encrypted-session"
			const stale = "stale-compact-encrypted-cipher"
			body, marker := normalCompactAcceptanceBody(t, stream, session, stale)
			original := append([]byte(nil), body...)
			upstream := &httpUpstreamRecorder{responses: []*http.Response{
				normalCompactAcceptanceFailure(),
				{StatusCode: http.StatusBadRequest, Header: http.Header{"Content-Type": []string{"application/json"}},
					Body: io.NopCloser(strings.NewReader(`{"error":{"code":"invalid_encrypted_content","type":"invalid_request_error","message":"The encrypted content could not be verified."}}`))},
				normalCompactAcceptanceSuccess(stream, "gpt-5.4"),
			}}
			svc, account, spill := normalCompactAcceptanceService(t, upstream)
			spill.observeResponse(upstream.responses[0], upstream, marker, "gpt-5.5", 1)
			spill.observeResponse(upstream.responses[2], upstream, marker, "gpt-5.4", 2)
			c, recorder := normalCompactAcceptanceContext(body, 71)
			sessionHash := svc.GenerateSessionHash(c, body)
			require.NotEmpty(t, sessionHash)
			require.False(t, svc.getOpenAIWSStateStore().HasAnySessionInvalidEncryptedContent())

			result, err := svc.Forward(context.Background(), c, account, body)

			require.NoError(t, err)
			normalCompactAcceptanceResult(t, result, stream, "gpt-5.4")
			require.Len(t, upstream.bodies, 3, "one compact fallback plus one encrypted recovery")
			require.Empty(t, upstream.responses)
			for i, sent := range upstream.bodies {
				model, cipher := "gpt-5.4", stale
				if i == 0 {
					model = "gpt-5.5"
				}
				if i == 2 {
					cipher = ""
				}
				normalCompactAcceptancePayload(t, sent, marker, model, cipher, stream, "resp_previous")
				require.Equal(t, "/v1/responses", upstream.requests[i].URL.Path)
			}
			require.True(t, isOpenAINativeCompactionV2(c))
			normalCompactAcceptanceRetryEvent(t, c, account)
			require.True(t, bytes.Equal(original, body), "combined retries must not mutate caller body")
			spill.assertReleased(t, 2)
			normalCompactAcceptanceOutput(t, recorder, stream)
			state := svc.getOpenAIWSStateStore()
			require.Len(t, state.GetSessionInvalidEncryptedContentDigests(71, sessionHash), 1)

			turns := []struct {
				name, session, cipher, expectedCipher string
				group                                 int64
			}{
				{"same_session_next_turn", session, stale, "", 71},
				{"different_session_same_stale_cipher", "other-compact-session", stale, stale, 71},
				{"different_group_same_session_and_cipher", session, stale, stale, 72},
				{"same_session_new_cipher", session, "fresh-compact-cipher", "fresh-compact-cipher", 71},
			}
			for i, turn := range turns {
				t.Run(turn.name, func(t *testing.T) {
					nextBody, nextMarker := normalCompactAcceptanceBody(t, stream, turn.session, turn.cipher)
					// This is a later turn, not a byte-identical retry: use the prior
					// response as continuation and append a new user message.
					var next map[string]any
					require.NoError(t, json.Unmarshal(nextBody, &next))
					next["previous_response_id"] = "resp_compact_acceptance"
					items := next["input"].([]any)
					next["input"] = append(items[:len(items)-1],
						map[string]any{"type": "message", "role": "user", "content": "next turn"},
						items[len(items)-1])
					nextBody, err := json.Marshal(next)
					require.NoError(t, err)
					nextOriginal := append([]byte(nil), nextBody...)
					nextContext, nextRecorder := normalCompactAcceptanceContext(nextBody, turn.group)
					nextHash := svc.GenerateSessionHash(nextContext, nextBody)
					if turn.session == session {
						require.Equal(t, sessionHash, nextHash)
					} else {
						require.NotEqual(t, sessionHash, nextHash)
						require.Empty(t, state.GetSessionInvalidEncryptedContentDigests(turn.group, nextHash))
					}
					if turn.group != 71 {
						require.Empty(t, state.GetSessionInvalidEncryptedContentDigests(turn.group, nextHash))
					}
					success := normalCompactAcceptanceSuccess(stream, "gpt-5.5")
					spill.observeResponse(success, upstream, nextMarker, "gpt-5.5", 3+i)
					upstream.responses = append(upstream.responses, success)
					before := len(upstream.bodies)

					nextResult, nextErr := svc.Forward(context.Background(), nextContext, account, nextBody)

					require.NoError(t, nextErr)
					normalCompactAcceptanceResult(t, nextResult, stream, "gpt-5.5")
					require.Len(t, upstream.bodies, before+1, "pre-strip or isolation must need only the first upstream attempt")
					require.Empty(t, upstream.responses)
					normalCompactAcceptancePayload(t, upstream.bodies[before], nextMarker, "gpt-5.5", turn.expectedCipher, stream, "resp_compact_acceptance")
					require.Equal(t, "/v1/responses", upstream.requests[before].URL.Path)
					require.True(t, isOpenAINativeCompactionV2(nextContext))
					require.True(t, bytes.Equal(nextOriginal, nextBody))
					spill.assertReleased(t, 3+i)
					normalCompactAcceptanceOutput(t, nextRecorder, stream)
				})
			}
			require.Len(t, upstream.bodies, 7)
			require.Len(t, state.GetSessionInvalidEncryptedContentDigests(71, sessionHash), 1, "successful fresh ciphertext must not be marked invalid")
			spill.assertReleased(t, 6)
		})
	}
}

func normalCompactAcceptanceStreamName(stream bool) string {
	if stream {
		return "stream"
	}
	return "nonstream"
}

func normalCompactAcceptanceService(t *testing.T, upstream *httpUpstreamRecorder) (*OpenAIGatewayService, *Account, *normalCompactAcceptanceSpill) {
	t.Helper()
	spill := &normalCompactAcceptanceSpill{dir: t.TempDir(), budget: newOpenAIPassthroughReplayBudget(8 << 20)}
	store := &openAIPassthroughReplayStore{budget: spill.budget, createTemp: func() (*os.File, error) {
		spill.creates++
		f, err := os.CreateTemp(spill.dir, "normal-compact-*")
		if err == nil {
			spill.files = append(spill.files, f)
		}
		return f, err
	}}
	// Safety cleanup is not evidence of Forward cleanup: assertReleased runs
	// before this cleanup, and after every individual Forward call.
	t.Cleanup(func() {
		for _, f := range spill.files {
			_ = f.Close()
			_ = os.Remove(f.Name())
		}
	})
	cfg := &config.Config{Gateway: config.GatewayConfig{OpenAICompactModel: "gpt-5.4"}}
	cfg.Security.URLAllowlist.Enabled = false
	svc := &OpenAIGatewayService{cfg: cfg, httpUpstream: upstream, passthroughReplayStore: store,
		openaiWSStateStore: NewOpenAIWSStateStore(nil)}
	account := &Account{ID: 1701, Name: "ordinary-compact-acceptance", Platform: PlatformOpenAI,
		Type: AccountTypeAPIKey, Concurrency: 1, Status: StatusActive, Schedulable: true,
		Credentials: map[string]any{"api_key": "sk-test", "base_url": "https://example.com"},
		Extra:       map[string]any{"use_responses_api": true, "openai_passthrough": false}}
	require.Equal(t, false, account.Extra["openai_passthrough"])
	require.False(t, account.IsOpenAIPassthroughEnabled())
	return svc, account, spill
}

// Inspect the actual file while Forward is pending on its upstream response,
// not a separately constructed replay. Reading with ReadAt preserves its offset.
type normalCompactAcceptanceSpill struct {
	dir          string
	budget       *openAIPassthroughReplayBudget
	creates      int
	observations int
	files        []*os.File
}

func (s *normalCompactAcceptanceSpill) observeResponse(resp *http.Response, upstream *httpUpstreamRecorder, marker, model string, count int) {
	resp.Body = &normalCompactAcceptanceObservedBody{ReadCloser: resp.Body, beforeRead: func() error {
		// Streaming scans on a goroutine. Return an error to Forward rather
		// than calling require/FailNow outside the test's own goroutine.
		if s.creates != count || len(s.files) != count {
			return fmt.Errorf("pending spill count: creates=%d files=%d want=%d", s.creates, len(s.files), count)
		}
		f := s.files[count-1]
		info, err := f.Stat()
		if err != nil {
			return fmt.Errorf("pending spill descriptor is not open: %w", err)
		}
		if info.Size() <= int64(openAIPassthroughReplayMemoryLimit) || s.budget.used.Load() != info.Size() {
			return fmt.Errorf("pending real spill: bytes=%d reservation=%d", info.Size(), s.budget.used.Load())
		}
		parked := make([]byte, int(info.Size()))
		n, err := f.ReadAt(parked, 0)
		if err != nil || n != len(parked) {
			return fmt.Errorf("pending spill read: bytes=%d want=%d err=%v", n, len(parked), err)
		}
		if !json.Valid(parked) || sha256.Sum256(upstream.lastBody) != sha256.Sum256(parked) {
			return fmt.Errorf("pending spill differs from actual upstream JSON body")
		}
		if gjson.GetBytes(parked, "model").String() != model {
			return fmt.Errorf("pending spill model mismatch: want=%s", model)
		}
		if sha256.Sum256([]byte(marker)) != sha256.Sum256([]byte(gjson.GetBytes(parked, "input.1.content.0.text").String())) {
			return fmt.Errorf("pending spill marker SHA256 mismatch")
		}
		s.observations++
		return nil
	}}
}

func (s *normalCompactAcceptanceSpill) assertReleased(t *testing.T, count int) {
	t.Helper()
	require.Equal(t, count, s.creates)
	require.Equal(t, count, s.observations, "each real spill was observed while pending")
	require.Len(t, s.files, count)
	require.Zero(t, s.budget.used.Load(), "Forward cleanup, not t.Cleanup, releases all reservations")
	for _, f := range s.files {
		_, err := f.Stat()
		require.ErrorIs(t, err, os.ErrClosed)
		_, err = os.Stat(f.Name())
		require.ErrorIs(t, err, os.ErrNotExist)
	}
}

type normalCompactAcceptanceObservedBody struct {
	io.ReadCloser
	beforeRead func() error
	observed   bool
}

func (b *normalCompactAcceptanceObservedBody) Read(p []byte) (int, error) {
	if !b.observed {
		b.observed = true
		if err := b.beforeRead(); err != nil {
			return 0, err
		}
	}
	return b.ReadCloser.Read(p)
}

func normalCompactAcceptanceContext(body []byte, group int64) (*gin.Context, *httptest.ResponseRecorder) {
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", bytes.NewReader(body))
	c.Request.Header.Set("Content-Type", "application/json")
	c.Request.Header.Set("session-id", gjson.GetBytes(body, "prompt_cache_key").String())
	c.Set("api_key", &APIKey{ID: 271, GroupID: &group})
	SetOpenAIClientTransport(c, OpenAIClientTransportHTTP)
	MarkOpenAINativeCompactionV2(c)
	return c, recorder
}

func normalCompactAcceptanceBody(t *testing.T, stream bool, session, cipher string) ([]byte, string) {
	t.Helper()
	marker := "NORMAL-FORWARD-LARGE-MARKER:" + strings.Repeat("0123456789abcdef", (1<<20)/16+32)
	body, err := json.Marshal(map[string]any{
		"model": "gpt-5.5", "stream": stream, "service_tier": "priority",
		"instructions": "ordinary Forward native compaction acceptance", "prompt_cache_key": session,
		"reasoning":            map[string]any{"effort": "high", "summary": "auto"},
		"previous_response_id": "resp_previous",
		"tools":                []any{map[string]any{"type": "function", "name": "lookup", "parameters": map[string]any{"type": "object"}}},
		"input": []any{
			map[string]any{"type": "reasoning", "encrypted_content": cipher, "summary": []any{map[string]any{"type": "summary_text", "text": "keep-summary"}}},
			map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": marker}}},
			map[string]any{"type": "function_call", "call_id": "call_keep", "name": "lookup", "arguments": "{}"},
			map[string]any{"type": "function_call_output", "call_id": "call_keep", "output": "keep-output"},
			map[string]any{"type": "compaction_trigger"},
		},
	})
	require.NoError(t, err)
	require.True(t, json.Valid(body))
	require.Greater(t, len(body), openAIPassthroughReplayMemoryLimit)
	return body, marker
}

func normalCompactAcceptancePayload(t *testing.T, body []byte, marker, model, cipher string, stream bool, previous string) {
	t.Helper()
	require.True(t, json.Valid(body))
	require.Greater(t, len(body), openAIPassthroughReplayMemoryLimit, "transformed JSON must still spill")
	require.Equal(t, sha256.Sum256([]byte(marker)), sha256.Sum256([]byte(gjson.GetBytes(body, "input.1.content.0.text").String())))
	require.Equal(t, model, gjson.GetBytes(body, "model").String())
	require.Equal(t, stream, gjson.GetBytes(body, "stream").Bool())
	require.Equal(t, "priority", gjson.GetBytes(body, "service_tier").String())
	require.Equal(t, "high", gjson.GetBytes(body, "reasoning.effort").String())
	require.Equal(t, "auto", gjson.GetBytes(body, "reasoning.summary").String())
	require.Equal(t, "keep-summary", gjson.GetBytes(body, "input.0.summary.0.text").String())
	require.Equal(t, "lookup", gjson.GetBytes(body, "tools.0.name").String())
	require.Equal(t, "object", gjson.GetBytes(body, "tools.0.parameters.type").String())
	require.Equal(t, "function_call", gjson.GetBytes(body, "input.2.type").String())
	require.Equal(t, "call_keep", gjson.GetBytes(body, "input.2.call_id").String())
	require.Equal(t, "function_call_output", gjson.GetBytes(body, "input.3.type").String())
	require.Equal(t, "call_keep", gjson.GetBytes(body, "input.3.call_id").String())
	require.Equal(t, "keep-output", gjson.GetBytes(body, "input.3.output").String())
	require.Equal(t, previous, gjson.GetBytes(body, "previous_response_id").String())
	encrypted := gjson.GetBytes(body, "input.0.encrypted_content")
	if cipher == "" {
		require.False(t, encrypted.Exists(), "known-invalid cipher must be removed, not blanked")
	} else {
		require.True(t, encrypted.Exists())
		require.Equal(t, cipher, encrypted.String())
	}
	input := gjson.GetBytes(body, "input").Array()
	triggers := 0
	for _, item := range input {
		if item.Get("type").String() == "compaction_trigger" {
			triggers++
		}
	}
	require.Equal(t, 1, triggers, "retain exactly one native compaction trigger")
	require.Equal(t, "compaction_trigger", input[len(input)-1].Get("type").String())
}

// Pin the actual Forward result contract: outbound priority is separate from
// response-declared default; original billing model survives compact fallback.
// A returned result does not establish persistence, cost or exactly-once debit.
func normalCompactAcceptanceResult(t *testing.T, result *OpenAIForwardResult, stream bool, upstreamModel string) {
	t.Helper()
	require.NotNil(t, result)
	require.Equal(t, OpenAIUsage{InputTokens: 17, OutputTokens: 9, CacheReadInputTokens: 5}, result.Usage)
	require.Equal(t, "gpt-5.5", result.Model)
	require.Equal(t, "gpt-5.5", result.BillingModel)
	require.Equal(t, upstreamModel, result.UpstreamModel)
	require.Equal(t, upstreamModel, result.UpstreamResponseModel)
	require.False(t, result.UpstreamResponseModelConflict)
	require.NotNil(t, result.ServiceTier)
	require.Equal(t, "priority", *result.ServiceTier)
	require.Equal(t, "default", result.UpstreamResponseServiceTier)
	require.NotNil(t, result.ReasoningEffort)
	require.Equal(t, "high", *result.ReasoningEffort)
	require.Equal(t, stream, result.Stream)
	require.False(t, result.OpenAIWSMode)
	require.Equal(t, "/v1/responses", result.UpstreamEndpoint)
	require.Equal(t, "resp_compact_acceptance", result.ResponseID)
}

func normalCompactAcceptanceRetryEvent(t *testing.T, c *gin.Context, account *Account) {
	t.Helper()
	raw, ok := c.Get(OpsUpstreamErrorsKey)
	require.True(t, ok)
	events, ok := raw.([]*OpsUpstreamErrorEvent)
	require.True(t, ok)
	require.Len(t, events, 1, "failed compact attempt is a retry event, not a successful usage record")
	require.Equal(t, "retry", events[0].Kind)
	require.Equal(t, "compact_model_fallback", events[0].Reason)
	require.Equal(t, http.StatusOK, events[0].UpstreamStatusCode)
	require.Equal(t, account.ID, events[0].AccountID)
	require.False(t, events[0].Passthrough, "prove the ordinary Forward branch")
}

func normalCompactAcceptanceOutput(t *testing.T, recorder *httptest.ResponseRecorder, stream bool) {
	t.Helper()
	require.Equal(t, http.StatusOK, recorder.Code)
	require.NotContains(t, recorder.Body.String(), "model_not_found")
	require.NotContains(t, recorder.Body.String(), "unsupported_model")
	require.NotContains(t, recorder.Body.String(), "invalid_encrypted_content")
	require.NotContains(t, recorder.Body.String(), "response.failed")
	if stream {
		require.Contains(t, recorder.Body.String(), "response.completed")
	} else {
		require.True(t, json.Valid(recorder.Body.Bytes()))
	}
}

func normalCompactAcceptanceFailure() *http.Response {
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}},
		Body: io.NopCloser(strings.NewReader("event: response.failed\n" +
			`data: {"type":"response.failed","response":{"status":"failed","error":{"code":"unsupported_model","message":"The model is not supported for compaction"},"usage":{"input_tokens":811,"output_tokens":911,"input_tokens_details":{"cached_tokens":101}}}}` + "\n\n"))}
}

func normalCompactAcceptanceSuccess(stream bool, model string) *http.Response {
	body := `{"id":"resp_compact_acceptance","status":"completed","model":"` + model + `","service_tier":"default","output":[],"usage":{"input_tokens":17,"output_tokens":9,"input_tokens_details":{"cached_tokens":5}}}`
	contentType := "application/json"
	if stream {
		body = "event: response.completed\n" + `data: {"type":"response.completed","response":` + body + "}\n\n"
		contentType = "text/event-stream"
	}
	return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{contentType}}, Body: io.NopCloser(strings.NewReader(body))}
}
