// Auth core: scrypt password hashing/verify, session issue+resolve, and the
// shared scopedAllows RBAC predicate. These are the crypto + session + scope
// invariants a regression here must never silently break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

setupTestEnv();
const auth = await import("../src/auth.ts");
const { db } = await import("../src/db.ts");

// scopedAllows only reads `.scope`; a minimal object cast to the param type is
// enough to exercise it without dragging in the rest of the User shape.
type UserArg = Parameters<typeof auth.scopedAllows>[0];
const scopedUser = (scope: string) => ({ role: "scoped", scope } as unknown as UserArg);

// ---------- 1. password hashing (scrypt) ----------

test("hashPassword produces a scrypt-tagged hash that verifies the correct password", async () => {
  const stored = await auth.hashPassword("hunter2");
  assert.match(stored, /^scrypt\$/, "stored hash should carry the scrypt tag + params");
  assert.equal(await auth.verifyPassword("hunter2", stored), true);
});

test("verifyPassword rejects the wrong password", async () => {
  const stored = await auth.hashPassword("hunter2");
  assert.equal(await auth.verifyPassword("hunter3", stored), false);
  assert.equal(await auth.verifyPassword("", stored), false);
});

test("two hashes of the SAME password are different strings (per-hash salt)", async () => {
  const a = await auth.hashPassword("same-password");
  const b = await auth.hashPassword("same-password");
  assert.notEqual(a, b, "salted hashing must not be deterministic");
  // ...yet both must still verify the original password.
  assert.equal(await auth.verifyPassword("same-password", a), true);
  assert.equal(await auth.verifyPassword("same-password", b), true);
});

test("verifyPassword rejects malformed / non-scrypt stored values instead of throwing", async () => {
  for (const junk of ["", "not-a-hash", "bcrypt$1$abc", "scrypt$$$$$", "scrypt$0$0$0$aa$bb"]) {
    assert.equal(await auth.verifyPassword("whatever", junk), false, `junk should not verify: ${JSON.stringify(junk)}`);
  }
});

// ---------- 2. sessions ----------

test("createSession issues a token that userForSession resolves back to the user", async () => {
  const user = await auth.createUser({ username: "sess_alice", password: "pw-alice", role: "admin" });
  const token = auth.createSession(user.id, "dev", "127.0.0.1");
  assert.match(token, /^[0-9a-f]{64}$/, "session token should be 32 random bytes as hex");

  const resolved = auth.userForSession(token);
  assert.ok(resolved, "a valid token must resolve to a user");
  assert.equal(resolved.id, user.id);
  assert.equal(resolved.username, "sess_alice");
});

test("userForSession returns null for a bogus token and for undefined", () => {
  assert.equal(auth.userForSession("bogus-token"), null);
  assert.equal(auth.userForSession(undefined), null);
});

test("destroySession invalidates a token immediately", async () => {
  const user = await auth.createUser({ username: "sess_bob", password: "pw-bob" });
  const token = auth.createSession(user.id, "dev", "127.0.0.1");
  assert.ok(auth.userForSession(token), "sanity: token resolves before destroy");
  auth.destroySession(token);
  assert.equal(auth.userForSession(token), null, "destroyed token must not resolve");
});

test("userForSession rejects (and reaps) an expired session", async () => {
  const user = await auth.createUser({ username: "sess_carol", password: "pw-carol" });
  const token = "expired0".repeat(8); // deterministic 64-char token
  const past = new Date(Date.now() - 60_000).toISOString();
  db.prepare("INSERT INTO sessions (token, userId, device, ip, createdAt, expiresAt) VALUES (?,?,?,?,?,?)")
    .run(token, user.id, "dev", "127.0.0.1", past, past);
  assert.equal(auth.userForSession(token), null, "an already-expired session must not resolve");
  // ...and it should have been reaped on read.
  const still = db.prepare("SELECT token FROM sessions WHERE token = ?").get(token);
  assert.equal(still, undefined, "expired session should be deleted on access");
});

test("destroyUserSessions clears every session for a user", async () => {
  const user = await auth.createUser({ username: "sess_dave", password: "pw-dave" });
  const t1 = auth.createSession(user.id, "phone", "127.0.0.1");
  const t2 = auth.createSession(user.id, "laptop", "127.0.0.2");
  auth.destroyUserSessions(user.id);
  assert.equal(auth.userForSession(t1), null);
  assert.equal(auth.userForSession(t2), null);
});

// ---------- 3. scopedAllows (shared RBAC predicate) ----------

test("scopedAllows: id match", () => {
  assert.equal(
    auth.scopedAllows(scopedUser("plex, media"), { id: "plex", name: "Plex", domain: "plex.x.com" }),
    true,
  );
});

test("scopedAllows: name match is case-insensitive", () => {
  assert.equal(
    auth.scopedAllows(scopedUser("plex, media"), { id: "x", name: "Media", domain: "m.x.com" }),
    true,
  );
});

test("scopedAllows: domain match is case-insensitive", () => {
  assert.equal(
    auth.scopedAllows(scopedUser("plex.x.com"), { id: "x", name: "Whatever", domain: "PLEX.X.COM" }),
    true,
  );
});

