import { z } from "zod";
import { VERSION } from "./version.ts";
import { getSettings, redactSettings, saveSettings, SECRET_SETTING_KEYS } from "./db.ts";
import { listHosts, replaceAllHosts } from "./repo.ts";
import { listBans, replaceAllBans, type Ban } from "./bans.ts";
import { listChannels, listChannelsRaw, replaceAllChannels, validateChannelConfig, type Channel, type ChannelType } from "./notify.ts";
import { hostInput, isControlPlaneDomain, normalizeProtocolFields, protocolCapabilityError, streamPortConflictError } from "./hostschema.ts";
import { settingsInput } from "./settingsschema.ts";
import { isIpOrCidr } from "./validate.ts";
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
  id: z.string().min(1).max(128),
  type: z.enum(["ntfy", "gotify", "pushover", "discord", "slack", "telegram", "webhook", "email"]),
  name: z.string().min(1).max(64),
  config: z.record(z.string().max(128), z.string().max(2048)).default({}),
  events: z.array(z.string().max(64)).max(50).default(["*"]),
  minSeverity: z.enum(["info", "notice", "warn", "danger"]).default("info"),
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
    // Bundles from before upstream verification existed preserve their prior
    // self-signed-compatible behavior; new creates default this on.
    upstreamTlsVerify: z.boolean().default(false),
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

  // Settings: apply only real (non-masked) values, so a redacted bundle keeps the
  // current secrets. A masked secret is the "••••" placeholder from redactSettings.
  const settingsPatch: Record<string, unknown> = {};
  const masked = new Set<string>(SECRET_SETTING_KEYS);
  for (const [k, v] of Object.entries(b.settings)) {
    if (masked.has(k) && typeof v === "string" && v.includes("••")) continue;
    settingsPatch[k] = v;
  }
  // Validate through the SAME schema PUT /api/settings uses BEFORE validating hosts,
  // so host portal/cookie-domain checks evaluate against the post-restore settings.
  const s = settingsInput.safeParse(settingsPatch);
  if (!s.success) {
    throw new Error("Invalid backup bundle: settings " + s.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).slice(0, 4).join("; "));
  }
  const effectiveSettings: Settings = { ...getSettings(), ...(s.data as Partial<Settings>) };

  // Normalize and validate EVERY section before the first mutation.
  const hosts = b.hosts.map((h) => {
    const capabilityError = protocolCapabilityError(h, effectiveSettings);
    if (capabilityError) throw new Error(`Invalid backup bundle: ${h.domain} ${capabilityError}`);
    const normalized = normalizeProtocolFields(h);
    if (isControlPlaneDomain(normalized.domain, normalized.forwardHost, normalized.forwardPort, normalized.forwardScheme, effectiveSettings)) {
      throw new Error(`Invalid backup bundle: ${normalized.domain} conflicts with the NginUX sign-in portal domain.`);
    }
    return {
      ...normalized,
      health: "unknown",
      certExpiresAt: null,
      createdAt: h.createdAt ?? now,
      updatedAt: now,
    };
  }) as unknown as ProxyHost[];

  const hostIds = new Set<string>();
  const domains = new Set<string>();
  for (const h of hosts) {
    const domain = h.domain.toLowerCase();
    if (hostIds.has(h.id) || domains.has(domain)) throw new Error("Invalid backup bundle: duplicate host id or domain.");
    hostIds.add(h.id); domains.add(domain);
    const spErr = streamPortConflictError(h, hosts, h.id);
    if (spErr) throw new Error(`Invalid backup bundle: ${h.domain} ${spErr}`);
  }

  // Channels reach outbound-connect sinks (webhook URL / syslog server / SMTP host).
  // Validate every non-masked channel config before any DB mutation.
  for (const c of b.channels) {
    const cfg = (c.config ?? {}) as Record<string, string>;
    const isRedacted = Object.values(cfg).some((v) => typeof v === "string" && v.includes("••"));
    if (isRedacted) continue;
    const cfgErr = validateChannelConfig(c.type as ChannelType, cfg);
    if (cfgErr) throw new Error(`Invalid backup bundle channel "${c.name}": ${cfgErr}`);
  }
  if (new Set(b.channels.map((c) => c.id)).size !== b.channels.length) {
    throw new Error("Invalid backup bundle: duplicate notification channel id.");
  }

  // All untrusted input is now known-safe. Mutate only after that validation
  // barrier; each replace helper is internally transactional for its table.
  replaceAllHosts(hosts);
  const bans = replaceAllBans(b.bans as Ban[]);
  const channels = replaceAllChannels(b.channels as Channel[]);
  saveSettings(s.data as Partial<Settings>);

  return { hosts: hosts.length, bans, channels, settings: Object.keys(s.data).length };
}
