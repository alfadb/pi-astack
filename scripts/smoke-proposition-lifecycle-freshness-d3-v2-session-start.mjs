#!/usr/bin/env node
/**
 * ADR0040 D3-v2 session_start adapter + real fakePi E2E smoke (R3.9).
 * All mutation stays under system temp. Production D3/settings/legacy are snapshotted.
 *
 * Covers: activation binding + settings_mutation closed exact equality, single fence/
 * nonce consistency/strip, nested/orphan/mixed/blank fence sanitizer (outside bytes
 * preserved), D3/audit failure sanitized zero-rule no fallback, foreign sanitize,
 * exact own idempotent, halt + pending-intent halt, unselected byte-stable, fakePi
 * session_start+before_agent_start, host wiring predicate, captured extractor payload
 * strip, audit adversarial (v1/offset/tail/hash), rollback per-face crash windows with
 * correct parent_hash, stale/out-of-order intent reject, stateRoot===rollback_target,
 * sandbox hard-path over real control roots, Door1 full closed-schema (no trimmed),
 * production triple-auth exact-path positive under /tmp, hard-path never called,
 * R3.5 ancestor-symlink negatives (/tmp alias→control root, /tmp alias→agent) refused
 * before any production byte change, activationRootHasNoBound extensionless bound fixture,
 * R3.6 retained parent-fd walk: after-hold ancestor swap write lands on original inode
 * not production; re-walk fails closed; closed-set one-shot sandbox operator hook with
 * env token refuses production write (snapshot only),
 * R3.7 session_id single safe filename component + path-helper containment (../ absolute
 * backslash dot rejected; sessionTaintPath/receipt/intents cannot escape stateRoot),
 * rehearse static no absolute write + procfd-anchored fixture create,
 * R3.8 rehearse settings/session/quarantine forced under stateRoot with dynamic external
 * sentinel negatives; live selector fail-closed unsafe; session_id 127/128/129 vs NAME_MAX
 * 255 component bound; `${id}.json/.jsonl` at 128 boundary passes; dossier continuous
 * build/verify stability, production zero-write.
 * R3.9: selector normalize/select apply isSafeSessionIdComponent on raw values only
 * (no trim); empty / pure-whitespace / leading-trailing-whitespace / null entries
 * fail-closed disabled/empty/cleared pins without missing-pin throw; unsafe current
 * session id unselected with original identity preserved for safe ids. Smoke ≥21 checks.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const core = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-production-core.ts"));
const adapter = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start.ts"));
const audit = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-runtime-audit.ts"));
const control = jiti(path.join(repoRoot, "extensions/abrain/rule-injector/proposition-lifecycle-freshness-d3-v2-session-start-control.ts"));
const { canonicalizeJcs, sha256Hex, jcsSha256Hex } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const EXPECTED = Object.freeze({
  selection_hash: "94edfbbdf354c7df5a45337fb29365f67e12c6a792f924805cf874fe1f42ae35",
  head_hash: "fd717f2ab5acb59267bd7ff8377a5197cf500c42fcb60b837eeabf0d077bcfea",
  proof_hash: "d47fe0eac9aac077c25abb172c0992ab7e378ac7886983a0f08779fbc0e1a2f2",
  intent_hash: "2175f55c4cbcbea6355557db597cc70f2008f6b147c7292cd7bb189b60ddc5e1",
  stable_bundle_hash: "6a74d84818ea9ab9702c472bd38a96b31eec60f73d4d2adf9402967ca42a7398",
  p2a_bundle_hash: "1768de48d0c3bcb2c1e12605829d22e307973605f5c648c66c3c610bf3f40f34",
});

const PROTECTED = Object.freeze([
  core.D3_PUB_HARD_ROOT,
  "/home/worker/.abrain/.state/sediment/proposition-policy-stable-view/v1",
  "/home/worker/.pi/agent/pi-astack-settings.json",
]);

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-d3-v2-r32-"));
const activationRoot = path.join(tmpRoot, "activations");
// Allow production loader to accept sandbox activation root without affecting defaults when unset.
process.env.PI_ASTACK_D3V2_ACTIVATION_ROOT = activationRoot;
const failures = [];
let passed = 0;
function assert(value, message = "assertion failed") { if (!value) throw new Error(message); }
async function check(name, operation) {
  try { await operation(); passed += 1; process.stdout.write(`  ok    ${name}\n`); }
  catch (error) { failures.push({ name, error }); process.stdout.write(`  FAIL  ${name}\n        ${error?.stack ?? error}\n`); }
}
function snapshot(paths) { return core.captureProtectedPrestate(paths); }
function sessionManager(sessionId, file) {
  return { getSessionId: () => sessionId, getSessionFile: () => file };
}
function writeSession(file, body = `{"session":true}\n`) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, "utf8");
}
function cloneProductionRoot(label) {
  const root = path.join(tmpRoot, label, "proposition-lifecycle-freshness", "v2");
  fs.cpSync(core.D3_PUB_HARD_ROOT, root, { recursive: true });
  return root;
}
function nonceOf(label) {
  return createHash("sha256").update(`d3v2-r32:${label}`).digest("hex");
}

function writeBoundActivation(args) {
  fs.mkdirSync(activationRoot, { recursive: true, mode: 0o700 });
  const activationPath = path.join(activationRoot, `${args.label}.json`);
  const sessionBinding = adapter.captureSessionFileBinding(args.sessionFile);
  const quarantineTarget = path.join(tmpRoot, "quarantine", `${args.sessionId}-${args.label}.jsonl`);
  fs.mkdirSync(path.dirname(quarantineTarget), { recursive: true, mode: 0o700 });
  const settingsMutation = {
    enabled: true,
    selector: { session_ids: [args.sessionId] },
    expectedSelectionHash: EXPECTED.selection_hash,
    expectedHeadHash: EXPECTED.head_hash,
    expectedProofHash: EXPECTED.proof_hash,
    expectedStableBundleHash: EXPECTED.stable_bundle_hash,
    expectedIntentHash: EXPECTED.intent_hash,
    adapterManifestHash: args.manifestHash,
    activationObjectPath: activationPath,
    maxReadBytes: 65536,
  };
  const activation = adapter.buildD3V2SessionStartActivationObject({
    sessionId: args.sessionId,
    activationNonce: args.activationNonce,
    authorizationStatus: "AUTHORIZED",
    authorizationCoordinate: {
      schema_version: "adr0040-d3-v2-session-start-sandbox-authorization/v1",
      mode: "sandbox_test",
      label: args.label,
    },
    d3Identities: {
      selection_hash: EXPECTED.selection_hash,
      head_hash: EXPECTED.head_hash,
      proof_hash: EXPECTED.proof_hash,
      intent_hash: EXPECTED.intent_hash,
      stable_bundle_hash: EXPECTED.stable_bundle_hash,
      p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
      generation: 0,
      selection_seq: 0,
    },
    adapterManifestHash: args.manifestHash,
    settingsMutation,
    auditTarget: args.auditFile ?? path.join(tmpRoot, "audit", `${args.label}.jsonl`),
    rollbackTarget: args.rollbackTarget ?? path.join(tmpRoot, "rollback", args.label),
    sessionFile: sessionBinding,
    quarantineTarget,
    mode: "bound",
  });
  fs.mkdirSync(path.dirname(activation.audit_target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(activation.rollback_target, { recursive: true, mode: 0o700 });
  const raw = `${canonicalizeJcs(activation)}\n`;
  fs.writeFileSync(activationPath, raw, "utf8");
  return {
    activationPath,
    activationHash: activation.activation_object_hash,
    activation,
    settingsMutation,
    quarantineTarget,
    sessionBinding,
  };
}

function enabledSettings(sessionIds, manifestHash, activationPath, activationHash, extra = {}) {
  return adapter.resolveD3V2SessionStartInjectionSettings({
    enabled: true,
    selector: { session_ids: sessionIds },
    expectedSelectionHash: EXPECTED.selection_hash,
    expectedHeadHash: EXPECTED.head_hash,
    expectedProofHash: EXPECTED.proof_hash,
    expectedStableBundleHash: EXPECTED.stable_bundle_hash,
    expectedIntentHash: EXPECTED.intent_hash,
    adapterManifestHash: manifestHash,
    activationObjectPath: activationPath,
    activationObjectHash: activationHash,
    maxReadBytes: 65536,
    ...extra,
  });
}

process.stdout.write("ADR0040 D3-v2 session_start adapter + real fakePi E2E smoke (R3.9)\n");
const before = snapshot(PROTECTED);
const manifest = adapter.buildD3V2SessionStartAdapterManifest({ repoRoot });
const sessionId = "019f77f6-d3v2-r32-smoke-session";
const sessionFile = path.join(tmpRoot, "sessions", `${sessionId}.jsonl`);
writeSession(sessionFile);

try {
  await check("adapter is default-off with empty selector and empty expected bindings", () => {
    const settings = adapter.resolveD3V2SessionStartInjectionSettings(undefined);
    assert(settings.enabled === false && settings.selector.session_ids.length === 0);
    assert(settings.expectedSelectionHash === null && settings.adapterManifestHash === null);
    assert(settings.activationObjectPath === null && settings.activationObjectHash === null);
    const sel = adapter.selectD3V2SessionStartSession({ settings, sessionManager: sessionManager(sessionId, sessionFile) });
    assert(sel.selected === false && sel.reason === "disabled");
  });

  await check("adapter static dependency closure covers critical exact-byte set and is self-hashed", () => {
    const second = adapter.buildD3V2SessionStartAdapterManifest({ repoRoot });
    assert(canonicalizeJcs(manifest) === canonicalizeJcs(second), "manifest nondeterministic");
    adapter.validateD3V2SessionStartAdapterManifest(manifest);
    const paths = new Set(manifest.graph.files.map((f) => f.path));
    for (const required of adapter.D3_V2_SESSION_START_CRITICAL_REQUIRED_PATHS) {
      assert(paths.has(required), `missing critical ${required}`);
      assert(manifest.critical_required_paths.includes(required), `critical list missing ${required}`);
    }
    assert(manifest.graph.roots.includes(adapter.D3_V2_SESSION_START_CONTROL_MODULE));
    assert(manifest.graph.explicit_files.includes(adapter.D3_V2_SESSION_START_RULE_INJECTOR_INDEX));
    assert(manifest.graph.explicit_files.includes(adapter.D3_V2_SESSION_START_ABRAIN_HOST_ENTRY));
    assert(manifest.graph.explicit_files.includes(adapter.D3_V2_SESSION_START_SETTINGS_SCHEMA));
    assert(paths.has(adapter.D3_V2_SESSION_START_ABRAIN_HOST_ENTRY), "host entry missing from graph");
    const wiring = adapter.evaluateD3V2SessionStartHostWiringPredicate(repoRoot);
    assert(wiring.ok === false && wiring.registers_session_start_surface === false,
      `retired D3 host wiring unexpectedly remains reachable: ${JSON.stringify(wiring)}`);
  });

  await check("enabled=true without activation path/hash fails closed at settings resolve", () => {
    let threw = false;
    try {
      adapter.resolveD3V2SessionStartInjectionSettings({
        enabled: true,
        selector: { session_ids: [sessionId] },
        expectedSelectionHash: EXPECTED.selection_hash,
        expectedHeadHash: EXPECTED.head_hash,
        expectedProofHash: EXPECTED.proof_hash,
        expectedStableBundleHash: EXPECTED.stable_bundle_hash,
        adapterManifestHash: manifest.manifest_hash,
      });
    } catch { threw = true; }
    assert(threw, "enabled without activation must throw");
  });

  await check("settings_mutation expectedIntentHash/maxReadBytes/selector negatives", () => {
    const base = {
      enabled: true,
      selector: { session_ids: [sessionId] },
      expectedSelectionHash: EXPECTED.selection_hash,
      expectedHeadHash: EXPECTED.head_hash,
      expectedProofHash: EXPECTED.proof_hash,
      expectedStableBundleHash: EXPECTED.stable_bundle_hash,
      expectedIntentHash: EXPECTED.intent_hash,
      adapterManifestHash: manifest.manifest_hash,
      activationObjectPath: path.join(activationRoot, "neg.json"),
      maxReadBytes: 65536,
    };
    let badIntent = false;
    try {
      adapter.normalizeSettingsMutationClosed({ ...base, expectedIntentHash: "NOT_A_HASH" }, { requireExecutableShape: true });
    } catch { badIntent = true; }
    assert(badIntent, "invalid expectedIntentHash must fail");
    let badMax = false;
    try {
      adapter.normalizeSettingsMutationClosed({ ...base, maxReadBytes: 0 }, { requireExecutableShape: true });
    } catch { badMax = true; }
    assert(badMax, "maxReadBytes < 1 must fail");
    let badSelector = false;
    try {
      adapter.normalizeSettingsMutationClosed({
        ...base,
        selector: { session_ids: [sessionId], extra: true },
      }, { requireExecutableShape: true });
    } catch { badSelector = true; }
    assert(badSelector, "selector unknown field must fail");
    let badSelectorType = false;
    try {
      adapter.normalizeSettingsMutationClosed({ ...base, selector: "nope" }, { requireExecutableShape: true });
    } catch { badSelectorType = true; }
    assert(badSelectorType, "selector non-object must fail");
  });

  await check("sandbox clone injects exact selected view via bound activation", () => {
    const controlRoot = cloneProductionRoot("happy");
    const act = writeBoundActivation({
      label: "happy",
      sessionId,
      sessionFile,
      activationNonce: nonceOf("happy"),
      manifestHash: manifest.manifest_hash,
    });
    const settings = enabledSettings([sessionId], manifest.manifest_hash, act.activationPath, act.activationHash);
    const result = adapter.readD3V2SessionStartForRuntime({
      abrainHome: path.join(tmpRoot, "happy-abrain"),
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      controlRoot,
      adapterManifestHash: manifest.manifest_hash,
      activationRoot,
    });
    assert(result.ok, `expected ok got ${JSON.stringify(result)}`);
    assert(result.selectionHash === EXPECTED.selection_hash);
    assert(result.activationNonce === nonceOf("happy"));
    assert(result.activationObjectHash === act.activationHash);
    assert(result.itemCount === 1 && result.viewBytes === 341);
    const injection = adapter.composeD3V2SessionStartInjection(result);
    assert(injection.includes(adapter.D3_V2_SESSION_START_SOURCE_MARKER));
    assert(injection.includes(`activation_object_hash=${act.activationHash}`));
    assert(injection.includes(`session_id=${sessionId}`));
    assert((injection.match(/BEGIN_ABRAIN_RULES/g) || []).length === 1);
  });

  await check("view.json leaf tamper is rejected", () => {
    const controlRoot = cloneProductionRoot("tamper-view");
    const bundleDir = path.join(controlRoot, "stable", "v1", "bundles", EXPECTED.stable_bundle_hash);
    const viewPath = path.join(bundleDir, "view.json");
    const view = JSON.parse(fs.readFileSync(viewPath, "utf8"));
    view.items[0].statement = "TAMPERED STATEMENT THAT MUST NOT INJECT";
    fs.writeFileSync(viewPath, `${JSON.stringify(view)}\n`);
    const act = writeBoundActivation({
      label: "tamper", sessionId, sessionFile,
      activationNonce: nonceOf("tamper"), manifestHash: manifest.manifest_hash,
    });
    const settings = enabledSettings([sessionId], manifest.manifest_hash, act.activationPath, act.activationHash);
    const result = adapter.readD3V2SessionStartForRuntime({
      abrainHome: path.join(tmpRoot, "tamper-abrain"),
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      controlRoot,
      adapterManifestHash: manifest.manifest_hash,
      activationRoot,
    });
    assert(result.ok === false, `tampered view.json must fail: ${JSON.stringify(result)}`);
  });

  await check("manifest drift fails closed", () => {
    const controlRoot = cloneProductionRoot("manifest-drift");
    const act = writeBoundActivation({
      label: "drift", sessionId, sessionFile,
      activationNonce: nonceOf("drift"), manifestHash: manifest.manifest_hash,
    });
    const settings = enabledSettings([sessionId], manifest.manifest_hash, act.activationPath, act.activationHash);
    const result = adapter.readD3V2SessionStartForRuntime({
      abrainHome: path.join(tmpRoot, "drift-abrain"),
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      controlRoot,
      adapterManifestHash: "a".repeat(64),
      activationRoot,
    });
    assert(result.ok === false && result.reason === "adapter_manifest_mismatch", JSON.stringify(result));
  });

  await check("exclusive runtime audit v2-only chain + adversarial reject v1/offset/tail", () => {
    const controlRoot = cloneProductionRoot("audit");
    const act = writeBoundActivation({
      label: "audit", sessionId, sessionFile,
      activationNonce: nonceOf("audit-chain"), manifestHash: manifest.manifest_hash,
    });
    const settings = enabledSettings([sessionId], manifest.manifest_hash, act.activationPath, act.activationHash);
    const result = adapter.readD3V2SessionStartForRuntime({
      abrainHome: path.join(tmpRoot, "audit-abrain"),
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      controlRoot,
      adapterManifestHash: manifest.manifest_hash,
      activationRoot,
    });
    assert(result.ok, JSON.stringify(result));
    const activationNonce = result.activationNonce;
    const injection = adapter.composeD3V2SessionStartInjection(result);
    const row = audit.buildD3V2SessionStartRuntimeAuditRow({
      sessionId,
      latestUserText: "probe turn",
      decision: "d3_v2_session_start_injected",
      reason: result.reason,
      renderedPrompt: `BASE\n\n${injection}`,
      d3v2: result,
      activationNonce,
      adapterManifestHash: manifest.manifest_hash,
      activationObjectHash: result.activationObjectHash,
      authorizationCoordinateHash: result.authorizationCoordinateHash,
      causalAnchor: { session_id: sessionId, turn: "smoke-1" },
    });
    assert(row.activation_object_hash === result.activationObjectHash);
    const auditFile = path.join(tmpRoot, "audit-chain.jsonl");
    const appended = audit.appendD3V2SessionStartRuntimeAudit(row, auditFile);
    assert(appended.ok, appended.error);
    assert(appended.pre_offset === 0 && appended.parent_hash === null);
    const second = audit.appendD3V2SessionStartRuntimeAudit({
      ...row,
      activation_nonce: nonceOf("audit-chain-2"),
      timestamp: new Date(Date.now() + 1).toISOString(),
    }, auditFile);
    assert(second.ok, second.error);
    assert(second.parent_hash === appended.self_hash);

    // Adversarial: v1 row
    const v1File = path.join(tmpRoot, "audit-v1.jsonl");
    fs.writeFileSync(v1File, `${JSON.stringify({ schema: audit.D3_V2_SESSION_START_RUNTIME_AUDIT_SCHEMA, version: 1, self_hash: "b".repeat(64) })}\n`);
    const v1 = audit.appendD3V2SessionStartRuntimeAudit(row, v1File);
    assert(v1.ok === false, "v1 must fail");

    // Adversarial: tail truncate
    const tailFile = path.join(tmpRoot, "audit-tail.jsonl");
    fs.writeFileSync(tailFile, `${canonicalizeJcs({ hello: 1 })}\n`.slice(0, -1)); // no LF
    const tail = audit.appendD3V2SessionStartRuntimeAudit(row, tailFile);
    assert(tail.ok === false, "tail truncate must fail");

    // Adversarial: offset gap (write a valid-looking first row with wrong pre_offset)
    const gapFile = path.join(tmpRoot, "audit-gap.jsonl");
    const gapBase = {
      schema: audit.D3_V2_SESSION_START_RUNTIME_AUDIT_SCHEMA,
      version: 2,
      timestamp: new Date().toISOString(),
      pid: process.pid,
      session_id: sessionId,
      latest_user_text_sha256: "c".repeat(64),
      latest_user_text_bytes: 1,
      decision: "selected_zero_injection",
      reason: "gap",
      selection_hash: null, head_hash: null, proof_hash: null, intent_hash: null,
      stable_bundle_hash: null, adapter_manifest_hash: null, surface_combination_hash: null,
      view_md_hash: null, view_bytes: null, item_count: null,
      rendered_prompt_sha256: "d".repeat(64), rendered_prompt_bytes: 0,
      begin_fence_count: 0, end_fence_count: 0,
      contains_d3_v2_marker: false, contains_policy_stable_marker: false,
      contains_compiled_marker: false, contains_legacy_catalog_marker: false,
      activation_nonce: nonceOf("gap"),
      activation_object_hash: null,
      authorization_coordinate_hash: null,
      causal_anchor: { session_id: sessionId },
      pre_offset: 99,
      parent_hash: null,
    };
    const gapSelf = jcsSha256Hex(gapBase);
    fs.writeFileSync(gapFile, `${canonicalizeJcs({ ...gapBase, self_hash: gapSelf })}\n`);
    const gap = audit.appendD3V2SessionStartRuntimeAudit(row, gapFile);
    assert(gap.ok === false, "offset gap must fail");
  });

  await check("control: success single fence; D3 fail sanitized zero; foreign sanitize; own idempotent; halt; unselected", () => {
    const controlRoot = cloneProductionRoot("control");
    const act = writeBoundActivation({
      label: "control", sessionId, sessionFile,
      activationNonce: nonceOf("control"),
      manifestHash: manifest.manifest_hash,
      auditFile: path.join(tmpRoot, "control-audit.jsonl"),
      rollbackTarget: path.join(tmpRoot, "rollback-control"),
    });
    const settings = enabledSettings([sessionId], manifest.manifest_hash, act.activationPath, act.activationHash);

    // success
    const ok = control.decideD3V2SessionStartControl({
      repoRoot,
      abrainHome: path.join(tmpRoot, "control-abrain"),
      cwd: tmpRoot,
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      currentSystemPrompt: "BASE PROMPT",
      latestUserText: "turn",
      controlRoot,
      auditFile: act.activation.audit_target,
      activationRoot,
    });
    assert(ok.kind === "selected_injected", JSON.stringify(ok));
    assert((ok.systemPrompt.match(/BEGIN_ABRAIN_RULES/g) || []).length === 1);
    assert(ok.activationNonce === nonceOf("control"));
    assert(ok.systemPrompt.includes(`activation_object_hash=${act.activationHash}`));
    assert(!ok.systemPrompt.includes("source=proposition-policy-stable-view"));

    // exact own idempotent
    const again = control.decideD3V2SessionStartControl({
      repoRoot,
      abrainHome: path.join(tmpRoot, "control-abrain"),
      cwd: tmpRoot,
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      currentSystemPrompt: ok.systemPrompt,
      latestUserText: "turn2",
      controlRoot,
      auditFile: act.activation.audit_target,
      activationRoot,
    });
    assert(again.kind === "selected_injected" && again.idempotent === true, JSON.stringify(again));
    assert(again.systemPrompt === ok.systemPrompt, "exact own must keep bytes");

    // foreign sanitize + reinject
    const foreign = `${ok.systemPrompt.replace(adapter.D3_V2_SESSION_START_SOURCE_MARKER, "source=proposition-policy-stable-view")}`;
    // Force foreign by changing source in place — may still parse as one fence.
    const foreignPrompt = `BASE\n\n<!-- BEGIN_ABRAIN_RULES session=${"f".repeat(64)} source=proposition-policy-stable-view (auto-managed by sediment, do not edit by hand) -->\nFOREIGN\n<!-- END_ABRAIN_RULES -->`;
    const foreignDecision = control.decideD3V2SessionStartControl({
      repoRoot,
      abrainHome: path.join(tmpRoot, "control-abrain"),
      cwd: tmpRoot,
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      currentSystemPrompt: foreignPrompt,
      latestUserText: "turn3",
      controlRoot,
      auditFile: path.join(tmpRoot, "foreign-audit.jsonl"),
      activationRoot,
    });
    assert(foreignDecision.kind === "selected_injected", JSON.stringify(foreignDecision));
    assert(!foreignDecision.systemPrompt.includes("FOREIGN"));
    assert(!foreignDecision.systemPrompt.includes("source=proposition-policy-stable-view"));
    assert((foreignDecision.systemPrompt.match(/BEGIN_ABRAIN_RULES/g) || []).length === 1);

    // D3 fail (bad control root) => sanitized zero
    const bad = control.decideD3V2SessionStartControl({
      repoRoot,
      abrainHome: path.join(tmpRoot, "control-abrain"),
      cwd: tmpRoot,
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      currentSystemPrompt: foreignPrompt,
      latestUserText: "turn4",
      controlRoot: path.join(tmpRoot, "does-not-exist-control"),
      auditFile: path.join(tmpRoot, "bad-d3-audit.jsonl"),
      activationRoot,
    });
    assert(bad.kind === "selected_zero_injection", JSON.stringify(bad));
    assert(typeof bad.systemPrompt === "string");
    assert(!bad.systemPrompt.includes("BEGIN_ABRAIN_RULES"), "zero injection must not keep foreign fence");
    assert(!bad.systemPrompt.includes("FOREIGN"));

    // halt
    const haltDir = path.join(act.activation.rollback_target, "halt");
    fs.mkdirSync(haltDir, { recursive: true });
    fs.writeFileSync(path.join(haltDir, `${nonceOf("control")}.json`), `${canonicalizeJcs({
      schema_version: "adr0040-d3-v2-session-start-halt/v1",
      activation_nonce: nonceOf("control"),
      session_id: sessionId,
      reason: "smoke_halt",
      auto_retry: false,
    })}\n`);
    const halted = control.decideD3V2SessionStartControl({
      repoRoot,
      abrainHome: path.join(tmpRoot, "control-abrain"),
      cwd: tmpRoot,
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      currentSystemPrompt: "BASE",
      latestUserText: "halt-turn",
      controlRoot,
      auditFile: path.join(tmpRoot, "halt-audit.jsonl"),
      activationRoot,
    });
    assert(halted.kind === "selected_zero_injection" && halted.reason === "halted", JSON.stringify(halted));

    // unselected
    const unselected = control.decideD3V2SessionStartControl({
      repoRoot,
      abrainHome: path.join(tmpRoot, "control-abrain"),
      cwd: tmpRoot,
      settings: enabledSettings(["other"], manifest.manifest_hash, act.activationPath, act.activationHash),
      sessionManager: sessionManager(sessionId, sessionFile),
      currentSystemPrompt: "BASE_UNCHANGED",
      latestUserText: "t",
      controlRoot,
      activationRoot,
    });
    assert(unselected.kind === "unselected");
  });

  await check("production fakePi boundary: retained D3 settings cannot restore a runtime call edge", async () => {
    const injectorSource = fs.readFileSync(path.join(repoRoot, "extensions/abrain/rule-injector/index.ts"), "utf8");
    assert(!injectorSource.includes("proposition-lifecycle-freshness-d3-v2-session-start-control"), "D3 control import remains in production injector");
    assert(!injectorSource.includes("decideD3V2SessionStartControl") && !injectorSource.includes("selectD3V2SessionStartSession"),
      "D3 runtime symbols remain in production injector");
    return;
    const controlRoot = cloneProductionRoot("fakepi");
    const act = writeBoundActivation({
      label: "fakepi", sessionId, sessionFile,
      activationNonce: nonceOf("fakepi"),
      manifestHash: manifest.manifest_hash,
      auditFile: path.join(tmpRoot, "fakepi-audit.jsonl"),
      rollbackTarget: path.join(tmpRoot, "rollback-fakepi"),
    });
    const settingsObj = {
      ruleInjector: {
        enabled: true,
        propositionLifecycleFreshnessD3V2SessionStartInjection: {
          enabled: true,
          selector: { session_ids: [sessionId] },
          expectedSelectionHash: EXPECTED.selection_hash,
          expectedHeadHash: EXPECTED.head_hash,
          expectedProofHash: EXPECTED.proof_hash,
          expectedStableBundleHash: EXPECTED.stable_bundle_hash,
          expectedIntentHash: EXPECTED.intent_hash,
          adapterManifestHash: manifest.manifest_hash,
          activationObjectPath: act.activationPath,
          activationObjectHash: act.activationHash,
          maxReadBytes: 65536,
        },
      },
    };
    const home = path.join(tmpRoot, "fake-home");
    fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    fs.writeFileSync(path.join(home, ".pi", "agent", "pi-astack-settings.json"), `${JSON.stringify(settingsObj, null, 2)}\n`);
    const abrainHome = path.join(tmpRoot, "fake-abrain");
    fs.mkdirSync(abrainHome, { recursive: true });

    // Load rule-injector with env overrides (subprocess isolation via jiti + env).
    const prev = {
      HOME: process.env.HOME,
      ABRAIN_ROOT: process.env.ABRAIN_ROOT,
      PI_ASTACK_D3V2_CONTROL_ROOT: process.env.PI_ASTACK_D3V2_CONTROL_ROOT,
      PI_ASTACK_D3V2_AUDIT_FILE: process.env.PI_ASTACK_D3V2_AUDIT_FILE,
      PI_ASTACK_D3V2_ACTIVATION_ROOT: process.env.PI_ASTACK_D3V2_ACTIVATION_ROOT,
      PI_ASTACK_D3V2_REPO_ROOT: process.env.PI_ASTACK_D3V2_REPO_ROOT,
      PI_ASTACK_ENABLE_TEST_HOOKS: process.env.PI_ASTACK_ENABLE_TEST_HOOKS,
    };
    process.env.HOME = home;
    process.env.ABRAIN_ROOT = abrainHome;
    process.env.PI_ASTACK_D3V2_CONTROL_ROOT = controlRoot;
    process.env.PI_ASTACK_D3V2_AUDIT_FILE = act.activation.audit_target;
    process.env.PI_ASTACK_D3V2_ACTIVATION_ROOT = activationRoot;
    process.env.PI_ASTACK_D3V2_REPO_ROOT = repoRoot;
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

    try {
      // Fresh jiti instance so module state is clean and env is visible.
      const jiti2 = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
      const ruleInjector = jiti2(path.join(repoRoot, "extensions/abrain/rule-injector/index.ts"));
      const handlers = new Map();
      const fakePi = {
        on(event, handler) { handlers.set(event, handler); },
        registerCommand() { /* ignore */ },
      };
      assert(typeof ruleInjector.default === "function", "default export must be activate function");
      ruleInjector.default(fakePi);
      assert(handlers.has("session_start"), "session_start handler missing");
      assert(handlers.has("before_agent_start"), "before_agent_start handler missing");

      const ctx = {
        cwd: tmpRoot,
        sessionManager: sessionManager(sessionId, sessionFile),
        ui: { setStatus() {}, notify() {} },
      };
      await handlers.get("session_start")({}, ctx);
      const nonce = ruleInjector.getCurrentRuleInjectionNonce();
      assert(nonce === nonceOf("fakepi"), `nonce mismatch: ${nonce}`);

      const beforeResult = await handlers.get("before_agent_start")({
        systemPrompt: "BASE PROMPT FROM PI",
        prompt: "user turn",
      }, ctx);
      assert(beforeResult && typeof beforeResult.systemPrompt === "string", "must return systemPrompt");
      assert((beforeResult.systemPrompt.match(/BEGIN_ABRAIN_RULES/g) || []).length === 1);
      assert(beforeResult.systemPrompt.includes(`session=${nonceOf("fakepi")}`));
      assert(beforeResult.systemPrompt.includes(`activation_object_hash=${act.activationHash}`));
      assert(ruleInjector.getCurrentRuleInjectionNonce() === nonceOf("fakepi"));

      // strip: rule body + fence metadata must not enter extractor
      const stripped = ruleInjector.stripCurrentRuleInjection(beforeResult.systemPrompt, ruleInjector.getCurrentRuleInjectionNonce());
      assert(stripped.includes("[ABRAIN_RULES_SECTION_REMOVED]"));
      assert(!stripped.includes("real production data") || !stripped.includes("BEGIN_ABRAIN_RULES"));
      assert(!stripped.includes("BEGIN_ABRAIN_RULES"));
      assert(!stripped.includes(act.activationHash));

      // unselected session keeps legacy path free (no v2 injection)
      const otherSession = "other-session-unselected";
      const otherFile = path.join(tmpRoot, "sessions", `${otherSession}.jsonl`);
      writeSession(otherFile);
      const unCtx = {
        cwd: tmpRoot,
        sessionManager: sessionManager(otherSession, otherFile),
        ui: { setStatus() {}, notify() {} },
      };
      // Re-activate is not needed; selection is per-call via settings. Other session is unselected.
      const un = await handlers.get("before_agent_start")({
        systemPrompt: "UNSELECTED_BASE_BYTES",
        prompt: "u",
      }, unCtx);
      // unselected may return undefined or legacy injection; must not contain d3-v2 source
      if (un && un.systemPrompt) {
        assert(!un.systemPrompt.includes("source=proposition-lifecycle-freshness-d3-v2"));
      }
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  await check("captured provider payload smoke: strip removes fence from continuation text parts", () => {
    const controlRoot = cloneProductionRoot("strip-payload");
    const act = writeBoundActivation({
      label: "strip", sessionId, sessionFile,
      activationNonce: nonceOf("strip"),
      manifestHash: manifest.manifest_hash,
    });
    const settings = enabledSettings([sessionId], manifest.manifest_hash, act.activationPath, act.activationHash);
    const result = adapter.readD3V2SessionStartForRuntime({
      abrainHome: path.join(tmpRoot, "strip-abrain"),
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      controlRoot,
      adapterManifestHash: manifest.manifest_hash,
      activationRoot,
    });
    assert(result.ok, JSON.stringify(result));
    const fence = adapter.composeD3V2SessionStartInjection(result);
    const providerText = `user said hi\n\n${fence}\n\nmore`;
    const stripped = adapter.stripSelectedActivationRuleFence(providerText, result.activationNonce);
    assert(!stripped.includes("BEGIN_ABRAIN_RULES"));
    assert(!stripped.includes(result.activationObjectHash));
    assert(!stripped.includes("real production data") || stripped.includes("[ABRAIN_RULES_SECTION_REMOVED]"));
    // unselected nonce: byte-stable
    const other = adapter.stripSelectedActivationRuleFence(providerText, "e".repeat(64));
    assert(other === providerText, "unselected strip must be byte-identical");
  });

  await check("fence nested/orphan/mixed/blank: managed regions removed, outside bytes preserved", () => {
    const outside = "PREFIX\t  keep  \n\n";
    const blankOutside = "A  \n\n\nB";
    // Nested: outer BEGIN contains inner BEGIN..END, then outer END
    const nested = `${outside}<!-- BEGIN_ABRAIN_RULES session=${"a".repeat(64)} source=x -->\nOUT\n<!-- BEGIN_ABRAIN_RULES session=${"b".repeat(64)} source=y -->\nIN\n<!-- END_ABRAIN_RULES -->\nMID\n<!-- END_ABRAIN_RULES -->${blankOutside}`;
    const nestedSan = adapter.sanitizeManagedRuleFences(nested);
    assert(nestedSan === `${outside}${blankOutside}`, `nested sanitize must preserve outside exactly: ${JSON.stringify(nestedSan)}`);
    assert(!nestedSan.includes("BEGIN_ABRAIN_RULES"));
    // Orphan END left intact (not a managed region start)
    const orphan = `${outside}<!-- END_ABRAIN_RULES -->trail`;
    assert(adapter.sanitizeManagedRuleFences(orphan) === orphan, "orphan END must not be touched");
    // Mixed: two sequential fences
    const mixed = `${outside}<!-- BEGIN_ABRAIN_RULES session=${"c".repeat(64)} source=x -->\nF1\n<!-- END_ABRAIN_RULES -->MID<!-- BEGIN_ABRAIN_RULES session=${"d".repeat(64)} source=y -->\nF2\n<!-- END_ABRAIN_RULES -->${blankOutside}`;
    const mixedSan = adapter.sanitizeManagedRuleFences(mixed);
    assert(mixedSan === `${outside}MID${blankOutside}`, `mixed sanitize: ${JSON.stringify(mixedSan)}`);
    // Unclosed BEGIN removes to EOF; prefix preserved exactly including trailing spaces
    const unclosed = `${outside}<!-- BEGIN_ABRAIN_RULES session=${"e".repeat(64)} source=x -->\nBODY`;
    assert(adapter.sanitizeManagedRuleFences(unclosed) === outside, "unclosed must strip from BEGIN to EOF");
    // Blank-byte preservation: multiple spaces/tabs/newlines outside never collapsed
    const spaces = "X \t  \n\n\nY";
    assert(adapter.sanitizeManagedRuleFences(spaces) === spaces);
    // classify nested as malformed
    const kind = adapter.classifyManagedSuffix(nested, null);
    assert(kind.kind === "malformed", `nested must be malformed got ${kind.kind}`);
  });

  await check("rollback sandbox + production-mode /tmp triple-auth positive; hard paths never called; pending intent halt; per-face crash", () => {
    function makeSettings(p) {
      fs.writeFileSync(p, `${JSON.stringify({
        ruleInjector: {
          propositionLifecycleFreshnessD3V2SessionStartInjection: {
            enabled: true,
            selector: { session_ids: [sessionId] },
            expectedSelectionHash: EXPECTED.selection_hash,
            expectedHeadHash: EXPECTED.head_hash,
            expectedProofHash: EXPECTED.proof_hash,
            expectedStableBundleHash: EXPECTED.stable_bundle_hash,
            adapterManifestHash: manifest.manifest_hash,
            activationObjectPath: path.join(activationRoot, "placeholder.json"),
            activationObjectHash: "0".repeat(64),
            maxReadBytes: 65536,
          },
        },
      }, null, 2)}\n`);
    }
    function makeActivation(label, sess, quarantine, stateRoot) {
      writeSession(sess, `{"session":"${sessionId}","label":"${label}"}\n`);
      fs.mkdirSync(path.dirname(quarantine), { recursive: true });
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const st = fs.lstatSync(sess);
      const prefix = fs.readFileSync(sess);
      return adapter.buildD3V2SessionStartActivationObject({
        sessionId,
        activationNonce: nonceOf(label),
        authorizationStatus: "AUTHORIZED",
        authorizationCoordinate: { schema_version: "sandbox-only/v1", mode: "sandbox", label },
        d3Identities: {
          selection_hash: EXPECTED.selection_hash,
          head_hash: EXPECTED.head_hash,
          proof_hash: EXPECTED.proof_hash,
          intent_hash: EXPECTED.intent_hash,
          stable_bundle_hash: EXPECTED.stable_bundle_hash,
          p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
          generation: 0,
          selection_seq: 0,
        },
        adapterManifestHash: manifest.manifest_hash,
        settingsMutation: { enabled: false },
        auditTarget: path.join(tmpRoot, `audit-${label}.jsonl`),
        rollbackTarget: stateRoot,
        sessionFile: {
          path: path.resolve(sess),
          dev: st.dev,
          ino: st.ino,
          prefix_bytes: prefix.length,
          prefix_sha256: sha256Hex(prefix),
        },
        quarantineTarget: path.resolve(quarantine),
        mode: "bound",
      });
    }

    const settingsPath = path.join(tmpRoot, "rollback-settings.json");
    makeSettings(settingsPath);
    const stateRoot = path.join(tmpRoot, "rollback-state");
    const sess = path.join(tmpRoot, "rollback-sessions", `${sessionId}.jsonl`);
    const quarantine = path.join(tmpRoot, "rollback-quarantine", `${sessionId}.jsonl`);
    const activation = makeActivation("rollback", sess, quarantine, stateRoot);

    // Door missing: NOT_AUTHORIZED rollback
    let denied = false;
    try {
      adapter.executeD3V2SessionStartRollbackOperator({
        target: "sandbox",
        settingsPath,
        stateRoot,
        sessionId,
        activationObject: activation,
        rollbackAuthorization: adapter.buildD3V2SessionStartRollbackAuthorization({
          activationObject: activation,
          authorizationStatus: "NOT_AUTHORIZED",
        }),
        reason: "must-deny",
      });
    } catch { denied = true; }
    assert(denied, "NOT_AUTHORIZED rollback must fail");

    const auth = adapter.buildD3V2SessionStartRollbackAuthorization({
      activationObject: activation,
      authorizationStatus: "AUTHORIZED",
      grantPhrase: "sandbox-grant",
    });

    // Production missing door 3 — never call with hard paths under full auth
    let prodDenied = false;
    try {
      adapter.executeD3V2SessionStartRollbackOperator({
        target: "production",
        settingsPath: "/home/worker/.pi/agent/pi-astack-settings.json",
        stateRoot: "/home/worker/.abrain/should-not-write",
        sessionId,
        activationObject: activation,
        rollbackAuthorization: auth,
        reason: "must-deny-production",
      });
    } catch { prodDenied = true; }
    assert(prodDenied, "production without target auth must deny");

    // Production with full triple auth but path mismatch (still /tmp fixture) must deny
    const wrongProdAuth = adapter.buildD3V2SessionStartProductionTargetAuthorization({
      activationObject: activation,
      rollbackAuthorization: auth,
      authorizationStatus: "AUTHORIZED",
      grantPhrase: "prod-mismatch",
      productionSettingsPath: path.join(tmpRoot, "other-settings.json"),
      productionStateRoot: stateRoot,
      productionSessionFilePath: sess,
      productionQuarantineTarget: quarantine,
    });
    let mismatchDenied = false;
    try {
      adapter.executeD3V2SessionStartRollbackOperator({
        target: "production",
        settingsPath,
        stateRoot,
        sessionId,
        activationObject: activation,
        rollbackAuthorization: auth,
        productionTargetAuthorization: wrongProdAuth,
        reason: "path-mismatch",
      });
    } catch (e) { mismatchDenied = /path_mismatch|production_path_mismatch/.test(String(e)); }
    assert(mismatchDenied, "production path mismatch must deny");

    // Args override of activation binding forbidden
    let overrideDenied = false;
    try {
      adapter.executeD3V2SessionStartRollbackOperator({
        target: "sandbox",
        settingsPath,
        stateRoot,
        sessionId,
        activationObject: activation,
        rollbackAuthorization: auth,
        reason: "override",
        sessionFilePath: path.join(tmpRoot, "not-the-bound-session.jsonl"),
      });
    } catch (e) { overrideDenied = /override/.test(String(e)); }
    assert(overrideDenied, "sessionFilePath override must fail");

    // stateRoot A != activation.rollback_target B must deny
    const stateRootB = path.join(tmpRoot, "rollback-state-B");
    let abDenied = false;
    try {
      adapter.executeD3V2SessionStartRollbackOperator({
        target: "sandbox",
        settingsPath,
        stateRoot: stateRootB,
        sessionId,
        activationObject: activation,
        rollbackAuthorization: auth,
        reason: "state-root-mismatch",
      });
    } catch (e) { abDenied = /state_root_mismatch/.test(String(e)); }
    assert(abDenied, "stateRoot !== activation.rollback_target must deny");

    // Door1 rejects trimmed activation objects (must reuse full closed-schema validator)
    let trimmedDenied = false;
    try {
      adapter.executeD3V2SessionStartRollbackOperator({
        target: "sandbox",
        settingsPath,
        stateRoot,
        sessionId,
        activationObject: {
          activation_object_hash: activation.activation_object_hash,
          authorization_status: "AUTHORIZED",
          mode: "bound",
          executable: true,
          session_id: sessionId,
          activation_nonce: nonceOf("rollback"),
        },
        rollbackAuthorization: auth,
        reason: "trimmed",
      });
    } catch (e) { trimmedDenied = /rollback_not_authorized|closed-schema|activation_/.test(String(e)); }
    assert(trimmedDenied, "trimmed activation must fail Door1 full closed-schema");

    // Full sandbox success with real quarantine rename
    const result = adapter.executeD3V2SessionStartRollbackOperator({
      target: "sandbox",
      settingsPath,
      stateRoot,
      sessionId,
      activationObject: activation,
      rollbackAuthorization: auth,
      reason: "smoke_full",
    });
    assert(result.settingsAfter.enabled === false);
    assert(result.receipts.length === 4);
    assert(result.halted === true);
    assert(!fs.existsSync(sess), "session must be quarantined (renamed)");
    assert(fs.existsSync(quarantine), "quarantine target must exist");
    assert(fs.existsSync(path.join(stateRoot, "halt", `${nonceOf("rollback")}.json`)));

    // Full resume from receipts (idempotent)
    const result2 = adapter.executeD3V2SessionStartRollbackOperator({
      target: "sandbox",
      settingsPath,
      stateRoot,
      sessionId,
      activationObject: activation,
      rollbackAuthorization: auth,
      reason: "smoke_full",
    });
    assert(result2.resumed_from_receipt_count === 4);
    assert(result2.receipts.length === 4);

    // Production-mode positive: all paths under /tmp fixture, full triple auth
    const prodSettings = path.join(tmpRoot, "prod-mode-settings.json");
    makeSettings(prodSettings);
    // re-enable selector for this fixture
    {
      const re = JSON.parse(fs.readFileSync(prodSettings, "utf8"));
      re.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.enabled = true;
      re.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.selector.session_ids = [sessionId];
      fs.writeFileSync(prodSettings, `${JSON.stringify(re, null, 2)}\n`);
    }
    const prodState = path.join(tmpRoot, "prod-mode-state");
    const prodSess = path.join(tmpRoot, "prod-mode-sessions", `${sessionId}.jsonl`);
    const prodQ = path.join(tmpRoot, "prod-mode-quarantine", `${sessionId}.jsonl`);
    const prodAct = makeActivation("prod-mode-tmp", prodSess, prodQ, prodState);
    const prodRbAuth = adapter.buildD3V2SessionStartRollbackAuthorization({
      activationObject: prodAct,
      authorizationStatus: "AUTHORIZED",
      grantPhrase: "prod-mode-tmp-grant",
    });
    const prodTargetAuth = adapter.buildD3V2SessionStartProductionTargetAuthorization({
      activationObject: prodAct,
      rollbackAuthorization: prodRbAuth,
      authorizationStatus: "AUTHORIZED",
      grantPhrase: "prod-target-tmp-grant",
      productionSettingsPath: prodSettings,
      productionStateRoot: prodState,
      productionSessionFilePath: prodSess,
      productionQuarantineTarget: prodQ,
    });
    const prodResult = adapter.executeD3V2SessionStartRollbackOperator({
      target: "production",
      settingsPath: prodSettings,
      stateRoot: prodState,
      sessionId,
      activationObject: prodAct,
      rollbackAuthorization: prodRbAuth,
      productionTargetAuthorization: prodTargetAuth,
      reason: "prod-mode-tmp-positive",
    });
    assert(prodResult.halted === true && prodResult.receipts.length === 4);
    assert(!fs.existsSync(prodSess) && fs.existsSync(prodQ), "prod-mode /tmp quarantine must run");
    assert(JSON.parse(fs.readFileSync(prodSettings, "utf8")).ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.enabled === false);

    // Per-face crash: seed prior receipts+poststate, plant intent with correct parent_hash
    function seedPriorAndPlantIntent(face, sPath, sRoot, sFile, sQ, nonceF) {
      const faces = adapter.D3_V2_ROLLBACK_FACES;
      const idx = faces.indexOf(face);
      const receiptDir = path.join(sRoot, "rollback-receipts", nonceF);
      const intentDir = path.join(sRoot, "rollback-intents", nonceF);
      fs.mkdirSync(receiptDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(intentDir, { recursive: true, mode: 0o700 });
      let parentHash = null;
      for (let j = 0; j < idx; j += 1) {
        const prior = faces[j];
        if (prior === "selector_disable") {
          const re = JSON.parse(fs.readFileSync(sPath, "utf8"));
          re.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.enabled = false;
          re.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.selector.session_ids = [];
          fs.writeFileSync(sPath, `${JSON.stringify(re, null, 2)}\n`);
        } else if (prior === "session_taint") {
          const taintPath = path.join(sRoot, "session-taints", `${sessionId}.json`);
          fs.mkdirSync(path.dirname(taintPath), { recursive: true, mode: 0o700 });
          const taint = {
            schema_version: "adr0040-d3-v2-session-start-session-taint/v1",
            session_id: sessionId,
            activation_nonce: nonceF,
            reason: "seeded-prior",
            tainted_at_ms: 0,
          };
          fs.writeFileSync(taintPath, `${canonicalizeJcs(taint)}\n`);
        } else if (prior === "session_quarantine_rename") {
          fs.mkdirSync(path.dirname(sQ), { recursive: true, mode: 0o700 });
          if (fs.existsSync(sFile) && !fs.existsSync(sQ)) fs.renameSync(sFile, sQ);
        } else if (prior === "terminal_halt") {
          const haltPath = path.join(sRoot, "halt", `${nonceF}.json`);
          fs.mkdirSync(path.dirname(haltPath), { recursive: true, mode: 0o700 });
          const halt = {
            schema_version: "adr0040-d3-v2-session-start-halt/v1",
            activation_nonce: nonceF,
            session_id: sessionId,
            reason: "seeded-prior",
            auto_retry: false,
          };
          fs.writeFileSync(haltPath, `${canonicalizeJcs(halt)}\n`);
        }
        const receiptBase = {
          schema_version: "adr0040-d3-v2-session-start-rollback-receipt/v1",
          face: prior,
          activation_nonce: nonceF,
          session_id: sessionId,
          reason: "seeded-prior",
          payload: { seeded: true, face: prior },
          parent_hash: parentHash,
        };
        const receipt = { ...receiptBase, receipt_hash: jcsSha256Hex(receiptBase) };
        fs.writeFileSync(path.join(receiptDir, `${prior}.json`), `${canonicalizeJcs(receipt)}\n`);
        parentHash = receipt.receipt_hash;
      }
      const intent = {
        schema_version: "adr0040-d3-v2-session-start-rollback-intent/v1",
        face,
        activation_nonce: nonceF,
        session_id: sessionId,
        reason: "planted",
        parent_hash: parentHash,
      };
      fs.writeFileSync(
        path.join(intentDir, `${face}.json`),
        `${canonicalizeJcs({ ...intent, intent_hash: jcsSha256Hex(intent) })}\n`,
      );
      return parentHash;
    }

    for (const face of adapter.D3_V2_ROLLBACK_FACES) {
      const faceLabel = `crash-${face}`;
      const sPath = path.join(tmpRoot, `settings-${faceLabel}.json`);
      makeSettings(sPath);
      {
        const re = JSON.parse(fs.readFileSync(sPath, "utf8"));
        re.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.enabled = true;
        re.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.selector.session_ids = [sessionId];
        fs.writeFileSync(sPath, `${JSON.stringify(re, null, 2)}\n`);
      }
      const sRoot = path.join(tmpRoot, `state-${faceLabel}`);
      const sFile = path.join(tmpRoot, `sess-${faceLabel}`, `${sessionId}.jsonl`);
      const sQ = path.join(tmpRoot, `q-${faceLabel}`, `${sessionId}.jsonl`);
      const actF = makeActivation(faceLabel, sFile, sQ, sRoot);
      const authF = adapter.buildD3V2SessionStartRollbackAuthorization({
        activationObject: actF,
        authorizationStatus: "AUTHORIZED",
        grantPhrase: `grant-${face}`,
      });
      const nonceF = nonceOf(faceLabel);
      seedPriorAndPlantIntent(face, sPath, sRoot, sFile, sQ, nonceF);

      // Runtime treats pending intent as halt (taint/halt from seeded prior faces also halt — both close the window)
      const halt = adapter.readD3V2SessionStartHaltOrTaint({
        rollbackTarget: sRoot,
        activationNonce: nonceF,
        sessionId,
      });
      assert(halt.halted === true, `face ${face} must halt: ${JSON.stringify(halt)}`);
      const faces = adapter.D3_V2_ROLLBACK_FACES;
      const idx = faces.indexOf(face);
      if (idx === 0) {
        assert(halt.kind === "pending_intent", `first face pending must be pending_intent: ${JSON.stringify(halt)}`);
      } else {
        assert(["pending_intent", "taint", "halt"].includes(halt.kind), `face ${face} halt kind: ${JSON.stringify(halt)}`);
      }

      // Operator without continue blocks
      let blocked = false;
      try {
        adapter.executeD3V2SessionStartRollbackOperator({
          target: "sandbox",
          settingsPath: sPath,
          stateRoot: sRoot,
          sessionId,
          activationObject: actF,
          rollbackAuthorization: authF,
          reason: `crash-${face}`,
        });
      } catch { blocked = true; }
      assert(blocked, `face ${face} intent without receipt must block`);

      // Resume with operatorContinue completes remaining faces
      const resumed = adapter.executeD3V2SessionStartRollbackOperator({
        target: "sandbox",
        settingsPath: sPath,
        stateRoot: sRoot,
        sessionId,
        activationObject: actF,
        rollbackAuthorization: authF,
        reason: `crash-${face}`,
        operatorContinue: true,
      });
      assert(resumed.halted === true, `face ${face} resume must halt`);
      assert(resumed.receipts.length === 4, `face ${face} resume must complete 4 receipts got ${resumed.receipts.length}`);
      assert(!fs.existsSync(sFile) && fs.existsSync(sQ), `face ${face} quarantine must complete`);
    }

    // Stale intent parent_hash rejected
    {
      const label = "stale-parent";
      const sPath = path.join(tmpRoot, `settings-${label}.json`);
      makeSettings(sPath);
      const sRoot = path.join(tmpRoot, `state-${label}`);
      const sFile = path.join(tmpRoot, `sess-${label}`, `${sessionId}.jsonl`);
      const sQ = path.join(tmpRoot, `q-${label}`, `${sessionId}.jsonl`);
      const actF = makeActivation(label, sFile, sQ, sRoot);
      const authF = adapter.buildD3V2SessionStartRollbackAuthorization({
        activationObject: actF, authorizationStatus: "AUTHORIZED", grantPhrase: "stale",
      });
      const nonceF = nonceOf(label);
      const intentDir = path.join(sRoot, "rollback-intents", nonceF);
      fs.mkdirSync(intentDir, { recursive: true, mode: 0o700 });
      const intent = {
        schema_version: "adr0040-d3-v2-session-start-rollback-intent/v1",
        face: "selector_disable",
        activation_nonce: nonceF,
        session_id: sessionId,
        reason: "stale",
        parent_hash: "a".repeat(64),
      };
      fs.writeFileSync(path.join(intentDir, "selector_disable.json"), `${canonicalizeJcs({ ...intent, intent_hash: jcsSha256Hex(intent) })}\n`);
      let staleDenied = false;
      try {
        adapter.executeD3V2SessionStartRollbackOperator({
          target: "sandbox", settingsPath: sPath, stateRoot: sRoot, sessionId,
          activationObject: actF, rollbackAuthorization: authF, reason: "stale", operatorContinue: true,
        });
      } catch (e) { staleDenied = /parent_mismatch|intent_parent|intent/.test(String(e)); }
      assert(staleDenied, "stale parent_hash intent must be rejected");
    }

    // Out-of-order intent: plant session_taint with parent=null while no prior receipt;
    // face0 executes first then face1 parent check fails.
    {
      const label = "ooo-intent";
      const sPath = path.join(tmpRoot, `settings-${label}.json`);
      makeSettings(sPath);
      {
        const re = JSON.parse(fs.readFileSync(sPath, "utf8"));
        re.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.enabled = true;
        re.ruleInjector.propositionLifecycleFreshnessD3V2SessionStartInjection.selector.session_ids = [sessionId];
        fs.writeFileSync(sPath, `${JSON.stringify(re, null, 2)}\n`);
      }
      const sRoot = path.join(tmpRoot, `state-${label}`);
      const sFile = path.join(tmpRoot, `sess-${label}`, `${sessionId}.jsonl`);
      const sQ = path.join(tmpRoot, `q-${label}`, `${sessionId}.jsonl`);
      const actF = makeActivation(label, sFile, sQ, sRoot);
      const authF = adapter.buildD3V2SessionStartRollbackAuthorization({
        activationObject: actF, authorizationStatus: "AUTHORIZED", grantPhrase: "ooo",
      });
      const nonceF = nonceOf(label);
      const intentDir = path.join(sRoot, "rollback-intents", nonceF);
      fs.mkdirSync(intentDir, { recursive: true, mode: 0o700 });
      const intent = {
        schema_version: "adr0040-d3-v2-session-start-rollback-intent/v1",
        face: "session_taint",
        activation_nonce: nonceF,
        session_id: sessionId,
        reason: "ooo",
        parent_hash: null,
      };
      fs.writeFileSync(path.join(intentDir, "session_taint.json"), `${canonicalizeJcs({ ...intent, intent_hash: jcsSha256Hex(intent) })}\n`);
      let oooDenied = false;
      try {
        adapter.executeD3V2SessionStartRollbackOperator({
          target: "sandbox", settingsPath: sPath, stateRoot: sRoot, sessionId,
          activationObject: actF, rollbackAuthorization: authF, reason: "ooo", operatorContinue: true,
        });
      } catch (e) { oooDenied = /parent_mismatch|intent_parent|intent/.test(String(e)); }
      assert(oooDenied, "out-of-order intent parent must be rejected");
    }

    // Sandbox hard-path: stateRoot = real production control root refused before any write
    {
      const realControl = path.join(os.homedir(), ".pi", ".pi-astack", "adr0040-d3-v2-session-start");
      const roots = adapter.listD3V2SessionStartHardProductionRoots();
      assert(roots.some((r) => {
        const base = path.resolve(r);
        const target = path.resolve(realControl);
        return target === base || target.startsWith(base + path.sep);
      }), "control root must be in hard-production list");
      const snapRoot = () => {
        if (!fs.existsSync(realControl)) return "ABSENT";
        return spawnSync("find", [realControl, "-printf", "%p %s\n"], { encoding: "utf8" }).stdout;
      };
      const beforeSnap = snapRoot();
      const sPath = path.join(tmpRoot, "settings-hardpath.json");
      makeSettings(sPath);
      const sFile = path.join(tmpRoot, "sess-hardpath", `${sessionId}.jsonl`);
      const sQ = path.join(tmpRoot, "q-hardpath", `${sessionId}.jsonl`);
      // Build activation in-memory only — never mkdir the real control root in the fixture helper.
      writeSession(sFile, `{"session":"${sessionId}","label":"hardpath"}\n`);
      fs.mkdirSync(path.dirname(sQ), { recursive: true });
      const st = fs.lstatSync(sFile);
      const prefix = fs.readFileSync(sFile);
      const actHard = adapter.buildD3V2SessionStartActivationObject({
        sessionId,
        activationNonce: nonceOf("hardpath"),
        authorizationStatus: "AUTHORIZED",
        authorizationCoordinate: { schema_version: "sandbox-only/v1", mode: "sandbox", label: "hardpath" },
        d3Identities: {
          selection_hash: EXPECTED.selection_hash,
          head_hash: EXPECTED.head_hash,
          proof_hash: EXPECTED.proof_hash,
          intent_hash: EXPECTED.intent_hash,
          stable_bundle_hash: EXPECTED.stable_bundle_hash,
          p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
          generation: 0,
          selection_seq: 0,
        },
        adapterManifestHash: manifest.manifest_hash,
        settingsMutation: { enabled: false },
        auditTarget: path.join(tmpRoot, "audit-hardpath.jsonl"),
        rollbackTarget: realControl,
        sessionFile: {
          path: path.resolve(sFile),
          dev: st.dev,
          ino: st.ino,
          prefix_bytes: prefix.length,
          prefix_sha256: sha256Hex(prefix),
        },
        quarantineTarget: path.resolve(sQ),
        mode: "bound",
      });
      // build auth only — validateBoundActivationObjectClosed is pure (no I/O on rollback_target)
      const authHard = adapter.buildD3V2SessionStartRollbackAuthorization({
        activationObject: actHard, authorizationStatus: "AUTHORIZED", grantPhrase: "hardpath-deny",
      });
      const midSnap = snapRoot();
      assert(beforeSnap === midSnap, "building activation/auth must not touch real control root");
      let hardDenied = false;
      try {
        adapter.executeD3V2SessionStartRollbackOperator({
          target: "sandbox",
          settingsPath: sPath,
          stateRoot: realControl,
          sessionId,
          activationObject: actHard,
          rollbackAuthorization: authHard,
          reason: "must-deny-hard-root",
        });
      } catch (e) { hardDenied = /production_forbidden|hard/.test(String(e)) || /sandbox rollback target/.test(String(e)); }
      assert(hardDenied, "sandbox stateRoot at real control root must deny before write");
      const afterSnap = snapRoot();
      assert(beforeSnap === afterSnap, "real control root must be unchanged after hard-path deny");
    }

    // Hard production paths: only mock/dry deny via incomplete auth — never call full auth against them
    // (operator with hard paths + missing prod auth already covered above).
  });

  await check("R3.5 ancestor-symlink negatives + extensionless bound activationRootHasNoBound", () => {
    // Symlinks are created ONLY under tmpRoot. Targets are existing hard roots;
    // we never mkdir/write under production targets. Snapshot before/after must match.
    const realControl = path.join(os.homedir(), ".pi", ".pi-astack", "adr0040-d3-v2-session-start");
    const realAgent = path.join(os.homedir(), ".pi", "agent");
    function snapTree(root) {
      if (!fs.existsSync(root)) return "ABSENT";
      // Identity-only listing; do not modify.
      return spawnSync("find", [root, "-printf", "%p %s %y\n"], { encoding: "utf8" }).stdout;
    }
    const beforeControl = snapTree(realControl);
    const beforeAgent = snapTree(realAgent);

    // /tmp alias → real control root
    const aliasControl = path.join(tmpRoot, "alias-to-control-root");
    fs.symlinkSync(realControl, aliasControl);
    assert(fs.lstatSync(aliasControl).isSymbolicLink(), "alias-control must be symlink under /tmp");
    // /tmp alias → real agent (settings parent attack)
    const aliasAgent = path.join(tmpRoot, "alias-to-agent");
    fs.symlinkSync(realAgent, aliasAgent);
    assert(fs.lstatSync(aliasAgent).isSymbolicLink(), "alias-agent must be symlink under /tmp");

    function makeSettings(p) {
      fs.writeFileSync(p, `${JSON.stringify({
        ruleInjector: {
          propositionLifecycleFreshnessD3V2SessionStartInjection: {
            enabled: true,
            selector: { session_ids: [sessionId] },
            expectedSelectionHash: EXPECTED.selection_hash,
            expectedHeadHash: EXPECTED.head_hash,
            expectedProofHash: EXPECTED.proof_hash,
            expectedStableBundleHash: EXPECTED.stable_bundle_hash,
            adapterManifestHash: manifest.manifest_hash,
            activationObjectPath: path.join(activationRoot, "placeholder.json"),
            activationObjectHash: "0".repeat(64),
            maxReadBytes: 65536,
          },
        },
      }, null, 2)}\n`);
    }

    // Case A: stateRoot = /tmp/alias → control root. Must refuse BEFORE any production change.
    {
      const sPath = path.join(tmpRoot, "settings-symlink-control.json");
      makeSettings(sPath);
      const sFile = path.join(tmpRoot, "sess-symlink-control", `${sessionId}.jsonl`);
      const sQ = path.join(tmpRoot, "q-symlink-control", `${sessionId}.jsonl`);
      writeSession(sFile, `{"session":"${sessionId}","label":"symlink-control"}\n`);
      fs.mkdirSync(path.dirname(sQ), { recursive: true });
      const st = fs.lstatSync(sFile);
      const prefix = fs.readFileSync(sFile);
      const act = adapter.buildD3V2SessionStartActivationObject({
        sessionId,
        activationNonce: nonceOf("symlink-control"),
        authorizationStatus: "AUTHORIZED",
        authorizationCoordinate: { schema_version: "sandbox-only/v1", mode: "sandbox", label: "symlink-control" },
        d3Identities: {
          selection_hash: EXPECTED.selection_hash,
          head_hash: EXPECTED.head_hash,
          proof_hash: EXPECTED.proof_hash,
          intent_hash: EXPECTED.intent_hash,
          stable_bundle_hash: EXPECTED.stable_bundle_hash,
          p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
          generation: 0,
          selection_seq: 0,
        },
        adapterManifestHash: manifest.manifest_hash,
        settingsMutation: { enabled: false },
        auditTarget: path.join(tmpRoot, "audit-symlink-control.jsonl"),
        rollbackTarget: aliasControl, // lexical under /tmp, realpath = control root
        sessionFile: {
          path: path.resolve(sFile),
          dev: st.dev,
          ino: st.ino,
          prefix_bytes: prefix.length,
          prefix_sha256: sha256Hex(prefix),
        },
        quarantineTarget: path.resolve(sQ),
        mode: "bound",
      });
      const auth = adapter.buildD3V2SessionStartRollbackAuthorization({
        activationObject: act, authorizationStatus: "AUTHORIZED", grantPhrase: "symlink-control-deny",
      });
      const midControl = snapTree(realControl);
      assert(beforeControl === midControl, "building activation/auth must not touch real control root");
      let denied = false;
      let deniedMsg = "";
      try {
        adapter.executeD3V2SessionStartRollbackOperator({
          target: "sandbox",
          settingsPath: sPath,
          stateRoot: aliasControl,
          sessionId,
          activationObject: act,
          rollbackAuthorization: auth,
          reason: "must-deny-symlink-control",
        });
      } catch (e) {
        denied = true;
        deniedMsg = String(e);
      }
      assert(denied, "sandbox stateRoot via /tmp alias→control must deny");
      assert(
        /path_ancestor_symlink|production_forbidden|realpath/.test(deniedMsg),
        `symlink-control deny reason unexpected: ${deniedMsg}`,
      );
      // Ensure no intents/receipts were created under the alias (which would be production).
      assert(!fs.existsSync(path.join(aliasControl, "rollback-intents")), "must not create intents via alias");
      assert(!fs.existsSync(path.join(aliasControl, "rollback-receipts")), "must not create receipts via alias");
      const afterControl = snapTree(realControl);
      assert(beforeControl === afterControl, "real control root must be unchanged after symlink-control deny");
    }

    // Case B: settings parent = /tmp/alias → real agent. Must refuse before settings write.
    {
      const sPath = path.join(aliasAgent, "pi-astack-settings-symlink-probe.json");
      // Do NOT create the settings file under the alias (that would write into agent).
      // Operator will try to read/write settings — preflight must refuse on parent symlink first.
      // Provide a real session under /tmp only.
      const sFile = path.join(tmpRoot, "sess-symlink-agent", `${sessionId}.jsonl`);
      const sQ = path.join(tmpRoot, "q-symlink-agent", `${sessionId}.jsonl`);
      const stateRoot = path.join(tmpRoot, "state-symlink-agent");
      writeSession(sFile, `{"session":"${sessionId}","label":"symlink-agent"}\n`);
      fs.mkdirSync(path.dirname(sQ), { recursive: true });
      fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
      const st = fs.lstatSync(sFile);
      const prefix = fs.readFileSync(sFile);
      const act = adapter.buildD3V2SessionStartActivationObject({
        sessionId,
        activationNonce: nonceOf("symlink-agent"),
        authorizationStatus: "AUTHORIZED",
        authorizationCoordinate: { schema_version: "sandbox-only/v1", mode: "sandbox", label: "symlink-agent" },
        d3Identities: {
          selection_hash: EXPECTED.selection_hash,
          head_hash: EXPECTED.head_hash,
          proof_hash: EXPECTED.proof_hash,
          intent_hash: EXPECTED.intent_hash,
          stable_bundle_hash: EXPECTED.stable_bundle_hash,
          p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
          generation: 0,
          selection_seq: 0,
        },
        adapterManifestHash: manifest.manifest_hash,
        settingsMutation: { enabled: false },
        auditTarget: path.join(tmpRoot, "audit-symlink-agent.jsonl"),
        rollbackTarget: stateRoot,
        sessionFile: {
          path: path.resolve(sFile),
          dev: st.dev,
          ino: st.ino,
          prefix_bytes: prefix.length,
          prefix_sha256: sha256Hex(prefix),
        },
        quarantineTarget: path.resolve(sQ),
        mode: "bound",
      });
      const auth = adapter.buildD3V2SessionStartRollbackAuthorization({
        activationObject: act, authorizationStatus: "AUTHORIZED", grantPhrase: "symlink-agent-deny",
      });
      const midAgent = snapTree(realAgent);
      assert(beforeAgent === midAgent, "building activation/auth must not touch real agent");
      // Confirm probe file does not already exist under agent via alias.
      assert(!fs.existsSync(sPath), "probe settings must not pre-exist under agent alias");
      let denied = false;
      let deniedMsg = "";
      try {
        adapter.executeD3V2SessionStartRollbackOperator({
          target: "sandbox",
          settingsPath: sPath,
          stateRoot,
          sessionId,
          activationObject: act,
          rollbackAuthorization: auth,
          reason: "must-deny-symlink-agent",
        });
      } catch (e) {
        denied = true;
        deniedMsg = String(e);
      }
      assert(denied, "sandbox settingsPath via /tmp alias→agent must deny");
      assert(
        /path_ancestor_symlink|production_forbidden|realpath/.test(deniedMsg),
        `symlink-agent deny reason unexpected: ${deniedMsg}`,
      );
      assert(!fs.existsSync(sPath), "must not create settings under agent via alias");
      const afterAgent = snapTree(realAgent);
      assert(beforeAgent === afterAgent, "real agent tree must be unchanged after symlink-agent deny");
    }

    // Final production snapshots unchanged.
    assert(beforeControl === snapTree(realControl), "control root snapshot final");
    assert(beforeAgent === snapTree(realAgent), "agent snapshot final");

    // Extensionless bound-object fixture: activationRootHasNoBoundObject must be false.
    const scanRoot = path.join(tmpRoot, "activation-scan-root");
    fs.mkdirSync(scanRoot, { recursive: true, mode: 0o700 });
    assert(adapter.activationRootHasNoBoundObject(scanRoot) === true, "empty root has no bound");
    // No-extension bound object fixture (the R3.4 .json-only scanner would miss this).
    const extensionless = path.join(scanRoot, "bound-object-no-ext");
    fs.writeFileSync(extensionless, JSON.stringify({
      authorization_status: "AUTHORIZED",
      mode: "bound",
      executable: true,
      session_id: "fixture",
    }), "utf8");
    assert(
      adapter.activationRootHasNoBoundObject(scanRoot) === false,
      "extensionless bound object must make predicate false",
    );
    // Nested .json AUTHORIZED also false.
    const nestedDir = path.join(tmpRoot, "activation-scan-json");
    fs.mkdirSync(path.join(nestedDir, "sub"), { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "sub", "x.json"), JSON.stringify({ mode: "bound" }), "utf8");
    assert(adapter.activationRootHasNoBoundObject(nestedDir) === false, "nested json bound must be false");
    // Parse error fail-closed.
    const parseRoot = path.join(tmpRoot, "activation-scan-parse");
    fs.mkdirSync(parseRoot, { recursive: true });
    fs.writeFileSync(path.join(parseRoot, "junk"), "not-json{", "utf8");
    assert(adapter.activationRootHasNoBoundObject(parseRoot) === false, "parse error must fail-closed false");
    // Absent root is true.
    assert(adapter.activationRootHasNoBoundObject(path.join(tmpRoot, "no-such-activation-root")) === true);
  });

  await check("R3.6 retained parent-fd walk closes check-after ancestor-swap; no production write", () => {
    // Low-level helper unit tests + closed-set one-shot sandbox operator hook.
    // Never touches real hard-root *contents* beyond identity snapshots.
    const realAgent = path.join(os.homedir(), ".pi", "agent");
    const realControl = path.join(os.homedir(), ".pi", ".pi-astack", "adr0040-d3-v2-session-start");
    function snapTree(root) {
      if (!fs.existsSync(root)) return "ABSENT";
      return spawnSync("find", [root, "-printf", "%p %s %y\n"], { encoding: "utf8" }).stdout;
    }
    const beforeAgent = snapTree(realAgent);
    const beforeControl = snapTree(realControl);

    assert(
      adapter.D3_V2_SESSION_START_PATH_SAFETY_PLATFORM_BOUNDARY
        === "linux_proc_self_fd_retained_parent_directory_fd_walk",
      "platform boundary constant must document Linux /proc/self/fd",
    );

    // --- Low-level: hold parent FD, swap ancestor to hard root, write via procfd ---
    const holdRoot = path.join(tmpRoot, "r36-hold");
    const holdChild = path.join(holdRoot, "leaf");
    adapter.ensureDirectoryChainNoSymlink(holdChild, "r36 hold child");
    const held = adapter.walkRetainParentDirectoryFd(holdChild, { create: false, label: "r36 held leaf" });
    const backup = `${holdChild}.r36-backup`;
    fs.renameSync(holdChild, backup);
    fs.symlinkSync(realAgent, holdChild);
    const proofName = "r36-anchored-proof.txt";
    const via = adapter.procFdChildPath(held.fd, proofName);
    const wfd = fs.openSync(via, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(wfd, "anchored-not-production\n");
      fs.fsyncSync(wfd);
    } finally {
      fs.closeSync(wfd);
    }
    assert(fs.existsSync(path.join(backup, proofName)), "FD-anchored write must land on original inode (backup)");
    assert(!fs.existsSync(path.join(realAgent, proofName)), "FD-anchored write must NOT land in production agent");
    // Re-walk after swap must fail closed on symlink.
    let rewalkDenied = false;
    let rewalkMsg = "";
    try {
      adapter.ensureDirectoryChainNoSymlink(path.join(holdChild, "new"), "r36 rewalk");
    } catch (e) {
      rewalkDenied = true;
      rewalkMsg = String(e);
    }
    assert(rewalkDenied, "rewalk after ancestor swap must deny");
    assert(/path_ancestor_symlink|procfd/.test(rewalkMsg), `rewalk deny unexpected: ${rewalkMsg}`);
    // Restore for cleanup.
    fs.unlinkSync(holdChild);
    fs.renameSync(backup, holdChild);
    fs.closeSync(held.fd);
    assert(beforeAgent === snapTree(realAgent), "agent snapshot unchanged after low-level FD proof");

    // --- Closed-set one-shot operator hook: after preflight, before mkdir ---
    adapter.__resetR36TestAncestorSwapHookForTests();
    const token = `r36-test-token-${Date.now()}-closed-set`;
    process.env.PI_ASTACK_R36_TEST_TOKEN = token;
    try {
      const sPath = path.join(tmpRoot, "settings-r36-hook.json");
      fs.writeFileSync(sPath, `${JSON.stringify({
        ruleInjector: {
          propositionLifecycleFreshnessD3V2SessionStartInjection: {
            enabled: true,
            selector: { session_ids: [sessionId] },
            expectedSelectionHash: EXPECTED.selection_hash,
            expectedHeadHash: EXPECTED.head_hash,
            expectedProofHash: EXPECTED.proof_hash,
            expectedStableBundleHash: EXPECTED.stable_bundle_hash,
            adapterManifestHash: manifest.manifest_hash,
            activationObjectPath: path.join(activationRoot, "placeholder.json"),
            activationObjectHash: "0".repeat(64),
            maxReadBytes: 65536,
          },
        },
      }, null, 2)}\n`);
      // stateRoot is under a dedicated ancestor we will swap after preflight.
      const stateAncestor = path.join(tmpRoot, "r36-state-ancestor");
      fs.mkdirSync(stateAncestor, { recursive: true, mode: 0o700 });
      const stateRoot = path.join(stateAncestor, "state");
      const sFile = path.join(tmpRoot, "sess-r36-hook", `${sessionId}.jsonl`);
      const sQ = path.join(tmpRoot, "q-r36-hook", `${sessionId}.jsonl`);
      writeSession(sFile, `{"session":"${sessionId}","label":"r36-hook"}\n`);
      fs.mkdirSync(path.dirname(sQ), { recursive: true });
      const st = fs.lstatSync(sFile);
      const prefix = fs.readFileSync(sFile);
      const act = adapter.buildD3V2SessionStartActivationObject({
        sessionId,
        activationNonce: nonceOf("r36-hook"),
        authorizationStatus: "AUTHORIZED",
        authorizationCoordinate: { schema_version: "sandbox-only/v1", mode: "sandbox", label: "r36-hook" },
        d3Identities: {
          selection_hash: EXPECTED.selection_hash,
          head_hash: EXPECTED.head_hash,
          proof_hash: EXPECTED.proof_hash,
          intent_hash: EXPECTED.intent_hash,
          stable_bundle_hash: EXPECTED.stable_bundle_hash,
          p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
          generation: 0,
          selection_seq: 0,
        },
        adapterManifestHash: manifest.manifest_hash,
        settingsMutation: { enabled: false },
        auditTarget: path.join(tmpRoot, "audit-r36-hook.jsonl"),
        rollbackTarget: stateRoot,
        sessionFile: {
          path: path.resolve(sFile),
          dev: st.dev,
          ino: st.ino,
          prefix_bytes: prefix.length,
          prefix_sha256: sha256Hex(prefix),
        },
        quarantineTarget: path.resolve(sQ),
        mode: "bound",
      });
      const auth = adapter.buildD3V2SessionStartRollbackAuthorization({
        activationObject: act, authorizationStatus: "AUTHORIZED", grantPhrase: "r36-hook-deny",
      });
      const midControl = snapTree(realControl);
      assert(beforeControl === midControl, "building activation must not touch control root");
      let denied = false;
      let deniedMsg = "";
      try {
        adapter.executeD3V2SessionStartRollbackOperator({
          target: "sandbox",
          settingsPath: sPath,
          stateRoot,
          sessionId,
          activationObject: act,
          rollbackAuthorization: auth,
          reason: "must-deny-after-preflight-swap",
          __testAncestorSwapAfterPreflight: {
            kind: adapter.D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND,
            testToken: token,
            sandboxAncestorToSwap: stateAncestor,
            hardRootSymlinkTarget: realControl,
          },
        });
      } catch (e) {
        denied = true;
        deniedMsg = String(e);
      }
      assert(denied, "operator after preflight ancestor swap must fail closed");
      assert(
        /path_ancestor_symlink|production_forbidden|procfd|test_hook/.test(deniedMsg)
          || /ancestor is a symlink/.test(deniedMsg),
        `r36 hook deny unexpected: ${deniedMsg}`,
      );
      // Production must be unchanged; no intents/receipts under control via the swap.
      assert(!fs.existsSync(path.join(realControl, "rollback-intents")), "must not create intents under control via swap");
      assert(!fs.existsSync(path.join(realControl, "rollback-receipts")), "must not create receipts under control via swap");
      assert(beforeControl === snapTree(realControl), "control root snapshot unchanged after operator hook");
      assert(beforeAgent === snapTree(realAgent), "agent snapshot unchanged after operator hook");

      // Hook is one-shot: second apply without reset must fail closed.
      let oneShotDenied = false;
      try {
        adapter.applyR36TestAncestorSwapAfterPreflight({
          target: "sandbox",
          hook: {
            kind: adapter.D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND,
            testToken: token,
            sandboxAncestorToSwap: path.join(tmpRoot, "another-ancestor"),
            hardRootSymlinkTarget: realControl,
          },
        });
      } catch (e) {
        oneShotDenied = true;
        assert(/one.shot|test_hook/.test(String(e)), `one-shot deny unexpected: ${e}`);
      }
      assert(oneShotDenied, "second hook apply without reset must deny");

      // Production target must refuse the test hook entirely.
      adapter.__resetR36TestAncestorSwapHookForTests();
      let prodHookDenied = false;
      try {
        adapter.applyR36TestAncestorSwapAfterPreflight({
          target: "production",
          hook: {
            kind: adapter.D3_V2_R36_TEST_ANCESTOR_SWAP_HOOK_KIND,
            testToken: token,
            sandboxAncestorToSwap: path.join(tmpRoot, "prod-hook-ancestor"),
            hardRootSymlinkTarget: realControl,
          },
        });
      } catch (e) {
        prodHookDenied = true;
        assert(/test_hook_production_forbidden/.test(String(e)), `prod hook deny unexpected: ${e}`);
      }
      assert(prodHookDenied, "production target must refuse test hook");
    } finally {
      delete process.env.PI_ASTACK_R36_TEST_TOKEN;
      adapter.__resetR36TestAncestorSwapHookForTests();
      // Best-effort restore any leftover symlink from the operator hook.
      const stateAncestor = path.join(tmpRoot, "r36-state-ancestor");
      try {
        if (fs.existsSync(stateAncestor) && fs.lstatSync(stateAncestor).isSymbolicLink()) {
          fs.unlinkSync(stateAncestor);
        }
      } catch { /* best-effort */ }
      // Restore backup if present.
      try {
        const backups = fs.readdirSync(tmpRoot).filter((n) => n.startsWith("r36-state-ancestor.r36-swap-backup-"));
        for (const b of backups) {
          const full = path.join(tmpRoot, b);
          if (!fs.existsSync(stateAncestor)) fs.renameSync(full, stateAncestor);
        }
      } catch { /* best-effort */ }
    }

    assert(beforeAgent === snapTree(realAgent), "agent final snapshot");
    assert(beforeControl === snapTree(realControl), "control final snapshot");
  });

  await check("R3.7 session_id safe component + path containment + rehearse no absolute write", () => {
    const stateRoot = path.join(tmpRoot, "r37-state-root");
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const goodId = "019f77f6-r37-safe-session";
    const goodNonce = nonceOf("r37-safe");

    // --- Closed-set adversarial session_id rejections (builder + full validator) ---
    const badIds = [
      "../escape",
      "..\\escape",
      "/absolute/id",
      "\\\\absolute",
      ".",
      "..",
      "",
      "has space",
      "uni\u2713",
      "a/b",
      "a\\b",
      `x${"y".repeat(200)}`, // over max length
      "\u0000null",
      "trailing.",
    ];
    // trailing. is actually allowed by charset; keep only true rejects.
    const rejectIds = badIds.filter((id) => id !== "trailing.");
    for (const bad of rejectIds) {
      let denied = false;
      let msg = "";
      try {
        adapter.assertSafeSessionIdComponent(bad);
      } catch (e) {
        denied = true;
        msg = String(e);
      }
      assert(denied, `assertSafeSessionIdComponent must deny ${JSON.stringify(bad)}`);
      assert(/path_component_invalid|session_id/.test(msg), `unexpected deny msg for ${bad}: ${msg}`);

      // Builder must refuse bound activation with traversal sessionId.
      let buildDenied = false;
      try {
        adapter.buildD3V2SessionStartActivationObject({
          sessionId: bad,
          activationNonce: goodNonce,
          authorizationStatus: "AUTHORIZED",
          authorizationCoordinate: { schema_version: "sandbox-only/v1", mode: "sandbox" },
          d3Identities: {
            selection_hash: EXPECTED.selection_hash,
            head_hash: EXPECTED.head_hash,
            proof_hash: EXPECTED.proof_hash,
            intent_hash: EXPECTED.intent_hash,
            stable_bundle_hash: EXPECTED.stable_bundle_hash,
            p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
            generation: 0,
            selection_seq: 0,
          },
          adapterManifestHash: manifest.manifest_hash,
          settingsMutation: { enabled: false },
          auditTarget: path.join(tmpRoot, "audit-r37.jsonl"),
          rollbackTarget: stateRoot,
          sessionFile: {
            path: path.join(tmpRoot, "sess-r37.jsonl"),
            dev: 1, ino: 1, prefix_bytes: 1, prefix_sha256: "0".repeat(64),
          },
          quarantineTarget: path.join(tmpRoot, "q-r37.jsonl"),
          mode: "bound",
        });
      } catch (e) {
        buildDenied = true;
      }
      assert(buildDenied, `builder must refuse sessionId=${JSON.stringify(bad)}`);

      // Path helpers must refuse before join (cannot escape stateRoot).
      let taintDenied = false;
      try { adapter.sessionTaintPath(stateRoot, bad); } catch { taintDenied = true; }
      assert(taintDenied, `sessionTaintPath must refuse ${JSON.stringify(bad)}`);
    }

    // Full validator rejects object with traversal session_id (selfhash made consistent so shape path is reached).
    let fullDenied = false;
    const forgedBase = {
      schema_version: adapter.D3_V2_SESSION_START_ACTIVATION_OBJECT_SCHEMA,
      mode: "bound",
      authorization_status: "AUTHORIZED",
      session_id: "../escape",
      activation_nonce: goodNonce,
      authorization_coordinate: { a: 1 },
      authorization_coordinate_hash: jcsSha256Hex({ a: 1 }),
      d3_identities: {
        selection_hash: EXPECTED.selection_hash,
        head_hash: EXPECTED.head_hash,
        proof_hash: EXPECTED.proof_hash,
        intent_hash: EXPECTED.intent_hash,
        stable_bundle_hash: EXPECTED.stable_bundle_hash,
        p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
        generation: 0,
        selection_seq: 0,
      },
      adapter_manifest_hash: manifest.manifest_hash,
      settings_mutation: { enabled: false },
      audit_target: "/tmp/a",
      rollback_target: "/tmp/b",
      session_file: { path: "/tmp/s", dev: 1, ino: 1, prefix_bytes: 1, prefix_sha256: "0".repeat(64) },
      quarantine_target: "/tmp/q",
      executable: true,
    };
    try {
      adapter.validateBoundActivationObjectClosed({
        ...forgedBase,
        activation_object_hash: adapter.computeD3V2ActivationObjectHash(forgedBase),
      });
    } catch (e) {
      fullDenied = true;
      assert(/path_component_invalid|session_id/.test(String(e)), `full validator msg: ${e}`);
    }
    assert(fullDenied, "full validator must reject ../ session_id");

    // --- Containment: legal joins stay under stateRoot ---
    adapter.assertSafeSessionIdComponent(goodId);
    const taint = adapter.sessionTaintPath(stateRoot, goodId);
    const intentDir = adapter.rollbackIntentDir(stateRoot, goodNonce);
    const receiptDir = adapter.rollbackReceiptDir(stateRoot, goodNonce);
    const halt = adapter.haltMarkerPath(stateRoot, goodNonce);
    const barrier = adapter.rollbackBarrierPath(stateRoot, goodNonce);
    const resolvedRoot = path.resolve(stateRoot);
    for (const p of [taint, intentDir, receiptDir, halt, barrier]) {
      const resolved = path.resolve(p);
      assert(
        resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep),
        `path must stay under stateRoot: ${resolved}`,
      );
      const rel = path.relative(resolvedRoot, resolved);
      assert(!rel.startsWith("..") && !path.isAbsolute(rel), `relative must not escape: ${rel}`);
    }
    // joinUnderRootContained rejects multi-component / absolute injection.
    let joinDenied = false;
    try { adapter.joinUnderRootContained(stateRoot, "..", "escape"); } catch { joinDenied = true; }
    assert(joinDenied, "joinUnderRootContained must refuse '..'");
    joinDenied = false;
    try { adapter.joinUnderRootContained(stateRoot, "/abs"); } catch { joinDenied = true; }
    assert(joinDenied, "joinUnderRootContained must refuse absolute component");

    // --- Static: rehearse body has no absolute writeFileSync/existsSync/lstatSync/readFileSync ---
    const rollbackSrc = fs.readFileSync(
      path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE),
      "utf8",
    );
    const rehearseStart = rollbackSrc.indexOf("export function rehearseD3V2SessionStartRollback");
    assert(rehearseStart >= 0, "rehearse function must exist");
    const rehearseEnd = rollbackSrc.indexOf("\nfunction applySelectorDisableStep", rehearseStart);
    assert(rehearseEnd > rehearseStart, "rehearse body bounds");
    const rehearseBody = rollbackSrc.slice(rehearseStart, rehearseEnd);
    assert(!/fs\.writeFileSync/.test(rehearseBody), "rehearse must not call fs.writeFileSync (use procfd-anchored write)");
    assert(!/fs\.existsSync/.test(rehearseBody), "rehearse must not call fs.existsSync (use anchored probe)");
    assert(!/fs\.lstatSync/.test(rehearseBody), "rehearse must not call fs.lstatSync (use anchored lstat)");
    assert(!/fs\.readFileSync/.test(rehearseBody), "rehearse must not call fs.readFileSync (use readTextFileAnchored)");
    assert(/pathExistsRegularFileAnchored|atomicDurableWriteText|lstatRegularFileAnchored|readTextFileAnchored/.test(rehearseBody),
      "rehearse must use retained-FD anchored helpers");
    assert(/assertSafeSessionIdComponent|joinUnderRootContained/.test(rehearseBody),
      "rehearse must enforce safe session_id + contained joins");

    // Production-module writeFileSync audit: only FD writes (first arg not a path string).
    // applyR36TestAncestorSwap is closed-set test hook and may use absolute rename — residual accepted.
    const writeMatches = [...rollbackSrc.matchAll(/fs\.writeFileSync\s*\(\s*([^,\n]+)/g)];
    for (const m of writeMatches) {
      const first = m[1].trim();
      assert(
        first === "fd" || first === "wfd" || /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(first) && !/Path|File|path|file|session|settings|halt|taint/.test(first),
        `production writeFileSync first arg must be an FD var, got: ${first}`,
      );
    }
    // mkdirSync only via procfd child path variable (childProc), never absolute path var after check.
    const mkdirMatches = [...rollbackSrc.matchAll(/fs\.mkdirSync\s*\(\s*([^,\n]+)/g)];
    for (const m of mkdirMatches) {
      const first = m[1].trim();
      assert(first === "childProc" || /Proc/.test(first), `mkdirSync must be procfd-anchored, got: ${first}`);
    }

    // --- Live rehearse: settings/session/quarantine all under stateRoot (R3.8) ---
    const settingsPath = path.join(stateRoot, "settings-r37-rehearse.json");
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.writeFileSync(settingsPath, `${JSON.stringify({
      ruleInjector: {
        propositionLifecycleFreshnessD3V2SessionStartInjection: {
          enabled: true,
          selector: { session_ids: [goodId] },
          expectedSelectionHash: EXPECTED.selection_hash,
          expectedHeadHash: EXPECTED.head_hash,
          expectedProofHash: EXPECTED.proof_hash,
          expectedStableBundleHash: EXPECTED.stable_bundle_hash,
          adapterManifestHash: manifest.manifest_hash,
          activationObjectPath: path.join(activationRoot, "r37-placeholder.json"),
          activationObjectHash: "0".repeat(64),
          maxReadBytes: 65536,
        },
      },
    }, null, 2)}\n`);
    const result = adapter.rehearseD3V2SessionStartRollback({
      sandboxSettingsPath: settingsPath,
      sandboxStateRoot: stateRoot,
      sessionId: goodId,
      activationNonce: goodNonce,
      reason: "r37-rehearse-anchored",
    });
    assert(Array.isArray(result.receipts) && result.receipts.length === 4, "rehearse must complete 4 faces");
    assert(result.settingsAfter.enabled === false, "selector must be disabled");
    assert(!result.settingsAfter.selector.session_ids.includes(goodId), "session must be removed from selector");
    assert(fs.existsSync(adapter.sessionTaintPath(stateRoot, goodId)), "taint must exist under stateRoot");
    assert(fs.existsSync(adapter.haltMarkerPath(stateRoot, goodNonce)), "halt must exist under stateRoot");
    // Escape proof: no sibling pollution outside stateRoot from session id.
    assert(!fs.existsSync(path.join(tmpRoot, "escape")), "must not create escape artifact outside stateRoot");
  });

  await check("R3.8/R3.9 rehearse containment + selector fail-closed (no-trim) + 127/128/129 vs NAME_MAX", () => {
    const stateRoot = path.join(tmpRoot, "r38-state-root");
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    const goodId = "019f77f6-r38-safe-session";
    const goodNonce = nonceOf("r38-safe");

    // --- Length bounds: session_id ≤128; generic component ≤255; derived .json/.jsonl at 128 pass ---
    assert(adapter.D3_V2_SESSION_ID_MAX_LENGTH === 128, "session_id max must be 128");
    assert(adapter.D3_V2_SAFE_PATH_COMPONENT_MAX_LENGTH === 255, "generic component max must be NAME_MAX 255");
    const id127 = `a${"b".repeat(126)}`; // 127
    const id128 = `a${"b".repeat(127)}`; // 128
    const id129 = `a${"b".repeat(128)}`; // 129
    assert(id127.length === 127 && id128.length === 128 && id129.length === 129, "boundary lengths");
    adapter.assertSafeSessionIdComponent(id127);
    adapter.assertSafeSessionIdComponent(id128);
    let denied129 = false;
    try { adapter.assertSafeSessionIdComponent(id129); } catch { denied129 = true; }
    assert(denied129, "session_id length 129 must be refused");
    // Generic component allows 255; 256 refused.
    const comp255 = `c${"d".repeat(254)}`;
    const comp256 = `c${"d".repeat(255)}`;
    assert(comp255.length === 255 && comp256.length === 256, "component boundary lengths");
    adapter.assertSafeSinglePathComponent(comp255);
    let denied256 = false;
    try { adapter.assertSafeSinglePathComponent(comp256); } catch { denied256 = true; }
    assert(denied256, "generic component length 256 must be refused");
    // Derived `${id}.json` / `${id}.jsonl` at session_id 128 boundary must join under root.
    const taint128 = adapter.sessionTaintPath(stateRoot, id128);
    assert(taint128.endsWith(`${id128}.json`), "taint basename uses sessionId.json");
    assert(path.basename(taint128).length === 128 + ".json".length, "taint basename length = 133 ≤ 255");
    const session128 = adapter.joinUnderRootContained(stateRoot, "sessions", `${id128}.jsonl`);
    assert(session128.endsWith(`${id128}.jsonl`), "session file basename uses sessionId.jsonl");
    assert(path.basename(session128).length === 128 + ".jsonl".length, "session basename length = 134 ≤ 255");
    // isSafeSessionIdComponent predicate
    assert(adapter.isSafeSessionIdComponent(id128) === true, "isSafe accepts 128");
    assert(adapter.isSafeSessionIdComponent(id129) === false, "isSafe rejects 129");
    assert(adapter.isSafeSessionIdComponent("../escape") === false, "isSafe rejects traversal");
    assert(adapter.isSafeSessionIdComponent(".") === false, "isSafe rejects dot");

    // --- Production schema retirement: historical adapter validators remain code-only. ---
    const schemaRaw = fs.readFileSync(path.join(repoRoot, "pi-astack-settings.schema.json"), "utf8");
    const schema = JSON.parse(schemaRaw);
    const v2Config = schema?.properties?.ruleInjector?.properties
      ?.propositionLifecycleFreshnessD3V2SessionStartInjection;
    assert(v2Config === undefined, "retired D3 runtime configuration remains in production schema");

    // --- Live resolve: unsafe selector fail-closed to disabled/empty/cleared pins, never throws ---
    // R3.9: empty / pure whitespace / leading-trailing whitespace are NOT ignored and NOT trimmed.
    const unsafeSelectors = [
      "../escape", "/abs", ".", "..", "a/b", id129, "has space", "uni\u2713",
      "", " ", "\t", "  ", ` ${goodId}`, `${goodId} `, ` ${goodId} `, null, 42,
    ];
    for (const bad of unsafeSelectors) {
      let threw = false;
      let settings;
      try {
        settings = adapter.resolveD3V2SessionStartInjectionSettings({
          enabled: true,
          selector: { session_ids: [bad, goodId] },
          expectedSelectionHash: EXPECTED.selection_hash,
          expectedHeadHash: EXPECTED.head_hash,
          expectedProofHash: EXPECTED.proof_hash,
          expectedStableBundleHash: EXPECTED.stable_bundle_hash,
          adapterManifestHash: manifest.manifest_hash,
          activationObjectPath: path.join(activationRoot, "r38.json"),
          activationObjectHash: "0".repeat(64),
          maxReadBytes: 65536,
        });
      } catch (e) {
        threw = true;
      }
      assert(!threw, `resolve must not throw on unsafe selector ${JSON.stringify(bad)}`);
      assert(settings.enabled === false, `unsafe selector must disable: ${JSON.stringify(bad)}`);
      assert(settings.selector.session_ids.length === 0, `unsafe selector must empty: ${JSON.stringify(bad)}`);
      assert(settings.activationObjectPath === null, "fail-closed clears activation path");
      assert(settings.activationObjectHash === null, "fail-closed clears activation hash pin");
      // Must not rewrite padded identity into a safe id.
      assert(!settings.selector.session_ids.includes(goodId), `must not keep/trim-to goodId for ${JSON.stringify(bad)}`);
    }
    // Empty-only selector + enabled=true + missing activation pins: fail-closed, no missing-pin throw.
    {
      let threw = false;
      let settings;
      try {
        settings = adapter.resolveD3V2SessionStartInjectionSettings({
          enabled: true,
          selector: { session_ids: ["", " "] },
        });
      } catch {
        threw = true;
      }
      assert(!threw, "empty/whitespace selector must not throw missing-pin");
      assert(settings.enabled === false, "empty/whitespace selector disables without pin throw");
      assert(settings.selector.session_ids.length === 0, "empty/whitespace selector empties");
      assert(settings.activationObjectPath === null && settings.activationObjectHash === null,
        "empty/whitespace selector clears pins");
    }
    // Safe-only selector still enables when activation present; identity preserved (no trim).
    const safeSettings = adapter.resolveD3V2SessionStartInjectionSettings({
      enabled: true,
      selector: { session_ids: [goodId] },
      expectedSelectionHash: EXPECTED.selection_hash,
      expectedHeadHash: EXPECTED.head_hash,
      expectedProofHash: EXPECTED.proof_hash,
      expectedStableBundleHash: EXPECTED.stable_bundle_hash,
      adapterManifestHash: manifest.manifest_hash,
      activationObjectPath: path.join(activationRoot, "r38.json"),
      activationObjectHash: "0".repeat(64),
      maxReadBytes: 65536,
    });
    assert(safeSettings.enabled === true && safeSettings.selector.session_ids.includes(goodId), "safe selector enables");
    assert(safeSettings.selector.session_ids[0] === goodId, "safe selector keeps original identity");

    // --- Unsafe current session id: select unselected on raw value, no throw, no D3/inject ---
    const unsafeSessionCases = [
      "../escape-session",
      "",
      " ",
      "\t",
      ` ${goodId}`,
      `${goodId} `,
      ` ${goodId} `,
    ];
    const unsafeSessionFile = path.join(tmpRoot, "r38-unsafe-session.jsonl");
    writeSession(unsafeSessionFile);
    for (const unsafeSessionId of unsafeSessionCases) {
      // Even if caller bypasses resolve and hand-builds settings with unsafe id, select must refuse.
      const handSettings = {
        ...safeSettings,
        enabled: true,
        selector: { session_ids: [typeof unsafeSessionId === "string" && unsafeSessionId.trim() ? unsafeSessionId.trim() : goodId, goodId] },
      };
      // For padded forms, also plant the raw padded value in selector to prove no trim-match.
      if (typeof unsafeSessionId === "string" && unsafeSessionId !== unsafeSessionId.trim()) {
        handSettings.selector = { session_ids: [unsafeSessionId, goodId] };
      }
      let selectThrew = false;
      let sel;
      try {
        sel = adapter.selectD3V2SessionStartSession({
          settings: handSettings,
          sessionManager: sessionManager(unsafeSessionId, unsafeSessionFile),
        });
      } catch {
        selectThrew = true;
      }
      assert(!selectThrew, `select must not throw on unsafe session id ${JSON.stringify(unsafeSessionId)}`);
      assert(sel.selected === false, `unsafe session id must not be selected: ${JSON.stringify(unsafeSessionId)}`);
      assert(sel.reason === "unselected_session", `expected unselected_session for ${JSON.stringify(unsafeSessionId)}, got ${sel.reason}`);
      if (typeof unsafeSessionId === "string") {
        assert(sel.sessionId === unsafeSessionId, `must preserve raw unsafe identity, not trim: ${JSON.stringify(sel.sessionId)}`);
      }
      // Control hook: unselected → no D3 read / no inject.
      const decision = control.decideD3V2SessionStartControl({
        repoRoot,
        abrainHome: path.join(tmpRoot, "r38-abrain"),
        cwd: tmpRoot,
        settings: { ...safeSettings, enabled: true, selector: { session_ids: [goodId] } },
        sessionManager: sessionManager(unsafeSessionId, unsafeSessionFile),
        currentSystemPrompt: "BASE_R38",
        latestUserText: "r38-unsafe",
        controlRoot: path.join(tmpRoot, "r38-control"),
        auditFile: path.join(tmpRoot, "r38-audit.jsonl"),
        activationRoot,
      });
      assert(decision.kind === "unselected", `hook must be unselected for ${JSON.stringify(unsafeSessionId)}, got ${decision.kind}`);
      assert(!decision.systemPrompt, "unselected must not inject systemPrompt");
    }
    // Safe current session id keeps original identity (no trim rewrite path).
    {
      const safeSessionFile = path.join(tmpRoot, "r39-safe-session.jsonl");
      writeSession(safeSessionFile);
      const selSafe = adapter.selectD3V2SessionStartSession({
        settings: safeSettings,
        sessionManager: sessionManager(goodId, safeSessionFile),
      });
      assert(selSafe.selected === true && selSafe.sessionId === goodId, "safe session id selected with original identity");
    }

    // --- Rehearse containment: external absolute / sibling / override refused; sentinel unchanged ---
    const externalDir = path.join(tmpRoot, "r38-external-sentinel");
    fs.mkdirSync(externalDir, { recursive: true, mode: 0o700 });
    const sentinelPath = path.join(externalDir, "SENTINEL.txt");
    const sentinelBody = "R38_EXTERNAL_UNTOUCHED\n";
    fs.writeFileSync(sentinelPath, sentinelBody);
    const externalSettings = path.join(externalDir, "settings-escape.json");
    fs.writeFileSync(externalSettings, `${JSON.stringify({ ruleInjector: {} }, null, 2)}\n`);
    const siblingSettings = path.join(tmpRoot, "r38-sibling-settings.json");
    fs.writeFileSync(siblingSettings, `${JSON.stringify({ ruleInjector: {} }, null, 2)}\n`);
    const containedSettings = path.join(stateRoot, "settings-r38.json");
    fs.writeFileSync(containedSettings, `${JSON.stringify({
      ruleInjector: {
        propositionLifecycleFreshnessD3V2SessionStartInjection: {
          enabled: true,
          selector: { session_ids: [goodId] },
          expectedSelectionHash: EXPECTED.selection_hash,
          expectedHeadHash: EXPECTED.head_hash,
          expectedProofHash: EXPECTED.proof_hash,
          expectedStableBundleHash: EXPECTED.stable_bundle_hash,
          adapterManifestHash: manifest.manifest_hash,
          activationObjectPath: path.join(activationRoot, "r38-placeholder.json"),
          activationObjectHash: "0".repeat(64),
          maxReadBytes: 65536,
        },
      },
    }, null, 2)}\n`);

    function assertRehearseRefused(label, args) {
      let denied = false;
      let msg = "";
      try {
        adapter.rehearseD3V2SessionStartRollback(args);
      } catch (e) {
        denied = true;
        msg = String(e);
      }
      assert(denied, `rehearse must refuse ${label}`);
      assert(/path_escape|rollback_production_forbidden|path_component/.test(msg),
        `unexpected refuse msg for ${label}: ${msg}`);
      assert(fs.readFileSync(sentinelPath, "utf8") === sentinelBody, `sentinel mutated after ${label}`);
      assert(fs.readdirSync(externalDir).sort().join(",") === "SENTINEL.txt,settings-escape.json",
        `external dir polluted after ${label}`);
    }

    // External absolute settings (outside stateRoot)
    assertRehearseRefused("external absolute settings", {
      sandboxSettingsPath: externalSettings,
      sandboxStateRoot: stateRoot,
      sessionId: goodId,
      activationNonce: goodNonce,
      reason: "r38-external-settings",
    });
    // Sibling of stateRoot
    assertRehearseRefused("sibling settings", {
      sandboxSettingsPath: siblingSettings,
      sandboxStateRoot: stateRoot,
      sessionId: goodId,
      activationNonce: goodNonce,
      reason: "r38-sibling-settings",
    });
    // ../ relative that resolves outside
    assertRehearseRefused("dotdot settings", {
      sandboxSettingsPath: path.join(stateRoot, "..", "r38-dotdot-settings.json"),
      sandboxStateRoot: stateRoot,
      sessionId: goodId,
      activationNonce: goodNonce,
      reason: "r38-dotdot-settings",
    });
    // sessionFilePath override outside stateRoot
    assertRehearseRefused("external sessionFilePath override", {
      sandboxSettingsPath: containedSettings,
      sandboxStateRoot: stateRoot,
      sessionId: goodId,
      activationNonce: goodNonce,
      reason: "r38-external-session",
      sessionFilePath: path.join(externalDir, "session-escape.jsonl"),
    });
    // quarantineTarget override outside stateRoot
    assertRehearseRefused("external quarantineTarget override", {
      sandboxSettingsPath: containedSettings,
      sandboxStateRoot: stateRoot,
      sessionId: goodId,
      activationNonce: goodNonce,
      reason: "r38-external-quarantine",
      quarantineTarget: path.join(externalDir, "q-escape.jsonl"),
    });
    // Static: rehearse body asserts containment before ensureDirectoryChain/write
    const rollbackSrc = fs.readFileSync(
      path.join(repoRoot, adapter.D3_V2_SESSION_START_ROLLBACK_MODULE),
      "utf8",
    );
    const rehearseStart = rollbackSrc.indexOf("export function rehearseD3V2SessionStartRollback");
    const rehearseEnd = rollbackSrc.indexOf("\nfunction applySelectorDisableStep", rehearseStart);
    const rehearseBody = rollbackSrc.slice(rehearseStart, rehearseEnd);
    assert(/assertResolvedPathContainedUnderRoot/.test(rehearseBody),
      "rehearse must call assertResolvedPathContainedUnderRoot");
    const containIdx = rehearseBody.indexOf("assertResolvedPathContainedUnderRoot");
    const mkdirIdx = rehearseBody.indexOf("ensureDirectoryChainNoSymlink");
    assert(containIdx >= 0 && mkdirIdx > containIdx,
      "containment must run before ensureDirectoryChainNoSymlink");

    // Positive: contained settings + defaults under stateRoot complete FSM; sentinel untouched.
    const ok = adapter.rehearseD3V2SessionStartRollback({
      sandboxSettingsPath: containedSettings,
      sandboxStateRoot: stateRoot,
      sessionId: goodId,
      activationNonce: goodNonce,
      reason: "r38-contained-positive",
    });
    assert(Array.isArray(ok.receipts) && ok.receipts.length === 4, "contained rehearse must complete 4 faces");
    assert(fs.readFileSync(sentinelPath, "utf8") === sentinelBody, "sentinel must remain after positive rehearse");
    assert(!fs.existsSync(path.join(externalDir, "session-escape.jsonl")), "external session must not be created");
    assert(!fs.existsSync(path.join(externalDir, "q-escape.jsonl")), "external quarantine must not be created");
  });

  await check("historical execution-ready dossier remains frozen after production host retirement", () => {
    const wiring = adapter.evaluateD3V2SessionStartHostWiringPredicate(repoRoot);
    assert(wiring.ok === false && wiring.registers_session_start_surface === false, "current host unexpectedly satisfies the historical D3 execution predicate");
    const frozen = path.join(repoRoot, "docs/evidence/2026-07-19-adr0040-d3-v2-session-start-execution-ready-dossier.json");
    assert(fs.existsSync(frozen) && fs.lstatSync(frozen).isFile(), "frozen historical D3 dossier is missing");
    return;
    const dossierScript = path.join(repoRoot, "scripts/dossier-proposition-lifecycle-freshness-d3-v2-session-start-execution-ready.mjs");
    const t1 = path.join(tmpRoot, "dossier-stability-a.json");
    const t2 = path.join(tmpRoot, "dossier-stability-b.json");
    const r1 = spawnSync(process.execPath, [dossierScript, "--write", t1], { encoding: "utf8", cwd: repoRoot });
    const r2 = spawnSync(process.execPath, [dossierScript, "--write", t2], { encoding: "utf8", cwd: repoRoot });
    assert(r1.status === 0, `dossier build1 failed: ${r1.stderr || r1.stdout}`);
    assert(r2.status === 0, `dossier build2 failed: ${r2.stderr || r2.stdout}`);
    const b1 = fs.readFileSync(t1, "utf8");
    const b2 = fs.readFileSync(t2, "utf8");
    assert(b1 === b2, "two consecutive dossier builds must be byte-identical");
    const v1 = spawnSync(process.execPath, [dossierScript, "--verify", t1], { encoding: "utf8", cwd: repoRoot });
    const v2 = spawnSync(process.execPath, [dossierScript, "--verify", t1], { encoding: "utf8", cwd: repoRoot });
    assert(v1.status === 0, `dossier verify1 failed: ${v1.stderr || v1.stdout}`);
    assert(v2.status === 0, `dossier verify2 failed: ${v2.stderr || v2.stdout}`);
    assert(v1.stdout === v2.stdout, "two consecutive dossier verifies must be identical");
  });

  await check("pending rollback intent stops selected injection (selector-disable crash window closed)", () => {
    const controlRoot = cloneProductionRoot("pending-intent");
    const act = writeBoundActivation({
      label: "pending-intent",
      sessionId,
      sessionFile,
      activationNonce: nonceOf("pending-intent"),
      manifestHash: manifest.manifest_hash,
      auditFile: path.join(tmpRoot, "pending-audit.jsonl"),
      rollbackTarget: path.join(tmpRoot, "rollback-pending"),
    });
    // Plant selector_disable intent without receipt under activation rollback target
    const intentDir = path.join(act.activation.rollback_target, "rollback-intents", nonceOf("pending-intent"));
    fs.mkdirSync(intentDir, { recursive: true, mode: 0o700 });
    const intent = {
      schema_version: "adr0040-d3-v2-session-start-rollback-intent/v1",
      face: "selector_disable",
      activation_nonce: nonceOf("pending-intent"),
      session_id: sessionId,
      reason: "crash-after-disable-intent",
      parent_hash: null,
    };
    fs.writeFileSync(path.join(intentDir, "selector_disable.json"), `${canonicalizeJcs({ ...intent, intent_hash: jcsSha256Hex(intent) })}\n`);
    const settings = enabledSettings([sessionId], manifest.manifest_hash, act.activationPath, act.activationHash);
    const decision = control.decideD3V2SessionStartControl({
      repoRoot,
      abrainHome: path.join(tmpRoot, "pending-abrain"),
      cwd: tmpRoot,
      settings,
      sessionManager: sessionManager(sessionId, sessionFile),
      currentSystemPrompt: "BASE",
      latestUserText: "pending-turn",
      controlRoot,
      auditFile: act.activation.audit_target,
      activationRoot,
    });
    assert(decision.kind === "selected_zero_injection", JSON.stringify(decision));
    assert(decision.reason === "pending_rollback_intent", `got reason ${decision.reason}`);
    assert(!decision.systemPrompt?.includes("BEGIN_ABRAIN_RULES"));
  });

  await check("activation template is NOT_AUTHORIZED non-executable; S1 dossier shape", () => {
    const template = adapter.buildD3V2SessionStartActivationObject({
      sessionId: null,
      activationNonce: null,
      authorizationStatus: "NOT_AUTHORIZED",
      authorizationCoordinate: null,
      d3Identities: {
        selection_hash: EXPECTED.selection_hash,
        head_hash: EXPECTED.head_hash,
        proof_hash: EXPECTED.proof_hash,
        intent_hash: EXPECTED.intent_hash,
        stable_bundle_hash: EXPECTED.stable_bundle_hash,
        p2a_bundle_hash: EXPECTED.p2a_bundle_hash,
        generation: 0,
        selection_seq: 0,
      },
      adapterManifestHash: manifest.manifest_hash,
      settingsMutation: { enabled: true, note: "template only" },
      auditTarget: path.join(tmpRoot, "audit-target"),
      rollbackTarget: path.join(tmpRoot, "rollback-target"),
      mode: "template",
    });
    assert(template.authorization_status === "NOT_AUTHORIZED");
    assert(template.executable === false);
    assert(template.mode === "template");
    assert(template.session_id === null);
  });

  await check("production D3/settings/legacy zero-write after entire smoke", () => {
    const after = snapshot(PROTECTED);
    assert(canonicalizeJcs(before) === canonicalizeJcs(after), "protected surfaces changed");
  });
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.stdout.write(`\n${failures.length === 0 ? "PASS" : "FAIL"}: ${failures.length} failure(s), ${passed} passed\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
