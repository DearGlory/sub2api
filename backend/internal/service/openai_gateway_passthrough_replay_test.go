//go:build unit

package service

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

type passthroughHoldUpstream struct {
	started      chan struct{}
	release      chan struct{}
	calls        int
	retain       bool
	last         []byte
	sawInvalidID bool
	body         io.ReadCloser
}

func (u *passthroughHoldUpstream) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	if req != nil && req.Body != nil {
		b, _ := io.ReadAll(req.Body)
		u.sawInvalidID = bytes.Contains(b, []byte(`"id":"item_invalid"`))
		if u.retain {
			u.last = append([]byte(nil), b...)
		}
		_ = req.Body.Close()
	}
	u.calls++
	body := u.body
	if body == nil {
		body = io.NopCloser(strings.NewReader(""))
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Request:    req,
		Body:       body,
	}, nil
}

func (u *passthroughHoldUpstream) DoWithTLS(req *http.Request, proxyURL string, accountID int64, accountConcurrency int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(req, proxyURL, accountID, accountConcurrency)
}

type passthroughHoldBody struct {
	started chan struct{}
	release chan struct{}
	once    bool
	rest    *strings.Reader
	err     error
}

func (b *passthroughHoldBody) Read(p []byte) (int, error) {
	if !b.once {
		b.once = true
		if b.started != nil {
			close(b.started)
		}
		if b.release != nil {
			<-b.release
		}
		if b.err != nil {
			return 0, b.err
		}
	}
	if b.rest == nil {
		return 0, io.EOF
	}
	return b.rest.Read(p)
}

func (b *passthroughHoldBody) Close() error { return nil }

type passthroughSpillCloseBody struct {
	rest  io.Reader
	close func()
	once  bool
}

func (b *passthroughSpillCloseBody) Read(p []byte) (int, error) {
	if !b.once {
		b.once = true
		if b.close != nil {
			b.close()
		}
	}
	if b.rest == nil {
		return 0, io.EOF
	}
	return b.rest.Read(p)
}

func (b *passthroughSpillCloseBody) Close() error { return nil }

func TestParkOpenAIPassthroughReplaySpillsLargeBodyAndRemovesFile(t *testing.T) {
	payload := bytes.Repeat([]byte("z"), openAIPassthroughReplayMemoryLimit+1)
	budget := newOpenAIPassthroughReplayBudget(openAIPassthroughReplayDiskBudgetBytes)
	replay, err := parkOpenAIPassthroughReplay(payload, int64(len(payload)), &openAIPassthroughReplayStore{budget: budget})
	require.NoError(t, err)
	require.NotNil(t, replay)
	require.Nil(t, replay.memory)
	require.Equal(t, int64(len(payload)), budget.used.Load())
	if runtime.GOOS != "windows" {
		require.Empty(t, replay.path)
	}
	path := replay.path
	payload = nil
	got, err := replay.bytes()
	require.NoError(t, err)
	require.Equal(t, openAIPassthroughReplayMemoryLimit+1, len(got))
	require.Equal(t, byte('z'), got[0])
	require.Equal(t, byte('z'), got[len(got)-1])
	require.NoError(t, replay.release())
	if path != "" {
		_, statErr := os.Stat(path)
		require.ErrorIs(t, statErr, os.ErrNotExist)
	}
	_, err = replay.bytes()
	require.Error(t, err)
	require.Zero(t, budget.used.Load())
}

func TestParkOpenAIPassthroughReplayKeepsSmallBodyInMemory(t *testing.T) {
	payload := []byte(`{"model":"gpt-test"}`)
	creates := 0
	replay, err := parkOpenAIPassthroughReplay(payload, openAIPassthroughReplayDefaultRequestLimit, &openAIPassthroughReplayStore{
		createTemp: func() (*os.File, error) {
			creates++
			return nil, errors.New("disk should not be used")
		},
	})
	require.NoError(t, err)
	require.Equal(t, payload, replay.memory)
	require.Empty(t, replay.path)
	require.Zero(t, creates)
	got, err := replay.bytes()
	require.NoError(t, err)
	require.Equal(t, payload, got)
	require.NoError(t, replay.release())
	require.Nil(t, replay.memory)
}

