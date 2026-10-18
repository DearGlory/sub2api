# Account Password Compatibility — 0.0.7 Baseline Contract

## Source identity and authorization

- Administrator-selected baseline: `0.2.17-GloryCode-0.0.7`.
- Verified remote tag: `v0.2.17-GloryCode-0.0.7`, tag object `a40a8f8b6ee9ff0ce7b220b11a3032ae3ae573bb`, dereferenced commit `3f29b7434ea23a29cbac3f1bf2892afacc49e41d`.
- Verified remote production branch: `fork/prod/0.2.15-custom`, pointing at that same commit when checked.
- Baseline `backend/cmd/server/VERSION`: `0.2.17-GloryCode-0.0.7`.
- Candidate version: `0.2.17-GloryCode-0.0.9` (local candidate, not a published or deployed release).
- Integration worktree: `E:/Global-session/xiao-20261018-password-v007`.
- Integration branch: `feat/sub2api-v0217-gc009-password`.
- Forward-preservation update: while this work was running, remote `v0.2.17-GloryCode-0.0.8` and production mainline advanced to `a3b7b221164bf50815e9887fbc3bc0c6ef341eac`. This descendant of the selected 0.0.7 baseline was fast-forwarded before the local password commit, preserving its payment fixes and existing migrations 247/248. The password feature adds no database migration relative to that current parent. Version 0.0.8 is already taken; the new local candidate is 0.0.9.
- Local implementation, tests, and new local commits are authorized. Production writes, deployments, Nginx changes, remote pushes, published tags and releases remain outside this phase.
- The last separately observed running version was `0.2.17-GloryCode-0.0.6`; that observation is not evidence that the repository's 0.0.7 is already deployed. Any deployment phase requires a fresh runtime identity check.

## Baseline preservation

0.0.7 is a descendant of `50ec1808b70faa1186cfa6831f0bca6d93687064` and introduces configurable external-voucher purchase and EPUSDT payment support. Those features and their migration remain intact. Compared with 0.0.6, the inspected `auth_service.go`, `user.go`, `totp_service.go`, `auth_handler.go`, `config.go` and `go.mod` are unchanged; this supports reuse of scoped development work, not reuse of old test results as 0.0.7 acceptance.

Old worktrees remain untouched until their writers return. Preserve tracked diffs and untracked implementation files; integrate only reviewed task-owned changes into this worktree. No reset, forced checkout, blanket copy or replacement of 0.0.7 files. Rerun acceptance against the integrated candidate and retain 0.0.7 payment regression coverage.

## Approved behavior

The administrator superseded the temporary Argon2id-to-bcrypt converter:

- Accept existing bcrypt account-password hashes and GloryCode Argon2id account-password hashes.
- Write new account passwords as Argon2id for registration, setup, password changes, admin resets and reset-password flows.
- Preserve existing `password_hash` storage. This feature introduces no database columns, tables, migrations or status values.
- No silent login rehash and no intentional session/token-version behavior changes.
- Leave MFA backup codes, API keys, payment secrets and unrelated bcrypt uses unchanged.
- Administrator-requested plaintext password copies are an independent, optional local storage feature **enabled by default**; explicit configuration false disables writing. This remains a high-risk feature despite permissions. Only synthetic test credentials may be used in this phase.
- History migration may use restricted external archives, as explicitly approved. This contract does not authorize production data migration.

## Account password codec

Add `internal/pkg/accountpassword` with `Hash(password string) (string, error)` and `Verify(password, encoded string) bool`.

- GloryCode-compatible Argon2id PHC version 19, `m=19456,t=2,p=1`, cryptographically random 16-byte salt and 32-byte output.
- Strict, bounded parsing before KDF execution: reject malformed encodings, excessive work parameters, unknown algorithms and invalid salt/output lengths.
- No trimming, normalization, 72-byte truncation or hash-of-hash conversion.
- Constant-time derived-key comparison and legacy bcrypt verification.
- Preserve current public input-policy boundaries; do not apply new-password policy to historical authentication.

## Independent plaintext copy storage

Administrator-configurable local directory, enabled by default. Store only the most recent fully authenticated password per numeric user ID with minimal metadata. Atomic replacement, restricted owner permissions, no symlinks or group/world-readable outputs. No HTTP retrieval API and no plaintext in ordinary logs, errors, stdout or response bodies.

Failed password validation, failed/unfinished MFA, disabled users, refresh-token requests, OAuth-only and WebAuthn-only authentication do not create a copy. Explicit disable has no new directory/file side effects. Storage failure must be observable without including credentials and must not silently change session authorization semantics.

The MFA handoff uses a short-lived authenticated encrypted envelope carried only in the existing server-side temporary login session. Bind it to the user ID, temporary session token, expiry and current password-hash fingerprint with a purpose/version marker; use the existing secret encryptor rather than introduce a new credential or database field. No plaintext in Redis or client session tokens. After all MFA/account/backend checks and successful session issuance, recover and verify the unchanged credential before storing the final copy; erase/consume the temporary session. Explicit disable skips staging, recovery and writes. Verify expired/tampered envelopes, failed MFA, changed password, distributed instance recovery and cleanup in tests. The encrypted handoff is temporary plumbing, not the requested persistent plaintext copy. Copies represent the last successful password login; password changes or OAuth logins alone do not fabricate a new copy.

## Confirmed verification scope

- Public Hash/Verify, User and AuthService password methods.
- Successful password login and completed MFA; wrong password, inactive user and incomplete MFA negatives.
- Registration, setup, password change and reset writes.
- Concurrent successful logins and atomic replacement.
- Default-enabled and explicit-disabled configuration, with filesystem side-effect assertions.
- Existing bcrypt users continue to authenticate; login does not mutate password hashes.
- No feature-added schema diff; no changes to 0.0.7 purchase/payment behavior.

Use the baseline-declared Go 1.27.2 toolchain. Local Docker and populated `xiao-sub2-gomod-1272` / `xiao-sub2-gocache-1272` caches are available. Service tests require `-tags unit`. Keep real RED/GREEN evidence, rerun affected full suites and relevant 0.0.7 payment regressions, execute race/static checks where supported, and obtain independent review before the final local commit. A successful command with `[no tests to run]` is not behavioral evidence. Local tests, build identity, code review, commit and deployment are separate acceptance states.