test("scopedAllows: host outside the scope is denied", () => {
  assert.equal(
    auth.scopedAllows(scopedUser("plex, media"), { id: "grafana", name: "Grafana", domain: "g.x.com" }),
    false,
  );
});

test("scopedAllows: empty scope denies every host", () => {
  for (const scope of ["", "   ", " , , "]) {
    assert.equal(
      auth.scopedAllows(scopedUser(scope), { id: "plex", name: "Plex", domain: "plex.x.com" }),
      false,
      `empty/blank scope ${JSON.stringify(scope)} must deny`,
    );
  }
});

// ---------- bonus: user store + credential check round-trips ----------

test("createUser + getUserById round-trip stores role and scope", async () => {
  const created = await auth.createUser({ username: "store_eve", email: "eve@home", password: "pw-eve", role: "scoped", scope: "plex" });
  const fetched = auth.getUserById(created.id);
  assert.ok(fetched);
  assert.equal(fetched.username, "store_eve");
  assert.equal(fetched.email, "eve@home");
  assert.equal(fetched.role, "scoped");
  assert.equal(fetched.scope, "plex");
  assert.equal(auth.getUserById("no-such-id"), null);
});

test("checkCredentials returns the row for the right password and null otherwise", async () => {
  await auth.createUser({ username: "cred_frank", password: "correct-horse" });
  const ok = await auth.checkCredentials("cred_frank", "correct-horse");
  assert.ok(ok, "correct credentials should return the user row");
  assert.equal(String(ok.username), "cred_frank");
  assert.equal(await auth.checkCredentials("cred_frank", "wrong-password"), null);
  assert.equal(await auth.checkCredentials("nobody-unknown", "whatever"), null);
});

// ---------- 4. 2FA backup codes (single-use consumption) ----------
// PINNED SECURITY INVARIANT: a backup code is a one-time skeleton key. It must
// verify exactly once, then be burned so a captured/reused code can't sign in
// again. (Coverage gap - audit finding.)

test("useBackupCode accepts a real code exactly once, then rejects the reuse", async () => {
  const user = await auth.createUser({ username: "bk_alice", password: "pw" });
  const codes = auth.enableTwofa(user.id);
  assert.equal(codes.length, 8, "enableTwofa should mint 8 codes");

  assert.equal(auth.useBackupCode(user.id, codes[0]), true, "a valid code must be accepted once");
  assert.equal(auth.useBackupCode(user.id, codes[0]), false, "the SAME code must not work a second time");
  // A different, still-unused code must still work (only the spent one is burned).
  assert.equal(auth.useBackupCode(user.id, codes[1]), true, "an unused sibling code must still verify");
});

test("useBackupCode rejects an unknown code, whitespace tolerance aside, and an unknown user", async () => {
  const user = await auth.createUser({ username: "bk_bob", password: "pw" });
  const codes = auth.enableTwofa(user.id);
  assert.equal(auth.useBackupCode(user.id, "deadbeefdeadbeefdead"), false, "a code that was never issued must fail");
  assert.equal(auth.useBackupCode("no-such-user", codes[0]), false, "an unknown user must fail, not throw");
  // Surrounding whitespace is trimmed (users paste codes with stray spaces).
  assert.equal(auth.useBackupCode(user.id, `  ${codes[0]}  `), true, "a valid code with stray whitespace must still verify");
  assert.equal(auth.useBackupCode(user.id, codes[0]), false, "…and that trimmed code is now burned");
});

test("useBackupCode returns false when 2FA was never enabled (no codes stored)", async () => {
  const user = await auth.createUser({ username: "bk_carol", password: "pw" });
  assert.equal(auth.useBackupCode(user.id, "anything-at-all-1234"), false, "no stored codes -> always false");
});

// ---------- 5. TOTP replay guard (monotonic counter) ----------
// PINNED SECURITY INVARIANT: once a TOTP time-step is consumed it must never be
// accepted again, even across a restart (persisted). The counter only moves
// forward, so a captured code from an already-used step is rejected. (Coverage gap.)

test("TOTP counter starts at -1 and only ever advances forward", async () => {
  const user = await auth.createUser({ username: "totp_dave", password: "pw" });
  assert.equal(auth.getLastTotpCounter(user.id), -1, "a fresh user has consumed no step");

  auth.setLastTotpCounter(user.id, 100);
  assert.equal(auth.getLastTotpCounter(user.id), 100, "consuming step 100 must persist");

  // Replay of an OLDER (or equal) step must not move the watermark backward.
  auth.setLastTotpCounter(user.id, 50);
  assert.equal(auth.getLastTotpCounter(user.id), 100, "a lower step must not roll the counter back (replay guard)");
  auth.setLastTotpCounter(user.id, 100);
  assert.equal(auth.getLastTotpCounter(user.id), 100, "re-consuming the same step is a no-op");

  auth.setLastTotpCounter(user.id, 101);
  assert.equal(auth.getLastTotpCounter(user.id), 101, "the next fresh step advances the watermark");
});

test("getLastTotpCounter returns -1 for an unknown user", () => {
  assert.equal(auth.getLastTotpCounter("nobody"), -1);
});
