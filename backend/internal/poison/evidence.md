# 命中响应取证

模块位于 `internal/poison/evidence.go`，不需要数据库表。设置仅有：

| 键 | 默认值 | 作用 |
|---|---|---|
| `poison_guard_evidence_enabled` | `false` | 仅在既有防投毒准入成功的账号尝试启用 |
| `poison_guard_evidence_dir` | `./data/poison-evidence` | 持久卷中的独立受限目录 |

设置随现有 Store.Reload 快照热更新，单个账号尝试使用 Attach 时的快照。关闭或未准入时不创建 evidence session、body wrapper、spool 或 goroutine。父级设置 API 和处置回写属于外部装配。

## 保存与生命周期

每次 Attach 分配密码学随机 evidence ID，入口 request ID 仅作元数据，绝不拼接路径。正常请求在内存暂存，达到存储层阈值后写 `.pending-*` 目录；阈值不是响应截断限制。Body.Close 不删除暂存，因为非流式协议可能先 ReadAll/Close，后 Finish 才命中。非命中 Finalize、GuardWriter.Close、重试和 panic 清理临时目录。

命中由原 detector 给出，Feed/Flush/Finish 先快照去重词、计数、阈值、lane、检测字符进度，再清理协议状态。解析错误不视为关键词命中。命中时冻结捕获；Read 返回与冻结在线性化锁下决定是否纳入。模块不追加 read、不 drain、不改变取消策略。

命中 Finalize 写 body 和 metadata 后同文件系统原子 rename 发布 `<random-id>/`，完成后设置 gin 的 `poison_guard_evidence_id` 与 `poison_guard_evidence_path`。已确认命中后若发布失败，仍保留 evidence_id 用于关联错误，path 为空；正常和解析错误请求不生成命中收据。目录 0700，文件 0600。原文可能含用户内容，只在该受限目录保存；不进入日志或客户端响应。命中目录不自动删除，容量监控/保留策略需显式制定。

`WriteEvidenceDisposition(path, value)` 在命中目录内原子发布 `disposition.json`；调用方仅传已经脱敏的处置收据。该模块不引用轮换 lane 的类型。

## 捕获层级与读取边界

- `transport_response_body`：统一 doUpstreamRequest 返回成功后、应用解压前的 Body.Read 字节。包括 Do/DoWithTLS 共用路径。它不是网络帧，标准 Transport 自动 gzip 解压时记录 `uncompressed=true`，不能声称保存了线上压缩字节。
- `decoded_upstream_body`：应用显式解压后的补充副本，与原始捕获分开文件。自动解压时不重复保存。
- `plugin_http_response_body`：插件交给核心的响应 body；不能证明插件内部是否改写过内容。
- `websocket_message_payload`：单次 HTTP→WS forward 的上游消息 payload 原样连接。紧邻的 `websocket_message_lengths_uint64be` 文件逐消息记录 8 字节大端长度，按顺序切分可还原消息边界。上下文属于 forward，绝不绑定池化连接；在 JSON 修复/拆分和 SSE 重编码前捕获。WS 文件不冒称 HTTP EOF，`complete=false`。

metadata 含账号/代理 ID、ctxkey.RequestID / Model、入口 URL.Path（无 query）、状态和白名单内容头、层级、SHA256、捕获字节数、EOF/Closed/read error，以及命中快照和下游已提交字节数。`capture_end_offset` 是 Read 返回前缀边界，可能包括 bufio/压缩器预读，**不是命中词最后一个字节的精确 offset**；`inspected_runes` 也不是原始字节 offset。HTTP 仅观测 EOF 且无读取/捕获错误时声明 complete。

I/O 失败只记短类别、evidence_id、请求/账号/代理关联及已捕获字节数，丢弃未能可靠发布的暂存，不改变放行/阻断/自动处置。不会打印原始 error 中可能携带的 URL、凭据。进程硬崩溃可能留下 `.pending-*`，不提供自动清扫，以免多进程误删活跃暂存；运维清理必须确认无活动实例持有。已确认命中后发生 panic 时，中间件展开路径先幂等保存证据和触发处置，再清理临时资源，不再触碰已经释放的响应 writer。

现有 WS ingress 直接连接写出不经过 GuardWriter，本模块没有扩展其检测覆盖。GatewayHandler.Responses 两条 ForwardAsResponses 已改用 Attach 后 c.Request.Context()。

## 管理员恢复与迟到处置

恢复代次保存于已有 `accounts.extra.poison_guard_restore_epoch`，缺省为零。管理员显式启用账号、启用调度、批量恢复，以及清除账号错误时，仓库把代次递增与状态修改及调度 outbox 放在同一事务；普通编辑保留数据库当前代次，客户端 extra 不能写入或回退它。自动成功测试恢复不携带管理员标记。

选号快照（包括调度 metadata 投影）携带代次。命中处置在入口以及停号/换绑事务的账号行锁内复核代次、代理和状态；管理员恢复后，旧请求的处置变成 stale，新请求使用新代次继续接受检测。审计落盘时间不参与判断，也不增加普通转发的数据库查询。该保证适用于运行此实现的实例；部署排空期间仍运行的旧二进制不具备该保护。

删除整项防投毒功能时，同时移除 restore_epoch 接线、仓库保护和调度字段，并按维护计划删除该内部 JSON 键；不新增表或迁移。取证开关只控制原始响应留存，不控制恢复代次与处置保护。
