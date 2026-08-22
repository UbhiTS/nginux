// Self-update release detection (server/src/update.ts). The Docker container-swap
// is NOT exercisable here (no docker socket on the test runner), but the trigger -
// "is a newer release/build available?" - is pure decision logic and fully tested
// with a stubbed GitHub API. semverCompare + the recut-of-same-tag SHA path.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setupTestEnv } from "./helpers.ts";

// BUILD_SHA is captured at module load, so set it BEFORE importing update.ts.
process.env.NGINUX_BUILD_SHA = "abc1234";
process.env.NGINUX_UPDATE_API = "https://api.github.test/repos/x/y";
setupTestEnv();
const {
  attestationVerifyArgs,
  attestedImageRef,
  checkForUpdate,
  dockerPullTarget,
  releaseImage,
  releaseVersion,
  semverCompare,
  updateStatus,
} = await import("../src/update.ts");
const { VERSION } = await import("../src/version.ts"); // current version (0.1.x)

// ---- fetch stub: canned GitHub responses driven by per-test fixtures ----
const realFetch = globalThis.fetch;
let releaseTag = "";     // e.g. "v0.9.9"
const SAME_SHA = "abc1234fffffffffffffffffffffffffffffffff";
const OTHER_SHA = "9999deadbeefcafe000000000000000000000000";
let commitSha = SAME_SHA; // full sha returned by /commits/<tag>
let failWith: string | null = null;
globalThis.fetch = (async (url: string | URL) => {
  if (failWith) throw new Error(failWith);
  const u = String(url);
  const json = u.includes("/releases/latest")
    ? { tag_name: releaseTag, name: `Release ${releaseTag}`, body: "release notes here", html_url: "https://example/rel", published_at: "2026-07-01T00:00:00Z" }
    : u.includes("/commits/")
      ? { sha: commitSha }
      : {};
  return { ok: true, status: 200, json: async () => json } as unknown as Response;
}) as typeof fetch;
afterEach(() => { failWith = null; });
process.on("exit", () => { globalThis.fetch = realFetch; });

// ---------------------------------------------------------------------------
// 1. semverCompare - numeric per-segment ordering.
// ---------------------------------------------------------------------------
test("semverCompare orders versions numerically (not lexically) and tolerates a v prefix", () => {
  assert.ok(semverCompare("1.2.10", "1.2.9") > 0, "1.2.10 > 1.2.9 (numeric, not string)");
  assert.ok(semverCompare("v0.2.0", "0.1.9") > 0, "leading v is ignored");
  assert.ok(semverCompare("0.1.1", "0.1.1") === 0, "equal versions compare equal");
  assert.ok(semverCompare("0.1.0", "0.1.1") < 0, "older is less");
  assert.ok(semverCompare("1.0", "1.0.0") === 0, "missing segments count as 0");
});

test("release tags are canonical semver and select a version tag, never latest", () => {
  assert.equal(releaseVersion("v1.2.3"), "1.2.3");
  assert.equal(releaseImage("v1.2.3"), "ghcr.io/ubhits/nginux:v1.2.3");
  for (const invalid of ["1.2.3", "v01.2.3", "v1.2", "latest", "v1.2.3-rc.1"]) {
    assert.equal(releaseVersion(invalid), null, `${invalid} must be rejected`);
  }
  assert.throws(() => releaseImage("latest"), /invalid release tag/i);
});

test("attestedImageRef extracts one signed digest for only the NginUX image", () => {
  const digest = "ab".repeat(32);
  const verified = JSON.stringify([{
    verificationResult: {
      statement: { subject: [{ name: "ghcr.io/ubhits/nginux", digest: { sha256: digest } }] },
    },
  }]);
  assert.equal(attestedImageRef(verified), `ghcr.io/ubhits/nginux@sha256:${digest}`);
  assert.throws(() => attestedImageRef("not-json"), /malformed attestation/i);
  assert.throws(() => attestedImageRef(JSON.stringify([{
    verificationResult: {
      statement: { subject: [{ name: "ghcr.io/attacker/nginux", digest: { sha256: digest } }] },
    },
  }])), /exactly one NginUX image digest/i);
  assert.throws(() => attestedImageRef(JSON.stringify([{
    verificationResult: {
      statement: { subject: [
        { name: "ghcr.io/ubhits/nginux", digest: { sha256: digest } },
        { name: "ghcr.io/ubhits/nginux", digest: { sha256: "cd".repeat(32) } },
      ] },
    },
  }])), /exactly one NginUX image digest/i);
});

