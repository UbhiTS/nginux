import { z } from "zod";
import { isHostname } from "./validate.ts";

// Single source of truth for settings-write validation, shared by the REST
// boundary (PUT /api/settings) and the agent tool path (update_settings). Both
// validate through the SAME schema, so the agent path can't be looser than REST -
// and unknown keys are stripped by zod, so it doubles as the write allowlist.
//
// It's `.partial()` because both paths accept partial patches (change one setting
// without resending them all). Every field is length/charset/enum/range bounded;
// URL and cookie-domain fields that reach generated nginx config are guarded.
export const settingsInput = z.object({
  instanceName: z.string().max(120),
  baseDomain: z.string().max(253).refine((s) => s === "" || isHostname(s), "Invalid base domain."),
  theme: z.enum(["dark", "less-dark", "medium", "less-light", "light"]),
  letsEncryptEmail: z.string().max(254),
  homeCountry: z.string().max(2),
  // Comma/space-separated ISO-3166-1 alpha-2 codes; geoip.ts filters to valid
  // 2-letter tokens, so we only bound length + charset here (no injection into
  // the generated nginx map - each code is re-validated against /^[A-Z]{2}$/).
  allowedCountries: z.string().max(512).regex(/^[A-Za-z ,]*$/, "Only letters, spaces and commas."),
  publicIp: z.string().max(64),
  gatewayIp: z.string().max(64),
  dnsProvider: z.enum(["none", "godaddy", "cloudflare"]),
  godaddyApiKey: z.string().max(256),
  godaddySecret: z.string().max(256),
  cloudflareApiToken: z.string().max(256),
  maxmindLicenseKey: z.string().max(256),
  acmeStaging: z.boolean(),
  updateCheckEnabled: z.boolean(),
  agentAutoApprove: z.boolean(),
  require2faForManagers: z.boolean(),
  gitOpsEnabled: z.boolean(),
  ssoLoginUrl: z.string().max(512).refine((s) => s === "" || /^https?:\/\/[^\s/]+/i.test(s), "Must be a full URL like https://nginux.example.com."),
  ssoCookieDomain: z.string().max(253).refine((s) => s === "" || /^\.?[a-z0-9.-]+$/i.test(s), "Invalid cookie domain."),
  // JSON array of { baseDomain, loginUrl }: each base domain a valid hostname, each
  // login URL a full http(s) URL. Empty = single global realm.
  ssoRealms: z.string().max(4096).refine((s) => {
    if (!s.trim()) return true;
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) && arr.every((r) =>
        r && typeof r.baseDomain === "string" && /^[a-z0-9.-]+$/i.test(r.baseDomain) &&
        typeof r.loginUrl === "string" && /^https?:\/\/[^\s/]+/i.test(r.loginUrl));
    } catch { return false; }
  }, "Realms must be a JSON array of { baseDomain, loginUrl } with valid domains and URLs."),
  ssoForwardSecret: z.string().max(256),
  logMaxMb: z.number().int().min(0).max(100000),
  logKeepFiles: z.number().int().min(0).max(50),
}).partial();

export type SettingsInput = z.infer<typeof settingsInput>;
