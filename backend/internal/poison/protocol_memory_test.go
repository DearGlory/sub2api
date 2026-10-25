package poison

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProtocolPendingWireDoesNotRetainLargeHeap(t *testing.T) {
	for _, mode := range []string{"application/json", "text/event-stream"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("TMP", dir)
			t.Setenv("TEMP", dir)
			t.Setenv("TMPDIR", dir)
			g := newResponseGuard(activeSnapshot().Detector, mode)
			body := `{"content":[{"text":"normal"}],"metadata":"` + strings.Repeat("x", 1024*1024) + `"}`
			wire := body
			if mode == "text/event-stream" {
				wire = "data: " + body + "\n\n"
			}
			var got bytes.Buffer
			for i := 0; i < len(wire); i += 4096 {
				out, blocked, err := g.feed([]byte(wire[i:min(i+4096, len(wire))]), false)
				if err != nil || blocked {
					t.Fatalf("normal input rejected: %v", err)
				}
				got.Write(out)
				retained := cap(g.input)
				for _, f := range g.frames {
					retained += cap(f.wire)
				}
				if retained > 512*1024 {
					t.Fatalf("pending wire retains %d heap bytes", retained)
				}
			}
			out, blocked, err := g.feed(nil, true)
			got.Write(out)
			if blocked || err != nil || got.String() != wire {
				t.Fatalf("spooled wire changed: got=%d want=%d err=%v", got.Len(), len(wire), err)
			}
			files, err := filepath.Glob(filepath.Join(dir, "sub2api-poison-wire-*"))
			if err != nil || len(files) != 0 {
				t.Fatalf("spool not removed: files=%v err=%v", files, err)
			}
		})
	}
}

func TestWireSpoolRemovesFileOnClose(t *testing.T) {
	var spool wireSpool
	body := bytes.Repeat([]byte("x"), wireMemoryThreshold+1)
	if err := spool.append(body); err != nil {
		t.Fatal(err)
	}
	if spool.file == nil {
		t.Fatal("fixture did not spill")
	}
	path := spool.file.Name()
	got, err := spool.bytes()
	if err != nil || !bytes.Equal(got, body) {
		t.Fatal("spool changed bytes")
	}
	spool.close()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("spool remains: %v", err)
	}
}
