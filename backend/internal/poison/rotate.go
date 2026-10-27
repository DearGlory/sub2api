package poison

import (
	"context"

	"net"
	"net/url"
	"strings"
)

// RotationCandidate 是轮换时可选的代理。
type RotationCandidate struct {
	ID       int64
	Name     string
	Host     string
	Port     int
	Protocol string
	Username string
	Password string
}

// Rotator 决定命中投毒后该换哪个代理。
//
// 规则（与需求一致）：
//   - 只从 proxies 中 status=active 且未进黑名单的代理里挑；
//   - 动态代理不整行拉黑，只轮换会话，但其历史出口 IP 仍在黑名单中，因此
//     轮换出来的新出口若命中黑名单要再轮一次；
//   - 轮换次数上限可配，默认 3；预算耗尽不代表候选穷尽。
type Rotator struct {
	// ActiveProxies 返回全部可用代理，由接线层注入。
	ActiveProxies func(ctx context.Context) ([]RotationCandidate, error)
	// Blocked 返回已拉黑的代理行 ID 集合。
	Blocked func(ctx context.Context) (map[int64]struct{}, error)
	// IsEgressBlocked 报告某个出口 IP 是否在黑名单中。
	IsEgressBlocked func(ctx context.Context, ip string) (bool, error)
	// InUse 返回已被其他账号占用的代理出口集合。
	//
	// 键是 endpoint（host:port）而不是代理行 ID：proxies 表里同一个出口地址存在
	// 多行记录（线上 12 个 IP 各有 3 行重复），只按行 ID 排除仍会挑到同一个出口，
	// 换号等于没换。
	//
	// 复用别人正在用的出口会把两个账号绑在同一个 IP 上：一旦这个出口后续被判定
	// 投毒，两个号一起遭殃。因此轮换目标必须是没有其他账号在用的出口。
	InUse func(ctx context.Context) (map[string]struct{}, error)
	// Prober 用于确认真实出口 IP。
	Prober *EgressProber
}

// Next selects without probing. A nil result alone never proves safe exhaustion.
func (r *Rotator) Next(ctx context.Context, skip map[int64]struct{}) (*RotationCandidate, error) {
	c, _, err := r.NextWithDisposition(ctx, skip)
	return c, err
}

// NextWithDisposition records the full read-only candidate scan, including empty pools.
func (r *Rotator) NextWithDisposition(ctx context.Context, skip map[int64]struct{}) (*RotationCandidate, CandidateSelection, error) {
	audit := CandidateSelection{Excluded: map[string]int{}, Candidates: []CandidateDecision{}}
	fail := func(kind string, err error) (*RotationCandidate, CandidateSelection, error) {
		audit.Error = kind
		return nil, audit, rotationError(kind, err)
	}
	if err := ctx.Err(); err != nil {
		return fail("context", err)
	}
	if r == nil || r.ActiveProxies == nil {
		return fail("active_unavailable", ErrRotationUnavailable)
	}
	candidates, err := r.ActiveProxies(ctx)
	if err != nil {
		return fail("active_query", err)
	}
	audit.Total = len(candidates)
	blocked := map[int64]struct{}{}
	if r.Blocked != nil {
		blocked, err = r.Blocked(ctx)
		if err != nil {
			return fail("blocked_query", err)
		}
	}
	inUse := map[string]struct{}{}
	if r.InUse != nil {
		inUse, err = r.InUse(ctx)
		if err != nil {
			return fail("occupied_query", err)
		}
	}
	skippedEndpoints := map[string]struct{}{}
	for i := range candidates {
		if _, ok := skip[candidates[i].ID]; ok {
			skippedEndpoints[candidates[i].endpoint()] = struct{}{}
		}
	}
	var next *RotationCandidate
	for i := range candidates {
		if err := ctx.Err(); err != nil {
			return fail("context", err)
		}
		c := &candidates[i]
		reason := "eligible"
		_, skipped := skip[c.ID]
		_, sameEndpoint := skippedEndpoints[c.endpoint()]
		_, bad := blocked[c.ID]
		_, taken := inUse[c.endpoint()]
		switch {
		case skipped || sameEndpoint:
			reason = "tried_endpoint"
		case bad:
			reason = "blocked_proxy"
		case taken:
			reason = "occupied_endpoint"
		default:
			if r.IsEgressBlocked != nil && isStaticHost(c.Host) {
				dirty, err := r.IsEgressBlocked(ctx, strings.TrimSpace(c.Host))
				if err != nil {
					audit.Candidates = append(audit.Candidates, CandidateDecision{ProxyID: c.ID, Reason: "egress_query_unknown"})
					return fail("egress_query", err)
				}
				if dirty {
					reason = "blocked_egress"
				}
			}
		}
		audit.Candidates = append(audit.Candidates, CandidateDecision{ProxyID: c.ID, Reason: reason})
		if reason == "eligible" {
			audit.Eligible++
			if next == nil {
				next = c
			}
		} else {
			audit.Excluded[reason]++
		}
	}
	if err := ctx.Err(); err != nil {
		return fail("context", err)
	}
	audit.Complete = true
	return next, audit, nil
}

