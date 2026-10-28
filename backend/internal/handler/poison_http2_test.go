package handler

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
)

func TestPoisonProtocolHTTP2LateHitResetsStream(t *testing.T) {
	snap := pgLifecycleSnapshot(t)
	hit := make(chan struct{})
	release := make(chan struct{})
	r := gin.New()
	r.Use(middleware2.Recovery(), poison.Middleware(), OpsErrorLoggerMiddleware(nil))
	r.POST("/v1/messages", func(c *gin.Context) {
		poison.Attach(c, snap, poison.AccountInfo{Name: "防投毒test", BaseURL: "https://kedaya.ai", HasProxy: true})
		c.Header("Content-Type", "text/event-stream")
		for range 4 {
			_, _ = c.Writer.Write([]byte(`data: {"delta":{"text":"` + strings.Repeat("a", 512) + `"}}` + "\n\n"))
			c.Writer.Flush()
		}
		if poison.StatusGuard(c).Committed() == 0 {
			t.Error("no clean bytes committed")
		}
		_, _ = c.Writer.Write([]byte("data: {\"delta\":{\"text\":\"kedaya\"}}\n\n"))
		close(hit)
		<-release
	})
	srv := httptest.NewUnstartedServer(r)
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	defer close(release)
	client := srv.Client()
	client.Timeout = 3 * time.Second
	resp, err := client.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.ProtoMajor != 2 || resp.StatusCode != http.StatusOK {
		t.Fatalf("fixture protocol/status = %s/%d", resp.Proto, resp.StatusCode)
	}
	done := make(chan error, 1)
	go func() {
		body, err := io.ReadAll(resp.Body)
		if strings.Contains(string(body), "kedaya") {
			t.Error("blocked keyword leaked")
		}
		done <- err
	}()
	<-hit
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("HTTP2 response ended successfully after a late poison hit")
		}
		t.Logf("HTTP2 transport error: %v", err)
	case <-time.After(300 * time.Millisecond):
		t.Fatal("HTTP2 stream still open after detection")
	}
}
