package handler

import (
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestPoisonProtocolLateHitAbortsBeforeHandlerReturns(t *testing.T) {
	hit := make(chan struct{})
	release := make(chan struct{})
	srv := pgLifecycleServer(t, func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		for range 4 {
			_, _ = c.Writer.Write([]byte(`data: {"delta":{"text":"` + strings.Repeat("a", 512) + `"}}` + "\n\n"))
			c.Writer.Flush()
		}
		_, _ = c.Writer.Write([]byte("data: {\"delta\":{\"text\":\"kedaya\"}}\n\n"))
		close(hit)
		<-release
	})
	defer close(release)
	client := &http.Client{Timeout: 3 * time.Second}
	resp, err := client.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	done := make(chan error, 1)
	go func() {
		_, err := io.ReadAll(resp.Body)
		done <- err
	}()
	<-hit
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("blocked stream ended successfully")
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("connection remained open after detection until handler return")
	}
}
