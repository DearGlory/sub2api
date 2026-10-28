package handler

import (
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
)

func TestPoisonProtocolRetryDiscardsPreviousAttempt(t *testing.T) {
	for _, inScope := range []bool{false, true} {
		name := "out_of_scope"
		if inScope {
			name = "in_scope"
		}
		t.Run(name, func(t *testing.T) {
			second := `{"content":[{"text":"normal second reply"}]}`
			snap := pgLifecycleSnapshot(t)
			srv := pgLifecycleServer(t, func(c *gin.Context) {
				c.Header("Content-Type", "text/event-stream")
				_, _ = c.Writer.Write([]byte("data: {\"delta\":{\"text\":\"first_attempt_only\"}}\n\n"))
				if poison.StatusGuard(c).Committed() != 0 {
					t.Error("fixture committed before retry")
				}
				base := "https://other.example"
				if inScope {
					base = "https://kedaya.ai"
				}
				poison.Attach(c, snap, poison.AccountInfo{Name: "防投毒test", BaseURL: base, HasProxy: true, AccountID: 200})
				if !inScope && poison.StatusGuard(c) != nil {
					t.Error("out of scope retry kept previous guard")
				}
				c.Data(200, "application/json", []byte(second))
			})
			resp, err := http.Post(srv.URL+"/v1/messages", "application/json", strings.NewReader("{}"))
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(resp.Body)
			resp.Body.Close()
			if err != nil || resp.StatusCode != 200 || string(body) != second {
				t.Fatalf("retry mixed responses status=%d got=%q err=%v", resp.StatusCode, body, err)
			}
		})
	}
}
