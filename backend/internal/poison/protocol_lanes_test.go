package poison

import (
	"fmt"
	"strings"
	"testing"
)

func TestReviewFinishedShortBlockDoesNotStallFollowingStream(t *testing.T) {
	g := newResponseGuard(activeSnapshot().Detector, "text/event-stream")
	frames := []string{
		"data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"thinking\":\"brief reasoning\"}}\n\n",
		"data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
	}
	for i := 0; i < 4; i++ {
		frames = append(frames, fmt.Sprintf("data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"text\":%q}}\n\n", strings.Repeat("normal ", 100)))
	}
	var released strings.Builder
	for _, frame := range frames {
		out, blocked, err := g.feed([]byte(frame), false)
		if blocked || err != nil {
			t.Fatalf("normal stream rejected: blocked=%v err=%v", blocked, err)
		}
		released.Write(out)
	}
	if !strings.Contains(released.String(), "normal") {
		t.Fatal("completed short reasoning block stalled subsequent long text until EOF")
	}
}

func TestReviewCompletedGuardDropsBuffers(t *testing.T) {
	g := newResponseGuard(activeSnapshot().Detector, "text/event-stream")
	_, _, _ = g.feed([]byte("data: {\"delta\":{\"text\":\"normal\"}}\n\n"), false)
	_, _, _ = g.feed(nil, true)
	if cap(g.input) != 0 || cap(g.frames) != 0 || len(g.lanes) != 0 {
		t.Fatalf("finalized response retains input=%d frames=%d lanes=%d", cap(g.input), cap(g.frames), len(g.lanes))
	}
}
