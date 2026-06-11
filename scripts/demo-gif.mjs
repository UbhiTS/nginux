// Regenerate the README demo media from a running NginUX instance: a dark-theme
// feature tour with a visible cursor - dashboard topology, per-service
// analytics, traffic map, live log, certs, Security Center - ending with a spin
// through all five themes.
//
// The two published artifacts and how to reproduce them:
//   docs/img/nginux-demo.gif  (README hero, ~57s @ 30fps, 880px - GitHub's
//                              README column displays ~880px, so wider only costs bytes)
//     NGINUX_GIF_SMOOTH=1 NGINUX_GIF_WIDTH=880 node scripts/demo-gif.mjs
//   docs/img/nginux-demo.mp4  (HD click-through + social uploads, 1080px H.264)
//     NGINUX_GIF_SMOOTH=1 NGINUX_GIF_OUT=docs/img/nginux-demo.mp4 node scripts/demo-gif.mjs
//
// Drives your installed Edge/Chrome headlessly via puppeteer-core, captures
// frames to a temp dir, then encodes with ffmpeg (two-pass palette for GIF,
// H.264 for .mp4 outputs). Uses `ffmpeg-static` if installed
// (npm i --no-save ffmpeg-static), else `ffmpeg` on PATH.
//
// Config via env (all optional):
//   NGINUX_GIF_URL           base URL            (default http://localhost:6767)
//   NGINUX_GIF_USER          admin username      (default "admin")
//   NGINUX_GIF_PASS          admin password      (default "admin")
//   NGINUX_GIF_BIN           browser executable  (default: auto-detect Edge/Chrome)
//   NGINUX_GIF_SERVICE       service NAME for the analytics scene (default: first service)
//   NGINUX_GIF_RESOLVE       chrome --host-resolver-rules value, for instances whose
//                            login cookie is scoped to a real domain (e.g.
//                            "MAP *.example.com 127.0.0.1")
//   NGINUX_GIF_HOME_COUNTRY  if set, writes Settings → home country first so the
//                            traffic-map arcs have somewhere to converge (e.g. "US")
//   NGINUX_GIF_OUT           output path; .mp4 switches the encode to H.264
//   NGINUX_GIF_SMOOTH        "1" = ~30fps capture with longer per-screen dwell
//   NGINUX_GIF_WIDTH / _FPS / _COLORS   encode tuning (default 1080 / 14, 30 when smooth / 200)
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import puppeteer from "puppeteer-core";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GIF = join(ROOT, "docs", "img", "nginux-demo.gif");
// NGINUX_GIF_OUT overrides the output path; a .mp4 extension switches the encode
// to H.264 (smoother and smaller than GIF - right for LinkedIn/social uploads).
const OUTPUT = process.env.NGINUX_GIF_OUT ? resolve(process.env.NGINUX_GIF_OUT) : GIF;
const MP4 = OUTPUT.toLowerCase().endsWith(".mp4");
// NGINUX_GIF_SMOOTH=1: capture at ~30fps with finer cursor interpolation and
// subdivided SVG motion, and dwell ~1.8x longer per screen (longest on the
// dashboard). The default profile stays snappy/small for the README GIF.
const SMOOTH = process.env.NGINUX_GIF_SMOOTH === "1";
const BASE = process.env.NGINUX_GIF_URL ?? "http://localhost:6767";
const USER = process.env.NGINUX_GIF_USER ?? "admin";
const PASS = process.env.NGINUX_GIF_PASS ?? "admin";
const WIDTH = Number(process.env.NGINUX_GIF_WIDTH ?? 1080);
const FPS = Number(process.env.NGINUX_GIF_FPS ?? (SMOOTH ? 30 : 14));
const COLORS = Number(process.env.NGINUX_GIF_COLORS ?? 200);
const DWELL = SMOOTH ? 1.8 : 1; // static-screen hold multiplier
const W = 1440, H = 900;

// Chrome first: the x86 Edge stub can exit 0 immediately under puppeteer headless.
const CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const bin = process.env.NGINUX_GIF_BIN ?? CANDIDATES.find((p) => existsSync(p));
if (!bin) throw new Error("No Edge/Chrome found - set NGINUX_GIF_BIN to a browser executable.");

async function ffmpegBin() {
  try { return (await import("ffmpeg-static")).default; }
  catch { return "ffmpeg"; } // PATH fallback; errors below if absent
}

