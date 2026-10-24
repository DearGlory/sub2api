package poison

import (
	"context"
	"strings"
	"testing"
)

// fakeEgress 模拟黑名单存储，用于测试轮换选择逻辑。
type fakeEgress struct {
	blockedProxy map[int64]struct{}
	blockedIP    map[string]struct{}
	recorded     []string
}

func newFakeEgress() *fakeEgress {
	return &fakeEgress{
		blockedProxy: map[int64]struct{}{},
		blockedIP:    map[string]struct{}{},
	}
}

func TestRotatorSkipsBlockedProxyRows(t *testing.T) {
	fake := newFakeEgress()
	fake.blockedProxy[1] = struct{}{}

	proxies := []RotationCandidate{
		{ID: 1, Name: "blocked", Host: "1.1.1.1", Port: 1080, Protocol: "socks5"},
		{ID: 2, Name: "clean", Host: "2.2.2.2", Port: 1080, Protocol: "socks5"},
	}
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) { return proxies, nil },
		Blocked:       func(ctx context.Context) (map[int64]struct{}, error) { return fake.blockedProxy, nil },
		IsEgressBlocked: func(ctx context.Context, ip string) (bool, error) {
			_, bad := fake.blockedIP[ip]
			return bad, nil
		},
	}

	got, err := r.Next(context.Background(), nil)
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if got == nil || got.ID != 2 {
		t.Fatalf("must skip blocked proxy row, got %+v", got)
	}
}

func TestRotatorSkipsStaticHostWithBlockedEgress(t *testing.T) {
	fake := newFakeEgress()
	fake.blockedIP["3.3.3.3"] = struct{}{}

	proxies := []RotationCandidate{
		{ID: 3, Host: "3.3.3.3", Port: 1080, Protocol: "socks5"},
		{ID: 4, Host: "4.4.4.4", Port: 1080, Protocol: "socks5"},
	}
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) { return proxies, nil },
		Blocked:       func(ctx context.Context) (map[int64]struct{}, error) { return fake.blockedProxy, nil },
		IsEgressBlocked: func(ctx context.Context, ip string) (bool, error) {
			_, bad := fake.blockedIP[ip]
			return bad, nil
		},
	}

	got, err := r.Next(context.Background(), nil)
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if got == nil || got.ID != 4 {
		t.Fatalf("must skip static host whose egress IP is blocked, got %+v", got)
	}
}

// TestRotatorKeepsDynamicHostCandidates 验证域名形式的动态代理不会因为 host
// 无法判定出口 IP 而被跳过——它的出口只能靠探测确认。
func TestRotatorKeepsDynamicHostCandidates(t *testing.T) {
	fake := newFakeEgress()
	proxies := []RotationCandidate{
		{ID: 9, Host: "dyn.proxy.example", Port: 1080, Protocol: "socks5"},
	}
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) { return proxies, nil },
		Blocked:       func(ctx context.Context) (map[int64]struct{}, error) { return fake.blockedProxy, nil },
		IsEgressBlocked: func(ctx context.Context, ip string) (bool, error) {
			return false, nil
		},
	}

	got, err := r.Next(context.Background(), nil)
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if got == nil || got.ID != 9 {
		t.Fatalf("dynamic host must stay a candidate, got %+v", got)
	}
}

func TestRotatorHonorsSkipSet(t *testing.T) {
	fake := newFakeEgress()
	proxies := []RotationCandidate{
		{ID: 1, Host: "1.1.1.1", Port: 1080},
		{ID: 2, Host: "2.2.2.2", Port: 1080},
	}
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) { return proxies, nil },
		Blocked:       func(ctx context.Context) (map[int64]struct{}, error) { return fake.blockedProxy, nil },
	}

	got, err := r.Next(context.Background(), map[int64]struct{}{1: {}})
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if got == nil || got.ID != 2 {
		t.Fatalf("must skip already-tried proxy, got %+v", got)
	}
}

func TestRotatorReturnsNilWhenExhausted(t *testing.T) {
	fake := newFakeEgress()
	fake.blockedProxy[1] = struct{}{}
	proxies := []RotationCandidate{{ID: 1, Host: "1.1.1.1", Port: 1080}}
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) { return proxies, nil },
		Blocked:       func(ctx context.Context) (map[int64]struct{}, error) { return fake.blockedProxy, nil },
	}

	got, err := r.Next(context.Background(), nil)
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	if got != nil {
		t.Fatalf("expected exhaustion, got %+v", got)
	}
}

func TestRotationCandidateProxyURL(t *testing.T) {
	c := &RotationCandidate{Host: "1.2.3.4", Port: 8080, Protocol: "socks5"}
	if got := c.ProxyURL(); got != "socks5://1.2.3.4:8080" {
		t.Fatalf("ProxyURL()=%q", got)
	}
	c2 := &RotationCandidate{Host: "1.2.3.4", Port: 8080}
	if got := c2.ProxyURL(); got != "http://1.2.3.4:8080" {
		t.Fatalf("default protocol ProxyURL()=%q", got)
	}
}

// TestDefaultKeywordsCoverReplyText 确认默认关键词能命中真实回复正文，
// 且新增的 您好/这里是 确实参与判定。
func TestDefaultKeywordsCoverReplyText(t *testing.T) {
	snap := parse(map[string]string{SettingEnabled: "true"})

	// 真实投毒回复正文（不含请求侧的指令句）。
	reply := "您好，这里是  https://kedaya.ai  中转站，您正在使用一个被盗取的key"
	if res := snap.Detector.Inspect(reply); !res.Poisoned {
		t.Fatalf("reply must be detected, got %+v", res)
	}

	// kedaya 已被扣留，仅剩 您好 + 这里是 时也应由阈值判定。
	partial := "您好，这里是 https://某中转站 中转站，您正在使用一个被盗取的key"
	res := snap.Detector.Inspect(partial)
	if !res.Poisoned {
		t.Fatalf("您好+这里是+被盗取+key must reach threshold, got %+v", res)
	}
	if !strings.HasPrefix(res.Reason, "threshold:") {
		t.Fatalf("expected threshold verdict, got %q", res.Reason)
	}

	// 只出现弱信号不应误判。
	if res := snap.Detector.Inspect("您好，这是您要的代码。"); res.Poisoned {
		t.Fatalf("greeting alone must not trigger, got %q", res.Reason)
	}
}
