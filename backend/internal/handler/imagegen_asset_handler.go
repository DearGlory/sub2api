package handler

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/gin-gonic/gin"
)

// imageGenAssetRoutePrefix is the public URL prefix for the image-generation
// plaza's server-hosted assets (prompt template catalog + preview images).
//
// These deliberately live on disk under <dataDir>/imagegen-assets rather than
// inside the embedded SPA bundle: operators add, remove or reorder templates by
// editing files on the server, with no rebuild and no new binary. The matching
// entry in shouldBypassEmbeddedFrontend keeps the SPA middleware from swallowing
// these paths.
const imageGenAssetRoutePrefix = "/imagegen-assets"

// ImageGenAssetHandler serves the image-generation plaza's template catalog and
// preview images from the data directory.
type ImageGenAssetHandler struct {
	assetsDir string
}

// NewImageGenAssetHandler builds the handler rooted at <dataDir>/imagegen-assets.
func NewImageGenAssetHandler(dataDir string) *ImageGenAssetHandler {
	return &ImageGenAssetHandler{assetsDir: filepath.Join(dataDir, "imagegen-assets")}
}

// ServeAsset resolves *filepath inside the assets directory and serves it.
//
// Path traversal is refused by resolving to an absolute path and confirming it
// stays under the root, rather than by string-matching "..". Anything that is
// not a regular file (directories, symlinks pointing outside) is a 404 so the
// route never leaks the layout of the data volume.
func (h *ImageGenAssetHandler) ServeAsset(c *gin.Context) {
	relPath := strings.TrimPrefix(c.Param("filepath"), "/")
	if relPath == "" {
		c.Status(http.StatusNotFound)
		return
	}

	root, err := filepath.Abs(h.assetsDir)
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	target, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(relPath)))
	if err != nil {
		c.Status(http.StatusNotFound)
		return
	}

	// A path equal to the root is a directory, and any path escaping it is an
	// escape attempt; both are rejected.
	if target == root || !strings.HasPrefix(target, root+string(filepath.Separator)) {
		c.Status(http.StatusNotFound)
		return
	}

	info, err := os.Stat(target)
	if err != nil || !info.Mode().IsRegular() {
		c.Status(http.StatusNotFound)
		return
	}

	// The catalog changes whenever an operator edits it, so it must not be
	// cached aggressively like the hashed bundle assets are.
	if strings.EqualFold(filepath.Ext(target), ".json") {
		c.Header("Cache-Control", "no-cache")
	} else {
		c.Header("Cache-Control", "public, max-age=3600")
	}

	c.File(target)
}

// RegisterImageGenAssetRoutes mounts the asset route on the panel API group so
// it inherits the same origin, rate limiting and logging as the rest of /api/v1.
func RegisterImageGenAssetRoutes(v1 *gin.RouterGroup, dataDir string) {
	h := NewImageGenAssetHandler(dataDir)
	v1.GET(imageGenAssetRoutePrefix+"/*filepath", h.ServeAsset)
}
