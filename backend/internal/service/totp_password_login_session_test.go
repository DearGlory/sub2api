//go:build unit

package service

import (
	"context"
	"encoding/base64"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type passwordLoginEnvelopeEncryptor struct {
	fail bool
}

func (e *passwordLoginEnvelopeEncryptor) Encrypt(plaintext string) (string, error) {
	if e.fail {
		return "", errors.New("encrypt failed")
	}
	return base64.RawStdEncoding.EncodeToString([]byte(plaintext)), nil
}

func (e *passwordLoginEnvelopeEncryptor) Decrypt(ciphertext string) (string, error) {
	decoded, err := base64.RawStdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}
	return string(decoded), nil
}

type passwordLoginSessionCache struct {
	TotpCache
	token   string
	session *TotpLoginSession
}

func (c *passwordLoginSessionCache) SetLoginSession(_ context.Context, token string, session *TotpLoginSession, _ time.Duration) error {
	c.token = token
	c.session = session
	return nil
}

func TestCreateAndRecoverPasswordLoginSessionKeepsCacheValueEncryptedAndBound(t *testing.T) {
	cache := &passwordLoginSessionCache{}
	svc := NewTotpService(nil, &passwordLoginEnvelopeEncryptor{}, cache, nil, nil, nil)

	const (
		userID       int64 = 42
		password           = "synthetic-password"
		passwordHash       = "$argon2id$v=19$m=19456,t=2,p=1$synthetic"
	)
	token, err := svc.CreatePasswordLoginSession(context.Background(), userID, "user@example.com", password, passwordHash)
	require.NoError(t, err)
	require.NotEmpty(t, token)
	require.NotNil(t, cache.session)
	require.False(t, strings.Contains(cache.session.PasswordLoginEnvelope, password), "handoff exposed the password")
	require.False(t, strings.Contains(cache.session.PasswordLoginEnvelope, passwordHash), "handoff exposed the hash")

	recovered, err := svc.RecoverPasswordLoginSession(context.Background(), token, cache.session, userID, passwordHash)
	require.NoError(t, err)
	require.True(t, password == recovered, "handoff did not preserve exact password bytes")

	_, err = svc.RecoverPasswordLoginSession(context.Background(), token+"-wrong", cache.session, userID, passwordHash)
	require.Error(t, err)
	_, err = svc.RecoverPasswordLoginSession(context.Background(), token, cache.session, userID, passwordHash+"-changed")
	require.Error(t, err)
}

func TestCreatePasswordLoginSessionEncryptionFailureDoesNotCreateSession(t *testing.T) {
	cache := &passwordLoginSessionCache{}
	svc := NewTotpService(nil, &passwordLoginEnvelopeEncryptor{fail: true}, cache, nil, nil, nil)

	_, err := svc.CreatePasswordLoginSession(context.Background(), 42, "user@example.com", "synthetic-password", "hash")
	require.Error(t, err)
	require.Nil(t, cache.session)
}

func TestRecoverPasswordLoginSessionRejectsExpiredEnvelope(t *testing.T) {
	cache := &passwordLoginSessionCache{}
	svc := NewTotpService(nil, &passwordLoginEnvelopeEncryptor{}, cache, nil, nil, nil)

	token, err := svc.CreatePasswordLoginSession(context.Background(), 42, "user@example.com", "synthetic-password", "hash")
	require.NoError(t, err)
	cache.session.TokenExpiry = time.Now().Add(-time.Second)
	_, err = svc.RecoverPasswordLoginSession(context.Background(), token, cache.session, 42, "hash")
	require.Error(t, err)
	require.True(t, strings.Contains(err.Error(), "unavailable"))
}
