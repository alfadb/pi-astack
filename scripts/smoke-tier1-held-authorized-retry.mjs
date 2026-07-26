#!/usr/bin/env node
/**
 * Smoke: Tier-1 active-correction held authorized decision durable retry.
 *
 * Real production shape (PID 1049406 / 1308386 class):
 *   1) LLM classifier authorizes user-role directive → tier1_direct_write
 *   2) Constraint Evidence append throws RECOVERY_QUARANTINED-like transient
 *   3) signal_consumed=false; checkpoint must HOLD; exact decision is durable-held
 *   4) Process state reset / "restart" (in-memory cleared; disk held kept)
 *   5) Next lifecycle retry WITHOUT new user restatement uses original
 *      user-expressed provenance + classifier rule_scope; CE succeeds exactly-once
 *   6) Held is acked; demoted re-classification cannot steal the retry
 *
 * Offline sandbox only. No production abrain mutation. No commit.
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
const jiti = createJiti(repoRoot, { interopDefault: true });

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-tier1-held-"));
const abrainHome = path.join(tmpRoot, ".abrain");
const projectRoot = path.join(tmpRoot, "project");
const smokeSettingsPath = path.join(tmpRoot, "pi-astack-settings.json");
fs.mkdirSync(abrainHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(projectRoot, { recursive: true });
fs.mkdirSync(path.join(projectRoot, ".pi-astack", "sediment"), { recursive: true });
fs.writeFileSync(smokeSettingsPath, `${JSON.stringify({
  canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
}, null, 2)}\n`);

const originalEnv = {
  HOME: process.env.HOME,
  ABRAIN_ROOT: process.env.ABRAIN_ROOT,
  PI_ASTACK_SETTINGS_PATH: process.env.PI_ASTACK_SETTINGS_PATH,
};
process.env.HOME = path.dirname(abrainHome);
process.env.ABRAIN_ROOT = abrainHome;
process.env.PI_ASTACK_SETTINGS_PATH = smokeSettingsPath;

let passed = 0;
const failures = [];
function assert(v, msg) {
  if (!v) throw new Error(msg || "assertion failed");
}
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok    ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL  ${name}\n        ${error?.stack || error}\n`);
  }
}

const index = jiti(path.join(repoRoot, "extensions/sediment/index.ts"));
const heldMod = jiti(path.join(repoRoot, "extensions/sediment/tier1-held-decision.ts"));
const settingsMod = jiti(path.join(repoRoot, "extensions/sediment/settings.ts"));
// Force-throw hook MUST go through index (same module graph as tryAutoWriteLane).
// A separate jiti load of integration.ts is a dual-instance miss.

const USER_QUOTE =
  "在当前项目中，如果修改了pi-astack的项目代码，在每轮对话结束时要提醒用户是否需要重启pi";

const authorizedSignal = {
  signal_found: true,
  typing: "durable",
  confidence: 9,
  is_directive: true,
  rule_scope: "project",
  provenance: "user-expressed",
  quote_source: "user_message",
  correction_intent: "remind restart pi after pi-astack code changes",
  scope_description: "当前项目：修改 pi-astack 代码后每轮结束提醒是否重启 pi",
  user_quote: USER_QUOTE,
  target_entry_slug: null,
  quote_multi_match: false,
  quote_matched_roles: ["user"],
};

/** Demoted re-classification shape (assistant echo multi-match) — must NOT win over held. */
const demotedSignal = {
  ...authorizedSignal,
  provenance: "content-in-transcript",
  quote_source: "transcript_content",
  is_directive: false,
  confidence: 4,
  quote_multi_match: true,
  quote_matched_roles: ["user", "assistant"],
};

function baseSettings() {
  const defaults = settingsMod.DEFAULT_SEDIMENT_SETTINGS ?? settingsMod.resolveSedimentSettings?.({}) ?? {};
  return {
    ...defaults,
    autoLlmWriteEnabled: true,
    constraintEvidenceEventWriter: {
      enabled: true,
      mode: "event_first",
      legacyFallbackOnEventFailure: false,
      legacyRuleWriteOnSuccessfulEvent: false,
    },
    // Keep proposition bridge disabled in this smoke: async stable-view
    // republish races with tmp cleanup (ENOENT after PASS). Dedicated
    // smoke-proposition-tier1-policy-bridge covers that path independently.
    propositionTier1PolicyWriter: { enabled: false },
  };
}

function mkWindow(turnId = "turn1", timestamp = "2026-07-25T08:00:00.000Z") {
  const text = `--- ENTRY 1 ${turnId} message/user ---\n${USER_QUOTE}`;
  return {
    entries: [{
      type: "message",
      id: turnId,
      timestamp,
      message: { role: "user", content: [{ type: "text", text: USER_QUOTE }] },
    }],
    text,
    chars: text.length,
    totalBranchEntries: 1,
    candidateEntries: 1,
    includedEntries: 1,
    checkpointFound: false,
    lastEntryId: turnId,
  };
}

const mockModelRegistry = {
  find: () => null,
  getApiKeyAndHeaders: async () => ({ ok: false, error: "unused" }),
};

