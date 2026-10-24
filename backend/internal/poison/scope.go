package poison

import "strings"

// Scope 决定某个账号的请求是否进入检测。
//
// 两个条件必须同时满足，缺一不可：
//  1. 账号上游 base_url 命中白名单前缀；
//  2. 账号配置了代理。
//
// 未同时满足的账号走原有路径，本包不产生任何额外开销。
type Scope struct {
	prefixes []string
	enabled  bool
}

// NewScope 构造准入判定。prefixes 为空或 enabled 为 false 时恒不启用。
func NewScope(prefixes []string, enabled bool) *Scope {
	clean := make([]string, 0, len(prefixes))
	for _, raw := range prefixes {
		p := strings.ToLower(strings.TrimSpace(raw))
		if p == "" {
			continue
		}
		// 统一去掉结尾斜杠，避免配置写成 https://host/ 时匹配不上。
		p = strings.TrimRight(p, "/")
		clean = append(clean, p)
	}
	return &Scope{prefixes: clean, enabled: enabled && len(clean) > 0}
}

// Enabled 报告准入判定是否具备生效条件。
func (s *Scope) Enabled() bool { return s != nil && s.enabled }

// Count 返回已配置的上游前缀数量，仅用于启动日志。
func (s *Scope) Count() int {
	if s == nil {
		return 0
	}
	return len(s.prefixes)
}

// Match 判断账号是否进入检测：必须同时命中上游前缀且有代理。
//
// baseURL 需要匹配 host 与端口前缀，允许 openai 协议带 /v1 后缀，因此按字符串前缀
// 比较而不是整体相等。hasProxy 表示账号是否绑定了代理。
func (s *Scope) Match(baseURL string, hasProxy bool) bool {
	if !s.Enabled() {
		return false
	}
	if !hasProxy {
		return false
	}
	u := strings.ToLower(strings.TrimSpace(baseURL))
	if u == "" {
		return false
	}
	for _, p := range s.prefixes {
		if u == p || strings.HasPrefix(u, p+"/") {
			return true
		}
	}
	return false
}
