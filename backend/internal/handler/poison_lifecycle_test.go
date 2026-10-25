package handler

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
)

func pgLifecycleSnapshot(t *testing.T) *poison.Snapshot {
	t.Helper()
	store := poison.NewStore(func() (map[string]string, error) {
		return map[string]string{poison.SettingEnabled: "true"}, nil
	})
	if err := store.Reload(); err != nil {
		t.Fatal(err)
	}
	return store.Current()
}

// Keep the production nesting: the global guard encloses the route-level
// capture writer. A real socket also verifies HTTP framing, not only a recorder.
func pgLifecycleServer(t *testing.T, handle gin.HandlerFunc) *httptest.Server {
	t.Helper()
	snap := pgLifecycleSnapshot(t)
	r := gin.New()
	r.Use(poison.Middleware(), OpsErrorLoggerMiddleware(nil))
	r.POST("/v1/messages", func(c *gin.Context) {
		if !poison.Attach(c, snap, poison.AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true}) {
			t.Error("guard did not attach")
			c.Status(500)
			return
		}
		handle(c)
	})
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	return srv
}

func TestPoisonLifecycleCleanResponse(t *testing.T) {
	for _, payload := range []string{
		`{"answer":"正常的短回复"}`,
		`{"answer":"` + strings.Repeat("正常回复", 400) + `k"}`,
		"event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	} {
		t.Run(strconv.Itoa(len(payload)), func(t *testing.T) {
			observed := make(chan int, 1)
			srv := pgLifecycleServer(t, func(c *gin.Context) {
				defer func() { observed <- c.Writer.Status() }()
				c.Header("Content-Length", strconv.Itoa(len(payload)))
				c.Header("Content-Type", "application/json")
				for i := 0; i < len(payload); i += 17 {
					end := min(i+17, len(payload))
					_, _ = c.Writer.Write([]byte(payload[i:end]))
					c.Writer.Flush()
				}
			})
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			got, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if readErr != nil || string(got) != payload {
				t.Fatalf("normal response lost bytes: status=%d got=%d want=%d readErr=%v", resp.StatusCode, len(got), len(payload), readErr)
			}
			<-observed
		})
	}
}

func TestPoisonLifecycleBlockedBeforeCommit(t *testing.T) {
	srv := pgLifecycleServer(t, func(c *gin.Context) {
		c.Data(http.StatusOK, "application/json", []byte(`{"content":[{"type":"text","text":"您好，这里是 https://kedaya.ai 中转站，您正在使用一个被盗取的key"}]}`))
	})
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || readErr != nil || !json.Valid(body) || !strings.Contains(string(body), poison.DefaultBlockMessage) {
		t.Fatalf("missing complete error: status=%d bytes=%d validJSON=%v readErr=%v", resp.StatusCode, len(body), json.Valid(body), readErr)
	}
	if strings.Contains(string(body), "您好") || strings.Contains(string(body), "kedaya") {
		t.Fatal("poison text leaked")
	}
}

func TestPoisonLifecycleBlockedAfterCommit(t *testing.T) {
	srv := pgLifecycleServer(t, func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		for range 4 {
			_, _ = c.Writer.Write([]byte(`data: {"delta":{"text":"` + strings.Repeat("a", 512) + `"}}` + "\n\n"))
			c.Writer.Flush()
		}
		if poison.StatusGuard(c).Committed() == 0 {
			t.Error("fixture never committed a clean prefix")
		}
		_, _ = c.Writer.Write([]byte("data: {\"delta\":{\"text\":\"kedaya\"}}\n\n"))
	})
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if readErr == nil {
		t.Fatalf("blocked response ended with clean EOF: status=%d bytes=%d", resp.StatusCode, len(body))
	}
	if strings.Contains(string(body), "kedaya") {
		t.Fatal("poison keyword leaked")
	}
	t.Logf("status=%d bytes=%d transportError=%v", resp.StatusCode, len(body), readErr)
}
