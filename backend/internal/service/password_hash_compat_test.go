package service

import (
	"strings"
	"testing"

	"github.com/Wei-Shaw/sub2api/internal/pkg/accountpassword"
	"golang.org/x/crypto/bcrypt"
)

func TestUserPasswordUsesArgon2idAndKeepsLegacyBcryptCompatibility(t *testing.T) {
	password := strings.Repeat("界", 40)
	user := &User{}

	if err := user.SetPassword(password); err != nil {
		t.Fatalf("SetPassword() error = %v", err)
	}
	if !strings.HasPrefix(user.PasswordHash, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatal("SetPassword() did not write the required Argon2id parameter set")
	}
	if !user.CheckPassword(password) {
		t.Fatal("CheckPassword() rejected the Argon2id password")
	}

	legacy, err := bcrypt.GenerateFromPassword([]byte("legacy-password"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("bcrypt.GenerateFromPassword() error = %v", err)
	}
	legacyEncoded := string(legacy)
	user.PasswordHash = legacyEncoded
	if !user.CheckPassword("legacy-password") {
		t.Fatal("CheckPassword() rejected the legacy bcrypt password")
	}
	if user.PasswordHash != legacyEncoded {
		t.Fatal("CheckPassword() changed the legacy password hash")
	}
}

func TestUserAndAuthServicePasswordMethodsKeepSixCharacterPasswords(t *testing.T) {
	const password = "123456"

	user := &User{}
	if err := user.SetPassword(password); err != nil {
		t.Fatal("User.SetPassword() rejected a six-character password")
	}
	if !user.CheckPassword(password) {
		t.Fatal("User.CheckPassword() rejected a six-character password")
	}

	service := &AuthService{}
	hashed, err := service.HashPassword(password)
	if err != nil {
		t.Fatal("AuthService.HashPassword() rejected a six-character password")
	}
	if !service.CheckPassword(password, hashed) {
		t.Fatal("AuthService.CheckPassword() rejected a six-character password")
	}
}

func TestAuthServicePasswordMethodsUseArgon2idAndKeepLegacyBcryptCompatibility(t *testing.T) {
	password := strings.Repeat("界", 40)
	service := &AuthService{}

	hashed, err := service.HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword() error = %v", err)
	}
	if !strings.HasPrefix(hashed, "$argon2id$v=19$m=19456,t=2,p=1$") {
		t.Fatal("HashPassword() did not write the required Argon2id parameter set")
	}
	if !service.CheckPassword(password, hashed) {
		t.Fatal("CheckPassword() rejected the Argon2id password")
	}

	legacy, err := bcrypt.GenerateFromPassword([]byte("legacy-password"), bcrypt.DefaultCost)
	if err != nil {
		t.Fatalf("bcrypt.GenerateFromPassword() error = %v", err)
	}
	if !service.CheckPassword("legacy-password", string(legacy)) {
		t.Fatal("CheckPassword() rejected the legacy bcrypt password")
	}
}

func TestAuthServiceCheckPasswordAcceptsAccountPasswordArgon2id(t *testing.T) {
	hashed, err := accountpassword.Hash("account-password")
	if err != nil {
		t.Fatalf("accountpassword.Hash() error = %v", err)
	}
	if !(&AuthService{}).CheckPassword("account-password", hashed) {
		t.Fatal("AuthService.CheckPassword() rejected accountpassword Argon2id")
	}
}