/** Explicit turnId+timestamp per lifecycle so cross-window exactly-once is forced. */
function laneArgs(sessionId, correctionSignal, correlationId, windowOpts = {}) {
  const turnId = windowOpts.turnId ?? "turn1";
  const timestamp = windowOpts.timestamp ?? "2026-07-25T08:00:00.000Z";
  return {
    cwd: projectRoot,
    sessionId,
    settings: baseSettings(),
    window: mkWindow(turnId, timestamp),
    modelRegistry: mockModelRegistry,
    signal: undefined,
    correlationId,
    abrainHome,
    projectId: "pi-astack",
    correctionSignal,
  };
}

function listL1EventFilesBySchema(schema) {
  const root = path.join(abrainHome, "l1", "events");
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (dir) => {
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, child.name);
      if (child.isDirectory()) walk(full);
      else if (child.isFile() && child.name.endsWith(".json")) {
        try {
          const env = JSON.parse(fs.readFileSync(full, "utf8"));
          if (env?.schema === schema) out.push(full);
        } catch { /* skip */ }
      }
    }
  };
  walk(root);
  return out.sort();
}

function listCeEventFiles() {
  return listL1EventFilesBySchema("constraint-evidence-envelope/v1");
}

function countCeEvents() {
  return listCeEventFiles().length;
}

function readSoleCeEnvelope() {
  const files = listCeEventFiles();
  assert(files.length === 1, `expected exactly 1 CE file, got ${files.length}`);
  return JSON.parse(fs.readFileSync(files[0], "utf8"));
}

await check("normalize + transient taxonomy: RECOVERY_QUARANTINED HOLDs", () => {
  const code = index._normalizeConstraintEvidenceAppendErrorForTests(
    Object.assign(new Error("RECOVERY_QUARANTINED: active v3 recovery classification failed"), {
      code: "RECOVERY_QUARANTINED",
      name: "CanonicalGitRuntimeError",
    }),
  );
  assert(code === "RECOVERY_QUARANTINED", `expected RECOVERY_QUARANTINED, got ${code}`);
  const reason = `constraint_evidence_append_failed:${code}`;
  assert(index._isTransientConstraintEvidenceAppendFailureForTests(reason) === true, "quarantine must be transient");
  assert(
    index._isTerminalTier1RejectForTests({ status: "rejected", reason }) === false,
    "quarantine must not terminal-advance checkpoint",
  );
  assert(
    index._isTerminalTier1RejectForTests({
      status: "rejected",
      reason: "constraint_evidence_append_failed:blocked",
    }) === true,
    "blocked remains terminal",
  );
  assert(
    index._isTerminalTier1RejectForTests({
      status: "rejected",
      reason: "constraint_evidence_append_failed:write_failed",
    }) === false,
    "write_failed remains HOLD",
  );
});

await check("normalize + transient taxonomy: RUNTIME_PROVENANCE_SPLIT HOLDs (restart-only)", () => {
  // CanonicalGitRuntimeError message shape: `${code}: ${message}`.
  const codeFromField = index._normalizeConstraintEvidenceAppendErrorForTests(
    Object.assign(
      new Error("RUNTIME_PROVENANCE_SPLIT: jiti/module copies loaded different implementation provenance"),
      { code: "RUNTIME_PROVENANCE_SPLIT", name: "CanonicalGitRuntimeError" },
    ),
  );
  assert(codeFromField === "RUNTIME_PROVENANCE_SPLIT", `expected RUNTIME_PROVENANCE_SPLIT from .code, got ${codeFromField}`);
  // Message-only / mid-flight un-normalized production shape (PID1533336 class).
  const codeFromMsg = index._normalizeConstraintEvidenceAppendErrorForTests(
    new Error("RUNTIME_PROVENANCE_SPLIT: jiti/module copies loaded different implementation provenance"),
  );
  assert(codeFromMsg === "RUNTIME_PROVENANCE_SPLIT", `expected RUNTIME_PROVENANCE_SPLIT from message, got ${codeFromMsg}`);
  const reason = `constraint_evidence_append_failed:${codeFromField}`;
  assert(index._isTransientConstraintEvidenceAppendFailureForTests(reason) === true, "provenance split must be transient HOLD");
  assert(
    index._isTerminalTier1RejectForTests({ status: "rejected", reason }) === false,
    "provenance split must not terminal-advance checkpoint",
  );
  // Legacy un-normalized reason already written to held/audit must still HOLD.
  assert(
    index._isTransientConstraintEvidenceAppendFailureForTests(
      "constraint_evidence_append_failed:RUNTIME_PROVENANCE_SPLIT: jiti/module copies loaded different implementation provenance",
    ) === true,
    "legacy full message reason must stay HOLD",
  );
  // Sibling process-level provenance codes (restart-only).
  for (const sibling of ["PROVENANCE_DRIFT", "RUNTIME_RECONFIGURE_BLOCKED"]) {
    const normalized = index._normalizeConstraintEvidenceAppendErrorForTests(
      Object.assign(new Error(`${sibling}: process provenance frozen`), {
        code: sibling,
        name: "CanonicalGitRuntimeError",
      }),
    );
    assert(normalized === sibling, `expected ${sibling}, got ${normalized}`);
    assert(
      index._isTransientConstraintEvidenceAppendFailureForTests(`constraint_evidence_append_failed:${sibling}`) === true,
      `${sibling} must be transient HOLD`,
    );
  }
  // True terminals must NOT be reclassified by provenance matching.
  assert(
    index._isTransientConstraintEvidenceAppendFailureForTests(
      "constraint_evidence_append_failed:blocked",
    ) === false,
    "blocked remains terminal",
  );
  assert(
    index._isTransientConstraintEvidenceAppendFailureForTests(
      "constraint_evidence_append_failed:invalid",
    ) === false,
    "invalid remains terminal",
  );
});

