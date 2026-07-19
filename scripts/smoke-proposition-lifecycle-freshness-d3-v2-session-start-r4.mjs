#!/usr/bin/env node
/** ADR0040 D3-v2 session_start R4 sandbox/runtime/production-readonly smoke. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const r4 = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.ts"));
const adapter = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts"));
const core = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-core.ts"));
const evidence = jiti(path.join(repoRoot, r4.D3_V2_R4_EVIDENCE_MODULE));
const { canonicalizeJcs, jcsSha256Hex, sha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));
const { parseJsonRejectDuplicateKeys } = jiti(path.join(repoRoot, "extensions/_shared/strict-json.ts"));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-r4-"));
let passed = 0;
const failures = [];
function assert(value, message = "assertion failed") { if (!value) throw new Error(message); }
async function check(name, fn) { try { await fn(); passed += 1; process.stdout.write(`  ok    ${name}\n`); } catch (error) { failures.push({ name, error }); process.stdout.write(`  FAIL  ${name}\n        ${error?.stack ?? error}\n`); } }
function expectCode(fn, fragments) { let caught; try { fn(); } catch (error) { caught = error; } assert(caught, `expected failure ${fragments}`); assert(fragments.some((part) => String(caught).includes(part)), `unexpected failure: ${caught}`); }
function expectFailure(fn, message = "expected failure") { let caught; try { fn(); } catch (error) { caught = error; } assert(caught, message); return caught; }
function h(label) { return createHash("sha256").update(label).digest("hex"); }
const D3 = Object.freeze({ selection_hash: h("selection"), head_hash: h("head"), proof_hash: h("proof"), intent_hash: h("intent"), stable_bundle_hash: h("stable"), p2a_bundle_hash: h("p2a"), generation: 0, selection_seq: 0 });
const FAKE_MANIFEST = Object.freeze({ manifest_hash: h("operator-manifest"), graph: { graph_hash: h("graph") }, source_closure_hash: h("source-closure") });

function sessionRows(id) {
  return [
    { type: "session", version: 3, id, timestamp: new Date(Date.now() - 10_000).toISOString(), cwd: tmp },
    { type: "model_change", id: h(`root-${id}`).slice(0, 16), parentId: null, timestamp: new Date(Date.now() - 9_000).toISOString(), provider: "sandbox", modelId: "sandbox" },
  ];
}
function appendUser(fixture, text, label = `u-${Date.now()}-${Math.random()}`) {
  const lines = fs.readFileSync(fixture.authorizationSessionPath, "utf8").trimEnd().split("\n").map(JSON.parse);
  const parent = lines.at(-1).id;
  const timestamp = new Date(Date.now() + lines.length).toISOString();
  const row = { type: "message", id: h(label).slice(0, 16), parentId: parent, timestamp, message: { role: "user", content: [{ type: "text", text }], timestamp: Date.parse(timestamp) } };
  fs.appendFileSync(fixture.authorizationSessionPath, `${JSON.stringify(row)}\n`);
  return row;
}
function baseSettings(sessionId, options = {}) {
  const ruleInjector = {
    enabled: true,
    propositionPolicyStableViewInjection: { enabled: true, selector: { session_ids: options.v1Ids ?? ["other-v1-session"] }, expectedBundleHash: h("v1") },
  };
  if (options.v2 !== undefined) ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection = options.v2;
  return { $schema: "sandbox", unrelated: { keep: true }, ruleInjector };
}
function makeFixture(label, options = {}) {
  const root = path.join(tmp, label);
  const sessionsRoot = path.join(root, "sessions");
  const sessionId = options.sessionId ?? `r4-${label}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const authorizationSessionId = `auth-${h(label).slice(0, 16)}`;
  const sessionPath = path.join(sessionsRoot, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
  const authorizationSessionPath = path.join(sessionsRoot, `2026-01-01T00-00-01-000Z_${authorizationSessionId}.jsonl`);
  const settingsPath = path.join(root, "settings.json");
  const controlRoot = path.join(root, "control");
  const rollbackTarget = path.join(root, "rollback");
  const oldActivationRoot = path.join(root, "old-activations");
  fs.mkdirSync(sessionsRoot, { recursive: true, mode: 0o700 });
  fs.writeFileSync(sessionPath, `${sessionRows(sessionId).map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  fs.writeFileSync(authorizationSessionPath, `${sessionRows(authorizationSessionId).map(JSON.stringify).join("\n")}\n`, { mode: 0o600 });
  const settingsObject = options.settings ?? baseSettings(sessionId, options);
  const settingsRaw = typeof settingsObject === "string" ? settingsObject : `${JSON.stringify(settingsObject, null, 2)}\n`;
  fs.writeFileSync(settingsPath, settingsRaw, { mode: 0o600 });
  const manifestHash = h(`adapter-${label}`);
  const frozen = r4.buildD3V2R4FrozenBinding({
    targetSessionId: sessionId, targetSessionsRoot: sessionsRoot, targetSessionPath: sessionPath,
    authorizationSessionId, authorizationSessionsRoot: sessionsRoot, authorizationSessionPath,
    settingsPath, controlRoot, rollbackTarget, oldActivationRoot,
    runtimeAuditPath: path.join(root, "runtime-audit.jsonl"),
    operatorAuditPath: path.join(controlRoot, "operator-audit.jsonl"),
    quarantineTarget: path.join(sessionsRoot, `.quarantine-${sessionId}.jsonl`),
    d3: D3,
    adapterManifestHash: manifestHash,
    operatorManifest: FAKE_MANIFEST,
    operatorManifestIdentity: { relative_path: "sandbox-manifest.json", raw_sha256: h("manifest-raw") },
    predecessorDossier: { relative_path: "predecessor.json", raw_sha256: h("pred-raw"), self_hash: h("pred-self") },
    executionDossier: { relative_path: "r4-dossier.json", raw_sha256: h("dossier-raw"), self_hash: h("dossier-self") },
    sourceCommit: "0".repeat(40),
  });
  return { root, sessionsRoot, sessionId, sessionPath, authorizationSessionId, authorizationSessionPath, settingsPath, controlRoot, rollbackTarget, oldActivationRoot, manifestHash, frozen, settingsRaw };
}
function grant(fixture) { appendUser(fixture, r4.D3_V2_R4_INITIAL_AUTHORIZATION_PHRASE, `initial-${fixture.sessionId}-${Date.now()}`); }
function continueGrant(fixture) { appendUser(fixture, r4.D3_V2_R4_CONTINUE_AUTHORIZATION_PHRASE, `continue-${fixture.sessionId}-${Date.now()}-${Math.random()}`); }
function resolvedSettings(fixture) {
  const root = JSON.parse(fs.readFileSync(fixture.settingsPath, "utf8"));
  return adapter.resolveD3V2SessionStartInjectionSettings(root.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection);
}
function runtimeGate(fixture, sessionId = fixture.sessionId, sessionPath = fixture.sessionPath) {
  return r4.evaluateD3V2R4RuntimeGate({ settings: resolvedSettings(fixture), sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionPath }, adapterManifestHash: fixture.manifestHash });
}
function operationFiles(fixture) {
  const names = fs.readdirSync(path.join(fixture.controlRoot, "intents"));
  const operationId = names.map((name) => /^([0-9a-f]{64})\.json$/.exec(name)?.[1] ?? /^\.([0-9a-f]{64})\.intent\.pending$/.exec(name)?.[1]).find(Boolean);
  assert(operationId, "operation identity missing from intent final/pending");
  return { operationId, intent: path.join(fixture.controlRoot, "intents", `${operationId}.json`), activation: path.join(fixture.controlRoot, "activations", `${operationId}.json`), receipt: path.join(fixture.controlRoot, "receipts", `${operationId}.json`) };
}
function executeHappy(label) {
  const f = makeFixture(label);
  grant(f);
  const sessionBefore = fs.readFileSync(f.sessionPath);
  const result = r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: f.frozen });
  return { f, result, files: operationFiles(f), sessionBefore };
}

process.stdout.write("ADR0040 D3-v2 session_start R4 smoke\n");
try {
  await check("sandbox positive create/bind closes operation id, three create-only objects, settings CAS, and runtime gate", () => {
    const { f, result, files, sessionBefore } = executeHappy("happy");
    assert(result.status === "bound" && /^[0-9a-f]{64}$/.test(result.operation_id));
    assert(result.operation_id === files.operationId);
    for (const file of [files.intent, files.activation, files.receipt]) { const st = fs.lstatSync(file); assert(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && (st.mode & 0o7777) === 0o600); }
    const intent = JSON.parse(fs.readFileSync(files.intent, "utf8"));
    assert(intent.operation_id === jcsSha256Hex(intent.authorization_tuple), "operation_id is not SHA256(JCS(full tuple))");
    assert(runtimeGate(f).ok === true, JSON.stringify(runtimeGate(f)));
    assert(fs.readFileSync(f.sessionPath).equals(sessionBefore), "bind-existing operator changed the session file");
  });

  await check("disabled/absent is inert; enabled missing control/intent/activation/receipt are selected-zero gate failures", () => {
    const off = adapter.resolveD3V2SessionStartInjectionSettings(undefined);
    assert(off.enabled === false && !off.r4Binding);
    const missing = makeFixture("missing-control");
    const postRaw = r4.renderD3V2R4SettingsPost(JSON.parse(missing.settingsRaw), missing.frozen.desired_settings);
    fs.writeFileSync(missing.settingsPath, postRaw, { mode: 0o600 });
    assert(runtimeGate(missing).ok === false);
    const { f, files } = executeHappy("missing-faces");
    fs.unlinkSync(files.receipt); assert(runtimeGate(f).ok === false, "missing receipt passed");
    fs.unlinkSync(files.activation); assert(runtimeGate(f).ok === false, "missing activation passed");
    fs.unlinkSync(files.intent); assert(runtimeGate(f).ok === false, "missing intent passed");
  });

  await check("unsafe/no-trim session ids and selectors fail closed", () => {
    for (const id of ["", " ", " padded", "padded ", "../x", "a/b", "a\\b", ".", "..", "x".repeat(129)]) {
      const cfg = adapter.resolveD3V2SessionStartInjectionSettings({ enabled: true, selector: { session_ids: [id] }, r4Binding: { schema_version: adapter.D3_V2_SESSION_START_R4_SETTINGS_BINDING_SCHEMA, controlRoot: "/tmp/x", operatorManifestHash: h("m"), settingsPath: "/tmp/s" } });
      assert(cfg.enabled === false && cfg.selector.session_ids.length === 0 && cfg.r4Binding === null, `unsafe id did not fail closed: ${JSON.stringify(id)}`);
    }
    expectCode(() => makeFixture("bad-id", { sessionId: " padded " }), ["path_component_invalid"]);
  });

  await check("target session already in v1 or v2 selector is refused", () => {
    expectCode(() => makeFixture("v1-conflict", { v1Ids: ["r4-v1-conflict"] }), ["R4_SELECTOR_CONFLICT"]);
    expectCode(() => makeFixture("v2-conflict", { v2: { enabled: false, selector: { session_ids: ["r4-v2-conflict"] } } }), ["R4_SETTINGS_PRESTATE", "R4_SELECTOR_CONFLICT"]);
  });

  await check("strict JSON rejects duplicate keys/invalid UTF-8 and preserves prototype-named own keys", () => {
    expectCode(() => parseJsonRejectDuplicateKeys('{"a":1,"\\u0061":2}'), ["STRICT_JSON_DUPLICATE_KEY"]);
    expectCode(() => parseJsonRejectDuplicateKeys(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d])), ["STRICT_JSON_UTF8"]);
    const prototypeNamed = parseJsonRejectDuplicateKeys('{"__proto__":{"polluted":true},"constructor":1}');
    assert(Object.getPrototypeOf(prototypeNamed) === null, "strict parser object prototype is not null");
    assert(Object.prototype.hasOwnProperty.call(prototypeNamed, "__proto__"), "__proto__ own key was lost");
    assert(canonicalizeJcs(prototypeNamed) === '{"__proto__":{"polluted":true},"constructor":1}', "JCS lost a prototype-named key");
    assert({}.polluted === undefined, "global object prototype was polluted");
    const root = path.join(tmp, "duplicate-settings"); fs.mkdirSync(path.join(root, "sessions"), { recursive: true });
    const sessionId = "duplicate-settings"; const sessionPath = path.join(root, "sessions", `${sessionId}.jsonl`);
    fs.writeFileSync(sessionPath, `${sessionRows(sessionId).map(JSON.stringify).join("\n")}\n`);
    const settingsPath = path.join(root, "settings.json"); fs.writeFileSync(settingsPath, '{"ruleInjector":{},"ruleInjector":{}}\n');
    expectCode(() => r4.captureD3V2R4SettingsPrestate(settingsPath), ["R4_DUPLICATE_OR_INVALID_JSON"]);
  });

  await check("fresh execute refuses foreign intent, activation, or receipt collision before settings/session mutation", () => {
    for (const family of ["intents", "activations", "receipts"]) {
      const f = makeFixture(`collision-${family}`); grant(f);
      fs.mkdirSync(path.join(f.controlRoot, family), { recursive: true });
      fs.writeFileSync(path.join(f.controlRoot, family, `${h(family)}.json`), "{}\n");
      const before = fs.readFileSync(f.settingsPath, "utf8");
      expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: f.frozen }), ["R4_CONTROL_FOREIGN"]);
      assert(fs.readFileSync(f.settingsPath, "utf8") === before);
    }
  });

  await check("settings preimage race halts; exact winner readback alone may converge", () => {
    const f = makeFixture("preimage-race"); grant(f);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: f.frozen, testHooks: { beforeSettingsCas() { const value = JSON.parse(fs.readFileSync(f.settingsPath, "utf8")); value.foreign = true; fs.writeFileSync(f.settingsPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); } } }), ["R4_SETTINGS_CAS_RACE"]);
    assert(!fs.existsSync(operationFiles(f).receipt));
    const winner = makeFixture("exact-winner"); grant(winner);
    const result = r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: winner.frozen, testHooks: { beforeSettingsCas() { fs.writeFileSync(winner.settingsPath, r4.renderD3V2R4SettingsPost(JSON.parse(winner.settingsRaw), winner.frozen.desired_settings), { mode: 0o600 }); } } });
    assert(result.settings_cas === "exact_winner_readback" && runtimeGate(winner).ok);
  });

  await check("settings-CAS to receipt crash is runtime-zero, then fresh continue creates the sole receipt", () => {
    const f = makeFixture("post-crash"); grant(f);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: f.frozen, testHooks: { afterSettingsCasBeforeReceipt() { throw new Error("simulated-post-cas-crash"); } } }), ["simulated-post-cas-crash"]);
    const files = operationFiles(f); assert(!fs.existsSync(files.receipt)); assert(runtimeGate(f).ok === false, "crash window injected");
    continueGrant(f);
    const resumed = r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: f.frozen });
    assert(resumed.status === "bound" && resumed.settings_cas === "already_exact_post" && runtimeGate(f).ok);
  });

  await check("settings-pre plus exact intent/activation resumes CAS+receipt; post+receipt verifies terminal without rewrite", () => {
    const f = makeFixture("pre-crash"); grant(f);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: f.frozen, testHooks: { beforeSettingsCas() { throw new Error("simulated-pre-cas-crash"); } } }), ["simulated-pre-cas-crash"]);
    assert(fs.readFileSync(f.settingsPath, "utf8") === f.settingsRaw);
    continueGrant(f);
    const resumed = r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: f.frozen });
    assert(resumed.status === "bound" && runtimeGate(f).ok);
    const receiptBefore = fs.readFileSync(operationFiles(f).receipt);
    continueGrant(f);
    const terminal = r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: f.frozen });
    assert(terminal.status === "terminal_verified" && terminal.rewritten === false);
    assert(fs.readFileSync(operationFiles(f).receipt).equals(receiptBefore));
  });

  await check("activation reconstruction rejects settings-post, receipt-present, and mismatched activation states", () => {
    const preWithReceipt = executeHappy("invalid-pre-with-receipt");
    fs.writeFileSync(preWithReceipt.f.settingsPath, preWithReceipt.f.settingsRaw, { mode: 0o600 }); continueGrant(preWithReceipt.f);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: preWithReceipt.f.frozen }), ["R4_RECOVERY_PRE_WITH_RECEIPT"]);

    const postMissing = executeHappy("invalid-post-missing-activation");
    fs.unlinkSync(postMissing.files.receipt); fs.unlinkSync(postMissing.files.activation); continueGrant(postMissing.f);
    const postBefore = fs.readFileSync(postMissing.f.settingsPath);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: postMissing.f.frozen }), ["R4_RECOVERY_ACTIVATION_MISSING"]);
    assert(!fs.existsSync(postMissing.files.activation) && fs.readFileSync(postMissing.f.settingsPath).equals(postBefore), "settings-post missing activation was mutated");

    const receiptMissing = executeHappy("invalid-receipt-missing-activation");
    fs.writeFileSync(receiptMissing.f.settingsPath, receiptMissing.f.settingsRaw, { mode: 0o600 }); fs.unlinkSync(receiptMissing.files.activation); continueGrant(receiptMissing.f);
    const receiptBefore = fs.readFileSync(receiptMissing.files.receipt);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: receiptMissing.f.frozen }), ["R4_RECOVERY_ACTIVATION_MISSING"]);
    assert(!fs.existsSync(receiptMissing.files.activation) && fs.readFileSync(receiptMissing.files.receipt).equals(receiptBefore), "receipt-present missing activation was mutated");

    const mismatch = makeFixture("invalid-activation-mismatch"); grant(mismatch);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: mismatch.frozen, testHooks: { beforeSettingsCas() { throw new Error("stop-before-cas"); } } }), ["stop-before-cas"]);
    const mismatchFiles = operationFiles(mismatch);
    const foreignActivation = JSON.parse(fs.readFileSync(mismatchFiles.activation, "utf8"));
    foreignActivation.audit_target = path.join(mismatch.root, "foreign-audit.jsonl");
    delete foreignActivation.activation_object_hash;
    foreignActivation.activation_object_hash = jcsSha256Hex(foreignActivation);
    fs.writeFileSync(mismatchFiles.activation, `${canonicalizeJcs(foreignActivation)}\n`, { mode: 0o600 }); continueGrant(mismatch);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: mismatch.frozen }), ["R4_RECOVERY_ACTIVATION_MISMATCH"]);
    assert(fs.readFileSync(mismatch.settingsPath, "utf8") === mismatch.settingsRaw, "mismatched activation changed settings");
  });

  await check("deterministic create-only pending recovers only through fresh continue at all three crash points", () => {
    const cases = [
      ["intent", "before_hardlink"], ["intent", "after_hardlink"], ["intent", "after_unlink"],
      ["activation", "before_hardlink"], ["activation", "after_hardlink"], ["activation", "after_unlink"],
      ["receipt", "before_hardlink"], ["receipt", "after_hardlink"], ["receipt", "after_unlink"],
    ];
    for (const [kind, point] of cases) {
      const f = makeFixture(`crash-${kind}-${point}`); grant(f);
      const targetBefore = fs.readFileSync(f.sessionPath);
      const targetIdentityBefore = fs.lstatSync(f.sessionPath);
      expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: f.frozen, testHooks: { createOnlyCrash: { kind, point } } }), ["CREATE_ONLY_SIMULATED_CRASH"]);
      const gateAfterCrash = runtimeGate(f);
      if (kind === "receipt" && point === "after_unlink") assert(gateAfterCrash.ok === true, "exact final receipt after unlink was not readable");
      else assert(gateAfterCrash.ok === false, `${kind}/${point} crash was runtime-authorized`);
      expectFailure(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: f.frozen }), `${kind}/${point} repeated execute did not stop`);
      continueGrant(f);
      const resumed = r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: f.frozen });
      assert(["bound", "terminal_verified"].includes(resumed.status), `${kind}/${point} did not recover`);
      if (kind === "intent" && point === "after_unlink") assert(resumed.status === "bound" && resumed.settings_cas === "written", "natural intent final-only window did not reconstruct activation then CAS");
      assert(runtimeGate(f).ok === true, `${kind}/${point} did not close runtime gate`);
      for (const family of ["intents", "activations", "receipts"]) assert(fs.readdirSync(path.join(f.controlRoot, family)).every((name) => /^[0-9a-f]{64}\.json$/.test(name)), `${kind}/${point} left pending temp`);
      const targetIdentityAfter = fs.lstatSync(f.sessionPath);
      assert(fs.readFileSync(f.sessionPath).equals(targetBefore) && targetIdentityAfter.dev === targetIdentityBefore.dev && targetIdentityAfter.ino === targetIdentityBefore.ino && targetIdentityAfter.nlink === targetIdentityBefore.nlink, `${kind}/${point} changed target session bytes/identity`);
    }
  });

  await check("foreign pending and non-distinct session bindings fail closed without cleanup", () => {
    const f = makeFixture("foreign-pending"); grant(f);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: f.frozen, testHooks: { createOnlyCrash: { kind: "intent", point: "before_hardlink" } } }), ["CREATE_ONLY_SIMULATED_CRASH"]);
    const foreign = `.${h("foreign-operation")}.activation.pending`;
    fs.writeFileSync(path.join(f.controlRoot, "activations", foreign), "foreign\n", { mode: 0o600 });
    continueGrant(f);
    const settingsBefore = fs.readFileSync(f.settingsPath);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "continue", frozen: f.frozen }), ["R4_FOREIGN_OR_PENDING"]);
    assert(fs.existsSync(path.join(f.controlRoot, "activations", foreign)), "foreign temp was cleaned");
    assert(fs.readFileSync(f.settingsPath).equals(settingsBefore), "foreign pending path changed settings");
    const aliased = { ...makeFixture("same-binding").frozen };
    aliased.authorization_transcript_binding = aliased.target_session_binding;
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: aliased }), ["R4_SESSION_BINDINGS_NOT_DISTINCT"]);
  });

  await check("publish-time target/auth TOCTOU mismatches are zero-write; longer target append preserves exact first prefix", () => {
    const authRace = makeFixture("auth-toctou"); grant(authRace);
    const settingsBefore = fs.readFileSync(authRace.settingsPath);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: authRace.frozen, testHooks: { beforeFirstPublish() { appendUser(authRace, "not an authorization", "foreign-latest-user"); } } }), ["TRUSTED_TRANSCRIPT_EXACT_TEXT", "R4_AUTHORIZATION_TOCTOU"]);
    assert(!fs.existsSync(authRace.controlRoot) && !fs.existsSync(authRace.rollbackTarget), "auth TOCTOU published roots");
    assert(fs.readFileSync(authRace.settingsPath).equals(settingsBefore), "auth TOCTOU changed settings");

    const targetRace = makeFixture("target-toctou"); grant(targetRace);
    const targetRaw = fs.readFileSync(targetRace.sessionPath);
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: targetRace.frozen, testHooks: { beforeFirstPublish() { const changed = Buffer.from(targetRaw); changed[0] = 0x20; fs.writeFileSync(targetRace.sessionPath, changed, { mode: 0o600 }); } } }), ["TRUSTED_TRANSCRIPT", "R4_SESSION_BINDING"]);
    assert(!fs.existsSync(targetRace.controlRoot) && !fs.existsSync(targetRace.rollbackTarget), "target TOCTOU published roots");

    const appendOnly = makeFixture("target-longer-prefix");
    const rows = fs.readFileSync(appendOnly.sessionPath, "utf8").trimEnd().split("\n").map(JSON.parse);
    const timestamp = new Date().toISOString();
    fs.appendFileSync(appendOnly.sessionPath, `${JSON.stringify({ type: "custom", customType: "sandbox-append", data: { append_only: true }, id: h("target-append").slice(0, 16), parentId: rows.at(-1).id, timestamp })}\n`);
    grant(appendOnly);
    const result = r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: appendOnly.frozen });
    assert(result.status === "bound" && runtimeGate(appendOnly).ok === true, "valid longer target prefix did not preserve first-prefix binding");
  });

  await check("receipt stale/cross-session/replay and foreign runtime objects fail closed", () => {
    const first = executeHappy("receipt-source");
    const raw = fs.readFileSync(first.files.receipt, "utf8");
    fs.writeFileSync(first.files.receipt, raw.replace('"exactly_once":true', '"exactly_once":false'));
    assert(runtimeGate(first.f).ok === false, "tampered stale receipt passed");
    const second = makeFixture("receipt-target", { sessionId: "receipt-target" });
    const post = r4.renderD3V2R4SettingsPost(JSON.parse(second.settingsRaw), second.frozen.desired_settings); fs.writeFileSync(second.settingsPath, post, { mode: 0o600 });
    fs.cpSync(first.f.controlRoot, second.controlRoot, { recursive: true });
    assert(runtimeGate(second).ok === false, "cross-session replay passed");
    const foreign = executeHappy("foreign-runtime");
    fs.writeFileSync(path.join(foreign.f.controlRoot, "receipts", `${h("foreign")}.json`), "{}\n");
    assert(runtimeGate(foreign.f).ok === false, "foreign receipt passed");
    const completion = executeHappy("completion-coordinate-tamper");
    const forgedReceipt = JSON.parse(fs.readFileSync(completion.files.receipt, "utf8"));
    const forgedCoordinate = { ...forgedReceipt.completion_authorization.coordinate, text_sha256: h("forged-completion-text") };
    delete forgedCoordinate.coordinate_hash;
    forgedCoordinate.coordinate_hash = jcsSha256Hex(forgedCoordinate);
    forgedReceipt.completion_authorization = { ...forgedReceipt.completion_authorization, coordinate: forgedCoordinate, coordinate_hash: forgedCoordinate.coordinate_hash };
    delete forgedReceipt.receipt_hash;
    forgedReceipt.receipt_hash = jcsSha256Hex(forgedReceipt);
    fs.writeFileSync(completion.files.receipt, `${canonicalizeJcs(forgedReceipt)}\n`, { mode: 0o600 });
    assert(runtimeGate(completion.f).ok === false, "forged completion authorization coordinate passed");
  });

  await check("ancestor symlink and post-lock ancestor swap fail closed", () => {
    const real = makeFixture("symlink-real");
    const aliasRoot = path.join(tmp, "symlink-alias"); fs.symlinkSync(real.root, aliasRoot);
    expectCode(() => r4.captureD3V2R4SettingsPrestate(path.join(aliasRoot, "settings.json")), ["R4_ANCESTOR_UNSAFE"]);
    const swap = makeFixture("ancestor-swap"); grant(swap);
    const originalParent = swap.root; const backup = `${swap.root}.held`;
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: swap.frozen, testHooks: { beforeSettingsCas() { fs.renameSync(originalParent, backup); fs.mkdirSync(originalParent); fs.writeFileSync(path.join(originalParent, "settings.json"), '{"foreign":true}\n', { mode: 0o600 }); } } }), ["R4_SETTINGS_CAS_RACE", "R4_FILE", "directory_missing"]);
    assert(fs.readFileSync(path.join(originalParent, "settings.json"), "utf8") === '{"foreign":true}\n');
  });

  await check("non-Linux/proc-unavailable and sandbox production hard paths fail closed", () => {
    expectCode(() => r4.assertR4PlatformBoundary("darwin"), ["R4_PROCFD_UNAVAILABLE"]);
    expectCode(() => r4.assertR4PlatformBoundary("linux", path.join(tmp, "missing-proc")), ["R4_PROCFD_UNAVAILABLE"]);
    const f = makeFixture("hardpath-refuse"); grant(f);
    const hard = { ...f.frozen, control_root: r4.D3_V2_R4_PRODUCTION_CONTROL_ROOT, operator_audit_path: r4.D3_V2_R4_PRODUCTION_OPERATOR_AUDIT, rollback_target: r4.D3_V2_R4_PRODUCTION_ROLLBACK_ROOT };
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: hard }), ["R4_SANDBOX_PRODUCTION_PATH"]);
    const aliased = { ...f.frozen, rollback_target: f.frozen.control_root };
    expectCode(() => r4.executeD3V2R4BindOperator({ target: "sandbox", mode: "execute", frozen: aliased }), ["R4_CONTROL_ROLLBACK_ALIAS"]);
  });

  await check("production CLI rejects authority/path overrides", () => {
    const cli = path.join(repoRoot, r4.D3_V2_R4_PRODUCTION_CLI);
    for (const flag of ["--force", "--yes", "--session", "--authorization-json", "--target"]) {
      const result = spawnSync(process.execPath, [cli, flag], { encoding: "utf8" });
      assert(result.status !== 0 && result.stderr.includes("forbidden"), `${flag} was accepted`);
    }
  });

  await check("real production default preview is exact frozen bytes, protected-zero-write, and strace has no mutating syscall", () => {
    const paths = evidence.protectedD3V2R4ProductionPaths(repoRoot);
    assert(!paths.includes(path.resolve(r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH)), "active authorization transcript entered generic stable snapshot");
    assert(!paths.includes(path.resolve(path.dirname(r4.D3_V2_R4_PRODUCTION_AUTHORIZATION_SESSION_PATH))), "active authorization transcript parent entered generic stable snapshot");
    const before = core.captureProtectedPrestate(paths);
    const cli = path.join(repoRoot, r4.D3_V2_R4_PRODUCTION_CLI);
    const trace = path.join(tmp, "preview.strace");
    const syscalls = "open,openat,openat2,creat,rename,renameat,renameat2,unlink,unlinkat,mkdir,mkdirat,rmdir,link,linkat,symlink,symlinkat,truncate,ftruncate,chmod,fchmod,chown,fchown,fsync,fdatasync,mknod,mknodat";
    const result = spawnSync("strace", ["-f", "-qq", "-o", trace, "-e", `trace=${syscalls}`, process.execPath, cli], { cwd: repoRoot, encoding: "utf8", timeout: 600000, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
    const after = core.captureProtectedPrestate(paths);
    assert(result.status === 0, result.stderr);
    const committed = fs.readFileSync(path.join(repoRoot, r4.D3_V2_R4_PREVIEW_RELATIVE), "utf8");
    assert(result.stdout === committed, "CLI preview bytes differ from frozen preview evidence");
    const preview = JSON.parse(result.stdout);
    assert(preview.authorization_status === "NOT_AUTHORIZED" && preview.status === "S2_NOT_AUTHORIZED" && preview.revision === "R4.1" && preview.executable === false);
    assert(preview.target_session_binding.session_id !== preview.authorization_transcript_binding.session_id);
    assert(preview.preview_stability_policy.authorization_session.includes("append_tolerant_frozen_prefix"));
    assert(Object.values(preview.assertions).every((value) => value === true), "preview contains a false or literal-placeholder assertion");
    assert(preview.authorization_transcript_binding.session_file.session_id === preview.authorization_transcript_binding.session_id);
    assert(/^[0-9a-f]{64}$/.test(preview.authorization_transcript_binding.session_file.header_sha256));
    assert(canonicalizeJcs(before) === canonicalizeJcs(after), "real production preview changed protected paths");
    const traceRaw = fs.readFileSync(trace, "utf8");
    const mutating = traceRaw.split("\n").filter((line) => /\b(creat|rename(?:at2?)?|unlink(?:at)?|mkdir(?:at)?|rmdir|link(?:at)?|symlink(?:at)?|truncate|ftruncate|chmod|fchmod|chown|fchown|fsync|fdatasync|mknod(?:at)?)\(/.test(line) || (!line.includes('"/dev/null"') && /\bopen(?:at2?|)\(.*O_(?:WRONLY|RDWR|CREAT|TRUNC|APPEND)/.test(line)));
    assert(mutating.length === 0, `preview issued mutating syscalls: ${mutating.slice(0, 5).join(" | ")}`);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures.length) {
  process.stderr.write(`R4 smoke failed: ${failures.length}/${passed + failures.length}\n`);
  process.exitCode = 1;
} else process.stdout.write(`R4 smoke passed: ${passed} checks\n`);
