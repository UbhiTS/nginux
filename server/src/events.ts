import { createHmac, randomUUID } from "node:crypto";
import { db } from "./db.ts";
import { isDangerousHost } from "./validate.ts";
import { isSyslogUrl, parseSyslogUrl, sendSyslog } from "./syslog.ts";

export interface NgxEvent {
  id: string;
  ts: string;
  type: string; // e.g. "security.ip_banned", "cert.renewed", "agent.tool_called"
  data: Record<string, unknown>;
}

type Subscriber = (e: NgxEvent) => void;
const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Fan an event out to SSE subscribers and matching webhooks. */
export function emitEvent(type: string, data: Record<string, unknown> = {}): NgxEvent {
  const e: NgxEvent = { id: randomUUID(), ts: new Date().toISOString(), type, data };
  for (const fn of subscribers) {
    try { fn(e); } catch { /* a slow/broken subscriber shouldn't break others */ }
  }
  void deliverWebhooks(e);
  return e;
}

// ---------- webhooks ----------
export interface Webhook {
  id: string;
  url: string;
  events: string[];
  lastStatus: string | null;
  lastDeliveryAt: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;
function toWebhook(r: Row): Webhook {
  return {
    id: String(r.id),
    url: String(r.url),
    events: JSON.parse(String(r.events)),
    lastStatus: r.lastStatus ? String(r.lastStatus) : null,
    lastDeliveryAt: r.lastDeliveryAt ? String(r.lastDeliveryAt) : null,
    createdAt: String(r.createdAt),
  };
}

export function listWebhooks(): Webhook[] {
  return (db.prepare("SELECT * FROM webhooks ORDER BY createdAt").all() as Row[]).map(toWebhook);
}

export function createWebhook(url: string, events: string[]): { webhook: Webhook; secret: string } {
  const id = randomUUID();
  const secret = `whsec_${randomUUID().replace(/-/g, "")}`;
  db.prepare("INSERT INTO webhooks (id, url, events, secret, createdAt) VALUES (?,?,?,?,?)").run(
    id, url, JSON.stringify(events.length ? events : ["*"]), secret, new Date().toISOString(),
  );
  return { webhook: toWebhook(db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as Row), secret };
}

export function deleteWebhook(id: string): boolean {
  return db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
}

/** Does an event `type` match a subscriber's pattern list? Supports "*" (all),
 *  exact match, and "prefix.*" (e.g. "cert.*"). Shared with the notify channels. */
export function matchesEvent(patterns: string[], type: string): boolean {
  return patterns.some((p) => p === "*" || p === type || (p.endsWith(".*") && type.startsWith(p.slice(0, -1))));
}

async function deliverWebhooks(e: NgxEvent): Promise<void> {
  const rows = db.prepare("SELECT * FROM webhooks").all() as Row[];
  for (const r of rows) {
    const wh = toWebhook(r);
    if (!matchesEvent(wh.events, e.type)) continue;

    let status: string;
    if (isSyslogUrl(wh.url)) {
      // Stream to a SIEM over syslog (RFC 5424). Same SSRF guard on the host.
      const target = parseSyslogUrl(wh.url);
      if (!target) { status = "failed: bad syslog URL"; }
      else if (isDangerousHost(target.host)) { status = "failed: blocked host"; }
      else { status = await sendSyslog(target, e); }
    } else {
      // Defense in depth: never deliver to a link-local/metadata host even if a
      // record predates URL validation.
      try { if (isDangerousHost(new URL(wh.url).hostname)) continue; } catch { continue; }
      const body = JSON.stringify(e);
      const signature = createHmac("sha256", String(r.secret)).update(body).digest("hex");
      try {
        const res = await fetch(wh.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-NginUX-Signature": `sha256=${signature}`, "X-NginUX-Event": e.type },
          body,
          signal: AbortSignal.timeout(5000),
        });
        status = res.ok ? `${res.status}` : `error ${res.status}`;
      } catch (err) {
        status = `failed: ${err instanceof Error ? err.message : "unreachable"}`;
      }
    }
    db.prepare("UPDATE webhooks SET lastStatus = ?, lastDeliveryAt = ? WHERE id = ?").run(
      status, new Date().toISOString(), wh.id,
    );
  }
}
