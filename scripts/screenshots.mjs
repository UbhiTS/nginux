// Regenerate the README screenshots from a running NginUX instance.
//
//   node scripts/screenshots.mjs
//
// Drives your installed Edge/Chrome headlessly via puppeteer-core (no bundled
// browser download). Logs in with the API, then captures each page to docs/img/.
//
// Config via env (all optional):
//   NGINUX_SHOT_URL   base URL              (default http://localhost:4600)
//   NGINUX_SHOT_USER  admin username        (default "admin")
//   NGINUX_SHOT_PASS  admin password        (default "admin")
//   NGINUX_SHOT_BIN   browser executable    (default: auto-detect Edge/Chrome)
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "img");
const BASE = process.env.NGINUX_SHOT_URL ?? "http://localhost:4600";
const USER = process.env.NGINUX_SHOT_USER ?? "admin";
const PASS = process.env.NGINUX_SHOT_PASS ?? "admin";

const CANDIDATES = [
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const bin = process.env.NGINUX_SHOT_BIN ?? CANDIDATES.find((p) => existsSync(p));
if (!bin) throw new Error("No Edge/Chrome found - set NGINUX_SHOT_BIN to a browser executable.");

// The pages to capture: [filename, nav-item label shown in the sidebar].
// "" label = the default dashboard (no click needed).
const SHOTS = [
  ["dashboard", ""],
  ["services", "Services"],
  ["security", "Security Center"],
  ["certificates", "Certificates"],
  ["agents", "Agents & API"],
];

if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// A fresh, unique profile dir stops Edge/Chrome from handing off to an
// already-open instance (which makes our spawned process exit immediately) and
// avoids any stale singleton lock from a previous run.
const profileDir = mkdtempSync(join(tmpdir(), "nginux-shot-"));
const browser = await puppeteer.launch({
  executablePath: bin,
  headless: true,
  userDataDir: profileDir,
  defaultViewport: { width: 1360, height: 900, deviceScaleFactor: 2 },
  dumpio: !!process.env.NGINUX_SHOT_DEBUG,
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--force-color-profile=srgb"],
});
try {
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: "networkidle2" });
  // Authenticate inside the browser context so the session cookie is set.
  const ok = await page.evaluate(async (u, p) => {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    return r.ok;
  }, USER, PASS);
  if (!ok) throw new Error(`Login failed for "${USER}". Set NGINUX_SHOT_USER/NGINUX_SHOT_PASS.`);

  for (const [name, label] of SHOTS) {
    await page.goto(BASE, { waitUntil: "networkidle2" });
    if (label) {
      await page.evaluate((text) => {
        const el = [...document.querySelectorAll(".nav-item, .nav-child")]
          .find((e) => e.textContent.trim().startsWith(text));
        if (el) el.click();
      }, label);
    }
    await new Promise((r) => setTimeout(r, 1400)); // let charts/topology settle
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    console.log("✓", file);
  }
} finally {
  await browser.close();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