test("attestation verification pins repository, workflow, source SHA/ref, and OCI bundle", () => {
  const args = attestationVerifyArgs("v1.2.3", OTHER_SHA.toUpperCase());
  assert.deepEqual(args.slice(0, 3), ["attestation", "verify", "oci://ghcr.io/ubhits/nginux:v1.2.3"]);
  assert.ok(args.includes("UbhiTS/nginux"));
  assert.ok(args.includes("github.com/UbhiTS/nginux/.github/workflows/release.yml"));
  assert.ok(args.includes(OTHER_SHA));
  assert.ok(args.includes("refs/heads/main"));
  assert.ok(args.includes("--deny-self-hosted-runners"));
  assert.ok(args.includes("--bundle-from-oci"));
  assert.equal(args.some((arg) => arg.endsWith(":latest")), false);
  assert.throws(() => attestationVerifyArgs("v1.2.3", "deadbeef"), /full Git commit SHA/i);
});

test("Docker pull preserves an immutable digest instead of parsing it as a mutable tag", () => {
  const digest = "ab".repeat(32);
  assert.deepEqual(dockerPullTarget(`ghcr.io/ubhits/nginux@sha256:${digest}`), {
    image: "ghcr.io/ubhits/nginux",
    tag: `sha256:${digest}`,
  });
  assert.deepEqual(dockerPullTarget("ghcr.io/ubhits/nginux:v1.2.3"), {
    image: "ghcr.io/ubhits/nginux",
    tag: "v1.2.3",
  });
  assert.throws(() => dockerPullTarget("ghcr.io/ubhits/nginux"), /explicit tag or digest/i);
});

// ---------------------------------------------------------------------------
// 2. checkForUpdate - the "should we offer an update?" decision.
// ---------------------------------------------------------------------------
test("checkForUpdate: a higher release version is available", async () => {
  releaseTag = "v9.9.9";
  commitSha = OTHER_SHA;
  const s = await checkForUpdate();
  assert.equal(s.available, true, "a newer version must be offered");
  assert.equal(s.latestVersion, "9.9.9");
  assert.equal(s.latestTag, "v9.9.9");
  assert.equal(s.latestSha, OTHER_SHA, "every release tag is resolved to its full commit");
  assert.equal(s.releaseName, "Release v9.9.9");
  assert.ok(s.notes && s.notes.includes("release notes"), "release notes are surfaced");
  assert.equal(s.checkError, null);
});

test("checkForUpdate: an older/equal release with the SAME build is NOT available", async () => {
  releaseTag = "v0.0.1"; // definitely <= current
  commitSha = OTHER_SHA;
  const older = await checkForUpdate();
  assert.equal(older.available, false, "an older release must not be offered");

  releaseTag = `v${VERSION}`;         // same version number...
  commitSha = SAME_SHA;               // ...and the commit sha starts with our BUILD_SHA -> same build
  const same = await checkForUpdate();
  assert.equal(same.available, false, "same version + same build must not be offered");
});

test("checkForUpdate: a RECUT of the same tag (same version, different build sha) IS available", async () => {
  releaseTag = `v${VERSION}`;          // same version number...
  commitSha = OTHER_SHA;               // ...but a different commit sha -> rebuilt image
  const s = await checkForUpdate();
  assert.equal(s.available, true, "a recut (same tag, new build) must still be detected");
  assert.equal(s.latestSha, OTHER_SHA);
});

test("checkForUpdate rejects a non-semver release tag before resolving it", async () => {
  releaseTag = "latest";
  const s = await checkForUpdate();
  assert.match(s.checkError ?? "", /canonical semver/i);
});

test("checkForUpdate rejects a release tag without a full source commit", async () => {
  releaseTag = "v9.9.9";
  commitSha = "deadbeef";
  const s = await checkForUpdate();
  assert.match(s.checkError ?? "", /full Git commit SHA/i);
});

test("checkForUpdate: a network/API failure is captured (not thrown) and recorded for the UI", async () => {
  failWith = "GitHub unreachable";
  const s = await checkForUpdate();
  // The check fails soft: the error is recorded and the timestamp stamped. The
  // last-known `available` is deliberately preserved (a transient blip must not
  // flap a genuinely-available update off), so we don't assert on it here.
  assert.ok(s.checkError && /unreachable/i.test(s.checkError), "the error is recorded for the UI");
  assert.ok(s.checkedAt, "the check timestamp is still stamped");
});

test("updateStatus reports the current build identity and a well-typed self-update capability", async () => {
  const s = updateStatus();
  assert.equal(s.current, VERSION, "reports the running version");
  assert.equal(s.buildSha, "abc1234", "reports the baked build sha");
  // canSelfUpdate reflects whether a Docker socket is live, which is environment-
  // dependent (false on Windows/most runners, but GitHub's ubuntu runners DO have a
  // docker socket) - so pin the type/gating, not a fixed value.
  assert.equal(typeof s.canSelfUpdate, "boolean", "self-update capability is a boolean");
});
