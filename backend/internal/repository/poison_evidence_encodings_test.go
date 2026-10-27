//go:build unit

package repository

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/stretchr/testify/require"
)

func TestPoisonEvidenceEncodedOriginalsAndDecodedBodies(t *testing.T) {
	raw := []byte(" {\"text\":\"kedaya\",\"spacing\":  1} \n")
	for _, tc := range []struct {
		name     string
		compress func(*testing.T, []byte) []byte
	}{
		{"br", compressBrotli}, {"deflate", compressDeflate}, {"zstd", compressZstd},
	} {
		t.Run(tc.name, func(t *testing.T) {
			compressed := tc.compress(t, raw)
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Content-Encoding", tc.name)
				_, _ = w.Write(compressed)
			}))
			defer upstream.Close()
			dir := t.TempDir()
			c := evidenceAttach(t, dir)
			request, _ := http.NewRequestWithContext(c.Request.Context(), http.MethodGet, upstream.URL, nil)
			request.Header.Set("Accept-Encoding", tc.name)
			response, err := doUpstreamRequest(upstream.Client(), request)
			require.NoError(t, err)
			decoded, err := io.ReadAll(response.Body)
			require.NoError(t, err)
			require.NoError(t, response.Body.Close())
			require.Equal(t, raw, decoded)
			c.Data(http.StatusOK, "application/json", decoded)
			poison.Finalize(c)
			path := c.GetString("poison_guard_evidence_path")
			require.NotEmpty(t, path)
			metadata, err := os.ReadFile(filepath.Join(path, "metadata.json"))
			require.NoError(t, err)
			var m struct {
				Responses []struct {
					File     string `json:"file"`
					Stage    string `json:"capture_stage"`
					Encoding string `json:"content_encoding"`
				}
			}
			require.NoError(t, json.Unmarshal(metadata, &m))
			require.Len(t, m.Responses, 2)
			original, err := os.ReadFile(filepath.Join(path, m.Responses[0].File))
			require.NoError(t, err)
			require.Equal(t, compressed, original)
			require.Equal(t, tc.name, m.Responses[0].Encoding)
			plain, err := os.ReadFile(filepath.Join(path, m.Responses[1].File))
			require.NoError(t, err)
			require.Equal(t, raw, plain)
			require.Equal(t, "decoded_upstream_body", m.Responses[1].Stage)
		})
	}
}
