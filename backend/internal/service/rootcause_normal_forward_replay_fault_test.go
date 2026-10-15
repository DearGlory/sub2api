//go:build unit

package service

import (
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

const normalReplayFaultMarker = "normal-forward-private-marker-57b0"

const normalReplayFaultFailedSSE = "event: response.failed\n" +
	`data: {"type":"response.failed","response":{"status":"failed","error":{"code":"context_length_exceeded","message":"context window exceeded"}}}` + "\n\n"

const normalReplayFaultCompletedSSE = "event: response.completed\n" +
	`data: {"type":"response.completed","response":{"id":"normal-replay-ok","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3}}}` + "\n\ndata: [DONE]\n\n"

func normalReplayFaultBody(t *testing.T) []byte {
	t.Helper()
	body := []byte(`{"model":"gpt-5.5","stream":true,"instructions":"compact-test","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"` + normalReplayFaultMarker + strings.Repeat("r", openAIPassthroughReplayMemoryLimit+64) + `"}]},{"type":"compaction_trigger"}]}`)
	require.True(t, gjson.ValidBytes(body))
	require.Greater(t, len(body), openAIPassthroughReplayMemoryLimit)
	require.True(t, HasCompactionTriggerInInput(body))
	return body
}

// This transport double keeps only scalars/digests, not a large upload. It
// returns HTTP 200 before Forward can park. Both transport entry points share
// the counter; reaching a third Do produces an error instead of looping.
type normalReplayFaultUpstream struct {
	calls         int
	firstReturned bool
	lengths       []int
	textHashes    [][sha256.Size]byte
	models        []string
	first         io.ReadCloser
	next          io.ReadCloser
	secondErr     error
}

func (u *normalReplayFaultUpstream) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	u.calls++
	if u.calls > 2 {
		return nil, errors.New("unexpected third normal Forward Do")
	}
	if u.calls == 2 && u.secondErr != nil {
		return nil, u.secondErr
	}
	if req == nil || req.Body == nil {
		return nil, errors.New("normal Forward upload missing")
	}
	body, err := io.ReadAll(req.Body)
	closeErr := req.Body.Close()
	if err != nil || closeErr != nil {
		return nil, errors.Join(err, closeErr)
	}
	if !gjson.ValidBytes(body) {
		return nil, errors.New("normal Forward upload is not JSON")
	}
	u.lengths = append(u.lengths, len(body))
	u.models = append(u.models, gjson.GetBytes(body, "model").String())
	u.textHashes = append(u.textHashes, sha256.Sum256([]byte(gjson.GetBytes(body, "input.0.content.0.text").String())))
	responseBody := u.next
	if u.calls == 1 {
		responseBody = u.first
		u.firstReturned = true
	}
	return &http.Response{
		StatusCode: http.StatusOK,
		Header:     http.Header{"Content-Type": []string{"text/event-stream"}},
		Request:    req,
		Body:       responseBody,
	}, nil
}

func (u *normalReplayFaultUpstream) DoWithTLS(req *http.Request, proxyURL string, accountID int64, concurrency int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(req, proxyURL, accountID, concurrency)
}

// First actual response Read is a synchronous control point. Its callback
// alters the already-written file or cancels the real context before Read
// returns, without sleep, unsafe, or scheduler-dependent cancellation.
type normalReplayFaultResponseBody struct {
	reader     io.Reader
	beforeRead func()
	reads      int
	closed     bool
}

func (b *normalReplayFaultResponseBody) Read(p []byte) (int, error) {
	b.reads++
	if b.reads == 1 && b.beforeRead != nil {
		b.beforeRead()
	}
	return b.reader.Read(p)
}

func (b *normalReplayFaultResponseBody) Close() error {
	b.closed = true
	return nil
}

type normalReplayFaultHarness struct {
	svc      *OpenAIGatewayService
	c        *gin.Context
	recorder *httptest.ResponseRecorder
	account  *Account
	body     []byte
	upstream *normalReplayFaultUpstream
	response *normalReplayFaultResponseBody
	store    *openAIPassthroughReplayStore
	file     *os.File
	path     string
	creates  int
	reserved int64
}

