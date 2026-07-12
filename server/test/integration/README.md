# Data-plane integration tests

These tests run **real nginx** in front of real echo upstreams, feed it the app's own
generated config, and drive live HTTP requests through the whole chain to prove NginUX's
core promise: **no under-authenticated request ever reaches a gated backend.**

```
curl → nginx (auth_request) → control plane /api/auth/forward → allow / deny
              │  allow → proxy_pass → echo upstream (stamps UPSTREAM_OK)
              └─ deny  → 401 / 403 / 302-to-login, upstream NEVER reached
```

Unit tests (`test/*.test.ts`) drive the Fastify app via `app.inject()` and check the
`/api/auth/forward` handler in isolation. They cannot prove that **nginx, with the config
we actually ship, enforces the gate the way we think** — that the `auth_request` wiring,
`error_page 401 → login`, per-server `if ($nginux_banned)`, and path-route siblings all
behave correctly against a running server. That gap is exactly where the "unauthenticated
request reaches a service" bug class has recurred. These tests close it.

## Why `*.itest.ts`, not `*.test.ts`

The default `npm test` glob is `test/**/*.test.ts`, so these files (`*.itest.ts`) are **not**
part of the normal suite — they need a real nginx binary and bind real ports. They run via
a separate target:

```bash
npm run test:integration --workspace server
```

## Running locally

The suite **skips cleanly** (no-op) unless it can find an nginx binary. Point it at one:

```bash
# any nginx with the http_auth_request module (all mainline builds have it)
NGINUX_NGINX_BIN=/path/to/nginx npm run test:integration --workspace server
```

- **Linux/macOS:** `apt-get install nginx-full` / `brew install nginx`, then set
  `NGINUX_NGINX_BIN=/usr/sbin/nginx` (or `nginx` if it's on `PATH`).
- **Windows:** download the [nginx.org Windows build](https://nginx.org/en/download.html)
  and point `NGINUX_NGINX_BIN` at `nginx.exe`.

No nginx? The suite prints a skip notice and exits green, so `test:integration` is safe to
run anywhere.

## How the harness stays faithful

- It generates config with the app's **real** `buildDesiredConfigs()` /
  `writeGeoipConf()` / `writeBannedConf()` — the exact server blocks NginUX ships, not a
  hand-authored approximation.
- The **only** transform applied is remapping the privileged `listen 80` down to a high
  port so nginx binds unprivileged on any runner. No `auth_request`, `proxy_pass`,
  `server_name`, or `if ($nginux_banned)` directive is touched.
- It never calls `applyConfig()` (which would shell out to nginx and could clobber the
  remap) — only the pure config writers, plus its own top-level wrapper that mirrors
  `docker/nginx.conf`'s `http{}` contract with harness-local paths.

## What's covered

19 core invariants: unauth denied (C1), valid session allowed (C2), per-host 2FA (C3/C4),
scoped access (C5/C6) and its **`X-Forwarded-Host` spoof defence (C6b)**, the
**case-insensitive (C7) and wildcard (C8) host recurrence**, unknown-host fail-closed (C9),
**wrong/absent forward-secret rejection (C9b)**, default-credential confinement (C10), org
2FA policy (C11), **ban-beats-`ipAllow` ordering (C12)**, gated path routes (C13), the gate
**inside a real `listen 443 ssl` block (C14)**, the ssl host's **`:80` redirect that must
301 without proxying (C15)**, plus a non-gated `sanity` control and a hard-required-nginx
guard (see below).

Three further hardening items — once deferred, now **implemented and proven** here:
**A1** the `nginux_session` cookie is stripped before proxy_pass (other cookies survive),
**A2** L4/TCP stream proxies enforce IP bans (ngx_stream_access, capability-gated on the
runner having a usable `stream{}` module), and **A3** a `customNginx add_header` no longer
shadows the managed security headers.

The suite is proven non-vacuous: reverting the fail-closed host check reddens C8+C9;
reverting the case-insensitive lookup reddens C7; and each of A1/A2/A3 reddens if its fix
is reverted.

## CI

Runs on `ubuntu-latest` in both `ci.yml` (PRs / non-main pushes) and `release.yml`'s
`verify` gate (so a push to `main` cannot ship to GHCR unless the data-plane boundary
holds). Both install `nginx-full` and run `test:integration` with
`NGINUX_NGINX_BIN=/usr/sbin/nginx` **and `NGINUX_REQUIRE_NGINX=1`** — the latter turns a
missing/broken nginx into a hard failure instead of a silent skip, so this security suite
can never quietly no-op to green in CI.
