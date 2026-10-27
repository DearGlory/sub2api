package handler

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
)

func TestAttachPoisonGuardCopiesSharedGeneration(t *testing.T) {
	old := poison.CurrentHandler()
	defer poison.AttachHandler(old)
	defer poison.SetStore(nil)
	store := poison.NewStore(func() (map[string]string, error) { return map[string]string{poison.SettingEnabled: "true"}, nil })
	if err := store.Reload(); err != nil {
		t.Fatal(err)
	}
	poison.SetStore(store)
	got := make(chan poison.Incident, 1)
	poison.AttachHandler(&poison.Handler{ReportDisposition: func(inc poison.Incident, _ poison.Disposition) { got <- inc }})
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/responses", nil).WithContext(context.Background())
	proxy := int64(4)
	a := &service.Account{ID: 9, ProxyID: &proxy, Credentials: map[string]any{"base_url": "https://kedaya.ai"}, Extra: map[string]any{poison.SharedGenerationKey: float64(12), poison.RestoreEpochKey: float64(3)}}
	attachPoisonGuard(c, a)
	defer poison.StatusGuard(c).Close()
	poison.Dispatch(c, "hit")
	select {
	case inc := <-got:
		if inc.SharedGeneration != 12 || inc.RestoreEpoch != 3 {
			t.Fatalf("shared=%d restore=%d", inc.SharedGeneration, inc.RestoreEpoch)
		}
	case <-time.After(time.Second):
		t.Fatal("missing incident")
	}
}