func TestBuildUpstreamRequestOpenAIPassthroughReleasesReplay(t *testing.T) {
	gin.SetMode(gin.TestMode)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	account := newOpenAIImageGenerationControlTestAccount()
	body := []byte(`{"model":"gpt-test","input":"x"}`)
	svc := newOpenAIImageGenerationControlTestService(nil)
	req, err := svc.buildUpstreamRequestOpenAIPassthrough(context.Background(), c, account, body, "tok")
	require.NoError(t, err)
	replay, err := req.GetBody()
	require.NoError(t, err)
	got, err := io.ReadAll(replay)
	require.NoError(t, err)
	require.Equal(t, body, got)
	require.NoError(t, replay.Close())
	getBody := req.GetBody
	releaseOpenAIPassthroughUpstreamRequest(req)
	_, err = getBody()
	require.Error(t, err)
	require.Nil(t, req.GetBody)
	runtime.KeepAlive(body)
}

func TestOpenAIPassthroughStreamArmDropsTransformedBodyWhilePending(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"gpt-test","stream":true,"service_tier":"priority","input":[{"type":"message","id":"item_invalid","role":"user","content":[{"type":"input_text","text":"` + strings.Repeat("a", 16<<20) + `"}]}]}`)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}
	started := make(chan struct{})
	release := make(chan struct{})
	sse := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\ndata: [DONE]\n\n"
	u := &passthroughHoldUpstream{
		started: started,
		release: release,
		body: &passthroughHoldBody{
			started: started,
			release: release,
			rest:    strings.NewReader(sse),
		},
	}
	s := newOpenAIImageGenerationControlTestService(nil)
	s.httpUpstream = u
	runtime.GC()
	runtime.GC()
	var before, during runtime.MemStats
	runtime.ReadMemStats(&before)
	done := make(chan error, 1)
	var result *OpenAIForwardResult
	go func() {
		var err error
		result, err = s.Forward(context.Background(), c, account, body)
		done <- err
	}()
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("exited before stream read: %v", err)
	case <-time.After(20 * time.Second):
		close(release)
		t.Fatal("stream read not reached")
	}
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&during)
	extra := int64(during.HeapAlloc) - int64(before.HeapAlloc)
	close(release)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(20 * time.Second):
		t.Fatal("stream arm did not finish")
	}
	require.NotNil(t, result)
	require.NotNil(t, result.ServiceTier)
	require.Equal(t, "priority", *result.ServiceTier)
	require.Equal(t, 1, u.calls)
	require.False(t, u.sawInvalidID)
	require.Contains(t, string(body), `"id":"item_invalid"`)
	t.Logf("stream arm extra_retained_while_response_pending=%d", extra)
	if extra > 8<<20 {
		t.Errorf("stream arm retained transformed body: %d", extra)
	}
	runtime.KeepAlive(body)
	runtime.KeepAlive(c)
	runtime.KeepAlive(u)
}

func TestOpenAIPassthroughStreamCancelDoesNotRetry(t *testing.T) {
	gin.SetMode(gin.TestMode)
	const marker = "CANCELMARKER"
	body := []byte(`{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + marker + `"}]}]}`)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}
	started := make(chan struct{})
	stop := make(chan struct{})
	u := &passthroughHoldUpstream{
		started: started,
		retain:  true,
		body: &passthroughHoldBody{
			started: started,
			release: stop,
			err:     context.Canceled,
		},
	}
	s := newOpenAIImageGenerationControlTestService(nil)
	s.httpUpstream = u
	done := make(chan error, 1)
	go func() {
		_, err := s.Forward(context.Background(), c, account, body)
		done <- err
	}()
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("exited before cancel point: %v", err)
	case <-time.After(20 * time.Second):
		close(stop)
		t.Fatal("stream read not reached")
	}
	close(stop)
	select {
	case err := <-done:
		require.Error(t, err)
		require.ErrorContains(t, err, "stream usage incomplete")
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(20 * time.Second):
		t.Fatal("cancel did not finish")
	}
	require.Equal(t, 1, u.calls)
	require.Contains(t, string(u.last), marker)
	require.Contains(t, string(body), marker)
}

