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

// Rotator validates proxy egress for the shared coordinator.
type Rotator struct {
	IsEgressBlocked func(context.Context, string) (bool, error)
	Prober          *EgressProber
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
