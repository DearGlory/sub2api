package poison

import (
	"context"
	"errors"
	"log"
	"net"
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
	ReportDisposition func(Incident, Disposition)
	IncidentCurrent   func(context.Context, Incident) (bool, error)
	RebindIncident    func(context.Context, Incident, int64) error
	DisableIncident   func(context.Context, Incident) error
	// Egress 记录与查询出口 IP 黑名单。
	Egress *EgressStore
	// Prober 探测真实出口 IP，未注入时跳过探测。
	Prober *EgressProber
	// Rotator 选择轮换目标。
	Rotator *Rotator
	// LookupProxy loads the real proxy configuration, including protocol and authentication.
	LookupProxy func(context.Context, int64) (*RotationCandidate, error)
	// DisableAccount 停用账号，由接线层注入。
	DisableAccount func(ctx context.Context, accountID int64) error
	// RebindProxy 把账号的代理换成另一个，返回是否成功。
	RebindProxy func(ctx context.Context, accountID int64, proxyID int64) error
}

// Handle 执行一次命中后的处置。它不返回错误：任何处置失败都不应影响对客户的
// 拦截行为，拦截本身已经在上游 writer 完成。
func (h *Handler) Handle(ctx context.Context, inc Incident) {
	d := Disposition{AccountID: inc.AccountID, RequestID: inc.RequestID, EvidenceID: inc.EvidenceID, EvidencePath: inc.EvidencePath, Outcome: "deferred", Reason: "deferred_dependency", Blacklist: BlacklistDisposition{Status: "not_attempted"}, Selections: []CandidateSelection{}, Attempts: []RotationAttempt{}}
	defer func() { h.report(inc, d) }()
	if h == nil {
		return
	}
	canceled := func() bool {
		if ctx.Err() != nil {
			d.Reason = "deferred_" + rotationReason(ctx.Err())
			return true
		}
		return false
	}
	if canceled() {
		return
	}
	egressIP, isDynamic, resolveErr := h.resolveIncidentEgress(ctx, inc)
	if canceled() {
		return
	}
	if resolveErr != nil {
		d.Blacklist.Status = "egress_lookup_failed"
		d.Reason = "deferred_incident_proxy_query"
		return
	}
	if egressIP != "" {
		if h.Egress == nil || h.Egress.db == nil {
			d.Blacklist.Status = "unavailable"
			d.Reason = "deferred_blacklist"
			return
		}
		d.Blacklist.Status = "failed"
		for retry := 0; retry < 3; retry++ {
			if canceled() {
				return
			}
			d.Blacklist.Attempts++
			err := recordIncidentBlacklist(ctx, h.Egress, egressIP, inc, isDynamic)
			if err == nil {
				d.Blacklist.Status = "saved"
				break
			}
			if errors.Is(err, ErrBlacklistCommitUnknown) {
				d.Blacklist.Status = "commit_unknown"
				d.Reason = "deferred_blacklist"
				return
			}
		}
		if d.Blacklist.Status != "saved" {
			d.Reason = "deferred_blacklist"
			return
		}
	} else {
		d.Blacklist.Status = "egress_unknown"
	}
	if h.IncidentCurrent != nil {
		current, err := h.IncidentCurrent(ctx, inc)
		if canceled() {
			return
		}
		if err != nil {
			d.Reason = "deferred_incident_query"
			return
		}
		if !current {
			d.Outcome = "stale"
			d.Reason = "incident_changed"
			return
		}
	}
	rotateMax := 3
	if snap := CurrentSnapshot(); snap != nil {
		rotateMax = snap.RotateMax
	}
	if rotateMax > 3 {
		rotateMax = 3
	}
	if rotateMax <= 0 {
		d.Reason = "deferred_rotation_disabled"
		return
	}
	if h.Rotator == nil || h.Rotator.ActiveProxies == nil || h.Rotator.Blocked == nil || h.Rotator.InUse == nil || h.Rotator.IsEgressBlocked == nil || (h.RebindProxy == nil && h.RebindIncident == nil) {
		return
	}
	tried := map[int64]struct{}{}
	if inc.ProxyID != nil {
		tried[*inc.ProxyID] = struct{}{}
	}
	unknown := false
	for attempt := 0; attempt <= rotateMax; attempt++ {
		if canceled() {
			return
		}
		next, selection, err := h.Rotator.NextWithDisposition(ctx, tried)
		d.Selections = append(d.Selections, selection)
		if canceled() {
			return
		}
		if err != nil {
			d.Reason = "deferred_" + rotationReason(err)
			return
		}
		if next == nil {
			if unknown {
				d.Reason = "deferred_unresolved_candidates"
				return
			}
			if h.DisableIncident == nil && h.DisableAccount == nil {
				return
			}
			if canceled() {
				return
			}
			if h.DisableIncident != nil {
				err = h.DisableIncident(ctx, inc)
			} else {
				err = h.DisableAccount(ctx, inc.AccountID)
			}
			if errors.Is(err, ErrStaleIncident) {
				d.Outcome = "stale"
				d.Reason = "incident_changed"
				return
			}
			if err != nil {
				d.Reason = "deferred_disable"
				if canceled() {
					return
				}
				return
			}
			d.Outcome = "disabled"
			d.Reason = "candidates_exhausted"
			return
		}
		// This final scan is read-only: never a fourth probe or binding attempt.
		if attempt == rotateMax {
			d.Reason = "deferred_attempt_budget"
			return
		}
		tried[next.ID] = struct{}{}
		a := RotationAttempt{ProxyID: next.ID}
		if err := h.Rotator.ValidateEgress(ctx, next); err != nil {
			a.Reason = rotationReason(err)
			if errors.Is(err, ErrEgressBlocked) {
				a.Outcome = "excluded"
			} else {
				a.Outcome = "unknown"
				unknown = true
			}
			d.Attempts = append(d.Attempts, a)
			if canceled() {
				return
			}
			continue
		}
		if canceled() {
			return
		}
		if h.RebindIncident != nil {
			err = h.RebindIncident(ctx, inc, next.ID)
		} else {
			err = h.RebindProxy(ctx, inc.AccountID, next.ID)
		}
		if errors.Is(err, ErrStaleIncident) {
			a.Outcome = "stale"
			a.Reason = "incident_changed"
			d.Attempts = append(d.Attempts, a)
			d.Outcome = "stale"
			d.Reason = a.Reason
			return
		}
		if err != nil {
			a.Outcome = "unknown"
			a.Reason = "rebind_failed"
			unknown = true
			d.Attempts = append(d.Attempts, a)
			if canceled() {
				return
			}
			continue
		}
		a.Outcome = "rotated"
		a.Reason = "rebind_succeeded"
		d.Attempts = append(d.Attempts, a)
		d.Outcome = "rotated"
		d.Reason = "rebind_succeeded"
		return
	}
}