const SOURCE_TURN = "turn1";
const SOURCE_TS = "2026-07-25T08:00:00.000Z";
let frozenHeldSource = null;
let firstCeEventId = null;

await check("first append throws quarantine-like → held durable, no CE, no checkpoint advance", async () => {
  index._resetAutoWriteStateForTests();
  index._setAppendTier1ForceThrowForTests({
    remaining: 1,
    errorFactory: () => Object.assign(
      new Error("RECOVERY_QUARANTINED: active v3 recovery classification failed: combined historical"),
      { name: "CanonicalGitRuntimeError", code: "RECOVERY_QUARANTINED" },
    ),
  });

  const outcome = await index._tryAutoWriteLaneForTests(
    laneArgs("held-retry-s1", authorizedSignal, "held-retry-s1:auto-1", {
      turnId: SOURCE_TURN,
      timestamp: SOURCE_TS,
    }),
  );
  assert(outcome.kind === "tier1_direct", `expected tier1_direct, got ${outcome.kind}`);
  assert(outcome.result.status === "rejected", `expected rejected, got ${outcome.result.status}`);
  assert(
    (outcome.result.reason ?? "").startsWith("constraint_evidence_append_failed:RECOVERY_QUARANTINED"),
    `expected quarantine reason, got ${outcome.result.reason}`,
  );
  assert(outcome.signal.provenance === "user-expressed", "authorized provenance must be preserved on outcome");
  assert(outcome.signal.rule_scope === "project", "classifier rule_scope must be preserved");
  assert(index._shouldAdvanceAfterAutoOutcomeForTests(outcome) === false, "failure must not advance checkpoint");
  assert(countCeEvents() === 0, "CE must not exist after throw");

  const held = await index._listTier1HeldDecisionsForSessionForTests(abrainHome, "held-retry-s1");
  assert(held.length === 1, `expected 1 held decision, got ${held.length}`);
  assert(held[0].signal.provenance === "user-expressed", "held provenance must stay user-expressed");
  assert(held[0].signal.rule_scope === "project", "held rule_scope must stay project");
  assert(held[0].signal.user_quote === USER_QUOTE, "held quote lineage");
  assert(held[0].signal.is_directive === true, "held is_directive lineage");
  assert(held[0].holdReason.includes("RECOVERY_QUARANTINED"), `holdReason=${held[0].holdReason}`);
  // Source lineage frozen from authorizing window (not later retries).
  assert(held[0].sessionId === "held-retry-s1", `held sessionId=${held[0].sessionId}`);
  assert(held[0].projectId === "pi-astack", `held projectId=${held[0].projectId}`);
  assert(held[0].sourceTurnId === SOURCE_TURN, `held sourceTurnId must be ${SOURCE_TURN}, got ${held[0].sourceTurnId}`);
  assert(held[0].authorizedAtUtc === SOURCE_TS, `held authorizedAtUtc must be ${SOURCE_TS}, got ${held[0].authorizedAtUtc}`);
  frozenHeldSource = {
    sessionId: held[0].sessionId,
    projectId: held[0].projectId,
    sourceTurnId: held[0].sourceTurnId,
    authorizedAtUtc: held[0].authorizedAtUtc,
    decisionId: held[0].decisionId,
  };

  // Clear force-throw for next lifecycle.
  index._setAppendTier1ForceThrowForTests(null);
});

