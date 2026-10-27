package service

import (
	"bytes"
	"errors"
	"io"
	"net/http"

	"github.com/Wei-Shaw/sub2api/internal/pkg/tlsfingerprint"
)

// Probe capture bounds. These are probe-local limits, not gateway settings: the
// probe only needs enough of a response to judge keywords, so an unbounded upstream
// must never be able to grow probe memory without limit.
const (
	// probeMaxCaptureBytes caps the number of upstream body bytes retained for the
	// poison judgement. Anything beyond it is still drained (so the connection can
	// be reused and the concurrency slot released) but not buffered, and the result
	// is reported as truncated rather than clean.
	probeMaxCaptureBytes = 4 << 20 // 4 MiB
	// probeCaptureChunkBytes is the read granularity while draining.
	probeCaptureChunkBytes = 32 << 10
)

// probeSentinelAccountID keeps probe traffic out of any real account's client pool
// and in-flight accounting. 0 is never a real account ID.
const probeSentinelAccountID int64 = 0

var (
	errProbeUpstreamRepeat     = errors.New("poison probe issued more than one upstream request")
	errProbeUpstreamNoResponse = errors.New("poison probe received no upstream response")
)

// probeCapture is the raw material for one verdict.
type probeCapture struct {
	body         []byte
	truncated    bool
	readErr      error
	contentType  string
	status       int
	receivedSize int64
}

// probeUpstream decorates the real HTTPUpstream for one probe request.
//
// It does three things that the ordinary test path must not do:
//   - it forces the egress proxy to the exact runtime probe proxy, so a probe never
//     depends on the account's current proxy binding and never touches it;
//   - it passes a sentinel account ID so the account's own concurrency slot and
//     client-pool entry are not consumed by a probe (a probe must not perturb
//     scheduling);
//   - it fully drains the raw upstream body into a buffer before handing a replay
//     reader to the existing protocol parser, so the captured bytes are complete
//     even when that parser returns early on success.
//
// Only the first upstream call of a probe is captured. Later calls (for example an
// Agent-Identity retry that would reload the account) are refused, so a probe
// cannot fan out into extra traffic or into account writes.
type probeUpstream struct {
	inner      HTTPUpstream
	proxyURL   string
	maxCapture int64

	calls    int
	capture  *probeCapture
	proxyHit string
	called   bool
}

func newProbeUpstream(inner HTTPUpstream, proxyURL string) *probeUpstream {
	return &probeUpstream{inner: inner, proxyURL: proxyURL, maxCapture: probeMaxCaptureBytes}
}

func (u *probeUpstream) Do(req *http.Request, _ string, _ int64, _ int) (*http.Response, error) {
	return u.do(func() (*http.Response, error) {
		return u.inner.Do(req, u.proxyURL, probeSentinelAccountID, 0)
	})
}

func (u *probeUpstream) DoWithTLS(req *http.Request, _ string, _ int64, _ int, profile *tlsfingerprint.Profile) (*http.Response, error) {
	return u.do(func() (*http.Response, error) {
		return u.inner.DoWithTLS(req, u.proxyURL, probeSentinelAccountID, 0, profile)
	})
}

func (u *probeUpstream) do(call func() (*http.Response, error)) (*http.Response, error) {
	u.calls++
	u.called = true
	if u.calls > 1 {
		return nil, errProbeUpstreamRepeat
	}
	resp, err := call()
	if err != nil {
		return nil, err
	}
	if resp == nil {
		return nil, errProbeUpstreamNoResponse
	}
	captured, capture := captureProbeResponse(resp, u.maxCapture)
	u.capture = capture
	return captured, nil
}

// captureProbeResponse drains the response body completely, retaining at most max
// bytes, and replaces the body with a reader over what was retained.
//
// The original body is closed here exactly once, after draining, which is what
// releases the transport connection and the client pool's in-flight counter; the
// replacement body's Close is a no-op so the caller's deferred Close cannot
// double-close the transport body.
func captureProbeResponse(resp *http.Response, max int64) (*http.Response, *probeCapture) {
	if max <= 0 {
		max = probeMaxCaptureBytes
	}
	capture := &probeCapture{
		contentType: resp.Header.Get("Content-Type"),
		status:      resp.StatusCode,
	}
	original := resp.Body
	if original == nil {
		resp.Body = io.NopCloser(bytes.NewReader(nil))
		return resp, capture
	}

	buf := make([]byte, probeCaptureChunkBytes)
	var retained bytes.Buffer
	for {
		n, readErr := original.Read(buf)
		if n > 0 {
			capture.receivedSize += int64(n)
			room := max - int64(retained.Len())
			if room > 0 {
				take := int64(n)
				if take > room {
					take = room
					capture.truncated = true
				}
				retained.Write(buf[:take])
			} else {
				capture.truncated = true
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				capture.readErr = readErr
			}
			break
		}
	}
	_ = original.Close()
	capture.body = retained.Bytes()
	resp.Body = io.NopCloser(bytes.NewReader(capture.body))
	return resp, capture
}
