//go:build unit

package service

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

const nfCancelPriorityPrivateMarker = "cancel-priority-private-request-7da8"

func nfCancelPriorityBody() []byte {
	return []byte(`{"model":"gpt-5.5","stream":true,"input":[{"type":"message","role":"user","content":"` + nfCancelPriorityPrivateMarker + `"},{"type":"compaction_trigger"}]}`)
}

func nfCancelPrioritySignal() (*openAICompactFallbackSignal, error) {
	signal := &openAICompactFallbackSignal{
		message: "context window exceeded",
		payload: []byte(`{"error":{"code":"context_length_exceeded","message":"context window exceeded"}}`),
	}
	return signal, fmt.Errorf("original compact read failure: %w", signal)
}

func nfCancelPriorityMemory(t *testing.T, readErr error) *openAIPassthroughReplay {
	t.Helper()
	body := nfCancelPriorityBody()
	replay := &openAIPassthroughReplay{memory: body, size: len(body), limit: int64(len(body)), forcedReadErr: readErr}
	t.Cleanup(func() { require.NoError(t, replay.release()) })
	return replay
}

// Check-boundary instrumentation ONLY. Err transitions at an explicitly counted
// observation, or synchronously in the existing removeFile callback. The same
// transition closes Done before returning the terminal error; all later Err
// observations keep that error. No wall-clock deadline/timer or cancellation
// inside Seek/ReadFull is modeled. Background supplies Value and no scheduled
// Deadline. The synthetic DeadlineExceeded reason tests error priority, not time.
// Do not reuse this as evidence of a real I/O cancellation barrier.
type nfCancelPriorityObservedContext struct {
	context.Context
	mu       sync.Mutex
	done     chan struct{}
	terminal error
	err      error
	atCheck  int
	checks   int
	firstErr error
}

func nfCancelPriorityContext(terminal error, atCheck int) *nfCancelPriorityObservedContext {
	return &nfCancelPriorityObservedContext{
		Context: context.Background(), done: make(chan struct{}), terminal: terminal, atCheck: atCheck,
	}
}

func (c *nfCancelPriorityObservedContext) Done() <-chan struct{} { return c.done }

func (c *nfCancelPriorityObservedContext) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.checks++
	if c.err == nil && c.atCheck > 0 && c.checks >= c.atCheck {
		c.err = c.terminal
		close(c.done)
	}
	if c.checks == 1 {
		c.firstErr = c.err
	}
	return c.err
}

func (c *nfCancelPriorityObservedContext) finish() {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err == nil {
		c.err = c.terminal
		close(c.done)
	}
}

func nfCancelPriorityDone(ctx context.Context) bool {
	select {
	case <-ctx.Done():
		return true
	default:
		return false
	}
}

type nfCancelPriorityResponseBody struct{ closes int }

func (*nfCancelPriorityResponseBody) Read([]byte) (int, error) { return 0, io.EOF }
func (b *nfCancelPriorityResponseBody) Close() error {
	b.closes++
	return nil
}

type nfCancelPriorityResult struct {
	body   []byte
	err    error
	retry  bool
	model  string
	closes int
}

// Both real production entry points are exercised, with no existing-test helper
// dependency. The explicit compact request and configured fallback make an
// accidentally permitted retry observable rather than relying on a nil service.
func nfCancelPriorityInvoke(t *testing.T, target string, ctx context.Context, replay *openAIPassthroughReplay, handleErr error) nfCancelPriorityResult {
	t.Helper()
	if target == "restore" {
		body, err := restoreOpenAICompactReplayForReadError(ctx, replay, handleErr)
		return nfCancelPriorityResult{body: body, err: err}
	}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses/compact", nil)
	responseBody := &nfCancelPriorityResponseBody{}
	response := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: responseBody}
	svc := &OpenAIGatewayService{cfg: &config.Config{Gateway: config.GatewayConfig{OpenAICompactModel: "gpt-5.4"}}}
	decision := svc.decideOpenAIPassthroughReadError(ctx, response, c, &Account{Name: "cancel-priority-account"}, "gpt-5.5", replay, handleErr, false)
	return nfCancelPriorityResult{body: decision.body, err: decision.err, retry: decision.retry, model: decision.fallbackModel, closes: responseBody.closes}
}

