// Config-diff preview engine (server/src/nginx.ts): the pure line-diff and the
// "what would this host change produce vs. what's live" preview that powers the
// UI's before-apply confirmation. No nginx binary or network involved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv, makeHost } from "./helpers.ts";

setupTestEnv();
const { unifiedLineDiff, previewConfigForHosts, writeAllConfigs, buildDesiredConfigs, readManagedConfigs } =
  await import("../src/nginx.ts");
const { createHost, listHosts } = await import("../src/repo.ts");

// -------------------------------------------------------------------------
// 1. unifiedLineDiff - the pure LCS line diff.
// -------------------------------------------------------------------------
test("unifiedLineDiff: identical input has no additions or deletions", () => {
  const d = unifiedLineDiff("a\nb\nc\n", "a\nb\nc\n");
  assert.equal(d.additions, 0);
  assert.equal(d.deletions, 0);
  assert.ok(!/^[+-]/m.test(d.text), "no +/- lines for identical input");
});

test("unifiedLineDiff: pure addition and pure removal are counted", () => {
  const add = unifiedLineDiff("", "x\ny");
  assert.deepEqual([add.additions, add.deletions], [2, 0]);
  const del = unifiedLineDiff("x\ny", "");
  assert.deepEqual([del.additions, del.deletions], [0, 2]);
});

test("unifiedLineDiff: a single changed line is one add + one delete, context preserved", () => {
  const d = unifiedLineDiff("a\nb\nc", "a\nX\nc");
  assert.equal(d.additions, 1);
  assert.equal(d.deletions, 1);
  assert.ok(d.text.includes("- b"), "old line marked removed");
  assert.ok(d.text.includes("+ X"), "new line marked added");
  assert.ok(d.text.includes("  a") && d.text.includes("  c"), "unchanged lines kept as context");
});

// -------------------------------------------------------------------------
// 2. previewConfigForHosts - diff a proposed host set vs. what's on disk.
// -------------------------------------------------------------------------
test("previewConfigForHosts reports NO change when the host set matches what's live", () => {
  createHost(makeHost({ name: "plex", domain: "plex.example.com" }));
  writeAllConfigs(); // make disk match the DB
  const preview = previewConfigForHosts(listHosts());
  assert.equal(preview.changed, false, "no diff when desired == live");
  assert.equal(preview.files.length, 0);
});

test("previewConfigForHosts flags an ADDED file for a brand-new host", () => {
  writeAllConfigs();
  const candidate = makeHost({ id: "cand", name: "grafana", domain: "grafana-new.example.com" });
  const preview = previewConfigForHosts([...listHosts(), candidate]);
  const added = preview.files.find((f) => f.name === "grafana-new.example.com.conf");
  assert.ok(added, "the new host's config file must show up");
  assert.equal(added.status, "added");
  assert.ok(added.additions > 0 && added.deletions === 0, "an added file is all additions");
});

test("previewConfigForHosts flags a MODIFIED file when a host's options change", () => {
  const host = createHost(makeHost({ name: "modme", domain: "modme.example.com", requireLogin: false }));
  writeAllConfigs();
  // Toggle a setting that materially changes the generated config.
  const changed = listHosts().map((h) => (h.id === host.id ? { ...h, requireLogin: true } : h));
  const preview = previewConfigForHosts(changed);
  const mod = preview.files.find((f) => f.name === "modme.example.com.conf");
  assert.ok(mod, "the edited host's file must appear in the diff");
  assert.equal(mod.status, "modified");
  assert.ok(mod.additions > 0, "turning on the login gate adds directives");
  assert.ok(mod.diff.includes("auth_request"), "the diff should show the new auth_request line");
});

test("previewConfigForHosts flags a REMOVED file when a host is dropped", () => {
  createHost(makeHost({ name: "goner", domain: "goner.example.com" }));
  writeAllConfigs();
  const remaining = listHosts().filter((h) => h.domain !== "goner.example.com");
  const preview = previewConfigForHosts(remaining);
  const removed = preview.files.find((f) => f.name === "goner.example.com.conf");
  assert.ok(removed, "the removed host's file must be reported");
  assert.equal(removed.status, "removed");
  assert.ok(removed.deletions > 0 && removed.additions === 0, "a removed file is all deletions");
});

// -------------------------------------------------------------------------
// 3. buildDesiredConfigs is the pure generator both writeAllConfigs and the
//    preview share (so a preview can never diverge from what apply writes).
// -------------------------------------------------------------------------
test("buildDesiredConfigs matches what writeAllConfigs persists to disk", () => {
  createHost(makeHost({ name: "parity", domain: "parity.example.com" }));
  writeAllConfigs();
  const desired = buildDesiredConfigs(listHosts());
  const live = readManagedConfigs();
  for (const [path, content] of desired) {
    assert.equal(live.get(path), content, `disk must match the generator for ${path}`);
  }
});
