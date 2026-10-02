import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import nodemailer from "nodemailer";
import { db } from "./db.ts";
import { matchesEvent, subscribe } from "./events.ts";
import { meetsSeverity } from "./severity.ts";
import { resolveSafeOutboundHost, safeOutboundRequest, type SafeOutboundResponse } from "./outbound.ts";

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
    // ntfy topics / Telegram chat ids are capabilities too (knowing them lets anyone
    // read or post), so they get the same partial masking as user/url.
    const semi = /user|url|topic|chat/i.test(k);
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

import { assertSafeOutboundUrl, isDangerousHost } from "./validate.ts";

/** Validate channel config fields against SSRF, URL path traversal, and query/userinfo injection. */
export function validateChannelConfig(type: ChannelType, config: Record<string, string>): string | null {
  for (const key of ["url", "server"]) {
    const v = config[key];
    if (v) {
      try { assertSafeOutboundUrl(v); } catch (e) { return e instanceof Error ? e.message : "Invalid URL."; }
    }
  }
  if (type === "email" && config.host && isDangerousHost(config.host)) {
    return "That SMTP host is not allowed.";
  }
  if (type === "ntfy" && config.topic !== undefined) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(config.topic) || config.topic === "." || config.topic === "..") {
      return "Invalid ntfy topic name.";
    }
  }
  if (type === "telegram" && config.token !== undefined) {
    if (!/^[A-Za-z0-9:_-]{1,256}$/.test(config.token)) {
      return "Invalid Telegram bot token.";
    }
  }
  return null;
}

// ---------- delivery ----------
async function deliver(ch: Channel, title: string, message: string): Promise<{ ok: boolean; status: string }> {
  const c = ch.config;
  try {
    const cfgErr = validateChannelConfig(ch.type, c);
    if (cfgErr) throw new Error(cfgErr);
    let res: SafeOutboundResponse;
    switch (ch.type) {
      case "ntfy": {
        const base = (c.server || "https://ntfy.sh").replace(/\/+$/, "");
        if (!c.topic) throw new Error("ntfy topic is required.");
        res = await safeOutboundRequest(`${base}/${encodeURIComponent(c.topic)}`, {
          method: "POST", body: message, headers: { Title: title }, timeoutMs: 5000,
        });
        break;
      }
      case "gotify": {
        const base = (c.server || "").replace(/\/+$/, "");
        if (!base || !c.token) throw new Error("gotify server and token are required.");
        res = await safeOutboundRequest(`${base}/message?token=${encodeURIComponent(c.token)}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, message, priority: 5 }), timeoutMs: 5000,
        });
        break;
      }
      case "pushover":
        res = await safeOutboundRequest("https://api.pushover.net/1/messages.json", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: c.token, user: c.user, title, message }), timeoutMs: 5000,
        });
        break;
      case "discord":
        res = await safeOutboundRequest(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          // Low-privilege users control host names that end up in alert text; never let
          // such text ping @everyone/@here/roles. (Security audit 2026-10-01.)
          body: JSON.stringify({ content: `**${title}**\n${message}`, allowed_mentions: { parse: [] } }), timeoutMs: 5000,
        });
        break;
      case "slack":
        res = await safeOutboundRequest(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          // Slack mrkdwn: `&`, `<`, `>` are control characters (links, mentions, channel
          // refs); escape them so alert text stays literal.
          body: JSON.stringify({ text: `*${slackEscape(title)}*\n${slackEscape(message)}` }), timeoutMs: 5000,
        });
        break;
      case "telegram":
        if (!c.token) throw new Error("Telegram bot token is required.");
        res = await safeOutboundRequest(`https://api.telegram.org/bot${c.token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: c.chatId, text: `${title}\n${message}` }), timeoutMs: 5000,
        });
        break;
      case "webhook":
        res = await safeOutboundRequest(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, message }), timeoutMs: 5000,
        });
        break;
      case "email": {
        const smtpHost = await resolveSafeOutboundHost(c.host);
        const transport = nodemailer.createTransport({
          host: smtpHost,
          port: Number(c.port || 587),
          secure: c.port === "465",
          auth: c.user ? { user: c.user, pass: c.pass } : undefined,
          // Bound every phase so a black-holed SMTP host can't hang the alert path
          // (every other channel already uses a 5s abort). Alerts are time-sensitive.
          connectionTimeout: 5000,
          greetingTimeout: 5000,
          socketTimeout: 8000,
          tls: { servername: isIP(c.host) ? undefined : c.host, rejectUnauthorized: true },
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
    // Store/return a fixed failure category, never the raw error text: the message can
    // carry a remote service's greeting banner or stack detail (a read primitive against
    // whatever the channel points at). Full detail stays in the server log.
    const status = `failed: ${failureCategory(err)}`;
    console.warn(`[notify] channel ${ch.id} (${ch.type}) delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    db.prepare("UPDATE channels SET lastStatus = ? WHERE id = ?").run(status, ch.id);
    return { ok: false, status };
  }
}

/** Escape Slack mrkdwn control characters (per Slack's formatting rules). */
function slackEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Collapse an arbitrary delivery error into one of a few neutral categories. Only
 *  NginUX's own validation messages (thrown before any network I/O) surface verbatim. */
const OWN_VALIDATION_MESSAGES = new Set([
  "That destination host is not allowed.", "That destination resolves to a blocked metadata/link-local address.",
  "Invalid URL.", "Only http(s) URLs are allowed.", "That SMTP host is not allowed.", "Invalid ntfy topic name.",
  "Invalid Telegram bot token.", "ntfy topic is required.", "gotify server and token are required.",
  "Telegram bot token is required.", "Invalid outbound header name.",
]);
function failureCategory(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  if (OWN_VALIDATION_MESSAGES.has(msg)) return msg;
  if (/abort|timed? ?out|ETIMEDOUT/i.test(msg)) return "timeout";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|getaddrinfo|socket hang up|fetch failed/i.test(msg)) return "unreachable";
  if (/certificate|TLS|SSL|self[- ]signed|handshake/i.test(msg)) return "tls error";
  if (/auth|credential|login|535|534|530/i.test(msg)) return "rejected (authentication)";
  return "rejected";
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
