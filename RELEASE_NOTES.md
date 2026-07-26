# NginUX v0.1.14

NginUX v0.1.14 makes the iPhone Home Screen icon full-bleed, with the neon frame
forming the icon's outer outline.

## Fixed

### Full-bleed iPhone icon with no black outer border

v0.1.13 protected the neon frame by shrinking the complete badge into a safe
area. Although this prevented clipping, it left a visible black frame between
the neon line and the iOS icon boundary.

The artwork is full-size again. Its neon frame now follows an iOS-style
superellipse directly on the canvas boundary, so Apple's rounded mask retains a
continuous pink, purple, and cyan outline without revealing a second black
border. The central NginUX artwork and dashboard branding remain unchanged.

The icon regression test now verifies that neon pixels reach the midpoint of
all four outer edges, preventing the padded black-frame treatment from
returning. Icon URLs are versioned so a newly added Home Screen shortcut fetches
the corrected asset.

## Upgrade

With Compose:

```bash
docker compose pull
docker compose up -d
```

Or pull the immutable version directly:

```bash
docker pull ghcr.io/ubhits/nginux:v0.1.14
```

The image is multi-architecture (`linux/amd64` and `linux/arm64`). Existing data
in `/data` is preserved.

> To refresh an icon that is already installed, remove the existing NginUX Home
> Screen shortcut and use Safari's **Share → Add to Home Screen** again after
> upgrading.