func TestOpenAIPassthroughCompactFallbackReloadsSpilledBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	marker := strings.Repeat("q", openAIPassthroughReplayMemoryLimit+64)
	body := []byte(`{"model":"gpt-5.5","stream":true,"service_tier":"priority","instructions":"compact-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + marker + `"}]},{"type":"compaction_trigger"}]}`)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	MarkOpenAINativeCompactionV2(c)
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}
	failed := "event: response.failed\n" +
		`data: {"type":"response.failed","response":{"status":"failed","error":{"code":"context_length_exceeded","message":"context window exceeded"}}}` + "\n\n"
	completed := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_compact\",\"status\":\"completed\",\"model\":\"gpt-5.4\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\ndata: [DONE]\n\n"
	upstream := &httpUpstreamRecorder{responses: []*http.Response{
		{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(failed))},
		{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(completed))},
	}}
	svc := newOpenAIImageGenerationControlTestService(nil)
	svc.httpUpstream = upstream
	svc.cfg = &config.Config{Gateway: config.GatewayConfig{OpenAICompactModel: "gpt-5.4"}}

	result, err := svc.Forward(context.Background(), c, account, body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.NotNil(t, result.ServiceTier)
	require.Equal(t, "priority", *result.ServiceTier)
	require.Len(t, upstream.bodies, 2)
	require.Equal(t, "gpt-5.5", gjson.GetBytes(upstream.bodies[0], "model").String())
	require.Equal(t, "gpt-5.4", gjson.GetBytes(upstream.bodies[1], "model").String())
	require.Contains(t, string(upstream.bodies[0]), marker)
	require.Contains(t, string(upstream.bodies[1]), marker)
	require.Equal(t, "gpt-5.5", gjson.GetBytes(body, "model").String())
	require.Contains(t, string(body), marker)
	require.Equal(t, "gpt-5.4", result.UpstreamModel)
	require.Equal(t, 1, result.Usage.InputTokens)
	require.Equal(t, 1, result.Usage.OutputTokens)
}

func TestParkOpenAIPassthroughReplayRejectsOverLimitWithoutMemory(t *testing.T) {
	marker := strings.Repeat("m", 64)
	payload := []byte(marker + strings.Repeat("x", 32))
	replay, err := parkOpenAIPassthroughReplay(payload, 16, nil)
	require.Nil(t, replay)
	require.Error(t, err)
	require.ErrorContains(t, err, "request limit")
	require.ErrorContains(t, err, "bytes=96")
	require.NotContains(t, err.Error(), marker)
}

