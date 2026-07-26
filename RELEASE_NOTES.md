# NginUX v0.1.15

NginUX v0.1.15 brings the new neon NginUX artwork to the browser tab and fixes
the Users & Access role guide layout.

## Fixed

### New favicon

The browser favicon now uses the same new neon NginUX icon as the dashboard.
Vite fingerprints the production asset, preventing an older cached favicon from
surviving a deployment.

### Users & Access role guide

The shield beside "What each role can do" now has an explicit icon size. This
prevents the inline SVG from expanding across the page and pushing the role
descriptions out of position.

## Upgrade

With Compose:

```bash
docker compose pull
docker compose up -d
```

Or pull the immutable version directly:

```bash
docker pull ghcr.io/ubhits/nginux:v0.1.15
```

The image is multi-architecture (`linux/amd64` and `linux/arm64`). Existing data
in `/data` is preserved.
