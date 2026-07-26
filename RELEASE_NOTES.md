# NginUX v0.1.11

NginUX v0.1.11 is the clean follow-up to v0.1.7. It contains the application and
security work completed since that release, with the source version, Docker image,
Git tag, and release notes synchronized again.

The former v0.1.8-v0.1.10 tags were produced by release automation on ordinary
`main` pushes while the application still identified itself as v0.1.7. They were
not three distinct application releases. That automation has been corrected:
releases now require an explicit source-version change and can no longer invent a
tag that disagrees with the API/UI version.

## New in v0.1.11

### Safer production defaults

- Fresh production installs generate a strong, one-time admin password and print
  it to the container log instead of exposing the known `admin` / `admin`
  credential. The password must still be replaced on first sign-in.
- The supplied Compose deployment binds the control plane to loopback by default.
  Operators can opt into a specific LAN/VPN address with
  `NGINUX_CONTROL_BIND`.
- Fresh root-owned Docker volumes now fall back to the bundled unprivileged user,
  and the entrypoint creates sensitive files with a restrictive umask.

### Authentication and proxy hardening

- Session tokens are hashed at rest, including an in-place migration for sessions
  created by older releases.
- Stored scrypt parameters are bounded before use, preventing corrupt database
  values from forcing excessive password-check allocations.
- Re-enrolling 2FA no longer replaces the active authenticator secret until the
  new code has been verified.
- Cookie stripping now fails closed when an adversarial request contains more
  duplicate NginUX session cookies than the normal stripping budget.
- Control-plane proxy exceptions require the exact configured scheme, host, and
  port. Login redirects require an exact enabled service instead of accepting a
  wildcard match.

### Input, agent, and download safety

- Proxy targets reject cloud-metadata, link-local, unspecified, legacy numeric
  IPv4, and disguised IPv6 forms consistently across REST and agent paths.
- Agent tool arguments receive common schema validation before approval or
  execution, and concurrent approval attempts can no longer run the same
  destructive tool twice.
- GeoIP downloads now enforce response and decompression size limits and validate
  the database before activation.

### Installable app and release integrity

- NginUX now includes a web app manifest and complete icon set for installation as
  a PWA on desktop and mobile.
- GitHub Actions are commit-pinned, dependency auditing is part of the release
  gate, and releases continue to require the server/web suites, the real-Nginx
  boundary test, and a booted-container health check.
- Ordinary pushes to `main` run CI but no longer create releases. A release is
  built only when the source version is explicitly advanced.

## Upgrade

With Compose:

```bash
docker compose pull
docker compose up -d
```

Or pull the immutable version directly:

```bash
docker pull ghcr.io/ubhits/nginux:v0.1.11
```

The image is multi-architecture (`linux/amd64` and `linux/arm64`). Existing data
in `/data` is migrated in place.

> **Keep the `:6767` control plane off the public internet.** Forward only
> `80`/`443` to proxied services; reach the admin plane over your LAN or VPN.
