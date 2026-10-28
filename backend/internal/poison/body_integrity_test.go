package poison

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 关键验证：guard 开启时，非流式响应写出的字节数必须与声明的 Content-Length 完全一致。
// 若 guard 把头部扣留后没有在收尾时完整返还，客户端收到的 body 就会短于声明长度，
// 表现为 "unexpected end of JSON input"。
func TestNonStreamingBodyLengthMatchesDeclared(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	payload := `{"id":"msg_1","type":"message","role":"assistant","content":[{"type":"text","text":"` +
		strings.Repeat("正常内容", 60) + `"}],"usage":{"input_tokens":10,"output_tokens":20}}`

	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		MarkRequest(c, snap, "防投毒test", "https://kedaya.ai", true)
		WrapWriter(c)
		// 复刻真实 handler 的非流式写法
		c.Data(http.StatusOK, "application/json", []byte(payload))
	})

	w := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", nil)
	r.ServeHTTP(w, req)

	got := w.Body.String()
	declared := w.Header().Get("Content-Length")
	t.Logf("payload=%d declared=%s actual=%d", len(payload), declared, len(got))

	if got != payload {
		t.Fatalf("BODY CORRUPTED: expected %d bytes, got %d\n tail_expected=%q\n tail_actual  =%q",
			len(payload), len(got), tail(payload, 60), tail(got, 60))
	}
	if declared != "" && declared != itoa(len(got)) {
		t.Fatalf("LENGTH MISMATCH: declared=%s actual=%d", declared, len(got))
	}
}

// 流式：所有写入的字节必须在收尾时完整送达，一个字符都不能丢。
func TestStreamingBodyNotTruncated(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	chunks := []string{
		"event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"" + strings.Repeat("x", 120) + "\"}}\n\n",
		"event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"text\":\"结尾文字\"}}\n\n",
		"event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
	}
	want := strings.Join(chunks, "")

	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		MarkRequest(c, snap, "防投毒test", "https://kedaya.ai", true)
		WrapWriter(c)
		c.Header("Content-Type", "text/event-stream")
		for _, ch := range chunks {
			_, _ = c.Writer.Write([]byte(ch))
		}
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", nil)
	r.ServeHTTP(rec, req)

	got := rec.Body.String()
	t.Logf("want=%d actual=%d", len(want), len(got))
	if got != want {
		t.Fatalf("STREAM TRUNCATED: lost %d bytes\n want_tail=%q\n got_tail =%q",
			len(want)-len(got), tail(want, 50), tail(got, 50))
	}
}

func tail(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
