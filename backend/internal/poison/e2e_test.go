package poison

import (
	"bufio"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestE2ERealHTTPStreamingNoLeak 走真实 TCP 的流式验证：客户端拿到的每一个
// 字节都由读到的 HTTP body 决定，不依赖 recorder 的内存视图。
func TestE2ERealHTTPStreamingNoLeak(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	// 真实投毒正文，切成极小的片，模拟 SSE 逐 token 下发。
	poison := "您好，这里是  https://kedaya.ai  中转站，您正在使用一个被盗取的key"
	pieces := splitEvery(poison, 3)

	srv := httptest.NewServer(newGuardRouter(t, snap, pieces, "text/event-stream"))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	body := string(raw)

	assertNoPoisonLeak(t, "e2e", body)
	if snap.Detector.Inspect(body).Poisoned {
		t.Fatalf("released bytes reach verdict: %q", body)
	}
	if resp.StatusCode != DefaultBlockStatus {
		t.Fatalf("status=%d want %d", resp.StatusCode, DefaultBlockStatus)
	}
	if !strings.Contains(body, DefaultBlockMessage) {
		t.Fatalf("expected standard upstream error, got %q", body)
	}
}

// TestE2ERealHTTPCleanStreamIntact 验证正常流式回复逐字节完整送达，不被扣留吞掉。
func TestE2ERealHTTPCleanStreamIntact(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	clean := "event: content_block_delta\ndata: {\"delta\":{\"text\":\"这是一段正常的流式回复，包含中文与 ASCII 混排 content。\"}}\n\n"
	pieces := splitEvery(clean, 7)

	srv := httptest.NewServer(newGuardRouter(t, snap, pieces, "text/event-stream"))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)

	if got := string(raw); got != clean {
		t.Fatalf("clean stream altered:\n got=%q\nwant=%q", got, clean)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status=%d want 200", resp.StatusCode)
	}
}

// TestE2ESSEFramedPoisonNoLeak 按真实 SSE 事件块下发（每块一个完整 event），
// 验证块边界恰好把一个关键词拆开时也不泄露。
func TestE2ESSEFramedPoisonNoLeak(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	// 故意让 "kedaya" 横跨两个 SSE 事件块。
	pieces := []string{
		"event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\"您好，这里是 https://keda\"}}\n\n",
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\"ya.ai 中转站，您正在使用一个被盗取的key\"}}\n\n",
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	}

	srv := httptest.NewServer(newGuardRouter(t, snap, pieces, "text/event-stream"))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	body := string(raw)

	assertNoPoisonLeak(t, "sse", body)
	if snap.Detector.Inspect(body).Poisoned {
		t.Fatalf("released SSE bytes reach verdict: %q", body)
	}
}

// TestE2EBufferedReadNoLeak 用 bufio 逐行读，确认客户端在判定前拿不到投毒行。
func TestE2EBufferedReadNoLeak(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	pieces := []string{
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\"您好，这里是 https://ked\"}}\n\n",
		"event: content_block_delta\ndata: {\"delta\":{\"text\":\"aya.ai 中转站，您正在使用一个被盗取的key\"}}\n\n",
	}

	srv := httptest.NewServer(newGuardRouter(t, snap, pieces, "text/event-stream"))
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", nil)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()

	sc := bufio.NewScanner(resp.Body)
	var lines []string
	for sc.Scan() {
		lines = append(lines, sc.Text())
	}
	joined := strings.Join(lines, "\n")
	assertNoPoisonLeak(t, "bufio", joined)
}

// newGuardRouter 构造一个把 pieces 依次写给客户端的真实路由。
func newGuardRouter(t *testing.T, snap *Snapshot, pieces []string, contentType string) *gin.Engine {
	t.Helper()
	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		MarkRequest(c, snap, "https://kedaya.ai", true)
		WrapWriter(c)
		c.Header("Content-Type", contentType)
		for _, p := range pieces {
			_, _ = c.Writer.Write([]byte(p))
			c.Writer.Flush()
		}
		if gw := StatusGuard(c); gw != nil {
			if gw.Finish() {
				gw.WriteError(DefaultBlockStatus, DefaultBlockMessage)
			}
		}
	})
	return r
}

// splitEvery 把字符串按 n 个 rune 切片，模拟极小的上游分片。
func splitEvery(s string, n int) []string {
	r := []rune(s)
	var out []string
	for i := 0; i < len(r); i += n {
		end := i + n
		if end > len(r) {
			end = len(r)
		}
		out = append(out, string(r[i:end]))
	}
	return out
}

// TestRealCorpusE2E 用真实生产语料逐条走真实 TCP 流式路径，验证零泄露。
func TestRealCorpusE2E(t *testing.T) {
	entries := loadCorpus(t, corpusPoisonPath)
	if len(entries) == 0 {
		t.Skip("empty poison corpus")
	}

	gin.SetMode(gin.TestMode)
	for _, e := range entries {
		text := extractBodyText(e.Body)
		snap := activeSnapshot()
		pieces := splitEvery(text, 4)

		srv := httptest.NewServer(newGuardRouter(t, snap, pieces, "application/json"))
		resp, err := http.Post(srv.URL+"/v1/messages", "application/json", nil)
		if err != nil {
			srv.Close()
			t.Fatalf("id=%s post: %v", e.ID, err)
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		srv.Close()

		body := string(raw)
		assertNoPoisonLeak(t, e.ID, body)
		if snap.Detector.Inspect(body).Poisoned {
			t.Errorf("id=%s released bytes reach verdict: %q", e.ID, truncate(body, 200))
		}
		if resp.StatusCode != DefaultBlockStatus {
			t.Errorf("id=%s status=%d want %d", e.ID, resp.StatusCode, DefaultBlockStatus)
		}
	}
}
