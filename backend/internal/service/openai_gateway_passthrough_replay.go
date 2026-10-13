package service

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync/atomic"

	pkghttputil "github.com/Wei-Shaw/sub2api/internal/pkg/httputil"
	"github.com/Wei-Shaw/sub2api/internal/pkg/logger"
	"github.com/gin-gonic/gin"
)

// openAIPassthroughReplayMemoryLimit is the largest compact-context body kept
// on the heap while a successful upstream response is read. Larger compact
// bodies spill to a bounded temp file so one fallback retry can rebuild the
// request. Non-compact responses are not parked: newOpenAICompactFallbackSignal
// is nil unless isExplicitOpenAICompactContext is true, so nothing later retries.
const openAIPassthroughReplayMemoryLimit = 1 << 20

// openAIPassthroughReplayDefaultRequestLimit is the per-request spill cap used
// when Gateway.MaxBodySize is unset or not positive. 256MiB is the existing
// gateway.max_body_size default. The cap is a gate, not a truncation: a larger
// body is rejected instead of being cut or kept on the heap.
const openAIPassthroughReplayDefaultRequestLimit int64 = 256 << 20

// openAIPassthroughReplayDiskBudgetBytes is the process-wide cap on compact
// replay bytes reserved on disk at once. Four times the default max body leaves
// room for one legal default-size compact retry plus a few concurrent spills,
// and further reservations fail instead of growing without a bound. This is a
// code constant. Production config is not changed. If an operator raises
// gateway.max_body_size above the remaining budget, that one compact replay
// fails closed rather than spilling without a ceiling.
const openAIPassthroughReplayDiskBudgetBytes int64 = 4 * openAIPassthroughReplayDefaultRequestLimit

type openAIPassthroughReplayBudget struct {
	limit int64
	used  atomic.Int64
}

func newOpenAIPassthroughReplayBudget(limit int64) *openAIPassthroughReplayBudget {
	if limit < 0 {
		limit = 0
	}
	return &openAIPassthroughReplayBudget{limit: limit}
}

// reserve adds n to the in-use total or leaves it unchanged. The error includes
// sizes only. Callers must not attach the request body.
func (b *openAIPassthroughReplayBudget) reserve(n int64) error {
	if b == nil {
		return errors.New("openai passthrough compact replay disk budget is not configured")
	}
	if n < 0 {
		return fmt.Errorf("openai passthrough compact replay reserve is negative: bytes=%d", n)
	}
	if n > b.limit {
		return fmt.Errorf("openai passthrough compact replay disk budget exceeded: bytes=%d reserved=%d limit=%d", n, b.used.Load(), b.limit)
	}
	for {
		cur := b.used.Load()
		if cur > b.limit-n {
			return fmt.Errorf("openai passthrough compact replay disk budget exceeded: bytes=%d reserved=%d limit=%d", n, cur, b.limit)
		}
		if b.used.CompareAndSwap(cur, cur+n) {
			return nil
		}
	}
}

func (b *openAIPassthroughReplayBudget) release(n int64) {
	if b == nil || n <= 0 {
		return
	}
	for {
		cur := b.used.Load()
		next := cur - n
		if next < 0 {
			next = 0
		}
		if b.used.CompareAndSwap(cur, next) {
			return
		}
	}
}

// openAIPassthroughReplayStore is the process spill budget plus test hooks.
// A nil store uses the process defaults. requestLimit > 0 overrides
// Gateway.MaxBodySize and is for tests; production leaves it zero.
// failRead, when set, makes bytes() fail without touching the spill so a test
// can prove cancellation is not replaced by a replay read error.
type openAIPassthroughReplayStore struct {
	budget       *openAIPassthroughReplayBudget
	createTemp   func() (*os.File, error)
	removeFile   func(string) error
	requestLimit int64
	failRead     error
}

var openAIPassthroughReplayProcessStore = &openAIPassthroughReplayStore{
	budget:     newOpenAIPassthroughReplayBudget(openAIPassthroughReplayDiskBudgetBytes),
	createTemp: createOpenAIPassthroughReplayTemp,
	removeFile: os.Remove,
}

type openAIPassthroughReplay struct {
	memory        []byte
	file          *os.File
	path          string
	size          int
	limit         int64
	reserved      int64
	budget        *openAIPassthroughReplayBudget
	removeFile    func(string) error
	forcedReadErr error
	released      bool
}

func (s *OpenAIGatewayService) parkOpenAIPassthroughCompactReplay(body []byte) (*openAIPassthroughReplay, error) {
	store := openAIPassthroughReplayProcessStore
	if s != nil && s.passthroughReplayStore != nil {
		store = s.passthroughReplayStore
	}
	limit := openAIPassthroughReplayDefaultRequestLimit
	if store != nil && store.requestLimit > 0 {
		limit = store.requestLimit
	} else if s != nil && s.cfg != nil && s.cfg.Gateway.MaxBodySize > 0 {
		limit = s.cfg.Gateway.MaxBodySize
	}
	return parkOpenAIPassthroughReplay(body, limit, store)
}

