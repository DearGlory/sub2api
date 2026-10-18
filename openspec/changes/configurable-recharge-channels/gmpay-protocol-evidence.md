# GMwalletApp/epusdt 协议证据笔记

> 目的：对公开接口做有界、只读核查，判断 GMPay 原生、EPUSDT/GMPay 兼容、易支付（EPay）兼容是否存在可验证的金额、商户、订单绑定查询能力，以及回调字段、签名、去重和重试机制。
>
> 本笔记不是支付成功证明；未创建订单、未支付、未登录、未部署，也未读取密钥。

## 结论摘要

1. **没有找到一个同时返回“当前状态 + 金额 + 商户/订单绑定 + 有商户鉴权”的公开订单查询接口。** 官方公开状态接口是 `GET /pay/check-status/{trade_id}`，不需要签名，响应只有 `trade_id` 和 `status`。它不能独立验证金额，也没有 `pid`、`order_id` 或签名字段。
2. **`GET /pay/checkout-counter-resp/{trade_id}` 能返回金额字段，但官方文档把它定义为收银台初始化/基础订单数据接口，并明确要求当前状态另调 `check-status`。** 因此不能把它单独当作可信的支付状态查询；其通过一个公开 `trade_id` 读取金额，也不能证明调用方是该商户。
3. **创建响应和成功回调都有金额与绑定字段。** GMPay 创建响应包含 `trade_id`、商户 `order_id`、法币 `amount/currency`、链上 `actual_amount`；GMPay 回调包含 `pid`、`trade_id`、`order_id`、`amount`、`actual_amount`、`block_transaction_id`、`status` 和 HMAC-SHA256 `signature`。这些是最强的一手绑定证据，但它们分别属于创建/通知流程，不是独立的订单查询。
4. **GMPay 与 EPay 的签名协议确实区分。** GMPay 当前为排除 `signature` 后的 HMAC-SHA256；EPay 兼容接口使用排除 `sign/sign_type` 后的排序参数 + secret 的 MD5。EPay 回调字段为 `pid`、`trade_no`、`out_trade_no`、`type`、`name`、`money`、`trade_status`、`sign`、`sign_type`。
5. **transaction id 可用于去重，但不是协议级“回调事件 ID”。** GMPay 回调提供 `trade_id` 和链上/第三方交易标识 `block_transaction_id`；官方源码以 `block_transaction_id` 查重并以订单状态条件更新避免重复入账。源码没有声明独立、不可变的 webhook delivery ID。`trade_id` 是订单标识，不应误称为回调事件 ID。
6. **回调确认与重试有源码证据。** 商户回调必须返回 HTTP 200 且响应体（去空白、大小写不敏感）为 `ok` 或 `success`；否则进入队列重试。最大重试次数由 `order_notice_max_retry` 配置，间隔由 `callback_retry_base_seconds` 配置，指数退避并封顶 5 分钟。默认配置函数在未设置时分别给出 5 秒基准间隔；最大次数默认函数只说明读取配置并将负数归零，未在本次证据中确认安装默认最大次数。
7. **当前目标适配器的 `QueryOrder` 无法取得金额。** 来源 `sub2api` 固定提交 `36f66572fb2929110179d1d7a3df422d5deba1ff` 的 `backend/internal/payment/provider/epusdt.go:228-254` 只解析 `trade_id/status`，构造的 `QueryOrderResponse` 未设置 `Amount`。目标代码固定提交 `50ec1808b70faa1186cfa6831f0bca6d93687064` 的生命周期代码在 `payment_order_lifecycle.go:168-181` 对已支付查询结果要求金额有效，否则记录 `PAYMENT_INVALID_AMOUNT` 并再次查询；仅拼接 `check-status` 响应不能满足该契约。

## 证据矩阵

