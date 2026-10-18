//go:build unit

package repository

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/config"
	"github.com/Wei-Shaw/sub2api/internal/service"
	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestPasswordCopyMFAAcrossInstancesAndAtomicConsumption(t *testing.T) {
	server := miniredis.RunT(t)
	clientA := redis.NewClient(&redis.Options{Addr: server.Addr()})
	clientB := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = clientA.Close(); _ = clientB.Close() })
	cfg := &config.Config{Totp: config.TotpConfig{EncryptionKey: strings.Repeat("42", 32)}}
	encryptorA, err := NewAESEncryptor(cfg)
	if err != nil {
		t.Fatal("first encryptor initialization failed")
	}
	encryptorB, err := NewAESEncryptor(cfg)
	if err != nil {
		t.Fatal("second encryptor initialization failed")
	}
	cacheA := NewTotpCache(clientA)
	cacheB := NewTotpCache(clientB)
	a := service.NewTotpService(nil, encryptorA, cacheA, nil, nil, nil)
	b := service.NewTotpService(nil, encryptorB, cacheB, nil, nil, nil)
	ctx := context.Background()
	const password = "synthetic-cross-instance-password"
	const hash = "synthetic-credential-fingerprint-input"
	token, err := a.CreatePasswordLoginSession(ctx, 42, "synthetic@example.invalid", password, hash)
	if err != nil {
		t.Fatal("password login session creation failed")
	}
	raw, err := server.Get(totpLoginKeyPrefix + token)
	if err != nil || strings.Contains(raw, password) || strings.Contains(raw, hash) {
		t.Fatal("cache did not contain an encrypted password handoff")
	}
	session, err := b.GetLoginSession(ctx, token)
	if err != nil || session == nil {
		t.Fatal("second instance could not load the session")
	}
	recovered, err := b.RecoverPasswordLoginSession(ctx, token, session, 42, hash)
	if err != nil || recovered != password {
		t.Fatal("cross-instance encrypted handoff failed")
	}
	var wins, failures atomic.Int32
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			svc := a
			if i%2 == 1 {
				svc = b
			}
			got, err := svc.ConsumeLoginSession(ctx, token)
			if err != nil {
				failures.Add(1)
				return
			}
			if got != nil {
				wins.Add(1)
			}
		}(i)
	}
	wg.Wait()
	if failures.Load() != 0 || wins.Load() != 1 {
		t.Fatal("MFA session was not consumed exactly once")
	}
	if server.Exists(totpLoginKeyPrefix + token) {
		t.Fatal("consumed session remained in cache")
	}
}

func TestPasswordCopyMFAExpirationTamperingAndCredentialBinding(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	encryptor, err := NewAESEncryptor(&config.Config{Totp: config.TotpConfig{EncryptionKey: strings.Repeat("43", 32)}})
	if err != nil {
		t.Fatal("encryptor initialization failed")
	}
	cache := NewTotpCache(client)
	svc := service.NewTotpService(nil, encryptor, cache, nil, nil, nil)
	ctx := context.Background()
	token, err := svc.CreatePasswordLoginSession(ctx, 42, "synthetic@example.invalid", "synthetic-password", "synthetic-hash")
	if err != nil {
		t.Fatal("session creation failed")
	}
	session, err := svc.GetLoginSession(ctx, token)
	if err != nil || session == nil {
		t.Fatal("session loading failed")
	}
	for _, tt := range []struct {
		name, token, hash string
		uid               int64
	}{
		{"wrong_user", token, "synthetic-hash", 43},
		{"wrong_session", token + "-wrong", "synthetic-hash", 42},
		{"changed_password", token, "changed-hash", 42},
	} {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := svc.RecoverPasswordLoginSession(ctx, tt.token, session, tt.uid, tt.hash); err == nil {
				t.Fatal("mismatched handoff binding accepted")
			}
		})
	}
	tampered := *session
	ciphertext := []byte(tampered.PasswordLoginEnvelope)
	if ciphertext[0] == 'A' {
		ciphertext[0] = 'B'
	} else {
		ciphertext[0] = 'A'
	}
	tampered.PasswordLoginEnvelope = string(ciphertext)
	if _, err := svc.RecoverPasswordLoginSession(ctx, token, &tampered, 42, "synthetic-hash"); err == nil {
		t.Fatal("tampered authenticated ciphertext accepted")
	}
	server.FastForward(6 * time.Minute)
	if got, err := svc.ConsumeLoginSession(ctx, token); err != nil || got != nil {
		t.Fatal("expired session was consumable")
	}
}

func TestPasswordCopyMFALongEscapedPasswordFitsCodecLimit(t *testing.T) {
	server := miniredis.RunT(t)
	client := redis.NewClient(&redis.Options{Addr: server.Addr()})
	t.Cleanup(func() { _ = client.Close() })
	encryptor, err := NewAESEncryptor(&config.Config{Totp: config.TotpConfig{EncryptionKey: strings.Repeat("44", 32)}})
	if err != nil {
		t.Fatal("encryptor initialization failed")
	}
	svc := service.NewTotpService(nil, encryptor, NewTotpCache(client), nil, nil, nil)
	password := strings.Repeat("\x00", 1<<20)
	token, err := svc.CreatePasswordLoginSession(context.Background(), 42, "synthetic@example.invalid", password, "synthetic-hash")
	if err != nil {
		t.Fatal("MFA handoff rejected a password within the codec limit")
	}
	session, err := svc.GetLoginSession(context.Background(), token)
	if err != nil || session == nil {
		t.Fatal("MFA handoff could not be loaded")
	}
	recovered, err := svc.RecoverPasswordLoginSession(context.Background(), token, session, 42, "synthetic-hash")
	if err != nil || recovered != password {
		t.Fatal("MFA handoff failed to preserve exact password bytes")
	}
}
