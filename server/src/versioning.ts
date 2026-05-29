import { randomUUID } from "node:crypto";
import { db, getSettings } from "./db.ts";
import { listHosts, replaceAllHosts } from "./repo.ts";
import type { ProxyHost } from "./types.ts";

const KEEP = 50;

export interface ConfigVersion {
  id: string;
  ts: string;
  label: string;
  actor: string;
  hostCount: number;
}

type Row = Record<string, unknown>;

/** Capture the full host+settings state as a restorable version. */
export function snapshot(label: string, actor = "system"): ConfigVersion {
  const hosts = listHosts();
  const id = randomUUID();
  db.prepare(
    "INSERT INTO config_versions (id, ts, label, actor, hostsJson, settingsJson, hostCount) VALUES (?,?,?,?,?,?,?)",
  ).run(id, new Date().toISOString(), label, actor, JSON.stringify(hosts), JSON.stringify(getSettings()), hosts.length);

  // prune old versions
  const ids = (db.prepare("SELECT id FROM config_versions ORDER BY ts DESC").all() as Row[]).map((r) => String(r.id));
  for (const old of ids.slice(KEEP)) db.prepare("DELETE FROM config_versions WHERE id = ?").run(old);

  return { id, ts: new Date().toISOString(), label, actor, hostCount: hosts.length };
}

export function listVersions(): ConfigVersion[] {
  return (db.prepare("SELECT id, ts, label, actor, hostCount FROM config_versions ORDER BY ts DESC").all() as Row[]).map((r) => ({
    id: String(r.id), ts: String(r.ts), label: String(r.label), actor: String(r.actor), hostCount: Number(r.hostCount),
  }));
}

function getVersionHosts(id: string): ProxyHost[] | null {
  const r = db.prepare("SELECT hostsJson FROM config_versions WHERE id = ?").get(id) as Row | undefined;
  return r ? (JSON.parse(String(r.hostsJson)) as ProxyHost[]) : null;
}

/** What changed between a saved version and the current state. */
export function diffVersion(id: string) {
  const snap = getVersionHosts(id);
  if (!snap) return null;
  const current = listHosts();
  const snapByDomain = new Map(snap.map((h) => [h.domain, h]));
  const curByDomain = new Map(current.map((h) => [h.domain, h]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [domain, h] of curByDomain) {
    if (!snapByDomain.has(domain)) added.push(domain);
    else if (JSON.stringify({ ...h, updatedAt: 0 }) !== JSON.stringify({ ...snapByDomain.get(domain)!, updatedAt: 0 })) changed.push(domain);
  }
  for (const domain of snapByDomain.keys()) if (!curByDomain.has(domain)) removed.push(domain);
  return { added, removed, changed };
}

/** Roll the host set back to a saved version. Caller re-applies config. */
export function restoreVersion(id: string): { restored: number } | null {
  const snap = getVersionHosts(id);
  if (!snap) return null;
  replaceAllHosts(snap);
  return { restored: snap.length };
}
