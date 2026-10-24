package poison

import (
	"context"
	"log"
	"net"
	"sync"

	"github.com/gin-gonic/gin"
)

// Incident 是一次命中投毒后的处置输入。
type Incident struct {
	AccountID int64
	ProxyID   *int64
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
type Handler struct {
	// Egress 记录与查询出口 IP 黑名单。
	Egress *EgressStore
	// Prober 探测真实出口 IP，未注入时跳过探测。
	Prober *EgressProber
	// Rotator 选择轮换目标。
	Rotator *Rotator
	// DisableAccount 停用账号，由接线层注入。
	DisableAccount func(ctx context.Context, accountID int64) error
	// RebindProxy 把账号的代理换成另一个，返回是否成功。
	RebindProxy func(ctx context.Context, accountID int64, proxyID int64) error
}

// Handle 执行一次命中后的处置。它不返回错误：任何处置失败都不应影响对客户的
// 拦截行为，拦截本身已经在上游 writer 完成。
func (h *Handler) Handle(ctx context.Context, inc Incident) {
	if h == nil {
		return
	}

	egressIP, isDynamic := h.resolveEgress(ctx, inc)

	// 1) 拉黑出口 IP。命中即永久拉黑，不设过期。
	if h.Egress != nil && egressIP != "" {
		if err := h.Egress.Record(ctx, egressIP, inc.ProxyID, &inc.AccountID, isDynamic, inc.Reason); err != nil {
			log.Printf("[poison] record blocked egress %s failed: %v", egressIP, err)
		}
	}

	snap := CurrentSnapshot()
	rotateMax := 3
	if snap != nil {
		rotateMax = snap.RotateMax
	}

	// 2) 尝试轮换代理。次数用尽或没有可用代理时停用账号。
	rotated := false
	if h.Rotator != nil && h.RebindProxy != nil && rotateMax > 0 {
		tried := map[int64]struct{}{}
		if inc.ProxyID != nil {
			tried[*inc.ProxyID] = struct{}{}
		}
		for attempt := 0; attempt < rotateMax; attempt++ {
			next, err := h.Rotator.Next(ctx, tried)
			if err != nil {
				log.Printf("[poison] pick rotation target failed: %v", err)
				break
			}
			if next == nil {
				break
			}
			tried[next.ID] = struct{}{}
			if err := h.RebindProxy(ctx, inc.AccountID, next.ID); err != nil {
				log.Printf("[poison] rebind account %d to proxy %d failed: %v", inc.AccountID, next.ID, err)
				continue
			}
			log.Printf("[poison] account %d rotated to proxy %d (%s)", inc.AccountID, next.ID, next.Name)
			rotated = true
			break
		}
	}

	// 3) 轮换不到干净代理则停用账号，避免继续被投毒。
	if !rotated && h.DisableAccount != nil {
		if err := h.DisableAccount(ctx, inc.AccountID); err != nil {
			log.Printf("[poison] disable account %d failed: %v", inc.AccountID, err)
		} else {
			log.Printf("[poison] account %d disabled after poison hit (%s)", inc.AccountID, inc.Reason)
		}
	}
}

// resolveEgress 计算本次命中的真实出口 IP，并判断代理是否为动态。
//
// 静态代理（host 是 IP）的出口就是 host；域名形式的代理视为动态，需要实际
// 探测才能知道这次用的是哪个出口 IP。
func (h *Handler) resolveEgress(ctx context.Context, inc Incident) (string, bool) {
	host := NormalizeBaseURL(inc.ProxyHost)
	if host == "" {
		return "", false
	}
	if net.ParseIP(host) != nil {
		return host, false
	}
	if h.Prober == nil {
		return host, true
	}
	snap := CurrentSnapshot()
	if snap != nil && !snap.EgressProbe {
		return host, true
	}
	ip, err := h.Prober.Probe(ctx, host+":"+itoa(inc.ProxyPort))
	if err != nil {
		log.Printf("[poison] probe egress for %s failed: %v", host, err)
		return host, true
	}
	return ip, true
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

	inc := Incident{Reason: reason}
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
	go h.Handle(context.Background(), inc)
}
