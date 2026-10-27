package poison

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Evidence records bytes returned by Read, not network frames or exact token offsets.
// Pre-reading by transports, decompressors and scanners can extend the prefix.
type evidenceContextKey struct{}

type HitDetails struct {
	InspectedRunes int      `json:"inspected_runes"`
	Reason         string   `json:"reason"`
	Lane           string   `json:"lane"`
	Matched        []string `json:"matched"`
	Counted        int      `json:"counted"`
	Threshold      int      `json:"threshold"`
	Veto           bool     `json:"veto"`
}

type evidenceResponse struct {
	Attempt         int       `json:"response_attempt"`
	File            string    `json:"file"`
	Stage           string    `json:"capture_stage"`
	Status          int       `json:"status"`
	ContentType     string    `json:"content_type"`
	ContentEncoding string    `json:"content_encoding"`
	ContentLength   int64     `json:"content_length"`
	Uncompressed    bool      `json:"uncompressed"`
	Started         time.Time `json:"started_at"`
	Bytes           int64     `json:"capture_end_offset"`
	SHA256          string    `json:"sha256"`
	EOF             bool      `json:"eof"`
	Closed          bool      `json:"closed"`
	Complete        bool      `json:"complete"`
	ReadError       string    `json:"read_error,omitempty"`
	CaptureError    string    `json:"capture_error,omitempty"`
	memory          []byte
	file            *os.File
	digest          hash.Hash
}

type evidenceMetadata struct {
	Schema      int                 `json:"schema_version"`
	ID          string              `json:"evidence_id"`
	RequestID   string              `json:"request_id"`
	AccountID   int64               `json:"account_id"`
	ProxyID     *int64              `json:"proxy_id,omitempty"`
	Path        string              `json:"path"`
	Model       string              `json:"request_model"`
	Started     time.Time           `json:"started_at"`
	HitAt       time.Time           `json:"hit_at"`
	Hit         HitDetails          `json:"hit"`
	Committed   int                 `json:"downstream_committed_bytes"`
	Interrupted bool                `json:"interrupted"`
	Boundary    string              `json:"capture_boundary"`
	Responses   []*evidenceResponse `json:"responses"`
}

type evidenceSession struct {
	mu                    sync.Mutex
	root, temp, published string
	meta                  evidenceMetadata
	frozen, closed        bool
	failed                string
}

func newEvidenceSession(root, requestID, path, model string, info AccountInfo) *evidenceSession {
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		log.Printf("[poison-evidence] error=random_id")
		return nil
	}
	if root == "" {
		root = "./data/poison-evidence"
	}
	s := &evidenceSession{root: root, meta: evidenceMetadata{Schema: 1, ID: hex.EncodeToString(id[:]), RequestID: requestID, AccountID: info.AccountID, Path: path, Model: model, Started: time.Now().UTC(), Boundary: "returned_read_prefix; may include read-ahead; not exact hit-token byte offset"}}
	if info.ProxyID != nil {
		v := *info.ProxyID
		s.meta.ProxyID = &v
	}
	return s
}

func evidenceFromContext(ctx context.Context) *evidenceSession {
	if ctx == nil {
		return nil
	}
	s, _ := ctx.Value(evidenceContextKey{}).(*evidenceSession)
	return s
}

