package server

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
)

func TestPoisonSharedRuntimeLifecycle(t *testing.T) {
	enabled := false
	starts, stops := 0, 0
	var workerCtx context.Context
	runtime := newPoisonSharedLifecycle(func() *poison.Snapshot {
		return &poison.Snapshot{Enabled: true, SharedEnabled: enabled, Detector: poison.NewDetector(poison.Config{}), Scope: poison.NewScope([]string{"https://scope.invalid"}, true)}
	}, func(ctx context.Context) { starts++; workerCtx = ctx }, func() { stops++ })
	runtime.Refresh()
	if starts != 0 || stops != 0 {
		t.Fatal("disabled runtime has worker activity")
	}
	enabled = true
	runtime.Refresh()
	runtime.Refresh()
	if starts != 1 {
		t.Fatalf("starts=%d want=1", starts)
	}
	enabled = false
	runtime.Refresh()
	if stops != 1 || workerCtx.Err() == nil {
		t.Fatal("disabled worker not cancelled and joined")
	}
	enabled = true
	runtime.Refresh()
	if starts != 2 {
		t.Fatal("worker did not restart")
	}
	runtime.Stop()
	runtime.Stop()
	runtime.Refresh()
	if starts != 2 || stops != 2 {
		t.Fatal("closed lifecycle restarted or stopped twice")
	}
}
func TestPoisonSharedRuntimeNeedsBothSwitches(t *testing.T) {
	starts := 0
	runtime := newPoisonSharedLifecycle(func() *poison.Snapshot { return &poison.Snapshot{SharedEnabled: true} }, func(context.Context) { starts++ }, func() {})
	runtime.Refresh()
	runtime.Stop()
	if starts != 0 {
		t.Fatal("inactive guard started shared worker")
	}
}
