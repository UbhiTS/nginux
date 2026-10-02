# NginUX v0.1.22

Full adversarial security review (eleven independent audit passes across auth/sessions, nginx generation, the agent gateway, certs/crypto/supply chain, observability, REST routes, the web SPA and the container/CI pipeline). Every confirmed finding is fixed here and pinned by a regression test in `server/test/sec-audit-v0122.test.ts` (33 new cases; 353 server + 337 web tests green).

## Security Hardening

### Critical
- **Percent-encoded API prefix bypassed the auth guard**: the `preHandler` guard and the `Cache-Control: no-store` hook keyed on the raw URL prefix `/api`, while the router dispatched on the decoded path. `GET /%61pi/hosts` therefore reached handlers unauthenticated. Both hooks now key on the decoded path (`guardPath`/`isApiRequest`), and `userRoleAtLeast` fails closed on an unknown role.

### High
- **Control-plane self-exposure through managed services**: an editor could publish the LAN-only UI/API to the internet (and receive admins' session cookies on an attacker-named host) by pointing a service at `127.0.0.1:6767`, at `NGINUX_CONTROL_URL`, at this instance behind a LAN IP, or via a TCP/SNI stream, an upstream pool entry or a path rule. A shared `controlPlaneTargetError` (in `hostschema.ts`) now refuses stream, pool and path-rule targets for everyone and HTTP/gRPC primaries for non-admins; it is enforced identically by REST create/update/batch/preview, MCP tools (`create_service`/`update_service`/`set_service_enabled`/`delete_service` and queued approvals, which execute as a non-admin), backup restore and `nginx.conf` import. Non-admins can no longer edit, pause or delete the host that fronts the control plane. Detection of "this instance behind another address" uses a per-boot `instance` id that `/api/health` now returns (`NGINUX_SELF_PROBE=0` disables only that live probe).
- **Stream listeners could shadow nginx or the control plane**: TCP/SNI streams may no longer `listen` on `80`, `443`, `PORT` or the `NGINUX_CONTROL_URL` port (UDP is exempt). Previously a `listen 443` stream passed validation and broke the HTTP data plane at reload.
- **Forward-auth resolved a row nginx was not serving**: a disabled exact-domain row (or a stream row with the same name) could shadow the enabled wildcard host that actually serves the request, skipping its `require2fa`/scope policy; a `requireLogin=false` row also admitted callers. The gate now uses `getServingHttpHostByDomainCached` (enabled http/grpc rows only, then the serving `*.parent`) and returns 401 for ungated rows.

### Medium
- **mTLS without a client CA failed open**: a host with `mtls=true` whose `client-ca.crt` was missing (for example after `DELETE /api/certificates/:domain`, which also removed the per-host CA) was generated without `ssl_verify_client`. The generator now emits `location / { return 403; }` instead, `deleteCert` keeps `client-ca.*`, the CA is provisioned on create when `mtls` is set, and a certificate still referenced by a host cannot be deleted.
- **Non-admin `GET /api/settings` was a denylist**: every new setting key leaked to editors/readonly/scoped users unless someone remembered to redact it. `redactSettings` is now an allowlist of operational keys (`instanceName`, `baseDomain`, `theme`, `homeCountry`, `dnsProvider`, `ssoLoginUrl`, `agentAutoApprove`, `require2faForManagers`, `updateCheckEnabled`, `acmeStaging`, `publicIp`, `gatewayIp`); everything else is returned at its default. Backup export and the `update_settings` tool use the new `maskSecretSettings` (old behaviour) so restores still round-trip.
- **Cookie `Domain` emitted for look-alike / unrelated hosts**: signing in via a LAN IP or a host that merely ended in the base-domain string (`evil-example.com` vs `.example.com`) set `Domain=.example.com`. `authCookieDomain` now emits `Domain=` only when the request host equals or is a subdomain of the base; this also fixes LAN-IP sign-in when an SSO login URL is configured. SSO realms match by DNS-label suffix (most specific first) and only fall back to the registrable domain when exactly one realm matches, so sibling realms stay independent.
- **2FA enrolment code replay**: the TOTP step used to finish `/api/auth/2fa/verify` could be replayed at sign-in inside the same window. Enrolment now burns its counter.
- **Duplicate `nginux_session` cookies**: a sibling app setting a stale `nginux_session` for the parent domain could hide the live one. `parseCookieAll` (max 8) returns every value and the first LIVE session wins.
- **Login limiter order**: a throttled IP consumed the shared global budget, letting one source lock out every other operator; order is now per-IP → per-IP+user → global.
- **Login redirect** (`safeLoginRedirect`) only targets enabled, `requireLogin` http/grpc hosts; `/api/notifications` only names hosts a scoped user may see; `clientIp` ignores a non-IP `req.ip`.
- **Agent gateway**: agents can no longer set `certDomain` (`FORBIDDEN_TOOL_FIELDS`); `sanitizeHostPatch` builds a null-prototype object and skips `__proto__`/`constructor`/`prototype`; tool lookup uses `Object.hasOwn`; read-tier tool calls no longer write `agent.tool_called` audit rows (an unbounded-audit-growth / log-flood primitive for any `read` token); approval summaries describe the change; Fastify runs with `onProtoPoisoning`/`onConstructorPoisoning` set to `error`.
- **Validators & generator**: `isIpOrCidr` rejects `%zone` ids and non-numeric masks; `isLocationPath` rejects `..` and malformed `%` escapes; `hasNginxMetachars` adds `$` and `\`; `htmlEscape` encodes `$`/`\` (maintenance page); `validCertDomain` accepts hostnames only; `isCustomHeaderLine` rejects control characters; presets are looked up with `Object.hasOwn`; IPv6 upstreams are bracketed everywhere; `X-Forwarded-Host` is pinned to `$host` in `location /` and in every path-rule block; a host fronting the control plane never emits custom response headers.
- **Bans**: IP/CIDR validated at the sink (`addBan`, `replaceAllBans`, `writeBannedConf`), the auto-ban subscriber ignores `login.failed` events whose source is not an IP, and reasons are capped at 200 chars.
- **Notifications**: Discord payloads send `allowed_mentions: { parse: [] }`, Slack text escapes `&<>`, Telegram/Slack `topic`/`chat` ids are masked like other credentials, and delivery failures are reported as a category (`timeout`, `unreachable`, `tls error`, `rejected (authentication)`, `rejected`) instead of echoing the remote error body.
- **Misc**: `releaseUrl` from GitHub metadata must match `https://github.com/<owner>/<repo>/releases/tag/<tag>`; `isDangerousHost` also blocks the RFC 8215 local NAT64 prefix `64:ff9b:1::/48`; syslog URLs require port 1–65535; the CLI's command table is looked up with `Object.hasOwn`.

### Supply chain
- **Dependency audit gate with an explicit, expiring allowlist**: CI and the release pipeline now run `scripts/audit-gate.mjs` (also `npm run audit`) instead of a bare `npm audit --audit-level=high`. It still fails on any high/critical advisory, but exceptions live in `audit-allowlist.json` with the package, a written justification and an expiry date; expired entries fail the build so each exception is re-evaluated against new upstream releases. The first entry is GHSA-86w9-cpqp-85rv (`node-forge` RSA PKCS#1 v1.5 *verification*, no fixed release, pulled in transitively by `acme-client`): NginUX only uses node-forge to generate keys and create/sign its own certificates and CRLs and never verifies a signature with it, so the vulnerable path is unreachable.
- `server/src/version.ts` now documents that the release workflow creates the `v<VERSION>` tag itself; pushing the tag by hand makes the release job refuse to run.

## Performance & Robustness

- **Metrics pipeline bounds**: request-derived keys are clipped before they become map keys (host 253 / path 256 / user-agent 256 / ip 64 / country 8 / method 16) and per-host buckets are capped at 200 hosts, so an internet client spraying unique values can no longer grow the control plane's memory without limit.
- **SSE policy** shared by `/api/logs/stream` and `/api/events/sse`: global cap (`NGINUX_SSE_MAX`), per-principal cap (`NGINUX_SSE_PER_PRINCIPAL`, default 5), 1 MiB backpressure cut-off and heartbeat re-validation of the session/token so revoked principals are disconnected.
- **Importer**: `nginx.conf` input is capped at 1 MiB and the `listen … ssl` detection is linear (the previous regex went super-linear on long whitespace runs).
- **Config apply** wraps `writeAllConfigs` so a write failure rolls back instead of leaving a half-written `conf.d`.

## Behaviour changes

- TCP/SNI streams cannot use ports `80`, `443` or the control-plane port (UDP unaffected). The SNI form now suggests `8443`.
- Only admins may point an HTTP/gRPC service's primary upstream at the control plane; streams, pools and path rules never can. Set `NGINUX_SELF_PROBE=0` to disable the live self-detection probe (static loopback checks remain).
- Non-admins receive only the allowlisted operational settings from `GET /api/settings`.
- The session cookie carries `Domain=` only on hosts under the configured base domain.
- Agents (MCP tools) can no longer set `certDomain`.
- New env knobs: `NGINUX_SSE_PER_PRINCIPAL`, `NGINUX_SELF_PROBE` (see README).

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
