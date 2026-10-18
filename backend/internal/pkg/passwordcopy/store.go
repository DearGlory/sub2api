// Package passwordcopy stores high-risk plaintext password copies in a
// separately configured, permission-restricted local directory. The contents
// are deliberately unencrypted by administrator request; callers must keep
// the directory on a host with suitable operational access controls.
package passwordcopy

import (
	"bytes"
	"strconv"
	"time"
)

// Config controls the local password-copy store.
type Config struct {
	// Enabled controls whether the store has any filesystem side effects.
	Enabled bool
	// Directory is the absolute private directory used for per-user records.
	Directory string
}

// DefaultConfig returns the enabled configuration for a supplied directory.
func DefaultConfig(directory string) Config {
	return Config{Enabled: true, Directory: directory}
}

// Fixed errors intentionally contain no path, record, or password data.
var (
	ErrInvalidConfiguration = errorString("passwordcopy: invalid configuration")
	ErrInvalidUserID        = errorString("passwordcopy: invalid user id")
	ErrUnsafeDirectory      = errorString("passwordcopy: unsafe directory")
	ErrUnsafeRecord         = errorString("passwordcopy: unsafe record")
	ErrFilesystem           = errorString("passwordcopy: filesystem operation failed")
	ErrClosed               = errorString("passwordcopy: store is closed")
	ErrInvalidContext       = errorString("passwordcopy: invalid context")
	ErrRestrictedPlatform   = errorString("passwordcopy: restricted platform")
	ErrRecordMissing        = errorString("passwordcopy: record missing")
)

// errorString keeps the exported error values fixed and allocation-free at
// call sites. It is intentionally a private implementation of error.
type errorString string

func (e errorString) Error() string { return string(e) }

func encodeRecord(userID int64, savedAt time.Time, password string) []byte {
	passwordBytes := []byte(password)
	var record bytes.Buffer
	record.Grow(64 + len(passwordBytes))
	_, _ = record.WriteString(strconv.FormatInt(userID, 10))
	_ = record.WriteByte('\n')
	_, _ = record.WriteString(strconv.FormatInt(savedAt.UnixNano(), 10))
	_ = record.WriteByte('\n')
	_, _ = record.WriteString(strconv.Itoa(len(passwordBytes)))
	_ = record.WriteByte('\n')
	_, _ = record.Write(passwordBytes)
	return record.Bytes()
}
