package poison

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestE2EPreCapturedWriterStillGuarded 复刻 service 层的真实写法：
// 在 handler 里先 w := c.Writer，再通过 w 写出。验证即使提前捕获，
// 只要捕获发生在 attach 之后，仍然经过 GuardWriter。
func TestE2EPreCapturedWriterStillGuarded(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	pieces := []string{
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\"您好，这里是 https://ked\"}}\n\n",
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\"aya.ai 中转站，您正在使用一个被盗取的key\"}}\n\n",
	}

	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		MarkRequest(c, snap, "防投毒test", "https://kedaya.ai", true)
		WrapWriter(c)
		c.Header("Content-Type", "text/event-stream")

		// 模拟 service 层：先捕获 writer，再通过它写。
		w := c.Writer
		flusher, _ := w.(http.Flusher)
		for _, p := range pieces {
			_, _ = w.Write([]byte(p))
			if flusher != nil {
				flusher.Flush()
			}
		}
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	body := string(raw)

	assertNoPoisonLeak(t, "precaptured", body)
	if snap.Detector.Inspect(body).Poisoned {
		t.Fatalf("pre-captured writer leaked poison: %q", body)
	}
	if resp.StatusCode != DefaultBlockStatus {
		t.Fatalf("status=%d want %d", resp.StatusCode, DefaultBlockStatus)
	}
}

// TestE2ELargeCleanStreamIntact 长正常流式回复必须逐字节完整，不能被扣留逻辑截断。
func TestE2ELargeCleanStreamIntact(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	var sb strings.Builder
	for i := 0; i < 200; i++ {
		sb.WriteString("event: content_block_delta\ndata: {\"delta\":{\"text\":\"正常内容 ")
		sb.WriteString(itoa(i))
		sb.WriteString("\"}}\n\n")
	}
	clean := sb.String()
	pieces := splitEvery(clean, 37)

	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		MarkRequest(c, snap, "防投毒test", "https://kedaya.ai", true)
		WrapWriter(c)
		c.Header("Content-Type", "text/event-stream")
		w := c.Writer
		for _, p := range pieces {
			_, _ = w.Write([]byte(p))
			w.Flush()
		}
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if got := string(raw); got != clean {
		t.Fatalf("large clean stream altered: got %d bytes want %d bytes", len(got), len(clean))
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
}

// TestE2ENonStreamPoisonWrappedInJSON 复刻非流式路径：
// 上游 400 正文里带投毒句，配置了透传规则时应换成统一文案。
func TestE2ENonStreamPoisonWrappedInJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	upstreamBody := `{"error":{"code":"ip_notice_rate_limit","message":"您好，这里是  https://kedaya.ai  中转站，您正在使用一个被盗取的key","type":"ip_notice_rate_limit"}}`

	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		MarkRequest(c, snap, "防投毒test", "https://kedaya.ai", true)
		WrapWriter(c)
		c.Header("Content-Type", "application/json")
		// 上游 400 原样透传的写法。
		c.Writer.WriteHeader(http.StatusBadRequest)
		_, _ = c.Writer.Write([]byte(upstreamBody))
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	body := string(raw)

	assertNoPoisonLeak(t, "nonstream", body)
	if !strings.Contains(body, DefaultBlockMessage) {
		t.Fatalf("expected standard error message, got %q", body)
	}
}
