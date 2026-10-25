package poison

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestReviewNilSnapshotDoesNotPanic(t *testing.T) {
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	before := c.Writer
	MarkRequest(c, nil, "https://kedaya.ai", true)
	if Attach(c, nil, AccountInfo{BaseURL: "https://kedaya.ai", HasProxy: true}) {
		t.Fatal("nil snapshot enabled guard")
	}
	if c.Writer != before {
		t.Fatal("nil snapshot wrapped writer")
	}
}

func TestReviewErrorJSONValid(t *testing.T) {
	for _, message := range []string{DefaultBlockMessage, "escaped \" \\ \n\r\t", "control\x00\x01\b\f\x1f"} {
		c, rec := newGuardContext(t, activeSnapshot(), "https://kedaya.ai", true)
		StatusGuard(c).WriteError(DefaultBlockStatus, message)
		var payload struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
			t.Errorf("invalid JSON for %q: %v", message, err)
			continue
		}
		if payload.Error.Message != message {
			t.Errorf("message changed: got %q want %q", payload.Error.Message, message)
		}
	}
}

func TestReviewSeparateChoicesDoNotFormKeyword(t *testing.T) {
	g := newResponseGuard(activeSnapshot().Detector, "application/json")
	body := []byte(`{"choices":[{"index":0,"message":{"content":"keda"}},{"index":1,"message":{"content":"ya"}}]}`)
	_, _, _ = g.feed(body, false)
	out, blocked, err := g.feed(nil, true)
	if err != nil || blocked || string(out) != string(body) {
		t.Fatalf("independent choices merged: blocked=%v err=%v bytes=%d", blocked, err, len(out))
	}
}

func TestReviewSeparateSSEChoicesDoNotFormKeyword(t *testing.T) {
	g := newResponseGuard(activeSnapshot().Detector, "text/event-stream")
	for _, frame := range []string{"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"keda\"}}]}\n\n", "data: {\"choices\":[{\"index\":1,\"delta\":{\"content\":\"ya\"}}]}\n\n"} {
		_, blocked, err := g.feed([]byte(frame), false)
		if err != nil || blocked {
			t.Fatalf("independent streaming choices merged: blocked=%v err=%v", blocked, err)
		}
	}
	_, blocked, err := g.feed(nil, true)
	if err != nil || blocked {
		t.Fatalf("independent streaming choices merged at EOF")
	}
}
