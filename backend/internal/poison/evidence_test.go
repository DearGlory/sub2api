package poison

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/ctxkey"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func evidenceFixture(t *testing.T) (*gin.Context, *Snapshot, string) {
	t.Helper()
	dir := t.TempDir()
	snap := activeSnapshot()
	snap.EvidenceEnabled = true
	snap.EvidenceDir = dir
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	ctx := context.WithValue(context.Background(), ctxkey.RequestID, "rid-not-a-filename/../")
	ctx = context.WithValue(ctx, ctxkey.Model, "test-model")
	c.Request = httptest.NewRequest("POST", "/v1/responses?credential=hidden", nil).WithContext(ctx)
	require.True(t, Attach(c, snap, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 51}))
	t.Cleanup(func() { StatusGuard(c).Close() })
	return c, snap, dir
}
func feedEvidence(t *testing.T, c *gin.Context, raw string) *http.Response {
	t.Helper()
	resp := &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(raw))}
	CaptureUpstreamResponse(c.Request.Context(), resp)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	require.Equal(t, raw, string(body))
	require.NoError(t, resp.Body.Close())
	return resp
}
func evidenceReceipt(t *testing.T, c *gin.Context, dir string) (evidenceMetadata, string) {
	t.Helper()
	Finalize(c)
	path := c.GetString("poison_guard_evidence_path")
	require.NotEmpty(t, path)
	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	require.Len(t, entries, 1)
	raw, err := os.ReadFile(filepath.Join(path, "metadata.json"))
	require.NoError(t, err)
	var m evidenceMetadata
	require.NoError(t, json.Unmarshal(raw, &m))
	return m, path
}
func TestEvidenceLifecycleProtocolMatrix(t *testing.T) {
	cases := []struct{ name, ct, raw string }{
		{"json-unicode", "application/json", ` {"choices":[{"message":{"content":"\u006b\u0065daya"}}]} `},
		{"chat-split", "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"ke\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{\"content\":\"daya\"}}]}\r\n\r\n"},
		{"anthropic-tools", "text/event-stream", "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"kedaya\"}}\n\n"},
		{"responses-reasoning", "text/event-stream", "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"kedaya\"}\n\n"},
		{"gemini", "text/event-stream", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"kedaya\"}]}}]}\n\n"},
		{"raw-unicode-threshold", "text/plain", "您好您好这里是密钥"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _, dir := evidenceFixture(t)
			feedEvidence(t, c, tc.raw)
			c.Header("Content-Type", tc.ct)
			// Byte splits include UTF-8 and SSE frame boundaries.
			for _, b := range []byte(tc.raw) {
				_, err := c.Writer.Write([]byte{b})
				require.NoError(t, err)
			}
			m, path := evidenceReceipt(t, c, dir)
			require.NotEmpty(t, m.Hit.Matched)
			require.NotEmpty(t, m.Hit.Lane)
			require.Equal(t, "test-model", m.Model)
			require.Equal(t, "/v1/responses", m.Path)
			require.Equal(t, "rid-not-a-filename/../", m.RequestID)
			if tc.name == "raw-unicode-threshold" {
				require.Equal(t, 3, m.Hit.Counted)
				require.False(t, m.Hit.Veto)
			}
			require.Len(t, m.Responses, 1)
			r := m.Responses[0]
			require.True(t, r.EOF)
			require.True(t, r.Complete)
			body, err := os.ReadFile(filepath.Join(path, r.File))
			require.NoError(t, err)
			require.Equal(t, tc.raw, string(body))
			sum := sha256.Sum256(body)
			require.Equal(t, hex.EncodeToString(sum[:]), r.SHA256)
			for _, f := range []string{path, filepath.Join(path, "metadata.json"), filepath.Join(path, r.File)} {
				st, err := os.Stat(f)
				require.NoError(t, err)
				if st.IsDir() {
					require.Equal(t, os.FileMode(0700), st.Mode().Perm())
				} else {
					require.Equal(t, os.FileMode(0600), st.Mode().Perm())
				}
			}
		})
	}
}
func TestEvidenceCleanupNormalParseErrorRetryAndClose(t *testing.T) {
	for _, mode := range []string{"normal", "parse-error", "retry", "cancel", "panic"} {
		t.Run(mode, func(t *testing.T) {
			c, snap, dir := evidenceFixture(t)
			old := c.Request.Context()
			feedEvidence(t, c, strings.Repeat("x", wireMemoryThreshold+1))
			entries, _ := os.ReadDir(dir)
			require.Len(t, entries, 1)
			switch mode {
			case "normal":
				c.Writer.WriteString("safe")
				Finalize(c)
			case "parse-error":
				c.Header("Content-Type", "text/event-stream")
				c.Writer.WriteString("data: {broken\n\n")
				Finalize(c)
			case "retry":
				require.True(t, Attach(c, snap, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 52}))
				r := &http.Response{Body: io.NopCloser(strings.NewReader("old"))}
				original := r.Body
				CaptureUpstreamResponse(old, r)
				require.True(t, original == r.Body)
			default:
				StatusGuard(c).Close()
			}
			entries, _ = os.ReadDir(dir)
			require.Empty(t, entries)
			require.Empty(t, c.GetString("poison_guard_evidence_path"))
		})
	}
}
func TestEvidenceDisabledAndBypassNoWrapperOrAllocation(t *testing.T) {
	for _, enabled := range []bool{false, true} {
		snap := activeSnapshot()
		snap.EvidenceEnabled = enabled
		snap.EvidenceDir = t.TempDir()
		c, _ := gin.CreateTestContext(httptest.NewRecorder())
		c.Request = httptest.NewRequest("GET", "/", nil)
		Attach(c, snap, AccountInfo{BaseURL: "https://unmatched.invalid", HasProxy: true})
		resp := &http.Response{Body: io.NopCloser(strings.NewReader("safe"))}
		original := resp.Body
		require.Zero(t, testing.AllocsPerRun(100, func() { CaptureUpstreamResponse(c.Request.Context(), resp) }))
		require.True(t, original == resp.Body)
		entries, _ := os.ReadDir(snap.EvidenceDir)
		require.Empty(t, entries)
	}
	c, snap, _ := evidenceFixture(t)
	StatusGuard(c).Close()
	snap.EvidenceEnabled = false
	Attach(c, snap, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true})
	require.Nil(t, StatusGuard(c).evidence)
}
func TestEvidenceDiskFailurePreservesBlocking(t *testing.T) {
	c, _, dir := evidenceFixture(t)
	s := StatusGuard(c).evidence
	file := filepath.Join(dir, "not-directory")
	require.NoError(t, os.WriteFile(file, []byte("x"), 0600))
	s.root = file
	raw := strings.Repeat("x", wireMemoryThreshold+1) + "kedaya"
	feedEvidence(t, c, raw)
	c.Writer.WriteString("kedaya")
	Finalize(c)
	require.True(t, StatusGuard(c).Blocked())
	require.Empty(t, c.GetString("poison_guard_evidence_path"))
	require.Equal(t, "spool_create", s.failed)
}

