package poison

import (
	"bytes"
	"github.com/gin-gonic/gin"
	"io"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestProtocolQueuedMetadataDoesNotRetainLargeHeap(t *testing.T) {
	g := newResponseGuard(activeSnapshot().Detector, "text/event-stream")
	frame := []byte(": " + strings.Repeat("x", 8192) + "\n\n")
	var want bytes.Buffer
	for range 160 {
		want.Write(frame)
		out, blocked, err := g.feed(frame, false)
		if blocked || err != nil || len(out) != 0 {
			t.Fatalf("metadata must remain pending: blocked=%v err=%v", blocked, err)
		}
		retained := cap(g.input)
		for _, f := range g.frames {
			retained += cap(f.wire)
		}
		if retained > 512*1024 {
			t.Fatalf("metadata queue retains %d heap bytes", retained)
		}
	}
	out, blocked, err := g.feed(nil, true)
	if blocked || err != nil || !bytes.Equal(out, want.Bytes()) {
		t.Fatalf("metadata replay mismatch err=%v", err)
	}
}

func TestProtocolPanicReleasesSpilledWire(t *testing.T) {
	var name string
	r := gin.New()
	r.Use(gin.RecoveryWithWriter(io.Discard), Middleware())
	r.GET("/", func(c *gin.Context) {
		MarkRequest(c, activeSnapshot(), "https://kedaya.ai", true)
		WrapWriter(c)
		c.Header("Content-Type", "application/json")
		_, _ = c.Writer.Write([]byte(`{"text":"` + strings.Repeat("a", wireMemoryThreshold+1)))
		gw := StatusGuard(c)
		if gw.protocol.pending.file == nil {
			t.Error("did not spill")
			return
		}
		name = gw.protocol.pending.file.Name()
		panic("test cleanup")
	})
	r.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	if name == "" {
		t.Fatal("no file created")
	}
	if _, err := os.Stat(name); !os.IsNotExist(err) {
		t.Fatalf("pending file remains after panic: %v", err)
	}
}
