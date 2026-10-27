package poison

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestAttachDispatchPreservesFirstRequestTimeAcrossAccounts(t *testing.T) {
	old := CurrentHandler()
	defer AttachHandler(old)
	ch := make(chan Incident, 2)
	AttachHandler(&Handler{ReportDisposition: func(i Incident, _ Disposition) { ch <- i }})
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
	snap := activeSnapshot()
	before := time.Now().UTC()
	p1, p2 := int64(7), int64(8)
	if !Attach(c, snap, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 41, ProxyID: &p1}) {
		t.Fatal("attach failed")
	}
	first, _ := c.Get(ContextKeyRequestStartedAt)
	started, ok := first.(time.Time)
	if !ok || started.Before(before) || started.After(time.Now()) {
		t.Fatalf("invalid first time: %v", first)
	}
	Dispatch(c, "first")
	if !Attach(c, snap, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 42, ProxyID: &p2}) {
		t.Fatal("retry attach failed")
	}
	defer StatusGuard(c).Close()
	Dispatch(c, "second")
	seen := map[int64]Incident{}
	for range 2 {
		select {
		case inc := <-ch:
			seen[inc.AccountID] = inc
		case <-time.After(time.Second):
			t.Fatal("missing dispatch")
		}
	}
	for id, wantProxy := range map[int64]int64{41: 7, 42: 8} {
		inc := seen[id]
		if !inc.RequestStartedAt.Equal(started) || inc.ProxyID == nil || *inc.ProxyID != wantProxy {
			t.Fatalf("account %d snapshot changed: %+v", id, inc)
		}
	}
}