// ValidateEgress validates a selected candidate before binding it. The
// probe uses the exact configured authentication, without inventing a session API.
func (r *Rotator) ValidateEgress(ctx context.Context, c *RotationCandidate) error {
	if err := ctx.Err(); err != nil {
		return rotationError("context", err)
	}
	if r == nil || c == nil {
		return ErrRotationUnavailable
	}
	if isStaticHost(c.Host) && r.Prober == nil {
		return nil
	}
	if r.Prober == nil {
		return rotationError("probe_unavailable", ErrRotationUnavailable)
	}
	if snap := CurrentSnapshot(); snap != nil && !snap.EgressProbe {
		return rotationError("probe_disabled", ErrRotationUnavailable)
	}
	ip, err := r.Prober.Probe(ctx, c.ProxyURL())
	if err != nil {
		return rotationError("probe_failed", err)
	}
	if r.IsEgressBlocked == nil {
		return rotationError("egress_unavailable", ErrRotationUnavailable)
	}
	dirty, err := r.IsEgressBlocked(ctx, ip)
	if err != nil {
		return rotationError("egress_query", err)
	}
	if dirty {
		return ErrEgressBlocked
	}
	return nil
}

// isStaticHost 判断 host 是否为可直接作为出口 IP 的地址。
//
// 域名形式的代理（如动态代理入口）无法从 host 推断出口 IP，返回 false，
// 这类代理只能靠探测确认。
func isStaticHost(host string) bool {
	host = strings.TrimSpace(host)
	if host == "" {
		return false
	}
	return net.ParseIP(host) != nil
}

// endpoint 返回代理出口的规范化标识 host:port，用于判断两个代理行是否指向
// 同一个实际出口。proxies 表存在同一 host:port 多行记录的情况。
func (c *RotationCandidate) endpoint() string {
	if c == nil {
		return ""
	}
	return Endpoint(c.Host, c.Port)
}

// Endpoint is the normalized key used by selection and transactional occupancy checks.
func Endpoint(host string, port int) string {
	return strings.TrimSpace(strings.ToLower(host)) + ":" + itoa(port)
}

// ProxyURL 拼出可直接用于 HTTP 客户端的代理地址。
func (c *RotationCandidate) ProxyURL() string {
	if c == nil {
		return ""
	}
	proto := strings.TrimSpace(c.Protocol)
	if proto == "" {
		proto = "http"
	}
	u := &url.URL{Scheme: proto, Host: net.JoinHostPort(strings.TrimSpace(c.Host), itoa(c.Port))}
	if c.Username != "" && c.Password != "" {
		u.User = url.UserPassword(c.Username, c.Password)
	}
	return u.String()
}
