// NginUX self-updater. Runs as a short-lived container created from the NEW
// image with the Docker socket mounted (see server/src/update.ts), and:
//
//   1. inspects the old NginUX container (NGINUX_OLD_ID)
//   2. stops it and moves it aside (rename -> <name>-old-<ts>)
//   3. creates a replacement with the SAME name/ports/volumes/env/limits on the
//      new image (NGINUX_NEW_IMAGE), and starts it
//   4. waits for its healthcheck to go healthy
//   5. healthy  -> removes the old container (update complete)
//      anything else -> removes the replacement, renames the old container
//      back, restarts it (full rollback - you stay on the prior version)
//
// Dependency-free on purpose: talks to the Docker Engine API over the unix
// socket with node:http only, and logs every step (visible via
// `docker logs nginux-updater-<ts>`).
import http from "node:http";

const SOCK = "/var/run/docker.sock";
const OLD_ID = process.env.NGINUX_OLD_ID;
const NEW_IMAGE = process.env.NGINUX_NEW_IMAGE;
const HEALTH_TIMEOUT_MS = 150_000;

const ts = () => new Date().toISOString();
const log = (msg) => console.log(`${ts()} [updater] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function req(method, path, body, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const r = http.request({
      socketPath: SOCK,
      method,
      path,
      headers: { Host: "docker", "Content-Type": "application/json", ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on("timeout", () => r.destroy(new Error(`Docker API timeout: ${method} ${path}`)));
    r.on("error", reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const must = (r, what, okStatuses = [200, 201, 204]) => {
  if (!okStatuses.includes(r.status)) {
    throw new Error(`${what} failed (HTTP ${r.status}): ${typeof r.body === "object" ? r.body?.message ?? JSON.stringify(r.body) : r.body}`);
  }
  return r.body;
};

/** Build the create-spec for the replacement from the old container's inspect:
 *  same env/cmd/ports/mounts/limits/networks, only the image changes. */
function cloneSpec(inspect) {
  const cfg = inspect.Config ?? {};
  const host = { ...(inspect.HostConfig ?? {}) };
  // Runtime-only / stale fields the create API shouldn't receive.
  delete host.ContainerIDFile;
  const endpoints = {};
  for (const [net, ep] of Object.entries(inspect.NetworkSettings?.Networks ?? {})) {
    endpoints[net] = {
      // keep user intent (static IPs, aliases, links); drop runtime state
      IPAMConfig: ep.IPAMConfig ?? undefined,
      Links: ep.Links ?? undefined,
      // docker auto-adds the old container's short-id as an alias - drop it
      Aliases: (ep.Aliases ?? []).filter((a) => !/^[0-9a-f]{12}$/i.test(a)),
    };
  }
  return {
    Image: NEW_IMAGE,
    Env: cfg.Env ?? [],
    Cmd: cfg.Cmd ?? undefined,
    Entrypoint: cfg.Entrypoint ?? undefined,
    User: cfg.User || undefined,
    WorkingDir: cfg.WorkingDir || undefined,
    Labels: cfg.Labels ?? {},
    ExposedPorts: cfg.ExposedPorts ?? undefined,
    Volumes: cfg.Volumes ?? undefined,
    HostConfig: host,
    NetworkingConfig: Object.keys(endpoints).length ? { EndpointsConfig: endpoints } : undefined,
  };
}

async function waitHealthy(id) {
  const start = Date.now();
  let lastState = "";
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    await sleep(3000);
    const r = await req("GET", `/containers/${id}/json`);
    if (r.status !== 200) { lastState = `inspect HTTP ${r.status}`; continue; }
    const st = r.body?.State ?? {};
    if (!st.Running) {
      // crashed during boot - no point waiting out the clock
      throw new Error(`replacement exited (code ${st.ExitCode ?? "?"})`);
    }
    const health = st.Health?.Status ?? "";
    if (health && health !== lastState) { log(`replacement health: ${health}`); lastState = health; }
    if (health === "healthy") return;
    if (!health) {
      // image without a healthcheck: 15s of stable running counts as up
      if (Date.now() - start > 15_000) return;
    }
  }
  throw new Error(`replacement did not become healthy within ${HEALTH_TIMEOUT_MS / 1000}s (last: ${lastState || "unknown"})`);
}

async function main() {
  if (!OLD_ID || !NEW_IMAGE) throw new Error("NGINUX_OLD_ID and NGINUX_NEW_IMAGE are required.");
  log(`updating container ${OLD_ID.slice(0, 12)} to image ${NEW_IMAGE}`);

  const inspect = must(await req("GET", `/containers/${OLD_ID}/json`), "inspect old container");
  const name = String(inspect.Name ?? "/nginux").replace(/^\//, "");
  const parkedName = `${name}-old-${Date.now()}`;
  const spec = cloneSpec(inspect);

  log(`stopping ${name}…`);
  must(await req("POST", `/containers/${OLD_ID}/stop?t=30`, undefined, 45_000), "stop old container", [204, 304]);
  log(`parking it as ${parkedName}`);
  must(await req("POST", `/containers/${OLD_ID}/rename?name=${encodeURIComponent(parkedName)}`), "rename old container", [204]);

  let newId = null;
  try {
    log(`creating ${name} from ${NEW_IMAGE}`);
    const created = must(await req("POST", `/containers/create?name=${encodeURIComponent(name)}`, spec), "create replacement");
    newId = created.Id;
    log(`starting ${newId.slice(0, 12)}…`);
    must(await req("POST", `/containers/${newId}/start`), "start replacement", [204]);
    await waitHealthy(newId);
    log("replacement is healthy - removing the old container");
    await req("DELETE", `/containers/${OLD_ID}?force=true`, undefined, 60_000);
    log("update complete ✓");
  } catch (err) {
    log(`UPDATE FAILED: ${err?.message ?? err} - rolling back`);
    try {
      if (newId) await req("DELETE", `/containers/${newId}?force=true`, undefined, 60_000);
      must(await req("POST", `/containers/${OLD_ID}/rename?name=${encodeURIComponent(name)}`), "restore old name", [204]);
      must(await req("POST", `/containers/${OLD_ID}/start`), "restart old container", [204, 304]);
      log("rollback complete - still on the previous version");
    } catch (rb) {
      log(`ROLLBACK FAILED: ${rb?.message ?? rb} - manual intervention needed: ` +
        `docker start ${OLD_ID.slice(0, 12)} (it is parked as ${parkedName})`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => { log(`fatal: ${e?.message ?? e}`); process.exitCode = 1; });