func newNormalReplayFaultHarness(t *testing.T) *normalReplayFaultHarness {
	t.Helper()
	gin.SetMode(gin.TestMode)
	h := &normalReplayFaultHarness{body: normalReplayFaultBody(t)}
	h.c, h.recorder = newOpenAIImageGenerationControlTestContext(true, "synthetic")
	MarkOpenAINativeCompactionV2(h.c)
	h.account = newOpenAIImageGenerationControlTestAccount()
	h.account.Extra = nil
	require.False(t, h.account.IsOpenAIPassthroughEnabled())
	require.True(t, isExplicitOpenAICompactContext(h.c))
	require.True(t, isExplicitOpenAICompactRequest(h.c, h.body))
	h.response = &normalReplayFaultResponseBody{reader: strings.NewReader(normalReplayFaultFailedSSE)}
	h.upstream = &normalReplayFaultUpstream{
		first: h.response,
		next:  io.NopCloser(strings.NewReader(normalReplayFaultCompletedSSE)),
	}
	h.svc = newOpenAIImageGenerationControlTestService(nil)
	h.svc.httpUpstream = h.upstream
	h.svc.cfg = &config.Config{Gateway: config.GatewayConfig{
		OpenAICompactModel: "gpt-5.4",
		MaxBodySize:        int64(len(h.body) + 4096),
	}}
	dir := t.TempDir()
	h.store = &openAIPassthroughReplayStore{
		budget: newOpenAIPassthroughReplayBudget(32 << 20),
		createTemp: func() (*os.File, error) {
			h.creates++
			require.True(t, h.upstream.firstReturned, "spill must follow the first Do returning 200")
			require.Equal(t, 1, h.upstream.calls)
			require.Zero(t, h.response.reads, "park precedes the first response Read")
			h.reserved = h.store.budget.used.Load()
			require.Greater(t, h.reserved, int64(openAIPassthroughReplayMemoryLimit))
			file, err := os.CreateTemp(dir, "normal-forward-replay-*")
			if file != nil {
				h.file = file
				h.path = file.Name()
			}
			return file, err
		},
	}
	h.svc.passthroughReplayStore = h.store
	t.Cleanup(func() {
		if h.file != nil {
			_ = h.file.Close()
		}
		if h.path != "" {
			_ = os.Remove(h.path)
		}
	})
	return h
}

func (h *normalReplayFaultHarness) assertUploaded(t *testing.T) {
	t.Helper()
	require.True(t, h.upstream.firstReturned)
	require.Equal(t, 1, h.upstream.calls)
	require.Len(t, h.upstream.lengths, 1)
	require.Greater(t, h.upstream.lengths[0], openAIPassthroughReplayMemoryLimit)
	text := gjson.GetBytes(h.body, "input.0.content.0.text").String()
	require.Equal(t, sha256.Sum256([]byte(text)), h.upstream.textHashes[0])
	require.Equal(t, "gpt-5.5", h.upstream.models[0])
}

func (h *normalReplayFaultHarness) assertDiskParked(t *testing.T) {
	t.Helper()
	require.NotNil(t, h.file)
	require.Equal(t, 1, h.creates)
	require.Greater(t, h.reserved, int64(openAIPassthroughReplayMemoryLimit))
	require.Equal(t, h.reserved, h.store.budget.used.Load())
	info, err := h.file.Stat()
	require.NoError(t, err)
	require.Equal(t, h.reserved, info.Size())
	require.Equal(t, int64(h.upstream.lengths[0]), info.Size())
	if runtime.GOOS != "windows" {
		_, err = os.Stat(h.path)
		require.ErrorIs(t, err, os.ErrNotExist, "Unix must unlink before Write")
	}
}

func (h *normalReplayFaultHarness) assertFileGone(t *testing.T) {
	t.Helper()
	if h.file != nil {
		_, err := h.file.Stat()
		require.ErrorIs(t, err, os.ErrClosed)
	}
	if h.path != "" {
		_, err := os.Stat(h.path)
		require.ErrorIs(t, err, os.ErrNotExist)
	}
}

