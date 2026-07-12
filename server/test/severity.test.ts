// Severity ordering (server/src/severity.ts) - the basis of per-channel alert routing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { severityRank, meetsSeverity, SEVERITY_ORDER } from "../src/severity.ts";

test("severityRank orders info < notice < warn < danger", () => {
  assert.deepEqual(SEVERITY_ORDER, ["info", "notice", "warn", "danger"]);
  assert.ok(severityRank("info") < severityRank("notice"));
  assert.ok(severityRank("notice") < severityRank("warn"));
  assert.ok(severityRank("warn") < severityRank("danger"));
});

test("severityRank treats unknown/undefined as info (0) so it never over-suppresses", () => {
  assert.equal(severityRank(undefined), 0);
  assert.equal(severityRank("bogus"), 0);
  assert.equal(severityRank(""), 0);
});

test("meetsSeverity: a danger-floor channel ignores lower severities; an info floor lets all through", () => {
  // Floor = danger: only danger clears it.
  assert.equal(meetsSeverity("danger", "danger"), true);
  assert.equal(meetsSeverity("warn", "danger"), false);
  assert.equal(meetsSeverity("info", "danger"), false);
  // Floor = warn: warn + danger clear it.
  assert.equal(meetsSeverity("warn", "warn"), true);
  assert.equal(meetsSeverity("danger", "warn"), true);
  assert.equal(meetsSeverity("notice", "warn"), false);
  // Floor = info (default): everything clears it (backward-compatible).
  for (const s of SEVERITY_ORDER) assert.equal(meetsSeverity(s, "info"), true, `${s} clears an info floor`);
  // An unknown floor behaves like info (no over-suppression).
  assert.equal(meetsSeverity("info", "bogus"), true);
});
