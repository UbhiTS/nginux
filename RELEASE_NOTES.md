# NginUX v0.1.21

Adversarial security, performance, and state-consistency hardening release.

## Security Hardening

### Outbound SSRF & Notification Channel Protections
- **NAT64 (`64:ff9b::/96`) & SIIT (`::ffff:0:0/96`) IPv6 Unwrapping**: `isDangerousHost` now unwraps RFC 6052 NAT64 (including RFC 5952 zero-coalesced `64:ff9b::`) and RFC 6145 SIIT IPv4-embedded IPv6 addresses before checking cloud metadata (`169.254.169.254`), link-local (`169.254.0.0/16`), and unspecified (`0.0.0.0/8`) ranges.
- **Notification Channel Path & Header Sanitization**: Added `validateChannelConfig` and URL-encoding for `ntfy` topics and `telegram` bot tokens (blocking `/`, `..`, `?`, `#`, `@`, and control characters), and stripped CR/LF (`\r`, `\n`) from all outbound HTTP headers in `safeOutboundRequest`.
- **mTLS Client Certificate CN Sanitization**: `POST /api/hosts/:id/client-certs` now rejects ASCII control characters (`\x00`–`\x1f`, `\x7f`) in client certificate display names.

### Backup Restore & `nginx.conf` Import Security Parity
- **Control-Plane Portal Hijack Defense**: `restoreBundle`, `importNginxConf`, and `previewNginxConf` now enforce `isControlPlaneDomain` (evaluated against the incoming bundle's `ssoLoginUrl`) so a restored bundle or imported `nginx.conf` cannot hijack the SSO login portal domain.
- **L4 Stream Port Validation & Uniqueness**: Shared `streamPortConflictError` enforces valid unprivileged stream ports (`1024`–`65535`, excluding `:6767`) and prevents duplicate TCP/UDP port bindings across backup restore, `nginx.conf` import, and config diff preview.
- **Capability Gate Parity**: `restoreBundle` evaluates `protocolCapabilityError` against the incoming bundle's `allowCustomNginx` setting.

### Cryptographic & Authentication Hardening
- **AES-256-GCM Tag Truncation Defense**: `decryptJson` and `decryptJsonAsync` now enforce exact 16-byte `salt`, 12-byte `iv`, and 16-byte authentication tag lengths (`authTagLength: 16`) on encrypted backup envelopes.
- **Bearer Token Brute-Force Rate Limiting**: Added per-IP failed Bearer token rate limiting (`30` failed attempts per minute $\rightarrow$ `429 Too Many Requests`).
- **Supply-Chain Updates**: Upgraded `nodemailer`, `fastify`, `axios`, `fast-uri`, and `brace-expansion` (`0` vulnerabilities in `npm audit`).

## Performance & Robustness

- **Non-Blocking Encrypted Backup Export/Restore**: Added async threadpool `scrypt` (`encryptJsonAsync` / `decryptJsonAsync`) so `/api/config/export-encrypted` and `/api/config/restore` never block the Node.js event loop or data-plane forward-auth subrequests.
- **Token `last_used_at` Write Throttling**: `resolveToken` throttles SQLite `last_used_at` updates to at most once every 60 seconds per token, eliminating write amplification under high-frequency MCP agent polling.
- **Transactional SQLite Rollback on `nginx -t` Failure**: `PUT /api/settings`, `update_settings` (MCP), `POST /api/hosts/batch`, `POST /api/security-profiles/:id/apply`, `POST /api/config/versions/:id/restore`, `POST /api/config/restore`, and `POST /api/config/import` now revert SQLite state when `applyConfig()` fails validation.
- **Session & Approval Table Hygiene**: Filtered expired sessions out of `listSessions()` and `securityOverview().activeSessions`, and reaped expired `sessions` and old decided `approvals` during daily maintenance.
