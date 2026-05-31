import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getPreset } from "./presets.ts";
import { listHosts } from "./repo.ts";
import { getSettings } from "./db.ts";
import { writeGeoipConf } from "./geoip.ts";
import type { ProxyHost } from "./types.ts";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Where generated per-host config lands. Mounted into the nginx container.
const CONF_DIR = process.env.NGINX_CONF_DIR ?? join(__dirname, "..", "..", "nginx", "conf.d");
const STREAM_DIR = process.env.NGINX_STREAM_DIR ?? join(__dirname, "..", "..", "nginx", "stream.d");
const NGINX_BIN = process.env.NGINX_BIN ?? "nginx";
// Where nginx reaches the control plane for forward-auth (same container).
const CONTROL_URL = process.env.NGINUX_CONTROL_URL ?? "http://127.0.0.1:4600";
const FORWARD_SECRET = process.env.NGINUX_FORWARD_SECRET ?? "";

/** Generate a stream (TCP/UDP) server block. Lives in the nginx `stream {}` context. */
export function generateStreamConfig(h: ProxyHost): string {
  const udp = h.protocol === "udp";
  const targets = [`${h.forwardHost}:${h.forwardPort}`, ...h.upstreams.split("\n").map((s) => s.trim()).filter(Boolean)];
  let pass = targets[0];
  let pool = "";
  if (targets.length > 1) {
    const name = "ngx_stream_" + h.domain.replace(/[^a-z0-9]/gi, "_");
    const method = h.lbMethod === "least_conn" ? "    least_conn;\n" : h.lbMethod === "ip_hash" ? "    hash $remote_addr;\n" : "";
    pool = `upstream ${name} {\n${method}${targets.map((t) => `    server ${t};`).join("\n")}\n}\n\n`;
    pass = name;
  }
  return `# Managed by NginUX — ${h.name} (${h.protocol.toUpperCase()} :${h.listenPort})
${pool}server {
    listen ${h.listenPort}${udp ? " udp" : ""};
    proxy_pass ${pass};${udp ? "\n    proxy_responses 1;" : ""}
}
`;
}

export interface ApplyResult {
  ok: boolean;
  /** plain-language outcome, safe to show a non-expert */
  message: string;
  nginxAvailable: boolean;
}

const splitList = (s: string): string[] => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const splitLines = (s: string): string[] => s.split("\n").map((x) => x.trim()).filter(Boolean);
/** HTML-escape for any user string reflected into a generated HTML response.
 *  Entities also neutralise quotes that would otherwise break the surrounding
 *  nginx single-quoted string. */
const htmlEscape = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Aggregate all SNI passthrough hosts into one stream config (route TLS by SNI,
 *  no termination) using ssl_preread + a map per listen port. */
export function generateSniPassthrough(hosts: ProxyHost[]): string {
  const byPort = new Map<number, ProxyHost[]>();
  for (const h of hosts) {
    const port = h.listenPort || 443;
    if (!byPort.has(port)) byPort.set(port, []);
    byPort.get(port)!.push(h);
  }
  const blocks: string[] = ["# Managed by NginUX — SNI / TLS passthrough (no termination)"];
  for (const [port, list] of byPort) {
    const v = `sni_pass_${port}`;
    const entries = list.map((h) => `    ${h.domain} ${h.forwardHost}:${h.forwardPort};`).join("\n");
    blocks.push(`map $ssl_preread_server_name $${v} {
    default ${list[0].forwardHost}:${list[0].forwardPort};
${entries}
}

server {
    listen ${port};
    ssl_preread on;
    proxy_pass $${v};
}`);
  }
  return blocks.join("\n\n") + "\n";
}

