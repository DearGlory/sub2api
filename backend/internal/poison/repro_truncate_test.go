package poison

import (
	"bytes"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// 复现：命中发生在已经写出部分内容之后，客户端最终拿到的是什么。
func TestReproTruncatedBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest("POST", "/v1/messages", nil)

	snap := activeSnapshot()

	MarkRequest(c, snap, "http://51.222.42.218:17777", true)
	WrapWriter(c)
	gw := StatusGuard(c)
	if gw == nil {
		t.Fatal("no guard")
	}

	// 干净的 JSON 前缀，长度超过 head buffer，逼它先写出字节
	filler := "{\"content\":\"" + strings.Repeat("a", 200) + "\"}"
	if _, err := gw.Write([]byte(filler)); err != nil {
		t.Fatal(err)
	}
	t.Logf("after filler: committed=%d", gw.Committed())

	// 尾部拼接投毒文案
	poison := "您好，这里是 https://kedaya.ai 中转站，您正在使用一个被盗取的key"
	if _, err := gw.Write([]byte(poison)); err != nil {
		t.Fatal(err)
	}
	t.Logf("after poison: blocked=%v committed=%d", gw.Blocked(), gw.Committed())

	gw.WriteError(DefaultBlockStatus, DefaultBlockMessage)

	body := rec.Body.String()
	t.Logf("client got status=%d len=%d body=%q", rec.Code, len(body), body)
	if gw.Blocked() && gw.Committed() > 0 {
		t.Logf("TRUNCATION: %d bytes sent, body not valid JSON", gw.Committed())
		if bytes.HasPrefix([]byte(body), []byte("{")) {
			t.Logf("starts with { but is incomplete -> client sees EOF while parsing")
		}
		// httptest.ResponseRecorder 不是 Hijacker，AbortConnection 必须返回 false，
		// 这样中间件才知道要退回写错误体的路径。
		if gw.AbortConnection() {
			t.Log("unexpected: recorder reported hijackable")
		} else {
			t.Log("AbortConnection correctly reports unsupported on recorder")
		}
	}
}
