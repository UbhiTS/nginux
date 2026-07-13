# NginUX v0.1.5

NginUX is a self-hosted reverse-proxy manager for your homelab — expose internal
services over HTTPS, gate them behind a login, and watch your traffic, all from one
clean dashboard. Think Nginx Proxy Manager, rebuilt around a live network-topology
view, real metrics, and an agent-ready API.

## New in v0.1.5

Data-plane hardening: three defence-in-depth gaps at the nginx layer — deferred in
v0.1.4 because they couldn't be validated without real nginx — are now closed and
**proven end-to-end** by the integration suite that shipped last release.

- **The session cookie no longer leaks to your backends.** NginUX's SSO cookie is issued
  for the whole base domain, so it used to ride along to every proxied app (which could
  log or replay it). It's now stripped from the request before it reaches the backend —
  all your other cookies pass through untouched, and the login check itself is unaffected.
- **IP bans now cover TCP/UDP/SNI services too.** Bans previously applied only to HTTP
  hosts; a banned address could still reach a raw TCP or SNI-passthrough stream. Bans are
  now enforced at the stream layer as well. (Per-country blocking for streams remains a
  known gap — it needs an nginx module that isn't bundled yet.)
- **Custom nginx snippets can't silently drop your security headers.** Because of how
  nginx inherits `add_header`, a single `add_header` in a service's custom config used to
  wipe out the managed security headers (X-Frame-Options, etc.) for that service. Managed
  headers are now emitted so they always coexist with your custom ones.

Each fix is verified through real nginx (14 → **19 core + 3 hardening invariants**), and
each new test was confirmed to fail if its fix is reverted — so these can't silently
regress. server 269 tests, web 325, plus the real-nginx integration gate on every release.

## New in v0.1.4

A security-and-polish release: the login gate is now hardened to stone and **proven**
so by a real-nginx test, and the interface got a full accessibility and visual pass.

**Security — the login gate, hardened and proven**
- **Fail-closed forward-auth.** A full security audit found (and this release closes) a
  recurrence of the "unauthenticated request reaches a service" class: a login-gated host
  with a wildcard or mixed-case domain could fail *open*. The gate now resolves hosts
  case-insensitively + wildcard-aware and **denies by default** for every role when a
  gated request can't be tied to a known host — the safe direction to fail.
- **Real-nginx boundary test.** A new integration suite stands up actual nginx in front of
  the app's own generated config and proves, end-to-end, that no under-authenticated
  request ever reaches a backend — 19 invariants incl. the wildcard/case recurrence,
  ban-beats-allow-list ordering, 2FA and scoped-access gates, and TLS. It runs in CI and
  **gates every release** — a push can't ship unless the boundary holds.
- **Hardened surfaces.** The agent/MCP tool path now fully mirrors the REST validation (no
  privilege-field bypass), backup/restore validates everything it imports, global IP bans
  are enforced as a map that still applies on hosts with their own allow/deny lists, and
  step-up re-auth is rate-limited.

**Interface — accessibility, clarity, and character**
- **Accessibility & UX overhaul** — real keyboard operation across nav/tabs/rows, focus
  management, honest loading / empty / error states (a failed list no longer looks empty),
  a mobile drawer, higher-contrast tokens, and clearer microcopy.
- **Session & role controls** — revoke an active session, change a user's role in place.
- **Iconography & motion** — concept icons across every header and stat tile, plus subtle,
  reduced-motion-safe entrances and count-ups. Much less of a wall of text.

**Quality** — a brand-new web test suite (Vitest + React Testing Library, **325 tests**),
the server suite at **269**, and the real-nginx integration suite on top. The forward-auth
fixes are pinned by regression tests that were verified to fail if the fix is reverted.

## Highlights

**Proxy & TLS**
- Point a domain at any internal `host:port` in a few clicks — HTTP/HTTPS, WebSocket,
  HTTP/2, gRPC, and TCP/UDP/SNI streams.
- Automatic certificates via Let's Encrypt (HTTP-01 and DNS-01 for GoDaddy/Cloudflare)
  or instant self-signed, with daily auto-renewal. ACME challenges are served on
  every host - ahead of redirects, IP lists, the login gate, and maintenance mode -
  so issuance and renewal just work.
- A live Let's Encrypt activity log on the Certificates page: every ACME step
  (staging/production directory, challenges, validation attempts, errors) streams
  in as it happens, so a failed issuance is never a black box.
- Load balancing, per-path routing, custom headers, and a raw-nginx escape hatch when
  you need it.

**Security**
- A login gate (forward-auth) that puts any service behind NginUX sign-in, with TOTP
  two-factor and one-time backup codes.
- Role-based access — admin / editor / scoped / readonly — enforced server-side.
- GeoIP country lock, IP allow/deny lists, and fail2ban-style auto-ban on brute force.
- mTLS client certificates with real CRL-based revocation.
- Per-host rate limiting, bandwidth caps, security headers, and common-exploit blocking.

**Visibility**
- A live network-topology map: Internet → gateway → servers → services, color-coded by
  health, with pan and zoom.
- Multi-range traffic graphs (requests + bandwidth), top IPs/paths/countries, and
  searchable access logs.
- Per-service analytics on each service's page: requests, bandwidth, p95 latency, error
  rate, status codes, top clients, a source-country traffic map, and a live access log —
  every panel loaded on demand when you expand it.
- Uptime monitoring with incident history, plus notification channels (ntfy, Gotify,
  Pushover, Discord, Slack, Telegram, email, and webhooks).

**Automation**
- An agent / MCP tool API so assistants can manage services under the same RBAC, with an
  approval queue gating the sensitive actions.

## Install

```bash
docker run -d \
  -p 80:80 -p 443:443 -p 6767:6767 \
  -v nginux-data:/data \
  ghcr.io/ubhits/nginux:latest
```

Multi-arch (amd64 + arm64). The container runs non-root as the owner of your mounted
`/data` volume (set `PUID`/`PGID` to override). First sign-in is `admin` / `admin` — you
are required to set a new password immediately.

> ⚠️ **Keep the `:6767` control plane off the public internet.** Forward only `80`/`443`
> to your proxied services; reach the admin plane over your LAN or VPN.
