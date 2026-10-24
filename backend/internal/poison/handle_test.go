package poison

import (
	"context"
	"errors"
	"testing"
)

// fakeHandlerDeps 收集 Handler 触发的副作用，用于断言处置顺序与结果。
type fakeHandlerDeps struct {
	recorded  []string // 形如 "record:IP"
	rotated   []int64
	disabled  []int64
	probeErr  error
	rotateErr error
}

func newTestHandler(deps *fakeHandlerDeps, proxies []RotationCandidate, blocked map[int64]struct{}) *Handler {
	rotator := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) {
			return proxies, nil
		},
		Blocked: func(ctx context.Context) (map[int64]struct{}, error) {
			return blocked, nil
		},
		IsEgressBlocked: func(ctx context.Context, ip string) (bool, error) {
			return false, nil
		},
	}
	return &Handler{
		Rotator: rotator,
		DisableAccount: func(ctx context.Context, accountID int64) error {
			deps.disabled = append(deps.disabled, accountID)
			return nil
		},
		RebindProxy: func(ctx context.Context, accountID int64, proxyID int64) error {
			if deps.rotateErr != nil {
				return deps.rotateErr
			}
			deps.rotated = append(deps.rotated, proxyID)
			return nil
		},
	}
}

// TestHandleRotatesToCleanProxy 命中后应换到未拉黑的代理，且不停用账号。
func TestHandleRotatesToCleanProxy(t *testing.T) {
	deps := &fakeHandlerDeps{}
	proxies := []RotationCandidate{
		{ID: 1, Host: "1.1.1.1", Port: 1080},
		{ID: 2, Host: "2.2.2.2", Port: 1080},
	}
	h := newTestHandler(deps, proxies, map[int64]struct{}{1: {}})

	current := int64(1)
	h.Handle(context.Background(), Incident{
		AccountID: 42,
		ProxyID:   &current,
		ProxyHost: "1.1.1.1",
		ProxyPort: 1080,
		Reason:    "veto:kedaya",
	})

	if len(deps.rotated) != 1 || deps.rotated[0] != 2 {
		t.Fatalf("expected rotation to proxy 2, got %v", deps.rotated)
	}
	if len(deps.disabled) != 0 {
		t.Fatalf("account must stay enabled after successful rotation, got disabled=%v", deps.disabled)
	}
}

// TestHandleDisablesWhenNoCleanProxy 没有可用代理时应停用账号。
func TestHandleDisablesWhenNoCleanProxy(t *testing.T) {
	deps := &fakeHandlerDeps{}
	proxies := []RotationCandidate{{ID: 1, Host: "1.1.1.1", Port: 1080}}
	h := newTestHandler(deps, proxies, map[int64]struct{}{1: {}})

	current := int64(1)
	h.Handle(context.Background(), Incident{
		AccountID: 42,
		ProxyID:   &current,
		ProxyHost: "1.1.1.1",
		ProxyPort: 1080,
		Reason:    "veto:kedaya",
	})

	if len(deps.rotated) != 0 {
		t.Fatalf("nothing to rotate to, got %v", deps.rotated)
	}
	if len(deps.disabled) != 1 || deps.disabled[0] != 42 {
		t.Fatalf("account must be disabled, got %v", deps.disabled)
	}
}

// TestHandleDisablesWhenRebindFails 轮换失败时也应停用账号。
func TestHandleDisablesWhenRebindFails(t *testing.T) {
	deps := &fakeHandlerDeps{rotateErr: errors.New("db down")}
	proxies := []RotationCandidate{
		{ID: 1, Host: "1.1.1.1", Port: 1080},
		{ID: 2, Host: "2.2.2.2", Port: 1080},
	}
	h := newTestHandler(deps, proxies, map[int64]struct{}{})

	current := int64(1)
	h.Handle(context.Background(), Incident{
		AccountID: 7,
		ProxyID:   &current,
		ProxyHost: "1.1.1.1",
		ProxyPort: 1080,
		Reason:    "threshold:3/3",
	})

	if len(deps.disabled) != 1 || deps.disabled[0] != 7 {
		t.Fatalf("account must be disabled when rotation fails, got %v", deps.disabled)
	}
}

// TestHandleNilRecovers 处理器未注入时 Handle 必须安全。
func TestHandleNilRecovers(t *testing.T) {
	var h *Handler
	h.Handle(context.Background(), Incident{AccountID: 1})
}

// TestDispatchWithoutHandler 未装配处理器时 Dispatch 不应 panic。
func TestDispatchWithoutHandler(t *testing.T) {
	Dispatch(nil, "veto:kedaya")
}

// TestIsStaticHost 静态代理与域名代理的区分是出口 IP 判定的前提。
func TestIsStaticHost(t *testing.T) {
	cases := map[string]bool{
		"1.2.3.4":         true,
		"51.222.42.218":   true,
		"dyn.example.com": false,
		"":                false,
		"2001:db8::1":     true,
	}
	for host, want := range cases {
		if got := isStaticHost(host); got != want {
			t.Fatalf("isStaticHost(%q)=%v want %v", host, got, want)
		}
	}
}
