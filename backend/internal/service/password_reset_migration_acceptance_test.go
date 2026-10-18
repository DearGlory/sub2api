//go:build unit

package service

import (
	"context"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"
)

func TestPasswordMigrationAcceptance_ResetWritesArgon2idAndConsumesToken(t *testing.T) {
	ctx := context.Background()
	const oldPassword = "synthetic-old-password"
	const resetToken = "synthetic-one-time-reset-token"
	oldHash, err := bcrypt.GenerateFromPassword([]byte(oldPassword), bcrypt.MinCost)
	if err != nil {
		t.Fatal("legacy fixture failed")
	}
	user := &User{ID: 41, Email: "reset-acceptance@example.com", Status: StatusActive, Role: RoleUser, PasswordHash: string(oldHash)}
	repo := &userRepoStub{user: user}
	cache := &resetTokenCacheStub{stored: &PasswordResetTokenData{Token: hashPasswordResetToken(resetToken)}}
	auth := newAuthService(repo, map[string]string{
		SettingKeyPasswordResetEnabled: "true",
		SettingKeyEmailVerifyEnabled:   "true",
	}, cache, nil)
	newPassword := strings.Repeat("界", 40)
	if err := auth.ResetPassword(ctx, user.Email, resetToken, newPassword); err != nil {
		t.Fatal("native reset-password rejected a long Unicode password")
	}
	if len(repo.updated) != 1 || !strings.HasPrefix(repo.user.PasswordHash, "$argon2id$") {
		t.Fatal("native reset-password did not write Argon2id")
	}
	if !auth.CheckPassword(newPassword, repo.user.PasswordHash) || auth.CheckPassword(oldPassword, repo.user.PasswordHash) {
		t.Fatal("reset password verification semantics are incorrect")
	}
	if err := auth.ResetPassword(ctx, user.Email, resetToken, newPassword); err == nil {
		t.Fatal("used password-reset token was accepted twice")
	}
}
