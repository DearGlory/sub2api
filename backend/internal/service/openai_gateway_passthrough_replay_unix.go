//go:build !windows

package service

import (
	"errors"
	"fmt"
	"os"
)

func createOpenAIPassthroughReplayTemp() (*os.File, error) {
	// os.CreateTemp uses mode 0600. No extra Chmod: that mode is already private.
	return os.CreateTemp("", "sub2api-openai-passthrough-replay-*")
}

// detachOpenAIPassthroughReplayName unlinks the name before any body bytes are
// written. The open descriptor stays readable. A crash cannot leave a named
// plaintext file. Unlink failure fails the park; it does not keep the body.
func detachOpenAIPassthroughReplayName(file *os.File, remove func(string) error) (string, error) {
	if file == nil {
		return "", errors.New("openai passthrough compact replay file is nil")
	}
	if remove == nil {
		remove = os.Remove
	}
	path := file.Name()
	if err := remove(path); err != nil {
		closeErr := file.Close()
		again := remove(path)
		if errors.Is(again, os.ErrNotExist) {
			again = nil
		}
		return "", errors.Join(
			fmt.Errorf("unlink openai passthrough compact replay before use: %w", err),
			closeErr,
			again,
		)
	}
	return "", nil
}
