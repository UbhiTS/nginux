import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { getSettings } from "./db.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.NGINUX_DATA_DIR ?? join(__dirname, "..", "data");
const GEOIP_DIR = process.env.GEOIP_DIR ?? join(DATA_DIR, "geoip");
const DB_PATH = join(GEOIP_DIR, "GeoLite2-Country.mmdb");
const CONF_DIR = process.env.NGINX_CONF_DIR ?? join(__dirname, "..", "..", "nginx", "conf.d");
// nginx.conf does `include <this>;` — keep it next to conf.d (i.e. /data/nginx/geoip.conf).
const GEOIP_CONF = process.env.NGINX_GEOIP_CONF ?? join(dirname(CONF_DIR), "geoip.conf");

export const geoipConfPath = GEOIP_CONF;
export const geoipDbPath = DB_PATH;

/** Parse the home-country setting into a clean list of ISO-3166-1 alpha-2 codes. */
function allowedCountries(homeCountry: string): string[] {
  return (homeCountry || "")
    .split(/[,\s]+/)
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c));
}

export interface GeoipStatus {
  present: boolean;
  active: boolean;
  sizeBytes: number;
  updatedAt: string | null;
  countries: string[];
}

export function geoipStatus(): GeoipStatus {
  const present = existsSync(DB_PATH);
  let sizeBytes = 0;
  let updatedAt: string | null = null;
  if (present) {
    const s = statSync(DB_PATH);
    sizeBytes = s.size;
    updatedAt = s.mtime.toISOString();
  }
  const countries = allowedCountries(getSettings().homeCountry);
  return { present, active: present && countries.length > 0, sizeBytes, updatedAt, countries };
}

/** Minimal tar reader: return the bytes of the first *.mmdb member. Tar uses
 *  512-byte headers (name @0, octal size @124) followed by 512-padded content —
 *  enough to pull one file out of MaxMind's archive without a tar dependency. */
function findMmdbInTar(tar: Buffer): Buffer | null {
  let off = 0;
  while (off + 512 <= tar.length) {
    const header = tar.toString("latin1", off, off + 136);
    const nul = header.indexOf("\0");
    const name = (nul >= 0 ? header.slice(0, nul) : header.slice(0, 100)).trim();
    if (!name) break; // end-of-archive (zero block)
    const size = parseInt(header.slice(124, 136).replace(/[^0-7]/g, "") || "0", 8) || 0;
    const start = off + 512;
    if (name.endsWith(".mmdb")) return tar.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Download the free GeoLite2-Country database from MaxMind using the configured
 *  license key, extract the .mmdb, and store it on the data volume. */
export async function downloadGeoipDb(): Promise<{ sizeBytes: number }> {
  const key = process.env.GEOIP_LICENSE_KEY ?? getSettings().maxmindLicenseKey;
  if (!key) throw new Error("Add your MaxMind license key in Settings first.");
  const url =
    "https://download.maxmind.com/app/geoip_download" +
    `?edition_id=GeoLite2-Country&license_key=${encodeURIComponent(key)}&suffix=tar.gz`;

  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) }); // don't hang the request forever
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "MaxMind rejected the license key (401). Double-check it in Settings."
        : `MaxMind download failed (HTTP ${res.status}).`,
    );
  }
  const gz = Buffer.from(await res.arrayBuffer());
  // The GeoLite2-Country archive is a few MB; cap the gzip input so a wrong/huge
  // response can't OOM the 512 MB container before we even decompress.
  if (gz.length > 64 * 1024 * 1024) throw new Error("MaxMind response was unexpectedly large — aborting.");
  let tar: Buffer;
  try {
    tar = gunzipSync(gz);
  } catch {
    throw new Error("The downloaded file wasn't a valid archive.");
  }
  const mmdb = findMmdbInTar(tar);
  if (!mmdb || mmdb.length < 1000) {
    throw new Error("Couldn't find the country database inside MaxMind's archive.");
  }
  mkdirSync(GEOIP_DIR, { recursive: true });
  writeFileSync(DB_PATH, mmdb);
  return { sizeBytes: mmdb.length };
}

export function deleteGeoipDb(): void {
  try {
    rmSync(DB_PATH, { force: true });
  } catch {
    /* nothing to remove */
  }
}

/** (Re)generate the nginx include defining $geoip2_country_iso_code (for the
 *  access log / traffic map) and $nginux_allowed_country (for the per-host
 *  country lock). Both variables are ALWAYS defined so the log format and host
 *  configs that reference them can never hit an "unknown variable" error:
 *   - $geoip2_country_iso_code: resolved from the MaxMind DB when present, else
 *     a constant empty string (country simply unknown).
 *   - $nginux_allowed_country: real geo-filtering with a DB + allowed countries
 *     (LAN always allowed), otherwise a valid allow-all no-op. */
export function writeGeoipConf(): void {
  mkdirSync(dirname(GEOIP_CONF), { recursive: true });
  const countries = allowedCountries(getSettings().homeCountry);
  const hasDb = existsSync(DB_PATH);
  const parts: string[] = ["# Generated by NginUX."];

  // 1) Country code for logging (and, when locked, filtering). Always defined.
  if (hasDb) {
    parts.push(`geoip2 ${DB_PATH} {
    auto_reload 60m;
    $geoip2_country_iso_code country iso_code;
}`);
  } else {
    parts.push(`# No GeoIP database — country is unknown (empty) for logging.
map $remote_addr $geoip2_country_iso_code { default ""; }`);
  }

  // 2) Per-host country lock. Active only with a DB + at least one allowed
  //    country; otherwise allow-all so country-lock is a safe no-op.
  if (hasDb && countries.length > 0) {
    const countryLines = countries.map((c) => `    ${c} 1;`).join("\n");
    parts.push(`# Country lock active for: ${countries.join(", ")}.
# Your own LAN / loopback is always allowed, regardless of geo.
geo $nginux_is_private {
    default 0;
    127.0.0.0/8 1;
    10.0.0.0/8 1;
    172.16.0.0/12 1;
    192.168.0.0/16 1;
    ::1/128 1;
    fc00::/7 1;
}
map $geoip2_country_iso_code $nginux_country_ok {
    default 0;
${countryLines}
}
# Allow when the client is on the LAN OR resolves to an allowed country.
map "$nginux_is_private$nginux_country_ok" $nginux_allowed_country {
    default 0;
    "~1" 1;
}`);
  } else {
    parts.push(`# Country lock inactive — allow all.
geo $nginux_allowed_country { default 1; }`);
  }

  writeFileSync(GEOIP_CONF, parts.join("\n\n") + "\n");
}