// parkOpenAIPassthroughReplay keeps a compact-context body for one possible
// fallback retry. Disk, budget, and limit failures do not fall back to a heap
// copy: the caller drops its reference and returns the error. Errors carry
// lengths and the underlying I/O error, not the body bytes.
func parkOpenAIPassthroughReplay(body []byte, requestLimit int64, store *openAIPassthroughReplayStore) (*openAIPassthroughReplay, error) {
	if requestLimit <= 0 {
		requestLimit = openAIPassthroughReplayDefaultRequestLimit
	}
	if int64(len(body)) > requestLimit {
		return nil, fmt.Errorf("openai passthrough compact replay exceeds request limit: bytes=%d limit=%d", len(body), requestLimit)
	}
	replay := &openAIPassthroughReplay{
		limit:         requestLimit,
		size:          len(body),
		removeFile:    replayRemover(store),
		forcedReadErr: replayReadErr(store),
	}
	if len(body) <= openAIPassthroughReplayMemoryLimit {
		replay.memory = body
		return replay, nil
	}
	budget := replayDiskBudget(store)
	if err := budget.reserve(int64(len(body))); err != nil {
		return nil, err
	}
	file, err := replayTempCreator(store)()
	if err != nil {
		budget.release(int64(len(body)))
		return nil, fmt.Errorf("create openai passthrough compact replay: %w", err)
	}
	keptPath, detachErr := detachOpenAIPassthroughReplayName(file, replay.removeFile)
	if detachErr != nil {
		budget.release(int64(len(body)))
		return nil, detachErr
	}
	n, writeErr := file.Write(body)
	if writeErr != nil || n != len(body) {
		if writeErr == nil {
			writeErr = io.ErrShortWrite
		}
		closeErr := file.Close()
		var removeErr error
		// Linux unlinks before Write, so a failed write leaves no named body.
		// Only a Windows name that still holds bytes keeps the reservation.
		keepReservation := false
		if keptPath != "" {
			removeErr = replay.removeFile(keptPath)
			if errors.Is(removeErr, os.ErrNotExist) {
				removeErr = nil
			}
			if removeErr != nil {
				info, statErr := os.Stat(keptPath)
				switch {
				case errors.Is(statErr, os.ErrNotExist):
					removeErr = nil
				case statErr != nil:
					removeErr = errors.Join(removeErr, statErr)
				case info.Size() > 0:
					keepReservation = true
				}
			}
		}
		if !keepReservation {
			budget.release(int64(len(body)))
		}
		return nil, fmt.Errorf("write openai passthrough compact replay: wrote=%d bytes=%d: %w", n, len(body), errors.Join(writeErr, closeErr, removeErr))
	}
	replay.file = file
	replay.path = keptPath
	replay.reserved = int64(len(body))
	replay.budget = budget
	replay.memory = nil
	return replay, nil
}

func replayTempCreator(store *openAIPassthroughReplayStore) func() (*os.File, error) {
	if store != nil && store.createTemp != nil {
		return store.createTemp
	}
	return createOpenAIPassthroughReplayTemp
}

func replayRemover(store *openAIPassthroughReplayStore) func(string) error {
	if store != nil && store.removeFile != nil {
		return store.removeFile
	}
	return os.Remove
}

func replayDiskBudget(store *openAIPassthroughReplayStore) *openAIPassthroughReplayBudget {
	if store != nil && store.budget != nil {
		return store.budget
	}
	return openAIPassthroughReplayProcessStore.budget
}

func replayReadErr(store *openAIPassthroughReplayStore) error {
	if store == nil {
		return nil
	}
	return store.failRead
}

func (r *openAIPassthroughReplay) bytes() ([]byte, error) {
	if r == nil || r.released {
		return nil, errors.New("openai passthrough compact replay released")
	}
	if r.forcedReadErr != nil {
		return nil, r.forcedReadErr
	}
	if r.file == nil {
		return r.memory, nil
	}
	if r.size < 0 || int64(r.size) > r.limit {
		return nil, fmt.Errorf("openai passthrough compact replay length exceeds limit: bytes=%d limit=%d", r.size, r.limit)
	}
	if _, err := r.file.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("rewind openai passthrough compact replay: %w", err)
	}
	if r.size == 0 {
		return []byte{}, nil
	}
	// Read the recorded length and no more. ReadFull refuses a short file.
	buf := make([]byte, r.size)
	if _, err := io.ReadFull(io.LimitReader(r.file, int64(r.size)), buf); err != nil {
		return nil, fmt.Errorf("read openai passthrough compact replay: %w", err)
	}
	return buf, nil
}

