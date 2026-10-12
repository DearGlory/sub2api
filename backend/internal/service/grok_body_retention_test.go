//go:build unit

package service

import (
	"bytes"
	"context"
	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
	"github.com/gin-gonic/gin"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strings"
	"testing"
	"time"
)

type retentionUpstream struct {
	readStarted chan struct{}
	release     chan struct{}
}
type retentionResponse struct {
	u      *retentionUpstream
	once   bool
	reader *strings.Reader
}

func (b *retentionResponse) Read(p []byte) (int, error) {
	if !b.once {
		b.once = true
		close(b.u.readStarted)
		<-b.u.release
	}
	return b.reader.Read(p)
}
func (b *retentionResponse) Close() error { return nil }
func (u *retentionUpstream) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	io.Copy(io.Discard, req.Body)
	req.Body.Close()
	return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"application/json"}}, Request: req, Body: &retentionResponse{u: u, reader: strings.NewReader(`{"id":"r","object":"response","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1}}`)}}, nil
}
func (u *retentionUpstream) DoWithTLS(r *http.Request, p string, a int64, n int, _ *tlsfingerprint.Profile) (*http.Response, error) {
	return u.Do(r, p, a, n)
}

func TestGrokSentRequestReleasesPatchedBodyWhileResponsePending(t *testing.T) {
	gin.SetMode(gin.TestMode)
	body := []byte(`{"model":"grok","input":"` + strings.Repeat("a", 16<<20) + `"}`)
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = httptest.NewRequest("POST", "/v1/responses", http.NoBody)
	c.Set("api_key", &APIKey{ID: 42})
	account := &Account{ID: 1, Platform: PlatformGrok, Type: AccountTypeAPIKey, Credentials: map[string]any{"api_key": "synthetic-test"}}
	u := &retentionUpstream{readStarted: make(chan struct{}), release: make(chan struct{})}
	s := &OpenAIGatewayService{httpUpstream: u}
	runtime.GC()
	var a, b runtime.MemStats
	runtime.ReadMemStats(&a)
	done := make(chan error, 1)
	go func() {
		_, err := s.forwardGrokResponses(context.Background(), c, account, body, "grok", false, time.Now())
		done <- err
	}()
	select {
	case <-u.readStarted:
	case err := <-done:
		t.Fatalf("early exit: %v", err)
	case <-time.After(20 * time.Second):
		t.Fatal("read not reached")
	}
	runtime.GC()
	runtime.GC()
	runtime.ReadMemStats(&b)
	retained := int64(b.HeapAlloc) - int64(a.HeapAlloc)
	close(u.release)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	t.Logf("extra retained during response: %d bytes for %d-byte body", retained, len(body))
	if retained > 8<<20 {
		t.Errorf("already sent patched body retained: %d", retained)
	}
	runtime.KeepAlive(body)
	runtime.KeepAlive(bytes.Equal)
}
