// Derive the registrable (base) domain from an FQDN, public-suffix aware. Used to
// pick the correct DNS zone for an ACME DNS-01 challenge so wildcard/DNS-01
// issuance works across MULTIPLE base domains on one instance, instead of always
// writing the TXT record into a single globally-configured baseDomain.
//
// This is a curated multi-label public-suffix list, not the full PSL - it covers
// the homelab long tail (national second-level domains) without a heavy dependency.
// If your TLD's second level isn't here, the base domain still resolves correctly
// for the common `sub.example.tld` case; only exotic `sub.example.co.xx` forms on
// an unlisted suffix would need an entry added.
export const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "net.uk", "sch.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz",
  "co.jp", "or.jp", "ne.jp", "go.jp", "ac.jp",
  "co.kr", "or.kr", "ne.kr", "go.kr",
  "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
  "co.za", "org.za", "net.za", "web.za", "gov.za",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "org.mx", "gob.mx",
  "com.sg", "edu.sg", "net.sg", "org.sg", "gov.sg",
  "com.tr", "net.tr", "org.tr", "gov.tr",
  "com.cn", "net.cn", "org.cn", "gov.cn",
  "com.tw", "org.tw", "idv.tw",
  "co.il", "org.il", "net.il", "ac.il", "gov.il",
  "com.hk", "org.hk", "net.hk", "edu.hk", "gov.hk",
]);

/** The registrable base domain of an FQDN (e.g. plex.ubhi.io -> ubhi.io,
 *  a.b.example.co.uk -> example.co.uk). Public-suffix aware for the curated set
 *  above. Strips a leading wildcard and any trailing dot. Never returns a bare
 *  public suffix (it always includes the label above it). */
export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^\*\./, "").replace(/\.$/, "").trim();
  const labels = h.split(".").filter(Boolean);
  if (labels.length <= 2) return h; // already registrable (example.com) or a single label
  // Longest matching multi-label suffix first (supports future 3-label suffixes).
  for (const n of [3, 2]) {
    if (labels.length > n && MULTI_LABEL_SUFFIXES.has(labels.slice(-n).join("."))) {
      return labels.slice(-(n + 1)).join(".");
    }
  }
  // Default: the last two labels are the registrable domain.
  return labels.slice(-2).join(".");
}
