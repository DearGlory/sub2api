package poison

import (
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
)

// ContextKeyActive 标记当前请求已通过准入判定、需要检测。
const ContextKeyActive = "poison_guard_active"

// MarkRequest 由接线处调用：账号同时满足上游白名单与代理时标记本请求。
func MarkRequest(c *gin.Context, snap *Snapshot, baseURL string, hasProxy bool) {
	if c == nil || !snap.Active() {
		return
	}
	if !snap.Scope.Match(baseURL, hasProxy) {
		return
	}
	c.Set(ContextKeyActive, snap)
}

// snapshotFromContext 取出本请求要用的快照，未标记时返回 nil。
func snapshotFromContext(c *gin.Context) *Snapshot {
	if c == nil {
		return nil
	}
	v, ok := c.Get(ContextKeyActive)
	if !ok {
		return nil
	}
	snap, ok := v.(*Snapshot)
	if !ok || !snap.Active() {
		return nil
	}
	return snap
}

// GuardWriter 包住 gin.ResponseWriter，在字节写给客户端之前做关键词判定。
//
// 它同时承担两种角色：
//   - 兜底：任何绕过 service 层钩子的写入路径也拦得住，因为所有字节都要经过这里。
//   - 零泄露：流式下只放行「不可能再构成关键词」的前缀，命中时丢弃全部缓冲。
//
// 一旦判定为投毒，后续写入全部丢弃，并由调用方把响应改成错误。
type GuardWriter struct {
	gin.ResponseWriter
	snap  *Snapshot
	guard *StreamGuard

	mu        sync.Mutex
	blocked   bool
	blockErr  error
	committed int // 已写给客户端的字节数
	// discarded 记录被扣留后丢弃的字节数，用于日志与断言。
	discarded int
}

// WrapWriter 在请求已标记时替换 c.Writer；否则原样返回。
//
// 必须在任何写入之前调用（中间件阶段），否则已经写出的字节无法回收。
func WrapWriter(c *gin.Context) {
	if c == nil {
		return
	}
	snap := snapshotFromContext(c)
	if snap == nil {
		return
	}
	if _, already := c.Writer.(*GuardWriter); already {
		return
	}
	c.Writer = &GuardWriter{
		ResponseWriter: c.Writer,
		snap:           snap,
		guard:          snap.Detector.NewStreamGuard(),
	}
}

// Blocked 报告是否已判定为投毒。
func (w *GuardWriter) Blocked() bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.blocked
}

