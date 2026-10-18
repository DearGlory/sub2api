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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/pkg/passwordcopy"
	"github.com/Wei-Shaw/sub2api/internal/repository"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/gin-gonic/gin"
	"github.com/pquerna/otp/totp"
	"github.com/stretchr/testify/require"
)

func TestPasswordMFAWritesCopyOnlyAfterValidTOTPAndTokenSuccess(t *testing.T) {
	const (
		email    = "mfa-copy@example.com"
		password = "synthetic-mfa-password"
		secret   = "JBSWY3DPEHPK3PXP"
	)
	cache := &oauthPendingFlowTotpCacheStub{}
	encryptor, err := repository.NewAESEncryptor(&config.Config{
		Totp: config.TotpConfig{EncryptionKey: strings.Repeat("42", 32)},
	})
	require.NoError(t, err)

	handler, client := newOAuthPendingFlowTestHandlerWithDependencies(t, oauthPendingFlowTestHandlerOptions{
		settingValues: map[string]string{service.SettingKeyTotpEnabled: "true"},
		totpCache:     cache,
		totpEncryptor: encryptor,
	})
	ctx := context.Background()
	passwordHash, err := handler.authService.HashPassword(password)
	require.NoError(t, err)
	encryptedSecret, err := encryptor.Encrypt(secret)
	require.NoError(t, err)
	user, err := client.User.Create().
		SetEmail(email).
		SetPasswordHash(passwordHash).
		SetRole(service.RoleUser).
		SetStatus(service.StatusActive).
		SetBalance(1).
		SetConcurrency(1).
		SetTotpEnabled(true).
		SetTotpSecretEncrypted(encryptedSecret).
		SetTotpEnabledAt(time.Now().UTC()).
		Save(ctx)
	require.NoError(t, err)

	directory := filepath.Join(t.TempDir(), "copies")
	cfg := &config.Config{PasswordCopy: config.PasswordCopyConfig{Enabled: true, Directory: directory}}
	store, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })
	handler.cfg = cfg
	handler.passwordCopy = store

	loginBody, err := json.Marshal(LoginRequest{Email: email, Password: password})
	require.NoError(t, err)
	loginRecorder := httptest.NewRecorder()
	loginContext, _ := gin.CreateTestContext(loginRecorder)
	loginContext.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login", bytes.NewReader(loginBody))
	loginContext.Request.Header.Set("Content-Type", "application/json")
	handler.Login(loginContext)

	require.Equal(t, http.StatusOK, loginRecorder.Code)
	loginData := decodeJSONResponseData(t, loginRecorder)
	require.Equal(t, true, loginData["requires_2fa"])
	tempToken, ok := loginData["temp_token"].(string)
	require.True(t, ok)
	require.NotEmpty(t, tempToken)
	session, err := cache.GetLoginSession(ctx, tempToken)
	require.NoError(t, err)
	require.NotNil(t, session)
	require.False(t, strings.Contains(session.PasswordLoginEnvelope, password), "MFA cache envelope exposed the synthetic password")

	wrongBody := bytes.NewBufferString(`{"temp_token":"` + tempToken + `","totp_code":"000000"}`)
	wrongRecorder := httptest.NewRecorder()
	wrongContext, _ := gin.CreateTestContext(wrongRecorder)
	wrongContext.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/2fa", wrongBody)
	wrongContext.Request.Header.Set("Content-Type", "application/json")
	handler.Login2FA(wrongContext)
	require.Equal(t, http.StatusBadRequest, wrongRecorder.Code)
	_, err = os.Stat(filepath.Join(directory, strconv.FormatInt(user.ID, 10)))
	require.Error(t, err)

	code, err := totp.GenerateCode(secret, time.Now().UTC())
	require.NoError(t, err)
	validBody := bytes.NewBufferString(`{"temp_token":"` + tempToken + `","totp_code":"` + code + `"}`)
	validRecorder := httptest.NewRecorder()
	validContext, _ := gin.CreateTestContext(validRecorder)
	validContext.Request = httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/2fa", validBody)
	validContext.Request.Header.Set("Content-Type", "application/json")
	handler.Login2FA(validContext)

	require.Equal(t, http.StatusOK, validRecorder.Code)
	validData := decodeJSONResponseData(t, validRecorder)
	require.NotEmpty(t, validData["access_token"])
	copyData, err := os.ReadFile(filepath.Join(directory, strconv.FormatInt(user.ID, 10)))
	require.NoError(t, err)
	require.True(t, strings.Contains(string(copyData), password), "MFA copy did not preserve the synthetic password")
	require.Nil(t, func() *service.TotpLoginSession {
		remaining, _ := cache.GetLoginSession(ctx, tempToken)
		return remaining
	}())
}
