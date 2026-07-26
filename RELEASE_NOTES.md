# NginUX v0.1.12

NginUX v0.1.12 fixes authenticated dashboard requests through a public NginUX
hostname on NAS and other Docker hosts.

## Fixed

### Public dashboard no longer returns `Authentication required`

v0.1.11 tightened session-cookie forwarding so only the literal configured
control-plane target could receive the NginUX session. A common NAS setup stores
the NAS hostname or LAN address as the managed NginUX service's upstream—even
though nginx and the control plane are in the same container. The alias still
reached the control plane, but v0.1.11 did not recognize it and stripped
`nginux_session`; the UI loaded while every authenticated `/api/*` request
returned 401.

The public portal is now identified by the configured **NginUX public URL**
(including multi-domain login realms) and pinned directly to
`NGINUX_CONTROL_URL` inside the container. This:

- works whether the stored service target is loopback, a Docker/NAS hostname, or
  a LAN address;
- keeps the session cookie only on the internal control-plane hop;
- never sends the session to the user-entered alias;
- ignores legacy load-balancer and path-route targets on the portal host so they
  cannot shadow or collect dashboard API requests.

Ordinary services and their path routes continue to have the NginUX session
cookie stripped before proxying.

### Expired sessions return to sign-in

If an authenticated API call genuinely returns 401—for example after replacing
a container with a fresh data volume—the UI now returns to the sign-in screen
instead of leaving every page mounted with an `Authentication required` error.
Rejected login credentials remain an inline login error and do not trigger this
session-expired path.

## Upgrade

With Compose:

```bash
docker compose pull
docker compose up -d
```

Or pull the immutable version directly:

```bash
docker pull ghcr.io/ubhits/nginux:v0.1.12
```

The image is multi-architecture (`linux/amd64` and `linux/arm64`). Existing data
in `/data` is preserved.

> **Keep the `:6767` control plane off the public internet.** Forward only
> `80`/`443` to proxied services; reach the admin plane over your LAN or VPN.
