import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { assertSafeOutboundUrl, isDangerousHost } from "./validate.ts";

/** Resolve at connection time and reject the entire hostname if ANY returned
 * address is metadata/link-local/unspecified. Returning the vetted literal pins
 * the subsequent socket and closes the validate-then-rebind gap. Private homelab
 * addresses remain allowed by the product's explicit outbound policy. */
export async function resolveSafeOutboundHost(hostname: string, timeoutMs = 5000): Promise<string> {
  if (isDangerousHost(hostname)) throw new Error("That destination host is not allowed.");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const records = await Promise.race([
    lookup(hostname.replace(/^\[|\]$/g, ""), { all: true, verbatim: true }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Destination DNS lookup timed out.")), timeoutMs); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
  if (!records.length || records.some((r) => isDangerousHost(r.address))) {
    throw new Error("That destination resolves to a blocked metadata/link-local address.");
  }
  // Prefer IPv4 for broad homelab compatibility; otherwise use the first AAAA.
  return records.find((r) => r.family === 4)?.address ?? records[0].address;
}

export interface SafeOutboundResponse { ok: boolean; status: number }

/** Minimal redirect-free HTTP(S) client for outbound notifications/webhooks.
 * It preserves the original Host header and TLS SNI/identity while connecting to
 * the already-vetted literal address, so DNS cannot change underneath the check. */
export async function safeOutboundRequest(
  raw: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer; timeoutMs?: number } = {},
): Promise<SafeOutboundResponse> {
  const url = assertSafeOutboundUrl(raw);
  const timeoutMs = options.timeoutMs ?? 5000;
  const address = await resolveSafeOutboundHost(url.hostname, timeoutMs);
  const body = options.body;
  const sanitizedHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    if (/[\r\n\0]/.test(k)) throw new Error("Invalid outbound header name.");
    sanitizedHeaders[k] = String(v).replace(/[\r\n\0]+/g, " ");
  }
  const headers: Record<string, string | number> = {
    ...sanitizedHeaders,
    Host: url.host,
    ...(body !== undefined ? { "Content-Length": Buffer.byteLength(body) } : {}),
  };
  if ((url.username || url.password) && !headers.Authorization) {
    headers.Authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
  }
  const request = url.protocol === "https:" ? https.request : http.request;
  return new Promise((resolve, reject) => {
    const req = request({
      protocol: url.protocol,
      hostname: address,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: options.method ?? "GET",
      headers,
      timeout: timeoutMs,
      ...(url.protocol === "https:" ? { servername: url.hostname, rejectUnauthorized: true } : {}),
    }, (res) => {
      res.resume();
      res.on("error", (err) => { clearTimeout(deadline); reject(err); });
      res.on("end", () => {
        clearTimeout(deadline);
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status });
      });
    });
    const deadline = setTimeout(() => req.destroy(new Error("Outbound request timed out.")), timeoutMs);
    req.on("timeout", () => req.destroy(new Error("Outbound request timed out.")));
    req.on("error", (err) => { clearTimeout(deadline); reject(err); });
    if (body !== undefined) req.write(body);
    req.end();
  });
}
