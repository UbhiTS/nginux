import { z } from "zod";
import { VERSION } from "./version.ts";
import { getSettings, redactSettings, saveSettings, SECRET_SETTING_KEYS } from "./db.ts";
import { listHosts, replaceAllHosts } from "./repo.ts";
import { listBans, replaceAllBans, type Ban } from "./bans.ts";
import { listChannels, listChannelsRaw, replaceAllChannels, type Channel } from "./notify.ts";
import { hostInput } from "./hostschema.ts";
import { settingsInput } from "./settingsschema.ts";
import { isIpOrCidr, assertSafeOutboundUrl, isDangerousHost } from "./validate.ts";
import type { ProxyHost, Settings } from "./types.ts";

// A portable, self-describing backup bundle: everything needed to stand up an
// identical NginUX on another box - hosts, settings, IP bans, and notification
// channels. Certificates are intentionally NOT included (they're re-issued on the
// new box; shipping private keys in a backup would be a footgun). Secrets travel
// only in an encrypted bundle; a plain bundle carries them masked and restore
// skips masked values so it never clobbers a real secret with a placeholder.

export interface Bundle {
  magic: "nginux-backup";
  schema: 1;
  version: string;
  createdAt: string;
  includesSecrets: boolean;
  hosts: ProxyHost[];
  settings: Settings;
  bans: Ban[];
  channels: Channel[];
}

/** Snapshot the instance into a bundle. `includeSecrets` (only honored for an
 *  encrypted export) ships real credentials + channel configs; otherwise they're
 *  masked. `createdAt` is passed in so this stays pure/testable. */
export function buildBundle(createdAt: string, includeSecrets: boolean): Bundle {
  return {
    magic: "nginux-backup",
    schema: 1,
    version: VERSION,
    createdAt,
    includesSecrets: includeSecrets,
    hosts: listHosts(),
    settings: includeSecrets ? getSettings() : redactSettings(getSettings()),
    bans: listBans(),
    channels: includeSecrets ? listChannelsRaw() : listChannels(),
  };
}

const banSchema = z.object({
  // Same charset gate as the REST/MCP ban paths — a raw bundle IP reaches
  // `deny ${ip};` in banned.conf, an http-context nginx sink. (Security audit 2026-07-12.)
  ip: z.string().min(1).max(64).refine(isIpOrCidr, "Ban entries must be a valid IP or CIDR."),
  reason: z.string().max(256).default(""),
  source: z.enum(["manual", "auto", "geoip"]).default("manual"),
  createdAt: z.string().default(() => new Date().toISOString()),
  expiresAt: z.string().nullable().default(null),
});
const channelSchema = z.object({
  id: z.string(), type: z.string(), name: z.string(),
  config: z.record(z.string(), z.string()).default({}),
  events: z.array(z.string()).default(["*"]),
  minSeverity: z.string().default("info"),
  enabled: z.boolean().default(true),
  lastStatus: z.string().nullable().default(null),
  createdAt: z.string().default(() => new Date().toISOString()),
});
const bundleSchema = z.object({
  magic: z.literal("nginux-backup"),
  schema: z.literal(1),
  version: z.string().optional(),
  createdAt: z.string().optional(),
  includesSecrets: z.boolean().optional(),
  // Each host must be a valid host (same rules as a create) plus its DB-managed id.
  hosts: z.array(hostInput.extend({
    id: z.string().min(1),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })).default([]),
  settings: z.record(z.string(), z.unknown()).default({}),
  bans: z.array(banSchema).default([]),
  channels: z.array(channelSchema).default([]),
});

export interface RestoreResult { hosts: number; bans: number; channels: number; settings: number }

/** Validate + restore a bundle, transactionally per table. Returns per-section
 *  counts. Masked secret settings/channels are skipped so a redacted bundle never
 *  overwrites a live secret with a placeholder. Throws on an invalid bundle. */
export function restoreBundle(raw: unknown): RestoreResult {
  const parsed = bundleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("Invalid backup bundle: " + parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 6).join("; "));
  }
  const b = parsed.data;
  const now = new Date().toISOString();

  // Hosts: fill DB-managed fields the schema doesn't require, then transactional swap.
  const hosts = b.hosts.map((h) => ({
    ...h,
    health: "unknown",
    certExpiresAt: null,
    createdAt: h.createdAt ?? now,
    updatedAt: now,
  })) as unknown as ProxyHost[];
  replaceAllHosts(hosts);

  const bans = replaceAllBans(b.bans as Ban[]);

  // Channels reach outbound-connect sinks (webhook URL / syslog server / SMTP host).
  // The create path SSRF-guards these; a restored bundle must too, or a tampered
  // portable bundle installs an attacker-chosen destination. (Security audit 2026-07-12.)
  for (const c of b.channels) {
    for (const key of ["url", "server"]) {
      const v = (c.config as Record<string, string> | undefined)?.[key];
      if (v) assertSafeOutboundUrl(v); // throws on a link-local/metadata target
    }
    const host = (c.config as Record<string, string> | undefined)?.host;
    if (c.type === "email" && host && isDangerousHost(host)) {
      throw new Error(`Backup bundle has an unsafe email host: ${host}`);
    }
  }
  const channels = replaceAllChannels(b.channels as Channel[]);

  // Settings: apply only real (non-masked) values, so a redacted bundle keeps the
  // current secrets. A masked secret is the "••••" placeholder from redactSettings.
  const settingsPatch: Record<string, unknown> = {};
  const masked = new Set<string>(SECRET_SETTING_KEYS);
  for (const [k, v] of Object.entries(b.settings)) {
    if (masked.has(k) && typeof v === "string" && v.includes("••")) continue;
    settingsPatch[k] = v;
  }
  // Validate through the SAME schema PUT /api/settings uses, so a restored bundle can't
  // inject values (e.g. an ssoForwardSecret / ssoLoginUrl that breaks out of an nginx
  // directive) that the REST boundary would reject. Unknown keys are stripped by zod.
  // (Security audit 2026-07-12.)
  const s = settingsInput.safeParse(settingsPatch);
  if (!s.success) {
    throw new Error("Invalid backup bundle: settings " + s.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 4).join("; "));
  }
  saveSettings(s.data as Partial<Settings>);

  return { hosts: hosts.length, bans, channels, settings: Object.keys(s.data).length };
}