// Committed 返回已经写给客户端的字节数。为 0 时才允许换账号重试。
func (w *GuardWriter) Committed() int {
	if w == nil {
		return 0
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.committed
}

// markBlocked 记录命中并丢弃全部待写内容。
func (w *GuardWriter) markBlocked(reason string) {
	w.mu.Lock()
	w.blocked = true
	if w.blockErr == nil {
		w.blockErr = &BlockedError{Reason: reason}
	}
	w.mu.Unlock()
}

// BlockedError 表示响应已被判定为投毒并拦截。
type BlockedError struct {
	Reason string
}

func (e *BlockedError) Error() string {
	if e == nil {
		return "poison guard: blocked"
	}
	return "poison guard: blocked (" + e.Reason + ")"
}

// Write 拦截写入。命中投毒时丢弃内容并返回成功，避免上层把它当成网络故障。
func (w *GuardWriter) Write(data []byte) (int, error) {
	if w == nil {
		return 0, nil
	}
	if len(data) == 0 {
		return 0, nil
	}

	// 整段加锁：StreamGuard 持有可变的判定状态，不能被并发喂入。
	w.mu.Lock()
	defer w.mu.Unlock()

	if w.blocked {
		w.discarded += len(data)
		return len(data), nil
	}

	safe, verdict := w.guard.Feed(string(data))

	if verdict == VerdictBlock {
		w.discarded += len(data)
		w.blocked = true
		if w.blockErr == nil {
			w.blockErr = &BlockedError{Reason: w.guard.Reason()}
		}
		return len(data), nil
	}

	if safe == "" {
		w.discarded += len(data)
		return len(data), nil
	}

	n, err := w.ResponseWriter.Write([]byte(safe))
	w.committed += n
	w.discarded += len(data) - n
	return len(data), err
}

// WriteString 走与 Write 相同的判定路径。
func (w *GuardWriter) WriteString(data string) (int, error) {
	return w.Write([]byte(data))
}

// Flush 在未判定时透传，命中后不再刷出任何内容。
func (w *GuardWriter) Flush() {
	if w == nil {
		return
	}
	w.mu.Lock()
	blocked := w.blocked
	w.mu.Unlock()
	if blocked {
		return
	}
	w.ResponseWriter.Flush()
}

// Finish 在上游正常结束时释放保留内容。返回是否为投毒。
//
// 上游中途中断时不要调用，直接丢弃保留内容即可，避免把半截投毒文案放出去。
func (w *GuardWriter) Finish() bool {
	if w == nil {
		return false
	}
	w.mu.Lock()
	if w.blocked {
		w.mu.Unlock()
		return true
	}
	w.mu.Unlock()

	rest, verdict := w.guard.Flush()

	w.mu.Lock()
	defer w.mu.Unlock()
	if verdict == VerdictBlock {
		w.blocked = true
		if w.blockErr == nil {
			w.blockErr = &BlockedError{Reason: w.guard.Reason()}
		}
		return true
	}
	if rest != "" {
		n, _ := w.ResponseWriter.Write([]byte(rest))
		w.committed += n
	}
	w.ResponseWriter.Flush()
	return false
}

// WriteHeader 在已判定投毒时改为错误码，避免先发出 200 再改口。
func (w *GuardWriter) WriteHeader(code int) {
	if w == nil {
		return
	}
	w.mu.Lock()
	blocked := w.blocked
	w.mu.Unlock()
	if blocked {
		return
	}
	w.ResponseWriter.WriteHeader(code)
}

// WriteHeaderNow 与 WriteHeader 保持同样语义。
func (w *GuardWriter) WriteHeaderNow() {
	if w == nil {
		return
	}
	w.mu.Lock()
	blocked := w.blocked
	w.mu.Unlock()
	if blocked {
		return
	}
	w.ResponseWriter.WriteHeaderNow()
}

// WriteError 在命中投毒后写出统一错误响应。
//
// 文案沿用现有上游错误，不暴露投毒事实。已写出过内容时无法回滚，只能中断。
func (w *GuardWriter) WriteError(status int, message string) {
	if w == nil {
		return
	}
	w.mu.Lock()
	committed := w.committed
	w.blocked = true
	w.mu.Unlock()

	if committed > 0 {
		return
	}
	body := []byte(`{"type":"error","error":{"type":"upstream_error","message":` + quoteJSON(message) + `}}`)
	h := w.ResponseWriter.Header()
	h.Set("Content-Type", "application/json; charset=utf-8")
	h.Set("Content-Length", itoa(len(body)))
	w.ResponseWriter.WriteHeader(status)
	_, _ = w.ResponseWriter.Write(body)
	w.ResponseWriter.Flush()
}

func quoteJSON(s string) string {
	b := make([]byte, 0, len(s)+2)
	b = append(b, '"')
	for _, r := range s {
		switch r {
		case '"':
			b = append(b, '\\', '"')
		case '\\':
			b = append(b, '\\', '\\')
		case '\n':
			b = append(b, '\\', 'n')
		case '\r':
			b = append(b, '\\', 'r')
		case '\t':
			b = append(b, '\\', 't')
		default:
			b = append(b, string(r)...)
		}
	}
	b = append(b, '"')
	return string(b)
}

// StatusGuard 返回本请求的 GuardWriter，未启用检测时返回 nil。
func StatusGuard(c *gin.Context) *GuardWriter {
	if c == nil {
		return nil
	}
	if gw, ok := c.Writer.(*GuardWriter); ok {
		return gw
	}
	return nil
}

// DefaultBlockStatus 是命中后返回的 HTTP 状态码。
const DefaultBlockStatus = http.StatusBadGateway