// release closes the spill and frees its reservation only after the name is
// confirmed gone. A close or remove error leaves the reservation held so a
// failed cleanup is not treated as free disk. Safe to call more than once.
func (r *openAIPassthroughReplay) release() error {
	if r == nil || r.released {
		return nil
	}
	var err error
	if r.file != nil {
		err = errors.Join(err, r.file.Close())
		r.file = nil
	}
	if r.path != "" {
		remove := r.removeFile
		if remove == nil {
			remove = os.Remove
		}
		removeErr := remove(r.path)
		if removeErr != nil && !errors.Is(removeErr, os.ErrNotExist) {
			// Windows delete-on-close can make Remove fail after Close has
			// already dropped the name. Stat is the confirmation. A name that
			// is still present keeps the reservation.
			if _, statErr := os.Stat(r.path); errors.Is(statErr, os.ErrNotExist) {
				removeErr = nil
			} else if statErr != nil {
				removeErr = errors.Join(removeErr, statErr)
			}
		}
		if removeErr != nil {
			err = errors.Join(err, removeErr)
		} else {
			r.path = ""
		}
	}
	if err != nil {
		return fmt.Errorf("release openai passthrough compact replay: %w", err)
	}
	r.memory = nil
	r.forcedReadErr = nil
	r.released = true
	if r.reserved > 0 {
		r.budget.release(r.reserved)
		r.reserved = 0
	}
	return nil
}

func releaseOpenAIPassthroughReplays(replays []*openAIPassthroughReplay) error {
	var err error
	for _, replay := range replays {
		err = errors.Join(err, replay.release())
	}
	return err
}

type openAIPassthroughReadDecision struct {
	retry         bool
	body          []byte
	fallbackModel string
	err           error
}

func releaseOpenAIPassthroughUpstreamRequest(req *http.Request) {
	if req == nil {
		return
	}
	pkghttputil.ReleaseRequestReplay(req)
	req.GetBody = nil
}

// decideOpenAIPassthroughReadError restores a compact replay only for a compact
// fallback signal. A canceled or deadline-exceeded context is not a retry: the
// spill is not read, and an existing cancellation wrap on handleErr is kept.
// Ordinary read errors are returned as-is. A replay read or cleanup failure
// must not replace context.Canceled.
func (s *OpenAIGatewayService) decideOpenAIPassthroughReadError(
	ctx context.Context,
	resp *http.Response,
	c *gin.Context,
	account *Account,
	requestedModel string,
	replay *openAIPassthroughReplay,
	handleErr error,
	alreadyRetried bool,
) openAIPassthroughReadDecision {
	if handleErr == nil {
		return openAIPassthroughReadDecision{}
	}
	closeBody := func() {
		if resp != nil && resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	canceled := errors.Is(handleErr, context.Canceled) || (ctx != nil && errors.Is(ctx.Err(), context.Canceled))
	signal, ok := asOpenAICompactFallbackSignal(handleErr)
	var ctxErr error
	if ctx != nil {
		ctxErr = ctx.Err()
	}
	if ok && ctxErr != nil {
		closeBody()
		if errors.Is(handleErr, context.Canceled) || errors.Is(handleErr, context.DeadlineExceeded) {
			return openAIPassthroughReadDecision{err: handleErr}
		}
		return openAIPassthroughReadDecision{err: fmt.Errorf("%w: %w", ctxErr, handleErr)}
	}
	if !ok || errors.Is(handleErr, context.Canceled) {
		closeBody()
		return openAIPassthroughReadDecision{err: handleErr}
	}
	if replay == nil {
		closeBody()
		if canceled {
			return openAIPassthroughReadDecision{err: handleErr}
		}
		return openAIPassthroughReadDecision{err: errors.New("openai passthrough compact replay missing")}
	}
	restored, restoreErr := replay.bytes()
	if restoreErr != nil {
		closeBody()
		if canceled {
			return openAIPassthroughReadDecision{err: handleErr}
		}
		return openAIPassthroughReadDecision{err: restoreErr}
	}
	if relErr := replay.release(); relErr != nil {
		// The bytes are already restored, so compact retry and the error
		// handler still run. The reservation stays held until a later release
		// succeeds; the log is the record that cleanup did not succeed.
		logger.LegacyPrintf("service.openai_gateway", "[OpenAI passthrough] compact replay cleanup failed after restore: %v", relErr)
		if canceled {
			closeBody()
			return openAIPassthroughReadDecision{err: handleErr}
		}
	}
	if retryBody, fallbackModel, retry := s.applyOpenAIPassthroughCompactFallbackFromSignal(
		c, account, requestedModel, restored, handleErr, alreadyRetried, resp,
	); retry {
		return openAIPassthroughReadDecision{retry: true, body: retryBody, fallbackModel: fallbackModel}
	}
	closeBody()
	compactResp, compactBody := openAICompactFallbackErrorResponse(resp, signal)
	if shouldFailoverOpenAIPassthroughResponse(account, compactResp.StatusCode, compactBody) {
		return openAIPassthroughReadDecision{err: s.handleFailoverErrorResponsePassthrough(ctx, compactResp, c, account, restored, compactBody)}
	}
	return openAIPassthroughReadDecision{err: s.handleErrorResponsePassthrough(ctx, compactResp, c, account, restored, compactBody)}
}
