package poison

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/gin-gonic/gin"
)

// AccountInfo 是接线层从账号对象提取的最小信息集合。
//
// 刻意只保留必要字段，避免本包依赖 service 包的具体类型；接线处负责填充。
type AccountInfo struct {
	// BaseURL 是账号上游地址原文，来自 credentials.base_url。
	BaseURL string
	// HasProxy 表示账号绑定了代理。
	HasProxy bool
	// AccountID 仅用于日志与黑名单记录。
	AccountID int64
	// ProxyID 为 nil 表示未配置代理；仅用于日志与轮换。
	ProxyID *int64
	// ProxyHost / ProxyPort 用于判定出口 IP：静态代理的 host 就是出口 IP，
	// 域名形式的代理需要探测。缺省时跳过出口 IP 记录。
	ProxyHost string
	ProxyPort int
}

// 包级默认 Store：由路由初始化时注入，供各 handler 在账号确定后读取当前配置。
// 未注入时 CurrentSnapshot 返回 nil，检测整体不生效。
var defaultStore struct {
	mu sync.RWMutex
	st *Store
}

// SetStore 注入全局 Store，由服务启动时调用一次。
func SetStore(st *Store) {
	defaultStore.mu.Lock()
	defaultStore.st = st
	defaultStore.mu.Unlock()
}

// CurrentSnapshot 返回当前生效的配置快照，未初始化或未启用时返回 nil。
func CurrentSnapshot() *Snapshot {
	defaultStore.mu.RLock()
	st := defaultStore.st
	defaultStore.mu.RUnlock()
	if st == nil {
		return nil
	}
	return st.Current()
}

// AttachFromAccount 是接线层的最简入口：从账号信息判断并挂载检测。
//
// 返回 true 表示该请求已进入检测；调用方无需关心准入细节。
func AttachFromAccount(c *gin.Context, info AccountInfo) bool {
	return Attach(c, CurrentSnapshot(), info)
}

// Attach 在账号确定后调用：满足准入时标记请求并包装 writer。
//
// 这个函数是接线层的唯一入口，三处 handler 各调用一次即可。必须在任何响应字节
// 写出之前调用，否则已经发出的内容无法回收。
func Attach(c *gin.Context, snap *Snapshot, info AccountInfo) bool {
	if c == nil {
		return false
	}
	if previous := StatusGuard(c); previous != nil {
		// A response already sent (including rejection) cannot be retried. Keep
		// its account attribution and writer until the owning handler finishes.
		if previous.Blocked() || previous.Committed() > 0 {
			return true
		}
		previous.Close()
		if c.Request != nil && previous.parentContext != nil {
			c.Request = c.Request.WithContext(previous.restoreContext(c.Request.Context()))
		}
		c.Writer = previous.ResponseWriter
		c.Set("poison_guard_writer", nil)
		c.Set(ContextKeyActive, nil)
		c.Set(ContextKeyProxyID, nil)
		c.Set(ContextKeyProxyHost, nil)
		c.Set(ContextKeyProxyPort, nil)
	}
	if !snap.Active() {
		return false
	}
	if !snap.Scope.Match(info.BaseURL, info.HasProxy) {
		return false
	}
	// Keep the first admitted forwarding attempt time across account retries.
	if c.Request != nil {
		ctx := c.Request.Context()
		started, _ := ctx.Value(requestStartedAtKey{}).(time.Time)
		if started.IsZero() {
			started = time.Now().UTC()
			c.Request = c.Request.WithContext(context.WithValue(ctx, requestStartedAtKey{}, started))
		}
		c.Set(ContextKeyRequestStartedAt, started)
	}
	MarkRequest(c, snap, info.BaseURL, info.HasProxy)
	WrapWriter(c)
	if snap.EvidenceEnabled && c.Request != nil {
		ctx := c.Request.Context()
		requestID, _ := ctx.Value(ctxkey.RequestID).(string)
		model, _ := ctx.Value(ctxkey.Model).(string)
		s := newEvidenceSession(snap.EvidenceDir, requestID, c.Request.URL.Path, model, info)
		if s != nil {
			StatusGuard(c).evidence = s
			c.Request = c.Request.WithContext(context.WithValue(ctx, evidenceContextKey{}, s))
		}
	}
	c.Set(ContextKeyAccountID, info.AccountID)
	if info.ProxyID != nil {
		c.Set(ContextKeyProxyID, *info.ProxyID)
	}
	if info.ProxyHost != "" {
		c.Set(ContextKeyProxyHost, info.ProxyHost)
	}
	if info.ProxyPort > 0 {
		c.Set(ContextKeyProxyPort, info.ProxyPort)
	}
	return true
}

type requestStartedAtKey struct{}

// 传给后续处置层的上下文键。
const (
	ContextKeyRequestStartedAt = "poison_guard_request_started_at"
	ContextKeyAccountID        = "poison_guard_account_id"
	ContextKeyProxyID          = "poison_guard_proxy_id"
	ContextKeyProxyHost        = "poison_guard_proxy_host"
	ContextKeyProxyPort        = "poison_guard_proxy_port"
)

// NormalizeBaseURL 去掉结尾斜杠，便于前缀比较。
func NormalizeBaseURL(raw string) string {
	return strings.TrimRight(strings.TrimSpace(raw), "/")
}