| 能力 | 官方路径/实现 | 鉴权 | 金额 | 商户/订单绑定 | 判断 |
| --- | --- | --- | --- | --- | --- |
| GMPay 创建 | `POST /payments/gmpay/v1/order/create-transaction` | `pid + signature`；GMPay HMAC-SHA256 | `amount` 是商户提交的法币金额；`actual_amount` 是实际需支付的加密货币数量 | 返回 `pid` 不在成功 data 中，但请求签名绑定 `pid/order_id`；响应有 `order_id/trade_id` | 可验证创建结果，不是查询接口 |
| 公开状态查询 | `GET /pay/check-status/{trade_id}` | 无签名 | 无 | `trade_id` 仅作为路径键；无 `pid/order_id` | 只能读状态，不能金额核验或证明商户归属 |
| 收银台初始化 | `GET /pay/checkout-counter-resp/{trade_id}` | 无签名 | `amount`、`actual_amount`，另有 currency/token/network | 有 `trade_id`，但无 `pid`，文档说只确认订单存在并返回基础数据 | 有金额展示证据，但不能单独作为可信支付查询 |
| GMPay 回调 | 订单 `notify_url`，POST JSON | HMAC-SHA256；`pid` 用于查本地密钥 | `amount` = 商户提交法币金额；`actual_amount` = 实际到账加密货币数量 | `pid + trade_id + order_id`，另有 `block_transaction_id` | 可验签、可绑定、可作为入账依据；需处理重试/幂等 |
| EPay 创建 | `GET/POST /payments/epay/v1/order/create-transaction/submit.php` | `pid + sign`；MD5 | 请求 `money`；成功为 302，不返回 JSON 订单金额 | 请求 `pid/out_trade_no`，服务器内部映射为 Epusdt `order_id/payment_type=Epay` | 兼容创建，不是金额查询 |
| EPay 回调 | EPay 订单 `notify_url`，GET 参数 | MD5，排除 `sign/sign_type` | `money` 为订单金额字符串 | `pid + trade_no + out_trade_no` | 可验签、可绑定；字段/签名与 GMPay 不同 |

## 一手来源与固定版本

本次源码/文档均固定到官方仓库提交：

- 仓库：<https://github.com/GMWalletApp/epusdt>
- 固定 commit：`aed4a970a28d734c8a35499496604b868a24ef7f`
- GitHub commit API：<https://api.github.com/repos/GMWalletApp/epusdt/commits/aed4a970a28d734c8a35499496604b868a24ef7f>
- API 文档（仓库内 `wiki/API.md`）：<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/wiki/API.md>
- 路由注册：<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/src/route/router.go>
- GMPay/EPay 控制器与状态接口：<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/src/controller/comm/order_controller.go>、<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/src/controller/comm/pay_controller.go>
- 响应/回调结构体：<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/src/model/response/order_response.go>、<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/src/model/response/pay_response.go>
- 订单创建与链上去重：<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/src/model/service/order_service.go>
- 回调发送、确认与重试：<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/src/mq/worker.go>
- 签名实现：<https://raw.githubusercontent.com/GMWalletApp/epusdt/aed4a970a28d734c8a35499496604b868a24ef7f/src/util/sign/sign.go>

## 详细证据

### 1. 查询接口的边界

官方 `wiki/API.md` 的接口总览列出：

- GMPay 创建：`POST /payments/gmpay/v1/order/create-transaction`，需要签名。
- 收银台初始化：`GET /pay/checkout-counter-resp/{trade_id}`，不需要签名。
- 支付状态查询：`GET /pay/check-status/{trade_id}`，不需要签名。
- EPay 兼容创建：`GET/POST /payments/epay/v1/order/create-transaction/submit.php`，需要签名。

同一文档对收银台初始化明确写明：该接口“只确认订单存在并返回基础数据；当前支付状态请调用 `/pay/check-status/{trade_id}`”。`pay_controller.go` 的注释也逐字表达同一分工；`CheckStatus` 构造的 `CheckStatusResponse` 只有 `TradeId` 与 `Status`。因此：

- `checkout-counter-resp` 的 `amount/actual_amount` 是订单展示/初始化数据，不是带商户授权的金额核验结果。
- `check-status` 的成功响应只有 `trade_id/status`，没有金额、`pid`、`order_id` 或签名。
- 路由源码显示这两个 GET 路由均没有 `CheckApiSign` 中间件；GMPay 创建路由才挂 `middleware.CheckApiSign()`。

这也解释了为什么不能单靠把 `pay/check-status` 或 `checkout-counter-resp` 的字段拼到本地响应来声称金额已被可信查询验证。

### 2. 金额定义与商户/订单绑定

官方 `wiki/API.md` 的 GMPay 创建参数/成功响应定义：

- 请求 `pid`：商户 PID，用于查找 API Key，并参与签名。
- 请求 `order_id`：商户订单号，最长 32 字符，不能重复。
- 请求 `amount`：法币金额。
- 成功响应 `trade_id`：Epusdt 交易号。
- 成功响应 `order_id`：商户订单号。
- 成功响应 `amount`：商户提交的法币金额。
- 成功响应 `actual_amount`：实际需支付的加密货币数量。

