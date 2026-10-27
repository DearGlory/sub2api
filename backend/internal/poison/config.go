package poison

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

// 配置键统一使用 poison_guard_ 前缀，便于一次性清理。
const (
	SettingEvidenceEnabled  = "poison_guard_evidence_enabled"
	SettingEvidenceDir      = "poison_guard_evidence_dir"
	SettingEnabled          = "poison_guard_enabled"
	SettingUpstreamPrefixes = "poison_guard_upstream_prefixes"
	SettingKeywordsVeto     = "poison_guard_keywords_veto"
	SettingKeywordsStrong   = "poison_guard_keywords_strong"
	SettingKeywordsWeak     = "poison_guard_keywords_weak"
	SettingThreshold        = "poison_guard_threshold"
	SettingRotateMax        = "poison_guard_rotate_max"
	SettingEgressProbe      = "poison_guard_egress_probe"
	SettingBlockMessage     = "poison_guard_block_message"
	SettingHeadBuffer       = "poison_guard_head_buffer"
)

// AllSettings 是本功能读取的全部配置键，删除功能时按此清单清理。
func AllSettings() []string {
	return []string{
		SettingEvidenceEnabled, SettingEvidenceDir, SettingSharedEnabled,
		SettingEnabled,
		SettingUpstreamPrefixes,
		SettingKeywordsVeto,
		SettingKeywordsStrong,
		SettingKeywordsWeak,
		SettingThreshold,
		SettingRotateMax,
		SettingEgressProbe,
		SettingBlockMessage,
		SettingHeadBuffer,
	}
}

// DefaultHeadBufferRunes is the initial decoded-content window per output lane.
// SSE framing and metadata do not consume it. Short clean content is released
// at the lane's terminal event; the window adds generation-time waiting until
// enough content is available, not just the CPU time spent inspecting it.
const DefaultHeadBufferRunes = 512

// DefaultBlockMessage 与现有上游错误文案保持一致，不暴露投毒事实。
const DefaultBlockMessage = "Upstream request failed"

// DefaultUpstreamPrefixes 是已知会注入盗用提示的上游。
func DefaultUpstreamPrefixes() []string {
	return []string{
		"https://kedaya.ai",
		"https://sub.kedaya.xyz",
		"http://51.222.42.218:17777",
		"http://51.161.119.83:17777",
	}
}

func DefaultVetoKeywords() []string { return []string{"kedaya", "kedaya.ai"} }
func DefaultStrongKeywords() []string {
	return []string{"盗", "偷", "窃", "这里是"}
}
func DefaultWeakKeywords() []string { return []string{"Key", "密钥", "您好"} }

// SettingsFetcher 返回当前生效的配置快照。由接线层注入，避免本包依赖 service。
type SettingsFetcher func() (map[string]string, error)

// Snapshot 是一次配置加载后的不可变视图。
type Snapshot struct {
	SharedEnabled   bool
	EvidenceEnabled bool
	EvidenceDir     string
	Enabled         bool
	Detector        *Detector
	Scope           *Scope
	RotateMax       int
	EgressProbe     bool
	BlockMsg        string
}

// Active 报告该快照是否应启用检测。
func (s *Snapshot) Active() bool {
	return s != nil && s.Enabled && s.Detector != nil && s.Scope != nil && s.Scope.Enabled()
}

// Store 持有当前生效快照，支持热更新。
type Store struct {
	fetch SettingsFetcher
	cur   atomic.Pointer[Snapshot]
	mu    sync.Mutex
}

// NewStore 创建配置存储并载入一次；载入失败时使用默认值，保证服务可用。
func NewStore(fetch SettingsFetcher) *Store {
	st := &Store{fetch: fetch}
	st.cur.Store(parse(nil))
	return st
}

// Current 返回当前快照。
func (st *Store) Current() *Snapshot {
	if st == nil {
		return nil
	}
	return st.cur.Load()
}

// Reload 重新读取配置并替换快照。供设置更新回调调用。
func (st *Store) Reload() error {
	if st == nil || st.fetch == nil {
		return nil
	}
	st.mu.Lock()
	defer st.mu.Unlock()

	values, err := st.fetch()
	if err != nil {
		return err
	}
	st.cur.Store(parse(values))
	return nil
}

// parse 把字符串配置解析成快照。缺失或非法的项回落到默认值。
func parse(values map[string]string) *Snapshot {
	get := func(key string) (string, bool) {
		if values == nil {
			return "", false
		}
		v, ok := values[key]
		return v, ok
	}

	snap := &Snapshot{
		RotateMax:   3,
		EgressProbe: true,
		BlockMsg:    DefaultBlockMessage,
	}

	if v, ok := get(SettingEnabled); ok {
		snap.Enabled = parseBool(v, false)
	}
	if v, ok := get(SettingSharedEnabled); ok {
		snap.SharedEnabled = parseBool(v, false)
	}

	veto := parseList(get, SettingKeywordsVeto, DefaultVetoKeywords)
	strong := parseList(get, SettingKeywordsStrong, DefaultStrongKeywords)
	weak := parseList(get, SettingKeywordsWeak, DefaultWeakKeywords)
	threshold := parseInt(get, SettingThreshold, 3)

	headBuffer := parseInt(get, SettingHeadBuffer, DefaultHeadBufferRunes)

	snap.Detector = NewDetector(Config{
		Veto:            veto,
		Strong:          strong,
		Weak:            weak,
		Threshold:       threshold,
		HeadBufferRunes: headBuffer,
	})
	snap.Scope = NewScope(parseList(get, SettingUpstreamPrefixes, DefaultUpstreamPrefixes), true)

	snap.RotateMax = parseInt(get, SettingRotateMax, 3)
	if snap.RotateMax < 0 {
		snap.RotateMax = 0
	}
	if v, ok := get(SettingEgressProbe); ok {
		snap.EgressProbe = parseBool(v, true)
	}
	if v, ok := get(SettingBlockMessage); ok && strings.TrimSpace(v) != "" {
		snap.BlockMsg = strings.TrimSpace(v)
	}

	if v, ok := get(SettingEvidenceEnabled); ok {
		snap.EvidenceEnabled = parseBool(v, false)
	}
	snap.EvidenceDir = "./data/poison-evidence"
	if v, ok := get(SettingEvidenceDir); ok && strings.TrimSpace(v) != "" {
		snap.EvidenceDir = strings.TrimSpace(v)
	}
	return snap
}

// parseList 支持 JSON 数组与逗号分隔两种写法。do 为空时使用默认值。
func parseList(get func(string) (string, bool), key string, fallback func() []string) []string {
	raw, ok := get(key)
	if !ok || strings.TrimSpace(raw) == "" {
		return fallback()
	}
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "[") {
		var out []string
		if err := json.Unmarshal([]byte(raw), &out); err == nil && len(out) > 0 {
			return out
		}
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return fallback()
	}
	return out
}

func parseInt(get func(string) (string, bool), key string, fallback int) int {
	raw, ok := get(key)
	if !ok {
		return fallback
	}
	v, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return fallback
	}
	return v
}

func parseBool(raw string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	}
	return fallback
}