await check("process state reset/restart: held survives; demoted reclass does not win (turn2 window)", async () => {
  // Simulate process restart: clear all in-memory sediment state; disk held remains.
  index._resetAutoWriteStateForTests();
  index._setAppendTier1ForceThrowForTests(null);

  const peeked = await index._peekOldestTier1HeldDecisionForTests(abrainHome, "held-retry-s1");
  assert(peeked, "held must survive process state reset");
  assert(peeked.signal.provenance === "user-expressed", "restart held provenance");
  assert(peeked.signal.rule_scope === "project", "restart held scope");
  assert(peeked.sourceTurnId === SOURCE_TURN, "restart held sourceTurnId frozen");
  assert(peeked.authorizedAtUtc === SOURCE_TS, "restart held authorizedAtUtc frozen");

  // Next lifecycle on a DIFFERENT window turn/time — must still use held lineage.
  const outcome = await index._tryAutoWriteLaneForTests(
    laneArgs("held-retry-s1", demotedSignal, "held-retry-s1:auto-2", {
      turnId: "turn2",
      timestamp: "2026-07-25T09:00:00.000Z",
    }),
  );
  assert(outcome.kind === "tier1_direct", `retry must stay tier1_direct, got ${outcome.kind}`);
  assert(outcome.signal.provenance === "user-expressed", `retry must use original provenance, got ${outcome.signal.provenance}`);
  assert(outcome.signal.rule_scope === "project", `retry must use original rule_scope, got ${outcome.signal.rule_scope}`);
  assert(outcome.signal.is_directive === true, "retry must keep is_directive");
  assert(outcome.signal.user_quote === USER_QUOTE, "retry quote lineage");

  // Success path: CE exactly-once (idempotent). publication may be pending without remote durability.
  assert(
    outcome.result.status === "deduped" || outcome.result.status === "created",
    `expected capture status, got ${JSON.stringify(outcome.result)}`,
  );
  const reason = outcome.result.reason ?? "";
  assert(
    reason.startsWith("constraint_compiler_publication_pending:")
      || reason.startsWith("constraint_compiler_publication_durable:"),
    `unexpected success reason: ${reason}`,
  );
  assert(countCeEvents() === 1, `exactly-once CE expected 1 file, got ${countCeEvents()}`);

  // Strong CE identity + held source lineage (not empty assert).
  const ce = readSoleCeEnvelope();
  firstCeEventId = ce.event_id ?? ce.body_hash;
  assert(typeof firstCeEventId === "string" && /^[0-9a-f]{64}$/.test(firstCeEventId), `CE event_id invalid: ${firstCeEventId}`);
  assert(ce.body?.session_id === frozenHeldSource.sessionId, `CE session_id must be held source, got ${ce.body?.session_id}`);
  assert(ce.body?.turn_id === frozenHeldSource.sourceTurnId, `CE turn_id must be held sourceTurnId (${SOURCE_TURN}), got ${ce.body?.turn_id}`);
  assert(ce.body?.created_at_utc === frozenHeldSource.authorizedAtUtc, `CE created_at_utc must be held authorizedAtUtc, got ${ce.body?.created_at_utc}`);
  // Must NOT adopt turn2 window.
  assert(ce.body?.turn_id !== "turn2", "CE must not use current retry window turnId");
  assert(ce.body?.created_at_utc !== "2026-07-25T09:00:00.000Z", "CE must not use current retry window timestamp");

  // Held must be acked only after capture OR terminal. publication_pending is NOT capture.
  const heldAfter = await index._listTier1HeldDecisionsForSessionForTests(abrainHome, "held-retry-s1");
  if (reason.startsWith("constraint_compiler_publication_pending:")) {
    assert(heldAfter.length === 1, `pending publication should keep held for retry, got ${heldAfter.length}`);
    assert(heldAfter[0].signal.provenance === "user-expressed", "held still original provenance");
    assert(heldAfter[0].sourceTurnId === SOURCE_TURN, "re-hold keeps sourceTurnId");
    assert(heldAfter[0].authorizedAtUtc === SOURCE_TS, "re-hold keeps authorizedAtUtc");
    assert(index._shouldAdvanceAfterAutoOutcomeForTests(outcome) === false, "pending publication HOLDs checkpoint");
  } else {
    assert(heldAfter.length === 0, `captured path should ack held, still pending=${heldAfter.length}`);
  }
});

await check("idempotent third pass on turn3 does not double-consume CE", async () => {
  index._resetAutoWriteStateForTests();
  index._setAppendTier1ForceThrowForTests(null);
  const stillHeld = await index._peekOldestTier1HeldDecisionForTests(abrainHome, "held-retry-s1");
  if (stillHeld) {
    assert(stillHeld.sourceTurnId === SOURCE_TURN, "pending held still frozen turn");
    assert(stillHeld.authorizedAtUtc === SOURCE_TS, "pending held still frozen time");
  }
  // Always demoted reclass on turn3: if held still pending, retry uses frozen lineage;
  // if held already acked/captured, demoted must NOT invent a new CE authorization.
  const outcome = await index._tryAutoWriteLaneForTests(
    laneArgs("held-retry-s1", demotedSignal, "held-retry-s1:auto-3", {
      turnId: "turn3",
      timestamp: "2026-07-25T10:00:00.000Z",
    }),
  );
  if (stillHeld) {
    assert(outcome.kind === "tier1_direct", `third pass with held must stay tier1_direct, got ${outcome.kind}`);
    assert(outcome.signal.provenance === "user-expressed", "third pass held provenance");
  } else {
    // Captured path already acked held — demoted alone is non-Tier1; no new CE.
    assert(outcome.kind !== "tier1_direct" || outcome.signal?.provenance === "user-expressed",
      `without held, demoted must not open a fresh tier1 authorization: ${outcome.kind}`);
  }
  assert(countCeEvents() === 1, `CE must stay exactly-once across turn1/2/3, got ${countCeEvents()}`);
  const ce = readSoleCeEnvelope();
  const ceId = ce.event_id ?? ce.body_hash;
  assert(ceId === firstCeEventId, `CE event_id must be stable across windows: ${ceId} !== ${firstCeEventId}`);
  assert(ce.body?.turn_id === SOURCE_TURN, `third pass CE turn_id still held source, got ${ce.body?.turn_id}`);
  assert(ce.body?.created_at_utc === SOURCE_TS, `third pass CE created_at still held source, got ${ce.body?.created_at_utc}`);
  assert(ce.body?.turn_id !== "turn3", "CE must not adopt turn3");
});

