# EPUSDT Binance CNY/USDT 汇率适配服务

这是一个 Python 标准库只读服务，将币安公开 P2P `quote-price` 的 BUY 报价转换为 EPUSDT 目录式汇率：

- 上游固定为 `https://www.binance.com/bapi/c2c/v1/public/c2c/agent/quote-price`
- 请求固定为 `asset=USDT&fiat=CNY&tradeType=BUY`
- 上游 `data.price` 是 CNY/USDT，服务输出 `cny.usdt = 1 / price`
- 默认只监听 `127.0.0.1:18084`
- 默认缓存 TTL 为 60 秒，报价最大年龄为 300 秒
- 上游失败时没有固定 fallback；冷启动或 TTL 过期后刷新失败返回 HTTP 503

## 接口

`GET /rates/cny.json` 成功响应示例：

```json
{
  "cny": {"usdt": 0.14925373134328357},
  "source": "binance-p2p",
  "trade_type": "BUY",
  "cny_per_usdt": 6.7,
  "fetched_at": "2026-10-18T10:00:00Z",
  "expires_at": "2026-10-18T10:01:00Z"
}
```

`GET /rates/usd.json` 返回 `{"usd":{"usdt":1}}`，只用于现有 USD-USDT 兼容路径。

`GET /health` 返回 `status=healthy`、`stale` 或 `not_ready`，并带有 `ready`、`refreshing` 和可用时的时间信息。报价未就绪时健康接口仍返回 JSON 状态，报价接口返回 503。

服务只实现固定路径，忽略并不转发用户 URL、身份头或密钥；POST 等写方法返回 405。

## 校验与缓存

上游响应必须是 HTTP 2xx，JSON 顶层 `success=true`、`code="000000"`，`data.asset="USDT"`、`data.fiat="CNY"`，且 `price` 是非 bool 的有限正数。JSON 重复键、`NaN`/`Infinity`、字符串价格、超出 64 KiB 的响应都会失败。上游请求有 5 秒超时。

缓存刷新使用单飞锁；同一时刻只有一个上游请求。只有 TTL 内的有效报价返回成功；TTL 过期后刷新失败返回 503，健康状态显示 not_ready/stale，绝不向忽略 expires_at 的消费者重新发布旧报价。持久化最大年龄 300 秒仅限制可加载快照，不扩大 60 秒报价有效期。EPUSDT 自身的缓存语义独立，Sub2API 新建 CNY 订单仍校验适配器的报价时间。HTTP 请求线程最多16个，读写超时5秒，超额连接直接关闭。可用 `--cache-file` 或 `EPUSDT_RATE_CACHE_FILE` 启用缓存持久化，文件使用临时文件、`fsync` 和原子替换，新进程只接受时间未超前且仍在适配器最大年龄内、数值一致的快照。

## 本地运行

在本目录执行：

```text
python rate_adapter.py
```

可配置参数：

```text
python rate_adapter.py --port 18084 --timeout 5 --cache-ttl 60 --max-age 300 --cache-file ./quote.json
```

端口可配置，但服务端绑定地址固定为 `127.0.0.1`。生产示例使用专用非登录用户和 systemd 的 `StateDirectory`，见 `systemd/epusdt-rate-adapter.service`。nginx 示例只代理三个固定 GET 路径并关闭转发请求头，见 `nginx/epusdt-rate-adapter.conf`。

## 测试与联网 smoke

离线单元/并发测试不访问币安：

```text
python -m unittest discover -s tests -v
```

真实公开币安请求是单独的联网 smoke，不属于单元测试，也不执行付款：

```text
python smoke_binance.py
```

该 smoke 只读取公开 quote-price，验证当前返回能通过同一套严格解析。