const OUT = mkdtempSync(join(tmpdir(), "nginux-gif-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const manifest = []; // { file, duration } - per-frame display seconds
let idx = 0;
let page;
let curX = W / 2, curY = H / 2;

async function shot(durationSec) {
  const file = join(OUT, `f${String(idx++).padStart(4, "0")}.png`);
  await page.screenshot({ path: file });
  manifest.push({ file, duration: durationSec });
}
// A scene-level hold: scales with the profile so smooth captures linger longer.
const hold = (durationSec) => shot(durationSec * DWELL);
// Headless screenshots don't include the OS cursor - draw one that follows the
// real mouse events, plus a click ripple, so the viewer can see the interaction.
async function injectCursor() {
  await page.evaluate(() => {
    if (document.getElementById("__cur")) return;
    const c = document.createElement("div");
    c.id = "__cur";
    c.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));";
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 26 26"><path d="M3 2 L3 20 L8 15.2 L11.4 22.2 L14.2 20.9 L10.9 14 L17.6 14 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    document.body.appendChild(c);
    const move = (x, y) => { c.style.transform = `translate(${x}px,${y}px)`; };
    move(-60, -60);
    document.addEventListener("mousemove", (e) => move(e.clientX, e.clientY), true);
    window.__ripple = (x, y) => {
      const r = document.createElement("div");
      r.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:10px;height:10px;border:2.5px solid #3b82f6;border-radius:50%;z-index:2147483646;pointer-events:none;transform:translate(-50%,-50%);opacity:.95;transition:all .38s ease-out;`;
      document.body.appendChild(r);
      requestAnimationFrame(() => { r.style.width = "40px"; r.style.height = "40px"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 430);
    };
  });
  await page.mouse.move(curX, curY);
}
// Ease the cursor to (x,y), screenshotting each step.
async function moveTo(x, y, frames = SMOOTH ? 14 : 7, holdSec = SMOOTH ? 1 / 30 : 0.045) {
  const sx = curX, sy = curY;
  for (let i = 1; i <= frames; i++) {
    let t = i / frames; t = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    await page.mouse.move(sx + (x - sx) * t, sy + (y - sy) * t);
    await shot(holdSec);
  }
  curX = x; curY = y;
}
async function clickFx() {
  await page.evaluate((x, y) => window.__ripple(x, y), curX, curY);
  await shot(0.1); await shot(0.16);
}
async function coords(sel, text) {
  return await page.evaluate((s, t) => {
    const els = [...document.querySelectorAll(s)];
    const el = t ? els.find((e) => (e.textContent || "").includes(t) && e.offsetParent !== null) : els.find((e) => e.offsetParent !== null);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, sel, text || null);
}
// Deterministic SVG (SMIL) motion: advance every svg clock, snap a frame each
// step. Smooth profile re-samples the same span at ~30fps (same wall-clock and
// same SVG-time, just many more in-between frames).
async function animateSvg(count, stepSec, holdSec, baseSec = 1.0) {
  let n = count, step = stepSec, holdF = holdSec;
  if (SMOOTH) {
    const svgSpan = count * stepSec, wall = count * holdSec;
    n = Math.max(count, Math.round(wall * 30));
    step = svgSpan / n;
    holdF = wall / n;
  }
  for (let i = 0; i < n; i++) {
    await page.evaluate((t) => { document.querySelectorAll("svg").forEach((s) => { try { s.setCurrentTime(t); } catch { /* static svg */ } }); }, baseSec + i * step);
    await shot(holdF);
  }
}
// Real-time frames (for SSE-driven content like the live access log).
async function animateReal(count, intervalMs) {
  for (let i = 0; i < count; i++) { await shot(intervalMs / 1000); if (i < count - 1) await sleep(intervalMs); }
}
async function navClick(sel, text, hash, waitText) {
  const c = await coords(sel, text);
  if (c) { await moveTo(c.x, c.y); await clickFx(); }
  await page.evaluate((h) => { window.location.hash = h; }, hash);
  await sleep(450);
  if (waitText) { try { await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 9000 }, waitText); } catch { /* best effort */ } }
  await sleep(600);
}
async function expandWithCursor(title) {
  const c = await coords(".collapsible-head", title);
  if (c) { await moveTo(c.x, c.y); await clickFx(); }
  await page.evaluate((t) => { const h = [...document.querySelectorAll(".collapsible-head")].find((x) => (x.textContent || "").includes(t)); if (h) h.click(); }, title);
}
async function scrollToText(sel, text, nudge = -18) {
  await page.evaluate((s, t, n) => { const el = [...document.querySelectorAll(s)].find((x) => (x.textContent || "").includes(t)); if (el) { el.scrollIntoView({ block: "start" }); window.scrollBy(0, n); } }, sel, text, nudge);
}

const args = [
  "--no-sandbox", "--hide-scrollbars", "--force-color-profile=srgb",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows",
];
if (process.env.NGINUX_GIF_RESOLVE) args.push(`--host-resolver-rules=${process.env.NGINUX_GIF_RESOLVE}`);