func TestParkOpenAIPassthroughReplayBudgetAndIOFailuresDoNotKeepMemory(t *testing.T) {
	marker := strings.Repeat("q", 48)
	payload := bytes.Repeat([]byte("q"), openAIPassthroughReplayMemoryLimit+64)
	require.Contains(t, string(payload), marker)

	t.Run("budget", func(t *testing.T) {
		budget := newOpenAIPassthroughReplayBudget(32)
		creates := 0
		replay, err := parkOpenAIPassthroughReplay(payload, int64(len(payload)), &openAIPassthroughReplayStore{
			budget: budget,
			createTemp: func() (*os.File, error) {
				creates++
				return nil, errors.New("create should not run")
			},
		})
		require.Nil(t, replay)
		require.Error(t, err)
		require.ErrorContains(t, err, "disk budget exceeded")
		require.NotContains(t, err.Error(), marker)
		require.Zero(t, creates)
		require.Zero(t, budget.used.Load())
	})

	t.Run("create", func(t *testing.T) {
		budget := newOpenAIPassthroughReplayBudget(int64(len(payload) + 1))
		replay, err := parkOpenAIPassthroughReplay(payload, int64(len(payload)), &openAIPassthroughReplayStore{
			budget: budget,
			createTemp: func() (*os.File, error) {
				return nil, errors.New("disk unavailable")
			},
		})
		require.Nil(t, replay)
		require.Error(t, err)
		require.ErrorContains(t, err, "disk unavailable")
		require.NotContains(t, err.Error(), marker)
		require.Zero(t, budget.used.Load())
	})

	t.Run("write", func(t *testing.T) {
		budget := newOpenAIPassthroughReplayBudget(int64(len(payload) + 1))
		var created []string
		replay, err := parkOpenAIPassthroughReplay(payload, int64(len(payload)), &openAIPassthroughReplayStore{
			budget: budget,
			createTemp: func() (*os.File, error) {
				file, createErr := os.CreateTemp("", "sub2api-openai-passthrough-replay-test-*")
				if createErr != nil {
					return nil, createErr
				}
				created = append(created, file.Name())
				require.NoError(t, file.Close())
				return file, nil
			},
		})
		t.Cleanup(func() {
			for _, path := range created {
				_ = os.Remove(path)
			}
		})
		require.Nil(t, replay)
		require.Error(t, err)
		require.ErrorContains(t, err, "write openai passthrough compact replay")
		require.NotContains(t, err.Error(), marker)
		require.Zero(t, budget.used.Load())
		for _, path := range created {
			_, statErr := os.Stat(path)
			require.ErrorIs(t, statErr, os.ErrNotExist)
		}
	})

	if runtime.GOOS == "windows" {
		t.Run("windows remove failure keeps reservation", func(t *testing.T) {
			budget := newOpenAIPassthroughReplayBudget(int64(len(payload) + 1))
			var created []string
			replay, err := parkOpenAIPassthroughReplay(payload, int64(len(payload)), &openAIPassthroughReplayStore{
				budget: budget,
				createTemp: func() (*os.File, error) {
					file, createErr := os.CreateTemp("", "sub2api-openai-passthrough-replay-test-*")
					if createErr != nil {
						return nil, createErr
					}
					created = append(created, file.Name())
					return file, nil
				},
				removeFile: func(string) error { return errors.New("remove denied") },
			})
			require.NoError(t, err)
			require.NotNil(t, replay)
			require.Nil(t, replay.memory)
			t.Cleanup(func() {
				for _, path := range created {
					_ = os.Remove(path)
				}
			})
			relErr := replay.release()
			require.Error(t, relErr)
			require.ErrorContains(t, relErr, "remove denied")
			require.NotContains(t, relErr.Error(), marker)
			require.Equal(t, int64(len(payload)), budget.used.Load())
			replay.removeFile = os.Remove
			require.NoError(t, replay.release())
			require.Zero(t, budget.used.Load())
		})
		return
	}

	t.Run("unix unlink failure", func(t *testing.T) {
		budget := newOpenAIPassthroughReplayBudget(int64(len(payload) + 1))
		var created []string
		replay, err := parkOpenAIPassthroughReplay(payload, int64(len(payload)), &openAIPassthroughReplayStore{
			budget: budget,
			createTemp: func() (*os.File, error) {
				file, createErr := os.CreateTemp("", "sub2api-openai-passthrough-replay-test-*")
				if createErr != nil {
					return nil, createErr
				}
				created = append(created, file.Name())
				return file, nil
			},
			removeFile: func(string) error { return errors.New("unlink denied") },
		})
		t.Cleanup(func() {
			for _, path := range created {
				_ = os.Remove(path)
			}
		})
		require.Nil(t, replay)
		require.Error(t, err)
		require.ErrorContains(t, err, "unlink openai passthrough compact replay before use")
		require.NotContains(t, err.Error(), marker)
		require.Zero(t, budget.used.Load())
	})
}

func TestOpenAIPassthroughNonCompactLargeResponseDoesNotSpill(t *testing.T) {
	gin.SetMode(gin.TestMode)
	marker := "NO-SPILL-" + strings.Repeat("a", 16<<20)
	body := []byte(`{"model":"gpt-test","stream":true,"service_tier":"priority","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + marker + `"}]}]}`)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}
	started := make(chan struct{})
	release := make(chan struct{})
	sse := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\ndata: [DONE]\n\n"
	creates := 0
	u := &passthroughHoldUpstream{
		started: started,
		release: release,
		body: &passthroughHoldBody{
			started: started,
			release: release,
			rest:    strings.NewReader(sse),
		},
	}
	s := newOpenAIImageGenerationControlTestService(nil)
	s.httpUpstream = u
	s.passthroughReplayStore = &openAIPassthroughReplayStore{
		budget: newOpenAIPassthroughReplayBudget(1),
		createTemp: func() (*os.File, error) {
			creates++
			return nil, errors.New("non-compact response must not spill")
		},
	}
	done := make(chan error, 1)
	var result *OpenAIForwardResult
	go func() {
		var err error
		result, err = s.Forward(context.Background(), c, account, body)
		done <- err
	}()
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("exited before stream read: %v", err)
	case <-time.After(20 * time.Second):
		close(release)
		t.Fatal("stream read not reached")
	}
	require.Zero(t, creates)
	close(release)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(20 * time.Second):
		t.Fatal("non-compact response did not finish")
	}
	require.NotNil(t, result)
	require.NotNil(t, result.ServiceTier)
	require.Equal(t, "priority", *result.ServiceTier)
	require.Equal(t, 1, u.calls)
	require.Zero(t, creates)
	require.Zero(t, s.passthroughReplayStore.budget.used.Load())
}

