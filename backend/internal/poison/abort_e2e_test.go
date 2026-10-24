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

	// 关键断言：客户端必须看到「读取失败」，而不是一个语法上看起来正常结束的 JSON。
	if readErr == nil {
		t.Fatalf("expected a transport-level error (truncated response), got clean EOF with %d bytes", len(body))
	}
	t.Logf("client correctly saw a transport error instead of a truncated JSON body: %v", readErr)

	// 投毒文案一个字节都不能出现在客户端收到的内容里。
	if strings.Contains(string(body), "kedaya") {
		t.Fatalf("LEAK: poisoned text reached the client: %q", string(body))
	}
	t.Log("no poisoned bytes leaked")
}
