package poison

import (
	"log"

	"github.com/gin-gonic/gin"
)

// Middleware 在请求结束后统一收尾，负责两件事：
//
//  1. 正常结束时释放 StreamGuard 保留的尾部内容，避免正常回复被截断。
//  2. 命中投毒且尚未向客户端写过任何字节时，把响应改写成统一错误。
//
// 它必须注册在所有写入业务之后（在 r.Use 里与业务中间件同层即可，因为 gin 的
// c.Next() 返回时业务已执行完毕）。
//
// 注意：本中间件不做包装，包装由 WrapWriter 在拿到账号后完成——只有这样才知道
// 该请求是否满足「上游白名单 + 代理」的准入条件。
func Middleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Next()

		gw := StatusGuard(c)
		if gw == nil {
			return
		}

		blocked := gw.Blocked()
		if !blocked {
			// 未命中：释放尾部保留内容。
			if gw.Finish() {
				blocked = true
			}
		}
		if !blocked {
			return
		}

		snap := gw.snap
		message := DefaultBlockMessage
		if snap != nil && snap.BlockMsg != "" {
			message = snap.BlockMsg
		}

		// 已经写出过字节时无法回滚：此时写错误体只会拼在残片后面，客户端解析
		// 得到的是「unexpected end of JSON input」这类假的上游故障。这种情况下
		// 主动切断连接，让客户端拿到明确的传输层错误。未写出字节时仍写完整错误。
		truncated := gw.Committed() > 0
		aborted := false
		if truncated {
			aborted = gw.AbortConnection()
		}
		if !aborted {
			gw.WriteError(DefaultBlockStatus, message)
		}

		// 命中留痕：这是唯一能证明检测真的在工作、也便于事后追查哪条账号/路径
		// 触发的记录。不记录被丢弃的正文内容，避免把投毒文本再抄一遍进日志。
		accountID, _ := c.Get(ContextKeyAccountID)
		log.Printf("[poison] blocked path=%s status=%d reason=%s account=%v truncated=%v aborted=%v",
			c.Request.URL.Path, DefaultBlockStatus, gw.Reason(), accountID, truncated, aborted)

		// 命中后的副作用：拉黑出口 IP、轮换代理、必要时停用账号。
		// 在响应收尾之后异步执行，不影响客户已经拿到的错误。
		Dispatch(c, gw.Reason())
	}
}
