// Shared pure formatters + small display helpers. Previously these lived in the
// Logs *page* and were imported into components (a page->component smell) and
// re-implemented in a couple of places (fmtBytes). One home now.

export function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " MB";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + " KB";
  return n + " B";
}

/** HTTP status -> the design-system colour var (5xx red, 4xx yellow, 3xx accent, else green). */
export const statusColor = (s: number) =>
  s >= 500 ? "var(--red)" : s >= 400 ? "var(--yellow)" : s >= 300 ? "var(--accent)" : "var(--green)";

/** ISO 3166 alpha-2 -> flag emoji (🌐 fallback). */
export const flag = (cc: string) =>
  cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map((c) => 127397 + c.charCodeAt(0))) : "🌐";

// ISO 3166 code -> full name via the browser (no data file); falls back to the code.
const regionNames = (() => { try { return new Intl.DisplayNames(["en"], { type: "region" }); } catch { return null; } })();
export const countryName = (cc: string) =>
  cc && cc.length === 2 && regionNames ? (regionNames.of(cc.toUpperCase()) ?? cc) : cc || "";
