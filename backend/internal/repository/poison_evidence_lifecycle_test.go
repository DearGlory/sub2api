//go:build unit

package repository

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func evidenceAttach(t *testing.T, dir string) *gin.Context {
	t.Helper()
	gin.SetMode(gin.TestMode)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("GET", "/v1/responses", nil)
	st := poison.NewStore(func() (map[string]string, error) {
		return map[string]string{"poison_guard_enabled": "true", "poison_guard_evidence_enabled": "true", "poison_guard_evidence_dir": dir}, nil
	})
	require.NoError(t, st.Reload())
	require.True(t, poison.Attach(c, st.Current(), poison.AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 1}))
	t.Cleanup(func() { poison.StatusGuard(c).Close() })
	return c
}
func TestPoisonEvidenceCompressionCaptureLayers(t *testing.T) {
	raw := []byte(` {"text":"kedaya"} `)
	var zipped bytes.Buffer
	gz := gzip.NewWriter(&zipped)
	gz.Write(raw)
	gz.Close()
	for _, explicit := range []bool{false, true} {
		t.Run(map[bool]string{false: "transport-auto", true: "explicit-gzip"}[explicit], func(t *testing.T) {
			dir := t.TempDir()
			c := evidenceAttach(t, dir)
			up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Encoding", "gzip")
				w.Write(zipped.Bytes())
			}))
			defer up.Close()
			req, _ := http.NewRequestWithContext(c.Request.Context(), "GET", up.URL, nil)
			if explicit {
				req.Header.Set("Accept-Encoding", "gzip")
			}
			resp, err := doUpstreamRequest(up.Client(), req)
			require.NoError(t, err)
			body, err := io.ReadAll(resp.Body)
			require.NoError(t, err)
			require.NoError(t, resp.Body.Close())
			require.Equal(t, raw, body)
			c.Data(200, "application/json", body)
			poison.Finalize(c)
			path := c.GetString("poison_guard_evidence_path")
			require.NotEmpty(t, path)
			meta, err := os.ReadFile(filepath.Join(path, "metadata.json"))
			require.NoError(t, err)
			var m struct {
				Responses []struct {
					File         string `json:"file"`
					Stage        string `json:"capture_stage"`
					Encoding     string `json:"content_encoding"`
					Uncompressed bool   `json:"uncompressed"`
				}
			}
			require.NoError(t, json.Unmarshal(meta, &m))
			first, err := os.ReadFile(filepath.Join(path, m.Responses[0].File))
			require.NoError(t, err)
			if explicit {
				require.Equal(t, zipped.Bytes(), first)
				require.Equal(t, "gzip", m.Responses[0].Encoding)
				require.Len(t, m.Responses, 2)
				decoded, err := os.ReadFile(filepath.Join(path, m.Responses[1].File))
				require.NoError(t, err)
				require.Equal(t, raw, decoded)
				require.Equal(t, "decoded_upstream_body", m.Responses[1].Stage)
			} else {
				require.Equal(t, raw, first)
				require.True(t, m.Responses[0].Uncompressed)
			}
		})
	}
}
func TestPoisonEvidenceRealSocketHitCancelsBlockedUpstream(t *testing.T) {
	dir := t.TempDir()
	c := evidenceAttach(t, dir)
	ended := make(chan struct{})
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(ended)
		io.WriteString(w, "kedaya")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer up.Close()
	req, _ := http.NewRequestWithContext(c.Request.Context(), "GET", up.URL, nil)
	resp, err := doUpstreamRequest(up.Client(), req)
	require.NoError(t, err)
	buf := make([]byte, 100)
	n, err := resp.Body.Read(buf)
	require.NoError(t, err)
	c.Writer.Write(buf[:n])
	resp.Body.Close()
	poison.Finalize(c)
	select {
	case <-ended:
	case <-time.After(2 * time.Second):
		t.Fatal("hit did not cancel blocked upstream")
	}
	path := c.GetString("poison_guard_evidence_path")
	require.NotEmpty(t, path)
	raw, err := os.ReadFile(filepath.Join(path, "response-1.body"))
	require.NoError(t, err)
	require.Equal(t, "kedaya", string(raw))
	meta, err := os.ReadFile(filepath.Join(path, "metadata.json"))
	require.NoError(t, err)
	require.Contains(t, string(meta), `"eof": false`)
}