// --- RUNTIME_PROVENANCE_SPLIT restart-only HOLD (PID1533336 class) ---
// Separate session so quarantine CE exactly-once above stays isolated.
const PROV_SESSION = "held-retry-prov-split";
const PROV_TURN = "turn1";
const PROV_TS = "2026-07-25T08:00:00.000Z";
let provFrozenHeld = null;
let provCeEventId = null;
const ceBeforeProv = countCeEvents();

await check("RUNTIME_PROVENANCE_SPLIT forced throw → rejected non-terminal, held pending, no checkpoint advance", async () => {
  index._resetAutoWriteStateForTests();
  index._setAppendTier1ForceThrowForTests({
    remaining: 1,
    errorFactory: () => Object.assign(
      new Error("RUNTIME_PROVENANCE_SPLIT: jiti/module copies loaded different implementation provenance"),
      { name: "CanonicalGitRuntimeError", code: "RUNTIME_PROVENANCE_SPLIT" },
    ),
  });

  const outcome = await index._tryAutoWriteLaneForTests(
    laneArgs(PROV_SESSION, authorizedSignal, `${PROV_SESSION}:auto-1`, {
      turnId: PROV_TURN,
      timestamp: PROV_TS,
    }),
  );
  assert(outcome.kind === "tier1_direct", `expected tier1_direct, got ${outcome.kind}`);
  assert(outcome.result.status === "rejected", `expected rejected, got ${outcome.result.status}`);
  assert(
    (outcome.result.reason ?? "") === "constraint_evidence_append_failed:RUNTIME_PROVENANCE_SPLIT"
      || (outcome.result.reason ?? "").startsWith("constraint_evidence_append_failed:RUNTIME_PROVENANCE_SPLIT"),
    `expected RUNTIME_PROVENANCE_SPLIT reason, got ${outcome.result.reason}`,
  );
  assert(
    index._isTerminalTier1RejectForTests(outcome.result) === false,
    "RUNTIME_PROVENANCE_SPLIT reject must not be terminal",
  );
  assert(index._shouldAdvanceAfterAutoOutcomeForTests(outcome) === false, "must not advance checkpoint");
  assert(countCeEvents() === ceBeforeProv, "CE must not exist after provenance-split throw");

  const held = await index._listTier1HeldDecisionsForSessionForTests(abrainHome, PROV_SESSION);
  assert(held.length === 1, `expected 1 held decision, got ${held.length}`);
  assert(held[0].signal.provenance === "user-expressed", "held provenance must stay user-expressed");
  assert(held[0].signal.rule_scope === "project", "held rule_scope must stay project");
  assert(held[0].holdReason.includes("RUNTIME_PROVENANCE_SPLIT"), `holdReason=${held[0].holdReason}`);
  assert(held[0].sourceTurnId === PROV_TURN, `held sourceTurnId must be ${PROV_TURN}, got ${held[0].sourceTurnId}`);
  assert(held[0].authorizedAtUtc === PROV_TS, `held authorizedAtUtc must be ${PROV_TS}, got ${held[0].authorizedAtUtc}`);
  provFrozenHeld = {
    sessionId: held[0].sessionId,
    projectId: held[0].projectId,
    sourceTurnId: held[0].sourceTurnId,
    authorizedAtUtc: held[0].authorizedAtUtc,
    decisionId: held[0].decisionId,
  };
  index._setAppendTier1ForceThrowForTests(null);
});

