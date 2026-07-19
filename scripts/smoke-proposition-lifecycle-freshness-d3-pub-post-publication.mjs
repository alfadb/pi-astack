#!/usr/bin/env node
/**
 * ADR0040 D3-PUB post-publication read-only closure smoke.
 *
 * Verifies the live production v2 published closure without writing D3,
 * settings, or legacy surfaces. Intentionally separate from the historical
 * pre-publication smoke which is excluded from smoke:all.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const core = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-core.ts"));
const { canonicalizeJcs, sha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const EXPECTED = Object.freeze({
  selection_hash: "94edfbbdf354c7df5a45337fb29365f67e12c6a792f924805cf874fe1f42ae35",
  head_hash: "fd717f2ab5acb59267bd7ff8377a5197cf500c42fcb60b837eeabf0d077bcfea",
  proof_hash: "d47fe0eac9aac077c25abb172c0992ab7e378ac7886983a0f08779fbc0e1a2f2",
  intent_hash: "2175f55c4cbcbea6355557db597cc70f2008f6b147c7292cd7bb189b60ddc5e1",
  stable_bundle_hash: "6a74d84818ea9ab9702c472bd38a96b31eec60f73d4d2adf9402967ca42a7398",
  p2a_bundle_hash: "1768de48d0c3bcb2c1e12605829d22e307973605f5c648c66c3c610bf3f40f34",
  generation: 0,
  selection_seq: 0,
  input_events: 3,
  candidates: 1,
  stable_items: 1,
});

const PROTECTED_PATHS = Object.freeze([
  core.D3_PUB_HARD_ROOT,
  core.D3_PUB_FOREIGN_V1,
  "/home/worker/.abrain/.state/sediment/proposition-policy-push-shadow/v1",
  "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1",
  "/home/worker/.pi/agent/pi-astack-settings.json",
]);

const failures = [];
let passed = 0;
function assert(value, message = "assertion failed") { if (!value) throw new Error(message); }
async function check(name, operation) {
  try { await operation(); passed += 1; process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  FAIL  ${name}\n        ${error?.stack ?? error}\n`); }
}
function snapshot(paths) { return core.captureProtectedPrestate(paths); }
function pointerIdentity(file) {
  const named = fs.lstatSync(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const raw = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    assert(before.isFile() && !named.isSymbolicLink() && before.dev === named.dev && before.ino === named.ino);
    assert(before.dev === after.dev && before.ino === after.ino && before.size === after.size && raw.length === before.size);
    assert(!current.isSymbolicLink() && current.dev === after.dev && current.ino === after.ino
      && current.mtimeMs === before.mtimeMs && current.ctimeMs === before.ctimeMs);
    return {
      raw: raw.toString("utf8"),
      identity: {
        dev: before.dev, ino: before.ino, mode: before.mode & 0o7777, nlink: before.nlink,
        size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs,
      },
    };
  } finally { fs.closeSync(fd); }
}

process.stdout.write("ADR0040 D3-PUB post-publication read-only closure smoke\n");
const before = snapshot(PROTECTED_PATHS);
try {
  await check("production dual pointers exist with exact selection/head hashes and A-B-A stable identity", () => {
    const headFile = path.join(core.D3_PUB_HARD_ROOT, "heads", "current.json");
    const selectionFile = path.join(core.D3_PUB_HARD_ROOT, "selections", "current.json");
    const firstHead = pointerIdentity(headFile);
    const firstSelection = pointerIdentity(selectionFile);
    const head = JSON.parse(firstHead.raw);
    const selection = JSON.parse(firstSelection.raw);
    assert(head.head_hash === EXPECTED.head_hash, "head hash differs");
    assert(selection.selection_hash === EXPECTED.selection_hash, "selection hash differs");
    const secondHead = pointerIdentity(headFile);
    const secondSelection = pointerIdentity(selectionFile);
    assert(canonicalizeJcs(firstHead) === canonicalizeJcs(secondHead), "head pointer A-B-A identity drifted");
    assert(canonicalizeJcs(firstSelection) === canonicalizeJcs(secondSelection), "selection pointer A-B-A identity drifted");
  });

  await check("readPublishedD3PubSelection closes exact selection/head/proof/stable and 3/1/1 gen0/seq0", () => {
    const published = core.readPublishedD3PubSelection(core.D3_PUB_HARD_ROOT);
    const selection = published.selection;
    const head = published.head;
    const proof = published.proof;
    const stable = published.artifact_closure.stable;
    const p2a = published.artifact_closure.p2a;
    assert(selection.selection_hash === EXPECTED.selection_hash);
    assert(head.head_hash === EXPECTED.head_hash);
    assert(proof.proof_hash === EXPECTED.proof_hash);
    assert(selection.intent_hash === EXPECTED.intent_hash);
    assert(stable.bundle_hash === EXPECTED.stable_bundle_hash);
    assert(p2a.bundle_hash === EXPECTED.p2a_bundle_hash);
    assert(selection.generation === EXPECTED.generation && selection.seq === EXPECTED.selection_seq);
    assert(head.generation === EXPECTED.generation);
    const view = JSON.parse(stable.artifacts["view.json"]);
    assert(Array.isArray(view.items) && view.items.length === EXPECTED.stable_items, "stable item count differs");
    const wrapper = JSON.parse(stable.artifacts["manifest.json"]);
    assert(wrapper.result?.item_count === EXPECTED.stable_items);
    const source = proof.source_snapshot;
    assert(source.input_event_count === EXPECTED.input_events, "input event count differs");
    // publication age is diagnostic only
    const ageMs = Math.max(0, Date.now() - Math.max(fs.lstatSync(path.join(core.D3_PUB_HARD_ROOT, "selections", "current.json")).mtimeMs,
      fs.lstatSync(path.join(core.D3_PUB_HARD_ROOT, "selections", "current.json")).ctimeMs));
    assert(Number.isFinite(ageMs), "publication age diagnostic must be finite");
    process.stdout.write(`        diagnostic publication_age_ms=${ageMs} (not a hard fail)\n`);
  });

  await check("foreign v1 remains absent and family root only contains v2", () => {
    assert(!fs.existsSync(core.D3_PUB_FOREIGN_V1), "foreign v1 exists");
    const family = fs.readdirSync(path.dirname(core.D3_PUB_HARD_ROOT)).sort();
    assert(canonicalizeJcs(family) === canonicalizeJcs(["v2"]), `family children=${JSON.stringify(family)}`);
  });

  await check("protected D3/settings/legacy surfaces remain zero-write across the smoke", () => {
    const after = snapshot(PROTECTED_PATHS);
    assert(canonicalizeJcs(before) === canonicalizeJcs(after), "protected surfaces changed during read-only smoke");
  });

  await check("sandbox clone of production root still validates the same exact closure", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-d3-pub-post-"));
    const clone = path.join(tmp, "proposition-lifecycle-freshness", "v2");
    fs.cpSync(core.D3_PUB_HARD_ROOT, clone, { recursive: true });
    const published = core.readPublishedD3PubSelection(clone);
    assert(published.selection.selection_hash === EXPECTED.selection_hash);
    assert(published.head.head_hash === EXPECTED.head_hash);
    assert(published.proof.proof_hash === EXPECTED.proof_hash);
    assert(published.artifact_closure.stable.bundle_hash === EXPECTED.stable_bundle_hash);
    fs.rmSync(tmp, { recursive: true, force: true });
    const after = snapshot(PROTECTED_PATHS);
    assert(canonicalizeJcs(before) === canonicalizeJcs(after), "clone path mutated production protected surfaces");
  });
} finally {
  // no cleanup needed; production untouched
}

process.stdout.write(`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${failures.length} failure(s), ${passed} passed\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
