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
