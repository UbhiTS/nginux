#!/usr/bin/env node
// NginUX CLI - manage your reverse proxy from the terminal.
// Auth: a scoped API token (create one in the UI under Agents & API).
//   NGINUX_URL    (default http://localhost:6767)
//   NGINUX_TOKEN  (required for everything except `health`)
// It speaks the same MCP tools + endpoints as AI agents, so scopes and the
// human-approval policy apply here too.

const URL = process.env.NGINUX_URL || "http://localhost:6767";
const TOKEN = process.env.NGINUX_TOKEN || "";
const args = process.argv.slice(2);
const cmd = args[0];

function die(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

async function mcp(method, params = {}) {
  if (!TOKEN) die("Set NGINUX_TOKEN (create a token in Agents & API).");
  const res = await fetch(`${URL}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) die(`HTTP ${res.status} from ${URL}`);
  const body = await res.json();
  if (body.error) die(body.error.message);
  return body.result;
}

async function callTool(name, args = {}) {
  const r = await mcp("tools/call", { name, arguments: args });
  const text = r?.content?.[0]?.text ?? "";
  if (r?._meta?.status === "pending_approval") {
    console.log(`⏳ Queued for human approval (${r._meta.tier}-risk). Approve it in the UI.`);
    return null;
  }
  if (r?.isError) die(text);
  try { return JSON.parse(text); } catch { return text; }
}

async function rest(path) {
  const res = await fetch(`${URL}${path}`, { headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {} });
  if (!res.ok) die(`HTTP ${res.status} from ${path}`);
  return res.json();
}

function table(rows, cols) {
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length)));
  const fmt = (r) => cols.map((c, i) => String(r[c] ?? "").padEnd(widths[i])).join("  ");
  console.log(fmt(Object.fromEntries(cols.map((c) => [c, c.toUpperCase()]))));
  for (const r of rows) console.log(fmt(r));
}

const HELP = `nginux - NginUX command-line

  nginux services                       list exposed services
  nginux expose <name> <domain> <host:port>   expose a new service
  nginux rm <id>                        remove a service (may need approval)
  nginux cert <domain> [method]         issue/renew a cert (selfsigned|http-01|dns-01)
  nginux audit                          security posture summary
  nginux logs [n]                       recent access-log lines
  nginux tools                          list available MCP tools
  nginux health                         control-plane health

Env: NGINUX_URL (default ${URL}), NGINUX_TOKEN`;

const run = {
  async services() {
    const hosts = await callTool("list_services");
    table(hosts.map((h) => ({ id: h.id.slice(0, 8), name: h.name, domain: h.domain, health: h.health, login: h.requireLogin ? "yes" : "no" })),
      ["id", "name", "domain", "health", "login"]);
  },
  async expose() {
    const [, name, domain, target] = args;
    if (!name || !domain || !target) die("usage: nginux expose <name> <domain> <host:port>");
    const [host, port] = target.split(":");
    const r = await callTool("create_service", { name, domain, forwardHost: host, forwardPort: Number(port) });
    if (r) console.log(`✓ Exposed ${name} at https://${domain}`);
  },
  async rm() {
    if (!args[1]) die("usage: nginux rm <id>");
    const r = await callTool("delete_service", { id: args[1] });
    if (r) console.log("✓ Removed.");
  },
  async cert() {
    if (!args[1]) die("usage: nginux cert <domain> [method]");
    const c = await callTool("issue_cert", { domain: args[1], method: args[2] || "selfsigned" });
    if (c) console.log(`✓ ${c.domain}: ${c.status} (${c.issuer})`);
  },
  async audit() {
    const a = await callTool("get_security_audit");
    console.log(`Security score: ${a.overview.score} (${a.overview.rating})`);
    console.log(`Exposed: ${a.overview.exposed} · unprotected: ${a.overview.unprotected} · failed logins 24h: ${a.overview.failedLogins24h}`);
    const weak = a.exposure.filter((e) => !e.wellProtected);
    if (weak.length) console.log("Needs login: " + weak.map((e) => e.domain).join(", "));
  },
  async logs() {
    const n = Number(args[1]) || 15;
    const lines = await rest(`/api/logs/recent?limit=${n}`);
    for (const e of lines) console.log(`${e.status} ${e.method.padEnd(4)} ${e.host}${e.path}  ${e.ip} ${e.ms}ms`);
  },
  async tools() {
    const r = await mcp("tools/list");
    for (const t of r.tools) console.log(`  ${t.name.padEnd(22)} ${t.description}`);
  },
  async health() {
    console.log(await rest("/api/health"));
  },
};

(async () => {
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP);
  const ls = cmd === "ls" ? "services" : cmd;
  if (!run[ls]) die(`unknown command: ${cmd}\n${HELP}`);
  await run[ls]();
})();
