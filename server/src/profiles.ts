import { randomUUID } from "node:crypto";
import { z } from "zod";
import { db } from "./db.ts";
import { hostInput } from "./hostschema.ts";
import type { ProxyHost } from "./types.ts";

// A security profile is a stored, named bundle of a host's security-subset fields
// that can be applied across services for consistency. The bundle is validated
// through the SAME hostInput rules (via .pick), so a profile can never hold a value
// a host couldn't (SSRF/injection guards inherited) - and it's stored as a JSON
// blob so the profile shape follows hostInput without a schema migration.

export const SECURITY_PROFILE_KEYS = [
  "requireLogin", "require2fa", "securityHeaders", "hsts", "blockExploits",
  "countryLock", "ipAllow", "ipDeny", "customHeaders", "mtls",
  "rateLimit", "rateLimitRps", "rateLimitBurst", "rateLimitKbps", "maxConns",
] as const;
export type SecurityProfileKey = (typeof SECURITY_PROFILE_KEYS)[number];

// Reuse hostInput's per-field validation for exactly this subset, all optional.
const pickShape = Object.fromEntries(SECURITY_PROFILE_KEYS.map((k) => [k, true])) as Record<SecurityProfileKey, true>;
export const profileFieldsSchema = hostInput.pick(pickShape).partial();
export type ProfileFields = z.infer<typeof profileFieldsSchema>;

export const profileInput = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(256).default(""),
  fields: profileFieldsSchema.default({}),
});

export interface SecurityProfile {
  id: string;
  name: string;
  description: string;
  fields: ProfileFields;
  builtin: boolean;
  createdAt: string;
  updatedAt: string;
}

type Row = Record<string, unknown>;
function toProfile(r: Row): SecurityProfile {
  return {
    id: String(r.id), name: String(r.name), description: String(r.description ?? ""),
    fields: JSON.parse(String(r.fields ?? "{}")), builtin: !!r.builtin,
    createdAt: String(r.createdAt), updatedAt: String(r.updatedAt),
  };
}

export function listProfiles(): SecurityProfile[] {
  return (db.prepare("SELECT * FROM security_profiles ORDER BY builtin DESC, name").all() as Row[]).map(toProfile);
}
export function getProfile(id: string): SecurityProfile | null {
  const r = db.prepare("SELECT * FROM security_profiles WHERE id = ?").get(id) as Row | undefined;
  return r ? toProfile(r) : null;
}

export function createProfile(input: { name: string; description?: string; fields: ProfileFields }, builtin = false, id = randomUUID()): SecurityProfile {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO security_profiles (id, name, description, fields, builtin, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?)").run(
    id, input.name, input.description ?? "", JSON.stringify(input.fields ?? {}), builtin ? 1 : 0, now, now,
  );
  return getProfile(id)!;
}

export function updateProfile(id: string, patch: { name?: string; description?: string; fields?: ProfileFields }): SecurityProfile | null {
  const cur = getProfile(id);
  if (!cur) return null;
  const merged = { name: patch.name ?? cur.name, description: patch.description ?? cur.description, fields: patch.fields ?? cur.fields };
  db.prepare("UPDATE security_profiles SET name = ?, description = ?, fields = ?, updatedAt = ? WHERE id = ?").run(
    merged.name, merged.description, JSON.stringify(merged.fields), new Date().toISOString(), id,
  );
  return getProfile(id);
}

/** Delete a profile. Built-in starters can't be deleted (returns false). */
export function deleteProfile(id: string): boolean {
  const p = getProfile(id);
  if (!p || p.builtin) return false;
  return db.prepare("DELETE FROM security_profiles WHERE id = ?").run(id).changes > 0;
}

/** The host patch a profile represents (just its stored security fields). */
export function profilePatch(p: SecurityProfile): Partial<ProxyHost> {
  return { ...p.fields } as Partial<ProxyHost>;
}

// Idempotent starter profiles so the feature isn't an empty list on first use.
const BUILTINS: Array<{ id: string; name: string; description: string; fields: ProfileFields }> = [
  {
    id: "builtin-locked-down", name: "Locked down",
    description: "Login + 2FA, HSTS, security headers, exploit blocking, and rate limiting.",
    fields: { requireLogin: true, require2fa: true, securityHeaders: true, hsts: true, blockExploits: true, rateLimit: true, rateLimitRps: 10, rateLimitBurst: 20 },
  },
  {
    id: "builtin-public-web", name: "Public web app",
    description: "Open to the internet but hardened: headers, HSTS, exploit blocking, generous rate limit.",
    fields: { requireLogin: false, securityHeaders: true, hsts: true, blockExploits: true, rateLimit: true, rateLimitRps: 50, rateLimitBurst: 100 },
  },
  {
    id: "builtin-internal-only", name: "Internal only",
    description: "Behind the login gate with security headers; no public rate limit.",
    fields: { requireLogin: true, securityHeaders: true, hsts: false, blockExploits: true, rateLimit: false },
  },
];

export function seedBuiltinProfiles(): void {
  const now = new Date().toISOString();
  const insert = db.prepare("INSERT OR IGNORE INTO security_profiles (id, name, description, fields, builtin, createdAt, updatedAt) VALUES (?,?,?,?,1,?,?)");
  for (const b of BUILTINS) insert.run(b.id, b.name, b.description, JSON.stringify(b.fields), now, now);
}
