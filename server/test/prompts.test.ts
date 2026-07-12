// MCP prompt catalog (server/src/prompts.ts): pure templates, no DB/network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROMPTS, promptCatalog, getPrompt } from "../src/prompts.ts";

test("every prompt builds a non-empty, well-formed user message", () => {
  for (const p of PROMPTS) {
    // Supply a placeholder for each required arg so build() runs.
    const args = Object.fromEntries(p.arguments.filter((a) => a.required).map((a) => [a.name, `test-${a.name}`]));
    const msgs = p.build(args);
    assert.ok(Array.isArray(msgs) && msgs.length > 0, `${p.name} builds messages`);
    for (const m of msgs) {
      assert.ok(m.role === "user" || m.role === "assistant", `${p.name} message has a valid role`);
      assert.equal(m.content.type, "text");
      assert.ok(m.content.text.trim().length > 0, `${p.name} message text is non-empty`);
    }
  }
});

test("promptCatalog advertises name + description + arguments for each prompt", () => {
  const cat = promptCatalog();
  assert.equal(cat.length, PROMPTS.length);
  for (const c of cat) {
    assert.ok(c.name && c.description);
    assert.ok(Array.isArray(c.arguments));
  }
});

test("getPrompt renders a known prompt and templates its arguments", () => {
  const r = getPrompt("expose_service", { service: "Immich", target: "192.168.1.50:2283" });
  assert.ok(r, "known prompt resolves");
  assert.ok(r.messages[0].content.text.includes("Immich"), "required arg is templated");
  assert.ok(r.messages[0].content.text.includes("192.168.1.50:2283"), "optional arg is templated");
});

test("getPrompt returns null for unknown names and throws on missing required args", () => {
  assert.equal(getPrompt("nope", {}), null);
  assert.throws(() => getPrompt("harden_host", {}), /host/i, "missing required arg names it");
  assert.doesNotThrow(() => getPrompt("weekly_security_review", {}), "no-arg prompt needs nothing");
});
