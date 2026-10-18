//go:build linux

package passwordcopy_test

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Wei-Shaw/sub2api/internal/pkg/passwordcopy"
)

func TestSaveCreatesRestrictedExactRecord(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	store, err := passwordcopy.New(passwordcopy.Config{
		Enabled:   true,
		Directory: directory,
	})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	const userID int64 = 42
	password := " leading\n秘密 \x00 trailing "
	before := time.Now()
	if err := store.Save(context.Background(), userID, password); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	after := time.Now()

	directoryInfo, err := os.Stat(directory)
	if err != nil {
		t.Fatalf("stat directory: %v", err)
	}
	if !directoryInfo.IsDir() || directoryInfo.Mode().Perm() != 0o700 {
		t.Fatalf("directory is not a private directory: isDir=%t mode=%#o", directoryInfo.IsDir(), directoryInfo.Mode().Perm())
	}

	path := filepath.Join(directory, strconv.FormatInt(userID, 10))
	fileInfo, err := os.Lstat(path)
	if err != nil {
		t.Fatalf("stat record: %v", err)
	}
	if !fileInfo.Mode().IsRegular() || fileInfo.Mode().Perm() != 0o600 {
		t.Fatalf("record is not a private regular file: regular=%t mode=%#o", fileInfo.Mode().IsRegular(), fileInfo.Mode().Perm())
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read record: %v", err)
	}
	recordedUID, savedAt, recordedPassword, err := parseRecord(data)
	if err != nil {
		t.Fatalf("parse record: %v", err)
	}
	if recordedUID != userID {
		t.Fatalf("recorded uid = %d, want %d", recordedUID, userID)
	}
	if !bytes.Equal(recordedPassword, []byte(password)) {
		t.Fatalf("recorded password bytes differ: got %d bytes, want %d bytes", len(recordedPassword), len(password))
	}
	if savedAt.Before(before) || savedAt.After(after) {
		t.Fatalf("saved time %s is outside save interval", savedAt.Format(time.RFC3339Nano))
	}
}

func TestNewRejectsDirectoryOwnedByAnotherUser(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root to create a foreign-owned test directory")
	}
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatalf("mkdir directory: %v", err)
	}
	if err := os.Chown(directory, 65534, -1); err != nil {
		t.Fatalf("chown directory: %v", err)
	}
	_, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if !errors.Is(err, passwordcopy.ErrUnsafeDirectory) {
		t.Fatalf("New error = %v, want ErrUnsafeDirectory", err)
	}
}

func TestSaveRejectsHardLinkedExistingRecord(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	store, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if err := store.Save(context.Background(), 42, "synthetic"); err != nil {
		t.Fatalf("initial Save returned error: %v", err)
	}
	recordPath := filepath.Join(directory, "42")
	linkPath := filepath.Join(directory, "linked-record")
	if err := os.Link(recordPath, linkPath); err != nil {
		t.Fatalf("hard link: %v", err)
	}
	if err := store.Save(context.Background(), 42, "replacement"); !errors.Is(err, passwordcopy.ErrUnsafeRecord) {
		t.Fatalf("Save error = %v, want ErrUnsafeRecord", err)
	}
}

func TestSaveRejectsSymlinkExistingRecordWithoutTouchingTarget(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	store, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	target := filepath.Join(root, "target")
	const original = "outside"
	if err := os.WriteFile(target, []byte(original), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(target, filepath.Join(directory, "42")); err != nil {
		t.Fatalf("symlink record: %v", err)
	}
	if err := store.Save(context.Background(), 42, "replacement"); !errors.Is(err, passwordcopy.ErrUnsafeRecord) {
		t.Fatalf("Save error = %v, want ErrUnsafeRecord", err)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read target: %v", err)
	}
	if string(data) != original {
		t.Fatalf("symlink target changed")
	}
}

func TestNewRejectsSymlinkDirectory(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatalf("mkdir target: %v", err)
	}
	directory := filepath.Join(root, "copies")
	if err := os.Symlink(target, directory); err != nil {
		t.Fatalf("symlink directory: %v", err)
	}
	_, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if !errors.Is(err, passwordcopy.ErrUnsafeDirectory) {
		t.Fatalf("New error = %v, want ErrUnsafeDirectory", err)
	}
}

func TestSaveRejectsExistingRecordWithUnsafePermissions(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	store, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	recordPath := filepath.Join(directory, "42")
	if err := os.WriteFile(recordPath, []byte("old"), 0o640); err != nil {
		t.Fatalf("write record: %v", err)
	}
	if err := store.Save(context.Background(), 42, "replacement"); !errors.Is(err, passwordcopy.ErrUnsafeRecord) {
		t.Fatalf("Save error = %v, want ErrUnsafeRecord", err)
	}
	info, err := os.Lstat(recordPath)
	if err != nil {
		t.Fatalf("stat record: %v", err)
	}
	if info.Mode().Perm() != 0o640 {
		t.Fatalf("existing record mode changed to %#o", info.Mode().Perm())
	}
}

