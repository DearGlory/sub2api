# PostgreSQL settlement verification

The release probe uses the actual service methods against PostgreSQL 18 on an isolated internal Docker network, with a schema-only test database and synthetic users/orders. Production data is not used in the settlement probe.

Candidate `f88a19e17539885d4d8233694149fd6905351a4e`:

- Cross-order same-chain-transaction contention: PASS, exactly one claim/audit admitted.
- Audit write exception: PASS, claim rolled back.
- Same-order gateway parent/child retry: FAIL, `pq: unexpected Parse response 'C'`.

Cause: `claimEpusdtBlockTransaction` retained an open result cursor after `Scan`, then executed an UPDATE on the same transaction connection. SQLite did not reveal the PostgreSQL protocol violation.

Correction: explicitly close `rows` and propagate its error immediately after `Scan`, before returning or issuing UPDATE. Existing deferred close remains the cleanup fallback.

Same probe after correction: all three named subtests PASS, exit 0. Test binary SHA-256 `9e8fd000f6a440707570a36248099c9495ce5595f17e01742684a357f31bf04a`.

Parent independently reran `Test(RecordPaymentManualReview|ApprovePaymentManualReview|RejectedEpusdt|NormalizeEpusdt)` in the integration tree: exit 0.

Reproducible probe source/overlay: `E:/Global-session/xiao-20261018-recharge-release/postgres_probe_test.go`, `postgres_probe_overlay.json`; remote logs and failure/success receipts preserved separately under `/root/sub2api-release-20261018-recharge/postgres-settlement-proof*`.

This proves the tested service/database boundaries only. It is not real-payment acceptance, final-artifact approval, or production deployment evidence.

## Callback trade ownership

Independent review found that distinct parent orders could reuse one callback trade number with different blockchain IDs, because only each parent trade number and blockchain ID were constrained. Two added regressions reproduced the flaw (expected error, received nil): cross-order child-trade reuse, and reuse of an older child trade after the first order received a replacement child trade.

Migration 248 adds permanent `trade_no -> order_id + block_transaction_id` ownership. The claim is inserted and checked inside the same transaction as the block claim and review/approval audit. Replacing the latest callback does not release a prior trade number. Existing order trade numbers and historical review/approval evidence are also checked.

The same isolated PostgreSQL service probe now additionally tests concurrent identical child trades with distinct blockchain IDs: exactly one transaction commits. All four subtests pass; binary SHA256 `d265b75308aa375176a7f413661470279e6e6602f74b52d4b8c01f1086f30f66`. Source is the `a78ee6d4c` tree plus this uncommitted trade-ownership/hex-normalization patch at test time; the older launcher label naming `f88a19e17` is not exact build provenance. Test evidence is not final artifact identity.

An additional RED/GREEN test canonicalizes 64-digit hexadecimal blockchain IDs with or without `0x` and differing case. Non-hex identifiers preserve case. Raw callback evidence remains in the audit detail.
