# NginUX v0.1.19

Gateway security release from a full adversarial review of the control plane,
generated Nginx data plane, L4/SNI routing, agent/MCP surface, dependencies,
container image, CI, backups, and self-update chain. Upgrade is strongly
recommended.

## Fixed

### High — editor-to-admin session theft through custom response headers

Editor-writable custom headers allowed Nginx variables. A value such as
`$http_cookie` reflected the Domain-scoped HttpOnly NginUX session into a
browser-readable response header; backslashes could also escape the generated
quoted directive. Header values now reject variables/backslashes at validation,
and the generator independently drops unsafe legacy rows.

### High — L4/SNI services falsely claimed HTTP protections

TCP, UDP, and SNI passthrough accepted and displayed login, 2FA, mTLS, country
lock, security headers, and request limits even though stream configs cannot
enforce them. Contradictory configurations are now rejected server-side,
ignored presentation flags are normalized off, security scoring/UI report raw
passthrough honestly, and security profiles cannot be applied to stream hosts.

Passthrough inside the shared SSO cookie domain is now withheld entirely: a
browser would otherwise deliver the admin session directly to the passthrough
backend, outside Nginx's HTTP cookie-stripping boundary. Use a separate base
domain or terminate HTTP/gRPC in NginUX.

### High — SNI and gRPC failed open/down

- Unknown or absent SNI no longer routes to the first configured backend; it
  fails closed on a local blackhole. Wildcard SNI matching is enabled correctly.
- HTTPS gRPC upstreams now use `grpcs://` instead of silently downgrading to
  plaintext.
- HTTPS/gRPC upstreams send SNI and new services verify the backend certificate
  against the system trust store by default. Existing self-signed deployments
  retain an explicit compatibility opt-out.

### High — mutable, unverified self-update had Docker-socket authority

One-click update previously pulled `:latest` and immediately ran updater code
from that candidate with the root-equivalent Docker socket. Updates now require
a canonical release tag, resolve its full source commit, verify GitHub/Sigstore
OCI provenance for this repository/workflow/ref/SHA, extract exactly one signed
digest, pull and launch only `image@sha256`, and run the socket-enabled helper
from the current trusted image. Mutable/non-digest candidates fail closed.

### High — sensitive admin directives leaked to lower roles

Host list/detail and MCP read tools returned raw `customNginx`, which commonly
contains upstream bearer/API credentials. Non-admin DTOs and generated-config
views now omit those directives. An editor's redacted empty form value is ignored
instead of erasing admin-installed security directives.

### High — unauthenticated login traffic amplified into memory, disk, and webhooks

Already-throttled requests kept growing timestamp arrays and synchronously wrote
and emitted one audit event per request. Per-key memory is now bounded, throttle
events are coalesced per source/window, the audit hard cap is enforced
continuously, auto-ban tracking has TTL/cardinality caps, and approval queues have
argument/per-agent/global limits.

## Additional hardening

- Scoped users can no longer pivot an allowed service to Docker/Portainer/admin
  ports on the same host by changing only `forwardPort`.
- Normal source starts bind to loopback and generate a random bootstrap password;
  `admin`/`admin` requires the explicit `NGINUX_INSECURE_DEV_DEFAULTS=1` opt-in.
- Backup restore validates every section before its first mutation, preventing a
  bad later channel/setting from partially replacing live hosts and bans.
- Webhook audit entries omit userinfo, secret paths, and query strings; legacy
  full-URL audit summaries are redacted once during migration.
- Mixed/legacy IPv4 and the full IPv6 `fe80::/10` range are canonicalized and
  blocked by metadata/link-local SSRF guards. User-configured HTTP, SMTP,
  syslog, webhook, and probe destinations are resolved and pinned at connection
  time, closing DNS-rebinding and redirect pivots into metadata services.
- The internal ACME account key is reserved and cannot be targeted through a
  certificate-domain deletion route/tool.
- JSON-RPC batches execute mutations sequentially so config rollback operations
  cannot race each other; 2FA enrollment and SSE limits are bounded.
- Fastify is upgraded from 5.10.0 to 5.12.1 for the August 2026 validation and
  proxy-trust advisories; compatible dependency patches are refreshed.
- Runtime is pinned to Node 24.19.0 / Alpine 3.24 by multi-arch digest, requires
  Nginx 1.30.4+, upgrades APKs, removes npm/corepack/yarn from production, and
  generates signed image provenance.
- Normal CI now runs all server and web tests. Release CI also scans the exact
  runtime image with digest-pinned Trivy and fails on fixed high/critical CVEs.

## Verification

- Server tests: **305 passed**
- Web tests: **333 passed**
- Real-Nginx integration: **24 passed**
- Server/web typechecks and production build: passed
- Hardened runtime container boot/health: passed
- Trivy high/critical scan (OS + production packages): **0 findings**
- npm production/full audit: **0 known vulnerabilities**

No audit can prove the absence of undisclosed zero-days. This release closes the
reproduced attack paths and adds enforcement so the same classes fail closed.
