# NginUX v0.1.18

A security release from a full adversarial audit of every surface. Two high-severity
issues (both privilege-escalation paths for a non-admin manager/agent) and several
lower-severity hardenings. **Upgrade is recommended for anyone running a multi-host or
agent-enabled deployment.**

## Fixed

### High — session-cookie exfiltration via a load-balanced control-plane host

A non-admin *editor* could create a host that pointed its primary target at NginUX's own
control plane (which legitimately keeps the session cookie) while ALSO listing an extra
load-balancer upstream. The extra target joined the round-robin pool and received the
forwarded `nginux_session` cookie, allowing capture of another user's (including an
admin's) session. The cookie strip is now suppressed only when the entire effective
upstream set is the control plane; any extra load-balancer target is dropped for a
control-plane host, so a session cookie can never reach an unintended backend.

### High — agent `create_service` bypassed the forbidden-field guard

The MCP/agent `create_service` tool spread its raw arguments into the new host, so a
`control`-scope (non-admin) agent token could smuggle fields the schema doesn't
declare — raw `customNginx` directives, `blockExploits: false`, IP allow/deny, transport
downgrades — none of which the agent path is allowed to set (`update_service` already
stripped them). Tool arguments not declared in a tool's input schema are now rejected
outright, closing this for `create_service` and any future tool.

### Medium — scoped users could change transport/preset fields

The scoped-user REST guard didn't list `protocol`, `listenPort`, and `preset`, so a
scoped user could flip a login-gated HTTP host into an un-gated TCP/UDP stream or change
its preset. These now mirror the agent path's forbidden set.

### Medium — unbounded per-host metrics memory

The per-host traffic counters were keyed on the (attacker-controllable) `Host` header
with no cardinality cap, so a flood of distinct Host values could grow memory without
bound. They now evict the coldest keys at the same limit as the other counters.

### Hardening

- Imported `nginx.conf` hosts are now validated through the same schema as the API
  (rejects out-of-range values before they can break a config apply).
- The image no longer bundles tests or matches secret/env file patterns.
- The CI boot smoke-test runs under the production capability set + `no-new-privileges`.

- Patched high-severity transitive advisories (brace-expansion, fast-uri — a Fastify
  runtime dependency — nanoid, undici) via compatible version bumps.

Dependency audit: **0 known vulnerabilities**.
