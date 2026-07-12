// Shared ordering for event severities, used by alert routing (a channel fires
// only for events at or above its configured floor) and anywhere else that needs
// to compare severities. Kept in one place so the ordering can't drift.

export const SEVERITY_ORDER = ["info", "notice", "warn", "danger"] as const;
export type Severity = (typeof SEVERITY_ORDER)[number];

/** Rank of a severity (0 = info, highest = danger). Unknown values fall back to
 *  "info" (0) so an unexpected value never over-suppresses an alert. */
export function severityRank(sev: string | undefined): number {
  const i = SEVERITY_ORDER.indexOf(String(sev) as Severity);
  return i === -1 ? 0 : i;
}

/** Does an event of severity `sev` clear a channel's minimum `min`? */
export function meetsSeverity(sev: string | undefined, min: string | undefined): boolean {
  return severityRank(sev) >= severityRank(min);
}