type evidenceTailReader struct {
	reads  int
	closed bool
}

func (r *evidenceTailReader) Read(p []byte) (int, error) {
	r.reads++
	return copy(p, "kedaya"), errors.New("secret-url-must-not-escape")
}
func (r *evidenceTailReader) Close() error { r.closed = true; return nil }
func TestEvidenceReadErrorFreezeAndDisposition(t *testing.T) {
	c, _, dir := evidenceFixture(t)
	reader := &evidenceTailReader{}
	resp := &http.Response{Body: reader}
	CaptureUpstreamResponse(c.Request.Context(), resp)
	b := make([]byte, 64)
	n, err := resp.Body.Read(b)
	require.Error(t, err)
	c.Writer.Write(b[:n])
	resp.Body.Read(b)
	require.Equal(t, 2, reader.reads)
	m, path := evidenceReceipt(t, c, dir)
	require.Equal(t, int64(6), m.Responses[0].Bytes)
	require.False(t, m.Responses[0].Complete)
	require.Equal(t, "upstream_read", m.Responses[0].ReadError)
	require.NoError(t, WriteEvidenceDisposition(path, map[string]string{"outcome": "deferred"}))
	value, err := os.ReadFile(filepath.Join(path, "disposition.json"))
	require.NoError(t, err)
	require.Contains(t, string(value), "deferred")
}
func TestEvidenceSnapshotAtFlushAndInspectionOffset(t *testing.T) {
	c, snap, dir := evidenceFixture(t)
	// A replacement rune is only produced at Flush for an incomplete UTF-8 suffix.
	snap.Detector = NewDetector(Config{Veto: []string{"�"}})
	feedEvidence(t, c, string([]byte{0xe4}))
	c.Writer.Write([]byte{0xe4})
	m, _ := evidenceReceipt(t, c, dir)
	require.Equal(t, []string{"�"}, m.Hit.Matched)
	data, _ := json.Marshal(m.Hit)
	require.Contains(t, string(data), `"inspected_runes":1`)
}

