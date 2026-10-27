package poison

import (
	"context"
	"testing"
)

func TestRotationLateIncidentDoesNotRotateNewBinding(t *testing.T) {
	oldProxy := int64(1)
	deps := &fakeHandlerDeps{}
	h := newTestHandler(t, deps, []RotationCandidate{{ID: 2, Host: "192.0.2.2", Port: 80}}, nil)
	h.IncidentCurrent = func(context.Context, Incident) (bool, error) { return false, nil }
	h.Handle(context.Background(), Incident{AccountID: 42, ProxyID: &oldProxy, ProxyHost: "192.0.2.1", Reason: "veto:kedaya"})
	if len(deps.rotated) != 0 || len(deps.disabled) != 0 {
		t.Fatalf("late incident changed new binding: rotated=%v disabled=%v", deps.rotated, deps.disabled)
	}
}
