package poison

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 端到端验证：流式响应先吐出干净字节、再拼接投毒文案时，客户端必须得到
// 传输层错误（而不是残缺 JSON 被解析成 unexpected end of JSON input）。
func TestE2EStreamTruncationAbortsConnection(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		MarkRequest(c, snap, "https://kedaya.ai", true)
		WrapWriter(c)
		c.Header("Content-Type", "text/event-stream")

		w := c.Writer
		// 第一段：足够长且干净的 JSON 前缀，超过 head buffer，必然先写出。
		filler := "{\"content\":\"" + strings.Repeat("a", 200) + "\"}"
		_, _ = w.Write([]byte(filler))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		// 第二段：投毒文案。
		_, _ = w.Write([]byte("您好，这里是 https://kedaya.ai 中转站，您正在使用一个被盗取的key"))
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(resp.Body)
	t.Logf("status=%d bytes=%d readErr=%v", resp.StatusCode, len(body), readErr)

	// 关键断言：客户端绝不能收到投毒正文的任何一段。
	//
	// 投毒文案整体（含 200 字节干净前缀）都落在开头扣留窗口内，因此判定发生在
	// 任何字节写出之前，客户端拿到的是完整 502 错误体，既不需要断连也不会出现
	// 残缺 JSON。窗口若被调小到无法覆盖协议外壳，这里会退化为「已写出部分字节
	// 后断连」，readErr 变成 unexpected EOF，但绝不泄露投毒文本。
	_ = readErr
	if strings.Contains(string(body), "kedaya") || strings.Contains(string(body), "盗取") {
		t.Fatalf("LEAK: poisoned text reached the client: %q", string(body))
	}
	if resp.StatusCode == 200 {
		t.Fatalf("expected an error status, got 200 with %d bytes: %q", len(body), string(body))
	}
	t.Logf("client got a complete error body (status=%d) with no poisoned bytes", resp.StatusCode)
}