func nfCancelPriorityNoPrivateData(t *testing.T, text string) {
	t.Helper()
	if strings.Contains(text, nfCancelPriorityPrivateMarker) {
		t.Fatal("request marker leaked; payload/log text intentionally omitted")
	}
}

func nfCancelPriorityStopped(t *testing.T, target string, got nfCancelPriorityResult) {
	t.Helper()
	require.False(t, got.retry, "cancellation/error must not request retry")
	require.True(t, got.body == nil, "retry body must be nil (bytes=%d)", len(got.body))
	require.Empty(t, got.model)
	if got.err != nil {
		nfCancelPriorityNoPrivateData(t, got.err.Error())
	}
	if target == "decision" {
		require.Equal(t, 1, got.closes, "error decision must close response exactly once")
	}
}

func nfCancelPriorityPreserved(t *testing.T, err, terminal, original error, signal *openAICompactFallbackSignal) {
	t.Helper()
	require.Error(t, err)
	nfCancelPriorityNoPrivateData(t, err.Error())
	require.ErrorIs(t, err, terminal)
	require.ErrorIs(t, err, original, "keep original compact wrapper, not a recreated signal")
	var recovered *openAICompactFallbackSignal
	require.True(t, errors.As(err, &recovered), "joined error must retain typed compact signal")
	require.True(t, recovered == signal, "retain the exact original signal pointer")
}

// A real, deliberately named file state, not normal Unix park integration:
// Unix park unlinks before Write. This portable fixture reaches the existing
// post-ReadFull, post-Close removeFile hook without new production hooks.
func nfCancelPriorityNamed(t *testing.T, remove func(string) error) (*openAIPassthroughReplay, *os.File, string, int64) {
	t.Helper()
	file, err := os.CreateTemp(t.TempDir(), "cancel-priority-named-*")
	require.NoError(t, err)
	path := file.Name()
	body := nfCancelPriorityBody()
	n, err := file.Write(body)
	if err != nil || n != len(body) {
		_ = file.Close()
		_ = os.Remove(path)
		t.Fatal("could not seed named replay fixture")
	}
	reserved := int64(len(body))
	budget := newOpenAIPassthroughReplayBudget(reserved)
	require.NoError(t, budget.reserve(reserved))
	replay := &openAIPassthroughReplay{
		file: file, path: path, size: len(body), limit: reserved,
		reserved: reserved, budget: budget, removeFile: remove,
	}
	t.Cleanup(func() {
		replay.removeFile = os.Remove
		require.NoError(t, replay.release())
		require.Zero(t, budget.used.Load())
		_, statErr := os.Stat(path)
		require.ErrorIs(t, statErr, os.ErrNotExist)
	})
	return replay, file, path, reserved
}

// Capture both LegacyPrintf routing modes through the existing public logger
// configuration API, not SetSink (which has no public getter for restoration).
// These tests MUST NOT use t.Parallel: stdout/stderr/logger are process-global.
// Restore configuration and stdlog state even if an assertion aborts the body.
// No logs are printed on a privacy assertion failure.
func nfCancelPriorityCaptureLogs(t *testing.T, call func()) string {
	t.Helper()
	reader, writer, err := os.Pipe()
	require.NoError(t, err)
	originalOut, originalErr := os.Stdout, os.Stderr
	originalWriter, originalFlags, originalPrefix := log.Writer(), log.Flags(), log.Prefix()
	originalSlog := slog.Default()
	var saved logger.InitOptions
	captured := make(chan string, 1)
	go func() {
		var buffer bytes.Buffer
		_, _ = io.Copy(&buffer, reader)
		captured <- buffer.String()
	}()
	os.Stdout, os.Stderr = writer, writer
	var text string
	finished := false
	finish := func() {
		if finished {
			return
		}
		finished = true
		logger.Sync()
		os.Stdout, os.Stderr = originalOut, originalErr
		restoreErr := logger.Reconfigure(func(options *logger.InitOptions) error { *options = saved; return nil })
		slog.SetDefault(originalSlog)
		log.SetOutput(originalWriter)
		log.SetFlags(originalFlags)
		log.SetPrefix(originalPrefix)
		closeErr := writer.Close()
		text = <-captured
		readCloseErr := reader.Close()
		require.NoError(t, restoreErr)
		require.NoError(t, closeErr)
		require.NoError(t, readCloseErr)
	}
	defer finish()
	err = logger.Reconfigure(func(options *logger.InitOptions) error {
		saved = *options
		options.Level = "debug"
		options.Format = "json"
		options.Output = logger.OutputOptions{ToStdout: true}
		options.Sampling.Enabled = false
		return nil
	})
	require.NoError(t, err)
	call()
	finish()
	return text
}

