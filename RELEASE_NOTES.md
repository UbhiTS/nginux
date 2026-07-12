# NginUX v0.1.2

NginUX is a self-hosted reverse-proxy manager for your homelab — expose internal
services over HTTPS, gate them behind a login, and watch your traffic, all from one
clean dashboard. Think Nginx Proxy Manager, rebuilt around a live network-topology
view, real metrics, and an agent-ready API.

## New in this release

**New features**
- **Config-diff preview** — "Preview changes" on any service dry-runs the exact
  nginx-config diff a save would produce, colour-coded, before anything is written
  or reloaded. Turns "edit and pray" into "see exactly what changes."
- **Update button + one-click self-update** — an "Update available" button appears
  (admins only) when a newer release or rebuilt image is published; with the Docker
  socket opted-in it can pull and relaunch itself, auto-rolling-back on failure.

**Hardening & correctness** (from a full adversarial review)
- Fixed an nginx IP-deny rule that was dead code (and inverted to *allow*), gated
  the per-host metrics feeds so scoped users can't enumerate services, closed a
  login open-redirect, tightened the control-plane-domain hijack guard, and locked
  scoped users out of upstream/domain/TLS routing changes.
- Corrected long-range analytics (7d/30d were truncated to ~25h), maintenance mode
  now short-circuits path routes, uptime monitoring debounces transient blips,
  auto-ban exempts LAN devices, and alert channels coalesce storms.
- Unified host-write validation into one shared schema so the REST and agent paths
  can never drift apart.

**Quality** — the regression suite grew from 133 to 193 tests.

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
