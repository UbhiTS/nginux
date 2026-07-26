# NginUX v0.1.13

NginUX v0.1.13 corrects the installable app icon on iPhone and other platforms
that apply their own rounded icon mask.

## Fixed

### Complete neon outline on the iPhone Home Screen

The previous Apple touch icon placed the neon frame directly on the image
boundary. iOS applies an additional rounded-square mask when a website is added
to the Home Screen, which clipped the top, sides, and lower-right portion of the
frame.

The installable icon artwork now sits inside a 12% safe area on a matching dark
canvas. The full pink, purple, and cyan outline remains visible after iOS applies
its mask, while the dashboard and sidebar branding remain unchanged.

The 180, 192, 512, and 1024 pixel app assets are generated reproducibly from the
canonical NginUX artwork. Their URLs are versioned so a newly added Home Screen
shortcut cannot reuse the cropped icon from Safari's cache.

## Upgrade

With Compose:

```bash
docker compose pull
docker compose up -d
```

Or pull the immutable version directly:

```bash
docker pull ghcr.io/ubhits/nginux:v0.1.13
```

The image is multi-architecture (`linux/amd64` and `linux/arm64`). Existing data
in `/data` is preserved.

> To refresh an icon that is already installed, remove the existing NginUX Home
> Screen shortcut and use Safari's **Share → Add to Home Screen** again after
> upgrading.
