#!/usr/bin/env node
/**
 * Smoke: ADR 0039 multi-device auto-merge self-heal for the knowledge
 * projection (git-sync.ts resolveDerivedL2ConflictAndCommit + the manifest
 * gitignore, both wired around fetchAndFF).
 *
 * GROUND TRUTH (probed in real git): content-addressed L1 events are disjoint
 * and merge cleanly, so a divergent multi-device merge's ONLY conflicts are in
 * DERIVED knowledge L2 — the per-write manifest.json (fix A: untrack it) and,
 * when the SAME slug was edited on both devices, that slug's entry .md (fix B:
 * two competing renders conflict on the body region; the correct L2 is
 * reproject(merged L1), so reproject resolves the conflict + concludes the
 * merge). A same-slug edit does NOT produce a clean Frankenstein — it
 * conflicts — so the fix lives on the CONFLICT path, not a clean-merge path.
 *
 * Offline + deterministic: a local bare repo is the fake remote; deviceA
 * pushes (origin), deviceB diverges and is driven through the REAL fetchAndFF.
 * freshWorkspace gitignores the manifest (fix A).
 *
 *   A. same-slug edit both devices -> conflict in derived L2 -> reproject
 *      resolves: result=ok, conflictResolvedByReproject>0, L2==reproject(L1),
 *      topo-fold winner content, single 2-parent merge commit, tree clean
 *   B. different-slug concurrent writes -> CLEAN merge (manifest untracked):
 *      result=ok, no conflict-resolve, both slugs present
 *   C. conflict OUTSIDE derived L2 (real content) -> abort, result=conflict
 *   D. reproject fails mid-resolve -> abort, result=conflict, HEAD restored
 *   E. constraint L2 conflict -> mechanical unblock (adopt incoming side, no
 *      LLM, no reproject); the async compiler does the real merge later
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
process.env.PI_ASTACK_REPO_ROOT = repoRoot;
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let totalChecks = 0;
async function asyncCheck(name, fn) {
  totalChecks++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
}

function git(cwd, args, opts = {}) {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Smoke", GIT_AUTHOR_EMAIL: "smoke@local",
    GIT_COMMITTER_NAME: "Smoke", GIT_COMMITTER_EMAIL: "smoke@local",
  };
  const res = spawnSync("git", args, { cwd, env, encoding: "utf-8", ...opts });
  if (res.status !== 0 && !opts.allowFail) {
    throw new Error(`git ${args.join(" ")} failed (${res.status}): ${res.stderr}`);
  }
  return res;
}

// ── Stage transpiled modules ───────────────────────────────────────
// Mirror the real extensions/ layout INSIDE tmpDir so every relative import
// resolves within tmpDir (and cleanup is a single safe rm). git-sync.cjs at
// tmpDir/abrain/ makes its CJS-transpiled `import("../sediment/...")` resolve
// to tmpDir/sediment, `../_shared` to tmpDir/_shared, `../memory` to
// tmpDir/memory, and `./redact` to tmpDir/abrain/redact.js.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-selfheal-"));
const abrainBridgeDir = path.join(tmpDir, "abrain");
const sharedBridgeDir = path.join(tmpDir, "_shared");
const sedimentBridgeDir = path.join(tmpDir, "sediment");
const memoryBridgeDir = path.join(tmpDir, "memory");
for (const d of [abrainBridgeDir, sharedBridgeDir, sedimentBridgeDir, memoryBridgeDir]) fs.mkdirSync(d, { recursive: true });

fs.writeFileSync(path.join(abrainBridgeDir, "redact.cjs"), transpile(path.join(repoRoot, "extensions/abrain/redact.ts")));
fs.writeFileSync(path.join(abrainBridgeDir, "redact.js"), `module.exports = require("./redact.cjs");\n`);
fs.writeFileSync(path.join(abrainBridgeDir, "reconcile-gate.js"), transpile(path.join(repoRoot, "extensions/abrain/reconcile-gate.ts")));
fs.writeFileSync(path.join(abrainBridgeDir, "git-sync.cjs"), transpile(path.join(repoRoot, "extensions/abrain/git-sync.ts")));
fs.writeFileSync(path.join(sharedBridgeDir, "causal-anchor.js"), `module.exports = { getCurrentAnchor: () => undefined, spreadAnchor: () => ({}) };\n`);
fs.writeFileSync(path.join(sharedBridgeDir, "git-singleflight.js"), transpile(path.join(repoRoot, "extensions/_shared/git-singleflight.ts")));
fs.writeFileSync(path.join(sharedBridgeDir, "durable-write.js"), transpile(path.join(repoRoot, "extensions/_shared/durable-write.ts")));
fs.writeFileSync(path.join(sharedBridgeDir, "jcs.js"), transpile(path.join(repoRoot, "extensions/_shared/jcs.ts")));
fs.writeFileSync(path.join(sharedBridgeDir, "l1-schema-registry.js"), transpile(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts")));
fs.mkdirSync(path.join(path.dirname(sharedBridgeDir), "schemas"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(path.dirname(sharedBridgeDir), "schemas", "l1-schema-role-registry.json"));
fs.writeFileSync(path.join(memoryBridgeDir, "settings.js"), transpile(path.join(repoRoot, "extensions/memory/settings.ts")));
fs.writeFileSync(path.join(memoryBridgeDir, "utils.js"), transpile(path.join(repoRoot, "extensions/memory/utils.ts")));
fs.writeFileSync(path.join(sedimentBridgeDir, "adr0039-l3.js"), transpile(path.join(repoRoot, "extensions/sediment/adr0039-l3.ts")));
fs.writeFileSync(path.join(sedimentBridgeDir, "knowledge-evidence.js"), transpile(path.join(repoRoot, "extensions/sediment/knowledge-evidence.ts")));

const gitSync = require(path.join(abrainBridgeDir, "git-sync.cjs"));
const km = require(path.join(sedimentBridgeDir, "knowledge-evidence.js"));
const REPO_SETTINGS = { knowledgeProjector: { l2OutputRoot: "repo" } };

// ── Knowledge event helpers (mirror buildLegacyImportBody validity) ─
let nonceCounter = 0;
function makeBody(slug, compiledTruth, device, createdAtUtc) {
  nonceCounter += 1;
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: createdAtUtc || new Date(Date.UTC(2026, 0, 1, 0, 0, nonceCounter)).toISOString(),
    device_id: device,
    producer_nonce: `selfheal-smoke:${device}:${slug}:${nonceCounter}`,
    causal_parents: [],
    session_id: "selfheal-smoke",
    turn_id: `turn-${nonceCounter}`,
    actor: { role: "assistant", id: "sediment" },
    source: { channel: "manual", source_ref: `selfheal-smoke:${slug}:${nonceCounter}` },
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    scope: { kind: "world" },
    payload: {
      slug, title: slug, kind: "fact", status: "active",
      provenance: "selfheal-smoke", confidence: 5,
      compiled_truth: compiledTruth, trigger_phrases: [], derives_from: [],
    },
    sanitizer: { sanitizer_name: "selfheal-smoke", sanitizer_version: "v1", status: "passed", replacements_count: 0 },
    legacy_parallel_write: { attempted: false, status: "legacy_import", path: `selfheal/${slug}` },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p5" },
  };
}
async function appendEvent(abrainHome, slug, compiledTruth, device, createdAtUtc) {
  const r = await km.appendKnowledgeEvidenceEvent({ abrainHome, body: makeBody(slug, compiledTruth, device, createdAtUtc) });
  if (!r.ok && r.status !== "idempotent_duplicate") throw new Error(`append ${slug} failed: ${r.status} ${r.error || ""}`);
  return r;
}
async function buildL2(abrainHome) {
  return km.reprojectAllKnowledge({ abrainHome, settings: REPO_SETTINGS });
}
function knowledgeL2Path(abrainHome, slug) {
  return path.join(abrainHome, "l2", "views", "knowledge", "latest", "world", `${slug}.md`);
}

// Fresh remote + deviceA(origin pusher) + deviceB(driven through fetchAndFF),
// sharing one base commit that already contains slug `alpha`.
let wsCounter = 0;
async function freshWorkspace() {
  wsCounter += 1;
  const ws = path.join(tmpDir, "ws", `ws${wsCounter}`);
  const remote = path.join(ws, "remote.git");
  const deviceA = path.join(ws, "deviceA", ".abrain");
  const deviceB = path.join(ws, "deviceB", ".abrain");
  fs.mkdirSync(remote, { recursive: true });
  fs.mkdirSync(path.dirname(deviceA), { recursive: true });
  fs.mkdirSync(path.dirname(deviceB), { recursive: true });
  git(remote, ["init", "--bare", "--initial-branch=main"]);
  git(path.dirname(deviceA), ["clone", "--quiet", remote, ".abrain"]);
  // Fix A: the per-device knowledge manifest is gitignored (mirrors
  // ABRAIN_KNOWLEDGE_MANIFEST_GITIGNORE_LINE in _shared/runtime.ts) so it is
  // never tracked and never participates in a merge.
  fs.writeFileSync(path.join(deviceA, ".gitignore"), ".state/\nl2/views/knowledge/latest/manifest.json\n");
  await appendEvent(deviceA, "alpha", "alpha base body\n", "deviceA");
  await buildL2(deviceA);
  git(deviceA, ["add", "-A"]);
  git(deviceA, ["commit", "-q", "-m", "base: alpha"]);
  git(deviceA, ["branch", "-M", "main"]);
  git(deviceA, ["push", "-q", "-u", "origin", "main"]);
  git(path.dirname(deviceB), ["clone", "--quiet", remote, ".abrain"]);
  git(deviceB, ["checkout", "-q", "main"]);
  return { remote, deviceA, deviceB };
}
function headSubject(abrainHome) {
  return git(abrainHome, ["log", "-1", "--pretty=%s"]).stdout.trim();
}
function headSha(abrainHome) {
  return git(abrainHome, ["rev-parse", "HEAD"]).stdout.trim();
}
function porcelain(abrainHome) {
  return git(abrainHome, ["status", "--porcelain"]).stdout.trim();
}

console.log(`tmp workspace: ${tmpDir}`);

// ── A. same-slug edit on both devices -> conflict in derived L2 -> B resolves
console.log("\n[A] same-slug edit on both devices conflicts in derived L2 -> reproject-resolve");
await asyncCheck("conflict auto-resolved: result=ok, conflictResolvedByReproject>0, L2==reproject(L1), 2-parent merge", async () => {
  const { remote, deviceA, deviceB } = await freshWorkspace();

  // deviceB edits alpha with an EARLIER created_at; deviceA edits the SAME slug
  // with a LATER created_at — pinned explicitly so deviceA deterministically
  // wins the topo-fold regardless of append/call order (kimi MINOR).
  await appendEvent(deviceB, "alpha", "alpha body EDITED BY DEVICE B bbbbbbbb\n", "deviceB", "2026-02-01T00:00:10.000Z");
  await buildL2(deviceB); git(deviceB, ["add", "-A"]); git(deviceB, ["commit", "-q", "-m", "deviceB: alpha v2"]);
  const preMergeHead = headSha(deviceB);

  // alpha.md competes on the body region -> git 3-way CONFLICT (verified
  // ground-truth, not a clean Frankenstein).
  await appendEvent(deviceA, "alpha", "alpha body EDITED BY DEVICE A aaaaaaaa\n", "deviceA", "2026-02-01T00:00:20.000Z");
  await buildL2(deviceA); git(deviceA, ["add", "-A"]); git(deviceA, ["commit", "-q", "-m", "deviceA: alpha v2"]); git(deviceA, ["push", "-q", "origin", "main"]);

  const ev = await gitSync.fetchAndFF({ abrainHome: deviceB });
  assert(ev.result === "ok", `expected result=ok (auto-resolved), got ${ev.result} (${ev.error || ""})`);
  assert((ev.conflictResolvedDerivedL2 ?? 0) > 0, `expected conflictResolvedDerivedL2>0, got ${ev.conflictResolvedDerivedL2}`);
  assert(headSha(deviceB) !== preMergeHead, "HEAD did not advance");
  assert(porcelain(deviceB) === "", `tree not clean after resolve: ${porcelain(deviceB)}`);

  const alpha = fs.readFileSync(knowledgeL2Path(deviceB, "alpha"), "utf-8");
  assert(!/^(<{7}|={7}|>{7})/m.test(alpha), "alpha.md still has conflict markers");
  // Content oracle (NON-circular): both events are now in L1; the topo-fold
  // winner is deviceA's (later created_at), so the resolved render carries
  // deviceA's body, not deviceB's and not a Frankenstein of both.
  assert(alpha.includes("aaaaaaaa") && !alpha.includes("bbbbbbbb"), `alpha.md is not the topo-fold winner (deviceA): ${alpha.slice(0, 120)}`);
  // Consistency oracle: committed L2 == reproject(merged L1) (zero content drift).
  await buildL2(deviceB);
  const drift = git(deviceB, ["status", "--porcelain", "l2/views/knowledge"]).stdout
    .trim().split("\n").filter((l) => l && !/manifest\.json$/.test(l));
  assert(drift.length === 0, `L2 != reproject(L1) after resolve: ${drift.join(" | ")}`);
  // It must be ONE 2-parent merge commit (not a follow-up / not a squash).
  const parents = git(deviceB, ["rev-list", "--parents", "-n", "1", "HEAD"]).stdout.trim().split(/\s+/);
  assert(parents.length === 3, `expected a 2-parent merge commit at HEAD, got ${parents.length - 1} parent(s)`);

  // Fleet propagation (kimi MAJOR): push the resolved merge, then clone the
  // remote as an independent observer and assert the REMOTE tip carries the
  // corrected winner L2 — not a conflicted state. This is the whole point.
  const push = await gitSync.pushAsync({ abrainHome: deviceB });
  assert(push.result === "ok", `expected push ok, got ${push.result} (${push.error || ""}) details=${JSON.stringify(push.details || null)}`);
  git(tmpDir, ["clone", "--quiet", remote, "observerA"]);
  const remoteAlpha = fs.readFileSync(knowledgeL2Path(path.join(tmpDir, "observerA"), "alpha"), "utf-8");
  assert(!/^(<{7}|={7}|>{7})/m.test(remoteAlpha), "remote alpha.md has conflict markers");
  assert(remoteAlpha.includes("aaaaaaaa") && !remoteAlpha.includes("bbbbbbbb"), `remote alpha.md is not the corrected winner: ${remoteAlpha.slice(0, 120)}`);
});

// ── B. different-slug concurrent writes -> clean merge (fix A: manifest untracked)
console.log("\n[B] different-slug concurrent writes merge cleanly (fix A: manifest untracked)");
await asyncCheck("clean merge: result=ok, no conflict-resolve, both slugs present, tree clean", async () => {
  const { deviceA, deviceB } = await freshWorkspace();

  // Both devices write knowledge to DIFFERENT slugs. Pre-fix-A this conflicted
  // on the tracked manifest.json; with the manifest gitignored, the entry
  // files are disjoint -> a clean 3-way merge, no self-heal needed.
  await appendEvent(deviceB, "tango", "tango body\n", "deviceB");
  await buildL2(deviceB); git(deviceB, ["add", "-A"]); git(deviceB, ["commit", "-q", "-m", "deviceB: tango"]);
  await appendEvent(deviceA, "uniform", "uniform body\n", "deviceA");
  await buildL2(deviceA); git(deviceA, ["add", "-A"]); git(deviceA, ["commit", "-q", "-m", "deviceA: uniform"]); git(deviceA, ["push", "-q", "origin", "main"]);

  const ev = await gitSync.fetchAndFF({ abrainHome: deviceB });
  assert(ev.result === "ok", `expected result=ok (clean), got ${ev.result} (${ev.error || ""})`);
  assert(ev.conflictResolvedDerivedL2 === undefined, `expected NO conflict-resolve on a clean merge, got ${ev.conflictResolvedDerivedL2}`);
  assert(fs.existsSync(knowledgeL2Path(deviceB, "tango")) && fs.existsSync(knowledgeL2Path(deviceB, "uniform")), "both slugs must be present after clean merge");
  assert(/auto-merge: integrate/.test(headSubject(deviceB)), `expected plain merge commit at HEAD, got: ${headSubject(deviceB)}`);
  assert(porcelain(deviceB) === "", `tree not clean: ${porcelain(deviceB)}`);
});

// ── C. conflict OUTSIDE derived L2 (real content) -> abort, not auto-resolved
console.log("\n[C] conflict outside derived L2 (real content) -> abort, result=conflict");
await asyncCheck("non-derived conflict is NOT auto-resolved: result=conflict, merge aborted, tree restored", async () => {
  const { deviceA, deviceB } = await freshWorkspace();

  // Both devices create the SAME non-derived tracked file with different
  // content -> a real add/add content conflict outside l2/views/knowledge.
  fs.writeFileSync(path.join(deviceB, "shared.txt"), "device B content\n");
  git(deviceB, ["add", "-A"]); git(deviceB, ["commit", "-q", "-m", "deviceB: shared"]);
  const preMergeHead = headSha(deviceB);
  fs.writeFileSync(path.join(deviceA, "shared.txt"), "device A content\n");
  git(deviceA, ["add", "-A"]); git(deviceA, ["commit", "-q", "-m", "deviceA: shared"]); git(deviceA, ["push", "-q", "origin", "main"]);

  const ev = await gitSync.fetchAndFF({ abrainHome: deviceB });
  assert(ev.result === "conflict", `expected result=conflict (real content), got ${ev.result}`);
  assert(ev.conflictResolvedDerivedL2 === undefined, "must NOT auto-resolve a non-derived conflict");
  assert(headSha(deviceB) === preMergeHead, "merge not aborted (HEAD moved)");
  assert(porcelain(deviceB) === "", `tree not clean after abort: ${porcelain(deviceB)}`);
});

// ── D. reproject fails during conflict-resolve -> abort, no commit
console.log("\n[D] reproject fails during conflict-resolve -> abort, result=conflict, no commit");
await asyncCheck("reproject failure bails to abort: result=conflict, HEAD restored, tree clean", async () => {
  const { deviceA, deviceB } = await freshWorkspace();

  // deviceB edits alpha (so the merge will conflict in derived L2 and engage
  // the resolver) ...
  await appendEvent(deviceB, "alpha", "alpha body B\n", "deviceB");
  await buildL2(deviceB);
  // ... then plants a CORRUPT L1 event inside the content-addressed store
  // (event_id != RFC8785/JCS body hash). Canonical-path R3.4.2 P1-S3: the
  // central schema-role registry scan fails closed on it => reprojectAllKnowledge
  // throws => resolver catch returns false => caller aborts the merge.
  const badId = `${"ab"}${"cd"}${"0".repeat(60)}`;
  const badDir = path.join(deviceB, "l1", "events", "sha256", badId.slice(0, 2), badId.slice(2, 4));
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, `${badId}.json`), JSON.stringify({
    schema: "knowledge-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: badId,
    body_hash: badId,
    body: { event_schema_version: "knowledge-evidence-event/v1", scope: { kind: "world" }, payload: { slug: "badrender" } },
  }, null, 2));
  git(deviceB, ["add", "-A"]); git(deviceB, ["commit", "-q", "-m", "deviceB: alpha v2 + unrenderable event"]);
  const preMergeHead = headSha(deviceB);

  // origin edits the same slug -> conflict in alpha.md (derived) -> resolver runs.
  await appendEvent(deviceA, "alpha", "alpha body A\n", "deviceA");
  await buildL2(deviceA); git(deviceA, ["add", "-A"]); git(deviceA, ["commit", "-q", "-m", "deviceA: alpha v2"]); git(deviceA, ["push", "-q", "origin", "main"]);

  const ev = await gitSync.fetchAndFF({ abrainHome: deviceB });
  assert(ev.result === "conflict", `expected result=conflict (reproject failed -> abort), got ${ev.result} (${ev.error || ""})`);
  assert(ev.conflictResolvedDerivedL2 === undefined, "must not claim a resolve when reproject failed");
  assert(headSha(deviceB) === preMergeHead, `merge not aborted after reproject failure: HEAD ${headSha(deviceB)} != ${preMergeHead}`);
  assert(porcelain(deviceB) === "", `tree not clean after abort: ${porcelain(deviceB)}`);
});

// ── E. constraint L2 conflict -> mechanical unblock (adopt incoming, no LLM)
console.log("\n[E] constraint L2 conflict -> mechanical unblock (adopt incoming side)");
await asyncCheck("constraint conflict auto-resolved by taking incoming side (no LLM, no reproject)", async () => {
  const { deviceA, deviceB } = await freshWorkspace();
  const cv = (home) => path.join(home, "l2", "views", "constraint", "latest", "compiled-view.md");

  // deviceB diverges with its own compiled constraint view.
  fs.mkdirSync(path.dirname(cv(deviceB)), { recursive: true });
  fs.writeFileSync(cv(deviceB), "# constraint rules (device B compile)\nDEVICE-B-VIEW\n");
  git(deviceB, ["add", "-A"]); git(deviceB, ["commit", "-q", "-m", "deviceB: constraint view"]);

  // origin diverges with a DIFFERENT compiled constraint view at the same path
  // (add/add divergence -> git conflict confined to l2/views/constraint).
  fs.mkdirSync(path.dirname(cv(deviceA)), { recursive: true });
  fs.writeFileSync(cv(deviceA), "# constraint rules (device A compile)\nDEVICE-A-VIEW\n");
  git(deviceA, ["add", "-A"]); git(deviceA, ["commit", "-q", "-m", "deviceA: constraint view"]); git(deviceA, ["push", "-q", "origin", "main"]);

  const ev = await gitSync.fetchAndFF({ abrainHome: deviceB });
  assert(ev.result === "ok", `expected result=ok (constraint unblocked), got ${ev.result} (${ev.error || ""})`);
  assert((ev.conflictResolvedDerivedL2 ?? 0) > 0, `expected conflictResolvedDerivedL2>0, got ${ev.conflictResolvedDerivedL2}`);
  assert(porcelain(deviceB) === "", `tree not clean after constraint unblock: ${porcelain(deviceB)}`);
  const view = fs.readFileSync(cv(deviceB), "utf-8");
  assert(!/^(<{7}|={7}|>{7})/m.test(view), "constraint view still has conflict markers");
  // Mechanical 'adopt incoming (origin)' — NOT a merge of both, NOT reproject.
  assert(view.includes("DEVICE-A-VIEW") && !view.includes("DEVICE-B-VIEW"), `expected incoming (origin) constraint view, got: ${view.slice(0, 80)}`);
});

// ── summary ────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
console.log(`\n${failures.length ? "FAIL" : "PASS"}  ${totalChecks - failures.length}/${totalChecks} checks`);
process.exit(failures.length ? 1 : 0);
