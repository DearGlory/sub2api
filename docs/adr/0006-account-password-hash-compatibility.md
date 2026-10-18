# Accept both account-password hash formats and write Argon2id

**Status: accepted**

GloryCode's stored account passwords include bcrypt and Argon2id. The administrator authorizes a narrow Sub2API compatibility change on the `0.2.17-GloryCode-0.0.7` baseline: verify both existing formats, and write new account passwords with Argon2id. The existing password-hash column stores the self-describing hash. Login does not silently change the hash, preserving the existing hash-derived session identity behavior.

**Consequences**

- Existing bcrypt and source-compatible Argon2id users can authenticate without a bulk password reset.
- Registration, setup, administrative password changes, reset-password and account creation reuse the same account-password codec.
- The temporary conversion-to-bcrypt design is superseded. Argon2id verification remains required while Argon2id is the write format.
- Password bytes remain unchanged. Public password-policy boundaries remain separate from hash encoding and historical authentication.
- Strict format and work-parameter validation bounds parsing and KDF resource consumption.
- MFA backup codes, API keys and other bcrypt consumers remain outside this decision.
- This feature introduces no database migration. Source identity, tests and review are required before a local candidate commit; production release and user-data migration require separate acceptance.
