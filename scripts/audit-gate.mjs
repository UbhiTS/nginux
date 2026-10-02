#!/usr/bin/env node
// Dependency audit gate for CI and releases.
//
// `npm audit --audit-level=high` has no allowlist, so a single advisory with no
// upstream fix (and no reachable code path in this project) would block every
// release until the ecosystem catches up - or tempt someone to lower the gate for
// everything. This wrapper keeps the gate strict and makes every exception
// explicit, justified, and temporary:
//
//   - runs `npm audit --json` across all workspaces (prod + dev, like before);
//   - fails on any advisory at or above the threshold (default: high) that is NOT
//     listed in audit-allowlist.json;
//   - fails on allowlist entries that have expired, so each exception is
//     re-evaluated against new upstream releases instead of living forever;
//   - fails closed when npm cannot produce an audit report at all.
//
//   node scripts/audit-gate.mjs [--audit-level high|critical|moderate|low]
//                               [--allowlist <path>]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const GHSA = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const argv = process.argv.slice(2);
function opt(flag, fallback) {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const level = opt("--audit-level", "high").toLowerCase();
const allowlistPath = resolve(ROOT, opt("--allowlist", "audit-allowlist.json"));
if (!(level in RANK)) die(`Unknown --audit-level "${level}" (use ${Object.keys(RANK).join("|")}).`);
const threshold = RANK[level];

function die(msg) {
  console.error(`\naudit-gate: ${msg}`);
  process.exit(1);
}

/** Load and validate the allowlist. Every entry must say what, why, and until when. */
function loadAllowlist() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(allowlistPath, "utf8"));
  } catch (err) {
    die(`cannot read ${allowlistPath}: ${err.message}`);
  }
  const entries = Array.isArray(raw?.allow) ? raw.allow : null;
  if (!entries) die(`${allowlistPath} must be an object with an "allow" array.`);
  const today = new Date().toISOString().slice(0, 10);
  const map = new Map();
  const expired = [];
  for (const e of entries) {
    const id = String(e?.id ?? "");
    if (!GHSA.test(id)) die(`allowlist entry has no GHSA id: ${JSON.stringify(e)}`);
    if (!e.package || !String(e.reason ?? "").trim()) die(`allowlist entry ${id} needs "package" and a non-empty "reason".`);
    if (!DATE.test(String(e.expires ?? ""))) die(`allowlist entry ${id} needs an "expires" date (YYYY-MM-DD).`);
    if (String(e.expires) < today) expired.push(e);
    map.set(id.toUpperCase(), e);
  }
  if (expired.length) {
    die(
      `allowlist entries have expired and must be re-evaluated (is there a fixed upstream release now?):\n` +
        expired.map((e) => `  - ${e.id} (${e.package}) expired ${e.expires}`).join("\n") +
        `\nEither remove the entry, upgrade the dependency, or extend "expires" with a fresh justification.`,
    );
  }
  return map;
}

/** Run `npm audit --json` and parse it, failing closed on anything that is not a report. */
function runAudit() {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const res = spawnSync(npm, ["audit", "--json"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) die(`failed to run npm audit: ${res.error.message}`);
  let report;
  try {
    report = JSON.parse(res.stdout || "{}");
  } catch {
    die(`npm audit did not return JSON (exit ${res.status}).\n${(res.stderr || res.stdout || "").slice(0, 2000)}`);
  }
  if (report.error) die(`npm audit failed: ${report.error.code ?? ""} ${report.error.summary ?? ""}`.trim());
  if (!report.vulnerabilities || typeof report.vulnerabilities !== "object") {
    die(`unexpected npm audit report shape (auditReportVersion ${report.auditReportVersion ?? "?"}).`);
  }
  return report;
}

const allow = loadAllowlist();
const report = runAudit();

// Advisories live in `via` as objects; a package whose `via` only names other
// packages is merely downstream of those advisories and carries none of its own.
const advisories = new Map(); // id -> { id, pkg, severity, title, url, affects:Set }
for (const [pkg, v] of Object.entries(report.vulnerabilities)) {
  for (const via of v.via ?? []) {
    if (typeof via !== "object" || via === null) continue;
    const id = (String(via.url ?? "").match(GHSA)?.[0] ?? `npm-${via.source ?? "?"}`).toUpperCase();
    const sev = String(via.severity ?? v.severity ?? "info").toLowerCase();
    const cur = advisories.get(id) ?? { id, pkg: via.name ?? pkg, severity: sev, title: via.title ?? "", url: via.url ?? "", affects: new Set() };
    cur.affects.add(pkg);
    for (const eff of v.effects ?? []) cur.affects.add(eff);
    advisories.set(id, cur);
  }
}

const blocking = [];
const allowed = [];
const below = [];
for (const a of advisories.values()) {
  if ((RANK[a.severity] ?? 0) < threshold) below.push(a);
  else if (allow.has(a.id)) allowed.push(a);
  else blocking.push(a);
}

const seen = new Set(advisories.keys());
const stale = [...allow.keys()].filter((id) => !seen.has(id));

const totals = report.metadata?.vulnerabilities ?? {};
console.log(`audit-gate: npm audit found ${totals.total ?? advisories.size} vulnerable package(s) ` +
  `(critical ${totals.critical ?? 0}, high ${totals.high ?? 0}, moderate ${totals.moderate ?? 0}, low ${totals.low ?? 0}); threshold: ${level}.`);
for (const a of allowed) {
  const e = allow.get(a.id);
  console.log(`  allowlisted  ${a.id}  ${a.pkg} [${a.severity}] - ${a.title}\n` +
    `               affects: ${[...a.affects].join(", ")}; expires ${e.expires}; reason: ${e.reason}`);
}
for (const a of below) console.log(`  below gate   ${a.id}  ${a.pkg} [${a.severity}] - ${a.title}`);
for (const id of stale) console.log(`  note: allowlist entry ${id} no longer appears in the audit - it can be removed.`);

if (blocking.length) {
  console.error(`\naudit-gate: ${blocking.length} advisory(ies) at or above "${level}" are not allowlisted:`);
  for (const a of blocking) {
    console.error(`  BLOCKING     ${a.id}  ${a.pkg} [${a.severity}] - ${a.title}\n` +
      `               affects: ${[...a.affects].join(", ")}\n               ${a.url}`);
  }
  console.error(`\nUpgrade the dependency (preferred). Only if no fixed release exists AND the vulnerable code path is` +
    ` unreachable in NginUX, add a justified, expiring entry to ${allowlistPath}.`);
  process.exit(1);
}
console.log("audit-gate: OK");
