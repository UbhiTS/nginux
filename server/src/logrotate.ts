// Rotates the on-disk nginx logs so they can't grow unbounded and fill the data
// volume. nginx has no built-in rotation; the control plane (which already drives
// nginx) handles it on a timer, sized by the Settings -> Logs knobs. The metrics
// tailer is rotation-aware (it resets when the file shrinks), so this is safe and
// never disturbs the live dashboards (those are in-memory).
import { closeSync, existsSync, openSync, renameSync, rmSync, statSync, truncateSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "./db.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ACCESS_LOG = process.env.NGINX_ACCESS_LOG ?? join(__dirname, "..", "data", "logs", "access.log");
const LOG_DIR = process.env.NGINX_LOG_DIR ?? dirname(ACCESS_LOG);
const NGINX_BIN = process.env.NGINX_BIN ?? "nginx";
const LOG_FILES = ["access.log", "stream.log", "error.log"];

/** Rotate one log file if it's over `maxBytes`. `keep` = how many .N copies to
 *  retain (0 = truncate in place, no history). Returns true if it rotated. */
function rotateOne(file: string, maxBytes: number, keep: number): boolean {
  const path = join(LOG_DIR, file);
  let size: number;
  try {
    if (!existsSync(path)) return false;
    size = statSync(path).size;
  } catch { return false; }
  if (size <= maxBytes) return false;
  try {
    if (keep <= 0) {
      // No history wanted - truncate in place; `nginx -s reopen` re-anchors it.
      truncateSync(path, 0);
    } else {
      // Drop the oldest, shift .i -> .(i+1), then move the live log to .1.
      const oldest = `${path}.${keep}`;
      if (existsSync(oldest)) rmSync(oldest, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        const from = `${path}.${i}`;
        if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
      }
      renameSync(path, `${path}.1`);
      // Recreate the live file so the tailer + nginx always have a path to open.
      try { closeSync(openSync(path, "a")); } catch { /* nginx reopen will create it */ }
    }
    return true;
  } catch { return false; }
}

/** Rotate any oversize log now per the current settings. Returns # rotated. */
export function rotateLogsNow(): number {
  const s = getSettings();
  const maxMb = Number(s.logMaxMb) || 0;
  if (maxMb <= 0) return 0; // rotation disabled
  const maxBytes = maxMb * 1024 * 1024;
  const keep = Math.max(0, Math.floor(Number(s.logKeepFiles) || 0));
  let rotated = 0;
  for (const f of LOG_FILES) if (rotateOne(f, maxBytes, keep)) rotated++;
  // Make nginx close + reopen its logs by path so it writes to the fresh files.
  // Best-effort: nginx may not be running (e.g. dev) - ignore failures.
  if (rotated) execFile(NGINX_BIN, ["-s", "reopen"], () => {});
  return rotated;
}

export function startLogRotation(): void {
  try { rotateLogsNow(); } catch { /* ignore */ }
  setInterval(() => { try { rotateLogsNow(); } catch { /* ignore */ } }, 5 * 60_000).unref?.();
}
