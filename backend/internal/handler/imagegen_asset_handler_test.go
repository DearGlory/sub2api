package handler

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/gin-gonic/gin"
)

// newAssetTestRouter mounts the real handler against a temp data dir.
func newAssetTestRouter(t *testing.T) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	dataDir := t.TempDir()
	assets := filepath.Join(dataDir, "imagegen-assets", "templates")
	if err := os.MkdirAll(filepath.Join(assets, "previews"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(
		filepath.Join(assets, "templates.json"),
		[]byte(`{"templates":[{"name":"demo","prompt":"p"}]}`),
		0o644,
	); err != nil {
		t.Fatalf("write catalog: %v", err)
	}
	if err := os.WriteFile(filepath.Join(assets, "previews", "a.webp"), []byte("RIFFxxxxWEBPVP8 "), 0o644); err != nil {
		t.Fatalf("write preview: %v", err)
	}

	r := gin.New()
	v1 := r.Group("/api/v1")
	RegisterImageGenAssetRoutes(v1, dataDir)
	return r, dataDir
}

func TestImageGenAssetsServesCatalog(t *testing.T) {
	r, _ := newAssetTestRouter(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/imagegen-assets/templates/templates.json", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if body := w.Body.String(); body == "" || body[0] != '{' {
		t.Fatalf("body = %q, want JSON", body)
	}
	// The catalog is edited by operators at runtime, so it must not be cached
	// as a long-lived immutable asset.
	if got := w.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", got)
	}
}

func TestImageGenAssetsServesPreviewImage(t *testing.T) {
	r, _ := newAssetTestRouter(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/imagegen-assets/templates/previews/a.webp", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if got := w.Header().Get("Cache-Control"); got == "no-cache" {
		t.Fatalf("cacheable asset should not use no-cache")
	}
}

func TestImageGenAssetsRejectsTraversal(t *testing.T) {
	r, _ := newAssetTestRouter(t)

	for _, path := range []string{
		"/api/v1/imagegen-assets/../../etc/passwd",
		"/api/v1/imagegen-assets/templates/../../../etc/passwd",
		"/api/v1/imagegen-assets/templates/%2e%2e/%2e%2e/etc/passwd",
	} {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code == http.StatusOK {
			t.Fatalf("%s: status = 200, want non-200 (traversal must be refused)", path)
		}
	}
}

func TestImageGenAssetsMissingFileIs404(t *testing.T) {
	r, _ := newAssetTestRouter(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/imagegen-assets/templates/nope.webp", nil))

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestImageGenAssetsRejectsDirectory(t *testing.T) {
	r, _ := newAssetTestRouter(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/v1/imagegen-assets/templates/previews", nil))

	if w.Code == http.StatusOK {
		t.Fatalf("status = 200 for a directory, want non-200")
	}
}