func (h *normalReplayFaultHarness) assertFailedClosed(t *testing.T, result *OpenAIForwardResult, err error, want string) {
	t.Helper()
	require.Nil(t, result)
	require.ErrorContains(t, err, want)
	require.NotContains(t, err.Error(), normalReplayFaultMarker)
	require.NotContains(t, h.recorder.Body.String(), normalReplayFaultMarker)
	h.assertUploaded(t)
	require.True(t, h.response.closed)
}

func TestNormalForwardCompactReplayBudgetFailureStopsAfterFirst200(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	h.store.budget = newOpenAIPassthroughReplayBudget(1)
	h.store.createTemp = func() (*os.File, error) {
		h.creates++
		return nil, errors.New("must not create after budget denial")
	}
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	h.assertFailedClosed(t, result, err, "disk budget exceeded")
	require.Zero(t, h.creates)
	require.Zero(t, h.response.reads, "no response read or heap retry after denied park")
	require.Zero(t, h.store.budget.used.Load())
}

func TestNormalForwardCompactReplayCreateFailureStopsAfterFirst200(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	injected := errors.New("normal replay create denied")
	h.store.createTemp = func() (*os.File, error) {
		h.creates++
		require.True(t, h.upstream.firstReturned)
		require.Equal(t, 1, h.upstream.calls)
		require.Zero(t, h.response.reads)
		require.Greater(t, h.store.budget.used.Load(), int64(openAIPassthroughReplayMemoryLimit))
		return nil, injected
	}
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	h.assertFailedClosed(t, result, err, "create openai passthrough compact replay")
	require.ErrorIs(t, err, injected)
	require.Equal(t, 1, h.creates)
	require.Zero(t, h.response.reads)
	require.Zero(t, h.store.budget.used.Load())
}

func TestNormalForwardCompactReplayReadOnlyWriteFailureStopsAfterFirst200(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	create := h.store.createTemp
	h.store.createTemp = func() (*os.File, error) {
		file, err := create()
		if err != nil {
			return nil, err
		}
		if err := file.Close(); err != nil {
			return nil, err
		}
		h.file, err = os.Open(h.path) // Actual read-only descriptor: Write fails.
		return h.file, err
	}
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	h.assertFailedClosed(t, result, err, "write openai passthrough compact replay")
	var pathErr *os.PathError
	require.ErrorAs(t, err, &pathErr)
	require.Equal(t, "write", pathErr.Op)
	require.Equal(t, 1, h.creates)
	require.Zero(t, h.response.reads)
	require.Zero(t, h.store.budget.used.Load())
	h.assertFileGone(t)
}

func TestNormalForwardCompactReplayUnixDetachFailureStopsBeforeResponseRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix early unlink failure; Windows instead retains the name")
	}
	h := newNormalReplayFaultHarness(t)
	injected := errors.New("normal replay unlink denied")
	removes := 0
	h.store.removeFile = func(string) error {
		removes++
		return injected
	}
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	h.assertFailedClosed(t, result, err, "unlink openai passthrough compact replay before use")
	require.ErrorIs(t, err, injected)
	require.Equal(t, 1, h.creates)
	require.Equal(t, 2, removes, "unlink before Write and retry after Close")
	require.Zero(t, h.response.reads)
	require.Zero(t, h.store.budget.used.Load(), "empty never-written spill does not reserve body bytes")
	_, statErr := h.file.Stat()
	require.ErrorIs(t, statErr, os.ErrClosed)
	info, statErr := os.Stat(h.path)
	require.NoError(t, statErr)
	require.Zero(t, info.Size(), "failed detach must leave no plaintext body")
	require.NoError(t, os.Remove(h.path)) // Test teardown of an empty name.
}

func TestNormalForwardCompactReplayShortDiskReadStopsBeforeSecondDo(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	h.response.beforeRead = func() {
		h.assertDiskParked(t)
		require.NoError(t, h.file.Truncate(1))
	}
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	h.assertFailedClosed(t, result, err, "read openai passthrough compact replay")
	require.ErrorIs(t, err, io.ErrUnexpectedEOF)
	require.Positive(t, h.response.reads)
	require.Zero(t, h.store.budget.used.Load())
	h.assertFileGone(t)
}

