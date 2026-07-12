// Alert-channel module (src/notify.ts): which events are worth alerting on, and
// that channel secrets are redacted before they can ever leave the server. The
// outbound delivery (fetch/SMTP) is deliberately NOT exercised here - these pin
// the pure decision + redaction logic that gates it. (Coverage gap - audit.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const { isAlertWorthy, createChannel, listChannels, setChannelRouting } = await import("../src/notify.ts");

// -------------------------------------------------------------------------
// 1. isAlertWorthy - the alert-severity gate.
// -------------------------------------------------------------------------
test("isAlertWorthy: warn/danger always alert (unless excluded by type)", () => {
  assert.equal(isAlertWorthy("service.upstream_down", "danger"), true);
  assert.equal(isAlertWorthy("security.ip_banned", "warn"), true);
  assert.equal(isAlertWorthy("cert.error", "warn"), true);
});

test("isAlertWorthy: high-volume/no-signal event types are always excluded", () => {
  // These fire constantly (every agent tool call, every successful login, every
  // host CRUD) and would drown out real alerts.
  assert.equal(isAlertWorthy("agent.tool_called", "warn"), false, "agent tool calls must never alert");
  assert.equal(isAlertWorthy("login.success", "info"), false, "successful logins must never alert");
  assert.equal(isAlertWorthy("host.updated", "danger"), false, "host CRUD must never alert even at danger severity");
});

test("isAlertWorthy: info-severity alerts only for the whitelisted prefixes", () => {
  assert.equal(isAlertWorthy("cert.issued", "info"), true, "cert.* is alert-worthy");
  assert.equal(isAlertWorthy("service.recovered", "info"), true, "service.* is alert-worthy");
  assert.equal(isAlertWorthy("security.audit", "info"), true, "security.* is alert-worthy");
  assert.equal(isAlertWorthy("agent.approval", "info"), true, "agent.approval is alert-worthy");
  // An info event outside the whitelist should stay quiet.
  assert.equal(isAlertWorthy("user.created", "info"), false, "an unlisted info event must not alert");
});

// -------------------------------------------------------------------------
// 2. maskConfig - channel secret redaction (exercised via the real API surface
//    createChannel/listChannels, which both return masked config). PINNED
//    INVARIANT: a secret value must never be returned to a client in full.
// -------------------------------------------------------------------------
test("createChannel + listChannels redact secret-bearing keys, never returning them whole", () => {
  const secret = "supersecrettoken1234567890";
  const created = createChannel({ type: "gotify", name: "ops", config: { server: "https://push.example.com", token: secret } });

  // The value returned to the caller must be masked, never the raw secret.
  assert.notEqual(created.config.token, secret, "token must not be returned in full");
  assert.ok(created.config.token.includes("•"), "token must be bullet-masked");
  assert.ok(!created.config.token.includes(secret.slice(6)), "the tail of the secret must not leak");

  const listed = listChannels().find((c) => c.id === created.id);
  assert.ok(listed, "the channel should be listed back");
  assert.notEqual(listed.config.token, secret, "listChannels must also mask the token");
});

test("maskConfig keeps non-secret fields readable (partial mask on semi-sensitive)", () => {
  const created = createChannel({
    type: "email",
    name: "mail",
    config: { host: "smtp.example.com", port: "587", user: "alerts@example.com", pass: "hunter2hunter2" },
  });
  // Non-secret operational fields stay legible.
  assert.equal(created.config.host, "smtp.example.com", "host is not a secret - shown in full");
  assert.equal(created.config.port, "587", "port is not a secret - shown in full");
  // The password is a secret and must be masked.
  assert.notEqual(created.config.pass, "hunter2hunter2", "pass must be masked");
  assert.ok(created.config.pass.includes("•"), "pass must be bullet-masked");
});

// -------------------------------------------------------------------------
// 3. Per-channel severity routing (backlog 4.7): a channel stores a severity
//    floor; the alert engine skips events below it (unit-tested in severity.test).
// -------------------------------------------------------------------------
test("createChannel defaults minSeverity to 'info' and persists an explicit floor", () => {
  const def = createChannel({ type: "slack", name: "all", config: { url: "https://hooks.slack.com/x" } });
  assert.equal(def.minSeverity, "info", "default floor is info (backward-compatible: all severities)");

  const pager = createChannel({ type: "webhook", name: "pager", config: { url: "https://pager.example.com/x" }, minSeverity: "danger" });
  assert.equal(pager.minSeverity, "danger", "an explicit floor is stored");
  // It survives a re-list.
  const listed = listChannels().find((c) => c.id === pager.id);
  assert.equal(listed?.minSeverity, "danger");
});

test("setChannelRouting edits events + severity floor, leaving unspecified fields intact", () => {
  const ch = createChannel({ type: "discord", name: "route", config: { url: "https://discord.example.com/x" }, events: ["*"], minSeverity: "info" });
  const updated = setChannelRouting(ch.id, { minSeverity: "warn" });
  assert.equal(updated?.minSeverity, "warn", "floor updated");
  assert.deepEqual(updated?.events, ["*"], "events left intact when only the floor changes");

  const routed = setChannelRouting(ch.id, { events: ["security.ip_banned", "service.upstream_down"] });
  assert.deepEqual(routed?.events, ["security.ip_banned", "service.upstream_down"], "events updated");
  assert.equal(routed?.minSeverity, "warn", "floor left intact when only events change");

  assert.equal(setChannelRouting("no-such-channel", { minSeverity: "info" }), null, "unknown id -> null");
});
