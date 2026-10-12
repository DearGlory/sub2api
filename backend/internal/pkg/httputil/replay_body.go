package httputil

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"sync"
)

type requestReplay struct {
	mu       sync.Mutex
	body     []byte
	released bool
}

type replayReader struct {
	mu     sync.Mutex
	reader *bytes.Reader
	replay *requestReplay
}

// BindReleasableRequestBody keeps redirect/retry support without retaining the
// uploaded bytes through http.Response.Request for the whole response stream.
// The caller must release replay ownership after Client.Do returns.
func BindReleasableRequestBody(req *http.Request, body []byte) {
	state := &requestReplay{body: body}
	req.ContentLength = int64(len(body))
	req.GetBody = state.open
	req.Body = &replayReader{reader: bytes.NewReader(body), replay: state}
	if len(body) == 0 {
		req.Body = http.NoBody
	}
}

func (s *requestReplay) open() (io.ReadCloser, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.released {
		return nil, errors.New("request replay released")
	}
	return &replayReader{reader: bytes.NewReader(s.body), replay: s}, nil
}

func (b *replayReader) Read(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.reader == nil {
		return 0, io.EOF
	}
	n, err := b.reader.Read(p)
	if b.reader.Len() == 0 {
		b.reader = nil
	}
	return n, err
}

func (b *replayReader) Close() error {
	b.mu.Lock()
	b.reader = nil
	b.mu.Unlock()
	return nil
}

// ReleaseRequestReplay drops the replay source, not a reader still being sent.
// It is safe after Do: redirects and transport retries have already completed.
func ReleaseRequestReplay(req *http.Request) {
	if req == nil {
		return
	}
	b, ok := req.Body.(*replayReader)
	if !ok {
		return
	}
	b.replay.mu.Lock()
	b.replay.body = nil
	b.replay.released = true
	b.replay.mu.Unlock()
}