func CaptureUpstreamResponse(ctx context.Context, resp *http.Response) {
	captureHTTP(ctx, resp, "transport_response_body")
}
func CapturePluginResponse(ctx context.Context, resp *http.Response) {
	captureHTTP(ctx, resp, "plugin_http_response_body")
}
func CaptureDecodedResponse(ctx context.Context, resp *http.Response) {
	captureHTTP(ctx, resp, "decoded_upstream_body")
}
func captureHTTP(ctx context.Context, resp *http.Response, stage string) {
	s := evidenceFromContext(ctx)
	if s == nil || resp == nil || resp.Body == nil {
		return
	}
	if b, ok := resp.Body.(*evidenceBody); ok && b.session == s {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.frozen || s.closed {
		return
	}
	r := s.newResponse(stage)
	r.Status = resp.StatusCode
	r.ContentType = resp.Header.Get("Content-Type")
	r.ContentEncoding = resp.Header.Get("Content-Encoding")
	r.ContentLength = resp.ContentLength
	r.Uncompressed = resp.Uncompressed
	resp.Body = &evidenceBody{ReadCloser: resp.Body, session: s, response: r}
}
func (s *evidenceSession) newResponse(stage string) *evidenceResponse {
	n := len(s.meta.Responses) + 1
	r := &evidenceResponse{Attempt: n, File: fmt.Sprintf("response-%d.body", n), Stage: stage, Started: time.Now().UTC(), digest: sha256.New()}
	s.meta.Responses = append(s.meta.Responses, r)
	return r
}

type evidenceBody struct {
	io.ReadCloser
	session  *evidenceSession
	response *evidenceResponse
}

func (b *evidenceBody) Read(p []byte) (int, error) {
	n, err := b.ReadCloser.Read(p)
	b.session.mu.Lock()
	defer b.session.mu.Unlock()
	if !b.session.closed && !b.session.frozen {
		b.session.append(b.response, p[:n])
		if err == io.EOF {
			b.response.EOF = true
		} else if err != nil {
			b.response.ReadError = "upstream_read"
		}
	}
	return n, err
}
func (b *evidenceBody) Close() error {
	// Never hold the evidence lock while closing or waiting on the transport.
	err := b.ReadCloser.Close()
	b.session.mu.Lock()
	if !b.session.closed && !b.session.frozen {
		b.response.Closed = true
	}
	b.session.mu.Unlock()
	return err
}
func (s *evidenceSession) failure(category string) {
	if s.failed == "" {
		s.failed = category
		log.Printf("[poison-evidence] id=%s error=%s", s.meta.ID, category)
	}
}
func (s *evidenceSession) directory() error {
	if s.temp != "" {
		return nil
	}
	if err := os.MkdirAll(s.root, 0700); err != nil {
		return err
	}
	if err := os.Chmod(s.root, 0700); err != nil {
		return err
	}
	temp, err := os.MkdirTemp(s.root, ".pending-")
	if err != nil {
		return err
	}
	s.temp = temp
	return nil
}
func (s *evidenceSession) spill(r *evidenceResponse) error {
	if r.file != nil {
		return nil
	}
	if err := s.directory(); err != nil {
		return err
	}
	f, err := os.OpenFile(filepath.Join(s.temp, r.File), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	r.file = f
	if n, err := f.Write(r.memory); err != nil {
		return err
	} else if n != len(r.memory) {
		return io.ErrShortWrite
	}
	r.memory = nil
	return nil
}
func (s *evidenceSession) append(r *evidenceResponse, p []byte) {
	if len(p) == 0 || s.failed != "" {
		return
	}
	if r.file == nil && len(r.memory)+len(p) <= wireMemoryThreshold {
		r.memory = append(r.memory, p...)
		r.digest.Write(p)
		r.Bytes += int64(len(p))
		return
	}
	if err := s.spill(r); err != nil {
		r.CaptureError = "spool_create"
		s.failure(r.CaptureError)
		return
	}
	n, err := r.file.Write(p)
	r.digest.Write(p[:n])
	r.Bytes += int64(n)
	if err != nil || n != len(p) {
		r.CaptureError = "spool_write"
		s.failure(r.CaptureError)
	}
}
func (s *evidenceSession) markHit(hit HitDetails, committed int) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.frozen {
		return
	}
	s.frozen = true
	s.meta.Hit = hit
	s.meta.HitAt = time.Now().UTC()
	s.meta.Committed = committed
	s.meta.Interrupted = committed > 0
}
func (s *evidenceSession) finalize() (string, string) {
	if s == nil {
		return "", ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.published != "" {
		return s.meta.ID, s.published
	}
	if s.closed {
		return "", ""
	}
	if !s.frozen || s.failed != "" {
		s.cleanup()
		return "", ""
	}
	if err := s.directory(); err != nil {
		s.failure("directory")
		s.cleanup()
		return "", ""
	}
	for _, r := range s.meta.Responses {
		if err := s.spill(r); err != nil {
			s.failure("spool_publish")
			s.cleanup()
			return "", ""
		}
		if err := r.file.Sync(); err != nil {
			s.failure("body_sync")
			s.cleanup()
			return "", ""
		}
		if err := r.file.Close(); err != nil {
			s.failure("body_close")
			s.cleanup()
			return "", ""
		}
		r.file = nil
		r.SHA256 = hex.EncodeToString(r.digest.Sum(nil))
		r.Complete = r.EOF && r.ReadError == "" && r.CaptureError == ""
	}
	data, err := json.MarshalIndent(s.meta, "", "  ")
	if err == nil {
		err = os.WriteFile(filepath.Join(s.temp, "metadata.json"), data, 0600)
	}
	if err != nil {
		s.failure("metadata")
		s.cleanup()
		return "", ""
	}
	target := filepath.Join(s.root, s.meta.ID)
	if err = os.Rename(s.temp, target); err != nil {
		s.failure("publish")
		s.cleanup()
		return "", ""
	}
	s.temp = ""
	s.published = target
	s.closed = true
	return s.meta.ID, target
}
func (s *evidenceSession) cleanup() {
	for _, r := range s.meta.Responses {
		if r.file != nil {
			_ = r.file.Close()
			r.file = nil
		}
		r.memory = nil
	}
	if s.temp != "" {
		if err := os.RemoveAll(s.temp); err != nil {
			s.failure("cleanup")
		}
		s.temp = ""
	}
	s.closed = true
}
func (s *evidenceSession) close() {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.cleanup()
}

// WebSocketCapture belongs to one forward invocation, never a pooled connection.
// Payloads are concatenated verbatim; the second file is uint64 big-endian
// message lengths, preserving message boundaries without retaining an index in RAM.
type WebSocketCapture struct {
	session          *evidenceSession
	payload, lengths *evidenceResponse
}

func NewWebSocketCapture(ctx context.Context) *WebSocketCapture {
	s := evidenceFromContext(ctx)
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.frozen {
		return nil
	}
	return &WebSocketCapture{session: s, payload: s.newResponse("websocket_message_payload"), lengths: s.newResponse("websocket_message_lengths_uint64be")}
}
func (w *WebSocketCapture) Capture(payload []byte) {
	if w == nil {
		return
	}
	s := w.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.frozen {
		return
	}
	var length [8]byte
	binary.BigEndian.PutUint64(length[:], uint64(len(payload)))
	s.append(w.payload, payload)
	s.append(w.lengths, length[:])
	// EOF describes HTTP only. A WS forward can stop before a terminal message.
}

// WriteEvidenceDisposition atomically adds a redacted disposition receipt.
func WriteEvidenceDisposition(evidencePath string, value any) error {
	if evidencePath == "" {
		return nil
	}
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.CreateTemp(evidencePath, ".disposition-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if _, err = f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(name, filepath.Join(evidencePath, "disposition.json"))
}
