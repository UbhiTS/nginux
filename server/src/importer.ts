import { createHost, getHostByDomain } from "./repo.ts";
import type { NewProxyHost } from "./types.ts";
import { isHost, isHostname } from "./validate.ts";

interface Parsed {
  domain: string;
  forwardScheme: "http" | "https";
  forwardHost: string;
  forwardPort: number;
  ssl: boolean;
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

export function parseNginxConf(text: string): Parsed[] {
  const out: Parsed[] = [];
  for (const block of serverBlocks(text)) {
    const nameM = block.match(/server_name\s+([^;]+);/);
    const passM = block.match(/proxy_pass\s+(https?):\/\/([^:;/\s]+)(?::(\d+))?/);
    if (!nameM || !passM) continue; // not a proxy server block (skip redirects/static)
    const domain = nameM[1].trim().split(/\s+/).find((n) => n !== "_" && !n.startsWith("*"));
    if (!domain) continue;
    const scheme = passM[1].toLowerCase() as "http" | "https";
    const ssl = /listen\s+[^;]*\bssl\b/.test(block) || /listen\s+443/.test(block);
    out.push({
      domain,
      forwardScheme: scheme,
      forwardHost: passM[2],
      forwardPort: Number(passM[3] ?? (scheme === "https" ? 443 : 80)),
      ssl,
    });
  }
  return out;
}

export function importNginxConf(text: string): { imported: string[]; skipped: string[] } {
  const imported: string[] = [];
  const skipped: string[] = [];
  for (const p of parseNginxConf(text)) {
    // Reject anything that isn't a clean hostname - the domain becomes a config
    // filename and is interpolated into generated nginx config.
    if (!isHostname(p.domain)) {
      skipped.push(p.domain);
      continue;
    }
    // forwardHost is interpolated into `proxy_pass`/`server` directives. The REST
    // path runs it through isHost; the importer is the only other writer, so guard
    // it here too - an unvalidated value would otherwise corrupt the generated conf.
    if (!isHost(p.forwardHost)) {
      skipped.push(p.domain);
      continue;
    }
    if (getHostByDomain(p.domain)) {
      skipped.push(p.domain);
      continue;
    }
    const host: NewProxyHost = {
      name: p.domain.split(".")[0].replace(/^\w/, (c) => c.toUpperCase()),
      domain: p.domain,
      forwardScheme: p.forwardScheme,
      forwardHost: p.forwardHost,
      forwardPort: p.forwardPort,
      preset: "custom",
      websockets: false,
      http2: true,
      ssl: p.ssl,
      requireLogin: false,
      require2fa: false,
      countryLock: false,
      serverGroup: p.forwardHost,
      serverIp: p.forwardHost,
      enabled: true,
    };
    createHost(host);
    imported.push(p.domain);
  }
  return { imported, skipped };
}