/** Generate the nginx server block for one host. Human-readable on purpose. */
export function generateHostConfig(h: ProxyHost): string {
  const preset = getPreset(h.preset);
  const upstream = `${h.forwardScheme}://${h.forwardHost}:${h.forwardPort}`;
  const lines: string[] = [];

  lines.push(`# Managed by NginUX — ${h.name} (${h.domain})`);
  lines.push(`# Do not edit by hand; changes are regenerated on apply.`);

  // Load balancing: emit an upstream block when extra targets are configured.
  const extraTargets = splitLines(h.upstreams);
  let proxyPass = upstream;
  if (extraTargets.length > 0) {
    const poolName = "ngx_" + h.domain.replace(/[^a-z0-9]/gi, "_");
    const method = h.lbMethod === "least_conn" ? "    least_conn;\n" : h.lbMethod === "ip_hash" ? "    ip_hash;\n" : "";
    const servers = [`${h.forwardHost}:${h.forwardPort}`, ...extraTargets].map((s) => `    server ${s};`).join("\n");
    lines.push(`upstream ${poolName} {\n${method}${servers}\n}`);
    proxyPass = `${h.forwardScheme}://${poolName}`;
  }

  const listen = h.ssl ? "443 ssl" : "80";
  const http2 = h.ssl && h.http2 ? "\n    http2 on;" : "";

  // HTTP -> HTTPS redirect when SSL is on.
  if (h.ssl) {
    lines.push(`server {
    listen 80;
    server_name ${h.domain};
    return 301 https://$host$request_uri;
}`);
  }

  // Use the managed per-host cert (self-signed or Let's Encrypt) when present;
  // otherwise fall back to the shared self-signed cert so nginx always boots.
  const certDir = process.env.CERT_DIR ?? join(__dirname, "..", "data", "certs");
  const liveCert = join(certDir, h.domain, "fullchain.pem");
  const liveKey = join(certDir, h.domain, "privkey.pem");
  const haveLive = existsSync(liveCert) && existsSync(liveKey);
  const certPath = haveLive ? liveCert : process.env.NGINX_DEFAULT_CERT ?? "/data/nginx/selfsigned.crt";
  const keyPath = haveLive ? liveKey : process.env.NGINX_DEFAULT_KEY ?? "/data/nginx/selfsigned.key";

  const clientCa = join(certDir, h.domain, "client-ca.crt");
  const mtlsBlock = h.mtls && h.ssl && existsSync(clientCa)
    ? `
    ssl_verify_client on;
    ssl_client_certificate ${clientCa};`
    : "";
  const sslBlock = h.ssl
    ? `
    ssl_certificate     ${certPath};
    ssl_certificate_key ${keyPath};
    ssl_protocols TLSv1.2 TLSv1.3;${mtlsBlock}`
    : "";

  const wsBlock = h.websockets
    ? `
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 3600s;`
    : "";

  // Forward-auth gate: ask the control plane whether the session may pass.
  const authBlock = h.requireLogin
    ? `
    # Require NginUX login before reaching the app
    auth_request /__nginux_auth;`
    : "";
  // The internal location auth_request calls; passes the original host so the
  // control plane can enforce per-host policy, plus an optional shared secret.
  const authLocation = h.requireLogin
    ? `    location = /__nginux_auth {
        internal;
        proxy_pass ${CONTROL_URL}/api/auth/forward;
        proxy_pass_request_body off;
        proxy_set_header Content-Length "";
        proxy_set_header X-Original-Host $host;
        proxy_set_header X-Original-URI $request_uri;${FORWARD_SECRET ? `\n        proxy_set_header X-NginUX-Forward-Secret "${FORWARD_SECRET}";` : ""}
    }
`
    : "";

  // GeoIP country lock (Phase 2 wires the real geo map; placeholder var here).
  const geoBlock = h.countryLock
    ? `
    if ($nginux_allowed_country = 0) { return 403; }`
    : "";

  const extra = preset.extraDirectives.map((d) => `    ${d}`).join("\n");

  // --- protections (server-level) ---
  const protections: string[] = [];
  if (h.securityHeaders) {
    protections.push(`    add_header X-Frame-Options SAMEORIGIN always;`);
    protections.push(`    add_header X-Content-Type-Options nosniff always;`);
    protections.push(`    add_header Referrer-Policy strict-origin-when-cross-origin always;`);
  }
  if (h.hsts && h.ssl) {
    protections.push(`    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;`);
  }
  for (const ip of splitList(h.ipAllow)) protections.push(`    allow ${ip};`);
  if (h.ipAllow.trim()) protections.push(`    deny all;`);
  for (const ip of splitList(h.ipDeny)) protections.push(`    deny ${ip};`);
  if (h.blockExploits) {
    protections.push(`    location ~* (\\.env|\\.git|/\\.aws|/wp-admin|/wp-login|/phpmyadmin|/xmlrpc\\.php) { return 403; }`);
    protections.push(`    if ($http_user_agent ~* (sqlmap|nikto|masscan|nmap|fimap)) { return 403; }`);
  }
  // custom response headers ("Name: value" per line)
  for (const line of splitLines(h.customHeaders)) {
    const idx = line.indexOf(":");
    if (idx > 0) protections.push(`    add_header ${line.slice(0, idx).trim()} "${line.slice(idx + 1).trim()}" always;`);
  }

  const rateLimitDirective = h.rateLimit ? `\n        limit_req zone=nginux_per_ip burst=20 nodelay;` : "";
  const bwParts: string[] = [];
  if (h.maxConns > 0) bwParts.push(`\n        limit_conn nginux_conn ${h.maxConns};`);
  if (h.rateLimitKbps > 0) bwParts.push(`\n        limit_rate ${h.rateLimitKbps}k;`);
  const bandwidthDirective = bwParts.join("");
  const customNginx = h.customNginx.trim()
    ? "\n" + h.customNginx.split("\n").map((l) => `        ${l.trim()}`).join("\n")
    : "";

  // Maintenance mode short-circuits the proxy with a friendly page. The name is
  // HTML-escaped (entities also neutralise the single-quote that would otherwise
  // close this nginx string), so it can't inject HTML or break out of the directive.
  const safeName = htmlEscape(h.name);
  const locationBody = h.maintenanceMode
    ? `        default_type text/html;
        return 503 '<!doctype html><html><head><meta charset="utf-8"><title>Be right back</title><style>body{font-family:system-ui;background:#0d1117;color:#e6edf3;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center}h1{font-size:22px}</style></head><body><div><h1>🔧 Be right back</h1><p>${safeName} is down for maintenance.</p></div></body></html>';`
    : h.protocol === "grpc"
    ? `        grpc_pass grpc://${extraTargets.length ? proxyPass.replace(/^https?:\/\//, "") : `${h.forwardHost}:${h.forwardPort}`};
        grpc_set_header Host $host;${authBlock}${geoBlock}${rateLimitDirective}${bandwidthDirective}${customNginx}
`
    : `        proxy_pass ${proxyPass};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;${wsBlock}${authBlock}${geoBlock}${rateLimitDirective}${bandwidthDirective}${customNginx}
${extra ? extra + "\n" : ""}`;

  // Per-path routing: send specific paths to different backends.
  const pathBlocks = splitLines(h.pathRules).map((line) => {
    const [p, t] = line.split(/\s+/);
    if (!p || !t) return "";
    const target = /^https?:\/\//.test(t) ? t : `http://${t}`;
    return `    location ${p} {
        proxy_pass ${target};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
`;
  }).join("");

  lines.push(`server {
    listen ${listen};${http2}
    server_name ${h.domain};${sslBlock}
${protections.length ? protections.join("\n") + "\n" : ""}
${authLocation}${pathBlocks}    location / {
${locationBody}    }
}`);

  return lines.join("\n\n") + "\n";
}

