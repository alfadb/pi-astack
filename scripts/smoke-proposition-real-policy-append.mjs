#!/usr/bin/env node
/** Focused Stage2 smoke. Every mutation fixture is confined to the one disposable ZFS sandbox. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const writer = jiti(path.join(repoRoot, "extensions/_shared/proposition-real-policy-append-writer.ts"));
const jcs = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));
const transcript = jiti(path.join(repoRoot, "extensions/_shared/proposition-real-policy-append-transcript.ts"));
const execute = jiti(path.join(repoRoot, "extensions/_shared/proposition-real-policy-append-production-execute.ts"));
const preview = jiti(path.join(repoRoot, "extensions/_shared/proposition-real-policy-append-production-preview.ts"));

const sandbox = "/home/worker/.adr0040-stage2-sandbox-019f569c";
const ZFS_MAGIC = 0x2fc12fc1;
const EXPECTED_TERMINAL_POST_RELATIVE = "docs/evidence/2026-07-14-adr0040-real-policy-proposition-append-production-post-execute-dossier.json";
const EXPECTED_TERMINAL_POST_SCHEMA = "adr0040-real-policy-proposition-append-production-post-execute-dossier/v1";
const EXPECTED_TERMINAL_POST_DOSSIER_HASH = "39801c093fb6ea4ff8b10f97f4f4f71e68641fa74846ec4e545aa646c22edd8d";
let root;
let passed = 0;
const failures = [];

async function check(name, fn) {
  try { await fn(); passed += 1; process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  FAIL  ${name}\n        ${error?.stack ?? error}\n`); }
}
function assert(value, message) { if (!value) throw new Error(message); }
function expectCode(code, fn) { let caught; try { fn(); } catch (error) { caught = error; } assert(caught, `expected ${code}`); assert(caught.code === code, `expected ${code}, got ${caught.code ?? caught.message}`); return caught; }
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

process.stdout.write("ADR0040 real-policy proposition append Stage2 smoke\n");
prepareSandbox();
root = path.join(sandbox, "focused-smoke");
fs.mkdirSync(root, { mode: 0o700 });
try {
  await check("sandbox runner starts from an owned clean real-ZFS root", () => {
    assert(fs.readdirSync(sandbox).join(",") === "focused-smoke", "sandbox was not cleanly recreated");
    assert(Number(fs.statfsSync(sandbox).type) === ZFS_MAGIC, "sandbox is not ZFS");
    assert((fs.lstatSync(sandbox).mode & 0o777) === 0o700, "sandbox mode differs");
  });

  await check("fixed tuple has no caller fields and exact frozen bytes", () => {
    const tuple = writer.fixedRealPolicyAppendTuple();
    assert(tuple.event_id === writer.REAL_POLICY_APPEND_EVENT_ID, "event ID differs");
    assert(tuple.canonical_envelope_raw_sha256 === writer.REAL_POLICY_APPEND_CANONICAL_BYTES_SHA256, "envelope hash differs");
    assert(tuple.canonical_envelope_utf8_bytes_including_lf === 1868 && tuple.caller_supplied_tuple_fields.length === 0, "tuple bytes/caller surface differ");
    const altered = JSON.parse(JSON.stringify(tuple.envelope));
    altered.body.proposition.statement += " altered";
    expectCode("REAL_POLICY_APPEND_TUPLE_REFUSED", () => writer.assertExactRealPolicyAppendEnvelope(altered));
  });

  await check("recorded Stage2 transcript coordinate remains exact but grants no current or Stage3 authority", () => {
    const value = transcript.verifyFreshRealPolicyAppendStage2Authorization();
    assert(value.message_id === "d1d44f44" && value.text_sha256 === "20c69a2684298d675fd3b6eeb53adeecaa380fd75139e1503e45255e91fa0c4d", "Stage2 coordinate differs");
    assert(value.latest_role_user_message_verified === false && value.recorded_coordinate_and_prefix_verified && value.append_only_suffix_permitted, "recorded Stage2 replay evidence differs");
    assert(value.stage3_authorized === false && value.stage3_authorization_text_generated === false, "Stage2 authority boundary differs");
  });

  await check("v2 authorization is exact HEADER plus JCS with no terminal LF; legacy, normalized, and stale variants reject", () => {
    const spec = {
      schema_version: transcript.REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA,
      authorization_kind: "exact_fresh_role_user_stage3_production_append",
      production_append_authorized: true,
      stage2_dossier: {}, complete_source_closure: {}, execution_closure_proofs: {}, fixed_tuple: {},
      repo_evidence_paths: {}, abrain_mutation_inventory: {}, downstream_non_authority: {},
    };
    const exact = transcript.renderRealPolicyAppendStage3Authorization(spec);
    const rendered = transcript.realPolicyAppendStage3AuthorizationExpectation(spec);
    const expectation = { expected_text_sha256: rendered.exact_text_sha256, expected_text_utf8_bytes: rendered.exact_text_utf8_bytes, line: 458, latest: true };
    assert(exact === `${transcript.REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_HEADER}\n${jcs.canonicalizeJcs(spec)}`, "authorization transport is not exact HEADER plus JCS");
    assert(transcript.REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_RENDERER_DEFINITION === `${transcript.REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_HEADER}\n<RFC8785-JCS(spec)>`, "renderer definition diverges from the exact header");
    assert(exact.split("\n").length === 2 && !exact.endsWith("\n"), "authorization transport is not exactly two lines without terminal LF");
    assert(sha256(exact) === rendered.exact_text_sha256 && Buffer.byteLength(exact) === rendered.exact_text_utf8_bytes, "renderer expectation differs from exact transport bytes");
    transcript.__STAGE2_TEST.verifyExactCandidate({ text: exact, ...expectation });
    expectCode("REAL_POLICY_APPEND_STAGE3_SPEC", () => transcript.renderRealPolicyAppendStage3Authorization({ ...spec, schema_version: "adr0040-real-policy-proposition-append-stage3-authorization-spec/v1" }));
    expectCode("REAL_POLICY_APPEND_STAGE3_EXACT_TEXT", () => transcript.verifyFreshRealPolicyAppendStage3Authorization({ authorization_spec: spec, maximum_age_ms: 48 * 60 * 60 * 1000 }));
    for (const variant of [`${exact}\n`, exact.replace("\n", "\r\n"), `\n${exact}\n`, `${exact} `]) expectCode("REAL_POLICY_APPEND_STAGE3_EXACT_TEXT", () => transcript.__STAGE2_TEST.verifyExactCandidate({ text: variant, ...expectation }));
    expectCode("REAL_POLICY_APPEND_STAGE3_EXACT_TEXT", () => transcript.__STAGE2_TEST.verifyExactCandidate({ text: "Authorize Stage3 now.", ...expectation }));
    expectCode("REAL_POLICY_APPEND_STAGE3_OLDER_MESSAGE", () => transcript.__STAGE2_TEST.verifyExactCandidate({ text: exact, ...expectation, line: 457 }));
    const stage2 = transcript.verifyFreshRealPolicyAppendStage2Authorization();
    expectCode("REAL_POLICY_APPEND_STAGE3_EXACT_TEXT", () => transcript.__STAGE2_TEST.verifyExactCandidate({ text: stage2.exact_full_text, ...expectation }));
  });

  await check("recovery accepts only the fresh standalone human phrase and derives machine binding internally", () => {
    const phrase = transcript.REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_PHRASE;
    const contract = transcript.__STAGE2_TEST.recoveryHumanAuthorizationContract();
    const expected = transcript.realPolicyAppendRecoveryHumanAuthorizationExpectation(contract);
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    const candidate = (overrides = {}) => ({ role: "user", content: [{ type: "text", text: phrase }], line: 534, latest: true, timestamp: new Date(now - 1_000).toISOString(), now_ms: now, ...overrides });
    assert(Buffer.byteLength(phrase) === expected.required_phrase_utf8_bytes && sha256(phrase) === expected.required_phrase_sha256, "recovery phrase bytes/hash differ");
    transcript.__STAGE2_TEST.verifyRecoveryCandidate(candidate());
    for (const text of [`${phrase}\n`, ` ${phrase}`, `${phrase} `, `${phrase}\n继续完成后续目标。`, "确认执行 ADR0040 S2 恢复并完成到 S4。"])
      expectCode("REAL_POLICY_APPEND_RECOVERY_EXACT_TEXT", () => transcript.__STAGE2_TEST.verifyRecoveryCandidate(candidate({ content: [{ type: "text", text }] })));
    expectCode("REAL_POLICY_APPEND_RECOVERY_STANDALONE", () => transcript.__STAGE2_TEST.verifyRecoveryCandidate(candidate({ content: [{ type: "text", text: phrase }, { type: "text", text: "" }] })));
    expectCode("REAL_POLICY_APPEND_RECOVERY_ROLE", () => transcript.__STAGE2_TEST.verifyRecoveryCandidate(candidate({ role: "assistant" })));
    expectCode("REAL_POLICY_APPEND_RECOVERY_ROLE", () => transcript.__STAGE2_TEST.verifyRecoveryCandidate(candidate({ role: "tool" })));
    expectCode("REAL_POLICY_APPEND_RECOVERY_NOT_LATEST", () => transcript.__STAGE2_TEST.verifyRecoveryCandidate(candidate({ latest: false })));
    expectCode("REAL_POLICY_APPEND_RECOVERY_FRESHNESS", () => transcript.__STAGE2_TEST.verifyRecoveryCandidate(candidate({ timestamp: new Date(now - transcript.REAL_POLICY_APPEND_RECOVERY_HUMAN_AUTHORIZATION_MAXIMUM_AGE_MS - 1).toISOString() })));
    expectCode("REAL_POLICY_APPEND_RECOVERY_FRESH_AFTER_ORIGINAL", () => transcript.__STAGE2_TEST.verifyRecoveryCandidate(candidate({ line: 533 })));

    const recoveryPath = path.join(repoRoot, execute.REAL_POLICY_APPEND_RECOVERY_DOSSIER_RELATIVE);
    const recoveryRaw = fs.readFileSync(recoveryPath);
    const recovery = JSON.parse(recoveryRaw.toString("utf8"));
    const machine = execute.__STAGE2_TEST.recoveryAuthorizationBinding(recovery, sha256(recoveryRaw), recovery.current_s2_shape, recovery.hard_anchors.anchors).machine_authorization_binding;
    const machineBase = { ...machine };
    delete machineBase.machine_authorization_binding_hash;
    assert(machine.machine_authorization_binding_hash === jcs.jcsSha256Hex(machineBase), "machine binding hash is not mechanically derived");
    assert(machine.machine_authorization_binding_hash !== jcs.jcsSha256Hex({ ...machineBase, target_and_post: { ...machineBase.target_and_post, target_state: "present" } }), "machine binding does not bind target state");
  });

  await check("production phase is exact and unauthorized APIs/CLI deny without rewriting terminal state", () => {
    const postPath = path.join(repoRoot, execute.REAL_POLICY_APPEND_POST_RELATIVE);
    const terminalRawBefore = fs.existsSync(postPath) ? fs.readFileSync(postPath, "utf8") : null;
    const error = expectCode("NOT_AUTHORIZED", () => execute.executeRealPolicyAppendProduction({ repoRoot }));
    const recoveryError = expectCode("NOT_AUTHORIZED", () => execute.executeRealPolicyAppendRecovery({ repoRoot }));
    assert(error.detail?.reason === "EFFECTIVE_BWRAP_REQUIRED" && recoveryError.detail?.reason === "EFFECTIVE_BWRAP_REQUIRED", "direct production APIs did not deny at confinement gate");
    const child = spawnSync(process.execPath, [path.join(repoRoot, "scripts/execute-proposition-real-policy-append-evidence.mjs")], { encoding: "utf8", env: {} });
    assert(child.status === 1 && child.stderr.includes("FRESH_STAGE3_AUTHORIZATION_REQUIRED"), "default execute CLI did not deny");
    assert(fs.existsSync(path.join(repoRoot, execute.REAL_POLICY_APPEND_RATIFICATION_RELATIVE)) && fs.existsSync(path.join(repoRoot, execute.REAL_POLICY_APPEND_INTENT_RELATIVE)), "fixed S2 ratification/intent are absent");
    if (terminalRawBefore === null) {
      assert(!fs.existsSync(postPath), "terminal post appeared during the pre-execution denial checks");
      return;
    }

    assert(execute.REAL_POLICY_APPEND_POST_RELATIVE === EXPECTED_TERMINAL_POST_RELATIVE && postPath === path.join(repoRoot, EXPECTED_TERMINAL_POST_RELATIVE), "terminal post path differs from the frozen expected path");
    const post = JSON.parse(terminalRawBefore);
    assert(terminalRawBefore === `${jcs.canonicalizeJcs(post)}\n`, "terminal post is not exact canonical JCS plus LF");
    const postBase = { ...post };
    delete postBase.dossier_hash;
    assert(post.schema_version === EXPECTED_TERMINAL_POST_SCHEMA, "terminal post schema differs");
    assert(post.dossier_hash === EXPECTED_TERMINAL_POST_DOSSIER_HASH && jcs.jcsSha256Hex(postBase) === EXPECTED_TERMINAL_POST_DOSSIER_HASH, "terminal post frozen/self hash differs");
    assert(post.terminal_status === "COMPLETE" && post.recovery === true && post.clean_s4_observed === true, "terminal completion/recovery state differs");
    assert(post.event_result?.initial_state === "S2" && post.event_result?.final_state === "S4", "terminal event transition is not S2 to S4");
    assert(post.fixed_tuple?.event_id === writer.REAL_POLICY_APPEND_EVENT_ID && post.event_result?.target === writer.REAL_POLICY_APPEND_ABSOLUTE_TARGET && post.fixed_tuple?.target_path === writer.REAL_POLICY_APPEND_ABSOLUTE_TARGET, "terminal event or target identity differs");
    assert(fs.readFileSync(postPath, "utf8") === terminalRawBefore, "unauthorized API/CLI checks rewrote the terminal post");
  });

  await check("complete execution closure includes exact Node, Jiti package, bwrap, flock, loader/DSO, procfs, and JCS", () => {
    const captured = execute.captureRealPolicyAppendExecutionClosure(repoRoot);
    try {
      assert(captured.evidence.complete === true && captured.evidence.closure_hash, "closure is incomplete");
      assert(captured.evidence.jiti.rows.length >= 16 && captured.evidence.jiti.no_symlinks === true, "Jiti package closure is incomplete");
      assert(captured.evidence.loader_dso_rows.length >= 3 && captured.evidence.procfs.fd_relative_identity_verified === true, "loader/DSO/procfs closure is incomplete");
    } finally { execute.closeRealPolicyAppendExecutionClosureHandles(captured.handles); }
  });

  await check("binary, source, Jiti, and DSO byte drift all fail closed", () => {
    const drift = path.join(root, "closure-drift");
    fs.mkdirSync(drift, { mode: 0o700 });
    for (const kind of ["binary", "source", "jiti", "dso"]) {
      const file = path.join(drift, kind);
      const original = Buffer.from(`${kind}-original\n`);
      fs.writeFileSync(file, original, { mode: kind === "binary" ? 0o700 : 0o600 });
      const expected = { bytes: original.length, sha256: sha256(original) };
      execute.__STAGE2_TEST.verifyClosureByteRow(file, expected, kind);
      fs.writeFileSync(file, Buffer.from(`${kind}-drifted!\n`));
      expectCode("REAL_POLICY_APPEND_EXECUTION_CLOSURE_DRIFT", () => execute.__STAGE2_TEST.verifyClosureByteRow(file, expected, kind));
    }
  });

  await check("same-OFD evidence-directory lock reports BUSY and releases on close", () => {
    const directory = path.join(root, "flock");
    fs.mkdirSync(directory, { mode: 0o700 });
    const first = execute.__STAGE2_TEST.acquireEvidenceDirectoryLock(directory);
    const second = execute.__STAGE2_TEST.acquireEvidenceDirectoryLock(directory);
    assert(first.status === "ACQUIRED" && second.status === "BUSY", "same-OFD lock statuses differ");
    fs.closeSync(second.fd); fs.closeSync(first.fd);
    const third = execute.__STAGE2_TEST.acquireEvidenceDirectoryLock(directory);
    assert(third.status === "ACQUIRED", "same-OFD lock did not release");
    fs.closeSync(third.fd);
  });

  await check("retained first-shard FD rejects real rename plus symlink swap before mutation", () => {
    const home = path.join(root, "event-first-swap");
    const first = path.join(home, "l1/events/sha256/1c");
    const attacker = path.join(home, "attacker-first");
    fs.mkdirSync(first, { recursive: true, mode: 0o700 });
    fs.mkdirSync(attacker, { mode: 0o700 });
    expectCode("REAL_POLICY_APPEND_EVENT_ANCESTOR_SWAP", () => execute.__STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash: "a".repeat(64), afterClassifyForTest: () => { fs.renameSync(first, `${first}.verified`); fs.symlinkSync(attacker, first); } }));
    assert(fs.readdirSync(attacker).length === 0 && !fs.existsSync(path.join(`${first}.verified`, "8c")), "first-shard swap redirected a mutation");
  });

  await check("retained second-shard FD rejects real rename plus symlink swap before mutation", () => {
    const home = path.join(root, "event-second-swap");
    const first = path.join(home, "l1/events/sha256/1c");
    const second = path.join(first, "8c");
    const attacker = path.join(first, "attacker-second");
    fs.mkdirSync(second, { recursive: true, mode: 0o700 });
    fs.chmodSync(second, 0o700);
    fs.mkdirSync(attacker, { mode: 0o700 });
    expectCode("REAL_POLICY_APPEND_EVENT_ANCESTOR_SWAP", () => execute.__STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash: "b".repeat(64), afterClassifyForTest: () => { fs.renameSync(second, `${second}.verified`); fs.symlinkSync(attacker, second); } }));
    assert(fs.readdirSync(attacker).length === 0 && fs.readdirSync(`${second}.verified`).length === 0, "second-shard swap redirected a mutation");
  });

  await check("private event primitive converges S0-S4 only through retained dirfds", () => {
    const home = path.join(root, "event");
    fs.mkdirSync(path.join(home, "l1/events/sha256/1c"), { recursive: true, mode: 0o700 });
    const first = execute.__STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash: "c".repeat(64) });
    const second = execute.__STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash: "c".repeat(64) });
    assert(first.final_state === "S4" && second.identical === true, "event did not converge/idempotently rerun");
  });

  await check("bootstrap Ccommit observes exact S2 through retained FDs", () => {
    const home = path.join(root, "bootstrap-ccommit");
    fs.mkdirSync(path.join(home, "l1/events/sha256/1c"), { recursive: true, mode: 0o700 });
    let observed = false;
    const result = execute.__STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash: "d".repeat(64), beforeCommit: (context) => {
      observed = context.state === "S2" && execute.__STAGE2_TEST.classifyFixedEventState({ abrainHome: home, intentHash: "d".repeat(64) }) === "S2";
    } });
    assert(observed && result.final_state === "S4", "bootstrap Ccommit did not observe exact S2");
  });

  await check("existing exact S2 recovers by replacing only the deterministic temp then reaches S4", () => {
    const home = path.join(root, "existing-s2");
    const second = path.join(home, "l1/events/sha256/1c/8c");
    fs.mkdirSync(second, { recursive: true, mode: 0o700 });
    const intentHash = "e".repeat(64);
    const temp = path.join(second, execute.deterministicEventTempBasename(intentHash));
    fs.writeFileSync(temp, writer.fixedRealPolicyAppendTuple().canonical_envelope_json, { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    const result = execute.__STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash, beforeCommit: (context) => assert(context.state === "S2", "recovery Ccommit was not S2") });
    assert(result.initial_state === "S2" && result.final_state === "S4" && fs.readdirSync(second).length === 1, "existing S2 did not converge through the exact recovery path");
  });

  await check("foreign siblings, wrong temp, symlink, mode, and nlink reject before recovery mutation", () => {
    const cases = ["foreign", "wrong", "symlink", "mode", "nlink"];
    for (const kind of cases) {
      const home = path.join(root, `reject-${kind}`);
      const second = path.join(home, "l1/events/sha256/1c/8c");
      fs.mkdirSync(second, { recursive: true, mode: 0o700 });
      const intentHash = "f".repeat(64);
      const temp = path.join(second, execute.deterministicEventTempBasename(intentHash));
      if (kind === "wrong") fs.writeFileSync(path.join(second, ".wrong.tmp"), writer.fixedRealPolicyAppendTuple().canonical_envelope_json, { mode: 0o600 });
      else if (kind === "symlink") fs.symlinkSync("/dev/null", temp);
      else {
        fs.writeFileSync(temp, writer.fixedRealPolicyAppendTuple().canonical_envelope_json, { mode: kind === "mode" ? 0o644 : 0o600 });
        fs.chmodSync(temp, kind === "mode" ? 0o644 : 0o600);
        if (kind === "foreign") fs.writeFileSync(path.join(second, "foreign"), "x", { mode: 0o600 });
        if (kind === "nlink") fs.linkSync(temp, path.join(second, "linked-foreign"));
      }
      let rejected = false;
      try { execute.__STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash }); } catch { rejected = true; }
      assert(rejected, `${kind} S2 surface was accepted`);
    }
  });

  await check("S3 target-first recovery removes the retained temp and preserves exact target", () => {
    const home = path.join(root, "existing-s3");
    const second = path.join(home, "l1/events/sha256/1c/8c");
    fs.mkdirSync(second, { recursive: true, mode: 0o700 });
    const intentHash = "1".repeat(64);
    const temp = path.join(second, execute.deterministicEventTempBasename(intentHash));
    const target = path.join(second, `${writer.REAL_POLICY_APPEND_EVENT_ID}.json`);
    fs.writeFileSync(temp, writer.fixedRealPolicyAppendTuple().canonical_envelope_json, { mode: 0o600 });
    fs.chmodSync(temp, 0o600); fs.linkSync(temp, target);
    const result = execute.__STAGE2_TEST.convergeFixedEvent({ abrainHome: home, intentHash });
    assert(result.initial_state === "S3" && result.final_state === "S4" && fs.readdirSync(second).join() === path.basename(target), "S3 recovery did not leave target-only S4");
  });

  await check("recorded authorization exact bytes allow an append-only later user suffix while fresh authorization remains latest-only", () => {
    const spec = { schema_version: transcript.REAL_POLICY_APPEND_STAGE3_AUTHORIZATION_SPEC_SCHEMA, authorization_kind: "exact_fresh_role_user_stage3_production_append", production_append_authorized: true, stage2_dossier: {}, complete_source_closure: {}, execution_closure_proofs: {}, fixed_tuple: {}, repo_evidence_paths: {}, abrain_mutation_inventory: {}, downstream_non_authority: {} };
    const exact = transcript.renderRealPolicyAppendStage3Authorization(spec);
    const expected = transcript.realPolicyAppendStage3AuthorizationExpectation(spec);
    transcript.__STAGE2_TEST.verifyRecordedExactCandidate({ text: exact, expected_text_sha256: expected.exact_text_sha256, expected_text_utf8_bytes: expected.exact_text_utf8_bytes, line: 533, latest: false });
    expectCode("REAL_POLICY_APPEND_STAGE3_NOT_LATEST", () => transcript.__STAGE2_TEST.verifyExactCandidate({ text: exact, expected_text_sha256: expected.exact_text_sha256, expected_text_utf8_bytes: expected.exact_text_utf8_bytes, line: 533, latest: false }));
  });

  await check("outer runner tolerates mutable directory metadata but rejects inode and symlink replacement", () => {
    const child = spawnSync(process.execPath, [path.join(repoRoot, "scripts/execute-proposition-real-policy-append-evidence.mjs"), "--runner-handoff-smoke"], { encoding: "utf8", env: { PI_ASTACK_REAL_POLICY_APPEND_TEST: "1" } });
    assert(child.status === 0, `runner handoff smoke failed: ${child.stderr}`);
    const value = JSON.parse(child.stdout);
    assert(value.mutable_directory_metadata_change_accepted && value.inode_replacement_rejected && value.symlink_replacement_rejected, "runner handoff results differ");
  });

  await check("preview staging parent rename/symlink cannot redirect no-replace create", () => {
    const directory = path.join(root, "preview-parent");
    const attacker = path.join(root, "preview-attacker");
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(attacker, { mode: 0o700 });
    expectCode("REAL_POLICY_APPEND_REPO_PARENT_SWAP", () => execute.__STAGE2_TEST.stageRepoArtifact({ directory, finalName: "preview.json", raw: '{"preview":true}\n', mode: 0o644, afterDirectoryOpenForTest: () => { fs.renameSync(directory, `${directory}.verified`); fs.symlinkSync(attacker, directory); } }));
    assert(fs.readdirSync(attacker).length === 0 && fs.readdirSync(`${directory}.verified`).length === 0, "preview parent swap redirected creation");
  });

  await check("deterministic repo stage is dirfd-relative, no-replace, and foreign-temp refusing", () => {
    const directory = path.join(root, "repo");
    fs.mkdirSync(directory, { mode: 0o700 });
    const raw = '{"smoke":true}\n';
    const first = execute.__STAGE2_TEST.stageRepoArtifact({ directory, finalName: "artifact.json", raw });
    const second = execute.__STAGE2_TEST.stageRepoArtifact({ directory, finalName: "artifact.json", raw });
    assert(first.status === "created" && second.status === "identical", "repo stage statuses differ");
    const foreign = path.join(root, "repo-foreign");
    fs.mkdirSync(foreign, { mode: 0o700 });
    fs.writeFileSync(path.join(foreign, ".artifact.json.foreign.tmp"), "foreign", { mode: 0o600 });
    expectCode("REAL_POLICY_APPEND_REPO_STAGE_FOREIGN", () => execute.__STAGE2_TEST.stageRepoArtifact({ directory: foreign, finalName: "artifact.json", raw }));
  });

  await check("exact terminal post returns before simulated later live-anchor drift", () => {
    const directory = path.join(root, "terminal");
    fs.mkdirSync(directory, { mode: 0o700 });
    const ratification = { record_hash: "d".repeat(64) };
    const intent = { intent_hash: "e".repeat(64) };
    const post = execute.__STAGE2_TEST.withSelfHash({
      schema_version: "adr0040-real-policy-proposition-append-production-post-execute-dossier/v1",
      canonicalization: "RFC8785-JCS", hash_algorithm: "sha256", dossier_hash_scope: "sha256 over RFC8785-JCS of this object with dossier_hash omitted and no LF",
      terminal_status: "COMPLETE", protocol_hash: preview.REAL_POLICY_APPEND_PROTOCOL_HASH, ratification_hash: ratification.record_hash, intent_hash: intent.intent_hash,
      fixed_tuple: execute.__STAGE2_TEST.fixedTupleBinding(), event_result: { initial_state: "S4", final_state: "S4", target: writer.REAL_POLICY_APPEND_ABSOLUTE_TARGET, identical: true },
      clean_s4_observed: true, observed_drift: null, mutation_accounting: execute.__STAGE2_TEST.exactAbrainMutationBinding(), recovery: true,
      recovery_authorization: { recovery_dossier_raw_sha256: "a".repeat(64), recovery_dossier_hash: "b".repeat(64), message_id: "repair", message_line_number: 1, text_sha256: "c".repeat(64), human_authorization_contract_hash: "d".repeat(64), machine_authorization_binding_hash: "e".repeat(64) },
    }, "dossier_hash");
    const file = path.join(directory, "post.json");
    fs.writeFileSync(file, execute.__STAGE2_TEST.canonicalRaw(post), { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    let liveAnchorChecked = false;
    const result = execute.__STAGE2_TEST.validateTerminalPost(file, ratification, intent, "S4");
    if (!result) { liveAnchorChecked = true; throw new Error("simulated later stable-anchor drift"); }
    assert(result.status === "COMPLETE" && liveAnchorChecked === false, "terminal post did not take static precedence");
  });

  await check("Stage2/Stage3 inventories and no-authority contract are exact", () => {
    assert(preview.REAL_POLICY_APPEND_STAGE2_PATHS.length === 8 && execute.REAL_POLICY_APPEND_STAGE3_OUTPUTS.length === 3, "path counts differ");
    assert(!preview.REAL_POLICY_APPEND_STAGE2_PATHS.some((value, index) => preview.REAL_POLICY_APPEND_STAGE2_PATHS.indexOf(value) !== index), "Stage2 path duplicate");
    const before = { summary: { inventory_hash: "a".repeat(64) }, rows: [{ path: "ambient/old", kind: "file", sha256: "1".repeat(64) }], proposition: [] };
    const after = { summary: { inventory_hash: "b".repeat(64) }, rows: [{ path: "ambient/new", kind: "file", sha256: "2".repeat(64) }], proposition: [] };
    const ambient = preview.__STAGE2_PREVIEW_TEST.summarizeWholeAbrainEvidence(before, after);
    assert(ambient.scope === "whole_abrain_evidence_only_not_a_hard_anchor_or_gate" && ambient.ambient_drift_observed === true && ambient.delta_count === 2, "ambient evidence does not record a non-gating delta");
    assert(!Object.prototype.hasOwnProperty.call(ambient, "equal") && ambient.delta_categories.map((row) => row.category).join(",") === "created,modified,removed", "ambient evidence schema contains equality semantics or wrong categories");
  });
} finally {
  try { cleanupSandbox(); if (fs.existsSync(sandbox)) throw new Error("sandbox remained after cleanup"); passed += 1; process.stdout.write("  ok    smoke cleans the entire sandbox root on exit\n"); }
  catch (error) { failures.push({ name: "smoke cleans the entire sandbox root on exit", error }); process.stdout.write(`  FAIL  smoke cleans the entire sandbox root on exit\n        ${error?.stack ?? error}\n`); }
}

if (failures.length) { process.stdout.write(`FAIL: ${failures.length} failure(s), ${passed} passed\n`); process.exit(1); }
process.stdout.write(`PASS: ${passed} checks\n`);

function prepareSandbox() { assertSandboxLiteral(); if (lstatMaybe(sandbox)) { assertOwnedDirectory(sandbox); assertNoNestedMounts(); fs.rmSync(sandbox, { recursive: true, force: false }); } fs.mkdirSync(sandbox, { mode: 0o700 }); fs.chmodSync(sandbox, 0o700); assertOwnedDirectory(sandbox); if (Number(fs.statfsSync(sandbox).type) !== ZFS_MAGIC) throw new Error("sandbox is not real ZFS"); }
function cleanupSandbox() { assertSandboxLiteral(); if (!lstatMaybe(sandbox)) return; assertOwnedDirectory(sandbox); assertNoNestedMounts(); fs.rmSync(sandbox, { recursive: true, force: false }); }
function assertSandboxLiteral() { if (sandbox !== "/home/worker/.adr0040-stage2-sandbox-019f569c" || path.dirname(sandbox) !== "/home/worker") throw new Error("sandbox escaped the one authorized root"); }
function assertOwnedDirectory(directory) { const stat = fs.lstatSync(directory); const uid = process.getuid?.() ?? stat.uid; const gid = process.getgid?.() ?? stat.gid; if (stat.isSymbolicLink() || !stat.isDirectory() || stat.uid !== uid || stat.gid !== gid || fs.realpathSync.native(directory) !== directory) throw new Error("sandbox is not exact and runner-owned"); }
function assertNoNestedMounts() { const prefix = `${sandbox}/`; const nested = fs.readFileSync("/proc/self/mountinfo", "utf8").split("\n").map((line) => line.split(" ")[4]).filter((mountpoint) => mountpoint === sandbox || mountpoint?.startsWith(prefix)); if (nested.length) throw new Error(`sandbox has nested mount: ${nested.join(",")}`); }
function lstatMaybe(file) { try { return fs.lstatSync(file); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