func TestNormalForwardCompactReplayReadHookFailureStopsBeforeSecondDo(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	injected := errors.New("normal replay injected read failure")
	h.store.failRead = injected
	h.response.beforeRead = func() { h.assertDiskParked(t) }
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	h.assertFailedClosed(t, result, err, injected.Error())
	require.ErrorIs(t, err, injected)
	require.Positive(t, h.response.reads)
	require.Zero(t, h.store.budget.used.Load())
	h.assertFileGone(t)
}

func TestNormalForwardCompactReplaySuccessReleasesSpillAndReservation(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	h.response.reader = strings.NewReader(normalReplayFaultCompletedSSE)
	h.response.beforeRead = func() { h.assertDiskParked(t) }
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, 2, result.Usage.InputTokens)
	require.Equal(t, 3, result.Usage.OutputTokens)
	h.assertUploaded(t)
	require.Positive(t, h.response.reads)
	require.True(t, h.response.closed)
	require.Zero(t, h.store.budget.used.Load())
	h.assertFileGone(t)
}

func TestNormalForwardCompactReplayCleanupCloseFailureHoldsReservation(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	// Closing an actual live spill in the response callback deterministically
	// makes final release.Close fail on Linux as well as Windows. This is not
	// a Windows-only unlink test or a simulated release implementation.
	h.response.reader = strings.NewReader(normalReplayFaultCompletedSSE)
	h.response.beforeRead = func() {
		h.assertDiskParked(t)
		require.NoError(t, h.file.Close())
	}
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	require.NoError(t, err, "successful billing is independent of logged cleanup failure")
	require.NotNil(t, result)
	require.Equal(t, 2, result.Usage.InputTokens)
	require.Equal(t, 3, result.Usage.OutputTokens)
	h.assertUploaded(t)
	require.True(t, h.response.closed)
	require.Equal(t, h.reserved, h.store.budget.used.Load(), "close error must not release reservation")
	require.Greater(t, h.reserved, int64(openAIPassthroughReplayMemoryLimit))
	h.assertFileGone(t)
}

func TestNormalForwardCompactReplayCleanupRemoveFailureHoldsReservationWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows kept-name cleanup only; NOT Linux Forward cleanup evidence")
	}
	h := newNormalReplayFaultHarness(t)
	h.response.reader = strings.NewReader(normalReplayFaultCompletedSSE)
	removes := 0
	h.store.removeFile = func(string) error {
		removes++
		return errors.New("normal replay remove denied")
	}
	h.response.beforeRead = func() { h.assertDiskParked(t) }
	result, err := h.svc.Forward(context.Background(), h.c, h.account, h.body)
	require.NoError(t, err)
	require.NotNil(t, result)
	h.assertUploaded(t)
	require.Equal(t, 2, removes, "detach attempt plus final named cleanup")
	require.Equal(t, h.reserved, h.store.budget.used.Load())
	info, statErr := os.Stat(h.path)
	require.NoError(t, statErr)
	require.Equal(t, h.reserved, info.Size())
	require.NoError(t, os.Remove(h.path)) // Test teardown, not production recovery.
}

func TestNormalForwardCompactReplayRestoreEntryCanceledSkipsDiskRead(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	// Helper-scope entry cancellation, not a claim that Forward rejects an
	// already-canceled request before its first detached upstream Do.
	file, err := os.CreateTemp(t.TempDir(), "normal-entry-cancel-*")
	require.NoError(t, err)
	h.file, h.path = file, file.Name()
	h.store.createTemp = func() (*os.File, error) { return file, nil }
	injected := errors.New("entry cancellation must bypass replay read")
	h.store.failRead = injected
	replay, err := h.svc.parkOpenAIPassthroughCompactReplay(h.body)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, replay.release()) })
	require.Empty(t, replay.memory)
	require.NotNil(t, replay.file)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	signal := &openAICompactFallbackSignal{message: "context window exceeded"}
	restored, err := restoreOpenAICompactReplayForReadError(ctx, replay, signal)
	require.Nil(t, restored)
	require.ErrorIs(t, err, context.Canceled)
	require.ErrorIs(t, err, signal)
	require.NotContains(t, err.Error(), injected.Error())
	require.NotContains(t, err.Error(), normalReplayFaultMarker)
	require.Zero(t, h.upstream.calls)
	require.Equal(t, int64(len(h.body)), h.store.budget.used.Load())
	require.NoError(t, replay.release())
	require.Zero(t, h.store.budget.used.Load())
	h.assertFileGone(t)
}

