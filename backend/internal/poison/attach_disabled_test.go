package poison

import (
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"testing"
)

func TestInactiveAttachDoesNotAddRequestState(t *testing.T) {
	for _, mode := range []string{"disabled", "outside-scope"} {
		t.Run(mode, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			original := httptest.NewRequest("POST", "/v1/responses", nil)
			c.Request = original
			snap := activeSnapshot()
			info := AccountInfo{Name: "防投毒test", BaseURL: "https://kedaya.ai", HasProxy: true}
			if mode == "disabled" {
				snap.Enabled = false
			} else {
				info.BaseURL = "https://outside.invalid"
			}
			if Attach(c, snap, info) {
				t.Fatal("inactive request admitted")
			}
			if c.Request != original {
				t.Fatal("inactive Attach allocated replacement request state")
			}
			if _, ok := c.Get(ContextKeyRequestStartedAt); ok {
				t.Fatal("inactive Attach recorded lifecycle state")
			}
		})
	}
}