func TestEvidenceDisabledHitSnapshotNoAllocation(t *testing.T) {
	d := NewDetector(Config{Veto: []string{"kedaya"}})
	s := d.NewStreamGuard()
	s.Feed("kedaya")
	g := newResponseGuard(d, "text/plain")
	require.Zero(t, testing.AllocsPerRun(100, func() { g.recordHit(s, "raw") }))
}

func TestEvidenceWSMemoryBoundAcrossMessages(t *testing.T) {
	c, _, _ := evidenceFixture(t)
	ws := NewWebSocketCapture(c.Request.Context())
	for i := 0; i < 100; i++ {
		ws.Capture([]byte(strings.Repeat("x", 10000)))
	}
	s := StatusGuard(c).evidence
	total := 0
	for _, r := range s.meta.Responses {
		total += cap(r.memory)
	}
	require.LessOrEqual(t, total, wireMemoryThreshold*2, "aggregate WS memory must spill")
}

func TestEvidenceMiddlewarePanicCleanup(t *testing.T) {
	dir := t.TempDir()
	snap := activeSnapshot()
	snap.EvidenceEnabled = true
	snap.EvidenceDir = dir
	r := gin.New()
	r.Use(gin.CustomRecovery(func(c *gin.Context, _ any) { c.Status(500) }), Middleware())
	r.GET("/", func(c *gin.Context) {
		Attach(c, snap, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true})
		feedEvidence(t, c, strings.Repeat("x", wireMemoryThreshold+1))
		panic("synthetic")
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	entries, _ := os.ReadDir(dir)
	require.Empty(t, entries)
}
func TestEvidenceRetryThenHitDoesNotMixAccounts(t *testing.T) {
	c, snap, dir := evidenceFixture(t)
	feedEvidence(t, c, "account-one-clean")
	Attach(c, snap, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 52})
	feedEvidence(t, c, "account-two-kedaya")
	c.Writer.WriteString("kedaya")
	m, path := evidenceReceipt(t, c, dir)
	require.Equal(t, int64(52), m.AccountID)
	require.Len(t, m.Responses, 1)
	raw, err := os.ReadFile(filepath.Join(path, m.Responses[0].File))
	require.NoError(t, err)
	require.Equal(t, "account-two-kedaya", string(raw))
}
func TestEvidenceWebSocketForwardIsolation(t *testing.T) {
	c, _, dir := evidenceFixture(t)
	a := NewWebSocketCapture(c.Request.Context())
	b := NewWebSocketCapture(c.Request.Context())
	a.Capture([]byte("first"))
	b.Capture([]byte("second-kedaya"))
	a.Capture([]byte("-end"))
	c.Writer.WriteString("kedaya")
	b.Capture([]byte("ignored-after-freeze"))
	m, path := evidenceReceipt(t, c, dir)
	require.Len(t, m.Responses, 4)
	first, err := os.ReadFile(filepath.Join(path, m.Responses[0].File))
	require.NoError(t, err)
	require.Equal(t, "first-end", string(first))
	second, err := os.ReadFile(filepath.Join(path, m.Responses[2].File))
	require.NoError(t, err)
	require.Equal(t, "second-kedaya", string(second))
	lengths, err := os.ReadFile(filepath.Join(path, m.Responses[1].File))
	require.NoError(t, err)
	require.Equal(t, 16, len(lengths))
}
func TestEvidenceConcurrentReadCloseFreeze(t *testing.T) {
	c, _, dir := evidenceFixture(t)
	s := StatusGuard(c).evidence
	ctx := c.Request.Context()
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := &http.Response{Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 10000)))}
			CaptureUpstreamResponse(ctx, r)
			io.Copy(io.Discard, r.Body)
			r.Body.Close()
		}()
	}
	s.markHit(HitDetails{Reason: "test", Matched: []string{"test"}}, 0)
	wg.Wait()
	_, path := s.finalize()
	require.NotEmpty(t, path)
	entries, _ := os.ReadDir(dir)
	require.Len(t, entries, 1)
}