func TestDecideOpenAIPassthroughReadErrorStopsOnContext(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc := &OpenAIGatewayService{cfg: &config.Config{Gateway: config.GatewayConfig{OpenAICompactModel: "gpt-5.4"}}}
	account := &Account{Name: "compact-account"}
	body := []byte(`{"model":"gpt-5.5","stream":true,"input":[{"type":"compaction_trigger"}]}`)
	signal := &openAICompactFallbackSignal{
		payload: []byte(`{"error":{"code":"context_length_exceeded","message":"context window exceeded"}}`),
		message: "context window exceeded",
	}
	newReplay := func() *openAIPassthroughReplay {
		return &openAIPassthroughReplay{memory: append([]byte(nil), body...), size: len(body), limit: openAIPassthroughReplayDefaultRequestLimit}
	}
	resp := func() *http.Response {
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("unused"))}
	}

	t.Run("cancel with successful replay", func(t *testing.T) {
		c := newOpenAICompactFallbackTestContext(t, "/v1/responses/compact")
		replay := newReplay()
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		decision := svc.decideOpenAIPassthroughReadError(ctx, resp(), c, account, "gpt-5.5", replay, signal, false)
		require.False(t, decision.retry)
		require.Nil(t, decision.body)
		require.ErrorIs(t, decision.err, context.Canceled)
		require.False(t, replay.released)
		got, err := replay.bytes()
		require.NoError(t, err)
		require.Equal(t, body, got)
	})

	t.Run("deadline keeps wrapped handle error", func(t *testing.T) {
		c := newOpenAICompactFallbackTestContext(t, "/v1/responses/compact")
		replay := newReplay()
		handleErr := errors.Join(context.DeadlineExceeded, signal)
		ctx, cancel := context.WithDeadline(context.Background(), time.Unix(0, 0))
		defer cancel()
		decision := svc.decideOpenAIPassthroughReadError(ctx, resp(), c, account, "gpt-5.5", replay, handleErr, false)
		require.False(t, decision.retry)
		require.Equal(t, handleErr, decision.err)
		require.ErrorIs(t, decision.err, context.DeadlineExceeded)
		require.False(t, replay.released)
	})

	t.Run("ordinary read error", func(t *testing.T) {
		c := newOpenAICompactFallbackTestContext(t, "/v1/responses/compact")
		replay := newReplay()
		handleErr := errors.New("ordinary read")
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		decision := svc.decideOpenAIPassthroughReadError(ctx, resp(), c, account, "gpt-5.5", replay, handleErr, false)
		require.False(t, decision.retry)
		require.Equal(t, handleErr, decision.err)
		require.False(t, replay.released)
	})
}

