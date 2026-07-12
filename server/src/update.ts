import { existsSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import http from "node:http";
import { VERSION } from "./version.ts";
import { getSettings } from "./db.ts";
import { logEvent } from "./auth.ts";

// Where releases are announced. Overridable so forks (and tests) can point at
// their own repo; the default is the upstream NginUX repo.
const UPDATE_API = process.env.NGINUX_UPDATE_API ?? "https://api.github.com/repos/UbhiTS/nginux";
// The image a self-update pulls and relaunches from.
export const UPDATE_IMAGE = process.env.NGINUX_UPDATE_IMAGE ?? "ghcr.io/ubhits/nginux:latest";
// Baked at image build time (release workflow passes the commit SHA). Lets the
// checker detect "same version number, newer build" - without it only version
// bumps are detectable.
export const BUILD_SHA = process.env.NGINUX_BUILD_SHA ?? "";
const DOCKER_SOCK = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";
const CHECK_INTERVAL_MS = 6 * 3600_000;
const UA = { "User-Agent": `nginux/${VERSION}`, Accept: "application/vnd.github+json" };

export interface UpdateState {
  current: string;
  buildSha: string;
  latestVersion: string | null;
  latestSha: string | null;
  releaseName: string | null;
  notes: string | null;
  releaseUrl: string | null;
  publishedAt: string | null;
  available: boolean;
  /** true when the running build can replace itself (docker socket mounted + alive) */
  canSelfUpdate: boolean;
  image: string;
  checkedAt: string | null;
  checkError: string | null;
  /** idle | pulling | handing-off | failed - the apply lifecycle */
  applyState: "idle" | "pulling" | "handing-off" | "failed";
  applyError: string | null;
  simulated: boolean;
}

const state: UpdateState = {
  current: VERSION,
  buildSha: BUILD_SHA,
  latestVersion: null,
  latestSha: null,
  releaseName: null,
  notes: null,
  releaseUrl: null,
  publishedAt: null,
  available: false,
  canSelfUpdate: false,
  image: UPDATE_IMAGE,
  checkedAt: null,
  checkError: null,
  applyState: "idle",
  applyError: null,
  simulated: false,
};

/** "1.2.10" vs "1.2.9" - numeric per-segment compare; returns >0 when a > b.
 *  Exported for regression tests (release-detection is the trigger for a self-update). */
export function semverCompare(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function ghJson(path: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(`${UPDATE_API}${path}`, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`GitHub API ${res.status} for ${path}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function checkForUpdate(): Promise<UpdateState> {
  try {
    const rel = await ghJson("/releases/latest");
    const tag = String(rel?.tag_name ?? "");
    if (!tag) throw new Error("Release feed had no tag.");
    const latest = tag.replace(/^v/i, "");
    state.latestVersion = latest;
    state.releaseName = String(rel?.name ?? tag);
    state.notes = String(rel?.body ?? "").slice(0, 4000) || null;
    state.releaseUrl = String(rel?.html_url ?? "") || null;
    state.publishedAt = String(rel?.published_at ?? "") || null;

    const cmp = semverCompare(latest, VERSION);
    if (cmp > 0) {
      state.latestSha = null;
      state.available = true;
    } else if (cmp === 0 && BUILD_SHA) {
      // Same version number - compare build SHAs so a re-cut release of the
      // same tag (rebuilt image) is still detected.
      const commit = await ghJson(`/commits/${encodeURIComponent(tag)}`);
      state.latestSha = String(commit?.sha ?? "") || null;
      state.available = !!state.latestSha && !state.latestSha.startsWith(BUILD_SHA) && !BUILD_SHA.startsWith(state.latestSha);
    } else {
      state.latestSha = null;
      state.available = false;
    }
    state.checkError = null;
    state.simulated = false;
  } catch (e) {
    state.checkError = e instanceof Error ? e.message : String(e);
  }
  state.checkedAt = new Date().toISOString();
  state.canSelfUpdate = await dockerAlive();
  return state;
}

/** Dev-only: pretend the current build is stale so the UI flow can be exercised
 *  without waiting for a real newer release. Refused in production. */
export async function simulateStaleBuild(): Promise<UpdateState> {
  await checkForUpdate();
  if (!state.available) {
    state.available = true;
    state.latestSha = state.latestSha ?? "0000000simulated";
    state.simulated = true;
  }
  return state;
}

export function updateStatus(): UpdateState {
  return state;
}

export function startUpdateChecker(): void {
  const tick = () => {
    if (!getSettings().updateCheckEnabled) return;
    void checkForUpdate();
  };
  setTimeout(tick, 15_000).unref?.();
  setInterval(tick, CHECK_INTERVAL_MS).unref?.();
  // Tidy up any finished updater containers from a previous self-update.
  void sweepUpdaters();
}

// ---------------- Docker Engine API (over the optional socket mount) ----------------

function dockerReq<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; body: T }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      socketPath: DOCKER_SOCK,
      method,
      path,
      headers: { Host: "docker", "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed: unknown = text;
        try { parsed = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }
        resolve({ status: res.statusCode ?? 0, body: parsed as T });
      });
    });
    req.on("timeout", () => { req.destroy(new Error("Docker API timed out")); });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function dockerAlive(): Promise<boolean> {
  if (process.platform !== "linux" || !existsSync(DOCKER_SOCK)) return false;
  try {
    const r = await dockerReq("GET", "/_ping", undefined, 2000);
    return r.status === 200;
  } catch {
    return false;
  }
}

/** Pull an image, consuming the progress stream until completion. */
function dockerPull(imageRef: string, timeoutMs = 300_000): Promise<void> {
  const idx = imageRef.lastIndexOf(":");
  const slash = imageRef.lastIndexOf("/");
  const [img, tag] = idx > slash ? [imageRef.slice(0, idx), imageRef.slice(idx + 1)] : [imageRef, "latest"];
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: DOCKER_SOCK,
      method: "POST",
      path: `/images/create?fromImage=${encodeURIComponent(img)}&tag=${encodeURIComponent(tag)}`,
      headers: { Host: "docker" },
      timeout: timeoutMs,
    }, (res) => {
      let failed = "";
      res.on("data", (c: Buffer) => {
        // progress stream: one JSON object per line; an "error" line means the pull failed
        for (const line of c.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line) as { error?: string };
            if (j.error) failed = j.error;
          } catch { /* partial line across chunks - progress only, safe to skip */ }
        }
      });
      res.on("end", () => {
        if (res.statusCode !== 200 || failed) reject(new Error(failed || `Pull failed (HTTP ${res.statusCode})`));
        else resolve();
      });
    });
    req.on("timeout", () => req.destroy(new Error("Image pull timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** The container id we are running inside (docker sets the hostname to the
 *  short id by default; fall back to cgroup/mountinfo parsing). */
async function selfContainerId(): Promise<string | null> {
  const short = hostname();
  if (/^[0-9a-f]{12}$/i.test(short)) {
    try {
      const r = await dockerReq<{ Id?: string }>("GET", `/containers/${short}/json`, undefined, 4000);
      if (r.status === 200 && r.body?.Id) return r.body.Id;
    } catch { /* fall through to mountinfo */ }
  }
  for (const file of ["/proc/self/mountinfo", "/proc/self/cgroup"]) {
    try {
      const m = readFileSync(file, "utf8").match(/containers\/([0-9a-f]{64})/);
      if (m) return m[1];
    } catch { /* not available */ }
  }
  return null;
}

/** Remove exited nginux-updater-* containers left behind by past updates. */
async function sweepUpdaters(): Promise<void> {
  if (!(await dockerAlive())) return;
  try {
    const r = await dockerReq<Array<{ Id: string; Names: string[]; State: string }>>(
      "GET", `/containers/json?all=true&filters=${encodeURIComponent(JSON.stringify({ name: ["nginux-updater-"] }))}`, undefined, 5000);
    if (r.status !== 200 || !Array.isArray(r.body)) return;
    for (const c of r.body) {
      if (c.State !== "running") await dockerReq("DELETE", `/containers/${c.Id}?force=true`, undefined, 5000);
    }
  } catch { /* purely cosmetic cleanup */ }
}

/**
 * One-click self-update: pull the new image, then hand off to a short-lived
 * updater container (created FROM the new image, so it runs the new updater
 * code) which stops this container, recreates it with the same configuration
 * on the new image, waits for it to become healthy, and rolls back if not.
 */
export async function applyUpdate(actor: string): Promise<{ ok: boolean; message: string }> {
  if (!(await dockerAlive())) {
    return {
      ok: false,
      message: "The Docker socket isn't mounted, so NginUX can't update itself. Mount /var/run/docker.sock " +
        "into the container (see docker-compose.yml) or update manually: docker compose pull && docker compose up -d",
    };
  }
  if (state.applyState === "pulling" || state.applyState === "handing-off") {
    return { ok: false, message: "An update is already in progress." };
  }
  const selfId = await selfContainerId();
  if (!selfId) {
    state.applyState = "failed";
    state.applyError = "Couldn't determine this container's id.";
    return { ok: false, message: "Couldn't determine this container's id - update manually with docker compose pull && up -d." };
  }

  try {
    state.applyState = "pulling";
    state.applyError = null;
    logEvent({ type: "system.update_started", severity: "notice", actor, summary: `Self-update to ${state.latestVersion ?? "latest"} started`, ip: "", meta: { image: UPDATE_IMAGE } });
    await dockerPull(UPDATE_IMAGE);

    // Updater runs from the image we just pulled - override the entrypoint so it
    // runs ONLY the updater script (no nginx/control-plane startup).
    state.applyState = "handing-off";
    const name = `nginux-updater-${Date.now()}`;
    const create = await dockerReq<{ Id?: string; message?: string }>("POST", `/containers/create?name=${name}`, {
      Image: UPDATE_IMAGE,
      Entrypoint: ["node"],
      Cmd: ["/app/server/updater.mjs"],
      Env: [`NGINUX_OLD_ID=${selfId}`, `NGINUX_NEW_IMAGE=${UPDATE_IMAGE}`],
      HostConfig: {
        Binds: [`${DOCKER_SOCK}:/var/run/docker.sock`],
        AutoRemove: false, // keep it around so `docker logs` can tell the story if something goes wrong
        RestartPolicy: { Name: "no" },
      },
    }, 15_000);
    if (create.status !== 201 || !create.body?.Id) {
      throw new Error(`Couldn't create the updater container: ${create.body?.message ?? `HTTP ${create.status}`}`);
    }
    const start = await dockerReq<{ message?: string }>("POST", `/containers/${create.body.Id}/start`, undefined, 15_000);
    if (start.status !== 204) throw new Error(`Couldn't start the updater container: ${start.body?.message ?? `HTTP ${start.status}`}`);

    // From here the updater stops this container; the HTTP response races the
    // shutdown, which is fine - the UI polls /api/health until we're back.
    return { ok: true, message: "New image pulled - restarting onto it now. This page will reconnect automatically." };
  } catch (e) {
    state.applyState = "failed";
    state.applyError = e instanceof Error ? e.message : String(e);
    logEvent({ type: "system.update_failed", severity: "warn", actor, summary: "Self-update failed before handoff", ip: "", meta: { error: state.applyError } });
    return { ok: false, message: state.applyError };
  }
}
