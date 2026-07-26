// Build installable-app icons from the canonical NginUX artwork.
//
// Apple applies its own rounded-square (squircle) mask to home-screen icons. The
// neon frame therefore needs to follow that outer silhouette: padding the whole
// badge creates an unwanted black border, while a conventional round-rectangle
// gets clipped at the corners. Draw the artwork full-bleed and reinforce its
// frame directly on an iOS-shaped superellipse at the canvas boundary.
//
//   node scripts/make-app-icons.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "web", "public");
const SOURCE = join(PUBLIC, "website-icon.png");
const IOS_SQUIRCLE_EXPONENT = 5;
const OUTPUTS = [
  ["app-icon-1024.png", 1024],
  ["icon-512.png", 512],
  ["icon-192.png", 192],
  ["apple-touch-icon.png", 180],
];

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const bin = process.env.NGINUX_SHOT_BIN ?? CANDIDATES.find((path) => existsSync(path));
if (!bin) throw new Error("No Chrome/Edge found - set NGINUX_SHOT_BIN.");

const sourceUrl = `data:image/png;base64,${readFileSync(SOURCE).toString("base64")}`;
const profileDir = mkdtempSync(join(tmpdir(), "nginux-app-icons-"));
const browser = await puppeteer.launch({
  executablePath: bin,
  headless: true,
  userDataDir: profileDir,
  args: ["--no-sandbox", "--disable-gpu", "--force-color-profile=srgb"],
});

try {
  const page = await browser.newPage();
  const rendered = await page.evaluate(async ({ sourceUrl, outputs, squircleExponent }) => {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();

    return outputs.map(([name, size]) => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, size, size);

      // Parametric superellipse: |x/a|^n + |y/b|^n = 1. With n≈5 this follows
      // Apple's continuous-corner icon mask much more closely than a circular
      // CSS border-radius. The path sits on the canvas boundary, so the visible
      // half of each stroke is the icon's outer edge—there is no black band
      // outside the neon line for iOS to reveal.
      const frame = new Path2D();
      const half = size / 2;
      const power = 2 / squircleExponent;
      const points = Math.max(256, size);
      for (let i = 0; i <= points; i++) {
        const angle = (i / points) * Math.PI * 2;
        const cosine = Math.cos(angle);
        const sine = Math.sin(angle);
        const x = half + (half * Math.sign(cosine) * Math.abs(cosine) ** power);
        const y = half + (half * Math.sign(sine) * Math.abs(sine) ** power);
        if (i === 0) frame.moveTo(x, y);
        else frame.lineTo(x, y);
      }
      frame.closePath();

      const gradient = context.createLinearGradient(0, 0, size, size);
      gradient.addColorStop(0, "#ff2d9b");
      gradient.addColorStop(0.52, "#8b36ff");
      gradient.addColorStop(1, "#15e0f5");
      context.save();
      context.globalCompositeOperation = "screen";
      context.strokeStyle = gradient;
      context.lineJoin = "round";
      for (const [width, alpha] of [
        [0.10, 0.16],
        [0.065, 0.28],
        [0.038, 0.95],
      ]) {
        context.globalAlpha = alpha;
        context.lineWidth = size * width;
        context.stroke(frame);
      }
      context.restore();
      return [name, canvas.toDataURL("image/png")];
    });
  }, {
    sourceUrl,
    outputs: OUTPUTS,
    squircleExponent: IOS_SQUIRCLE_EXPONENT,
  });

  for (const [name, dataUrl] of rendered) {
    writeFileSync(join(PUBLIC, name), Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log(`wrote web/public/${name}`);
  }
} finally {
  await browser.close();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
