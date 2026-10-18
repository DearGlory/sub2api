//go:build linux

package passwordcopy

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	directoryMode = 0o700
	recordMode    = 0o600
	lockRetry     = 5 * time.Millisecond
	oPath         = 0x200000
)

// Store persists one current plaintext password record per user. It is safe
// for concurrent use by multiple goroutines and multiple Store instances.
type Store struct {
	dir     *os.File
	enabled bool

	mu     sync.Mutex
	closed bool
}

// New validates and prepares a Store. Disabled stores do not inspect or
// create the configured path and all operations are no-ops.
func New(cfg Config) (*Store, error) {
	if !cfg.Enabled {
		return &Store{}, nil
	}
	if err := validateDirectoryPath(cfg.Directory); err != nil {
		return nil, err
	}
	directory, err := openPrivateDirectory(cfg.Directory)
	if err != nil {
		return nil, err
	}
	return &Store{dir: directory, enabled: true}, nil
}

// Save atomically replaces the latest record for userID.
func (s *Store) Save(ctx context.Context, userID int64, password string) error {
	if s == nil || !s.enabled {
		return nil
	}
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := validateUserID(userID); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := s.lockDirectory(ctx); err != nil {
		return err
	}
	defer s.unlockDirectory()
	if err := validateDirectoryFD(s.dir); err != nil {
		return err
	}

	name := userRecordName(userID)
	tempName, tempFile, err := createTempRecord(s.dir)
	if err != nil {
		return err
	}
	tempClosed := false
	renamed := false
	defer func() {
		if !tempClosed {
			_ = tempFile.Close()
		}
		if !renamed {
			_ = syscall.Unlinkat(int(s.dir.Fd()), tempName)
		}
	}()

	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := writeAll(tempFile, encodeRecord(userID, time.Now().UTC(), password)); err != nil {
		return err
	}
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := tempFile.Sync(); err != nil {
		return ErrFilesystem
	}
	if err := validateRecordFile(tempFile); err != nil {
		return err
	}
	if err := tempFile.Close(); err != nil {
		tempClosed = true
		return ErrFilesystem
	}
	tempClosed = true

	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := validateExistingRecord(s.dir, name, true); err != nil {
		return err
	}
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := syscall.Renameat(int(s.dir.Fd()), tempName, int(s.dir.Fd()), name); err != nil {
		return ErrFilesystem
	}
	renamed = true
	if err := syscall.Fsync(int(s.dir.Fd())); err != nil {
		return ErrFilesystem
	}
	return nil
}

// Remove deletes the current record for userID. Missing records are treated
// as success, matching the no-op behavior of a disabled store.
func (s *Store) Remove(ctx context.Context, userID int64) error {
	if s == nil || !s.enabled {
		return nil
	}
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := validateUserID(userID); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return ErrClosed
	}
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := s.lockDirectory(ctx); err != nil {
		return err
	}
	defer s.unlockDirectory()
	if err := validateDirectoryFD(s.dir); err != nil {
		return err
	}

	name := userRecordName(userID)
	if err := validateExistingRecord(s.dir, name, false); err != nil {
		if errors.Is(err, ErrRecordMissing) {
			return nil
		}
		return err
	}
	if err := validateContext(ctx); err != nil {
		return err
	}
	if err := syscall.Unlinkat(int(s.dir.Fd()), name); err != nil {
		if errors.Is(err, syscall.ENOENT) {
			return nil
		}
		return ErrFilesystem
	}
	if err := syscall.Fsync(int(s.dir.Fd())); err != nil {
		return ErrFilesystem
	}
	return nil
}

// Close prevents future enabled operations and releases the held directory fd.
func (s *Store) Close() error {
	if s == nil || !s.enabled {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	if s.dir == nil {
		return nil
	}
	if err := s.dir.Close(); err != nil {
		return ErrFilesystem
	}
	return nil
}

func validateDirectoryPath(directory string) error {
	if directory == "" || !filepath.IsAbs(directory) || filepath.Clean(directory) != directory {
		return ErrInvalidConfiguration
	}
	if strings.ContainsRune(directory, '\x00') {
		return ErrInvalidConfiguration
	}
	return nil
}

func validateContext(ctx context.Context) error {
	if ctx == nil {
		return ErrInvalidContext
	}
	if ctx.Err() == nil {
		return nil
	}
	return contextError(ctx)
}

func contextError(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return context.DeadlineExceeded
	}
	return context.Canceled
}

func validateUserID(userID int64) error {
	if userID <= 0 || userID == math.MinInt64 {
		return ErrInvalidUserID
	}
	return nil
}

func userRecordName(userID int64) string {
	return strconv.FormatInt(userID, 10)
}