func TestOpenAIPassthroughCompactSuccessReleaseCloseKeepsBilling(t *testing.T) {
	gin.SetMode(gin.TestMode)
	marker := strings.Repeat("b", openAIPassthroughReplayMemoryLimit+32)
	body := []byte(`{"model":"gpt-test","stream":true,"service_tier":"priority","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + marker + `"}]}]}`)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	MarkOpenAINativeCompactionV2(c)
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}
	var spill *os.File
	var spillPath string
	budget := newOpenAIPassthroughReplayBudget(int64(len(body) + 1))
	sse := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_ok\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":2,\"output_tokens\":3}}}\n\ndata: [DONE]\n\n"
	u := &passthroughHoldUpstream{
		body: &passthroughSpillCloseBody{
			rest: strings.NewReader(sse),
			close: func() {
				if spill != nil {
					_ = spill.Close()
				}
			},
		},
	}
	s := newOpenAIImageGenerationControlTestService(nil)
	s.httpUpstream = u
	s.passthroughReplayStore = &openAIPassthroughReplayStore{
		budget: budget,
		createTemp: func() (*os.File, error) {
			file, err := os.CreateTemp("", "sub2api-openai-passthrough-replay-test-*")
			if err != nil {
				return nil, err
			}
			spill = file
			spillPath = file.Name()
			return file, nil
		},
	}
	t.Cleanup(func() {
		if spill != nil {
			_ = spill.Close()
		}
		if spillPath != "" {
			_ = os.Remove(spillPath)
		}
	})

	result, err := s.Forward(context.Background(), c, account, body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.NotNil(t, result.ServiceTier)
	require.Equal(t, "priority", *result.ServiceTier)
	require.Equal(t, 2, result.Usage.InputTokens)
	require.Equal(t, 3, result.Usage.OutputTokens)
	require.Equal(t, 1, u.calls)
	require.Zero(t, budget.used.Load())
}

func TestOpenAIPassthroughReplayWriteFailureKeepsNamedResidueReservation(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("named bytes left by a failed write are the Windows cleanup path")
	}
	dir := t.TempDir()
	payload := []byte(strings.Repeat("w", 32))
	parkReadOnly := func(t *testing.T, path string, budget *openAIPassthroughReplayBudget) error {
		t.Helper()
		replay, err := parkOpenAIPassthroughReplay(payload, int64(len(payload)+8), &openAIPassthroughReplayStore{
			budget: budget,
			createTemp: func() (*os.File, error) {
				return os.Open(path)
			},
			removeFile: func(string) error { return errors.New("remove denied") },
		})
		require.Nil(t, replay)
		return err
	}

	t.Run("residue", func(t *testing.T) {
		path := filepath.Join(dir, "residue")
		seed, err := os.Create(path)
		require.NoError(t, err)
		_, err = seed.Write([]byte("residue"))
		require.NoError(t, err)
		require.NoError(t, seed.Close())
		budget := newOpenAIPassthroughReplayBudget(int64(len(payload) + 8))
		err = parkReadOnly(t, path, budget)
		require.Error(t, err)
		require.ErrorContains(t, err, "remove denied")
		require.Equal(t, int64(len(payload)), budget.used.Load())
		info, statErr := os.Stat(path)
		require.NoError(t, statErr)
		require.Greater(t, info.Size(), int64(0))
	})

	t.Run("empty", func(t *testing.T) {
		path := filepath.Join(dir, "empty")
		seed, err := os.Create(path)
		require.NoError(t, err)
		require.NoError(t, seed.Close())
		budget := newOpenAIPassthroughReplayBudget(int64(len(payload) + 8))
		err = parkReadOnly(t, path, budget)
		require.Error(t, err)
		require.ErrorContains(t, err, "remove denied")
		require.Zero(t, budget.used.Load())
	})
}

func TestOpenAIPassthroughCompactDiskFailureDoesNotFallbackToMemory(t *testing.T) {
	marker := strings.Repeat("d", 64)
	payloadText := marker + strings.Repeat("d", openAIPassthroughReplayMemoryLimit)
	failed := "event: response.failed\n" +
		`data: {"type":"response.failed","response":{"status":"failed","error":{"code":"context_length_exceeded","message":"context window exceeded"}}}` + "\n\n"
	completed := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_compact\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\ndata: [DONE]\n\n"

	run := func(t *testing.T, store *openAIPassthroughReplayStore, want string) {
		t.Helper()
		gin.SetMode(gin.TestMode)
		body := []byte(`{"model":"gpt-5.5","stream":true,"service_tier":"priority","instructions":"compact-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + payloadText + `"}]},{"type":"compaction_trigger"}]}`)
		c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
		MarkOpenAINativeCompactionV2(c)
		account := newOpenAIImageGenerationControlTestAccount()
		account.Extra = map[string]any{"openai_passthrough": true}
		upstream := &httpUpstreamRecorder{responses: []*http.Response{
			{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(failed))},
			{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(completed))},
		}}
		svc := newOpenAIImageGenerationControlTestService(nil)
		svc.httpUpstream = upstream
		svc.cfg = &config.Config{Gateway: config.GatewayConfig{OpenAICompactModel: "gpt-5.4", MaxBodySize: int64(len(body) + 1024)}}
		svc.passthroughReplayStore = store

		result, err := svc.Forward(context.Background(), c, account, body)
		require.Nil(t, result)
		require.Error(t, err)
		require.ErrorContains(t, err, want)
		require.NotContains(t, err.Error(), marker)
		require.Equal(t, 1, len(upstream.bodies))
		require.Contains(t, string(upstream.bodies[0]), marker)
		require.Zero(t, store.budget.used.Load())
	}

	t.Run("budget", func(t *testing.T) {
		run(t, &openAIPassthroughReplayStore{
			budget: newOpenAIPassthroughReplayBudget(32),
			createTemp: func() (*os.File, error) {
				t.Fatal("budget exhaustion created a temp file")
				return nil, errors.New("unreachable")
			},
		}, "disk budget exceeded")
	})
	t.Run("disk", func(t *testing.T) {
		run(t, &openAIPassthroughReplayStore{
			budget: newOpenAIPassthroughReplayBudget(32 << 20),
			createTemp: func() (*os.File, error) {
				return nil, errors.New("disk unavailable")
			},
		}, "disk unavailable")
	})
}