const browser = await puppeteer.launch({
  executablePath: bin,
  headless: true,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  args,
});
try {
  page = await browser.newPage();

  // ---- LOGIN ----
  console.log("login…");
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(900);
  if (await page.$("input[type=password]")) {
    const inputs = await page.$$("form input");
    await inputs[0].click({ clickCount: 3 });
    await inputs[0].type(USER, { delay: 20 });
    await page.type("input[type=password]", PASS, { delay: 20 });
    await page.click("button.btn-primary");
  }
  await page.waitForSelector('button[aria-label="Switch theme"]', { timeout: 20000 });
  await page.evaluate(() => { localStorage.setItem("nginux-theme", "dark"); document.documentElement.setAttribute("data-theme", "dark"); });
  if (process.env.NGINUX_GIF_HOME_COUNTRY) {
    await page.evaluate((cc) => fetch("/api/settings", { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ homeCountry: cc }) }).catch(() => {}), process.env.NGINUX_GIF_HOME_COUNTRY);
  }
  await sleep(1200); // hosts load into the sidebar
  // The analytics scene features one service: NGINUX_GIF_SERVICE or the first one.
  const svc = await page.evaluate(async (want) => {
    const hosts = await fetch("/api/hosts", { credentials: "include" }).then((r) => r.json()).catch(() => []);
    if (!Array.isArray(hosts) || !hosts.length) return null;
    const h = (want && hosts.find((x) => x.name === want)) || hosts[0];
    return { id: h.id, name: h.name };
  }, process.env.NGINUX_GIF_SERVICE ?? null);
  if (!svc) throw new Error("No services on this instance - the tour needs at least one.");
  await injectCursor();

  // ---- SCENE 1: Dashboard - show the alert toasts, dismiss them on-camera ----
  console.log("dashboard + dismiss notifications…");
  await page.evaluate(() => { window.location.hash = "#/dashboard"; window.scrollTo(0, 0); });
  await sleep(700);
  try { await page.waitForSelector(".toast", { timeout: 5000 }); } catch { /* none - fine */ }
  await hold(0.8); await hold(0.7);
  for (let k = 0; k < 3; k++) {
    const d = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".toast .toast-btn")].find((x) => /Dismiss/.test(x.textContent || ""));
      if (!b) return null; const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    if (!d) break;
    await moveTo(d.x, d.y); await clickFx();
    await page.evaluate(() => { const b = [...document.querySelectorAll(".toast .toast-btn")].find((x) => /Dismiss/.test(x.textContent || "")); if (b) b.click(); });
    await sleep(320);
  }
  await hold(0.7); // clean dashboard, KPIs revealed
  await moveTo(560, 430); // glide over the topology while traffic flows
  // The home screen is the hero - the smooth profile lets the topology's live
  // traffic flow for ~6s instead of ~2s.
  await animateSvg(SMOOTH ? 36 : 14, 0.16, 0.16);

  // ---- SCENE 2: Services ----
  console.log("services…");
  await navClick(".nav-parent", "Services", "#/services", "Services");
  await page.evaluate(() => window.scrollTo(0, 0));
  await hold(1.0); await hold(0.9);

  // ---- SCENE 3: Service detail → Traffic & errors ----
  console.log(`service analytics (${svc.name})…`);
  await navClick(".nav-child", svc.name, `#/host/${svc.id}`, "Traffic & logs");
  await page.evaluate(() => window.scrollTo(0, 0));
  await hold(1.2);
  await expandWithCursor("Traffic & errors");
  try { await page.waitForFunction(() => { const v = document.querySelector(".host-analytics .stat .value"); return v && /\d/.test(v.textContent || ""); }, { timeout: 9000 }); } catch { /* still shows */ }
  await sleep(700);
  await scrollToText(".section-title", "Traffic & logs", -10);
  await sleep(300);
  await hold(1.2); await hold(1.1);

  // ---- SCENE 4: Geography map ----
  console.log("geography…");
  await expandWithCursor("Geography");
  try {
    await page.waitForFunction(() => {
      const card = [...document.querySelectorAll(".collapsible-head")].find((x) => (x.textContent || "").includes("Geography"))?.closest(".collapsible");
      return card && [...card.querySelectorAll("svg")].some((v) => { const vb = (v.getAttribute("viewBox") || "").split(" ").map(Number); return vb[2] > 100; });
    }, { timeout: 9000 });
  } catch { /* map may be empty without geo data */ }
  await sleep(1100);
  await scrollToText(".card-head", "Traffic map", -14);
  await sleep(250);
  await moveTo(620, 360);
  await animateSvg(SMOOTH ? 24 : 16, 0.15, 0.15);

  // ---- SCENE 5: Live access log ----
  console.log("live log…");
  await expandWithCursor("Live access log");
  try { await page.waitForFunction(() => { const c = [...document.querySelectorAll(".collapsible")].find((x) => (x.textContent || "").includes("Live access log")); return c && c.querySelector(".code"); }, { timeout: 9000 }); } catch { /* shown empty */ }
  await sleep(700);
  await scrollToText(".collapsible-title", "Live access log", -14);
  await sleep(300);
  await animateReal(SMOOTH ? 14 : 9, 230);

  // ---- SCENE 6: Logs (instance-wide traffic map) ----
  console.log("logs…");
  await navClick(".nav-item", "Logs", "#/logs", "Traffic");
  await scrollToText(".card-head", "Traffic map", -14);
  await sleep(250);
  await animateSvg(SMOOTH ? 18 : 12, 0.16, 0.16);

  // ---- SCENE 7: Certificates ----
  console.log("certificates…");
  await navClick(".nav-item", "Certificates", "#/certs", "ertificate");
  await page.evaluate(() => window.scrollTo(0, 0));
  await hold(1.0); await hold(0.9);

  // ---- SCENE 8: Security Center ----
  console.log("security…");
  await navClick(".nav-item", "Security Center", "#/security", "Security");
  await page.evaluate(() => window.scrollTo(0, 0));
  await hold(1.0); await hold(0.9);

  // ---- SCENE 9: Theme showcase (dark → … → light → back to dark) ----
  console.log("themes…");
  await navClick(".nav-item", "Dashboard", "#/dashboard", "Dashboard");
  await page.evaluate(() => window.scrollTo(0, 0));
  const tc = await coords('button[aria-label="Switch theme"]');
  if (tc) await moveTo(tc.x, tc.y);
  await page.evaluate((t) => { document.querySelectorAll("svg").forEach((s) => { try { s.setCurrentTime(t); } catch { /* static */ } }); }, 1.0);
  await hold(0.7);
  for (let t = 0; t < 4; t++) {
    await clickFx();
    await page.click('button[aria-label="Switch theme"]');
    await sleep(320);
    await page.evaluate((tm) => { document.querySelectorAll("svg").forEach((s) => { try { s.setCurrentTime(tm); } catch { /* static */ } }); }, 1.4 + t);
    await hold(0.7); await hold(0.4);
  }
  await clickFx(); // wrap back to dark for a clean loop
  await page.click('button[aria-label="Switch theme"]');
  await sleep(320);
  await hold(0.8);
  console.log(`captured ${manifest.length} frames`);
} finally {
  await browser.close();
}

