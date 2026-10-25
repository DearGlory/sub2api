package poison

import (
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 关键场景：第一个账号失败、failover 到第二个账号。
//
// attachPoisonGuard 在每轮 failover 循环里都会被调用。若第二轮的账号不在
// 准入范围内（无代理或前缀不匹配），WrapWriter 会直接返回、不替换 writer，
// 但 c.Writer 里留着的仍是第一个账号包装的 GuardWriter——它的缓冲区可能还
// 扣着第一个账号的尾部内容。此时若不做收尾，第二个账号的正常响应会被污染。
func TestFailoverAcrossScopeBoundary(t *testing.T) {
	gin.SetMode(gin.TestMode)
	snap := activeSnapshot()

	poisonFirst := "event: content_block_delta\ndata: {\"text\":\"" + strings.Repeat("a", 150) + "\"}\n\n"
	cleanSecond := "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"

	r := gin.New()
	r.Use(Middleware())
	r.POST("/v1/messages", func(c *gin.Context) {
		// 第一轮：命中准入，写入一段内容（未命中投毒，尾部被扣留）
		MarkRequest(c, snap, "https://kedaya.ai", true)
		WrapWriter(c)
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.Write([]byte(poisonFirst))

		// 第二轮：failover 到不在准入范围的账号
		MarkRequest(c, snap, "https://api.other.com", false)
		WrapWriter(c) // 已包装则直接 return，不会重置缓冲区
		_, _ = c.Writer.Write([]byte(cleanSecond))
	})

	rec := httptest.NewRecorder()
	req := httptest.NewRequest("POST", "/v1/messages", nil)
	r.ServeHTTP(rec, req)

	got := rec.Body.String()
	want := poisonFirst + cleanSecond
	t.Logf("want=%d actual=%d", len(want), len(got))
	if got != want {
		t.Logf("MISMATCH: lost %d bytes", len(want)-len(got))
		t.Logf(" want_tail=%q", tail(want, 50))
		t.Logf(" got_tail =%q", tail(got, 50))
	} else {
		t.Log("OK: no bytes lost across failover")
	}
}