func TestOpenAIPassthroughLargeBodyCancelKeepsOriginalError(t *testing.T) {
	gin.SetMode(gin.TestMode)
	marker := strings.Repeat("c", 16<<20)
	body := []byte(`{"model":"gpt-test","stream":true,"input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + marker + `"}]}]}`)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}
	started := make(chan struct{})
	stop := make(chan struct{})
	creates := 0
	u := &passthroughHoldUpstream{
		started: started,
		retain:  true,
		body: &passthroughHoldBody{
			started: started,
			release: stop,
			err:     context.Canceled,
		},
	}
	s := newOpenAIImageGenerationControlTestService(nil)
	s.httpUpstream = u
	s.passthroughReplayStore = &openAIPassthroughReplayStore{
		budget: newOpenAIPassthroughReplayBudget(1),
		createTemp: func() (*os.File, error) {
			creates++
			return nil, errors.New("cancel must not spill")
		},
		failRead: errors.New("read openai passthrough compact replay: injected"),
	}
	done := make(chan error, 1)
	go func() {
		_, err := s.Forward(context.Background(), c, account, body)
		done <- err
	}()
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("exited before cancel point: %v", err)
	case <-time.After(20 * time.Second):
		close(stop)
		t.Fatal("stream read not reached")
	}
	close(stop)
	select {
	case err := <-done:
		require.Error(t, err)
		require.ErrorContains(t, err, "stream usage incomplete")
		require.ErrorIs(t, err, context.Canceled)
		require.NotContains(t, err.Error(), "compact replay")
		require.NotContains(t, err.Error(), marker[:32])
	case <-time.After(20 * time.Second):
		t.Fatal("cancel did not finish")
	}
	require.Equal(t, 1, u.calls)
	require.Contains(t, string(u.last), marker[:32])
	require.Zero(t, creates)

	t.Run("compact spill read failure does not replace cancel", func(t *testing.T) {
		compactMarker := strings.Repeat("k", openAIPassthroughReplayMemoryLimit+32)
		compactBody := []byte(`{"model":"gpt-5.5","stream":true,"instructions":"compact-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + compactMarker + `"}]},{"type":"compaction_trigger"}]}`)
		compactCtx, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
		MarkOpenAINativeCompactionV2(compactCtx)
		compactAccount := newOpenAIImageGenerationControlTestAccount()
		compactAccount.Extra = map[string]any{"openai_passthrough": true}
		compactStarted := make(chan struct{})
		compactStop := make(chan struct{})
		compactUpstream := &passthroughHoldUpstream{
			started: compactStarted,
			body: &passthroughHoldBody{
				started: compactStarted,
				release: compactStop,
				err:     context.Canceled,
			},
		}
		svc := newOpenAIImageGenerationControlTestService(nil)
		svc.httpUpstream = compactUpstream
		svc.cfg = &config.Config{Gateway: config.GatewayConfig{OpenAICompactModel: "gpt-5.4"}}
		svc.passthroughReplayStore = &openAIPassthroughReplayStore{
			budget:   newOpenAIPassthroughReplayBudget(32 << 20),
			failRead: errors.New("read openai passthrough compact replay: injected"),
		}
		compactDone := make(chan error, 1)
		go func() {
			_, err := svc.Forward(context.Background(), compactCtx, compactAccount, compactBody)
			compactDone <- err
		}()
		select {
		case <-compactStarted:
		case err := <-compactDone:
			t.Fatalf("exited before compact cancel point: %v", err)
		case <-time.After(20 * time.Second):
			close(compactStop)
			t.Fatal("compact cancel read not reached")
		}
		close(compactStop)
		select {
		case err := <-compactDone:
			require.Error(t, err)
			require.ErrorContains(t, err, "stream usage incomplete")
			require.ErrorIs(t, err, context.Canceled)
			require.NotContains(t, err.Error(), "injected")
			require.NotContains(t, err.Error(), compactMarker[:32])
		case <-time.After(20 * time.Second):
			t.Fatal("compact cancel did not finish")
		}
		require.Equal(t, 1, compactUpstream.calls)
		require.Zero(t, svc.passthroughReplayStore.budget.used.Load())
	})
}

type passthroughAsyncUploadUpstream struct {
	mu          sync.Mutex
	calls       int
	uploaded    []byte
	uploadErr   error
	releaseRead chan struct{}
	got         chan struct{}
	body        io.ReadCloser
}

func (u *passthroughAsyncUploadUpstream) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	u.mu.Lock()
	u.calls++
	u.mu.Unlock()
	started := make(chan struct{})
	go func() {
		buf := make([]byte, 1)
		n, err := req.Body.Read(buf)
		close(started)
		if err != nil && n == 0 {
			u.mu.Lock()
			u.uploadErr = err
			u.mu.Unlock()
			close(u.got)
			return
		}
		<-u.releaseRead
		rest, readErr := io.ReadAll(req.Body)
		_ = req.Body.Close()
		u.mu.Lock()
		u.uploaded = append(buf[:n], rest...)
		u.uploadErr = readErr
		u.mu.Unlock()
		close(u.got)
	}()
	select {
	case <-started:
	case <-time.After(20 * time.Second):
		return nil, errors.New("async upload did not start")
	}
	body := u.body
	if body == nil {
		body = io.NopCloser(strings.NewReader(""))
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Request:    req,
		Body:       body,
	}, nil
}