// resolveEgress 计算本次命中的真实出口 IP，并判断代理是否为动态。
//
// 静态代理（host 是 IP）的出口就是 host；域名形式的代理视为动态，需要实际
// 探测才能知道这次用的是哪个出口 IP。
func (h *Handler) resolveEgress(ctx context.Context, inc Incident) (string, bool) {
	ip, dynamic, _ := h.resolveIncidentEgress(ctx, inc)
	return ip, dynamic
}

func (h *Handler) resolveIncidentEgress(ctx context.Context, inc Incident) (string, bool, error) {
	if h.LookupProxy != nil && inc.ProxyID != nil {
		p, err := h.LookupProxy(ctx, *inc.ProxyID)
		if err != nil || p == nil {
			log.Printf("[poison] proxy %d metadata lookup failed; egress unknown", *inc.ProxyID)
			if err == nil {
				err = ErrRotationUnavailable
			}
			return "", true, rotationError("incident_proxy_query", err)
		}
		inc.ProxyHost = p.Host
		inc.ProxyPort = p.Port
	}
	host := NormalizeBaseURL(inc.ProxyHost)
	if host == "" {
		return "", false, nil
	}
	if net.ParseIP(host) != nil {
		return host, false, nil
	}
	// A fresh probe cannot identify the egress of the original poisoned request.
	// Until the request transport supplies that identity, retain the incident in logs only.
	log.Printf("[poison] account %d dynamic egress unknown", inc.AccountID)
	return "", true, nil
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
	if c.Request != nil {
		inc.RequestStartedAt, _ = c.Request.Context().Value(requestStartedAtKey{}).(time.Time)
	}
	if inc.RequestStartedAt.IsZero() {
		// Dispatch must never bypass restoration checks, even for legacy callers.
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
