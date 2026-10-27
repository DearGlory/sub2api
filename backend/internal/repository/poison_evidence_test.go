//go:build unit

package repository

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/gin-gonic/gin"
)

func TestPoisonEvidenceRealSocketJSONAfterBodyClose(t *testing.T) {
	dir := t.TempDir()
	raw := " { \"content\" : [{\"type\":\"text\",\"text\":\"kedaya\"}] }\n"
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		io.WriteString(w, raw)
	}))
	defer up.Close()
	st := poison.NewStore(func() (map[string]string, error) {
		return map[string]string{"poison_guard_enabled": "true", "poison_guard_evidence_enabled": "true", "poison_guard_evidence_dir": dir}, nil
	})
	if err := st.Reload(); err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	router := gin.New()
	done := make(chan struct{})
	router.Use(func(c *gin.Context) { defer close(done); c.Next() })
	router.Use(poison.Middleware())
	router.GET("/v1/responses", func(c *gin.Context) {
		if !poison.Attach(c, st.Current(), poison.AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true, AccountID: 42}) {
			t.Error("not admitted")
			return
		}
		req, _ := http.NewRequestWithContext(c.Request.Context(), "GET", up.URL, nil)
		resp, err := doUpstreamRequest(up.Client(), req)
		if err != nil {
			t.Error(err)
			return
		}
		body, err := io.ReadAll(resp.Body)
		resp.Body.Close()
		if err != nil {
			t.Error(err)
			return
		}
		if string(body) != raw {
			t.Error("transport changed raw body")
		}
		c.Data(200, "application/json", []byte(`{"content":[{"type":"text","text":"kedaya"}]}`))
	})
	gateway := httptest.NewServer(router)
	defer gateway.Close()
	req, _ := http.NewRequestWithContext(context.Background(), "GET", gateway.URL+"/v1/responses?secret=never-metadata", nil)
	resp, err := gateway.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 502 {
		t.Fatalf("status=%d want 502", resp.StatusCode)
	}
	<-done
	dirs, _ := os.ReadDir(dir)
	if len(dirs) != 1 {
		t.Fatalf("published evidence directories=%d want 1", len(dirs))
	}
	body, err := os.ReadFile(filepath.Join(dir, dirs[0].Name(), "response-1.body"))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != raw {
		t.Fatalf("captured=%q want=%q", body, raw)
	}
	meta, err := os.ReadFile(filepath.Join(dir, dirs[0].Name(), "metadata.json"))
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("metadata=%s", meta)
}
