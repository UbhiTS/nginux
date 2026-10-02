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

/** The login realm for a host. Primary rule: the host equals, or is a subdomain of, a
 *  configured realm.baseDomain — most specific base wins — and the cookie is scoped to
 *  exactly that base. (Two realms under one registrable domain, e.g. `a.example.com` and
 *  `b.example.com`, therefore stay independent instead of collapsing into whichever came
 *  first with an `.example.com`-wide cookie.) Compatibility fallback: a realm whose
 *  baseDomain was entered as a deeper label (e.g. the portal host itself) still covers
 *  its registrable domain, but only when no other realm shares that registrable domain.
 *  Returns null if none matches (caller falls back to the legacy single-domain
 *  ssoLoginUrl / cookie behavior). */
export function realmForHost(host: string, realms?: Realm[]): { loginUrl: string; cookieDomain: string } | null {
  const list = realms ?? parseRealms(getSettings().ssoRealms);
  if (!list.length) return null;
  const h = host.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
  const norm = (d: string) => d.toLowerCase().replace(/^\.+/, "").replace(/\.$/, "");
  const suffix = list
    .map((r) => ({ r, base: norm(r.baseDomain) }))
    .filter(({ base }) => base && (h === base || h.endsWith("." + base)))
    .sort((a, b) => b.base.length - a.base.length)[0];
  if (suffix) return { loginUrl: suffix.r.loginUrl, cookieDomain: "." + suffix.base };
  const base = registrableDomain(h);
  const byRegistrable = list.filter((r) => registrableDomain(norm(r.baseDomain)) === base);
  if (byRegistrable.length !== 1) return null;
  return { loginUrl: byRegistrable[0].loginUrl, cookieDomain: "." + base };
}
