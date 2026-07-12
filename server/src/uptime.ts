import { connect } from "node:net";
import { randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { getHost, listHosts, updateHost } from "./repo.ts";
import { logEvent } from "./auth.ts";

interface Check { ts: number; up: boolean; ms: number }
const history = new Map<string, Check[]>();
const HISTORY_MAX = 2000;

function push(id: string, up: boolean, ms: number) {
  const a = history.get(id) ?? [];
  a.push({ ts: Date.now(), up, ms });
  if (a.length > HISTORY_MAX) a.shift();
  history.set(id, a);
}

function openIncident(hostId: string, host: string) {
  // don't double-open
  const open = db.prepare("SELECT id FROM incidents WHERE hostId = ? AND endedAt IS NULL").get(hostId);
  if (open) return;
  db.prepare("INSERT INTO incidents (id, hostId, host, startedAt) VALUES (?,?,?,?)").run(
    randomUUID(), hostId, host, new Date().toISOString(),
  );
}
function closeIncident(hostId: string) {
  db.prepare("UPDATE incidents SET endedAt = ? WHERE hostId = ? AND endedAt IS NULL").run(
    new Date().toISOString(), hostId,
  );
}

// Require this many CONSECUTIVE failed probes before declaring a host down, so a
// single transient blip (a GC pause, a momentary packet drop) doesn't open a false
// incident + fire a danger alert + flap. Recovery is immediate (one good probe) -
// being fast to say "back online" is harmless; being fast to cry "down" is not.
const DOWN_STREAK = 2;
const failStreak = new Map<string, number>();

export function recordCheck(hostId: string, up: boolean, ms: number) {
  const host = getHost(hostId);
  if (!host) return;
  push(hostId, up, ms);

  if (up) {
    failStreak.delete(hostId);
    if (host.health === "online") return; // already up, nothing to do
    const wasDown = host.health === "down";
    updateHost(hostId, { health: "online" }); // resolves the initial "unknown" too
    if (wasDown) {
      closeIncident(hostId);
      logEvent({ type: "service.upstream_up", severity: "info", actor: "monitor", summary: `${host.name} is back online`, ip: "", meta: { host: host.domain } });
    }
    return;
  }

  // Failed probe: only act once we've seen DOWN_STREAK failures in a row.
  const streak = (failStreak.get(hostId) ?? 0) + 1;
  failStreak.set(hostId, streak);
  if (streak < DOWN_STREAK || host.health === "down") return;
  updateHost(hostId, { health: "down" });
  openIncident(hostId, host.domain);
  logEvent({ type: "service.upstream_down", severity: "danger", actor: "monitor", summary: `${host.name} is unreachable`, ip: "", meta: { host: host.domain } });
}

export function getUptime(hostId: string) {
  const host = getHost(hostId);
  if (!host) return null;
  const arr = history.get(hostId) ?? [];
  const upCount = arr.filter((c) => c.up).length;
  const pct = arr.length ? (upCount / arr.length) * 100 : host.health === "down" ? 0 : 100;
  const recent = arr.slice(-200).filter((c) => c.up);
  const avgMs = recent.length ? Math.round(recent.reduce((s, c) => s + c.ms, 0) / recent.length) : 0;

  // downsample history to ~40 bars
  const bars: number[] = [];
  const step = Math.max(1, Math.floor(arr.length / 40));
  for (let i = 0; i < arr.length; i += step) {
    const slice = arr.slice(i, i + step);
    bars.push(slice.every((c) => c.up) ? 1 : slice.some((c) => c.up) ? 0.5 : 0);
  }

  const incidents = db
    .prepare("SELECT * FROM incidents WHERE hostId = ? ORDER BY startedAt DESC LIMIT 10")
    .all(hostId) as Array<Record<string, unknown>>;

  return {
    hostId,
    uptimePct: +pct.toFixed(2),
    avgMs,
    lastCheck: arr.length ? new Date(arr[arr.length - 1].ts).toISOString() : null,
    bars,
    incidents: incidents.map((r) => ({
      id: String(r.id),
      startedAt: String(r.startedAt),
      endedAt: r.endedAt ? String(r.endedAt) : null,
    })),
  };
}

function probe(host: string, port: number, timeoutMs: number): Promise<{ up: boolean; ms: number }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = connect({ host, port });
    const done = (up: boolean) => { socket.destroy(); resolve({ up, ms: Date.now() - start }); };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

export function startUptimeMonitor() {
  // In dev demo, the seeded hosts are fictional, so synthesize from their seeded
  // health instead of probing unreachable IPs. In prod, do real TCP probes.
  const demo = process.env.NODE_ENV !== "production" && process.env.NGINUX_REAL_PROBES !== "1";

  let running = false;
  const tick = async () => {
    if (running) return; // never overlap sweeps
    running = true;
    try {
      // Paused (disabled) services aren't served, so don't probe them - that
      // would record bogus uptime or fire false "down" alerts for a host the
      // user intentionally took offline.
      const hosts = listHosts().filter((h) => h.enabled);
      if (demo) {
        for (const h of hosts) {
          const up = h.health !== "down";
          push(h.id, up, up ? 20 + Math.floor(Math.random() * 120) : 0);
        }
      } else {
        // Probe all hosts concurrently so one slow/down host can't stall the sweep.
        // Each host is isolated: a probe or DB error for one must not reject the
        // whole Promise.all and abandon the others' checks.
        await Promise.all(hosts.map(async (h) => {
          try {
            const { up, ms } = await probe(h.forwardHost, h.forwardPort, 4000);
            recordCheck(h.id, up, ms);
          } catch { /* skip this host this sweep */ }
        }));
      }
    } catch {
      /* a sweep-level failure must not kill the recurring interval */
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => void tick(), 15000).unref?.();

  // Seed one synthetic past incident in demo so the UI has history.
  if (demo) {
    const grafana = listHosts().find((h) => h.id === "grafana");
    if (grafana) openIncident(grafana.id, grafana.domain);
  }
}
