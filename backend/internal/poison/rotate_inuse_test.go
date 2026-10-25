package poison

import (
	"context"
	"testing"
)

// 轮换必须跳过已被其他账号占用的代理，否则会把两个账号绑到同一个出口，
// 并可能把账号换到一个根本不可用的代理上（线上曾因此打空整个账号池）。
func TestRotatorSkipsInUseProxies(t *testing.T) {
	cands := []RotationCandidate{
		{ID: 10, Name: "taken", Host: "1.1.1.1", Port: 1080},
		{ID: 11, Name: "blocked", Host: "2.2.2.2", Port: 1080},
		{ID: 12, Name: "free", Host: "3.3.3.3", Port: 1080},
	}
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) {
			return cands, nil
		},
		Blocked: func(ctx context.Context) (map[int64]struct{}, error) {
			return map[int64]struct{}{11: {}}, nil
		},
		InUse: func(ctx context.Context) (map[string]struct{}, error) {
			return map[string]struct{}{"1.1.1.1:1080": {}}, nil
		},
	}

	got, err := r.Next(context.Background(), nil)
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if got == nil {
		t.Fatal("expected a candidate, got nil")
	}
	if got.ID != 12 {
		t.Fatalf("expected proxy 12 (only free one), got %d", got.ID)
	}
}

// 同一个出口存在多行代理记录时，必须按 host:port 排除，否则会挑到同一个 IP。
// 线上 proxies 表里 12 个 IP 各有 3 行重复记录。
func TestRotatorSkipsDuplicateEndpointRows(t *testing.T) {
	cands := []RotationCandidate{
		{ID: 1, Host: "38.213.131.221", Port: 20000},
		{ID: 13, Host: "38.213.131.221", Port: 20000},
		{ID: 25, Host: "38.213.131.221", Port: 20000},
		{ID: 40, Host: "154.21.158.27", Port: 20000},
	}
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) {
			return cands, nil
		},
		InUse: func(ctx context.Context) (map[string]struct{}, error) {
			return map[string]struct{}{"38.213.131.221:20000": {}}, nil
		},
	}

	got, err := r.Next(context.Background(), nil)
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if got == nil {
		t.Fatal("expected a candidate, got nil")
	}
	if got.Host != "154.21.158.27" {
		t.Fatalf("expected the other endpoint, got %s:%d (id=%d)", got.Host, got.Port, got.ID)
	}
}

// 全部候选都被占用时返回 nil，调用方据此停用账号。
func TestRotatorReturnsNilWhenAllInUse(t *testing.T) {
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) {
			return []RotationCandidate{
				{ID: 10, Host: "1.1.1.1", Port: 1080},
				{ID: 11, Host: "2.2.2.2", Port: 1080},
			}, nil
		},
		InUse: func(ctx context.Context) (map[string]struct{}, error) {
			return map[string]struct{}{
				"1.1.1.1:1080": {},
				"2.2.2.2:1080": {},
			}, nil
		},
	}
	got, err := r.Next(context.Background(), nil)
	if err != nil {
		t.Fatalf("Next: %v", err)
	}
	if got != nil {
		t.Fatalf("expected nil, got proxy %d", got.ID)
	}
}

// InUse 查询失败时必须 fail closed，不能把未知状态当作空占用集合。
func TestRotatorInUseErrorFailsClosed(t *testing.T) {
	r := &Rotator{
		ActiveProxies: func(ctx context.Context) ([]RotationCandidate, error) {
			return []RotationCandidate{{ID: 10, Host: "1.1.1.1", Port: 1080}}, nil
		},
		InUse: func(ctx context.Context) (map[string]struct{}, error) {
			return nil, context.DeadlineExceeded
		},
	}
	got, err := r.Next(context.Background(), nil)
	if err == nil {
		t.Fatal("expected InUse query error")
	}
	if got != nil {
		t.Fatalf("must not return candidate after InUse error, got %+v", got)
	}
}
