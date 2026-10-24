package poison

import (
	"context"
	"net"
	"strings"
)

// RotationCandidate 是轮换时可选的代理。
type RotationCandidate struct {
	ID       int64
	Name     string
	Host     string
	Port     int
	Protocol string
}

// Rotator 决定命中投毒后该换哪个代理。
//
// 规则（与需求一致）：
//   - 只从 proxies 中 status=active 且未进黑名单的代理里挑；
//   - 动态代理不整行拉黑，只轮换会话，但其历史出口 IP 仍在黑名单中，因此
//     轮换出来的新出口若命中黑名单要再轮一次；
//   - 轮换次数上限可配，默认 3；用尽后停用账号。
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

// Next 返回下一个可用代理，排除 skip 中已有的 ID。
//
// 找不到时返回 nil，调用方应停用账号。
func (r *Rotator) Next(ctx context.Context, skip map[int64]struct{}) (*RotationCandidate, error) {
	if r == nil || r.ActiveProxies == nil {
		return nil, nil
	}
	candidates, err := r.ActiveProxies(ctx)
	if err != nil {
		return nil, err
	}
	blocked := map[int64]struct{}{}
	if r.Blocked != nil {
		if b, err := r.Blocked(ctx); err == nil {
			blocked = b
		}
	}
	inUse := map[string]struct{}{}
	if r.InUse != nil {
		if u, err := r.InUse(ctx); err == nil {
			inUse = u
		}
	}

	for i := range candidates {
		c := &candidates[i]
		if _, bad := blocked[c.ID]; bad {
			continue
		}
		if _, taken := inUse[c.endpoint()]; taken {
			continue
		}
		if skip != nil {
			if _, used := skip[c.ID]; used {
				continue
			}
		}
		// 静态代理的出口 IP 就是 host，可直接判断是否已知脏 IP，
		// 避免把请求再送进一个已拉黑的出口白跑一次。
		if r.IsEgressBlocked != nil && isStaticHost(c.Host) {
			if dirty, err := r.IsEgressBlocked(ctx, c.Host); err == nil && dirty {
				continue
			}
		}
		return c, nil
	}
	return nil, nil
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
	return strings.TrimSpace(strings.ToLower(c.Host)) + ":" + itoa(c.Port)
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
	return proto + "://" + c.Host + ":" + itoa(c.Port)
}
