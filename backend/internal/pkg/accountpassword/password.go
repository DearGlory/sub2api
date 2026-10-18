// Package accountpassword hashes new account passwords with Argon2id and verifies
// both the current Argon2id format and legacy bcrypt hashes.
package accountpassword

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/crypto/bcrypt"
)

const (
	argon2Memory    uint32 = 19 * 1024
	argon2Time      uint32 = 2
	argon2Threads   uint8  = 1
	argon2SaltBytes        = 16
	argon2KeyBytes         = 32
	maxEncodedBytes        = 256
	// MaxPasswordBytes bounds resource use without imposing a new public
	// minimum or a legacy bcrypt-sized maximum on account passwords.
	MaxPasswordBytes = 1 << 20
)

var errPasswordTooLarge = errors.New("account password exceeds the resource limit")

// Hash creates a new Argon2id PHC encoded account-password hash.
// Password bytes are passed to the KDF unchanged; no trimming or normalization
// is performed.
func Hash(password string) (string, error) {
	if err := validateNewPassword(password); err != nil {
		return "", err
	}

	salt := make([]byte, argon2SaltBytes)
	if _, err := rand.Read(salt); err != nil {
		return "", fmt.Errorf("generate account password salt: %w", err)
	}
	key := argon2.IDKey([]byte(password), salt, argon2Time, argon2Memory, argon2Threads, argon2KeyBytes)
	return fmt.Sprintf(
		"$argon2id$v=19$m=19456,t=2,p=1$%s$%s",
		base64.RawStdEncoding.EncodeToString(salt),
		base64.RawStdEncoding.EncodeToString(key),
	), nil
}

// Verify checks an account password against an Argon2id or legacy bcrypt hash.
// Authentication does not apply new-password minimum/maximum policy, but it
// rejects invalid input before invoking the Argon2id KDF when it exceeds the
// bounded source-password size.
func Verify(password, encoded string) bool {
	if len(password) > MaxPasswordBytes || len(encoded) > maxEncodedBytes {
		return false
	}

	switch {
	case strings.HasPrefix(encoded, "$argon2id$"):
		return verifyArgon2id(password, encoded)
	default:
		// Preserve every format and work factor accepted by the native bcrypt reader.
		return bcrypt.CompareHashAndPassword([]byte(encoded), []byte(password)) == nil
	}
}

func validateNewPassword(password string) error {
	if len(password) > MaxPasswordBytes {
		return errPasswordTooLarge
	}
	return nil
}

func verifyArgon2id(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "" || parts[1] != "argon2id" || parts[2] != "v=19" || parts[3] != "m=19456,t=2,p=1" {
		return false
	}

	salt, err := base64.RawStdEncoding.Strict().DecodeString(parts[4])
	if err != nil || len(salt) != argon2SaltBytes {
		return false
	}
	expected, err := base64.RawStdEncoding.Strict().DecodeString(parts[5])
	if err != nil || len(expected) != argon2KeyBytes {
		return false
	}

	actual := argon2.IDKey([]byte(password), salt, argon2Time, argon2Memory, argon2Threads, argon2KeyBytes)
	return subtle.ConstantTimeCompare(actual, expected) == 1
}
