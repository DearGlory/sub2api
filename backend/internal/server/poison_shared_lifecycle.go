package server

import (
	"context"
	"sync"

	"github.com/Wei-Shaw/sub2api/internal/poison"
)

type poisonSharedLifecycle struct {
	mu       sync.Mutex
	snapshot func() *poison.Snapshot
	start    func(context.Context)
	stop     func()
	cancel   context.CancelFunc
	closed   bool
}

func newPoisonSharedLifecycle(snapshot func() *poison.Snapshot, start func(context.Context), stop func()) *poisonSharedLifecycle {
	return &poisonSharedLifecycle{snapshot: snapshot, start: start, stop: stop}
}
func (r *poisonSharedLifecycle) Refresh() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	snap := r.snapshot()
	enabled := snap != nil && snap.Active() && snap.SharedEnabled
	if enabled && r.cancel == nil {
		ctx, cancel := context.WithCancel(context.Background())
		r.cancel = cancel
		r.start(ctx)
	} else if !enabled && r.cancel != nil {
		r.cancel()
		r.stop()
		r.cancel = nil
	}
}
func (r *poisonSharedLifecycle) Stop() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return
	}
	r.closed = true
	if r.cancel != nil {
		r.cancel()
		r.stop()
		r.cancel = nil
	}
}
