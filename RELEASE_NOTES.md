# NginUX v0.1.0

NginUX is a self-hosted reverse-proxy manager for your homelab — expose internal
services over HTTPS, gate them behind a login, and watch your traffic, all from one
clean dashboard. Think Nginx Proxy Manager, rebuilt around a live network-topology
view, real metrics, and an agent-ready API.

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