func TestDisabledStoreHasNoFilesystemSideEffects(t *testing.T) {
	root := filepath.Join(t.TempDir(), "does-not-exist")
	store, err := passwordcopy.New(passwordcopy.Config{Enabled: false, Directory: root})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if err := store.Save(context.Background(), 42, "synthetic"); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	if err := store.Remove(context.Background(), 42); err != nil {
		t.Fatalf("Remove returned error: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("disabled store touched filesystem: stat error = %v", err)
	}
}

func TestSaveContextAndCloseErrorsDoNotWrite(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	store, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := store.Save(ctx, 42, "synthetic"); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Save error = %v, want context.Canceled", err)
	}
	if _, err := os.Lstat(filepath.Join(directory, "42")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("canceled Save wrote a record: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close returned error: %v", err)
	}
	if err := store.Save(context.Background(), 42, "synthetic"); !errors.Is(err, passwordcopy.ErrClosed) {
		t.Fatalf("closed Save error = %v, want ErrClosed", err)
	}
}

func TestSaveConcurrentInstancesLeaveOnlyLatestCompleteRecord(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	first, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if err != nil {
		t.Fatalf("first New returned error: %v", err)
	}
	second, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if err != nil {
		t.Fatalf("second New returned error: %v", err)
	}
	passwords := []string{"first-秘密\n", "second with spaces\t"}
	errs := make(chan error, len(passwords))
	go func() { errs <- first.Save(context.Background(), 42, passwords[0]) }()
	go func() { errs <- second.Save(context.Background(), 42, passwords[1]) }()
	for range passwords {
		if err := <-errs; err != nil {
			t.Fatalf("concurrent Save returned error: %v", err)
		}
	}
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read directory: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "42" {
		t.Fatalf("directory entries = %#v, want only record", entries)
	}
	data, err := os.ReadFile(filepath.Join(directory, "42"))
	if err != nil {
		t.Fatalf("read record: %v", err)
	}
	_, _, password, err := parseRecord(data)
	if err != nil {
		t.Fatalf("parse record: %v", err)
	}
	if string(password) != passwords[0] && string(password) != passwords[1] {
		t.Fatalf("record contains neither complete password")
	}
}

func TestRemoveDeletesRecordAndIsIdempotent(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	store, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if err := store.Save(context.Background(), 42, "synthetic"); err != nil {
		t.Fatalf("Save returned error: %v", err)
	}
	if err := store.Remove(context.Background(), 42); err != nil {
		t.Fatalf("Remove returned error: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(directory, "42")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("record still exists: %v", err)
	}
	if err := store.Remove(context.Background(), 42); err != nil {
		t.Fatalf("second Remove returned error: %v", err)
	}
}
func TestDefaultConfigIsEnabled(t *testing.T) {
	cfg := passwordcopy.DefaultConfig("/tmp/password-copies")
	if !cfg.Enabled || cfg.Directory != "/tmp/password-copies" {
		t.Fatalf("DefaultConfig = %#v, want enabled with supplied directory", cfg)
	}
}

func TestNewRejectsUnsafeFinalDirectoryPermissions(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "copies")
	if err := os.Mkdir(directory, 0o750); err != nil {
		t.Fatalf("mkdir directory: %v", err)
	}
	_, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: directory})
	if !errors.Is(err, passwordcopy.ErrUnsafeDirectory) {
		t.Fatalf("New error = %v, want ErrUnsafeDirectory", err)
	}
}

func TestErrorsDoNotContainPathOrPassword(t *testing.T) {
	root := t.TempDir()
	secret := "synthetic-secret-value"
	_, err := passwordcopy.New(passwordcopy.Config{Enabled: true, Directory: filepath.Join(root, "copies") + "\x00" + secret})
	if err == nil || strings.Contains(err.Error(), root) || strings.Contains(err.Error(), secret) {
		t.Fatalf("configuration error leaked sensitive data: %v", err)
	}
}
func parseRecord(data []byte) (int64, time.Time, []byte, error) {
	first := bytes.IndexByte(data, '\n')
	if first < 1 {
		return 0, time.Time{}, nil, os.ErrInvalid
	}
	secondRelative := bytes.IndexByte(data[first+1:], '\n')
	if secondRelative < 1 {
		return 0, time.Time{}, nil, os.ErrInvalid
	}
	second := first + 1 + secondRelative
	thirdRelative := bytes.IndexByte(data[second+1:], '\n')
	if thirdRelative < 1 {
		return 0, time.Time{}, nil, os.ErrInvalid
	}
	third := second + 1 + thirdRelative

	uid, err := strconv.ParseInt(string(data[:first]), 10, 64)
	if err != nil {
		return 0, time.Time{}, nil, err
	}
	nanoseconds, err := strconv.ParseInt(string(data[first+1:second]), 10, 64)
	if err != nil {
		return 0, time.Time{}, nil, err
	}
	passwordLength, err := strconv.Atoi(string(data[second+1 : third]))
	if err != nil || passwordLength < 0 || len(data[third+1:]) != passwordLength {
		return 0, time.Time{}, nil, os.ErrInvalid
	}
	return uid, time.Unix(0, nanoseconds), data[third+1:], nil
}
