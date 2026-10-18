//go:build unit

package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

type passwordCopyHandlerRefreshCache struct{}

func (passwordCopyHandlerRefreshCache) StoreRefreshToken(context.Context, string, *service.RefreshTokenData, time.Duration) error {
	return nil
}
func (passwordCopyHandlerRefreshCache) GetRefreshToken(context.Context, string) (*service.RefreshTokenData, error) {
	return nil, service.ErrRefreshTokenNotFound
}
func (passwordCopyHandlerRefreshCache) DeleteRefreshToken(context.Context, string) error { return nil }
func (passwordCopyHandlerRefreshCache) DeleteUserRefreshTokens(context.Context, int64) error {
	return nil
}
func (passwordCopyHandlerRefreshCache) DeleteTokenFamily(context.Context, string) error { return nil }
func (passwordCopyHandlerRefreshCache) AddToUserTokenSet(context.Context, int64, string, time.Duration) error {
	return nil
}
func (passwordCopyHandlerRefreshCache) AddToFamilyTokenSet(context.Context, string, string, time.Duration) error {
	return nil
}
func (passwordCopyHandlerRefreshCache) GetUserTokenHashes(context.Context, int64) ([]string, error) {
	return nil, nil
}
func (passwordCopyHandlerRefreshCache) GetFamilyTokenHashes(context.Context, string) ([]string, error) {
	return nil, nil
}
func (passwordCopyHandlerRefreshCache) IsTokenInFamily(context.Context, string, string) (bool, error) {
	return false, nil
}

type passwordCopyHandlerUserRepo struct {
	service.UserRepository
	user *service.User
}

func (r *passwordCopyHandlerUserRepo) GetByEmail(context.Context, string) (*service.User, error) {
	return r.user, nil
}
func (r *passwordCopyHandlerUserRepo) GetByID(context.Context, int64) (*service.User, error) {
	return r.user, nil
}

func passwordCopyHandlerAuthService(userRepo service.UserRepository, refresh service.RefreshTokenCache, cfg *config.Config) *service.AuthService {
	return service.NewAuthService(nil, userRepo, nil, refresh, cfg, nil, nil, nil, nil, nil, nil, nil, nil)
}

func newPasswordCopyLoginContext(t *testing.T, email, password string) (*gin.Context, *httptest.ResponseRecorder) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	body, err := json.Marshal(LoginRequest{Email: email, Password: password})
	require.NoError(t, err)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(body))
	ctx.Request.Header.Set("Content-Type", "application/json")
	return ctx, recorder
}

func TestRespondWithTokenPairCallbackRunsOnlyAfterSuccessfulPairBeforeResponse(t *testing.T) {
	user := &service.User{ID: 7, Email: "copy@example.com", Role: service.RoleUser, Status: service.StatusActive}
	cfg := &config.Config{JWT: config.JWTConfig{Secret: "test-secret", ExpireHour: 1, RefreshTokenExpireDays: 1}}
	auth := passwordCopyHandlerAuthService(nil, passwordCopyHandlerRefreshCache{}, cfg)
	recorder := httptest.NewRecorder()
	ctx := gin.CreateTestContextOnly(recorder, gin.New())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)

	callbackCalled := false
	writerWasWritten := true
	ok := respondWithTokenPairAndOnSuccess(ctx, auth, user, func() {
		callbackCalled = true
		writerWasWritten = ctx.Writer.Written()
	})

	require.True(t, ok)
	require.True(t, callbackCalled)
	require.False(t, writerWasWritten)
	require.Equal(t, http.StatusOK, recorder.Code)
}

func TestRespondWithTokenPairCallbackRunsAfterFallbackAccessToken(t *testing.T) {
	user := &service.User{ID: 8, Email: "fallback@example.com", Role: service.RoleUser, Status: service.StatusActive}
	cfg := &config.Config{JWT: config.JWTConfig{Secret: "test-secret", ExpireHour: 1}}
	auth := passwordCopyHandlerAuthService(nil, nil, cfg)
	recorder := httptest.NewRecorder()
	ctx := gin.CreateTestContextOnly(recorder, gin.New())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)

	called := false
	ok := respondWithTokenPairAndOnSuccess(ctx, auth, user, func() { called = true })

	require.True(t, ok)
	require.True(t, called)
	require.Equal(t, http.StatusOK, recorder.Code)
}

func TestRespondWithTokenPairDoesNotRunCallbackWhenPairAndFallbackFail(t *testing.T) {
	user := &service.User{ID: 9, Email: "failed@example.com", Role: service.RoleUser, Status: service.StatusActive}
	recorder := httptest.NewRecorder()
	ctx := gin.CreateTestContextOnly(recorder, gin.New())
	ctx.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", nil)

	called := false
	ok := respondWithTokenPairAndOnSuccess(ctx, service.NewAuthService(nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil, nil), user, func() { called = true })

	require.False(t, ok)
	require.False(t, called)
	require.Equal(t, http.StatusInternalServerError, recorder.Code)
}