func TestNormalForwardReplayCancelPriorityBytesErrorCheckBoundaryContract(t *testing.T) {
	for _, target := range []string{"restore", "decision"} {
		for _, terminal := range []struct {
			name string
			err  error
		}{{"canceled", context.Canceled}, {"deadline", context.DeadlineExceeded}} {
			t.Run(target+"/"+terminal.name, func(t *testing.T) {
				// Frozen candidate observations: restore entry then post-bytes;
				// decision adds its own ctx observation before entering restore.
				// This is explicitly a check-boundary contract, not an I/O hook.
				atCheck := 2
				if target == "decision" {
					atCheck = 3
				}
				ctx := nfCancelPriorityContext(terminal.err, atCheck)
				require.False(t, nfCancelPriorityDone(ctx), "entry must be active")
				readErr := errors.New("forced replay read fault distinct from compact signal")
				replay := nfCancelPriorityMemory(t, readErr)
				signal, original := nfCancelPrioritySignal()
				got := nfCancelPriorityInvoke(t, target, ctx, replay, original)
				nfCancelPriorityStopped(t, target, got)
				nfCancelPriorityPreserved(t, got.err, terminal.err, original, signal)
				require.NotErrorIs(t, got.err, readErr, "observed cancellation outranks bytes error")
				require.NoError(t, ctx.firstErr, "first entry observation must be active")
				require.GreaterOrEqual(t, ctx.checks, atCheck)
				require.True(t, nfCancelPriorityDone(ctx))
				require.ErrorIs(t, ctx.Err(), terminal.err)
				require.False(t, replay.released, "read-error exit leaves cleanup to caller")
				require.True(t, bytes.Equal(replay.memory, nfCancelPriorityBody()))
			})
		}
	}
}

func TestNormalForwardReplayCancelPriorityDeadlineAfterReleaseContract(t *testing.T) {
	for _, target := range []string{"restore", "decision"} {
		for _, cleanupFailure := range []bool{false, true} {
			name := "cleanup_success"
			if cleanupFailure {
				name = "cleanup_failure"
			}
			t.Run(target+"/"+name, func(t *testing.T) {
				ctx := nfCancelPriorityContext(context.DeadlineExceeded, 0)
				signal, original := nfCancelPrioritySignal()
				cleanupErr := errors.New("synthetic named cleanup denied")
				removes := 0
				var file *os.File
				var replay *openAIPassthroughReplay
				var path string
				var reserved int64
				replay, file, path, reserved = nfCancelPriorityNamed(t, func(name string) error {
					removes++
					require.NoError(t, ctx.Err(), "active through successful bytes and Close")
					require.False(t, nfCancelPriorityDone(ctx))
					_, statErr := file.Stat()
					require.ErrorIs(t, statErr, os.ErrClosed, "Close precedes Remove")
					require.Equal(t, reserved, replay.budget.used.Load())
					ctx.finish() // Synthetic synchronous deadline observation, NOT timer expiry.
					if cleanupFailure {
						return cleanupErr
					}
					return os.Remove(name)
				})
				require.False(t, nfCancelPriorityDone(ctx))
				var got nfCancelPriorityResult
				logs := nfCancelPriorityCaptureLogs(t, func() {
					got = nfCancelPriorityInvoke(t, target, ctx, replay, original)
				})
				nfCancelPriorityNoPrivateData(t, logs)
				require.Equal(t, 1, removes)
				nfCancelPriorityStopped(t, target, got)
				nfCancelPriorityPreserved(t, got.err, context.DeadlineExceeded, original, signal)
				require.True(t, nfCancelPriorityDone(ctx))
				require.ErrorIs(t, ctx.Err(), context.DeadlineExceeded)
				require.NotErrorIs(t, got.err, cleanupErr)
				if cleanupFailure {
					require.True(t, strings.Contains(logs, "compact replay cleanup failed after restore"), "cleanup log assertion must not be vacuous")
					require.True(t, strings.Contains(logs, cleanupErr.Error()), "cleanup log must retain underlying I/O reason")
					require.False(t, replay.released)
					require.Equal(t, reserved, replay.reserved)
					require.Equal(t, reserved, replay.budget.used.Load())
					require.Equal(t, path, replay.path)
					info, statErr := os.Stat(path)
					require.NoError(t, statErr)
					require.Equal(t, reserved, info.Size(), "residue still occupies reserved bytes")
					// Legitimate later cleanup, not an artificial budget reset.
					replay.removeFile = os.Remove
					require.NoError(t, replay.release())
				} else {
					require.False(t, strings.Contains(logs, "compact replay cleanup failed after restore"))
				}
				require.True(t, replay.released)
				require.Zero(t, replay.reserved)
				require.Zero(t, replay.budget.used.Load())
				require.Empty(t, replay.path)
				_, statErr := os.Stat(path)
				require.ErrorIs(t, statErr, os.ErrNotExist)
			})
		}
	}
}

