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

// The pages to capture: [filename, nav-item label, optional async prep(page)].
// "" label = the default dashboard (no click needed). The prep hook runs after
// navigation + settle, for pages that need an interaction (e.g. hovering the
// traffic map to surface its country popup) before the shot.
const SHOTS = [
  ["dashboard", ""],
  ["services", "Services"],
  ["security", "Security Center"],
  ["certificates", "Certificates"],
  ["logs", "Logs", async (page) => {
    // Bring the traffic map into frame, then surface its busiest country's "top
    // source IPs" popup so the capture shows off the per-country drill-down.
    await page.evaluate(() => {
      const head = [...document.querySelectorAll(".card-head")].find((h) => h.textContent.includes("Traffic map"));
      head?.closest(".card")?.scrollIntoView({ block: "center" });
      // Pick the largest bubble (busiest country) and fire a bubbling mouseover -
      // React synthesizes onMouseEnter from it, opening the popup. Its x/y come
      // from the bubble's own coords, so we don't need real cursor positioning.
      const bubbles = [...document.querySelectorAll("svg g")].filter((g) => g.style.cursor === "pointer");
      let best = null, bestR = -1;
      for (const g of bubbles) {
        const r = parseFloat(g.querySelector("circle")?.getAttribute("r") ?? "0");
        if (r > bestR) { bestR = r; best = g; }
      }
      best?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 550));
  }],
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

  // Optional: capture only a subset, e.g. NGINUX_SHOT_ONLY=logs (comma-separated).
  const only = (process.env.NGINUX_SHOT_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const [name, label, prep] of SHOTS) {
    if (only.length && !only.includes(name)) continue;
    await page.goto(BASE, { waitUntil: "networkidle2" });
    // Hide the notification toast stack so it doesn't cover the UI in captures.
    await page.addStyleTag({ content: ".toast-stack{display:none!important}" }).catch(() => {});
    if (label) {
      await page.evaluate((text) => {
        const el = [...document.querySelectorAll(".nav-item, .nav-child")]
          .find((e) => e.textContent.trim().startsWith(text));
        if (el) el.click();
      }, label);
    }
    await new Promise((r) => setTimeout(r, 1400)); // let charts/topology settle
    if (prep) await prep(page);
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    console.log("✓", file);
  }
} finally {
  await browser.close();
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
