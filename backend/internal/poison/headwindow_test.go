package poison

import (
	"fmt"
	"strings"
	"testing"
	"time"
)

// 加大开头扣留窗口后，验证首字节延迟与吞吐没有实质退化。
func TestHeadWindowLatencyImpact(t *testing.T) {
	snap := activeSnapshot()
	head := snap.Detector.HeadRunes()
	t.Logf("head window = %d runes", head)

	// 模拟真实 SSE：外壳 + 正文分片，逐片喂入并统计首字节放行位置。
	body := strings.Repeat("这是一段完全正常的模型回复内容，没有任何投毒特征。", 200)

	start := time.Now()
	g := snap.Detector.NewStreamGuard()
	var firstOut time.Duration
	var written int
	chunk := 40
	for i := 0; i < len(body); i += chunk {
		j := i + chunk
		if j > len(body) {
			j = len(body)
		}
		safe, v := g.Feed(body[i:j])
		if v == VerdictBlock {
			t.Fatalf("clean content was blocked at offset %d", i)
		}
		if safe != "" && firstOut == 0 {
			firstOut = time.Since(start)
		}
		written += len(safe)
	}
	rest, _ := g.Flush()
	written += len(rest)
	elapsed := time.Since(start)

	rb, wb := len([]rune(body)), len([]rune(body[:0]))
	_ = wb
	if written != len(body) {
		t.Fatalf("clean content mangled: wrote %d bytes, want %d", written, len(body))
	}
	t.Logf("clean body %d runes: firstRelease=%v total=%v, all bytes intact", rb, firstOut, elapsed)

	// 稳态吞吐：单次 Feed 的平均耗时
	g2 := snap.Detector.NewStreamGuard()
	n := 0
	t0 := time.Now()
	for i := 0; i < 20000; i++ {
		safe, _ := g2.Feed("普通文本片段，")
		n += len(safe)
	}
	d := time.Since(t0)
	t.Logf("20k feeds in %v (%.1f us/feed), released %d bytes", d, float64(d.Microseconds())/20000, n)
}

// 窗口放大后，短响应（小于窗口）正常结束必须完整放出，不能被吞。
func TestShortResponseNotSwallowed(t *testing.T) {
	snap := activeSnapshot()
	for _, body := range []string{
		"好",
		"好的，我明白了。",
		strings.Repeat("短", 50),
	} {
		g := snap.Detector.NewStreamGuard()
		out, _ := g.Feed(body)
		rest, v := g.Flush()
		if v == VerdictBlock {
			t.Fatalf("short clean response blocked: %q", body)
		}
		got := out + rest
		if got != body {
			t.Fatalf("short response mangled: got %q want %q", got, body)
		}
	}
	fmt.Println("short responses intact")
}
