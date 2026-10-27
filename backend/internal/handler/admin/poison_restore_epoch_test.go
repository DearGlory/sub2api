package admin

import (
	"context"
	"errors"
	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/poison"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
	"net/http/httptest"
	"testing"
)

type epochRecoveryRepo struct {
	service.AccountRepository
	marked bool
	called bool
}

func (r *epochRecoveryRepo) GetByID(context.Context, int64) (*service.Account, error) {
	return &service.Account{ID: 42, Status: service.StatusError}, nil
}
func (r *epochRecoveryRepo) ClearError(ctx context.Context, id int64) error {
	r.called = true
	r.marked = poison.IsAdminRestore(ctx)
	return errors.New("synthetic write failure")
}
func TestPoisonRestoreEpochRecoverStateWiring(t *testing.T) {
	repo := &epochRecoveryRepo{}
	rate := service.NewRateLimitService(repo, nil, &config.Config{}, nil, nil)
	h := &AccountHandler{rateLimitService: rate}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/api/v1/admin/accounts/42/recover-state", nil)
	c.Params = gin.Params{{Key: "id", Value: "42"}}
	h.RecoverState(c)
	require.True(t, repo.called)
	require.True(t, repo.marked)
	repo.called = false
	repo.marked = false
	_, err := rate.RecoverAccountAfterSuccessfulTest(context.Background(), 42)
	require.Error(t, err)
	require.True(t, repo.called)
	require.False(t, repo.marked, "automated recovery must not acquire admin intent")
}