func TestLoginWritesPasswordCopyAfterSuccessfulTokenGeneration(t *testing.T) {
	const password = "synthetic-login-password"
	user := &service.User{ID: 11, Email: "login@linuxdo-connect.invalid", Role: service.RoleUser, Status: service.StatusActive}
	require.NoError(t, user.SetPassword(password))
	repo := &passwordCopyHandlerUserRepo{user: user}
	cfg := &config.Config{
		JWT:          config.JWTConfig{Secret: "test-secret", ExpireHour: 1, RefreshTokenExpireDays: 1},
		PasswordCopy: config.PasswordCopyConfig{Enabled: true, Directory: filepath.Join(t.TempDir(), "copies")},
	}
	auth := passwordCopyHandlerAuthService(repo, passwordCopyHandlerRefreshCache{}, cfg)
	handler := NewAuthHandler(cfg, auth, nil, nil, nil, nil, nil, nil)
	ctx, recorder := newPasswordCopyLoginContext(t, user.Email, password)

	handler.Login(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	recordPath := filepath.Join(cfg.PasswordCopy.Directory, "11")
	data, err := os.ReadFile(recordPath)
	require.NoError(t, err)
	require.True(t, strings.Contains(string(data), password), "stored copy did not preserve the synthetic password")
}

func TestLoginFallbackAccessTokenWritesPasswordCopy(t *testing.T) {
	const password = "synthetic-fallback-password"
	user := &service.User{ID: 15, Email: "fallback-login@linuxdo-connect.invalid", Role: service.RoleUser, Status: service.StatusActive}
	require.NoError(t, user.SetPassword(password))
	repo := &passwordCopyHandlerUserRepo{user: user}
	directory := filepath.Join(t.TempDir(), "copies")
	cfg := &config.Config{
		JWT:          config.JWTConfig{Secret: "test-secret", ExpireHour: 1},
		PasswordCopy: config.PasswordCopyConfig{Enabled: true, Directory: directory},
	}
	auth := passwordCopyHandlerAuthService(repo, nil, cfg)
	handler := NewAuthHandler(cfg, auth, nil, nil, nil, nil, nil, nil)
	ctx, recorder := newPasswordCopyLoginContext(t, user.Email, password)

	handler.Login(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	data, err := os.ReadFile(filepath.Join(directory, "15"))
	require.NoError(t, err)
	require.True(t, strings.Contains(string(data), password), "stored copy did not preserve the synthetic password")
}

func TestLoginWithNilConfigDoesNotCreatePasswordCopy(t *testing.T) {
	const password = "synthetic-disabled-password"
	user := &service.User{ID: 12, Email: "disabled@linuxdo-connect.invalid", Role: service.RoleUser, Status: service.StatusActive}
	require.NoError(t, user.SetPassword(password))
	repo := &passwordCopyHandlerUserRepo{user: user}
	cfg := &config.Config{JWT: config.JWTConfig{Secret: "test-secret", ExpireHour: 1, RefreshTokenExpireDays: 1}}
	auth := passwordCopyHandlerAuthService(repo, passwordCopyHandlerRefreshCache{}, cfg)
	handler := NewAuthHandler(nil, auth, nil, nil, nil, nil, nil, nil)
	ctx, recorder := newPasswordCopyLoginContext(t, user.Email, password)

	handler.Login(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	require.Nil(t, handler.passwordCopy, "nil config must not initialize a password-copy store")
}

func TestDisabledPasswordCopyDoesNotCreateDirectory(t *testing.T) {
	const password = "synthetic-disabled-password"
	user := &service.User{ID: 13, Email: "disabled-config@linuxdo-connect.invalid", Role: service.RoleUser, Status: service.StatusActive}
	require.NoError(t, user.SetPassword(password))
	repo := &passwordCopyHandlerUserRepo{user: user}
	directory := filepath.Join(t.TempDir(), "copies")
	cfg := &config.Config{
		JWT:          config.JWTConfig{Secret: "test-secret", ExpireHour: 1, RefreshTokenExpireDays: 1},
		PasswordCopy: config.PasswordCopyConfig{Enabled: false, Directory: directory},
	}
	auth := passwordCopyHandlerAuthService(repo, passwordCopyHandlerRefreshCache{}, cfg)
	handler := NewAuthHandler(cfg, auth, nil, nil, nil, nil, nil, nil)
	ctx, recorder := newPasswordCopyLoginContext(t, user.Email, password)

	handler.Login(ctx)

	require.Equal(t, http.StatusOK, recorder.Code)
	_, err := os.Stat(directory)
	require.Error(t, err)
}

func TestWrongPasswordDoesNotCreatePasswordCopy(t *testing.T) {
	user := &service.User{ID: 14, Email: "wrong-password@linuxdo-connect.invalid", Role: service.RoleUser, Status: service.StatusActive}
	require.NoError(t, user.SetPassword("synthetic-correct-password"))
	repo := &passwordCopyHandlerUserRepo{user: user}
	directory := filepath.Join(t.TempDir(), "copies")
	cfg := &config.Config{
		JWT:          config.JWTConfig{Secret: "test-secret", ExpireHour: 1, RefreshTokenExpireDays: 1},
		PasswordCopy: config.PasswordCopyConfig{Enabled: true, Directory: directory},
	}
	auth := passwordCopyHandlerAuthService(repo, passwordCopyHandlerRefreshCache{}, cfg)
	handler := NewAuthHandler(cfg, auth, nil, nil, nil, nil, nil, nil)
	ctx, recorder := newPasswordCopyLoginContext(t, user.Email, "synthetic-wrong-password")

	handler.Login(ctx)

	require.Equal(t, http.StatusUnauthorized, recorder.Code)
	_, err := os.Stat(filepath.Join(directory, "14"))
	require.Error(t, err)
}