func (u *passthroughAsyncUploadUpstream) DoWithTLS(req *http.Request, proxyURL string, accountID int64, accountConcurrency int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(req, proxyURL, accountID, accountConcurrency)
}

func TestOpenAIPassthroughAsyncUploadCompletesAfterHeaders(t *testing.T) {
	gin.SetMode(gin.TestMode)
	marker := strings.Repeat("u", 2<<20)
	body := []byte(`{"model":"gpt-test","stream":true,"service_tier":"priority","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + marker + `"}]}]}`)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = map[string]any{"openai_passthrough": true}
	responseStarted := make(chan struct{})
	responseRelease := make(chan struct{})
	sse := "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}}\n\ndata: [DONE]\n\n"
	creates := 0
	upstream := &passthroughAsyncUploadUpstream{
		releaseRead: make(chan struct{}),
		got:         make(chan struct{}),
		body: &passthroughHoldBody{
			started: responseStarted,
			release: responseRelease,
			rest:    strings.NewReader(sse),
		},
	}
	s := newOpenAIImageGenerationControlTestService(nil)
	s.httpUpstream = upstream
	s.passthroughReplayStore = &openAIPassthroughReplayStore{
		budget: newOpenAIPassthroughReplayBudget(1),
		createTemp: func() (*os.File, error) {
			creates++
			return nil, errors.New("async non-compact upload must not spill")
		},
	}
	done := make(chan error, 1)
	var result *OpenAIForwardResult
	go func() {
		var err error
		result, err = s.Forward(context.Background(), c, account, body)
		done <- err
	}()
	select {
	case <-responseStarted:
	case err := <-done:
		t.Fatalf("exited before async upload overlap: %v", err)
	case <-time.After(20 * time.Second):
		close(upstream.releaseRead)
		close(responseRelease)
		t.Fatal("response read not reached")
	}
	require.Zero(t, creates)
	close(upstream.releaseRead)
	select {
	case <-upstream.got:
	case <-time.After(20 * time.Second):
		close(responseRelease)
		t.Fatal("async upload did not finish")
	}
	upstream.mu.Lock()
	uploaded := append([]byte(nil), upstream.uploaded...)
	uploadErr := upstream.uploadErr
	upstream.mu.Unlock()
	require.NoError(t, uploadErr)
	require.Contains(t, string(uploaded), marker)
	require.GreaterOrEqual(t, len(uploaded), len(marker))
	close(responseRelease)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(20 * time.Second):
		t.Fatal("async upload request did not finish")
	}
	require.NotNil(t, result)
	require.NotNil(t, result.ServiceTier)
	require.Equal(t, "priority", *result.ServiceTier)
	require.Equal(t, 1, upstream.calls)
	require.Zero(t, creates)
	require.Zero(t, s.passthroughReplayStore.budget.used.Load())
}