await check("restart after RUNTIME_PROVENANCE_SPLIT: held survives, same lineage captures, held can ack", async () => {
  // Simulate process restart: clear in-memory state; disk held remains. Force-throw cleared
  // (restart heals process-level provenance fingerprint).
  index._resetAutoWriteStateForTests();
  index._setAppendTier1ForceThrowForTests(null);

  const peeked = await index._peekOldestTier1HeldDecisionForTests(abrainHome, PROV_SESSION);
  assert(peeked, "held must survive process state reset after provenance split");
  assert(peeked.signal.provenance === "user-expressed", "restart held provenance");
  assert(peeked.sourceTurnId === PROV_TURN, "restart held sourceTurnId frozen");
  assert(peeked.authorizedAtUtc === PROV_TS, "restart held authorizedAtUtc frozen");
  assert(peeked.decisionId === provFrozenHeld.decisionId, "restart held decisionId stable");

  const outcome = await index._tryAutoWriteLaneForTests(
    laneArgs(PROV_SESSION, demotedSignal, `${PROV_SESSION}:auto-2`, {
      turnId: "turn2",
      timestamp: "2026-07-25T09:00:00.000Z",
    }),
  );
  assert(outcome.kind === "tier1_direct", `retry must stay tier1_direct, got ${outcome.kind}`);
  assert(outcome.signal.provenance === "user-expressed", `retry must use original provenance, got ${outcome.signal.provenance}`);
  assert(outcome.signal.rule_scope === "project", `retry must use original rule_scope, got ${outcome.signal.rule_scope}`);
  assert(
    outcome.result.status === "deduped" || outcome.result.status === "created",
    `expected capture status after restart, got ${JSON.stringify(outcome.result)}`,
  );
  const reason = outcome.result.reason ?? "";
  assert(
    reason.startsWith("constraint_compiler_publication_pending:")
      || reason.startsWith("constraint_compiler_publication_durable:"),
    `unexpected success reason: ${reason}`,
  );
  assert(countCeEvents() === ceBeforeProv + 1, `exactly-once CE for provenance session, got ${countCeEvents()}`);

  // Find the CE belonging to this session (quarantine session may already have one).
  const ceFiles = listCeEventFiles();
  const matching = ceFiles
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
    .filter((env) => env?.body?.session_id === PROV_SESSION);
  assert(matching.length === 1, `expected 1 CE for ${PROV_SESSION}, got ${matching.length}`);
  const ce = matching[0];
  provCeEventId = ce.event_id ?? ce.body_hash;
  assert(typeof provCeEventId === "string" && /^[0-9a-f]{64}$/.test(provCeEventId), `CE event_id invalid: ${provCeEventId}`);
  assert(ce.body?.turn_id === provFrozenHeld.sourceTurnId, `CE turn_id must be held source, got ${ce.body?.turn_id}`);
  assert(ce.body?.created_at_utc === provFrozenHeld.authorizedAtUtc, `CE created_at_utc must be held source, got ${ce.body?.created_at_utc}`);
  assert(ce.body?.turn_id !== "turn2", "CE must not use current retry window turnId");

  const heldAfter = await index._listTier1HeldDecisionsForSessionForTests(abrainHome, PROV_SESSION);
  if (reason.startsWith("constraint_compiler_publication_pending:")) {
    assert(heldAfter.length === 1, `pending publication should keep held for retry, got ${heldAfter.length}`);
    assert(heldAfter[0].sourceTurnId === PROV_TURN, "re-hold keeps sourceTurnId");
    assert(index._shouldAdvanceAfterAutoOutcomeForTests(outcome) === false, "pending publication HOLDs checkpoint");
  } else {
    assert(heldAfter.length === 0, `captured path should ack held, still pending=${heldAfter.length}`);
  }
});

await check("held decision identity is content-addressed (no wall clock)", () => {
  const a = heldMod.computeTier1HeldDecisionId({
    sessionId: "s",
    projectId: "pi-astack",
    candidateId: "tier1-direct:c0",
    signal: { user_quote: USER_QUOTE, rule_scope: "project" },
  });
  const b = heldMod.computeTier1HeldDecisionId({
    sessionId: "s",
    projectId: "pi-astack",
    candidateId: "tier1-direct:c0",
    signal: { user_quote: USER_QUOTE, rule_scope: "project" },
  });
  assert(a === b && /^[0-9a-f]{64}$/.test(a), "decisionId must be stable sha256");
});

await check("freezeTier1HeldSignal reuses isTier1Directive fail-closed", () => {
  const ok = heldMod.freezeTier1HeldSignal(authorizedSignal);
  assert(ok.provenance === "user-expressed" && ok.is_directive === true, "freeze authorized");
  let threw = false;
  try {
    heldMod.freezeTier1HeldSignal(demotedSignal);
  } catch {
    threw = true;
  }
  assert(threw, "demoted non-Tier1 signal must fail-closed");
  let threw2 = false;
  try {
    heldMod.freezeTier1HeldSignal({
      signal_found: true,
      typing: "durable",
      provenance: "user-expressed",
      rule_scope: "project",
      // missing is_directive and conf<8 → not Tier-1
      confidence: 3,
      user_quote: USER_QUOTE,
    });
  } catch {
    threw2 = true;
  }
  assert(threw2, "low-conf non-directive must fail-closed via isTier1Directive");
});

// --- Formal production API: executeTier1HeldAuthorizedRetry ---
// Operator surface must NOT be a test-only re-export of tryAutoWriteLane.
const FORMAL_SESSION = "held-retry-formal-api";
const FORMAL_TURN = "formal-turn1";
const FORMAL_TS = "2026-07-25T11:00:00.000Z";
const ceBeforeFormal = countCeEvents();