`CheckoutCounterResponse` 的官方结构体注释再次定义：`Amount` 是法币金额，`ActualAmount` 是订单实际需要支付的金额；状态 `4` 占位订单的 `actual_amount` 为 `0`。

官方订单服务源码还显示，在订单创建时，`OrderId`、`Amount`、`Currency`、`ActualAmount`、`ApiKeyID` 等写入订单；重复的商户订单号会被拒绝。这个是服务端内部绑定证据，但不会通过无签名的 `check-status` 对外提供 `pid`/金额。

### 3. GMPay 回调字段与签名

官方 `OrderNotifyResponse` 结构体定义了以下 JSON 字段：

```text
pid
trade_id
order_id
amount
actual_amount
receive_address
token
block_transaction_id
signature
status
```

官方 `wiki/API.md` 的 GMPay 回调示例和字段表给出：

- `pid`：订单所属 API Key 的 PID，商户据此查本地密钥验签。
- `trade_id`：Epusdt 交易号。
- `order_id`：商户订单号。
- `amount`：商户提交的法币金额。
- `actual_amount`：实际到账的加密货币数量。
- `block_transaction_id`：链上交易哈希或第三方支付订单号。
- `status`：当前仅支付成功时回调，值为 `2`。
- `signature`：64 位小写十六进制 HMAC-SHA256 回调签名。

`worker.go` 的发送实现构造同一结构体，使用 `sign.GetHMACSHA256`，并 POST 到订单 `NotifyUrl`。源码没有 `payment_type` 回调字段；GMPay/EPay 通过订单内部类型选择不同出站格式。

### 4. EPay 兼容字段与签名

官方 EPay 创建路由接受 GET 或 POST，并先按提交的 `pid` 查启用 API Key，再校验 `sign`。请求中 `sign`、`sign_type` 不参与签名；其他非空参数按 ASCII 排序后追加 secret，以 MD5 计算。成功时仅 302 到 `/pay/checkout-counter/{trade_id}`。

官方 `OrderNotifyResponseEpay` 结构体定义回调字段：

```text
pid
trade_no
out_trade_no
type
name
money
sign
sign_type
trade_status
```

官方 EPay 回调示例定义 `trade_status=TRADE_SUCCESS`，并以 `money` 字符串承载订单金额。`worker.go` 对 EPay 回调使用 GET query 参数，只有 HTTP 200 且响应体为 `ok`/`success` 才算成功。

### 5. 去重能力与限制

官方订单服务 `OrderProcessing` 先以 `block_transaction_id` 查询已存在的链上交易；若已存在，返回“订单区块已处理”。随后用状态条件更新订单。由此可确认：

- `block_transaction_id` 在服务端有实际去重用途，适合链上交易/第三方支付订单标识的重复入账防护。
- `trade_id`/`order_id` 用于订单定位和绑定，但不是独立的 webhook 投递 ID。
- 本次固定提交的公开接口/源码没有发现 `event_id`、`delivery_id` 或带序列号的回调投递标识。
- 重复回调仍可能发生，因此商户侧必须按订单/交易标识和已处理状态幂等。

### 6. 回调确认、重试与超时边界

官方 `mq/worker.go` 的 `sendOrderCallback` 和调度代码给出可验证规则：

- GMPay：HTTP POST JSON；EPay：HTTP GET query 参数。
- 只有 HTTP 状态码 `200` 且响应体 trim 后为 `ok` 或 `success`（大小写不敏感）才确认成功。
- 其他 HTTP 状态、网络错误或非确认文本都会保留未确认状态，进入回调队列。
- `isCallbackDue` 按 `CallbackNum` 与 `order_notice_max_retry` 判断是否还应尝试。
- `callbackRetryDelay` 以 `callback_retry_base_seconds` 为基准指数翻倍，最大 5 分钟。
- `config.GetCallbackRetryBaseDuration()` 在配置值小于等于 0 时使用 5 秒。
- `config.GetOrderNoticeMaxRetry()` 只读配置，负值按 `0` 处理；本次未找到一个可确认的安装默认最大次数，因此该数值应视为部署配置而非协议常数。

