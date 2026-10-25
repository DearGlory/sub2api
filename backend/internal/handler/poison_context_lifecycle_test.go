package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
)

func TestPoisonFinalizationKeepsOuterRequestContextLive(t *testing.T) {
	r := gin.New()
	snap := pgLifecycleSnapshot(t)
	r.Use(func(c *gin.Context) {
		c.Next()
		if c.Request.Context().Err() != nil {
			t.Error("guard canceled context used by outer access/accounting middleware")
		}
	}, poison.Middleware(), OpsErrorLoggerMiddleware(nil))
	r.POST("/v1/messages", func(c *gin.Context) {
		poison.Attach(c, snap, poison.AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true})
		c.Data(http.StatusOK, "application/json", []byte(`{"content":[{"text":"normal"}]}`))
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/messages", strings.NewReader("{}")))
}
