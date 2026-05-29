import { createHash, randomBytes, randomUUID } from "node:crypto";
import { db } from "./db.ts";

export type Scope = "read" | "report" | "control" | "security";
export type Trust = "untrusted" | "trusted";

export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  scopes: Scope[];
  trust: Trust;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface AgentPrincipal {
  kind: "agent";
  id: string;
  name: string;
  scopes: Scope[];
  trust: Trust;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type Row = Record<string, unknown>;
function toToken(r: Row): ApiToken {
  return {
    id: String(r.id),
    name: String(r.name),
    prefix: String(r.prefix),
    scopes: JSON.parse(String(r.scopes)),
    trust: r.trust as Trust,
    createdAt: String(r.createdAt),
    lastUsedAt: r.lastUsedAt ? String(r.lastUsedAt) : null,
    revoked: !!r.revoked,
  };
}

export function listTokens(): ApiToken[] {
  return (db.prepare("SELECT * FROM api_tokens WHERE revoked = 0 ORDER BY createdAt").all() as Row[]).map(toToken);
}

export function createToken(input: { name: string; scopes: Scope[]; trust?: Trust }): { token: string; record: ApiToken } {
  const id = randomUUID();
  const raw = `ngx_${randomBytes(24).toString("hex")}`;
  db.prepare(
    "INSERT INTO api_tokens (id, name, prefix, tokenHash, scopes, trust, createdAt) VALUES (?,?,?,?,?,?,?)",
  ).run(id, input.name, raw.slice(-4), sha(raw), JSON.stringify(input.scopes), input.trust ?? "untrusted", new Date().toISOString());
  return { token: raw, record: toToken(db.prepare("SELECT * FROM api_tokens WHERE id = ?").get(id) as Row) };
}

export function revokeToken(id: string): boolean {
  return db.prepare("UPDATE api_tokens SET revoked = 1 WHERE id = ?").run(id).changes > 0;
}

/** Resolve a raw Bearer token to an agent principal (or null). */
export function resolveToken(raw: string | undefined): AgentPrincipal | null {
  if (!raw) return null;
  const row = db.prepare("SELECT * FROM api_tokens WHERE tokenHash = ? AND revoked = 0").get(sha(raw)) as Row | undefined;
  if (!row) return null;
  db.prepare("UPDATE api_tokens SET lastUsedAt = ? WHERE id = ?").run(new Date().toISOString(), String(row.id));
  const t = toToken(row);
  return { kind: "agent", id: t.id, name: t.name, scopes: t.scopes, trust: t.trust };
}

export function bearerFrom(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : undefined;
}

/** Seed demo token records so the UI isn't empty (raw values unknown by design). */
export function seedTokensIfEmpty(): void {
  const n = (db.prepare("SELECT COUNT(*) AS n FROM api_tokens").get() as Row).n as number;
  if (n > 0) return;
  const now = new Date().toISOString();
  const demo = [
    { name: "claude-desktop", scopes: ["read", "report"], trust: "trusted" },
    { name: "ops-bot", scopes: ["read", "control", "security"], trust: "trusted" },
    { name: "homepage-agent", scopes: ["read"], trust: "untrusted" },
  ];
  for (const d of demo) {
    db.prepare(
      "INSERT INTO api_tokens (id, name, prefix, tokenHash, scopes, trust, createdAt) VALUES (?,?,?,?,?,?,?)",
    ).run(randomUUID(), d.name, randomBytes(2).toString("hex"), sha(randomUUID()), JSON.stringify(d.scopes), d.trust, now);
  }
}
