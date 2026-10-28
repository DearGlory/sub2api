package poison

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/gin-gonic/gin"
)

// Incident 是一次命中投毒后的处置输入。
type Incident struct {
	// RequestStartedAt is captured on first Attach, before upstream forwarding.
	RequestStartedAt time.Time
	RequestID        string
	EvidenceID       string
	EvidencePath     string
	AccountID        int64
	RestoreEpoch     int64
	SharedGeneration int64
	ProxyID          *int64
	// ProxyHost 是代理主机；静态代理即为出口 IP，域名为动态代理入口。
	ProxyHost string
	// ProxyPort 仅用于日志。
	ProxyPort int
	// Reason 是判定原因，写入黑名单便于事后复核。
	Reason string
}

// Handler 负责命中后的全部副作用：拉黑出口 IP、轮换代理、必要时停用账号。
//
// 所有外部依赖由接线层注入，本包不直接依赖 service；未注入的项为空操作，
// 因此删除本功能只需要删掉本文件与迁移。
var ErrStaleIncident = errors.New("poison incident no longer matches account proxy")

type Handler struct {
	SharedHandle      func(context.Context, Incident) (Disposition, error)
	ReportDisposition func(Incident, Disposition)
}

// Handle 执行一次命中后的处置。它不返回错误：任何处置失败都不应影响对客户的
// 拦截行为，拦截本身已经在上游 writer 完成。
func (h *Handler) Handle(ctx context.Context, inc Incident) {
	d := Disposition{AccountID: inc.AccountID, RequestID: inc.RequestID, EvidenceID: inc.EvidenceID, EvidencePath: inc.EvidencePath, Outcome: "deferred", Reason: "deferred_dependency", Blacklist: BlacklistDisposition{Status: "not_attempted"}, Selections: []CandidateSelection{}, Attempts: []RotationAttempt{}}
	defer func() { h.report(inc, d) }()
	if h == nil {
		return
	}
	if snap := CurrentSnapshot(); snap != nil && !snap.Active() {
		d.Reason = "guard_disabled"
		return
	}
	if h.SharedHandle == nil {
		d.Reason = "deferred_shared_unavailable"
		return
	}
	result, err := h.SharedHandle(ctx, inc)
	if err != nil {
		d.Reason = "deferred_shared_operation"
		return
	}
	d = result
	d.AccountID, d.RequestID = inc.AccountID, inc.RequestID
	d.EvidenceID, d.EvidencePath = inc.EvidenceID, inc.EvidencePath
	if d.Outcome == "" {
		d.Outcome, d.Reason = "deferred", "deferred_shared_operation"
	}
	return
}

// AttachHandler 注入处置处理器，由路由初始化时调用一次。
func AttachHandler(h *Handler) {
	defaultHandler.mu.Lock()
	defaultHandler.h = h
	defaultHandler.mu.Unlock()
}

var defaultHandler struct {
	mu sync.RWMutex
	h  *Handler
}

// CurrentHandler 返回已注入的处理器，未注入时为 nil。
func CurrentHandler() *Handler {
	defaultHandler.mu.RLock()
	defer defaultHandler.mu.RUnlock()
	return defaultHandler.h
}

// Dispatch 由 middleware 在命中后调用，执行处置副作用。
func Dispatch(c *gin.Context, reason string) {
	h := CurrentHandler()
	if h == nil || c == nil {
		return
	}
	accountID, _ := c.Get(ContextKeyAccountID)
	proxyID, _ := c.Get(ContextKeyProxyID)

	inc := Incident{Reason: reason, RestoreEpoch: c.GetInt64(ContextKeyRestoreEpoch), SharedGeneration: c.GetInt64("poison_guard_shared_generation")}
	if c.Request != nil {
		inc.RequestStartedAt, _ = c.Request.Context().Value(requestStartedAtKey{}).(time.Time)
	}
	if inc.RequestStartedAt.IsZero() {
		// Keep a diagnostic timestamp for legacy dispatch callers.
		inc.RequestStartedAt = time.Unix(0, 0).UTC()
	}
	if c.Request != nil {
		inc.RequestID, _ = c.Request.Context().Value(ctxkey.RequestID).(string)
	}
	inc.EvidenceID = c.GetString("poison_guard_evidence_id")
	inc.EvidencePath = c.GetString("poison_guard_evidence_path")
	if v, ok := accountID.(int64); ok {
		inc.AccountID = v
	}
	if v, ok := proxyID.(int64); ok {
		inc.ProxyID = &v
	}
	if host, ok := c.Get(ContextKeyProxyHost); ok {
		if s, ok := host.(string); ok {
			inc.ProxyHost = s
		}
	}
	if port, ok := c.Get(ContextKeyProxyPort); ok {
		if n, ok := port.(int); ok {
			inc.ProxyPort = n
		}
	}
	if inc.AccountID == 0 {
		return
	}
	// 处置包含网络探测与数据库写入，不能阻塞响应收尾。
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		h.Handle(ctx, inc)
	}()
}
