package poison

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func TestEvidenceConfirmedHitPanicRetained(t *testing.T) {
	for _, mode := range []string{"hit", "late-hit", "ordinary", "parse-error"} {
		t.Run(mode, func(t *testing.T) {
			prior := CurrentHandler()
			dispatched := make(chan Incident, 4)
			AttachHandler(&Handler{IncidentCurrent: func(_ context.Context, inc Incident) (bool, error) {
				dispatched <- inc
				return false, nil
			}})
			t.Cleanup(func() { AttachHandler(prior) })
			dir := t.TempDir()
			snap := activeSnapshot()
			snap.EvidenceEnabled = true
			snap.EvidenceDir = dir
			var recovered any
			var ctx *gin.Context
			raw := strings.Repeat("x", wireMemoryThreshold+1) + "kedaya"
			router := gin.New()
			router.Use(gin.CustomRecoveryWithWriter(io.Discard, func(c *gin.Context, v any) { recovered = v }), Middleware())
			router.GET("/", func(c *gin.Context) {
				ctx = c
				require.True(t, Attach(c, snap, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 51}))
				feedEvidence(t, c, raw)
				if mode == "late-hit" {
					c.Writer.WriteString(strings.Repeat("safe ", 10000))
					require.Positive(t, StatusGuard(c).Committed())
				}
				if mode == "hit" || mode == "late-hit" {
					c.Writer.WriteString("kedaya")
				}
				if mode == "parse-error" {
					c.Header("Content-Type", "text/event-stream")
					c.Writer.WriteString("data: {broken\n\n")
				}
				// An inner capture middleware can release its pooled writer while unwinding.
				defer func() { StatusGuard(c).ResponseWriter = nil }()
				panic("original panic")
			})
			router.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
			require.Equal(t, "original panic", recovered)
			entries, err := os.ReadDir(dir)
			require.NoError(t, err)
			if mode != "hit" && mode != "late-hit" {
				select {
				case <-dispatched:
					t.Fatal("unconfirmed panic dispatched")
				case <-time.After(20 * time.Millisecond):
				}
				require.Empty(t, entries)
				require.Empty(t, ctx.GetString("poison_guard_evidence_id"))
				return
			}
			select {
			case inc := <-dispatched:
				require.NotEmpty(t, inc.Reason)
			case <-time.After(time.Second):
				t.Fatal("confirmed hit not dispatched")
			}
			Finalize(ctx)
			select {
			case <-dispatched:
				t.Fatal("duplicate dispatch")
			case <-time.After(20 * time.Millisecond):
			}
			require.Len(t, entries, 1)
			path := ctx.GetString("poison_guard_evidence_path")
			require.NotEmpty(t, path)
			data, err := os.ReadFile(filepath.Join(path, "metadata.json"))
			require.NoError(t, err)
			var m evidenceMetadata
			require.NoError(t, json.Unmarshal(data, &m))
			require.NotEmpty(t, m.Hit.Reason)
			body, err := os.ReadFile(filepath.Join(path, m.Responses[0].File))
			require.NoError(t, err)
			require.Equal(t, raw, string(body))
		})
	}
}

func TestEvidenceIOFailureCorrelation(t *testing.T) {
	c, _, dir := evidenceFixture(t)
	var out bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&out)
	defer log.SetOutput(previous)
	s := StatusGuard(c).evidence
	proxy := int64(77)
	s.meta.ProxyID = &proxy
	s.root = filepath.Join(dir, "not-directory")
	require.NoError(t, os.WriteFile(s.root, []byte("x"), 0600))
	feedEvidence(t, c, strings.Repeat("x", wireMemoryThreshold+1)+"kedaya")
	c.Writer.WriteString("kedaya")
	Finalize(c)
	require.Equal(t, s.meta.ID, c.GetString("poison_guard_evidence_id"))
	require.Empty(t, c.GetString("poison_guard_evidence_path"))
	failureLine := strings.Split(out.String(), "\n")[0]
	for _, field := range []string{"request_id=\"" + s.meta.RequestID + "\"", "account_id=51", "proxy_id=77", "evidence_id=" + s.meta.ID, "stage=spool_create", " bytes="} {
		require.Contains(t, failureLine, field)
	}
	require.Contains(t, out.String(), "[poison] blocked")
	require.Equal(t, 2, strings.Count(out.String(), "evidence_id="+s.meta.ID))
	require.NotContains(t, out.String(), s.root)
	require.NotContains(t, failureLine, "kedaya")
	require.True(t, s.closed)
}

func TestEvidenceResponseAttemptLayerCorrelation(t *testing.T) {
	s := newEvidenceSession(t.TempDir(), "r", "/", "m", AccountInfo{})
	defer s.close()
	ctx := context.WithValue(context.Background(), evidenceContextKey{}, s)
	responses := []*http.Response{{Header: make(http.Header), Body: io.NopCloser(strings.NewReader("one"))}, {Header: make(http.Header), Body: io.NopCloser(strings.NewReader("two"))}}
	for _, r := range responses {
		CaptureUpstreamResponse(ctx, r)
	}
	// Interleave decoders so the most recent response is not sufficient identity.
	for _, r := range responses {
		r.Body = struct{ io.ReadCloser }{r.Body}
		CaptureDecodedResponse(ctx, r)
		_, err := io.ReadAll(r.Body)
		require.NoError(t, err)
	}
	NewWebSocketCapture(ctx).Capture([]byte("first"))
	NewWebSocketCapture(ctx).Capture([]byte("second"))
	expected := []int{1, 2, 1, 2, 3, 3, 4, 4}
	require.Len(t, s.meta.Responses, len(expected))
	for i, r := range s.meta.Responses {
		require.Equal(t, expected[i], r.Attempt, "capture %d", i+1)
		data, err := json.Marshal(r)
		require.NoError(t, err)
		var fields map[string]any
		require.NoError(t, json.Unmarshal(data, &fields))
		require.Equal(t, float64(i+1), fields["capture_index"])
	}
	require.Equal(t, "one", string(s.meta.Responses[0].memory))
	require.Equal(t, "two", string(s.meta.Responses[1].memory))
}

type evidenceBarrierReader struct{ entered, closed chan struct{} }

func (r *evidenceBarrierReader) Read(p []byte) (int, error) {
	close(r.entered)
	<-r.closed
	return copy(p, "late"), io.EOF
}
func (r *evidenceBarrierReader) Close() error { close(r.closed); return nil }
func TestEvidenceConcurrentReadCloseBarrier(t *testing.T) {
	s := newEvidenceSession(t.TempDir(), "r", "/", "m", AccountInfo{})
	defer s.close()
	ctx := context.WithValue(context.Background(), evidenceContextKey{}, s)
	source := &evidenceBarrierReader{make(chan struct{}), make(chan struct{})}
	resp := &http.Response{Body: source}
	CaptureUpstreamResponse(ctx, resp)
	done := make(chan struct{})
	go func() { defer close(done); io.Copy(io.Discard, resp.Body) }()
	<-source.entered
	s.markHit(HitDetails{Reason: "confirmed"}, 0)
	require.NoError(t, resp.Body.Close())
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Read/Close deadlock")
	}
	_, path := s.finalize()
	require.NotEmpty(t, path)
	require.Zero(t, s.meta.Responses[0].Bytes)
}
