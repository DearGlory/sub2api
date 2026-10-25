package poison

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestReviewResponsesSummaryLanesRemainIndependent(t *testing.T) {
	g := newResponseGuard(activeSnapshot().Detector, "text/event-stream")
	defer g.clear()
	for i, text := range []string{"keda", "ya"} {
		frame := fmt.Sprintf("data: {\"type\":\"response.reasoning_summary_text.delta\",\"output_index\":0,\"summary_index\":%d,\"delta\":%q}\n\n", i, text)
		_, blocked, err := g.feed([]byte(frame), false)
		if blocked || err != nil {
			t.Fatalf("independent summaries concatenated: blocked=%v err=%v", blocked, err)
		}
	}
}

func TestReviewResponsesLocalDoneUnblocksFollowingText(t *testing.T) {
	g := newResponseGuard(activeSnapshot().Detector, "text/event-stream")
	defer g.clear()
	frames := []string{
		`{"type":"response.reasoning_summary_text.delta","output_index":0,"summary_index":0,"delta":"brief"}`,
		`{"type":"response.reasoning_summary_text.done","output_index":0,"summary_index":0,"text":"brief"}`,
		`{"type":"response.output_item.done","output_index":0,"item":{"type":"reasoning","summary":[{"type":"summary_text","text":"brief"}]}}`,
	}
	for range 4 {
		frames = append(frames, fmt.Sprintf(`{"type":"response.output_text.delta","output_index":1,"content_index":0,"delta":%q}`, strings.Repeat("normal ", 100)))
	}
	var got bytes.Buffer
	for _, frame := range frames {
		out, blocked, err := g.feed([]byte("data: "+frame+"\n\n"), false)
		if blocked || err != nil {
			t.Fatalf("clean response rejected: %v", err)
		}
		got.Write(out)
	}
	if !strings.Contains(got.String(), "normal ") {
		t.Fatal("local reasoning done kept later clean output buffered")
	}
}

func TestReviewPendingFramesUseBoundedFileCount(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMP", dir)
	t.Setenv("TEMP", dir)
	t.Setenv("TMPDIR", dir)
	g := newResponseGuard(activeSnapshot().Detector, "text/event-stream")
	defer g.clear()
	frame := []byte(": " + strings.Repeat("x", 8192) + "\n\n")
	var want bytes.Buffer
	for range 160 {
		want.Write(frame)
		if _, blocked, err := g.feed(frame, false); blocked || err != nil {
			t.Fatalf("input rejected: %v", err)
		}
	}
	files, err := filepath.Glob(filepath.Join(dir, "sub2api-poison-wire-*"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) > 2 {
		t.Fatalf("pending response owns %d open spool files, want at most 2", len(files))
	}
	out, blocked, err := g.feed(nil, true)
	if blocked || err != nil || !bytes.Equal(out, want.Bytes()) {
		t.Fatalf("replay changed wire: %v", err)
	}
	files, _ = filepath.Glob(filepath.Join(dir, "sub2api-poison-wire-*"))
	if len(files) != 0 {
		t.Fatalf("spool files remain after replay: %d", len(files))
	}
}
