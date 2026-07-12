# NginUX v0.2.2

NginUX is a self-hosted reverse-proxy manager for your homelab — expose internal
services over HTTPS, gate them behind a login, and watch your traffic, all from one
clean dashboard. Think Nginx Proxy Manager, rebuilt around a live network-topology
view, real metrics, and an agent-ready API.

## New in v0.2.2 — internal hardening

No new features and no behaviour change — this release finishes the deferred
follow-ups from the v0.2.0 batch, verified by the full test suite plus an
in-browser pass over both analytics views:

- **Faster log summaries** — per-service traffic summaries now skip the disk read
  entirely when the in-memory window already covers the requested range.
- **Modular route layout** — four more route groups (self-update, security, agents,
  certificates) moved out of the monolith into `server/src/routes/*`, shrinking the
  central file by ~200 lines with no route or auth change.
- **Deduplicated analytics UI** — the status-code, top-IP, and by-country panels are
  now one shared component set used by both the Logs page and each service's
  analytics, so the two can't drift.

(v0.2.1 was a docs/version-sync release with no code change.)

## New in v0.2.0 — the whole backlog

**Operations & recovery**
- **Backup & restore** — one-click portable bundle of hosts + settings + bans +
  channels, optionally passphrase-encrypted (AES-256-GCM). Migrate between boxes or
  recover in seconds.
- **Bulk actions** — select multiple services and enable / disable / maintenance /
  delete / apply-a-profile in one reload.
- **Import from nginx.conf** — paste an existing config, preview exactly what will
  be created, then confirm.
- **Security profiles** — named, reusable security bundles applied across services.

**Security & visibility**
- **HTTP(S) health checks** — probe the app (path + expected status), not just the
  port. **Enforce-2FA policy** for admins/editors. **Geo-block analytics** — see
  blocked attempts by country and IP, ban an offender in one click.
- **Alert routing by severity** (danger → pager, info → Slack) and a **syslog sink**
  so audit events can stream to a SIEM.
- **Multi-realm login gate** — gate services on a *second* base domain without the
  redirect loop. **Per-FQDN DNS-01** so wildcard certs work across domains.

**Under the hood**
- Async streaming access-log reader (no more event-loop-blocking reads), a shared
  settings-validation schema, a single-pass metrics aggregation, MCP `prompts/get`,
  and the start of a modular route layout.

**Quality** — the regression suite grew from 193 to **247 tests**; the full config
also carries the v0.1.2 hardening (adversarial-review fixes) and config-diff preview.

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