/** Write every enabled host's config to disk, removing stale files. */
export function writeAllConfigs(): string[] {
  if (!existsSync(CONF_DIR)) mkdirSync(CONF_DIR, { recursive: true });
  if (!existsSync(STREAM_DIR)) mkdirSync(STREAM_DIR, { recursive: true });
  // Refresh the country-lock include from current settings + DB presence.
  writeGeoipConf();

  // Clear previously generated files (only our managed .conf files).
  for (const dir of [CONF_DIR, STREAM_DIR]) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".conf")) rmSync(join(dir, f));
    }
  }

  const written: string[] = [];
  const sniHosts: ProxyHost[] = [];
  for (const h of listHosts()) {
    if (!h.enabled) continue;
    if (h.protocol === "sni") { sniHosts.push(h); continue; }
    const isStream = h.protocol === "tcp" || h.protocol === "udp";
    const file = join(isStream ? STREAM_DIR : CONF_DIR, `${h.domain}.conf`);
    writeFileSync(file, isStream ? generateStreamConfig(h) : generateHostConfig(h));
    written.push(file);
  }
  if (sniHosts.length) {
    const file = join(STREAM_DIR, "_sni_passthrough.conf");
    writeFileSync(file, generateSniPassthrough(sniHosts));
    written.push(file);
  }
  return written;
}

