import { getSettings } from "./db.ts";
import { registrableDomain } from "./registrable.ts";

// Multi-realm login gate: give each base domain its OWN login URL + cookie domain,
// so a gated service on a second base domain gets a cookie scoped to that domain
// and redirects to a sign-in portal on that domain - instead of looping because
// the single .domainA cookie is never sent to *.domainB. This is NOT cross-domain
// SSO (physically impossible via cookies); each base domain is an independent realm.
//
// Backward-compatible: with no realms configured, everything falls back to the
// single global ssoLoginUrl / ssoCookieDomain and behaves exactly as before.

export interface Realm { baseDomain: string; loginUrl: string }

/** Tolerantly parse the ssoRealms JSON setting; [] on empty/invalid. */
export function parseRealms(raw: string | undefined): Realm[] {
  if (!raw || !raw.trim()) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((r) => r && typeof r.baseDomain === "string" && typeof r.loginUrl === "string" && r.baseDomain && r.loginUrl)
      .map((r) => ({ baseDomain: String(r.baseDomain).toLowerCase().trim(), loginUrl: String(r.loginUrl).replace(/\/+$/, "") }));
  } catch {
    return [];
  }
}

/** The login realm for a host: match the host's registrable base against a
 *  configured realm.baseDomain. Returns null if none matches (caller falls back
 *  to the legacy single-domain ssoLoginUrl / cookie behavior). */
export function realmForHost(host: string, realms?: Realm[]): { loginUrl: string; cookieDomain: string } | null {
  const list = realms ?? parseRealms(getSettings().ssoRealms);
  if (!list.length) return null;
  const base = registrableDomain(host.replace(/:\d+$/, ""));
  const match = list.find((r) => registrableDomain(r.baseDomain) === base || r.baseDomain === base);
  if (!match) return null;
  return { loginUrl: match.loginUrl, cookieDomain: "." + base };
}
