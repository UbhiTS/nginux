# NginUX Backlog

Triage tracker for work that isn't in the current change. Each item has a
**priority** (P0 critical → P3 nice-to-have), rough **effort** (S ≤ half day ·
M ≤ 2 days · L larger), and **status**.

> Security and correctness are triaged above features. When you pick one up, move
> it to a PR and check it off. **Shipped items live in the Archive at the bottom.**

Legend: ☐ not started · ◐ in progress · ☑ done · ⏸ parked (built, awaiting a gate)

---

## Active

Everything else has shipped (see the Archive). What's left is one external-infra
gate and a short list of deliberately-deferred follow-ups from the shipped work.

### Gated on external infra

| # | Item | State | Pri |
|---|------|-------|-----|
| 3.1 | **One-click self-update — container-swap test.** The feature shipped (v0.1.2): release checker, admin UI + modal, opt-in Docker-socket self-update with auto-rollback; release detection + UI are verified live and unit-tested. The **container swap itself still needs one supervised test on real Docker** (the QNAP) — it can't run on the Windows dev box. Dormant unless the Docker socket is mounted **and** an admin triggers it, so shipping it is safe. | ⏸ ships dormant; swap unverified | P1 |

### Follow-ups from shipped work (optional, low priority)

F1–F3 shipped in **v0.2.2** (see the Archive). What remains is one infra-gated
verification and the parking lot.

| # | Item | Why it's deferred | Pri | Effort |
|---|------|-------------------|-----|--------|
| F4 | **Live multi-domain verification** of §3.2 (DNS-01 across base domains) and §3.3 (second-domain login-loop fix). | The logic is unit-tested; the real round-trip needs two domains + DNS/TLS (the QNAP deployment). | P3 | S |
| F5 | **New-idea parking lot** — surface future proposals here as they come up. | — | — | — |

---

## Archive — shipped

### v0.2.2 (2026-07-12) — v0.2.0 follow-ups (F1–F3)

Released; regression suite holds at 248 tests. Pure hardening/refactor — no
behaviour change, verified by tsc + tests + an in-browser pass over both
analytics consumers.

| # | Item | Shipped as |
|---|------|-----------|
| F1 | Rolling byte-offset index for the access log | `metrics.ts` `ringCoversWindow` fast-path: `hostSummary` skips the disk read entirely when the in-memory ring already covers the requested window (the reverse reader's early-break already obviated a byte-seek) |
| F2 | Finish the `index.ts` route split | four more groups extracted to `routes/*` (update / security / agents / certs) + centralized `registerXRoutes` block; `index.ts` 1683 → 1490 lines. The genuinely-coupled core (hosts/auth/metrics/topology/config/MCP/SSE) stays inline by design |
| F3 | Extract the 3 shared analytics panels | `components/AnalyticsPanels.tsx` (`StatusCodeBars` / `TopSourceIps` / `CountryBars`), shared verbatim by `Logs` + `HostAnalytics`; −81 lines across the two pages |

### v0.2.0 (2026-07-12) — the whole backlog batch

Released; regression suite 193 → 247 tests. See `RELEASE_NOTES.md` for the
user-facing summary.

| # | Item | Shipped as |
|---|------|-----------|
| 1.5 | MCP `prompts` capability | `prompts.ts`; `prompts/get` implemented (was -32601 despite advertising it) |
| 1.6 | Widen `update_settings` allowlist safely | shared `settingsschema.ts`; agent path validates through the same schema |
| 2.1 | Async access-log reader | `logtail.ts` reverse streaming reader; `searchLog`/`hostSummary` no longer block on a 32 MB sync read (offset index deferred → F1) |
| 2.2 | Cache the sorted merged-IP list | single-pass `groupTopIpsByCountry` (was O(countries × IPs)) |
| 2.3 | Split the `index.ts` monolith | `routes/*` (geoip/tokens/profiles/webhooks/channels) + shared `RouteCtx`; core left central (→ F2) |
| 2.4 | UI de-duplication | `TrafficMap` + formatters → shared modules; killed the page→component import smell (panels → F3) |
| 3.2 | Per-FQDN DNS-01 base-domain derivation | `registrable.ts`; the ACME zone is derived per FQDN (live test → F4) |
| 3.3 | Multi-realm login gate | `realms.ts` + `ssoRealms`: per-base-domain cookie + login redirect (live test → F4) |
| 4.2 | Backup & restore bundle | `cryptobox.ts` + `backup.ts`; passphrase-encrypted portable bundle (also closed a secret-leak in the old export) |
| 4.3 | HTTP(S) health checks | host health-check columns + `uptime.ts` `httpProbe` |
| 4.4 | Security profiles | `security_profiles` table + `profiles.ts` + apply-to-many |
| 4.5 | Bulk actions | `POST /api/hosts/batch`, one reload for the batch |
| 4.6 | SIEM / audit-log webhook | `syslog.ts` sink (`syslog://`) on the existing HMAC HTTP webhooks |
| 4.7 | Alert routing by severity | per-channel `minSeverity` floor (`severity.ts`) |
| 4.8 | Import from nginx.conf | preview-then-confirm + websocket detection |
| 4.9 | Enforce-2FA policy | `require2faForManagers` + the `Enable2fa` gate |
| 4.10 | Geo-block analytics | `blockedAttempts()` by country/IP in the Security Center |
| — | Additive-migration helper | `addColumnIfMissing`/`runMigrations` in `db.ts` (schema had no ALTER path) |
| — | Version-driven releases | `release.yml` honors `version.ts` when it's ahead of the latest tag |

### v0.1.2 (2026-07-11) — adversarial review + first features

| # | Item | Shipped as |
|---|------|-----------|
| 1.1 | Share host-write validation (REST ↔ agent) | `hostschema.ts`; agent path validates via `hostInput.partial()` |
| 1.2 | De-dup the control-plane hijack guard | one `isControlPlaneDomain` in `hostschema.ts` |
| 1.3 | Share the per-line injection-sink validators | shared predicates in `hostschema.ts` |
| 1.4 | Unify the `splitList`/`splitLines` utilities | canonical `splitLines`/`splitEntries` in `validate.ts` |
| 4.1 | Config-diff preview before apply | "Preview changes" dry-runs the colour-coded nginx diff |
| 3.1 | Update button + one-click self-update | merged; ships dormant (swap test → **Active §3.1**) |
| — | 15 security/logic fixes + 32 tests | from the full adversarial review (133 → 193 tests) |

---

_Last triaged: 2026-07-12. Backlog fully implemented and released as v0.2.0. Active
work is the §3.1 Docker-swap test and the F1–F4 follow-ups (all low priority)._
