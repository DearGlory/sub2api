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
		defer func() {
			if gw := StatusGuard(c); gw != nil {
				gw.Close()
				if c.Request != nil && gw.parentContext != nil {
					c.Request = c.Request.WithContext(gw.parentContext)
				}
			}
		}()
		c.Next()
		Finalize(c)
	}
}

// Finalize completes the response before a capture middleware releases its writer.
// The outer fallback can call it again without writing or dispatching twice.
func Finalize(c *gin.Context) {
	gw := StatusGuard(c)
	if gw == nil {
		return
	}
	gw.mu.Lock()
	if gw.finalized {
		gw.mu.Unlock()
		return
	}
	gw.finalized = true
	gw.mu.Unlock()
	defer func() {
		if gw.cancel != nil {
			gw.cancel()
		}
		if c.Request != nil && gw.parentContext != nil {
			c.Request = c.Request.WithContext(gw.parentContext)
		}
	}()

	if !gw.Blocked() && !gw.Finish() {
		return
	}
	message := DefaultBlockMessage
	if gw.snap != nil && gw.snap.BlockMsg != "" {
		message = gw.snap.BlockMsg
	}
	committed := gw.Committed()
	aborted := false
	if committed > 0 {
		aborted = gw.AbortConnection()
	} else {
		gw.WriteError(DefaultBlockStatus, message)
	}
	if gw.protocolErr != nil {
		log.Printf("[poison] invalid upstream stream path=%s committed_bytes=%d aborted=%v", c.Request.URL.Path, committed, aborted)
		return
	}
	accountID, _ := c.Get(ContextKeyAccountID)
	log.Printf("[poison] blocked path=%s status=%d reason=%s account=%v committed_bytes=%d truncated=%v aborted=%v",
		c.Request.URL.Path, DefaultBlockStatus, gw.Reason(), accountID, committed, committed > 0, aborted)
	Dispatch(c, gw.Reason())
}
