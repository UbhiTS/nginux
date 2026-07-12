import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { db } from "./db.ts";
import { matchesEvent, subscribe } from "./events.ts";
import { meetsSeverity } from "./severity.ts";

export type ChannelType = "ntfy" | "gotify" | "pushover" | "discord" | "slack" | "telegram" | "webhook" | "email";

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  config: Record<string, string>;
  events: string[];
  /** Only alert this channel for events at or above this severity (info = all). */
  minSeverity: string;
  enabled: boolean;
  lastStatus: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;
function toChannel(r: Row): Channel {
  return {
    id: String(r.id), type: r.type as ChannelType, name: String(r.name),
    config: JSON.parse(String(r.config)), events: JSON.parse(String(r.events)),
    minSeverity: String(r.minSeverity ?? "info"),
    enabled: !!r.enabled, lastStatus: r.lastStatus ? String(r.lastStatus) : null, createdAt: String(r.createdAt),
  };
}

export function listChannels(): Channel[] {
  // never leak secrets in config back to the client
  return (db.prepare("SELECT * FROM channels ORDER BY createdAt").all() as Row[]).map((r) => {
    const c = toChannel(r);
    return { ...c, config: maskConfig(c.config) };
  });
}
function getChannelRaw(id: string): Channel | null {
  const r = db.prepare("SELECT * FROM channels WHERE id = ?").get(id) as Row | undefined;
  return r ? toChannel(r) : null;
}

/** Every channel with its REAL (unmasked) config - for an encrypted backup only.
 *  Never return this to a client; listChannels() is the masked, client-safe view. */
export function listChannelsRaw(): Channel[] {
  return (db.prepare("SELECT * FROM channels ORDER BY createdAt").all() as Row[]).map(toChannel);
}

/** Replace the whole channel set (backup restore), in one transaction. Channels
 *  whose secret config is masked (••••) are skipped, so restoring a redacted
 *  (unencrypted) bundle never overwrites a real channel with a useless placeholder. */
export function replaceAllChannels(channels: Channel[]): number {
  const insert = db.prepare(
    "INSERT INTO channels (id, type, name, config, events, minSeverity, enabled, lastStatus, createdAt) VALUES (?,?,?,?,?,?,?,?,?)",
  );
  let restored = 0;
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM channels").run();
    for (const c of channels) {
      const masked = Object.values(c.config ?? {}).some((v) => typeof v === "string" && v.includes("••"));
      if (masked) continue; // a redacted export can't restore a working channel
      insert.run(
        c.id, c.type, c.name, JSON.stringify(c.config ?? {}), JSON.stringify(c.events ?? ["*"]),
        c.minSeverity ?? "info", c.enabled ? 1 : 0, c.lastStatus ?? null, c.createdAt ?? new Date().toISOString(),
      );
      restored++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return restored;
}
function maskConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    // Secret-bearing keys are always masked (even short ones); semi-sensitive
    // identifiers (user/url) are partially shown for readability.
    const secret = /token|secret|key|pass|pwd|auth/i.test(k);
    const semi = /user|url/i.test(k);
    if (secret && v) out[k] = v.length > 6 ? v.slice(0, 4) + "••••" : "••••";
    else if (semi && v.length > 6) out[k] = v.slice(0, 4) + "••••";
    else out[k] = v;
  }
  return out;
}

