import dgram from "node:dgram";
import net from "node:net";
import { hostname } from "node:os";
import type { NgxEvent } from "./events.ts";

// RFC 5424 syslog delivery for the audit-event webhooks, so events can stream to a
// SIEM (rsyslog/Graylog/Splunk) as well as an HTTP collector. A webhook whose URL
// is syslog://host:port (or syslog+tcp://) is delivered here instead of over HTTP.

const FACILITY = 16; // local0
// Map our event severities onto syslog severities (lower = more urgent).
const SYSLOG_SEV: Record<string, number> = { danger: 3 /*err*/, warn: 4, notice: 5, info: 6 };
const APP_NAME = "nginux";

function priority(sev: string | undefined): number {
  return FACILITY * 8 + (SYSLOG_SEV[String(sev)] ?? 6);
}

export interface SyslogTarget { proto: "udp" | "tcp"; host: string; port: number }

/** Parse syslog://host[:port] | syslog+udp://... | syslog+tcp://... (default 514/udp). */
export function parseSyslogUrl(url: string): SyslogTarget | null {
  const m = /^syslog(?:\+(udp|tcp))?:\/\/([^:/\s]+)(?::(\d+))?\/?$/i.exec(url.trim());
  if (!m) return null;
  return { proto: (m[1]?.toLowerCase() as "udp" | "tcp") ?? "udp", host: m[2], port: m[3] ? Number(m[3]) : 514 };
}

export function isSyslogUrl(url: string): boolean {
  return /^syslog(\+(udp|tcp))?:\/\//i.test(url.trim());
}

/** Format one event as an RFC 5424 message line. The MSG carries the event type
 *  followed by its JSON data, so a SIEM gets both a greppable type and full detail. */
export function formatRfc5424(host: string, e: NgxEvent): string {
  const sev = e.data?.severity as string | undefined;
  const structured = "-"; // no STRUCTURED-DATA; detail travels in MSG as JSON
  const msg = `${e.type} ${JSON.stringify(e.data ?? {})}`;
  return `<${priority(sev)}>1 ${e.ts} ${host} ${APP_NAME} - ${e.id} ${structured} ${msg}`;
}

/** Deliver one event to a syslog target. Resolves to a status string (never
 *  rejects) so a broken sink can't break the webhook fan-out. UDP is
 *  fire-and-forget; TCP confirms the connection. */
export function sendSyslog(target: SyslogTarget, e: NgxEvent): Promise<string> {
  const line = formatRfc5424(hostname(), e);
  return new Promise((resolve) => {
    if (target.proto === "tcp") {
      const sock = net.connect({ host: target.host, port: target.port });
      sock.setTimeout(5000);
      sock.once("connect", () => { sock.write(line + "\n"); sock.end(); resolve("ok"); });
      sock.once("timeout", () => { sock.destroy(); resolve("failed: timeout"); });
      sock.once("error", (err) => resolve(`failed: ${err.message}`));
    } else {
      const sock = dgram.createSocket("udp4");
      const buf = Buffer.from(line);
      sock.send(buf, target.port, target.host, (err) => { sock.close(); resolve(err ? `failed: ${err.message}` : "ok"); });
    }
  });
}
