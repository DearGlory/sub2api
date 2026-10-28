package admin

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type sharedAdminSettingRepo struct{ service.SettingRepository }

func (*sharedAdminSettingRepo) GetMultiple(context.Context, []string) (map[string]string, error) {
	return map[string]string{"poison_guard_enabled": "true"}, nil
}
func TestPoisonSharedAdminActionsReachCoordinator(t *testing.T) {
	gin.SetMode(gin.TestMode)
	settings := service.NewSettingService(&sharedAdminSettingRepo{}, &config.Config{})
	h := NewSettingHandler(settings, nil, nil, nil, nil, nil, nil)
	stateCalls, reconciles, backfills := 0, 0, 0
	h.SetPoisonSharedAdmin(&PoisonSharedAdmin{
		State: func(ctx context.Context) (any, error) {
			require.Equal(t, "trace", ctx.Value("test"))
			stateCalls++
			return map[string]any{"shared_proxy_id": 2, "generation": 5}, nil
		},
		Reconcile: func(ctx context.Context) error {
			require.Equal(t, "trace", ctx.Value("test"))
			reconciles++
			return nil
		},
		Backfill: func(ctx context.Context) (string, error) {
			require.Equal(t, "trace", ctx.Value("test"))
			backfills++
			return "batch-proof", nil
		},
	})
	request := func(fn gin.HandlerFunc) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest("POST", "/", nil).WithContext(context.WithValue(context.Background(), "test", "trace"))
		fn(c)
		return w
	}
	w := request(h.ReconcilePoisonShared)
	require.Equal(t, 200, w.Code)
	require.Equal(t, 1, reconciles)
	require.Equal(t, 1, stateCalls)
	var body struct {
		Data struct {
			Enabled bool `json:"enabled"`
			State   struct {
				Proxy int64 `json:"shared_proxy_id"`
			}
		}
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.True(t, body.Data.Enabled)
	require.Equal(t, int64(2), body.Data.State.Proxy)
	w = request(h.BackfillPoisonShared)
	require.Equal(t, 200, w.Code)
	require.Contains(t, w.Body.String(), "batch-proof")
	require.Equal(t, 1, backfills)
	h.poisonShared.Backfill = func(context.Context) (string, error) { return "", errors.New("SECRET-upstream") }
	w = request(h.BackfillPoisonShared)
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
	require.False(t, strings.Contains(w.Body.String(), "SECRET"))
	h.poisonShared.Reconcile = func(context.Context) error { return errors.New("SECRET-upstream") }
	w = request(h.ReconcilePoisonShared)
	require.Equal(t, 503, w.Code)
	require.NotContains(t, w.Body.String(), "SECRET")
	h.poisonShared.State = func(context.Context) (any, error) { return nil, errors.New("SECRET-state") }
	w = request(h.GetPoisonShared)
	require.Equal(t, 503, w.Code)
	require.NotContains(t, w.Body.String(), "SECRET")
	h.SetPoisonSharedAdmin(nil)
	require.Equal(t, 503, request(h.ReconcilePoisonShared).Code)
	require.Equal(t, 503, request(h.BackfillPoisonShared).Code)
}