func TestNormalForwardReplayCancelPriorityEntryAndWrappedSignalContract(t *testing.T) {
	for _, target := range []string{"restore", "decision"} {
		for _, terminal := range []struct {
			name string
			err  error
		}{{"canceled", context.Canceled}, {"deadline", context.DeadlineExceeded}} {
			t.Run(target+"/entry_"+terminal.name, func(t *testing.T) {
				var ctx context.Context
				var cancel context.CancelFunc
				if terminal.err == context.Canceled {
					ctx, cancel = context.WithCancel(context.Background())
					cancel()
				} else {
					ctx, cancel = context.WithDeadline(context.Background(), time.Unix(0, 0))
				}
				defer cancel()
				require.ErrorIs(t, ctx.Err(), terminal.err)
				replay := nfCancelPriorityMemory(t, errors.New("entry cancellation must bypass read fault"))
				signal, original := nfCancelPrioritySignal()
				got := nfCancelPriorityInvoke(t, target, ctx, replay, original)
				nfCancelPriorityStopped(t, target, got)
				nfCancelPriorityPreserved(t, got.err, terminal.err, original, signal)
				require.False(t, replay.released)
			})
			for _, ctxName := range []string{"active", "nil"} {
				t.Run(target+"/wrapped_"+terminal.name+"/"+ctxName, func(t *testing.T) {
					var ctx context.Context
					if ctxName == "active" {
						ctx = context.Background()
					}
					signal, original := nfCancelPrioritySignal()
					handleErr := errors.Join(terminal.err, original)
					replay := nfCancelPriorityMemory(t, errors.New("wrapped cancellation must bypass replay"))
					got := nfCancelPriorityInvoke(t, target, ctx, replay, handleErr)
					nfCancelPriorityStopped(t, target, got)
					require.True(t, got.err == handleErr, "already-wrapped handleErr identity must remain unchanged")
					nfCancelPriorityPreserved(t, got.err, terminal.err, original, signal)
					require.False(t, replay.released)
				})
			}
		}
	}
}

