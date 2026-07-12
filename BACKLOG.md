# NginUX Backlog

A single triage tracker for work that isn't in the current change. Grouped by
theme; each item has a **priority** (P0 critical → P3 nice-to-have), rough
**effort** (S ≤ half day · M ≤ 2 days · L larger), and **status**.

> Nothing here is started unless it says so. Security and correctness items are
> triaged above features. When you pick one up, move it to a PR and check it off.

Legend: ☐ not started · ◐ in progress · ☑ done · ⏸ parked (built, awaiting a gate)

---

## 1. Security & correctness (from the deep review)

The 2026-07-11 adversarial review fixed 24 findings (security, logic, coverage).
These survivors are **maintainability / drift risks**, not live vulnerabilities —
but two of them (1.1, 1.3) are places where a security-relevant validator has
*already drifted* between the REST and agent code paths, so they earn P1.

| # | Item | Why it matters | Pri | Effort | Status |
|---|------|----------------|-----|--------|--------|
| 1.1 | **Share host-write validation between REST and the agent tool path.** `server/src/index.ts` (zod `hostInput`) and `server/src/tools.ts` (`sanitizeHostPatch`) enforce the same injection/field rules twice, and have already diverged. Extract one shared validator both call. | A future field added to one path silently bypasses the other — the exact class of hole the review found. | P1 | M | ☐ |
| 1.2 | **De-duplicate the control-plane self-hijack guard** (`isControlPlaneDomain` logic) currently mirrored in two files. | Two copies drift; the update-path copy already had a bug (fixed this pass). | P2 | S | ☐ |
| 1.3 | **Share the per-line injection-sink validators** (`customHeaders` / `pathRules` / `upstreams`) copy-pasted between the zod schema and the agent sanitizer. | Same drift risk as 1.1, at the directive level. | P1 | S | ☐ |
| 1.4 | **Remove the dead split helper + unify the triplicated `splitList`/`splitLines` utilities** across three server modules into one `util.ts`. | Dead code + three subtly-different splitters invite inconsistency. | P3 | S | ☐ |
| 1.5 | **Finish the MCP `prompts` capability** in `server/src/mcp.ts` — it's advertised + listed but not retrievable (`prompts/get` unimplemented). Either wire it up or stop advertising it. | A half-wired capability confuses agent clients and reads as a bug. | P2 | S | ☐ |
| 1.6 | **Widen `update_settings` SETTING_KEYS allowlist safely** (`tools.ts`) once 1.1's shared settings-validation layer exists — currently omits `allowedCountries`, `updateCheckEnabled`, `ssoLoginUrl`, etc. by design (no agent-side validation). | Depends on 1.1; do not widen without shared validation. | P2 | M | ☐ (blocked by 1.1) |

## 2. Performance & structure (deferred audit findings)

| # | Item | Why it matters | Pri | Effort | Status |
|---|------|----------------|-----|--------|--------|
| 2.1 | **Async, offset-indexed access-log reader.** Replace the synchronous 32 MB `readSync` in `metrics.ts` (`searchLog`, `hostSummary`) with a bounded async line-reader + rolling byte-offset index. | A per-request 32 MB read/decode on a polled endpoint is the main latency/GC risk at scale. | P2 | L | ☐ |
| 2.2 | **Cache the sorted merged-IP list** in `rangeSummary`/`summary`/`hostSummary` — today it re-sorts the whole IP map once per country (O(countries × IPs)). | Wasted CPU on the metrics poll path. | P2 | S | ☐ |
| 2.3 | **Split the ~1650-line `index.ts` monolith** into route modules, keeping the auth/security helpers together. | Maintainability; makes the security surface easier to audit. | P3 | L | ☐ |
| 2.4 | **UI de-duplication:** move `TrafficMap` → `components/`, formatters → `web/src/format.ts`, and extract the Top-IPs / status-codes / by-country panels that `HostAnalytics.tsx` currently imports from the Logs *page*. | Pure UI refactor; removes a page→component import smell. | P3 | M | ☐ |

## 3. Parked features (built or specced, awaiting a gate)

| # | Item | State | Pri | Status |
|---|------|-------|-----|--------|
| 3.1 | **Update button + one-click self-update.** Full implementation on local branch `backlog/self-update-button` (release checker every 6h, admin UI + modal, opt-in Docker-socket self-update with auto-rollback). | Everything verified live **except** the container swap (no Docker on the dev box). Needs **one supervised test on real Docker** (QNAP) before shipping. Resume by merging the branch — don't rewrite. | P1 | ⏸ |
| 3.2 | **Per-FQDN DNS-01 base-domain derivation** (public-suffix-aware) so DNS-01 + wildcard issuance works across multiple base domains without settings juggling. Touch: `certs.ts`, `dns.ts`. | Specced; small, high-value, low-risk. | P2 | ☐ |
| 3.3 | **Multi-realm login gate (per-base-domain SSO).** Per-host login URL + cookie domain so a login-gated service on a *second* base domain doesn't hit a redirect loop. Touch: `index.ts` (`authCookieDomain`), `nginx.ts`, settings, Settings UI. | Specced; bigger. True cross-domain SSO is impossible via cookies — goal is only to stop the loop. | P3 | ☐ |

## 4. New feature proposals (from this review)

Fresh ideas surfaced while reviewing. Not committed — here to triage.

| # | Idea | Value | Pri | Effort |
|---|------|-------|-----|--------|
| 4.1 | **Config diff preview before apply.** Show the nginx-config diff (and `nginx -t` result) in the UI *before* writing/reloading, with a confirm step. | Turns "edit and pray" into "see exactly what changes." Big trust/safety win for the core workflow. | P1 | M |
| 4.2 | **Backup & restore bundle.** One-click encrypted export/import of hosts + settings + bans + channels (certs optional). | Disaster recovery + easy migration between boxes; today there's no portable snapshot. | P1 | M |
| 4.3 | **HTTP(S) health checks** (not just TCP): expected status, path, and interval per service — complements the new uptime-debounce logic. | TCP-connect says "port open," not "app healthy." | P2 | M |
| 4.4 | **Security profiles / rate-limit presets.** Named, reusable bundles (headers + rate limit + geo + exploit-block) applied across services. | Consistency + far fewer per-host mistakes. | P2 | M |
| 4.5 | **Bulk actions** on the Services list: enable/disable/maintenance/apply-profile to multiple hosts at once. | Operational speed once you run more than a handful of services. | P2 | S |
| 4.6 | **SIEM / audit-log webhook.** Stream the security event log to an external collector (syslog/HTTP), reusing the notification-channel plumbing. | Real deployments want events off-box for retention + correlation. | P2 | S |
| 4.7 | **Alert routing by severity.** Route `danger` → PagerDuty/phone, `info` → Slack, per channel. Pairs with the new alert coalescing. | The coalescing stopped the flood; routing makes what's left actionable. | P3 | S |
| 4.8 | **Import from existing nginx.conf.** Parse a user's current config and pre-fill hosts on first run. | Removes the biggest adoption barrier for people already running nginx. | P3 | L |
| 4.9 | **Enforce-2FA policy** for admin/editor roles (org setting). | Hardening for multi-user instances. | P2 | S |
| 4.10 | **Geo-block analytics.** Surface blocked-country / banned-IP attempts on the dashboard map. | Makes the security features visible + tunable. | P3 | M |

---

_Last triaged: 2026-07-11, after the full-application adversarial review + regression-suite expansion (133 → 165 tests, 71.9% line coverage)._
