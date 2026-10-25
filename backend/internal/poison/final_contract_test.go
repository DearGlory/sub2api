package poison

import (
	"context"
	"testing"
)

func TestConfiguredBareKeywordsMatchOwnerContract(t *testing.T) {
	d := activeSnapshot().Detector
	for _, text := range []string{"这个 Key 的密钥被偷了", "有人窃了密钥和 key", "盗走的 Key 与密钥"} {
		if !d.Inspect(text).Poisoned {
			t.Errorf("bare keyword contract missed: %q", text)
		}
	}
	if d.Inspect("盗盗盗").Poisoned {
		t.Fatal("repeated bare word counted more than once")
	}
}

func TestRotatorDoesNotRetryDuplicateEndpointRows(t *testing.T) {
	r := &Rotator{ActiveProxies: func(context.Context) ([]RotationCandidate, error) {
		return []RotationCandidate{{ID: 1, Host: "192.0.2.1", Port: 80}, {ID: 2, Host: "192.0.2.1", Port: 80}, {ID: 3, Host: "192.0.2.2", Port: 80}}, nil
	}}
	next, err := r.Next(context.Background(), map[int64]struct{}{1: {}})
	if err != nil || next == nil || next.ID != 3 {
		t.Fatalf("duplicate endpoint retried: candidate=%v err=%v", next, err)
	}
}
