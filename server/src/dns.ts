import { getSettings } from "./db.ts";

// Pluggable DNS provider model (GoDaddy first; others slot in the same way).
export interface DnsProvider {
  id: string;
  label: string;
  configured: boolean;
  /** Create/replace a TXT record (used for ACME DNS-01). name is relative to root. */
  upsertTxt(root: string, name: string, value: string): Promise<void>;
  removeTxt(root: string, name: string): Promise<void>;
  /** Create/replace an A/AAAA/CNAME record (used to auto-point a new host). */
  upsertRecord(root: string, type: "A" | "AAAA" | "CNAME", name: string, value: string): Promise<void>;
}

class ManualProvider implements DnsProvider {
  id = "none";
  label = "Manual (no provider connected)";
  configured = false;
  private fail(): never {
    throw new Error(
      "No DNS provider is connected. Add GoDaddy credentials in Settings, or create the record yourself.",
    );
  }
  async upsertTxt() { this.fail(); }
  async removeTxt() { this.fail(); }
  async upsertRecord() { this.fail(); }
}

class GoDaddyProvider implements DnsProvider {
  id = "godaddy";
  label = "GoDaddy";
  configured = true;
  private base = "https://api.godaddy.com/v1";
  private key: string;
  private secret: string;
  constructor(key: string, secret: string) {
    this.key = key;
    this.secret = secret;
  }

  private headers() {
    return {
      Authorization: `sso-key ${this.key}:${this.secret}`,
      "Content-Type": "application/json",
    };
  }

  // GoDaddy replaces all records of a given type+name with the supplied array.
  async upsertTxt(root: string, name: string, value: string) {
    const res = await fetch(`${this.base}/domains/${root}/records/TXT/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify([{ data: value, ttl: 600 }]),
    });
    if (!res.ok) throw new Error(`GoDaddy TXT update failed (${res.status})`);
  }

  async removeTxt(root: string, name: string) {
    const res = await fetch(`${this.base}/domains/${root}/records/TXT/${encodeURIComponent(name)}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 404) throw new Error(`GoDaddy TXT delete failed (${res.status})`);
  }

  async upsertRecord(root: string, type: "A" | "AAAA" | "CNAME", name: string, value: string) {
    const res = await fetch(`${this.base}/domains/${root}/records/${type}/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify([{ data: value, ttl: 600 }]),
    });
    if (!res.ok) throw new Error(`GoDaddy ${type} update failed (${res.status})`);
  }
}

class CloudflareProvider implements DnsProvider {
  id = "cloudflare";
  label = "Cloudflare";
  configured = true;
  private base = "https://api.cloudflare.com/client/v4";
  private token: string;
  private zoneCache = new Map<string, string>();
  constructor(token: string) {
    this.token = token;
  }
  private headers() {
    return { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" };
  }
  private async zoneId(root: string): Promise<string> {
    if (this.zoneCache.has(root)) return this.zoneCache.get(root)!;
    const res = await fetch(`${this.base}/zones?name=${root}`, { headers: this.headers() });
    const body = (await res.json()) as { result?: { id: string }[] };
    const id = body?.result?.[0]?.id;
    if (!id) throw new Error(`Cloudflare: zone ${root} not found`);
    this.zoneCache.set(root, id);
    return id;
  }
  private fqdn(root: string, name: string) {
    return name === "@" ? root : `${name}.${root}`;
  }
  private async upsert(root: string, type: string, name: string, content: string) {
    const zid = await this.zoneId(root);
    const fqdn = this.fqdn(root, name);
    const list = await fetch(`${this.base}/zones/${zid}/dns_records?type=${type}&name=${fqdn}`, { headers: this.headers() });
    const existing = ((await list.json()) as { result?: { id: string }[] })?.result?.[0];
    const payload = JSON.stringify({ type, name: fqdn, content, ttl: 120 });
    const res = existing
      ? await fetch(`${this.base}/zones/${zid}/dns_records/${existing.id}`, { method: "PUT", headers: this.headers(), body: payload })
      : await fetch(`${this.base}/zones/${zid}/dns_records`, { method: "POST", headers: this.headers(), body: payload });
    if (!res.ok) throw new Error(`Cloudflare ${type} upsert failed (${res.status})`);
  }
  async upsertTxt(root: string, name: string, value: string) { await this.upsert(root, "TXT", name, value); }
  async removeTxt(root: string, name: string) {
    const zid = await this.zoneId(root);
    const fqdn = this.fqdn(root, name);
    const list = await fetch(`${this.base}/zones/${zid}/dns_records?type=TXT&name=${fqdn}`, { headers: this.headers() });
    const rec = ((await list.json()) as { result?: { id: string }[] })?.result?.[0];
    if (rec) await fetch(`${this.base}/zones/${zid}/dns_records/${rec.id}`, { method: "DELETE", headers: this.headers() });
  }
  async upsertRecord(root: string, type: "A" | "AAAA" | "CNAME", name: string, value: string) { await this.upsert(root, type, name, value); }
}

export function getDnsProvider(): DnsProvider {
  const s = getSettings();
  if (s.dnsProvider === "godaddy") {
    const key = process.env.GODADDY_API_KEY ?? s.godaddyApiKey;
    const secret = process.env.GODADDY_API_SECRET ?? s.godaddySecret;
    if (key && secret) return new GoDaddyProvider(key, secret);
  }
  if (s.dnsProvider === "cloudflare") {
    const token = process.env.CLOUDFLARE_API_TOKEN ?? s.cloudflareApiToken;
    if (token) return new CloudflareProvider(token);
  }
  return new ManualProvider();
}

/** Split a full host (plex.ubhi.io) into record name (plex) relative to root (ubhi.io). */
export function recordName(domain: string, root: string): string {
  if (domain === root) return "@";
  return domain.endsWith(`.${root}`) ? domain.slice(0, -(root.length + 1)) : domain;
}