func TestNormalForwardCompactReplayResponseReadCancelKeepsCancellation(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.c.Request = h.c.Request.WithContext(ctx)
	h.store.failRead = errors.New("cancellation must bypass forced replay read")
	h.response.beforeRead = func() {
		h.assertDiskParked(t)
		require.NoError(t, ctx.Err())
		cancel() // First actual response Read, after disk park.
	}
	h.response.reader = passthroughErrReadCloser{err: context.Canceled}
	result, err := h.svc.Forward(ctx, h.c, h.account, h.body)
	h.assertFailedClosed(t, result, err, "stream usage incomplete")
	require.ErrorIs(t, err, context.Canceled)
	require.ErrorIs(t, ctx.Err(), context.Canceled)
	require.NotContains(t, err.Error(), "forced replay read")
	require.Positive(t, h.response.reads)
	require.Zero(t, h.store.budget.used.Load())
	h.assertFileGone(t)
}

func TestNormalForwardCompactReplayCancelBeforeRestoreSkipsDiskRead(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.c.Request = h.c.Request.WithContext(ctx)
	injected := errors.New("cancel before restore must bypass disk read")
	h.store.failRead = injected
	h.response.beforeRead = func() {
		h.assertDiskParked(t)
		require.NoError(t, ctx.Err())
		cancel()
	}
	// Emit a real compact failure instead of returning a canceled Read. This
	// reaches normal Forward's restore context guard after cancellation.
	result, err := h.svc.Forward(ctx, h.c, h.account, h.body)
	h.assertFailedClosed(t, result, err, "context canceled")
	require.ErrorIs(t, err, context.Canceled)
	_, signal := asOpenAICompactFallbackSignal(err)
	require.True(t, signal)
	require.NotContains(t, err.Error(), injected.Error())
	require.Zero(t, h.store.budget.used.Load())
	h.assertFileGone(t)
}

func TestNormalForwardCompactReplayCancelAfterDiskReadMustNotReturnRetryBody(t *testing.T) {
	h := newNormalReplayFaultHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// Portable real-helper counterexample, NOT normal Linux Forward integration:
	// Unix park unlinks/clears path before Write. Explicitly construct the real
	// helper's named-spill state to use its existing post-bytes removeFile hook.
	// No production hook/unsafe/sleep and no claim of cancellation inside ReadFull.
	file, err := os.CreateTemp(t.TempDir(), "normal-post-read-cancel-*")
	require.NoError(t, err)
	h.file, h.path = file, file.Name()
	n, err := file.Write(h.body)
	require.NoError(t, err)
	require.Equal(t, len(h.body), n)
	budget := newOpenAIPassthroughReplayBudget(int64(len(h.body)))
	require.NoError(t, budget.reserve(int64(len(h.body))))
	removes := 0
	replay := &openAIPassthroughReplay{
		file:     file,
		path:     h.path,
		size:     len(h.body),
		limit:    int64(len(h.body)),
		reserved: int64(len(h.body)),
		budget:   budget,
		removeFile: func(path string) error {
			removes++
			// release only follows successful Seek+ReadFull; Close precedes Remove.
			_, statErr := file.Stat()
			require.ErrorIs(t, statErr, os.ErrClosed)
			require.Equal(t, int64(len(h.body)), budget.used.Load())
			require.NoError(t, ctx.Err())
			cancel()
			return os.Remove(path)
		},
	}
	t.Cleanup(func() { require.NoError(t, replay.release()) })
	signal := &openAICompactFallbackSignal{message: "context window exceeded"}
	restored, restoreErr := restoreOpenAICompactReplayForReadError(ctx, replay, signal)
	require.Equal(t, 1, removes)
	require.ErrorIs(t, ctx.Err(), context.Canceled)
	require.True(t, replay.released)
	require.Zero(t, budget.used.Load())
	h.assertFileGone(t)
	// Desired late-cancel contract, for parent execution. Authored assertions
	// or static prediction are not evidence of a confirmed bug or a PASS.
	if !errors.Is(restoreErr, context.Canceled) || restored != nil {
		t.Fatalf("post-read cancellation must stop restore before retry: canceled=%t returned_retry_body=%t restored_bytes=%d",
			errors.Is(restoreErr, context.Canceled), restored != nil, len(restored))
	}
}

