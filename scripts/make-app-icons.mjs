// Build installable-app icons from the canonical NginUX artwork.
//
// Apple applies its own rounded-square mask to home-screen icons. The source
// artwork already contains a rounded neon frame, so drawing it edge-to-edge
// causes iOS to crop that frame at all four corners. Keep the complete artwork
// inside Apple's safe area and extend its navy corner colour to the canvas edge.
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
const SAFE_INSET_RATIO = 0.12;
const FALLBACK_BACKGROUND = "#05083d";
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
  const rendered = await page.evaluate(async ({ sourceUrl, outputs, insetRatio, fallbackBackground }) => {
    const image = new Image();
    image.src = sourceUrl;
    await image.decode();

    // Average small patches in all four source corners. This produces a
    // seamless canvas even if the canonical artwork's navy shade changes.
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = image.naturalWidth;
    sampleCanvas.height = image.naturalHeight;
    const sampleContext = sampleCanvas.getContext("2d", { willReadFrequently: true });
    sampleContext.drawImage(image, 0, 0);
    const patch = Math.max(2, Math.round(image.naturalWidth * 0.02));
    const corners = [
      [0, 0],
      [image.naturalWidth - patch, 0],
      [0, image.naturalHeight - patch],
      [image.naturalWidth - patch, image.naturalHeight - patch],
    ];
    const totals = [0, 0, 0, 0];
    let pixels = 0;
    for (const [x, y] of corners) {
      const data = sampleContext.getImageData(x, y, patch, patch).data;
      for (let i = 0; i < data.length; i += 4) {
        totals[0] += data[i];
        totals[1] += data[i + 1];
        totals[2] += data[i + 2];
        totals[3] += data[i + 3];
        pixels += 1;
      }
    }
    const background = totals[3] / pixels < 250
      ? fallbackBackground
      : `rgb(${totals.slice(0, 3).map((value) => Math.round(value / pixels)).join(",")})`;

    return outputs.map(([name, size]) => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      context.fillStyle = background;
      context.fillRect(0, 0, size, size);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      const inset = Math.round(size * insetRatio);
      context.drawImage(image, inset, inset, size - (2 * inset), size - (2 * inset));
      return [name, canvas.toDataURL("image/png")];
    });
  }, {
    sourceUrl,
    outputs: OUTPUTS,
    insetRatio: SAFE_INSET_RATIO,
    fallbackBackground: FALLBACK_BACKGROUND,
  });

  for (const [name, dataUrl] of rendered) {
    writeFileSync(join(PUBLIC, name), Buffer.from(dataUrl.split(",")[1], "base64"));
    console.log(`wrote web/public/${name}`);
  }
} finally {
  await browser.close();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
