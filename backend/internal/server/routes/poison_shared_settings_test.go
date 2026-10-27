package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func sharedSettingsRequest(router *gin.Engine, method, path, body string, admin bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	if admin {
		request.Header.Set("X-Test-Admin", "yes")
	}
	w := httptest.NewRecorder()
	router.ServeHTTP(w, request)
	return w
}
func TestPoisonSharedSettingsRoutesRoundTrip(t *testing.T) {
	router, repo, refresh := evidenceSettingsRouter(t)
	initial := sharedSettingsRequest(router, "GET", "/api/v1/admin/poison/shared", "", true)
	require.Equal(t, http.StatusOK, initial.Code, initial.Body.String())
	var v struct {
		Data struct {
			Enabled bool `json:"enabled"`
		}
	}
	require.NoError(t, json.Unmarshal(initial.Body.Bytes(), &v))
	require.False(t, v.Data.Enabled)
	on := sharedSettingsRequest(router, "PUT", "/api/v1/admin/poison/shared", `{"enabled":true}`, true)
	require.Equal(t, http.StatusOK, on.Code, on.Body.String())
	require.Equal(t, map[string]string{"poison_guard_shared_enabled": "true"}, repo.updates)
	require.Equal(t, 1, *refresh)
	require.Equal(t, "3", repo.values["poison_guard_threshold"])
	require.Equal(t, "false", repo.values["registration_enabled"])
	off := sharedSettingsRequest(router, "PUT", "/api/v1/admin/poison/shared", `{"enabled":false}`, true)
	require.Equal(t, http.StatusOK, off.Code)
	require.Equal(t, 2, *refresh)
	require.Equal(t, "false", repo.values["poison_guard_shared_enabled"])
	noop := sharedSettingsRequest(router, "PUT", "/api/v1/admin/poison/shared", `{}`, true)
	require.Equal(t, http.StatusOK, noop.Code)
	require.Equal(t, 2, *refresh)
	for _, body := range []string{`{"enabled":"yes"}`, `{`, `[]`} {
		require.Equal(t, 400, sharedSettingsRequest(router, "PUT", "/api/v1/admin/poison/shared", body, true).Code)
	}
}
func TestPoisonSharedSettingsRoutesAuthentication(t *testing.T) {
	router, repo, refresh := evidenceSettingsRouter(t)
	for _, tc := range []struct{ method, path string }{{"GET", "/api/v1/admin/poison/shared"}, {"PUT", "/api/v1/admin/poison/shared"}, {"POST", "/api/v1/admin/poison/shared/reconcile"}, {"POST", "/api/v1/admin/poison/shared/backfill"}} {
		require.Equal(t, 401, sharedSettingsRequest(router, tc.method, tc.path, `{"enabled":true}`, false).Code)
	}
	require.Nil(t, repo.updates)
	require.Zero(t, *refresh)
}
func TestPoisonSharedSettingsWriteFailurePreservesRuntime(t *testing.T) {
	router, repo, refresh := evidenceSettingsRouter(t)
	repo.fail = context.DeadlineExceeded
	w := sharedSettingsRequest(router, "PUT", "/api/v1/admin/poison/shared", `{"enabled":true}`, true)
	require.Equal(t, 500, w.Code)
	require.Zero(t, *refresh)
	require.NotContains(t, repo.values, "poison_guard_shared_enabled")
}