export function createChannel(input: { type: ChannelType; name: string; config: Record<string, string>; events?: string[]; minSeverity?: string }): Channel {
  const id = randomUUID();
  db.prepare("INSERT INTO channels (id, type, name, config, events, minSeverity, enabled, createdAt) VALUES (?,?,?,?,?,?,1,?)").run(
    id, input.type, input.name, JSON.stringify(input.config), JSON.stringify(input.events ?? ["*"]),
    input.minSeverity ?? "info", new Date().toISOString(),
  );
  return { ...getChannelRaw(id)!, config: maskConfig(getChannelRaw(id)!.config) };
}
export function deleteChannel(id: string): boolean {
  return db.prepare("DELETE FROM channels WHERE id = ?").run(id).changes > 0;
}
export function setChannelEnabled(id: string, enabled: boolean) {
  db.prepare("UPDATE channels SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}
/** Edit a channel's routing: which event types it matches and its severity floor. */
export function setChannelRouting(id: string, patch: { events?: string[]; minSeverity?: string }): Channel | null {
  const cur = getChannelRaw(id);
  if (!cur) return null;
  const events = patch.events ?? cur.events;
  const minSeverity = patch.minSeverity ?? cur.minSeverity;
  db.prepare("UPDATE channels SET events = ?, minSeverity = ? WHERE id = ?").run(JSON.stringify(events), minSeverity, id);
  const updated = getChannelRaw(id)!;
  return { ...updated, config: maskConfig(updated.config) };
}

// ---------- delivery ----------
async function deliver(ch: Channel, title: string, message: string): Promise<{ ok: boolean; status: string }> {
  const c = ch.config;
  try {
    let res: Response;
    switch (ch.type) {
      case "ntfy":
        res = await fetch(`${c.server || "https://ntfy.sh"}/${c.topic}`, {
          method: "POST", body: message, headers: { Title: title }, redirect: "manual", signal: AbortSignal.timeout(5000),
        });
        break;
      case "gotify":
        res = await fetch(`${c.server}/message?token=${c.token}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, message, priority: 5 }), redirect: "manual", signal: AbortSignal.timeout(5000),
        });
        break;
      case "pushover":
        res = await fetch("https://api.pushover.net/1/messages.json", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: c.token, user: c.user, title, message }), redirect: "manual", signal: AbortSignal.timeout(5000),
        });
        break;
      case "discord":
        res = await fetch(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `**${title}**\n${message}` }), redirect: "manual", signal: AbortSignal.timeout(5000),
        });
        break;
      case "slack":
        res = await fetch(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `*${title}*\n${message}` }), redirect: "manual", signal: AbortSignal.timeout(5000),
        });
        break;
      case "telegram":
        res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: c.chatId, text: `${title}\n${message}` }), redirect: "manual", signal: AbortSignal.timeout(5000),
        });
        break;
      case "webhook":
        res = await fetch(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, message }), redirect: "manual", signal: AbortSignal.timeout(5000),
        });
        break;
      case "email": {
        const transport = nodemailer.createTransport({
          host: c.host,
          port: Number(c.port || 587),
          secure: c.port === "465",
          auth: c.user ? { user: c.user, pass: c.pass } : undefined,
          // Bound every phase so a black-holed SMTP host can't hang the alert path
          // (every other channel already uses a 5s abort). Alerts are time-sensitive.
          connectionTimeout: 5000,
          greetingTimeout: 5000,
          socketTimeout: 8000,
        });
        await transport.sendMail({ from: c.from || c.user, to: c.to, subject: title, text: message });
        const status = "ok";
        db.prepare("UPDATE channels SET lastStatus = ? WHERE id = ?").run(status, ch.id);
        return { ok: true, status };
      }
      default:
        return { ok: false, status: "unknown channel type" };
    }
    const status = res.ok ? `ok (${res.status})` : `error ${res.status}`;
    db.prepare("UPDATE channels SET lastStatus = ? WHERE id = ?").run(status, ch.id);
    return { ok: res.ok, status };
  } catch (err) {
    const status = `failed: ${err instanceof Error ? err.message : "unreachable"}`;
    db.prepare("UPDATE channels SET lastStatus = ? WHERE id = ?").run(status, ch.id);
    return { ok: false, status };
  }
}

export async function testChannel(id: string): Promise<{ ok: boolean; status: string }> {
  const ch = getChannelRaw(id);
  if (!ch) return { ok: false, status: "not found" };
  return deliver(ch, "NginUX test", "If you can read this, notifications are working. 🎉");
}


// Which events are worth a push notification (high-volume ones are excluded).
export function isAlertWorthy(type: string, severity?: string): boolean {
  if (type === "agent.tool_called" || type === "login.success" || type.startsWith("host.")) return false;
  if (severity === "warn" || severity === "danger") return true;
  return /^(service\.|cert\.|security\.|agent\.approval)/.test(type);
}

// Coalesce alert storms: at most one alert per (channel,type) per window; repeats
// inside the window are counted and folded into a single trailing "+N more" summary
// when the window closes. Without this a password-guessing client or a flapping host
// fires one outbound message per event to every channel (Slack/Discord/email) - and
// the login limiter doesn't help, since the 429 path itself re-emits login.failed.
const ALERT_WINDOW_MS = 60_000;
interface AlertBucket { count: number; timer: ReturnType<typeof setTimeout> | null; lastMessage: string }
const alertBuckets = new Map<string, AlertBucket>();

function flushAlertBucket(channelId: string, type: string, key: string): void {
  const b = alertBuckets.get(key);
  alertBuckets.delete(key);
  if (!b || b.count === 0) return; // nothing was suppressed during the window
  const ch = getChannelRaw(channelId);
  if (!ch || !ch.enabled) return; // channel removed/disabled since the window opened
  const noun = b.count === 1 ? "event" : "events";
  void deliver(ch, `NginUX: ${type} (+${b.count})`, `${b.count} more "${type}" ${noun} in the last ${ALERT_WINDOW_MS / 1000}s. Latest: ${b.lastMessage}`);
}

export function initAlertEngine(): void {
  subscribe((e) => {
    const severity = (e.data?.severity as string) || "info";
    if (!isAlertWorthy(e.type, severity)) return;
    // Throttled (429) login attempts are already the limiter doing its job - don't
    // let them amplify into one alert per rejected request.
    if (e.data?.throttled) return;
    const title = `NginUX: ${e.type}`;
    const message = (e.data?.summary as string) || e.type;
    for (const r of db.prepare("SELECT * FROM channels WHERE enabled = 1").all() as Row[]) {
      const ch = toChannel(r);
      if (!matchesEvent(ch.events, e.type)) continue;
      // Severity routing: a channel with minSeverity "danger" ignores info/notice/
      // warn events; the default "info" lets everything through (backward-compatible).
      if (!meetsSeverity(severity, ch.minSeverity)) continue;
      const key = `${ch.id}|${e.type}`;
      const bucket = alertBuckets.get(key);
      if (!bucket) {
        // First of its kind in this window: deliver now, open the coalescing window.
        void deliver(ch, title, message);
        const b: AlertBucket = { count: 0, timer: null, lastMessage: message };
        b.timer = setTimeout(() => flushAlertBucket(ch.id, e.type, key), ALERT_WINDOW_MS);
        b.timer.unref?.();
        alertBuckets.set(key, b);
      } else {
        // Within the window: count it and remember the latest summary for the flush.
        bucket.count++;
        bucket.lastMessage = message;
      }
    }
  });
}
