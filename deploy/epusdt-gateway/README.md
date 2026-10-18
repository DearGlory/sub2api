# EPUSDT unified-checkout compatibility patch

Upstream: `GMWalletApp/epusdt` revision `619cecb11d6bbd1dcdd1b698ee08b37fc722d3e3` (v2.0.0).
Candidate build version: `v2.0.0-glorycode.1`.

This patch keeps Sub2API's USDT entry independent of network selection. Users select their network inside the gateway. The Sub2API request omits both token and network, allowing the upstream status-4 checkout flow.

## Scope

- GMPay callbacks retain the original merchant order and parent trade identifiers.
- For a settled child, callback token, actual amount, receiving address and block transaction come from that child. The child must be paid, related to the exact parent, owned by the same merchant, denominated in the same currency and original amount, and contain complete on-chain evidence. The signature covers the projected fields.
- Parent database fields are not rewritten. Direct-payment callbacks and EPay callbacks keep their existing behavior.
- Payment creation and gateway network-selection paths require a fresh automatic exchange rate. Existing quote-display cache behavior remains unchanged. Fixed rates and USD/USDT compatibility remain supported.
- There are no database schema changes, credentials, wallet changes or merchant changes in this patch.

## Reproduction

Use the exact upstream revision, verify the input file hashes in `manifest.json`, apply `gateway.patch` at the upstream root with `git apply --check` followed by `git apply`, then verify the output file hashes. Source hashes are for UTF-8 content with LF line endings.

From the upstream `src` directory, run:

```sh
go test ./config ./mq ./model/service ./model/data -count=1 -timeout=180s
go vet ./config ./mq
```

Build with the upstream Dockerfile and `BUILD_VERSION=v2.0.0-glorycode.1`, pinning the Go and runtime base image versions for the release. Keep the default embedded web assets and default entrypoint. Record the source patch hash and built image identity; a passing package test does not by itself approve production replacement.

## Acceptance boundaries

The callback tests exercise real SQLite rows, HTTP notification serialization and HMAC validation. Sub2API's separate isolated PostgreSQL tests exercise actual user/redeem repositories, concurrent admission, rollback and one-time credit. Real blockchain transfer acceptance is a separate check and is never replaced by posting a fabricated paid callback to production.