func TestNormalForwardReplayCancelPriorityCompatibilityContract(t *testing.T) {
	for _, target := range []string{"restore", "decision"} {
		for _, ctxName := range []string{"active", "nil"} {
			t.Run(target+"/read_error_identity/"+ctxName, func(t *testing.T) {
				var ctx context.Context
				if ctxName == "active" {
					ctx = context.Background()
				}
				readErr := errors.New("replay fault identity must survive without cancellation")
				replay := nfCancelPriorityMemory(t, readErr)
				_, original := nfCancelPrioritySignal()
				got := nfCancelPriorityInvoke(t, target, ctx, replay, original)
				nfCancelPriorityStopped(t, target, got)
				require.True(t, got.err == readErr, "return original replay readErr, not a new wrapper")
				require.False(t, replay.released)
			})
			for _, storage := range []string{"memory", "named_file"} {
				t.Run(target+"/successful_restore/"+ctxName+"/"+storage, func(t *testing.T) {
					var ctx context.Context
					if ctxName == "active" {
						ctx = context.Background()
					}
					var replay *openAIPassthroughReplay
					if storage == "memory" {
						replay = nfCancelPriorityMemory(t, nil)
					} else {
						replay, _, _, _ = nfCancelPriorityNamed(t, os.Remove)
					}
					_, original := nfCancelPrioritySignal()
					got := nfCancelPriorityInvoke(t, target, ctx, replay, original)
					require.NoError(t, got.err)
					require.True(t, replay.released)
					if storage == "named_file" {
						require.Zero(t, replay.budget.used.Load())
					}
					if target == "restore" {
						require.True(t, bytes.Equal(got.body, nfCancelPriorityBody()), "restored bytes changed")
					} else {
						require.True(t, got.retry)
						require.Equal(t, "gpt-5.4", got.model)
						require.Equal(t, 1, got.closes)
						expected := ReplaceModelInBody(nfCancelPriorityBody(), "gpt-5.4")
						require.True(t, bytes.Equal(got.body, expected), "fallback may change only requested model")
					}
				})
			}
		}
		t.Run(target+"/ordinary_error_canceled_context", func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			ordinary := errors.New("ordinary noncompact read error")
			replay := nfCancelPriorityMemory(t, errors.New("ordinary error must bypass replay"))
			got := nfCancelPriorityInvoke(t, target, ctx, replay, ordinary)
			nfCancelPriorityStopped(t, target, got)
			if target == "decision" {
				require.True(t, got.err == ordinary, "decision ordinary error remains EXACTLY as-is even if ctx canceled")
				require.NotErrorIs(t, got.err, context.Canceled)
			} else {
				// Existing restore entry guard predates compact gating; do NOT
				// accidentally impose decision's ordinary-error contract here.
				require.ErrorIs(t, got.err, context.Canceled)
				require.ErrorIs(t, got.err, ordinary)
			}
			require.False(t, replay.released)
		})
	}
}

func TestNormalForwardReplayCancelPriorityNilInputsContract(t *testing.T) {
	for _, target := range []string{"restore", "decision"} {
		for _, ctxName := range []string{"active", "nil", "canceled"} {
			newContext := func() context.Context {
				if ctxName == "nil" {
					return nil
				}
				if ctxName == "canceled" {
					ctx, cancel := context.WithCancel(context.Background())
					cancel()
					return ctx
				}
				return context.Background()
			}
			t.Run(target+"/nil_replay/"+ctxName, func(t *testing.T) {
				ctx := newContext()
				signal, original := nfCancelPrioritySignal()
				got := nfCancelPriorityInvoke(t, target, ctx, nil, original)
				nfCancelPriorityStopped(t, target, got)
				if ctxName == "canceled" {
					nfCancelPriorityPreserved(t, got.err, context.Canceled, original, signal)
				} else if target == "decision" {
					require.EqualError(t, got.err, "openai passthrough compact replay missing")
				} else {
					require.EqualError(t, got.err, "openai passthrough compact replay released")
				}
			})
			for _, nilReplay := range []bool{false, true} {
				name := "present_replay"
				if nilReplay {
					name = "nil_replay"
				}
				t.Run(target+"/nil_handle_error/"+ctxName+"/"+name, func(t *testing.T) {
					var replay *openAIPassthroughReplay
					if !nilReplay {
						replay = nfCancelPriorityMemory(t, errors.New("nil handleErr must not restore"))
					}
					got := nfCancelPriorityInvoke(t, target, newContext(), replay, nil)
					require.False(t, got.retry)
					require.True(t, got.body == nil)
					require.Empty(t, got.model)
					if target == "restore" && ctxName == "canceled" {
						require.ErrorIs(t, got.err, context.Canceled)
					} else {
						require.NoError(t, got.err)
					}
					require.Zero(t, got.closes, "nil handleErr leaves response ownership untouched")
					if replay != nil {
						require.False(t, replay.released)
					}
				})
			}
		}
	}
}