func openPrivateDirectory(directory string) (*os.File, error) {
	rootFD, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, ErrFilesystem
	}
	currentFD := rootFD
	parts := strings.Split(strings.TrimPrefix(directory, string(filepath.Separator)), string(filepath.Separator))
	for _, part := range parts {
		if part == "" {
			continue
		}
		nextFD, openErr := syscall.Openat(currentFD, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		if errors.Is(openErr, syscall.ENOENT) {
			if mkdirErr := syscall.Mkdirat(currentFD, part, directoryMode); mkdirErr != nil && !errors.Is(mkdirErr, syscall.EEXIST) {
				_ = syscall.Close(currentFD)
				return nil, mapDirectoryError(mkdirErr)
			}
			nextFD, openErr = syscall.Openat(currentFD, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
		}
		_ = syscall.Close(currentFD)
		if openErr != nil {
			return nil, mapDirectoryError(openErr)
		}
		currentFD = nextFD
	}

	var stat syscall.Stat_t
	if err := syscall.Fstat(currentFD, &stat); err != nil {
		_ = syscall.Close(currentFD)
		return nil, ErrFilesystem
	}
	if !isPrivateDirectory(stat) {
		_ = syscall.Close(currentFD)
		return nil, ErrUnsafeDirectory
	}
	return os.NewFile(uintptr(currentFD), directory), nil
}

func mapDirectoryError(err error) error {
	if errors.Is(err, syscall.ELOOP) || errors.Is(err, syscall.ENOTDIR) {
		return ErrUnsafeDirectory
	}
	return ErrFilesystem
}

func validateDirectoryFD(directory *os.File) error {
	if directory == nil {
		return ErrFilesystem
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(directory.Fd()), &stat); err != nil {
		return ErrFilesystem
	}
	if !isPrivateDirectory(stat) {
		return ErrUnsafeDirectory
	}
	return nil
}

func isPrivateDirectory(stat syscall.Stat_t) bool {
	return stat.Mode&syscall.S_IFMT == syscall.S_IFDIR &&
		stat.Uid == uint32(os.Geteuid()) &&
		stat.Mode&0o7777 == directoryMode
}

func (s *Store) lockDirectory(ctx context.Context) error {
	for {
		err := syscall.Flock(int(s.dir.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			if contextErr := validateContext(ctx); contextErr != nil {
				_ = syscall.Flock(int(s.dir.Fd()), syscall.LOCK_UN)
				return contextErr
			}
			return nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return ErrFilesystem
		}
		timer := time.NewTimer(lockRetry)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return contextError(ctx)
		case <-timer.C:
		}
	}
}

func (s *Store) unlockDirectory() {
	_ = syscall.Flock(int(s.dir.Fd()), syscall.LOCK_UN)
}

func createTempRecord(directory *os.File) (string, *os.File, error) {
	var random [12]byte
	for attempt := 0; attempt < 8; attempt++ {
		if _, err := rand.Read(random[:]); err != nil {
			return "", nil, ErrFilesystem
		}
		name := ".passwordcopy-" + hex.EncodeToString(random[:])
		fd, err := syscall.Openat(int(directory.Fd()), name, syscall.O_WRONLY|syscall.O_CREAT|syscall.O_EXCL|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, recordMode)
		if errors.Is(err, syscall.EEXIST) {
			continue
		}
		if err != nil {
			return "", nil, ErrFilesystem
		}
		file := os.NewFile(uintptr(fd), name)
		if err := validateRecordFile(file); err != nil {
			_ = file.Close()
			_ = syscall.Unlinkat(int(directory.Fd()), name)
			return "", nil, err
		}
		return name, file, nil
	}
	return "", nil, ErrFilesystem
}

func validateRecordFile(file *os.File) error {
	if file == nil {
		return ErrUnsafeRecord
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(int(file.Fd()), &stat); err != nil {
		return ErrFilesystem
	}
	if !isSafeRecord(stat) {
		return ErrUnsafeRecord
	}
	return nil
}

func validateExistingRecord(directory *os.File, name string, missingAllowed bool) error {
	fd, err := syscall.Openat(int(directory.Fd()), name, oPath|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if errors.Is(err, syscall.ENOENT) {
		if missingAllowed {
			return nil
		}
		return ErrRecordMissing
	}
	if err != nil {
		return ErrUnsafeRecord
	}
	defer syscall.Close(fd)

	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		return ErrFilesystem
	}
	if !isSafeRecord(stat) {
		return ErrUnsafeRecord
	}
	return nil
}

func isSafeRecord(stat syscall.Stat_t) bool {
	return stat.Mode&syscall.S_IFMT == syscall.S_IFREG &&
		stat.Uid == uint32(os.Geteuid()) &&
		stat.Nlink == 1 &&
		stat.Mode&0o7777 == recordMode
}

func writeAll(file *os.File, data []byte) error {
	for len(data) > 0 {
		n, err := file.Write(data)
		if err != nil {
			return ErrFilesystem
		}
		if n == 0 {
			return ErrFilesystem
		}
		data = data[n:]
	}
	return nil
}
