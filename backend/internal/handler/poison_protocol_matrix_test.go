package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
)

func TestPoisonProtocolFrameMatrix(t *testing.T) {
	formats := map[string]string{
		"anthropic": `{"type":"content_block_delta","delta":{"type":"text_delta","text":%s}}`,
		"chat":      `{"choices":[{"index":0,"delta":{"content":%s}}]}`,
		"responses": `{"type":"response.output_text.delta","delta":%s}`,
		"gemini":    `{"candidates":[{"content":{"parts":[{"text":%s}]}}]}`,
		"thinking":  `{"delta":{"type":"thinking_delta","thinking":%s}}`,
		"tool":      `{"delta":{"type":"input_json_delta","partial_json":%s}}`,
	}
	for name, format := range formats {
		for _, nl := range []string{"\n", "\r\n", "\r"} {
			t.Run(name+fmt.Sprintf("/%q", nl), func(t *testing.T) {
				srv := pgLifecycleServer(t, func(c *gin.Context) {
					c.Header("Content-Type", "text/event-stream")
					for _, r := range "您好，这里是 https://kedaya.ai" {
						value, _ := json.Marshal(string(r))
						frame := "event: delta" + nl + "data: " + fmt.Sprintf(format, value) + nl + nl
						for i := range len(frame) {
							_, _ = c.Writer.Write([]byte(frame[i : i+1]))
							c.Writer.Flush()
						}
					}
				})
				client := &http.Client{Timeout: 3 * time.Second}
				resp, err := client.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader(`{"stream":true}`))
				if err != nil {
					t.Fatal(err)
				}
				body, err := io.ReadAll(resp.Body)
				resp.Body.Close()
				if err != nil || resp.StatusCode != 502 || !json.Valid(body) || strings.Contains(string(body), "您好") {
					t.Fatalf("status=%d bytes=%d readErr=%v", resp.StatusCode, len(body), err)
				}
			})
		}
	}
}

func TestPoisonProtocolOrdinaryErrorsRemainExact(t *testing.T) {
	for _, payload := range []string{`{"error":{"message":"max_tokens must be positive"}}`, "ordinary upstream failure", "", `{"metadata":"kedaya","content":[{"text":"normal answer"}]}`} {
		srv := pgLifecycleServer(t, func(c *gin.Context) { c.Data(http.StatusBadRequest, "application/json", []byte(payload)) })
		resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != 400 || string(body) != payload {
			t.Fatalf("ordinary error changed: status=%d bytes=%d readErr=%v", resp.StatusCode, len(body), err)
		}
	}
}

func TestPoisonProtocolThresholdAndDuplicateWords(t *testing.T) {
	for _, tc := range []struct {
		text string
		want int
	}{
		{"您好，这里是被盗用的key", 502},
		{strings.Repeat("key", 40), 200},
	} {
		srv := pgLifecycleServer(t, func(c *gin.Context) {
			c.Header("Content-Type", "text/event-stream")
			for _, frame := range pgOpeningFrames(tc.text, false) {
				_, _ = c.Writer.Write([]byte(frame))
				c.Writer.Flush()
			}
		})
		resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil || resp.StatusCode != tc.want {
			t.Fatalf("status=%d want=%d err=%v", resp.StatusCode, tc.want, err)
		}
		if tc.want == 502 && (!json.Valid(body) || strings.Contains(string(body), "您好")) {
			t.Fatal("partial notice leaked")
		}
	}
}

func TestPoisonProtocolOpeningRejectsBeforeHandlerReturns(t *testing.T) {
	hit, release := make(chan struct{}), make(chan struct{})
	srv := pgLifecycleServer(t, func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.Write([]byte("data: {\"delta\":{\"text\":\"kedaya\"}}\n\n"))
		close(hit)
		<-release
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
		body, err := io.ReadAll(resp.Body)
		if err == nil && (resp.StatusCode != poison.DefaultBlockStatus || !json.Valid(body)) {
			err = fmt.Errorf("bad error response %d", resp.StatusCode)
		}
		done <- err
	}()
	<-hit
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(300 * time.Millisecond):
		t.Fatal("opening detection waited for upstream handler return")
	}
}
