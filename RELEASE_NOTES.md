# NginUX v0.1.16

NginUX v0.1.16 corrects icon sizing in service analytics and removes overlapping
placeholder glyphs from service logos.

## Fixed

### Service analytics section icons

The icons beside Traffic & errors, Top clients & paths, Geography, and Live
access log now have an explicit 16-pixel size. They no longer use the browser's
large intrinsic SVG dimensions when those sections are collapsed.

### Sidebar service logos

The generic service glyph remains visible while a remote logo is loading or
when it fails, but is removed as soon as the real logo loads. Transparent app
logos therefore no longer show a second generic icon underneath.

## Upgrade

With Compose:

```bash
docker compose pull
docker compose up -d
```

Or pull the immutable version directly:

```bash
docker pull ghcr.io/ubhits/nginux:v0.1.16
```

The image is multi-architecture (`linux/amd64` and `linux/arm64`). Existing data
in `/data` is preserved.
