//go:build unit

package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tidwall/gjson"
)

func TestNormalForwardReplayReleasePreservesIssuedReaders(t *testing.T) {
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = nil
	s := newOpenAIImageGenerationControlTestService(nil)
	body := []byte(`{"model":"gpt-test","input":"unchanged","stream":true}`)
	req, err := s.buildUpstreamRequest(context.Background(), c, account, body, "test-token", true, "", false)
	require.NoError(t, err)
	require.Equal(t, int64(len(body)), req.ContentLength)
	require.NotNil(t, req.GetBody)
	replay, err := req.GetBody()
	require.NoError(t, err)
	replayed, err := io.ReadAll(replay)
	require.NoError(t, err)
	require.Equal(t, body, replayed)
	require.NoError(t, replay.Close())
	issued, err := req.GetBody()
	require.NoError(t, err)
	openReplay := req.GetBody
	releaseOpenAIPassthroughUpstreamRequest(req)
	require.Nil(t, req.GetBody)
	afterRelease, err := openReplay()
	if afterRelease != nil {
		_ = afterRelease.Close()
	}
	require.ErrorContains(t, err, "request replay released")
	for _, reader := range []io.ReadCloser{req.Body, issued} {
		got, err := io.ReadAll(reader)
		require.NoError(t, err)
		require.Equal(t, body, got)
		require.NoError(t, reader.Close())
	}
}

func TestNormalForwardAsyncUploadCompletesAfterHeaders(t *testing.T) {
	marker := strings.Repeat("n", 2<<20)
	body := []byte(`{"model":"gpt-test","stream":true,"service_tier":"priority","input":[{"type":"message","id":"invalid-id","role":"user","content":[{"type":"input_text","text":"` + marker + `"}]}]}`)
	c, _ := newOpenAIImageGenerationControlTestContext(true, "synthetic")
	account := newOpenAIImageGenerationControlTestAccount()
	account.Extra = nil
	responseStarted := make(chan struct{})
	responseRelease := make(chan struct{})
	upstream := &passthroughAsyncUploadUpstream{
		releaseRead: make(chan struct{}),
		got:         make(chan struct{}),
		body: &passthroughHoldBody{
			started: responseStarted,
			release: responseRelease,
			rest:    strings.NewReader("data: {\"type\":\"response.completed\",\"response\":{\"id\":\"r-normal\",\"status\":\"completed\",\"output\":[],\"usage\":{\"input_tokens\":3,\"output_tokens\":4}}}\n\ndata: [DONE]\n\n"),
		},
	}
	t.Cleanup(func() {
		select {
		case <-upstream.releaseRead:
		default:
			close(upstream.releaseRead)
		}
		select {
		case <-responseRelease:
		default:
			close(responseRelease)
		}
	})
	s := newOpenAIImageGenerationControlTestService(nil)
	s.httpUpstream = upstream
	creates := 0
	s.passthroughReplayStore = &openAIPassthroughReplayStore{
		budget:     newOpenAIPassthroughReplayBudget(1),
		createTemp: func() (*os.File, error) { creates++; return nil, errors.New("normal response must not spill") },
	}
	var result *OpenAIForwardResult
	done := make(chan error, 1)
	go func() { var err error; result, err = s.Forward(context.Background(), c, account, body); done <- err }()
	select {
	case <-responseStarted:
	case err := <-done:
		t.Fatalf("finished before pending upload: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("response was not read")
	}
	close(upstream.releaseRead)
	select {
	case <-upstream.got:
	case <-time.After(20 * time.Second):
		t.Fatal("upload did not finish")
	}
	upstream.mu.Lock()
	uploaded := bytes.Clone(upstream.uploaded)
	uploadErr := upstream.uploadErr
	upstream.mu.Unlock()
	require.NoError(t, uploadErr)
	text := gjson.GetBytes(uploaded, "input.0.content.0.text").String()
	require.Equal(t, sha256.Sum256([]byte(marker)), sha256.Sum256([]byte(text)))
	require.False(t, gjson.GetBytes(uploaded, "input.0.id").Exists())
	close(responseRelease)
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-time.After(20 * time.Second):
		t.Fatal("request did not finish")
	}
	require.NotNil(t, result)
	require.NotNil(t, result.ServiceTier)
	require.Equal(t, "priority", *result.ServiceTier)
	require.Equal(t, 3, result.Usage.InputTokens)
	require.Equal(t, 4, result.Usage.OutputTokens)
	require.Zero(t, creates)
	require.Zero(t, s.passthroughReplayStore.budget.used.Load())
}

func TestNormalForwardCompactReplayRestoreAndCancellation(t *testing.T) {
	for _, canceled := range []bool{false, true} {
		t.Run(map[bool]string{false: "restore", true: "cancel"}[canceled], func(t *testing.T) {
			body := bytes.Repeat([]byte("r"), openAIPassthroughReplayMemoryLimit+1)
			var spillPath string
			store := &openAIPassthroughReplayStore{
				budget: newOpenAIPassthroughReplayBudget(int64(len(body))),
				createTemp: func() (*os.File, error) {
					file, err := os.CreateTemp(t.TempDir(), "normal-replay-*")
					if file != nil {
						spillPath = file.Name()
					}
					return file, err
				},
			}
			replay, err := parkOpenAIPassthroughReplay(body, int64(len(body)), store)
			require.NoError(t, err)
			defer func() { require.NoError(t, replay.release()) }()
			require.Empty(t, replay.memory)
			signal := &openAICompactFallbackSignal{message: "model not available"}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if canceled {
				cancel()
				replay.forcedReadErr = errors.New("read must not happen")
			}
			restored, err := restoreOpenAICompactReplayForReadError(ctx, replay, signal)
			if canceled {
				require.ErrorIs(t, err, context.Canceled)
				require.ErrorIs(t, err, signal)
				require.NotContains(t, err.Error(), "read must not happen")
				require.Nil(t, restored)
				require.Equal(t, int64(len(body)), store.budget.used.Load())
			} else {
				require.NoError(t, err)
				require.Equal(t, body, restored)
				require.True(t, replay.released)
				require.Zero(t, store.budget.used.Load())
				_, statErr := os.Stat(spillPath)
				require.True(t, errors.Is(statErr, os.ErrNotExist))
			}
		})
	}
}
