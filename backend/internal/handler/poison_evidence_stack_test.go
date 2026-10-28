package handler

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	middleware2 "github.com/Wei-Shaw/sub2api/internal/server/middleware"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestPoisonEvidenceProductionStackLateHit(t *testing.T) {
	for _, h2 := range []bool{false, true} {
		name := "http1"
		if h2 {
			name = "http2"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			snap := pgLifecycleSnapshot(t)
			snap.EvidenceEnabled = true
			snap.EvidenceDir = dir
			prior := poison.CurrentHandler()
			t.Cleanup(func() { poison.AttachHandler(prior) })
			report := make(chan poison.Disposition, 1)
			poison.AttachHandler(&poison.Handler{ReportDisposition: func(inc poison.Incident, d poison.Disposition) {
				if err := poison.WriteEvidenceDisposition(inc.EvidencePath, d); err != nil {
					t.Error(err)
				}
				report <- d
			}})
			var raw strings.Builder
			for range 4 {
				raw.WriteString("data: {\"delta\":{\"text\":\"" + strings.Repeat("a", 512) + "\"}}\n\n")
			}
			raw.WriteString("data: {\"delta\":{\"text\":\"kedaya\"}}\n\n")
			source := raw.String()
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, source)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			}))
			defer upstream.Close()
			finished := make(chan struct{})
			router := gin.New()
			router.Use(func(c *gin.Context) { defer close(finished); c.Next() }, middleware2.Recovery(), poison.Middleware(), OpsErrorLoggerMiddleware(nil))
			router.POST("/v1/responses", func(c *gin.Context) {
				ctx := context.WithValue(c.Request.Context(), ctxkey.RequestID, "evidence-prod-"+name)
				ctx = context.WithValue(ctx, ctxkey.Model, "fixture-model")
				c.Request = c.Request.WithContext(ctx)
				if !poison.Attach(c, snap, poison.AccountInfo{Name: "防投毒test", BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 42}) {
					t.Error("not admitted")
					return
				}
				request, _ := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, upstream.URL, nil)
				resp, err := upstream.Client().Do(request)
				if err != nil {
					t.Error(err)
					return
				}
				defer resp.Body.Close()
				poison.CaptureUpstreamResponse(c.Request.Context(), resp)
				c.Header("Content-Type", "text/event-stream")
				reader := bufio.NewReader(resp.Body)
				for {
					line, err := reader.ReadBytes('\n')
					if len(line) > 0 {
						_, _ = c.Writer.Write(line)
						c.Writer.Flush()
					}
					if poison.StatusGuard(c).Blocked() || err != nil {
						break
					}
				}
				if poison.StatusGuard(c).Committed() == 0 {
					t.Error("late-hit boundary not reached")
				}
			})
			server := httptest.NewUnstartedServer(router)
			server.EnableHTTP2 = h2
			if h2 {
				server.StartTLS()
			} else {
				server.Start()
			}
			defer server.Close()
			client := server.Client()
			client.Timeout = 3 * time.Second
			response, err := client.Post(server.URL+"/v1/responses", "application/json", strings.NewReader(`{}`))
			require.NoError(t, err)
			body, readErr := io.ReadAll(response.Body)
			response.Body.Close()
			require.Equal(t, http.StatusOK, response.StatusCode)
			require.Error(t, readErr)
			require.NotContains(t, string(body), "kedaya")
			select {
			case <-finished:
			case <-time.After(2 * time.Second):
				t.Fatal("gateway finalization stalled")
			}
			var d poison.Disposition
			select {
			case d = <-report:
			case <-time.After(time.Second):
				t.Fatal("disposition not dispatched")
			}
			require.Equal(t, "deferred", d.Outcome)
			require.NotEmpty(t, d.EvidenceID)
			require.Equal(t, "evidence-prod-"+name, d.RequestID)
			original, err := os.ReadFile(filepath.Join(d.EvidencePath, "response-1.body"))
			require.NoError(t, err)
			require.Equal(t, source, string(original))
			metadata, err := os.ReadFile(filepath.Join(d.EvidencePath, "metadata.json"))
			require.NoError(t, err)
			var m struct {
				Interrupted bool `json:"interrupted"`
				Hit         struct {
					Matched []string `json:"matched"`
				}
				Responses []struct {
					Complete bool `json:"complete"`
				}
			}
			require.NoError(t, json.Unmarshal(metadata, &m))
			require.True(t, m.Interrupted)
			require.Contains(t, m.Hit.Matched, "kedaya")
			require.False(t, m.Responses[0].Complete)
		})
	}
}
