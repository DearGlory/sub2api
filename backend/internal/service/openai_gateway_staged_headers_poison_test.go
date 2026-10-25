package service

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// Deliver one complete event per Read so checkpoints observe the production
// synchronous scanner after processing earlier events, without timing sleeps.
type stagedHeaderEventReader struct {
	events     []string
	index      int
	pending    string
	beforeRead func(int)
}

func (r *stagedHeaderEventReader) Read(p []byte) (int, error) {
	if r.pending == "" {
		if r.beforeRead != nil {
			r.beforeRead(r.index)
		}
		if r.index == len(r.events) {
			return 0, io.EOF
		}
		r.pending = r.events[r.index]
		r.index++
	}
	n := copy(p, r.pending)
	r.pending = r.pending[n:]
	return n, nil
}

func TestOpenAIStagedHeadersPoisonGuardAppliedOnce(t *testing.T) {
	for _, filtered := range []bool{false, true} {
		name := "request_id_fallback"
		if filtered {
			name = "filtered_multivalue"
		}
		t.Run(name, func(t *testing.T) {
			cfg := &config.Config{}
			svc := &OpenAIGatewayService{cfg: cfg}
			if filtered {
				svc.responseHeaderFilter = compileResponseHeaderFilter(cfg)
			}
			rec := httptest.NewRecorder()
			c, _ := gin.CreateTestContext(rec)
			c.Request = httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
			c.Writer.Header().Add("X-Request-Id", "gateway-request")
			snap := &poison.Snapshot{
				Enabled:  true,
				Detector: poison.NewDetector(poison.Config{Veto: poison.DefaultVetoKeywords(), HeadBufferRunes: poison.DefaultHeadBufferRunes}),
				Scope:    poison.NewScope([]string{"https://upstream.example"}, true),
			}
			poison.MarkRequest(c, snap, "https://upstream.example", true)
			poison.WrapWriter(c)
			guard, ok := c.Writer.(*poison.GuardWriter)
			require.True(t, ok, "must exercise the real poison GuardWriter")
			defer guard.Close()

			const delta = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"花\"}\n\n"
			const completed = "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_headers\",\"usage\":{\"input_tokens\":4,\"output_tokens\":640}}}\n\n"
			events := make([]string, 0, 641)
			for i := 0; i < 640; i++ {
				events = append(events, delta)
			}
			events = append(events, completed)
			checkedHeld, checkedFlushed := false, false
			reader := &stagedHeaderEventReader{events: events}
			reader.beforeRead = func(index int) {
				switch index {
				case 256:
					checkedHeld = true
					require.False(t, guard.Written())
					require.Zero(t, rec.Body.Len(), "head window must still hold the body")
					require.False(t, rec.Flushed)
				case 600:
					checkedFlushed = true
					require.True(t, rec.Flushed, "clean stream must flush before terminal/EOF")
					require.Positive(t, guard.Committed())
					require.NotContains(t, rec.Body.String(), "response.completed")
				}
			}
			largeState := strings.Repeat("s", 2048)
			headers := http.Header{
				"X-Request-Id":                   {"upstream-request"},
				"X-Codex-Turn-State":             {largeState},
				"X-Ratelimit-Remaining-Requests": {"99", "98"},
				"Content-Type":                   {"application/json"},
			}
			resp := &http.Response{StatusCode: http.StatusOK, Header: headers, Body: io.NopCloser(reader)}
			result, err := svc.handleStreamingResponse(c.Request.Context(), resp, c, &Account{ID: 1, Platform: PlatformOpenAI}, time.Now(), "model", "model")
			require.NoError(t, err)
			require.False(t, guard.Finish())
			require.True(t, checkedHeld)
			require.True(t, checkedFlushed)
			require.Equal(t, "resp_headers", result.responseID)
			require.Equal(t, 640, result.usage.OutputTokens)

			// Validate every SSE data document and reconstruct the whole Unicode body.
			var text strings.Builder
			terminalCount, deltaCount := 0, 0
			for _, frame := range strings.Split(strings.TrimSpace(rec.Body.String()), "\n\n") {
				require.True(t, strings.HasPrefix(frame, "data: "), "incomplete SSE frame")
				var event struct {
					Type  string `json:"type"`
					Delta string `json:"delta"`
				}
				require.NoError(t, json.Unmarshal([]byte(strings.TrimPrefix(frame, "data: ")), &event))
				switch event.Type {
				case "response.output_text.delta":
					deltaCount++
					text.WriteString(event.Delta)
				case "response.completed":
					terminalCount++
				default:
					t.Fatalf("unexpected SSE event %q", event.Type)
				}
			}
			require.Equal(t, 640, deltaCount)
			require.Equal(t, 1, terminalCount)
			require.Equal(t, strings.Repeat("花", 640), text.String())
			wire := rec.Result().Header
			t.Logf("wire header counts: request-id=%d turn-state=%d rate-limit=%d; complete deltas=%d; early flush=%v", len(wire.Values("X-Request-Id")), len(wire.Values("X-Codex-Turn-State")), len(wire.Values("X-Ratelimit-Remaining-Requests")), deltaCount, checkedFlushed)
			require.Equal(t, 2, len(wire.Values("X-Request-Id")), "gateway ID plus exactly one upstream ID")
			require.Equal(t, []string{"gateway-request", "upstream-request"}, wire.Values("X-Request-Id"))
			require.Equal(t, 1, len(wire.Values("X-Codex-Turn-State")), "large staged header must only be applied once")
			require.Equal(t, largeState, wire.Get("X-Codex-Turn-State"))
			if filtered {
				require.Equal(t, []string{"99", "98"}, wire.Values("X-Ratelimit-Remaining-Requests"))
			}
			require.Equal(t, []string{"text/event-stream"}, wire.Values("Content-Type"))
			require.Equal(t, []string{"no-cache"}, wire.Values("Cache-Control"))
		})
	}
}
