# Keep administrator-requested password copies outside runtime data

**Status: accepted**

The administrator explicitly requires a recoverable plaintext copy of the most recently successful password login and explicitly selects an enabled default with a configuration off-switch. This is a high-risk exception to one-way-only password storage: a compromise of the archive, its backups or the application account can expose usable credentials. Filesystem permissions reduce exposure but do not remove that consequence. Password hashes remain the authentication authority; copies are never read to authenticate.

**Consequences**

- Copies live in a separate owner-restricted local directory, with atomic replacement and minimal per-user metadata. No database columns, retrieval endpoints or password logging are introduced.
- Explicit disable prevents new directory/file side effects and bypasses password staging for multi-step authentication. Disabling is not deletion of already archived records; retention and backups remain administrator responsibilities.
- Copies are written only after successful account-password authentication and all required MFA checks and session issuance. Password-only partial success, failed or expired MFA, inactive users, rejected backend-mode users, token refresh and passwordless login do not create copies.
- A short-lived authenticated encrypted envelope may carry the already-verified password inside the existing server-side MFA session. It is bound to the user, temporary session, expiry and current credential fingerprint; plaintext is absent from cache payloads and browser responses.
- An optional archive failure is observable as a generic event without credential content and does not authorize a login that would otherwise fail.
- A copy represents the last successful password login, not a guaranteed current credential after a password reset. It is not an automatic cross-system migration contract.
- This phase uses synthetic credentials only, and does not activate the feature on production.
