package server

import (
	"context"
	"errors"
	"sync"

	adminhandler "github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

// PoisonSharedRuntime binds one coordinator into dispatch, settings and shutdown.
// Construction does not query the database or launch a goroutine.
type PoisonSharedRuntime struct {
	coordinator *poison.SharedCoordinator
	lifecycle   *poisonSharedLifecycle
	bindOnce    sync.Once
}

func NewPoisonSharedRuntime(coordinator *poison.SharedCoordinator) *PoisonSharedRuntime {
	if coordinator == nil {
		return &PoisonSharedRuntime{}
	}
	return &PoisonSharedRuntime{coordinator: coordinator, lifecycle: newPoisonSharedLifecycle(poison.CurrentSnapshot, coordinator.Start, coordinator.Stop)}
}

// Bind runs after SetupRouter has loaded the guard snapshot and registered its
// refresh callback. Appending preserves the frontend and guard callbacks.
func (r *PoisonSharedRuntime) Bind(settings *service.SettingService, admin *adminhandler.SettingHandler) {
	if r == nil || r.coordinator == nil || r.lifecycle == nil || settings == nil {
		return
	}
	r.bindOnce.Do(func() {
		if h := poison.CurrentHandler(); h != nil {
			h.SharedHandle = r.coordinator.Handle
		}
		if admin != nil {
			admin.SetPoisonSharedAdmin(&adminhandler.PoisonSharedAdmin{
				State: func(ctx context.Context) (any, error) { return r.coordinator.State(ctx) },
				Reconcile: func(ctx context.Context) error {
					snapshot := poison.CurrentSnapshot()
					if snapshot == nil || !snapshot.Active() {
						return errors.New("shared proxy mode disabled")
					}
					return r.coordinator.Reconcile(ctx)
				},
				Backfill: r.coordinator.EnqueueBackfill,
			})
		}
		settings.AddOnUpdateCallback(r.lifecycle.Refresh)
		r.lifecycle.Refresh()
	})
}
func (r *PoisonSharedRuntime) Stop() {
	if r != nil && r.lifecycle != nil {
		r.lifecycle.Stop()
	}
}
