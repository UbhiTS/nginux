// Render web/public/favicon.svg to a square web/public/logo.png (used as the
// authenticator icon via the otpauth `image=` param, and handy elsewhere).
//   node scripts/make-logo.mjs
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SIZE = 512;
const svg = readFileSync(join(ROOT, "web", "public", "favicon.svg"), "utf8");
const html = `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}svg{width:${SIZE}px;height:${SIZE}px;display:block}</style></head><body>${svg}</body></html>`;

const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const bin = process.env.NGINUX_SHOT_BIN ?? CANDIDATES.find((p) => existsSync(p));
if (!bin) throw new Error("No Chrome/Edge found — set NGINUX_SHOT_BIN.");

const profileDir = mkdtempSync(join(tmpdir(), "nginux-logo-"));
const browser = await puppeteer.launch({
  executablePath: bin,
  headless: true,
  userDataDir: profileDir,
  args: ["--no-sandbox", "--disable-gpu", "--force-color-profile=srgb"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: SIZE, height: SIZE, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.screenshot({ path: join(ROOT, "web", "public", "logo.png"), omitBackground: true, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
  console.log("wrote web/public/logo.png (512×512)");
} finally {
  await browser.close();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