await check("formal API: empty held → kind empty (does not touch lane)", async () => {
  index._resetAutoWriteStateForTests();
  index._setAppendTier1ForceThrowForTests({
    remaining: 1,
    errorFactory: () => Object.assign(
      new Error("RECOVERY_QUARANTINED: must not fire on empty formal API"),
      { name: "CanonicalGitRuntimeError", code: "RECOVERY_QUARANTINED" },
    ),
  });
  const ceBefore = countCeEvents();
  const result = await index.executeTier1HeldAuthorizedRetry({
    abrainHome,
    sessionId: "held-retry-formal-empty",
    correlationId: "held-retry-formal-empty:1",
    cwd: projectRoot,
    settings: baseSettings(),
    modelRegistry: mockModelRegistry,
  });
  assert(result.kind === "empty", `expected empty, got ${JSON.stringify(result)}`);
  assert(countCeEvents() === ceBefore, "empty formal API must not write CE");
  // Force-throw budget must remain (lane never entered → append never called).
  // Consume via a real lane attempt later only if held exists; here seed nothing.
  const stillEmpty = await index.executeTier1HeldAuthorizedRetry({
    abrainHome,
    sessionId: "held-retry-formal-empty",
    correlationId: "held-retry-formal-empty:2",
    cwd: projectRoot,
    settings: baseSettings(),
    modelRegistry: mockModelRegistry,
  });
  assert(stillEmpty.kind === "empty", "second empty peek stays empty");
  // If force-throw had been consumed by empty path, a subsequent held retry
  // under throw would not see it. Seed held + formal retry must still throw.
  const seeded = await index._holdTier1AuthorizedDecisionForTests(abrainHome, {
    sessionId: "held-retry-formal-empty-probe",
    projectId: "pi-astack",
    projectRoot,
    sourceTurnId: "probe-turn",
    authorizedAtUtc: "2026-07-25T11:30:00.000Z",
    holdReason: "probe_force_throw_budget",
    candidateId: "tier1-direct:c0",
    signal: authorizedSignal,
  });
  const probe = await index.executeTier1HeldAuthorizedRetry({
    abrainHome,
    sessionId: "held-retry-formal-empty-probe",
    correlationId: "held-retry-formal-empty:probe",
    // Intentionally omit cwd: held.projectRoot must win.
    settings: baseSettings(),
    modelRegistry: mockModelRegistry,
  });
  assert(probe.kind === "retried", `probe must retry seeded held, got ${probe.kind}`);
  assert(probe.decisionId === seeded.decision.decisionId, "probe decisionId");
  assert(probe.outcome.kind === "tier1_direct", `probe outcome ${probe.outcome.kind}`);
  assert(probe.outcome.result.status === "rejected", "force-throw budget must still be live after empty");
  assert(
    (probe.outcome.result.reason ?? "").includes("RECOVERY_QUARANTINED"),
    `probe reason=${probe.outcome.result.reason}`,
  );
  index._setAppendTier1ForceThrowForTests(null);
  // Ack probe held so it does not pollute later formal session checks.
  await index._ackTier1HeldDecisionForTests(abrainHome, seeded.decision.decisionId);
});

await check("formal API: forced transient keeps original held lineage", async () => {
  index._resetAutoWriteStateForTests();
  index._setAppendTier1ForceThrowForTests({
    remaining: 1,
    errorFactory: () => Object.assign(
      new Error("RECOVERY_QUARANTINED: formal API transient hold"),
      { name: "CanonicalGitRuntimeError", code: "RECOVERY_QUARANTINED" },
    ),
  });
  const seeded = await index._holdTier1AuthorizedDecisionForTests(abrainHome, {
    sessionId: FORMAL_SESSION,
    projectId: "pi-astack",
    projectRoot,
    sourceTurnId: FORMAL_TURN,
    authorizedAtUtc: FORMAL_TS,
    holdReason: "seed_for_formal_api_transient",
    candidateId: "tier1-direct:c0",
    signal: authorizedSignal,
  });
  assert(seeded.status === "created" || seeded.status === "identical", `seed status=${seeded.status}`);

  const result = await index.executeTier1HeldAuthorizedRetry({
    abrainHome,
    sessionId: FORMAL_SESSION,
    correlationId: `${FORMAL_SESSION}:formal-transient`,
    // Wrong cwd on purpose: held.projectRoot must be preferred for lineage.
    cwd: path.join(tmpRoot, "wrong-project-root-must-not-win"),
    settings: baseSettings(),
    modelRegistry: mockModelRegistry,
  });
  assert(result.kind === "retried", `expected retried, got ${result.kind}`);
  assert(result.decisionId === seeded.decision.decisionId, "formal API returns held decisionId");
  assert(result.outcome.kind === "tier1_direct", `expected tier1_direct, got ${result.outcome.kind}`);
  assert(result.outcome.result.status === "rejected", `expected rejected, got ${result.outcome.result.status}`);
  assert(
    (result.outcome.result.reason ?? "").startsWith("constraint_evidence_append_failed:RECOVERY_QUARANTINED"),
    `reason=${result.outcome.result.reason}`,
  );
  assert(result.outcome.signal.provenance === "user-expressed", "formal transient keeps provenance");
  assert(result.outcome.signal.rule_scope === "project", "formal transient keeps rule_scope");
  assert(result.outcome.signal.is_directive === true, "formal transient keeps is_directive");
  assert(result.outcome.signal.user_quote === USER_QUOTE, "formal transient quote lineage");
  assert(countCeEvents() === ceBeforeFormal, "transient formal API must not write CE");

  const heldAfter = await index._listTier1HeldDecisionsForSessionForTests(abrainHome, FORMAL_SESSION);
  assert(heldAfter.length === 1, `held must remain pending, got ${heldAfter.length}`);
  assert(heldAfter[0].decisionId === seeded.decision.decisionId, "decisionId stable");
  assert(heldAfter[0].sourceTurnId === FORMAL_TURN, "sourceTurnId frozen");
  assert(heldAfter[0].authorizedAtUtc === FORMAL_TS, "authorizedAtUtc frozen");
  assert(heldAfter[0].signal.provenance === "user-expressed", "held provenance frozen");
  assert(heldAfter[0].projectRoot === path.resolve(projectRoot), `held projectRoot=${heldAfter[0].projectRoot}`);
  index._setAppendTier1ForceThrowForTests(null);
});