源码还显示回调前会重新加载订单并要求订单是支付成功且未确认；发送成功才把回调确认标记为成功。这里有明确的重试机制，但本次未确认底层 HTTP 客户端的单请求连接/读取超时时间，因此“单次请求超时秒数”仍是未决项。

## 对当前目标适配器的影响

来源仓库 `E:/Global-session/repos/sub2api` 固定提交 `36f66572fb2929110179d1d7a3df422d5deba1ff` 的 `backend/internal/payment/provider/epusdt.go`：

- 创建请求发往 `/payments/gmpay/v1/order/create-transaction`。
- 查询请求发往 `/pay/check-status/{trade_id}`。
- `epusdtStatusData` 只有 `TradeID` 与 `Status`。
- `QueryOrder` 在 `:228-254` 将状态 `1/4/2/3` 映射为 pending/paid/failed，最终只返回 `TradeNo` 与 `Status`，没有 `Amount`。
- 回调验证则要求 JSON、64 位十六进制 signature、匹配 `pid`，并读取 `order_id`、`trade_id`、`amount`、`status`、`block_transaction_id`；这一侧具备金额与绑定字段。

目标仓库 `E:/Global-session/xiao-20261012-submem/integration` 固定提交 `50ec1808b70faa1186cfa6831f0bca6d93687064` 的 `backend/internal/service/payment_order_lifecycle.go:168-181` 在查询到已支付时检查 `resp.Amount`；金额无效会记录 `PAYMENT_INVALID_AMOUNT`，并最多再查一次，仍不满足则不入账。因此，当前 `check-status` 查询路径没有一手金额来源，不能宣称完成金额验证。

## 多网络切换与回调绑定补充证据

官方固定提交 `aed4a970a28d734c8a35499496604b868a24ef7f` 的 `src/model/service/order_service.go:505-758`、`src/controller/comm/order_controller.go` 和 `src/mq/worker.go` 显示：

- 创建时传入 `token=USDT` 与一个 `network` 后，收银台仍可调用 `POST /pay/switch-network` 切换到另一项已启用的资产／网络；网络与资产能力列表由公开配置接口提供。
- 创建时省略 token/network 会产生 `status=4` 的占位父单，首次选择可原地补全；切到不同目标时可能创建子单。子单不能继续切换，父单最多一个子单。
- 子单成功后，网关把支付信息归并回父单，并通常向商户通知父单的 `trade_id/order_id`；子单不单独回调。切换可能导致实际支付网络与第一次请求的 network 不同。
- 回调包含 `token` 和交易标识，但没有 `network` 或 `currency` 字段。本站可保存用户选择的 `requested_network`，但不能把它命名为 `settled_network` 或声称回调证明了实际链网络。

因此，多网络首版的最小安全契约是：用户显式选网；订单保存 `requested_network`；自动入账只校验签名、PID、父订单、金额、USDT token 和交易去重；网络一致性若业务必须保证，则需网关侧禁用切换、增加网络回调字段或先做真实端到端验证。没有这些条件，网络敏感订单需进入人工核对，不能由本站适配器强行宣称网络锁定。

- 官方公开接口是否另有未列入仓库 `wiki/API.md` 的、需要商户签名的订单详情/订单查询端点：本次固定提交的公开路由和文档中未发现，不能排除未来版本或私有部署分支存在。
- `checkout-counter-resp` 返回的金额来自订单内部数据，文档未给出商户鉴权；不能据此推导“调用者拥有该 PID 的查询权限”。
- `block_transaction_id` 的唯一性/格式约束由各支付网络或第三方 provider 决定；源码证明服务端用它去重，但未在本次核查中证明跨网络全局唯一。
- 单次商户回调 HTTP 请求的 connect/read timeout 未在已读取的一手源码片段中确认；已确认的是失败后的队列重试次数配置、指数退避和 5 分钟上限。
- 官方文档说 GMPay `status=2` 为成功；EPay 使用 `trade_status=TRADE_SUCCESS`。是否存在其它终态或 provider 特有状态，应以固定版本源码和实际部署配置继续核对，不能只按 `check-status` 的四值表外推。

## 本地对照提交

- 目标：`E:/Global-session/xiao-20261012-submem/integration`，`HEAD=50ec1808b70faa1186cfa6831f0bca6d93687064`
- 来源：`E:/Global-session/repos/sub2api`，固定提交 `36f66572fb2929110179d1d7a3df422d5deba1ff`
- 本次只新增本文件；未修改业务代码、配置、测试或仓库历史。
