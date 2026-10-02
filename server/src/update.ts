import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { VERSION } from "./version.ts";
import { getSettings } from "./db.ts";
import { logEvent } from "./auth.ts";

// Where releases are announced. Tests may override the API endpoint, but image
// identity remains fixed to the upstream repository and signed release workflow.
const UPDATE_API = process.env.NGINUX_UPDATE_API ?? "https://api.github.com/repos/UbhiTS/nginux";
// The one trusted image repository. A release tag is selected from GitHub, then
// its signed artifact attestation supplies the immutable digest used by Docker.
export const UPDATE_IMAGE = "ghcr.io/ubhits/nginux";
const UPDATE_REPO = "UbhiTS/nginux";
const UPDATE_WORKFLOW = "github.com/UbhiTS/nginux/.github/workflows/release.yml";
const UPDATE_SOURCE_REF = "refs/heads/main";
const RELEASE_TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_RE = /^[0-9a-f]{40}$/i;
const IMAGE_DIGEST_RE = /^[0-9a-f]{64}$/i;
const execFileAsync = promisify(execFile);
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
  latestTag: string | null;
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
  latestTag: null,
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

/** Validate the exact release-tag grammar produced by release.yml. */
export function releaseVersion(tag: string): string | null {
  const match = RELEASE_TAG_RE.exec(tag);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function releaseImage(tag: string): string {
  if (!releaseVersion(tag)) throw new Error(`Invalid release tag: ${tag}`);
  return `${UPDATE_IMAGE}:${tag}`;
}

type AttestationOutput = Array<{
  verificationResult?: {
    statement?: {
      subject?: Array<{ name?: string; digest?: { sha256?: string } }>;
    };
  };
}>;

/** Extract the one signed subject digest and bind it to our expected repository. */
export function attestedImageRef(output: string): string {
  let parsed: AttestationOutput;
  try {
    parsed = JSON.parse(output) as AttestationOutput;
  } catch {
    throw new Error("GitHub returned malformed attestation JSON.");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("GitHub returned no verified image attestation.");

  const digests = new Set<string>();
  for (const result of parsed) {
    for (const subject of result.verificationResult?.statement?.subject ?? []) {
      if (subject.name?.toLowerCase() !== UPDATE_IMAGE) continue;
      const digest = subject.digest?.sha256?.toLowerCase() ?? "";
      if (IMAGE_DIGEST_RE.test(digest)) digests.add(digest);
    }
  }
  if (digests.size !== 1) throw new Error("Verified attestation did not contain exactly one NginUX image digest.");
  return `${UPDATE_IMAGE}@sha256:${[...digests][0]}`;
}

export function attestationVerifyArgs(tag: string, sourceSha: string): string[] {
  if (!COMMIT_RE.test(sourceSha)) throw new Error("Attestation source must be a full Git commit SHA.");
  return [
    "attestation", "verify", `oci://${releaseImage(tag)}`,
    "--repo", UPDATE_REPO,
    "--signer-workflow", UPDATE_WORKFLOW,
    "--source-digest", sourceSha.toLowerCase(),
    "--source-ref", UPDATE_SOURCE_REF,
    "--deny-self-hosted-runners",
    "--bundle-from-oci",
    "--format", "json",
  ];
}

async function verifyReleaseImage(tag: string, sourceSha: string): Promise<string> {
  // The control plane runs unprivileged and may inherit HOME=/root. Give gh an
  // isolated writable home for Sigstore trusted-root/cache material, then remove it.
  const ghHome = mkdtempSync(join(tmpdir(), "nginux-gh-"));
  let stdout: string | Buffer;
  try {
    ({ stdout } = await execFileAsync("/usr/bin/gh", attestationVerifyArgs(tag, sourceSha), {
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        HOME: ghHome,
        GH_CONFIG_DIR: join(ghHome, "config"),
        XDG_CACHE_HOME: join(ghHome, "cache"),
        GH_PROMPT_DISABLED: "1",
        GH_NO_UPDATE_NOTIFIER: "1",
      },
    }));
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    throw new Error(`Image attestation verification failed: ${detail}`);
  } finally {
    rmSync(ghHome, { recursive: true, force: true });
  }
  return attestedImageRef(String(stdout));
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
    const latest = releaseVersion(tag);
    if (!latest) throw new Error("Release feed tag must be canonical semver (vMAJOR.MINOR.PATCH).");
    const commit = await ghJson(`/commits/${encodeURIComponent(tag)}`);
    const latestSha = String(commit?.sha ?? "");
    if (!COMMIT_RE.test(latestSha)) throw new Error("Release tag did not resolve to a full Git commit SHA.");
    state.latestTag = tag;
    state.latestVersion = latest;
    state.latestSha = latestSha.toLowerCase();
    state.releaseName = String(rel?.name ?? tag);
    state.notes = String(rel?.body ?? "").slice(0, 4000) || null;
    // The UI renders this as a link: only accept the canonical GitHub release URL shape.
    const relUrl = String(rel?.html_url ?? "");
    state.releaseUrl = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/tag\/[A-Za-z0-9_.-]+$/.test(relUrl) ? relUrl : null;
    state.publishedAt = String(rel?.published_at ?? "") || null;

    const cmp = semverCompare(latest, VERSION);
    if (cmp > 0) {
      state.available = true;
    } else if (cmp === 0 && BUILD_SHA) {
      // Same version number - compare the tag's commit to the running build.
      state.available = !!state.latestSha && !state.latestSha.startsWith(BUILD_SHA) && !BUILD_SHA.startsWith(state.latestSha);
    } else {
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
export function dockerPullTarget(imageRef: string): { image: string; tag: string } {
  const slash = imageRef.lastIndexOf("/");
  const at = imageRef.lastIndexOf("@");
  const idx = imageRef.lastIndexOf(":");
  if (at > slash) return { image: imageRef.slice(0, at), tag: imageRef.slice(at + 1) };
  if (idx > slash) return { image: imageRef.slice(0, idx), tag: imageRef.slice(idx + 1) };
  throw new Error("Docker pull requires an explicit tag or digest.");
}

function dockerPull(imageRef: string, timeoutMs = 300_000): Promise<void> {
  const { image, tag } = dockerPullTarget(imageRef);
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: DOCKER_SOCK,
      method: "POST",
      path: `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`,
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
 * One-click self-update: verify and pull the new image by digest, then hand off
 * to a short-lived updater container created from the CURRENT trusted image.
 * It stops this container, recreates it with the same configuration on the
 * verified image, waits for it to become healthy, and rolls back if not.
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

  // Refresh release metadata at the security boundary. Never install from stale
  // UI state, and always bind the release tag to its full source commit.
  const checked = await checkForUpdate();
  if (checked.checkError || !checked.latestTag || !checked.latestSha) {
    const message = checked.checkError ?? "Latest release metadata was incomplete.";
    state.applyState = "failed";
    state.applyError = message;
    return { ok: false, message };
  }
  if (!checked.available) return { ok: false, message: "No newer verified release is available." };

  try {
    state.applyState = "pulling";
    state.applyError = null;
    const verifiedImage = await verifyReleaseImage(checked.latestTag, checked.latestSha);
    state.image = verifiedImage;
    logEvent({ type: "system.update_started", severity: "notice", actor, summary: `Self-update to ${state.latestVersion} started`, ip: "", meta: { image: verifiedImage } });
    await dockerPull(verifiedImage);

    // The helper gets the root-equivalent Docker socket, so run the updater code
    // from our current trusted image rather than from the candidate being installed.
    const current = await dockerReq<{ Image?: string; message?: string }>("GET", `/containers/${selfId}/json`, undefined, 5000);
    const trustedImageId = current.body?.Image ?? "";
    if (current.status !== 200 || !/^sha256:[0-9a-f]{64}$/i.test(trustedImageId)) {
      throw new Error(`Couldn't resolve the current trusted image id: ${current.body?.message ?? `HTTP ${current.status}`}`);
    }

    // Override the entrypoint so the trusted image runs only the updater script.
    state.applyState = "handing-off";
    const name = `nginux-updater-${Date.now()}`;
    const create = await dockerReq<{ Id?: string; message?: string }>("POST", `/containers/create?name=${name}`, {
      Image: trustedImageId,
      Entrypoint: ["node"],
      Cmd: ["/app/server/updater.mjs"],
      Env: [`NGINUX_OLD_ID=${selfId}`, `NGINUX_NEW_IMAGE=${verifiedImage}`],
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