func TestNormalForwardCompactReplayPassthroughLateCancelMustNotRetry(t *testing.T) {
	for _, cleanupFailure := range []bool{false, true} {
		name := "cleanup_success"
		if cleanupFailure {
			name = "cleanup_failure"
		}
		t.Run(name, func(t *testing.T) {
			h := newNormalReplayFaultHarness(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			file, err := os.CreateTemp(t.TempDir(), "passthrough-late-cancel-*")
			require.NoError(t, err)
			h.file, h.path = file, file.Name()
			n, err := file.Write(h.body)
			require.NoError(t, err)
			require.Equal(t, len(h.body), n)
			budget := newOpenAIPassthroughReplayBudget(int64(len(h.body)))
			require.NoError(t, budget.reserve(int64(len(h.body))))
			replay := &openAIPassthroughReplay{
				file: file, path: h.path, size: len(h.body), limit: int64(len(h.body)),
				reserved: int64(len(h.body)), budget: budget,
				removeFile: func(path string) error {
					cancel()
					if cleanupFailure {
						return errors.New("named cleanup denied after cancellation")
					}
					return os.Remove(path)
				},
			}
			t.Cleanup(func() {
				replay.removeFile = os.Remove
				require.NoError(t, replay.release())
			})
			signal := &openAICompactFallbackSignal{
				message: "context window exceeded",
				payload: []byte(`{"error":{"code":"context_length_exceeded","message":"context window exceeded"}}`),
			}
			response := &normalReplayFaultResponseBody{reader: strings.NewReader("unused")}
			decision := h.svc.decideOpenAIPassthroughReadError(ctx,
				&http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: response},
				h.c, h.account, "gpt-5.5", replay, signal, false)
			require.ErrorIs(t, ctx.Err(), context.Canceled)
			if cleanupFailure {
				require.False(t, replay.released)
				require.Equal(t, int64(len(h.body)), budget.used.Load())
			} else {
				require.True(t, replay.released)
				require.Zero(t, budget.used.Load())
			}
			if decision.retry || decision.body != nil || !errors.Is(decision.err, context.Canceled) || !errors.Is(decision.err, signal) || !response.closed {
				t.Fatalf("late cancellation must stop passthrough retry: retry=%t bytes=%d canceled=%t signal=%t response_closed=%t",
					decision.retry, len(decision.body), errors.Is(decision.err, context.Canceled), errors.Is(decision.err, signal), response.closed)
			}
		})
	}
}

func TestNormalForwardCompactReplayCancelDuringCleanupMustStopSecondDoWindows(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("real Windows kept-name restore hook; Linux early unlink has no late remove hook")
	}
	h := newNormalReplayFaultHarness(t)
	h.upstream.secondErr = errors.New("forbidden second Do reached after cleanup cancellation")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h.c.Request = h.c.Request.WithContext(ctx)
	removes := 0
	h.store.removeFile = func(path string) error {
		removes++
		if removes == 1 {
			return errors.New("keep Windows spill name until release")
		}
		_, statErr := h.file.Stat()
		require.ErrorIs(t, statErr, os.ErrClosed)
		require.NoError(t, ctx.Err())
		cancel() // Actual release after disk restore, before prepare/second Do.
		return os.Remove(path)
	}
	h.response.beforeRead = func() { h.assertDiskParked(t) }
	result, err := h.svc.Forward(ctx, h.c, h.account, h.body)
	require.Equal(t, 2, removes)
	require.ErrorIs(t, ctx.Err(), context.Canceled)
	require.Zero(t, h.store.budget.used.Load())
	h.assertFileGone(t)
	// Unexecuted counterexample assertion, not a declared defect.
	require.Equal(t, 1, h.upstream.calls, "cleanup-time cancellation must not reach second Do")
	require.Nil(t, result)
	require.ErrorIs(t, err, context.Canceled)
}
