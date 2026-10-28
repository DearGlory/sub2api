package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
)

func TestPoisonProtocolStillStreamsAfterOpeningWindow(t *testing.T) {
	release := make(chan struct{})
	srv := pgLifecycleServer(t, func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		for range 4 {
			_, _ = c.Writer.Write([]byte(`data: {"delta":{"text":"` + strings.Repeat("正常", 300) + `"}}` + "\n\n"))
			c.Writer.Flush()
		}
		<-release
		_, _ = c.Writer.Write([]byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"))
	})
	defer close(release)
	done := make(chan error, 1)
	go func() {
		client := &http.Client{Timeout: 2 * time.Second}
		resp, err := client.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
		if err != nil {
			done <- err
			return
		}
		defer resp.Body.Close()
		buf := make([]byte, 64)
		_, err = io.ReadFull(resp.Body, buf)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("clean stream was buffered until handler end")
	}
}

func TestPoisonProtocolCleanMultilineAndFinalFrame(t *testing.T) {
	for _, nl := range []string{"\n", "\r\n", "\r"} {
		t.Run(fmt.Sprintf("%q", nl), func(t *testing.T) {
			payload := ": heartbeat" + nl + nl + "event: content_block_delta" + nl + "data: {\"delta\":" + nl + "data: {\"text\":\"你好\\ud83d\\ude00\"}}" + nl + nl + "event: message_stop" + nl + "data: {\"type\":\"message_stop\"}"
			srv := pgLifecycleServer(t, func(c *gin.Context) {
				c.Header("Content-Type", "text/event-stream")
				for i := range len(payload) {
					_, _ = c.Writer.Write([]byte(payload[i : i+1]))
					c.Writer.Flush()
				}
			})
			resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || string(body) != payload {
				t.Fatalf("wire changed: got=%d want=%d err=%v", len(body), len(payload), err)
			}
		})
	}
}

func TestPoisonProtocolDisabledAndOutOfScopeUnwrapped(t *testing.T) {
	for _, tc := range []struct {
		name, base     string
		enabled, proxy bool
	}{
		{"disabled", "https://kedaya.ai", false, true},
		{"other_origin", "https://other.example", true, true},
		{"no_proxy", "https://kedaya.ai", true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			snap := pgLifecycleSnapshot(t)
			snap.Enabled = tc.enabled
			r := gin.New()
			r.Use(poison.Middleware(), OpsErrorLoggerMiddleware(nil))
			r.POST("/v1/messages", func(c *gin.Context) {
				before := c.Writer
				if poison.Attach(c, snap, poison.AccountInfo{Name: "防投毒test", BaseURL: tc.base, HasProxy: tc.proxy}) || c.Writer != before {
					t.Error("out of scope writer wrapped")
				}
				c.Data(200, "application/json", []byte(`{"text":"kedaya"}`))
			})
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader("{}")))
			if rec.Code != 200 || rec.Body.String() != `{"text":"kedaya"}` {
				t.Fatal("unrelated route changed")
			}
		})
	}
}

func TestPoisonProtocolOuterStatusMatchesClient(t *testing.T) {
	for _, blocked := range []bool{false, true} {
		t.Run(fmt.Sprint(blocked), func(t *testing.T) {
			observed := make(chan int, 1)
			snap := pgLifecycleSnapshot(t)
			r := gin.New()
			r.Use(func(c *gin.Context) { c.Next(); observed <- c.Writer.Status() }, poison.Middleware(), OpsErrorLoggerMiddleware(nil))
			r.POST("/v1/messages", func(c *gin.Context) {
				poison.Attach(c, snap, poison.AccountInfo{Name: "防投毒test", BaseURL: "https://kedaya.ai", HasProxy: true})
				text := "normal"
				if blocked {
					text = "kedaya"
				}
				body, _ := json.Marshal(map[string]string{"text": text})
				c.Data(200, "application/json", body)
			})
			rec := httptest.NewRecorder()
			r.ServeHTTP(rec, httptest.NewRequest("POST", "/v1/messages", strings.NewReader("{}")))
			if status := <-observed; status != rec.Code || status == 0 {
				t.Fatalf("outer=%d client=%d", status, rec.Code)
			}
		})
	}
}
