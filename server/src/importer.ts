import { createHost, getHostByDomain } from "./repo.ts";
import type { NewProxyHost } from "./types.ts";
import { isDangerousHost, isHost, isHostname } from "./validate.ts";
import { controlPlaneTargetError, hostInput, isControlPlaneDomain } from "./hostschema.ts";

interface Parsed {
  domain: string;
  forwardScheme: "http" | "https";
  forwardHost: string;
  forwardPort: number;
  ssl: boolean;
  websockets: boolean;
}

/** Extract `server { ... }` blocks by brace matching (comments stripped). */
function serverBlocks(text: string): string[] {
  const clean = text.replace(/#[^\n]*/g, "");
  const blocks: string[] = [];
  const re = /server\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < clean.length && depth > 0) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") depth--;
      i++;
    }
    blocks.push(clean.slice(start, i - 1));
  }
  return blocks;
}

/** Largest nginx.conf the importer will parse. The route body limit is 2 MB; the
 *  parser is linear but still allocates per block, so refuse anything absurd. */
export const IMPORT_MAX_BYTES = 1024 * 1024;

/** `listen ... ssl;` detection in LINEAR time. The previous `/listen\s+[^;]*\bssl\b/`
 *  backtracked catastrophically (~94 s on a 1 MB crafted file: every `listen` run
 *  of whitespace × every `[^;]*` prefix) - a CPU DoS of the single-threaded control
 *  plane by anyone allowed to import. Scan each `listen` directive once instead. */
function listenHasSsl(block: string): boolean {
  const re = /listen\s+([^;\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block))) {
    if (/\bssl\b/.test(m[1]) || /^443\b/.test(m[1].trim()) || /:443\b/.test(m[1])) return true;
  }
  return false;
}

export function parseNginxConf(text: string): Parsed[] {
  if (Buffer.byteLength(text) > IMPORT_MAX_BYTES) throw new Error("nginx.conf is too large to import (1 MiB maximum).");
  const out: Parsed[] = [];
  for (const block of serverBlocks(text)) {
    const nameM = block.match(/server_name\s+([^;]+);/);
    const passM = block.match(/proxy_pass\s+(https?):\/\/([^:;/\s]+)(?::(\d+))?/);
    if (!nameM || !passM) continue; // not a proxy server block (skip redirects/static)
    const domain = nameM[1].trim().split(/\s+/).find((n) => n !== "_" && !n.startsWith("*"));
    if (!domain) continue;
    const scheme = passM[1].toLowerCase() as "http" | "https";
    const ssl = listenHasSsl(block);
    // WebSocket upgrade is the give-away that the app needs the ws block.
    const websockets = /proxy_set_header\s+Upgrade\b/i.test(block);
    out.push({
      domain,
      forwardScheme: scheme,
      forwardHost: passM[2],
      forwardPort: Number(passM[3] ?? (scheme === "https" ? 443 : 80)),
      ssl,
      websockets,
    });
  }
  return out;
}

export interface ImportDraft extends Parsed { name: string }
export interface ImportPreview {
  toImport: ImportDraft[];
  skipped: { domain: string; reason: string }[];
}

const draftName = (domain: string) => domain.split(".")[0].replace(/^\w/, (c) => c.toUpperCase());

/** Classify what a config would import WITHOUT creating anything - so the UI can
 *  preview then confirm. Rejects the same things the import does (invalid
 *  hostname / forward host - both are interpolated into generated config -
 *  duplicates, and repeats within the file). */
export function previewNginxConf(text: string): ImportPreview {
  const toImport: ImportDraft[] = [];
  const skipped: { domain: string; reason: string }[] = [];
  for (const p of parseNginxConf(text)) {
    if (!isHostname(p.domain)) { skipped.push({ domain: p.domain, reason: "invalid hostname" }); continue; }
    if (!isHost(p.forwardHost) || isDangerousHost(p.forwardHost)) { skipped.push({ domain: p.domain, reason: "invalid forward host" }); continue; }
    if (isControlPlaneDomain(p.domain, p.forwardHost, p.forwardPort, p.forwardScheme)) {
      skipped.push({ domain: p.domain, reason: "conflicts with NginUX portal" }); continue;
    }
    // Import is admin-only (HTTP portal forwards allowed); shared rule kept for parity.
    if (controlPlaneTargetError({ protocol: "http", forwardHost: p.forwardHost, forwardPort: p.forwardPort }, { admin: true })) {
      skipped.push({ domain: p.domain, reason: "targets the NginUX control plane" }); continue;
    }
    if (getHostByDomain(p.domain)) { skipped.push({ domain: p.domain, reason: "already exists" }); continue; }
    if (toImport.some((d) => d.domain.toLowerCase() === p.domain.toLowerCase())) { skipped.push({ domain: p.domain, reason: "duplicate in file" }); continue; }
    toImport.push({ ...p, name: draftName(p.domain) });
  }
  return { toImport, skipped };
}

export function importNginxConf(text: string): { imported: string[]; skipped: string[]; createdIds: string[] } {
  const preview = previewNginxConf(text);
  const imported: string[] = [];
  const createdIds: string[] = [];
  const skipped = preview.skipped.map((s) => s.domain);
  for (const d of preview.toImport) {
    const host: NewProxyHost = {
      name: d.name, domain: d.domain, forwardScheme: d.forwardScheme, forwardHost: d.forwardHost,
      forwardPort: d.forwardPort, preset: "custom", websockets: d.websockets, http2: true, ssl: d.ssl,
      requireLogin: false, require2fa: false, countryLock: false,
      serverGroup: d.forwardHost, serverIp: d.forwardHost, enabled: true,
    };
    // Route imported hosts through the SAME zod boundary as POST /api/hosts, so a value
    // parsed out of an untrusted nginx.conf (e.g. an out-of-range forwardPort) can't create
    // an invalid host that then breaks every config apply. (Security audit follow-up.)
    const parsed = hostInput.safeParse(host);
    if (!parsed.success || isControlPlaneDomain(parsed.data.domain, parsed.data.forwardHost, parsed.data.forwardPort, parsed.data.forwardScheme)) {
      skipped.push(d.domain);
      continue;
    }
    const created = createHost(parsed.data);
    createdIds.push(created.id);
    imported.push(d.domain);
  }
  return { imported, skipped, createdIds };
}
