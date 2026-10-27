# 共享代理与复测（shared coordinator）— 文件、键与卸载清单

本功能取代旧的“占用排除 + 永久拉黑”处置：所有符合防投毒检测的账号共用一个代理，
命中后整批切到下一个代理，并用 sub2api 既有探针复测旧代理，全部干净才解黑。

## 源码

| 文件 | 作用 |
|---|---|
| `shared_contract.go` | 父级冻结的共享类型（本 lane 不改） |
| `shared_state.go` | settings 文档模型：指针、代次、run/cell 账本，有界保留（20 条） |
| `shared_store.go` | SQL 层：准入账号读取/按 ID 锁、代理读取、黑名单 before-image 与精确删除 |
| `shared_coordinator.go` | `SharedCoordinator`：Reconcile / Handle / State / EnqueueBackfill / Start / Stop |
| `shared_worker.go` | worker：lease 认领、网络探测在事务外、结果回写、解黑、代次 CAS 切回 |
| `shared_*_test.go` | 真实 PostgreSQL 行为测试（独立 schema 隔离） |

## 持久化键（设置表）

| 键 | 内容 |
|---|---|
| `poison_guard_shared_state` | 整份协调文档 JSON（指针、generation、runs/cells、lease、before-image） |
| `poison_guard_shared_enabled` | 共享模式开关（父级配置读取，本 lane 不写） |
| `accounts.extra.poison_guard_shared_generation` | 账号当前代次，attach 时读入 `AccountInfo.SharedGeneration` |

无新表、无迁移：黑名单仍用 `poison_blocked_egress`，快照刷新仍用
`scheduler_outbox(event_type='account_bulk_changed')`。

## 语义要点

- 切换与切回都是**一个事务**：`pg_advisory_xact_lock(RotationLockKey)` → settings 行 `FOR UPDATE`
  → 账号 `FOR UPDATE ... ORDER BY id` → 只写 `proxy_id` + `extra` 单键（`jsonb_set`）+ 一条 outbox。
- 只动代理：`status` / `schedulable` / `credentials` / 其他 `extra` 保留；inactive 与
  `schedulable=false` 的准入账号也一起切，但**不**因此启用。
- 候选允许 occupied；禁用、软删、黑名单代理不入选；同 endpoint 视为没换。
- 解黑删除按 `outbound_ip + id + hit_count` 三元组匹配 before-image：期间出现新命中时删除
  0 行，条目保留，且**不会**切回仍被拉黑的出口。
- 自动任务全 clean → 代次 CAS 后切回；历史补测（`EnqueueBackfill`）全 clean → 只解黑不切回。
- 任一 poison 立即确认保留黑名单并停止该轮（决定已终局）；inconclusive 一律重新排队退避重试，
  永不当作 clean，解黑必须 `clean == expected`。
- 软删代理仅用于探测（读取保留的配置），不恢复 `deleted_at`、不成为 active 目标。

## 卸载

1. 删除 `shared_*.go`（含测试）。
2. `DELETE FROM settings WHERE key IN ('poison_guard_shared_state','poison_guard_shared_enabled');`
3. 清 `accounts.extra` 的 `poison_guard_shared_generation`
   （`UPDATE accounts SET extra = extra - 'poison_guard_shared_generation'`）。
4. 父级移除 `/api/v1/admin/poison/shared*` 路由、Handler 分流与 server 启停接线。
5. `poison_blocked_egress` 表与迁移 251 属于既有功能，按原卸载说明处理。
