# 充值功能集成进度与验收记录

## 当前边界

- 目标工作树：`E:/Global-session/xiao-20261012-submem/integration`。
- 已复核分支：`prod/0.2.15-custom`，HEAD 为 `50ec1808b70faa1186cfa6831f0bca6d93687064`。
- 下列结果针对未提交的工作树，不是该 HEAD 原始内容的测试结论。没有 commit、push、生产部署、真实付款或网关部署。
- 复用本地来源及既有功能 worktree；未 clone 或 fetch。
- 旧批次 `deleg_20f182a8` 为重启中断；后续实现由父助手在当前整合树完成并逐项复核。没有存活的独立后端子任务依赖本次交付。

## 已集成并执行验证

### 外部购卡

- 独立启用、URL、入口名称、购买兑换说明和展示方式贯通 settings 保存、读取、公开 DTO、初始化注入。
- 配置卡片位于“系统设置 → 支付设置”；内置支付关闭时仍可配置并显示外部购卡。
- 侧栏及购买页路由检查独立开关和合法地址；已有订单页等内置支付路由不因此开放。
- 用户页沿用原 card/btn/input 样式；展示配置名称和说明，并提供回本站 `/redeem` 及不带 referrer 的新窗口入口。
- `both` / 兼容 `embed` 模式均保留新窗口备用；`new_window` 不加载 iframe。
- URL 辅助函数不追加身份，移除保留的身份／来源 query 参数；iframe 与新窗口均设置 no-referrer。
- 内置支付关闭时不会恢复旧支付快照遮住外部页面，也不发起微信恢复下单或订阅数据请求。
- 配置变更纳入既有设置审计；CSP origin 收集仅在外部购卡启用时纳入对应合法 HTTPS origin。

### USDT 用户与服务商 UI

- EPUSDT 加入支付类型、服务商创建选项、provider 表单和展示名称；不是只增加常量而遗漏创建入口。
- 用户必须显式选择后端开放的网络；没有网络或没有选择时禁止提交。页面提交包含 `requested_network`。
- USDT 不出现在订阅支付方式中；切换到订阅选择现有可用渠道，只有 USDT 时不能提交订阅。
- 新 EPUSDT 实例默认关闭；管理界面资产限定 USDT，计价限定 USD。
- Provider 对话框和卡片不暴露 EPUSDT 退款开关，保存时不保留旧数据中的退款启用值。服务端退款拒绝由后端工作流负责，不能由 UI 保护替代。

## 实际测试证据

在父树使用现有依赖执行，不修改 `frontend/pnpm-lock.yaml`：

| 检查 | 命令／范围 | 真实结果 |
|---|---|---|
| 前端全量 | `./node_modules/.bin/vitest run --reporter=dot` | **405 个测试文件通过；3337 项通过，3 项跳过；退出码 0** |
| 前端类型 | `./node_modules/.bin/vue-tsc --noEmit` | 退出码 0 |
| 前端专项 | 外部购卡、PaymentView、SettingsView、PaymentProviderDialog、providerConfig、feature-access | 6 个文件、136 项通过；退出码 0 |
| 前端 CI 命令预检 | `CI=1 pnpm exec vitest run ... --runInBand` | pnpm 在启动测试前因 `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` 退出；现有 `node_modules` 下直接运行同一组 3 个文件为 **60 项通过** |
| 前端生产构建 | `./node_modules/.bin/vue-tsc -b && ./node_modules/.bin/vite build` | 退出码 0；Vite built；仅有既有 chunk size/Browserslist 提示，未部署 |
| 后端编译 | `go test -tags=unit ./internal/payment/... ./internal/handler ./internal/handler/admin ./internal/service ./internal/server/routes -run TestDoesNotExist -count=1` | 相关包编译通过，退出码 0 |
| 后端 provider | `go test -tags=unit ./internal/payment/... -count=1` | 通过，退出码 0 |
| 后端 handler/routes | `go test -tags=unit ./internal/handler ./internal/handler/admin ./internal/server/routes -count=1` | 通过，退出码 0 |
| 后端支付专项 | EPUSDT、签名通知、人工核对、订单快照、独立限额、退款阻断、开关过滤 | 通过，退出码 0 |
| 后端迁移 runner | 246 号 EPUSDT `payment_trade_no` 唯一索引；历史重复预检与索引创建回归 | 通过，退出码 0 |
| 双语完整性 | 全量包含 `src/i18n/__tests__/localeKeyCompleteness.spec.ts` | 通过 |
| 格式与锁文件 | `git diff --check`，`git diff --exit-code -- frontend/pnpm-lock.yaml` | 退出码 0；没有临时 `frontend/pnpm-workspace.yaml` |

新增前端测试已实际抓到并修复：隐式选择首个网络、订阅保留 USDT、仅 USDT 时订阅仍可提交、provider 创建选项缺 EPUSDT、旧 provider 退款值仍提交、新实例默认开启、资产币种选项不受限，以及旧支付快照覆盖外部入口。

前端测试中的 API 为 mock，证明组件行为和请求契约；不证明真实服务器持久化、浏览器 CSP 或真实收款。日志仍存在既有组件 stub 与 Browserslist 提示，未把它们描述为零警告。

## 当前剩余闸门

1. 独立只读审查仍需返回最终 verdict；父助手已根据代码路径独立复测关键边界。
2. 本轮 `go test -tags=unit ./internal/payment/... ./internal/handler ./internal/handler/admin ./internal/service ./internal/server/routes -count=1` 退出码为 1；`payment`、`handler`、`handler/admin`、`server/routes` 通过，`internal/service` 有 26 个失败。`backend-baseline-comparison.md` 记录了同 HEAD 干净树的相同失败集合，主要是 Windows 文件关闭检查、回放 fixture 和 Ollama stale CAS；本次不能把 service 全量写成全绿，也未把这些基线失败归因于充值改动。
3. 真实浏览器、真实网关、匹配数据库集成、生产环境和小额支付联调未执行。外部店铺是否实际发放适用于本站的余额码尚需运营核对。
4. 没有执行 commit、push、生产部署、网关部署、真实付款或退款。

## 已验证的后端边界

- EPUSDT/GMPay 签名回调没有网络证明时进入人工核对；状态查询不提供金额，不用于缺金额自动补账。
- USDT 订单在创建时固定资产、USD、请求网络、倍率、手续费、宽限分钟和自动入账截止时间；取消/过期只会把截止点收敛到更早时间。
- USDT 事务化履约在生产数据库使用行锁，SQLite 测试夹具使用同事务条件更新；超出截止时间的回调保留回调证据并进入人工队列。
- 人工确认按原订单金额幂等入账，拒绝要求备注；跨订单交易号和链上交易号会被检查，USDT 自动/自助退款均阻断。
- 关闭 EPUSDT 后 `/checkout-info` 和 `/limits` 都过滤该方法并重算全局范围；配置读取异常时 `/limits` 失败关闭。
- 普通渠道每日限额继续共享原有普通余额口径，USDT 使用独立 USD 每日限额；USDT 不进入订阅支付。
- 外部购卡不附加本站登录身份、用户 ID 或来源 URL，保留回本站兑换入口和新窗口备用入口。


## 后续合并纪律

- 后端子树仅取实际新增 delta，保留已整合的外部字段、前端选网与回归测试；不整文件回退到旧共同基线。
- USDT 经营配置接口已与 backend lane 按实际代码冻结，前端表单/quote 已接。下一步合并验收后端，并依实际管理员核对 API 接人工核对 UI，再重跑相关验证。
- 子任务完成、测试执行、独立审查、部署读回、真实收款分别记账；任何前一项通过都不等于下一项获准。
