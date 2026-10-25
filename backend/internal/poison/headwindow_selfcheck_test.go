package poison

import (
	"strings"
	"testing"
)

// 自证：开头窗口真的在起作用。
//
// 判据用「放行发生时已喂入的 rune 数」而不是「此前已放行的 rune 数」：
// 缓冲区攒满窗口后会一次性交出，此时此前放行量当然还是 0，用后者会把自己判成违规。
// 正确的安全性质是——在任何字节被写出之前，至少已经看过 head 个字符。
func TestHeadWindowActuallyHolds(t *testing.T) {
	snap := activeSnapshot()
	head := snap.Detector.HeadRunes()
	if head < 100 {
		t.Fatalf("head window unexpectedly small: %d", head)
	}
	t.Logf("head=%d runes", head)

	g := snap.Detector.NewStreamGuard()
	body := strings.Repeat("正常内容", 400)

	fed := 0            // 已喂入的 rune 数
	firstOutAtFed := -1 // 首次放行时已喂入多少 rune
	released := 0
	chunk := 10
	for i := 0; i < len(body); i += chunk {
		j := i + chunk
		if j > len(body) {
			j = len(body)
		}
		piece := body[i:j]
		safe, _ := g.Feed(piece)
		if n := len([]rune(safe)); n > 0 {
			if firstOutAtFed < 0 {
				firstOutAtFed = fed
			}
			released += n
		}
		fed += len([]rune(piece))
	}
	t.Logf("released=%d fed=%d firstOutAtFed=%d head=%d", released, fed, firstOutAtFed, head)

	if firstOutAtFed < 0 {
		t.Fatalf("nothing was ever released during feed — window may be unbounded")
	}
	if firstOutAtFed < head {
		t.Fatalf("HEAD WINDOW NOT ENFORCED: released after only %d runes fed, window=%d", firstOutAtFed, head)
	}
	rest, _ := g.Flush()
	if got := released + len([]rune(rest)); got != len([]rune(body)) {
		t.Fatalf("content lost: %d of %d runes", got, len([]rune(body)))
	} else {
		t.Logf("window enforced (first release at %d >= %d); full body intact", firstOutAtFed, head)
	}
}