// ---- ENCODE: honoring per-frame durations via the concat demuxer ----
// GIF: two-pass palette. MP4: H.264 (yuv420p + faststart - what LinkedIn,
// X, and other social uploaders expect; -2 keeps the height even).
const ff = await ffmpegBin();
const lines = [];
for (const m of manifest) { lines.push(`file '${m.file.split(/[\\/]/).pop()}'`); lines.push(`duration ${m.duration}`); }
lines.push(`file '${manifest[manifest.length - 1].file.split(/[\\/]/).pop()}'`); // repeat last so its duration sticks
const framesTxt = join(OUT, "frames.txt");
writeFileSync(framesTxt, lines.join("\n"));
mkdirSync(dirname(OUTPUT), { recursive: true });
console.log(`encoding ${MP4 ? "mp4" : "gif"} @ ${WIDTH}px ${FPS}fps…`);
try {
  if (MP4) {
    execFileSync(ff, ["-y", "-f", "concat", "-safe", "0", "-i", framesTxt,
      "-vf", `fps=${FPS},scale=${WIDTH}:-2:flags=lanczos`,
      "-c:v", "libx264", "-crf", "20", "-preset", "slow", "-pix_fmt", "yuv420p",
      "-movflags", "faststart", OUTPUT], { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    const palette = join(OUT, "palette.png");
    const vf = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;
    execFileSync(ff, ["-y", "-f", "concat", "-safe", "0", "-i", framesTxt,
      "-vf", `${vf},palettegen=max_colors=${COLORS}:stats_mode=diff`, palette], { stdio: ["ignore", "ignore", "pipe"] });
    execFileSync(ff, ["-y", "-f", "concat", "-safe", "0", "-i", framesTxt, "-i", palette,
      "-lavfi", `${vf}[x];[x][1:v]paletteuse=dither=floyd_steinberg:diff_mode=rectangle`,
      "-loop", "0", OUTPUT], { stdio: ["ignore", "ignore", "pipe"] });
  }
} catch (e) {
  throw new Error(`ffmpeg failed (${ff}). Install it on PATH or run: npm i --no-save ffmpeg-static\n${e.stderr ?? e.message}`);
} finally {
  rmSync(OUT, { recursive: true, force: true });
}
const dur = manifest.reduce((a, m) => a + m.duration, 0);
console.log(`=> ${OUTPUT}\n   ${(statSync(OUTPUT).size / 1e6).toFixed(2)} MB · ~${dur.toFixed(1)}s · ${WIDTH}px · ${FPS}fps`);
