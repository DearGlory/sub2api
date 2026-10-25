package handler

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func pgOpeningFrames(text string, escape bool) []string {
	frames := []string{"event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"" + strings.Repeat("m", 1800) + "\"}}\n\n"}
	for _, r := range text {
		value, _ := json.Marshal(string(r))
		if escape {
			value = []byte(fmt.Sprintf(`"\u%04x"`, r))
		}
		frames = append(frames, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":"+string(value)+"}}\n\n")
	}
	return append(frames, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
}

func TestPoisonProtocolOpeningSplitAcrossSSEFrames(t *testing.T) {
	for _, escape := range []bool{false, true} {
		t.Run(fmt.Sprint(escape), func(t *testing.T) {
			frames := pgOpeningFrames("您好，这里是 https://kedaya.ai 中转站，您正在使用一个被盗取的key。后续正常回答。", escape)
			srv := pgLifecycleServer(t, func(c *gin.Context) {
				c.Header("Content-Type", "text/event-stream")
				c.Writer.WriteHeaderNow()
				for _, frame := range frames {
					for i := range len(frame) {
						_, _ = c.Writer.Write([]byte(frame[i : i+1]))
						c.Writer.Flush()
					}
				}
			})
			client := &http.Client{Timeout: 5 * time.Second}
			resp, err := client.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader(`{"stream":true}`))
			if err != nil {
				t.Fatal(err)
			}
			body, readErr := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusBadGateway || readErr != nil || !json.Valid(body) {
				t.Fatalf("opening poison escaped before rejection: status=%d bytes=%d validJSON=%v readErr=%v", resp.StatusCode, len(body), json.Valid(body), readErr)
			}
			if strings.Contains(string(body), "您好") || strings.Contains(string(body), "content_block_delta") {
				t.Fatal("poison opening text/frame leaked")
			}
		})
	}
}

func TestPoisonProtocolEscapedNonStreaming(t *testing.T) {
	payload := `{"content":[{"type":"text","text":"\u006b\u0065\u0064\u0061\u0079\u0061"}]}`
	srv := pgLifecycleServer(t, func(c *gin.Context) { c.Data(http.StatusOK, "application/json", []byte(payload)) })
	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway || readErr != nil || !json.Valid(body) {
		t.Fatalf("escaped poison not rejected: status=%d bytes=%d readErr=%v", resp.StatusCode, len(body), readErr)
	}
}

func TestPoisonProtocolCleanSSEExactBytes(t *testing.T) {
	frames := pgOpeningFrames(strings.Repeat("正常文字", 160), false)
	want := strings.Join(frames, "")
	srv := pgLifecycleServer(t, func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		for _, frame := range frames {
			_, _ = c.Writer.Write([]byte(frame))
			c.Writer.Flush()
		}
	})
	resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	body, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if readErr != nil || string(body) != want {
		t.Fatalf("clean SSE changed: got=%d want=%d readErr=%v", len(body), len(want), readErr)
	}
}
