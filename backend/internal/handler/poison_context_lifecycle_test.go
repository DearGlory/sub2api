package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
)

func TestPoisonFinalizationKeepsOuterRequestContextLive(t *testing.T) {
	type requestMetadataKey struct{}
	r := gin.New()
	snap := pgLifecycleSnapshot(t)
	r.Use(func(c *gin.Context) {
		c.Next()
		if got := c.Request.Context().Value(requestMetadataKey{}); got != "selected-after-attach" {
			t.Errorf("post-attach metadata lost: %v", got)
		}
		if c.Request.Context().Err() != nil {
			t.Error("guard canceled context used by outer access/accounting middleware")
		}
	}, poison.Middleware(), OpsErrorLoggerMiddleware(nil))
	r.POST("/v1/messages", func(c *gin.Context) {
		poison.Attach(c, snap, poison.AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true})
		c.Request = c.Request.WithContext(context.WithValue(c.Request.Context(), requestMetadataKey{}, "selected-after-attach"))
		c.Data(http.StatusOK, "application/json", []byte(`{"content":[{"text":"normal"}]}`))
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("POST", "/v1/messages", strings.NewReader("{}")))
}
