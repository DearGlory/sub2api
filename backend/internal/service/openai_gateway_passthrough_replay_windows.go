//go:build windows

package service

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"syscall"
)

var openAIPassthroughReplayTempSeq atomic.Uint64

func createOpenAIPassthroughReplayTemp() (*os.File, error) {
	dir := os.TempDir()
	var last error
	for attempt := 0; attempt < 32; attempt++ {
		name := filepath.Join(dir, fmt.Sprintf(
			"sub2api-openai-passthrough-replay-%d-%d",
			os.Getpid(),
			openAIPassthroughReplayTempSeq.Add(1),
		))
		file, err := openOpenAIPassthroughReplayDeleteOnClose(name)
		if err == nil {
			return file, nil
		}
		last = err
		if !errors.Is(err, syscall.ERROR_ALREADY_EXISTS) {
			return nil, err
		}
	}
	if last == nil {
		last = errors.New("exhausted unique names")
	}
	return nil, fmt.Errorf("create openai passthrough compact replay temp: %w", last)
}

func openOpenAIPassthroughReplayDeleteOnClose(name string) (*os.File, error) {
	path, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return nil, err
	}
	const (
		fileAttributeTemporary = 0x00000100
		fileFlagDeleteOnClose  = 0x04000000
		// DELETE is the file access right. It is not exported by syscall.
		fileAccessDelete = 0x00010000
	)
	// DELETE plus FILE_FLAG_DELETE_ON_CLOSE removes the name when the last
	// handle closes, including process exit. FILE_SHARE_DELETE lets release
	// Remove the name while this handle is still open.
	handle, err := syscall.CreateFile(
		path,
		uint32(syscall.GENERIC_READ|syscall.GENERIC_WRITE)|fileAccessDelete,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil,
		syscall.CREATE_NEW,
		fileAttributeTemporary|fileFlagDeleteOnClose,
		0,
	)
	if err != nil {
		return nil, err
	}
	return os.NewFile(uintptr(handle), name), nil
}

// detachOpenAIPassthroughReplayName tries to drop the directory name before
// the body is written. Windows often refuses that while the handle is open.
// The name is then kept for release(); production files were created with
// FILE_FLAG_DELETE_ON_CLOSE, so Close and process exit still delete them.
// A live-name Remove failure is not a park failure and does not keep a heap copy.
func detachOpenAIPassthroughReplayName(file *os.File, remove func(string) error) (string, error) {
	if file == nil {
		return "", errors.New("openai passthrough compact replay file is nil")
	}
	if remove == nil {
		remove = os.Remove
	}
	path := file.Name()
	if path == "" {
		return "", nil
	}
	if err := remove(path); err == nil || errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return path, nil
}
