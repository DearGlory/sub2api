//go:build unit

package poison

import (
	"github.com/gin-gonic/gin"
	"net/http/httptest"
	"testing"
)

func TestAccountNameRequiredForAdmission(t *testing.T) {
	snap := sharedTestSnapshot()
	for _, name := range []string{"", "普通账号", "x防投毒", " 防投毒", "防投毒账号"} {
		t.Run(name, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest("POST", "/v1/responses", nil)
			info := AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true}
			info.Name = name
			got := Attach(c, snap, info)
			if got != (name == "防投毒账号") {
				t.Fatalf("name=%q admitted=%v", name, got)
			}
			if w := StatusGuard(c); w != nil {
				w.Close()
			}
		})
	}
}