await check("formal API: success captures + acks held (injected settings)", async () => {
  index._resetAutoWriteStateForTests();
  index._setAppendTier1ForceThrowForTests(null);

  const peeked = await index._peekOldestTier1HeldDecisionForTests(abrainHome, FORMAL_SESSION);
  assert(peeked, "held from transient case must still be pending for success retry");
  assert(peeked.sourceTurnId === FORMAL_TURN, "success path still frozen turn");
  assert(peeked.authorizedAtUtc === FORMAL_TS, "success path still frozen time");

  const result = await index.executeTier1HeldAuthorizedRetry({
    abrainHome,
    sessionId: FORMAL_SESSION,
    correlationId: `${FORMAL_SESSION}:formal-success`,
    settings: baseSettings(),
    modelRegistry: mockModelRegistry,
  });
  assert(result.kind === "retried", `expected retried, got ${result.kind}`);
  assert(result.decisionId === peeked.decisionId, "success returns same decisionId");
  assert(result.outcome.kind === "tier1_direct", `expected tier1_direct, got ${result.outcome.kind}`);
  assert(result.outcome.signal.provenance === "user-expressed", "success keeps original provenance");
  assert(result.outcome.signal.rule_scope === "project", "success keeps original rule_scope");
  assert(
    result.outcome.result.status === "deduped" || result.outcome.result.status === "created",
    `expected capture status, got ${JSON.stringify(result.outcome.result)}`,
  );
  const reason = result.outcome.result.reason ?? "";
  assert(
    reason.startsWith("constraint_compiler_publication_pending:")
      || reason.startsWith("constraint_compiler_publication_durable:"),
    `unexpected success reason: ${reason}`,
  );
  assert(countCeEvents() === ceBeforeFormal + 1, `exactly-once CE for formal session, got ${countCeEvents()}`);

  const ceFiles = listCeEventFiles();
  const matching = ceFiles
    .map((f) => JSON.parse(fs.readFileSync(f, "utf8")))
    .filter((env) => env?.body?.session_id === FORMAL_SESSION);
  assert(matching.length === 1, `expected 1 CE for ${FORMAL_SESSION}, got ${matching.length}`);
  const ce = matching[0];
  assert(ce.body?.turn_id === FORMAL_TURN, `CE turn_id must be held source, got ${ce.body?.turn_id}`);
  assert(ce.body?.created_at_utc === FORMAL_TS, `CE created_at must be held source, got ${ce.body?.created_at_utc}`);
  const scopeProjectId = ce.body?.scope?.scope_hint?.project_id
    ?? ce.body?.scope?.active_project_binding?.project_id;
  assert(scopeProjectId === "pi-astack", `CE scope project_id from held, got ${scopeProjectId}`);

  const heldAfter = await index._listTier1HeldDecisionsForSessionForTests(abrainHome, FORMAL_SESSION);
  if (reason.startsWith("constraint_compiler_publication_pending:")) {
    assert(heldAfter.length === 1, `pending publication keeps held, got ${heldAfter.length}`);
    assert(heldAfter[0].sourceTurnId === FORMAL_TURN, "re-hold keeps sourceTurnId");
    assert(index._shouldAdvanceAfterAutoOutcomeForTests(result.outcome) === false, "pending HOLDs checkpoint");
  } else {
    assert(heldAfter.length === 0, `captured path should ack held, still pending=${heldAfter.length}`);
  }
});

await check("formal API is production export (not test-only operator)", () => {
  assert(typeof index.executeTier1HeldAuthorizedRetry === "function", "executeTier1HeldAuthorizedRetry must be exported");
  // Test-only lane export may exist for fixtures, but operator must be the formal API.
  assert(typeof index._tryAutoWriteLaneForTests === "function", "fixture lane hook still present");
  const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf8");
  assert(
    /export async function executeTier1HeldAuthorizedRetry\(/.test(src),
    "formal API must be a real export async function",
  );
  assert(
    !/export const executeTier1HeldAuthorizedRetry\s*=\s*_tryAutoWriteLaneForTests/.test(src),
    "formal API must not alias the test-only lane export",
  );
  assert(
    /correctionSignal:\s*null/.test(src)
      && /tier1ExtractorFollowUp:\s*false/.test(src)
      && /peekOldestTier1HeldDecision/.test(src),
    "formal API must peek held then call private lane with null correction + no extractor follow-up",
  );
});

// cleanup
index._setAppendTier1ForceThrowForTests(null);
if (originalEnv.HOME === undefined) delete process.env.HOME;
else process.env.HOME = originalEnv.HOME;
if (originalEnv.ABRAIN_ROOT === undefined) delete process.env.ABRAIN_ROOT;
else process.env.ABRAIN_ROOT = originalEnv.ABRAIN_ROOT;
if (originalEnv.PI_ASTACK_SETTINGS_PATH === undefined) delete process.env.PI_ASTACK_SETTINGS_PATH;
else process.env.PI_ASTACK_SETTINGS_PATH = originalEnv.PI_ASTACK_SETTINGS_PATH;
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n${failures.length === 0 ? "PASS" : "FAIL"} — ${passed} passed, ${failures.length} failed (tier1 held authorized retry).`);
if (failures.length) process.exit(1);
