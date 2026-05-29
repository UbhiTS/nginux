import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import { db } from "./db.ts";
import { subscribe } from "./events.ts";

export type ChannelType = "ntfy" | "gotify" | "pushover" | "discord" | "slack" | "telegram" | "webhook" | "email";

export interface Channel {
  id: string;
  type: ChannelType;
  name: string;
  config: Record<string, string>;
  events: string[];
  enabled: boolean;
  lastStatus: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;
function toChannel(r: Row): Channel {
  return {
    id: String(r.id), type: r.type as ChannelType, name: String(r.name),
    config: JSON.parse(String(r.config)), events: JSON.parse(String(r.events)),
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
function maskConfig(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = /token|secret|key|user|url/i.test(k) && v.length > 6 ? v.slice(0, 4) + "••••" : v;
  }
  return out;
}

export function createChannel(input: { type: ChannelType; name: string; config: Record<string, string>; events?: string[] }): Channel {
  const id = randomUUID();
  db.prepare("INSERT INTO channels (id, type, name, config, events, enabled, createdAt) VALUES (?,?,?,?,?,1,?)").run(
    id, input.type, input.name, JSON.stringify(input.config), JSON.stringify(input.events ?? ["*"]), new Date().toISOString(),
  );
  return { ...getChannelRaw(id)!, config: maskConfig(getChannelRaw(id)!.config) };
}
export function deleteChannel(id: string): boolean {
  return db.prepare("DELETE FROM channels WHERE id = ?").run(id).changes > 0;
}
export function setChannelEnabled(id: string, enabled: boolean) {
  db.prepare("UPDATE channels SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
}

// ---------- delivery ----------
async function deliver(ch: Channel, title: string, message: string): Promise<{ ok: boolean; status: string }> {
  const c = ch.config;
  try {
    let res: Response;
    switch (ch.type) {
      case "ntfy":
        res = await fetch(`${c.server || "https://ntfy.sh"}/${c.topic}`, {
          method: "POST", body: message, headers: { Title: title }, signal: AbortSignal.timeout(5000),
        });
        break;
      case "gotify":
        res = await fetch(`${c.server}/message?token=${c.token}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, message, priority: 5 }), signal: AbortSignal.timeout(5000),
        });
        break;
      case "pushover":
        res = await fetch("https://api.pushover.net/1/messages.json", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: c.token, user: c.user, title, message }), signal: AbortSignal.timeout(5000),
        });
        break;
      case "discord":
        res = await fetch(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `**${title}**\n${message}` }), signal: AbortSignal.timeout(5000),
        });
        break;
      case "slack":
        res = await fetch(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: `*${title}*\n${message}` }), signal: AbortSignal.timeout(5000),
        });
        break;
      case "telegram":
        res = await fetch(`https://api.telegram.org/bot${c.token}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: c.chatId, text: `${title}\n${message}` }), signal: AbortSignal.timeout(5000),
        });
        break;
      case "webhook":
        res = await fetch(c.url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, message }), signal: AbortSignal.timeout(5000),
        });
        break;
      case "email": {
        const transport = nodemailer.createTransport({
          host: c.host,
          port: Number(c.port || 587),
          secure: c.port === "465",
          auth: c.user ? { user: c.user, pass: c.pass } : undefined,
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

function matches(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));
}

// Which events are worth a push notification (high-volume ones are excluded).
function isAlertWorthy(type: string, severity?: string): boolean {
  if (type === "agent.tool_called" || type === "login.success" || type.startsWith("host.")) return false;
  if (severity === "warn" || severity === "danger") return true;
  return /^(service\.|cert\.|security\.|agent\.approval)/.test(type);
}

export function initAlertEngine(): void {
  subscribe((e) => {
    const severity = (e.data?.severity as string) || "info";
    if (!isAlertWorthy(e.type, severity)) return;
    const title = `NginUX: ${e.type}`;
    const message = (e.data?.summary as string) || e.type;
    for (const r of db.prepare("SELECT * FROM channels WHERE enabled = 1").all() as Row[]) {
      const ch = toChannel(r);
      if (matches(ch.events, e.type)) void deliver(ch, title, message);
    }
  });
}
