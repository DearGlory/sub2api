package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestPoisonProtocolHitCancelsUpstreamContext(t *testing.T) {
	canceled := make(chan bool, 1)
	srv := pgLifecycleServer(t, func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.Write([]byte("data: {\"delta\":{\"text\":\"kedaya\"}}\n\n"))
		select {
		case <-c.Request.Context().Done():
			canceled <- true
		case <-time.After(100 * time.Millisecond):
			canceled <- false
		}
	})
	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil || resp.StatusCode != 502 || !json.Valid(body) {
		t.Fatalf("error response not delivered: status=%d err=%v", resp.StatusCode, err)
	}
	if !<-canceled {
		t.Fatal("upstream request context remained live after detection")
	}
}
