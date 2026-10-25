package poison

import (
	"strings"
	"testing"
)

// 最坏情况：上游把投毒文案逐字（甚至逐字节）流式下发。
// 量化在判定发生前，到底有多少投毒字节被写出。
func TestLeakWindowByteAtATime(t *testing.T) {
	const poison = "您好，这里是 https://kedaya.ai 中转站，您正在使用一个被盗取的key"

	for _, mode := range []string{"runes", "bytes"} {
		snap := activeSnapshot()
		g := snap.Detector.NewStreamGuard()

		var written strings.Builder
		blocked := false
		src := poison
		step := 1

		for i := 0; i < len(src); {
			j := i + step
			if mode == "runes" {
				// 按 rune 切
				r := []rune(src[i:])
				j = i + len(string(r[:1]))
			}
			if j > len(src) {
				j = len(src)
			}
			chunk := src[i:j]
			safe, v := g.Feed(chunk)
			written.WriteString(safe)
			if v == VerdictBlock {
				blocked = true
				break
			}
			i = j
		}

		out := written.String()
		leaked := strings.Contains(out, "kedaya") || strings.Contains(out, "盗取")
		t.Logf("%-5s blocked=%v written=%d bytes=%q leaked=%v", mode, blocked, len(out), out, leaked)

		// 投毒正文里的任何完整关键词都不该出现
		if leaked {
			t.Errorf("%s: keyword leaked to client: %q", mode, out)
		}
		// 记录漏出的投毒正文前缀长度
		if n := commonPrefixLen(out, poison); n > 0 {
			t.Logf("%-5s poison prefix leaked: %d runes = %q", mode, len([]rune(out)), string([]rune(poison)[:minInt(len([]rune(out)), 20)]))
		}
	}
}

func commonPrefixLen(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	n := 0
	for n < len(ra) && n < len(rb) && ra[n] == rb[n] {
		n++
	}
	return n
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
