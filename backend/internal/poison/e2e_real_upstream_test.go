package poison

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 用真实 Attach 接线，配一个会注入投毒文案的假上游，
// 走「真实透传 → 真网关拦截 → 看客户端到底收到什么」的完整路径。
func TestE2EPoisonUpstreamThroughRealAttach(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	const poison = "您好，这里是 https://kedaya.ai 中转站，您正在使用一个被盗取的key"

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Stream bool   `json:"stream"`
			Model  string `json:"model"`
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &req)

		if req.Stream {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			fl, _ := w.(http.Flusher)
			fmt.Fprintf(w, "event: message_start\ndata: {\"type\":\"message_start\"}\n\n")
			if fl != nil {
				fl.Flush()
			}
			fmt.Fprintf(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":%q}}\n\n", poison[:20])
			if fl != nil {
				fl.Flush()
			}
			fmt.Fprintf(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":%q}}\n\n", poison[20:])
			if fl != nil {
				fl.Flush()
			}
			fmt.Fprintf(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			return
		}

		body, _ := json.Marshal(map[string]any{
			"id": "msg_x", "type": "message", "role": "assistant",
			"model":   req.Model,
			"content": []map[string]string{{"type": "text", "text": poison}},
			"usage":   map[string]int{"input_tokens": 5, "output_tokens": 20},
		})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write(body)
	}))
	defer upstream.Close()

	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		attached := Attach(c, snap, AccountInfo{
			BaseURL:   "https://kedaya.ai",
			HasProxy:  true,
			AccountID: 350,
		})
		if !attached {
			t.Errorf("Attach returned false — scope did not match; test would prove nothing")
			c.Status(500)
			return
		}

		raw, _ := io.ReadAll(c.Request.Body)
		var req struct {
			Stream bool `json:"stream"`
		}
		_ = json.Unmarshal(raw, &req)

		usp, err := http.Post(upstream.URL+"/v1/messages", "application/json", strings.NewReader(string(raw)))
		if err != nil {
			c.Status(502)
			return
		}
		defer usp.Body.Close()

		if req.Stream {
			c.Header("Content-Type", "text/event-stream")
			c.Status(200)
			sc := bufio.NewScanner(usp.Body)
			sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
			for sc.Scan() {
				if _, werr := io.WriteString(c.Writer, sc.Text()+"\n"); werr != nil {
					return
				}
				c.Writer.Flush()
			}
			return
		}

		body, _ := io.ReadAll(usp.Body)
		c.Data(usp.StatusCode, "application/json", body)
	})

	srv := httptest.NewServer(r)
	defer srv.Close()

	for _, stream := range []bool{false, true} {
		payload := fmt.Sprintf(`{"model":"claude-haiku-5-5","max_tokens":32,"stream":%v,"messages":[{"role":"user","content":"hi"}]}`, stream)
		resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader(payload))
		if err != nil {
			t.Fatalf("stream=%v post: %v", stream, err)
		}
		body, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()

		s := string(body)
		leaked := strings.Contains(s, "kedaya") || strings.Contains(s, "盗取")
		t.Logf("stream=%-5v status=%d bytes=%d readErr=%v leaked=%v",
			stream, resp.StatusCode, len(body), readErr, leaked)
		t.Logf("   body=%q", clipBody(s, 180))

		if leaked {
			t.Errorf("LEAK (stream=%v): poisoned text reached the client", stream)
		}
		if !stream && resp.StatusCode == 200 {
			t.Errorf("non-stream: got 200, expected an error status")
		}
	}
}

func clipBody(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
