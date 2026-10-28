package poison

import (
	"context"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestSharedSwitchConfigurationReload(t *testing.T) {
	values := map[string]string{SettingEnabled: "true", SettingSharedEnabled: "true"}
	store := NewStore(func() (map[string]string, error) { return values, nil })
	if err := store.Reload(); err != nil {
		t.Fatal(err)
	}
	if !store.Current().SharedEnabled {
		t.Fatal("shared switch did not enable after reload")
	}
	count := 0
	for _, key := range AllSettings() {
		if key == SettingSharedEnabled {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("shared settings key count=%d want=1", count)
	}
	values[SettingEnabled] = "false"
	if err := store.Reload(); err != nil {
		t.Fatal(err)
	}
	if store.Current().SharedEnabled {
		t.Fatal("shared switch did not turn off")
	}
	if parse(nil).SharedEnabled {
		t.Fatal("shared default must remain explicit opt-in")
	}
}

func TestSharedGenerationAttachDispatchAcrossRetry(t *testing.T) {
	old := CurrentHandler()
	defer AttachHandler(old)
	events := make(chan Incident, 2)
	AttachHandler(&Handler{ReportDisposition: func(i Incident, _ Disposition) { events <- i }})
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
	proxy := int64(7)
	snap := activeSnapshot()
	for _, generation := range []int64{4, 9} {
		if !Attach(c, snap, AccountInfo{Name: "防投毒test", BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 41, ProxyID: &proxy, RestoreEpoch: 3, SharedGeneration: generation}) {
			t.Fatal("attach failed")
		}
		Dispatch(c, "hit")
		select {
		case inc := <-events:
			if inc.SharedGeneration != generation {
				t.Fatalf("generation=%d want=%d", inc.SharedGeneration, generation)
			}
		case <-time.After(time.Second):
			t.Fatal("dispatch missing")
		}
	}
	StatusGuard(c).Close()
}

func TestSharedHandlerDelegatesOnlyWhileEnabled(t *testing.T) {
	defaultStore.mu.RLock()
	oldStore := defaultStore.st
	defaultStore.mu.RUnlock()
	defer SetStore(oldStore)
	values := map[string]string{SettingEnabled: "true", SettingSharedEnabled: "true"}
	st := NewStore(func() (map[string]string, error) { return values, nil })
	if err := st.Reload(); err != nil {
		t.Fatal(err)
	}
	SetStore(st)
	calls := 0
	var got Disposition
	h := &Handler{SharedHandle: func(_ context.Context, i Incident) (Disposition, error) {
		calls++
		return Disposition{Outcome: "rotated", Reason: "shared_rotated"}, nil
	}, ReportDisposition: func(_ Incident, d Disposition) { got = d }}
	inc := Incident{AccountID: 7, RequestID: "rid", EvidenceID: "eid", SharedGeneration: 9}
	h.Handle(context.Background(), inc)
	if calls != 1 || got.Outcome != "rotated" || got.AccountID != 7 || got.RequestID != "rid" || got.EvidenceID != "eid" {
		t.Fatalf("calls=%d disposition=%+v", calls, got)
	}
	h.SharedHandle = func(context.Context, Incident) (Disposition, error) {
		return Disposition{}, fmt.Errorf("credential-private")
	}
	h.Handle(context.Background(), inc)
	if got.Outcome != "deferred" || got.Reason != "deferred_shared_operation" {
		t.Fatalf("bad failed dispatch: %+v", got)
	}
	h.SharedHandle = nil
	h.Handle(context.Background(), inc)
	if got.Reason != "deferred_shared_unavailable" {
		t.Fatalf("missing shared handler fell through: %+v", got)
	}
	values[SettingEnabled] = "false"
	if err := st.Reload(); err != nil {
		t.Fatal(err)
	}
	h.SharedHandle = func(context.Context, Incident) (Disposition, error) { calls++; return Disposition{}, nil }
	h.Handle(context.Background(), inc)
	if calls != 1 {
		t.Fatal("disabled shared branch called")
	}
}
