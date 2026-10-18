//go:build unit

package service_test

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/service"
	"golang.org/x/crypto/bcrypt"
)

func TestPasswordMigrationAcceptance_RegisterLoginAndChange(t *testing.T) {
	auth, repo, _ := newAuthServiceWithEnt(t, map[string]string{
		service.SettingKeyRegistrationEnabled: "true",
	}, nil)
	ctx := context.Background()
	const initialPassword = "short6"
	_, user, err := auth.Register(ctx, "password-acceptance@example.com", initialPassword)
	if err != nil {
		t.Fatal("native registration failed")
	}
	if !strings.HasPrefix(user.PasswordHash, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatal("native registration did not write the source-compatible Argon2id format")
	}
	before, err := repo.GetByID(ctx, user.ID)
	if err != nil {
		t.Fatal("registered user was not available through the repository")
	}
	initialHash := before.PasswordHash
	firstToken, _, err := auth.Login(ctx, user.Email, initialPassword)
	if err != nil || firstToken == "" {
		t.Fatal("native login rejected the newly registered password")
	}
	firstClaims, err := auth.ValidateToken(firstToken)
	if err != nil {
		t.Fatal("native login returned an invalid access token")
	}
	for i := 0; i < 2; i++ {
		token, _, loginErr := auth.Login(ctx, user.Email, initialPassword)
		if loginErr != nil || token == "" {
			t.Fatal("repeat login failed")
		}
		claims, tokenErr := auth.ValidateToken(token)
		if tokenErr != nil || claims.TokenVersion != firstClaims.TokenVersion {
			t.Fatal("repeat login changed the session credential version")
		}
	}
	after, err := repo.GetByID(ctx, user.ID)
	if err != nil || after.PasswordHash != initialHash {
		t.Fatal("login silently mutated the stored password hash")
	}
	users := service.NewUserService(repo, nil, nil, nil)
	newPassword := strings.Repeat("界", 40)
	if err := users.ChangePassword(ctx, user.ID, service.ChangePasswordRequest{
		CurrentPassword: initialPassword,
		NewPassword:     newPassword,
	}); err != nil {
		t.Fatal("native change-password rejected a long Unicode password")
	}
	changed, err := repo.GetByID(ctx, user.ID)
	if err != nil || !strings.HasPrefix(changed.PasswordHash, "$argon2id$") {
		t.Fatal("native change-password did not persist Argon2id")
	}
	if changed.PasswordHash == initialHash {
		t.Fatal("password change left the original hash unchanged")
	}
	if _, _, err := auth.Login(ctx, user.Email, initialPassword); err == nil {
		t.Fatal("the old password still authenticates after password change")
	}
	newToken, _, err := auth.Login(ctx, user.Email, newPassword)
	if err != nil || newToken == "" {
		t.Fatal("the new long password failed native login")
	}
	newClaims, err := auth.ValidateToken(newToken)
	if err != nil || newClaims.TokenVersion == firstClaims.TokenVersion {
		t.Fatal("password change did not advance the session credential version")
	}
}

func TestPasswordMigrationAcceptance_LegacyBcryptConcurrentLoginDoesNotRehash(t *testing.T) {
	auth, repo, client := newAuthServiceWithEnt(t, nil, nil)
	ctx := context.Background()
	const password = "synthetic-legacy-password"
	legacyHash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal("synthetic legacy fixture could not be created")
	}
	user, err := client.User.Create().SetEmail("legacy-password-acceptance@example.com").
		SetPasswordHash(string(legacyHash)).SetRole(service.RoleUser).
		SetStatus(service.StatusActive).SetBalance(1).SetConcurrency(1).Save(ctx)
	if err != nil {
		t.Fatal("legacy user fixture could not be created")
	}
	results := make(chan bool, 8)
	var wg sync.WaitGroup
	for i := 0; i < cap(results); i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, loggedIn, err := auth.Login(ctx, user.Email, password)
			results <- err == nil && token != "" && loggedIn != nil && loggedIn.ID == user.ID
		}()
	}
	wg.Wait()
	close(results)
	for ok := range results {
		if !ok {
			t.Fatal("concurrent native legacy login failed")
		}
	}
	stored, err := repo.GetByID(ctx, user.ID)
	if err != nil || stored.PasswordHash != string(legacyHash) {
		t.Fatal("concurrent legacy login changed the stored hash")
	}
	if _, _, err := auth.Login(ctx, user.Email, "incorrect-synthetic-password"); err == nil {
		t.Fatal("incorrect password was accepted")
	}
}
