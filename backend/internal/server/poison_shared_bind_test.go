package server

import (
	"context"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
)

type sharedRuntimeSettingsRepo struct {
	service.SettingRepository
	values map[string]string
}

func (r *sharedRuntimeSettingsRepo) GetMultiple(_ context.Context, keys []string) (map[string]string, error) {
	out := map[string]string{}
	for _, k := range keys {
		if v, ok := r.values[k]; ok {
			out[k] = v
		}
	}
	return out, nil
}
func (r *sharedRuntimeSettingsRepo) SetMultiple(_ context.Context, v map[string]string) error {
	for k, value := range v {
		r.values[k] = value
	}
	return nil
}
func TestPoisonSharedRuntimeBindPreservesRefreshChain(t *testing.T) {
	oldHandler := poison.CurrentHandler()
	defer poison.AttachHandler(oldHandler)
	defer poison.SetStore(nil)
	repo := &sharedRuntimeSettingsRepo{values: map[string]string{poison.SettingEnabled: "true", poison.SettingSharedEnabled: "false"}}
	settings := service.NewSettingService(repo, &config.Config{})
	store := poison.NewStore(func() (map[string]string, error) {
		return settings.GetRawSettings(context.Background(), poison.AllSettings())
	})
	if err := store.Reload(); err != nil {
		t.Fatal(err)
	}
	poison.SetStore(store)
	frontend := 0
	settings.SetOnUpdateCallback(func() { frontend++ })
	settings.AddOnUpdateCallback(func() {
		if err := store.Reload(); err != nil {
			t.Fatal(err)
		}
	})
	poison.AttachHandler(&poison.Handler{})
	co := poison.NewSharedCoordinator(nil, poison.SharedOptions{})
	runtime := NewPoisonSharedRuntime(co)
	starts, stops := 0, 0
	runtime.lifecycle = newPoisonSharedLifecycle(poison.CurrentSnapshot, func(context.Context) { starts++ }, func() { stops++ })
	runtime.Bind(settings, nil)
	runtime.Bind(settings, nil)
	if poison.CurrentHandler().SharedHandle == nil {
		t.Fatal("shared dispatch not connected")
	}
	on := true
	if err := settings.UpdatePoisonSharedEnabled(context.Background(), &on); err != nil {
		t.Fatal(err)
	}
	if frontend != 1 || starts != 1 {
		t.Fatalf("frontend=%d starts=%d", frontend, starts)
	}
	off := false
	if err := settings.UpdatePoisonSharedEnabled(context.Background(), &off); err != nil {
		t.Fatal(err)
	}
	if frontend != 2 || stops != 1 {
		t.Fatalf("frontend=%d stops=%d", frontend, stops)
	}
	runtime.Stop()
}
