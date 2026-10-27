package routes

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/handler"
	adminhandler "github.com/Wei-Shaw/sub2api/internal/handler/admin"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type evidenceSettingsRepo struct {
	service.SettingRepository
	values  map[string]string
	updates map[string]string
	fail    error
}

func (s *evidenceSettingsRepo) GetMultiple(_ context.Context, keys []string) (map[string]string, error) {
	out := map[string]string{}
	for _, key := range keys {
		if value, ok := s.values[key]; ok {
			out[key] = value
		}
	}
	return out, nil
}
func (s *evidenceSettingsRepo) SetMultiple(_ context.Context, values map[string]string) error {
	if s.fail != nil {
		return s.fail
	}
	s.updates = values
	for key, value := range values {
		s.values[key] = value
	}
	return nil
}
func evidenceSettingsRouter(t *testing.T) (*gin.Engine, *evidenceSettingsRepo, *int) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	repo := &evidenceSettingsRepo{values: map[string]string{"registration_enabled": "false", "poison_guard_enabled": "true", "poison_guard_threshold": "3"}}
	svc := service.NewSettingService(repo, &config.Config{})
	refreshed := new(int)
	svc.AddOnUpdateCallback(func() { *refreshed++ })
	h := &handler.Handlers{Admin: &handler.AdminHandlers{Setting: adminhandler.NewSettingHandler(svc, nil, nil, nil, nil, nil, nil)}}
	router := gin.New()
	group := router.Group("/api/v1/admin")
	group.Use(func(c *gin.Context) {
		if c.GetHeader("X-Test-Admin") != "yes" {
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	})
	registerSettingsRoutes(group, h)
	return router, repo, refreshed
}
func evidenceSettingsRequest(router *gin.Engine, method, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, "/api/v1/admin/settings/poison-evidence", bytes.NewBufferString(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Test-Admin", "yes")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}
func TestPoisonEvidenceSettingsRoutesNoopAndAuth(t *testing.T) {
	router, repo, refreshed := evidenceSettingsRouter(t)
	original := map[string]string{}
	for key, value := range repo.values {
		original[key] = value
	}
	noop := evidenceSettingsRequest(router, http.MethodPut, `{}`)
	require.Equal(t, http.StatusOK, noop.Code, noop.Body.String())
	require.Equal(t, original, repo.values)
	require.Zero(t, *refreshed)
	require.Nil(t, repo.updates)
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		response := httptest.NewRecorder()
		request := httptest.NewRequest(method, "/api/v1/admin/settings/poison-evidence", bytes.NewBufferString(`{"evidence_enabled":true}`))
		request.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(response, request)
		require.Equal(t, http.StatusUnauthorized, response.Code)
	}
	require.Equal(t, original, repo.values)
}

func TestPoisonEvidenceSettingsPersistFailureDoesNotRefresh(t *testing.T) {
	router, repo, refreshed := evidenceSettingsRouter(t)
	repo.fail = fmt.Errorf("database unavailable")
	response := evidenceSettingsRequest(router, http.MethodPut, `{"evidence_enabled":true}`)
	require.Equal(t, http.StatusInternalServerError, response.Code)
	require.Zero(t, *refreshed)
	require.NotContains(t, repo.values, "poison_guard_evidence_enabled")
	require.Nil(t, repo.updates)
}

func TestPoisonEvidenceSettingsInvalidBodyPreservesSettings(t *testing.T) {
	router, repo, refreshed := evidenceSettingsRouter(t)
	for _, body := range []string{`{"evidence_enabled":"true"}`, `{"evidence_enabled":`, `[]`} {
		response := evidenceSettingsRequest(router, http.MethodPut, body)
		require.Equal(t, http.StatusBadRequest, response.Code)
	}
	require.Zero(t, *refreshed)
	require.Nil(t, repo.updates)
}

func TestPoisonEvidenceSettingsRoutesRoundTrip(t *testing.T) {
	router, repo, refreshed := evidenceSettingsRouter(t)
	initial := evidenceSettingsRequest(router, http.MethodGet, "")
	require.Equal(t, http.StatusOK, initial.Code, initial.Body.String())
	var decoded struct {
		Data struct {
			Enabled bool   `json:"evidence_enabled"`
			Dir     string `json:"evidence_dir"`
		}
	}
	require.NoError(t, json.Unmarshal(initial.Body.Bytes(), &decoded))
	require.False(t, decoded.Data.Enabled)
	require.Equal(t, "./data/poison-evidence", decoded.Data.Dir)
	enabled := evidenceSettingsRequest(router, http.MethodPut, `{"evidence_enabled":true,"evidence_dir":"./data/hit-evidence"}`)
	require.Equal(t, http.StatusOK, enabled.Code, enabled.Body.String())
	require.Equal(t, map[string]string{"poison_guard_evidence_enabled": "true", "poison_guard_evidence_dir": "./data/hit-evidence"}, repo.updates)
	require.Equal(t, 1, *refreshed)
	require.Equal(t, "false", repo.values["registration_enabled"])
	require.Equal(t, "3", repo.values["poison_guard_threshold"])
	disabled := evidenceSettingsRequest(router, http.MethodPut, `{"evidence_enabled":false}`)
	require.Equal(t, http.StatusOK, disabled.Code, disabled.Body.String())
	require.Equal(t, map[string]string{"poison_guard_evidence_enabled": "false"}, repo.updates)
	require.Equal(t, "./data/hit-evidence", repo.values["poison_guard_evidence_dir"])
	require.Equal(t, 2, *refreshed)
}