async function nginxInstalled(): Promise<boolean> {
  try {
    await execFileAsync(NGINX_BIN, ["-v"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Test-and-reload: write configs, validate with `nginx -t`, then reload.
 * When nginx isn't present (dev box), we still write configs and report clearly
 * rather than failing — the real validation happens in the container.
 */
export async function applyConfig(): Promise<ApplyResult> {
  writeAllConfigs();

  if (!(await nginxInstalled())) {
    // In production nginx must be present; refuse to claim success when we
    // can't validate, so unvalidated config is never treated as applied.
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        nginxAvailable: false,
        message: "nginx binary not found — configuration was written but could not be validated or reloaded.",
      };
    }
    return {
      ok: true,
      nginxAvailable: false,
      message:
        "Config generated. Nginx isn't installed in this environment, so validation/reload was skipped — this runs for real inside the container.",
    };
  }

  try {
    await execFileAsync(NGINX_BIN, ["-t"]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      nginxAvailable: true,
      message: humanizeNginxError(detail),
    };
  }

  try {
    await execFileAsync(NGINX_BIN, ["-s", "reload"]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, nginxAvailable: true, message: `Nginx reload failed: ${detail}` };
  }

  return { ok: true, nginxAvailable: true, message: "Configuration applied and nginx reloaded." };
}

/** Turn raw nginx errors into plain-language guidance (PRD: errors that teach). */
function humanizeNginxError(raw: string): string {
  if (/host not found in upstream/i.test(raw)) {
    return "NginUX can't reach one of your internal services — it might be offline or the port may be wrong.";
  }
  if (/cannot load certificate|no such file.*\.pem/i.test(raw)) {
    return "A certificate isn't ready yet. The change was held back so nothing went down.";
  }
  if (/duplicate|conflicting server name/i.test(raw)) {
    return "Two services are trying to use the same domain. Give one of them a different address.";
  }
  if (/unknown directive/i.test(raw)) {
    return "The configuration used a directive this nginx build doesn't support. " +
      "Technical detail: " + nginxErrorDetail(raw);
  }
  return "The new configuration didn't pass validation, so it was not applied (nothing went down). " +
    "Technical detail: " + nginxErrorDetail(raw);
}

/** Pull the meaningful line out of `nginx -t` output. nginx prints the real
 *  reason on an `[emerg]`/`[error]` line and a useless "test failed" summary
 *  last — and the stderr has a trailing newline, so a naive tail drops the
 *  reason. Prefer the emerg/error line; strip the noisy "nginx:" prefix. */
function nginxErrorDetail(raw: string): string {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  const reason = lines.find((l) => /\[(emerg|error)\]/i.test(l)) ?? lines[lines.length - 1] ?? "";
  return reason.replace(/^nginx:\s*/i, "").replace(/^\[(emerg|error)\]\s*/i, "");
}

export { CONF_DIR };
