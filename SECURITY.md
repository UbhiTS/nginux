# Security Policy

## Reporting a vulnerability

Please report security issues **privately** - do not open a public issue.

- Preferred: GitHub's **private vulnerability reporting** (the repo's *Security* tab → *Report a vulnerability*).
- We aim to acknowledge within a few days and will credit reporters who want it.

## Supported versions

The latest `0.x` release (and `:latest` image) is supported.

## Deploying securely

NginUX is built defense-in-depth, but a few operator choices matter - especially if your host touches the internet:

1. **Keep the control plane on your LAN.** Only the data plane (`:80`/`:443`) should ever face the internet. The supplied Compose file binds `:6767` to loopback by default. If you must reach it remotely, bind it to a specific LAN/VPN address or put an authenticated reverse proxy in front of it - never a raw public port-forward.
2. **Replace the bootstrap password immediately.** Production generates a random initial admin password when `NGINUX_ADMIN_PASSWORD` is unset and prints it once in the container log. Sign in and replace it, or supply a strong initial password through your secrets/deployment system.
3. **Forward-auth secret (automatic).** NginUX generates a random shared secret on first boot - the value nginx sends to the forward-auth endpoint so it can't be invoked directly. No setup needed; rotate it anytime from **Settings → Login gate**.
4. **Only trust `X-Forwarded-For` from your real proxy.** `NGINUX_TRUST_PROXY=true` trusts XFF only from loopback (the bundled nginx). If you front `:6767` with your own proxy, set it to that proxy's IP/CIDR instead.

## What's already hardened

Server-side RBAC on every mutating route (admin/editor/scoped/readonly + scoped agent tokens), CSRF (SameSite + Origin check, including the MCP endpoint), injection-safe nginx config generation, path-traversal-contained cert handling, parameterized SQL, scrypt password hashing + TOTP 2FA with replay/lockout protection, mTLS with CRL-based revocation, secret redaction for non-admins, brute-force throttling + fail2ban-style auto-bans, security headers/CSP on the UI, and a container that drops all Linux capabilities except those needed to bind low ports (`no-new-privileges`).
