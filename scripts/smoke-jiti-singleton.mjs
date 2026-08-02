#!/usr/bin/env node
/**
 * Smoke: ADR 0027 PR-B+ R4 NEW-P0 — globalThis singleton for cross-extension state.
 *
 * # Problem this pins
 *
 * pi's extension loader uses `createJiti(..., { moduleCache: false })` per
 * extension. Empirically verified that this disables both jiti's entry
 * cache AND its nested-import cache: each extension that imports a shared
 * module gets its OWN copy with separate module-level state.
 *
 * Before R4 NEW-P0 fix, this silently broke:
 *   - PR-B sub-agent WeakSet (dispatch marks, sediment can't see)
 *   - R3 sub-agent anchor scope (dispatch's ALS invisible to memory)
 *   - P1-3 anchor retrofit for cross-extension writers
 *
 * Fix: state stored on `globalThis[Symbol.for(...)]` so all module
 * instances share the same object.
 *
 * # What this smoke verifies
 *
 *   - causal-anchor: live state + ALS scope shared across jiti instances
 *   - pi-internals: WeakSet sub-agent marker shared across jiti instances
 *
 * If this smoke fails, the entire cross-extension contract is broken.
 * Future refactors that demote globalThis singletons back to module locals
 * will be caught HERE before they ship.
 */

import { createJiti } from "jiti/static";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(() => fn())
    .then(() => console.log(`  ok    ${name}`))
    .catch((err) => {
      failures.push({ name, err });
      console.log(`  FAIL  ${name}\n        ${err.message}`);
    });
}

async function loadFresh(path) {
  return await createJiti(import.meta.url, { moduleCache: false }).import(path);
}

console.log("jiti singleton verification (ADR 0027 PR-B+ R4 NEW-P0)");

const anchorPath = `${repoRoot}/extensions/_shared/causal-anchor.ts`;
const piInternalsPath = `${repoRoot}/extensions/_shared/pi-internals.ts`;

// ── causal-anchor: cross-extension singleton ──────────────────

console.log("\n  causal-anchor:");

await check("two jiti instances produce different module objects (baseline sanity)", async () => {
  const a = await loadFresh(anchorPath);
  const b = await loadFresh(anchorPath);
  if (a === b) {
    throw new Error("jiti returned the SAME module object — moduleCache:false invariant broken; this smoke can't prove anything");
  }
});

await check("live anchor state shared via globalThis (dispatch sets, memory reads)", async () => {
  const dispatchInstance = await loadFresh(anchorPath);
  const memoryInstance = await loadFresh(anchorPath);

  dispatchInstance._resetCausalAnchorForTests();
  dispatchInstance._setCurrentAnchorForTests("shared-session", 77);

  const memReads = memoryInstance.getCurrentAnchor();
  if (!memReads) {
    throw new Error("memory instance reads undefined — globalThis state NOT shared");
  }
  if (memReads.session_id !== "shared-session" || memReads.turn_id !== 77) {
    throw new Error(`memory read wrong state: ${JSON.stringify(memReads)}`);
  }
});

await check("ALS scope shared: dispatch.runWithTriggerAnchor → memory.getCurrentAnchor inside", async () => {
  const dispatchInstance = await loadFresh(anchorPath);
  const memoryInstance = await loadFresh(anchorPath);

  dispatchInstance._resetCausalAnchorForTests();
  dispatchInstance._setCurrentAnchorForTests("live-only", 1);

  let memReads;
  await dispatchInstance.runWithTriggerAnchor(
    { session_id: "scope-test", turn_id: 99, subturn: 3 },
    async () => {
      memReads = memoryInstance.getCurrentAnchor();
    },
  );

  if (!memReads) {
    throw new Error("memory reads undefined inside dispatch's ALS scope — ALS NOT shared");
  }
  if (memReads.turn_id !== 99 || memReads.subturn !== 3) {
    throw new Error(
      `memory reads wrong anchor inside dispatch scope: ${JSON.stringify(memReads)}\n` +
      `(this is the exact failure mode of R3 fix without globalThis singleton)`,
    );
  }
});

await check("subturn counter shared: dispatch.derive twice → memory sees seq=2 next", async () => {
  const dispA = await loadFresh(anchorPath);
  const dispB = await loadFresh(anchorPath);

  dispA._resetCausalAnchorForTests();
  const parent = { session_id: "S", turn_id: 1 };
  const r1 = dispA.deriveSubAgentAnchor(parent);
  const r2 = dispB.deriveSubAgentAnchor(parent); // different instance, same counter
  if (r1.subturn !== 1) throw new Error(`r1 subturn ${r1.subturn} ≠ 1`);
  if (r2.subturn !== 2) {
    throw new Error(`r2 subturn ${r2.subturn} ≠ 2 — counter NOT shared (would be 1 if isolated)`);
  }
});

// ── pi-internals: cross-extension WeakSet ──────────────────

console.log("\n  pi-internals:");

await check("sub-agent WeakSet shared: dispatch marks SM, sediment isSubAgentSession sees it", async () => {
  const dispatchPi = await loadFresh(piInternalsPath);
  const sedimentPi = await loadFresh(piInternalsPath);

  const sm = { brand: "fake-sub-agent-sm" };
  dispatchPi.markSessionAsSubAgent(sm);

  const dispatchSees = dispatchPi.isSubAgentSession({ sessionManager: sm });
  const sedimentSees = sedimentPi.isSubAgentSession({ sessionManager: sm });
  if (!dispatchSees) throw new Error("dispatch can't see its own mark — basic WeakSet broken");
  if (!sedimentSees) {
    throw new Error(
      "sediment can't see dispatch's mark — WeakSet NOT shared across instances.\n" +
      "This is the silent PR-B violation: sub-agent sediment.agent_end would fire\n" +
      "and learn sub-agent reasoning as user implicit truth signal.",
    );
  }
});

await check("boundary probe status shared: dispatch sets ok, sediment reads ok", async () => {
  const dispatchPi = await loadFresh(piInternalsPath);
  const sedimentPi = await loadFresh(piInternalsPath);

  dispatchPi._resetSubAgentBoundaryProbeForTests();
  if (dispatchPi.getSubAgentBoundaryStatus() !== "untested") {
    throw new Error("reset didn't take");
  }
  if (sedimentPi.getSubAgentBoundaryStatus() !== "untested") {
    throw new Error("reset didn't propagate to other instance");
  }

  // Simulate sentinel firing in dispatch: install + trigger by faking a session_start
  const handlers = new Map();
  const pi = { on: (e, h) => handlers.set(e, h) };
  dispatchPi.bindSubAgentBoundarySentinel(pi);

  const sm = { kind: "test" };
  dispatchPi.markSessionAsSubAgent(sm);
  handlers.get("session_start")({}, { sessionManager: sm });

  const dispatchSees = dispatchPi.getSubAgentBoundaryStatus();
  const sedimentSees = sedimentPi.getSubAgentBoundaryStatus();
  if (dispatchSees !== "ok") throw new Error(`dispatch status ${dispatchSees} ≠ ok`);
  if (sedimentSees !== "ok") {
    throw new Error(`sediment status ${sedimentSees} ≠ ok — probe state NOT shared`);
  }
});

// ── csj witness mint: cross-extension capability share ─────────

console.log("\n  csj-witness-mint:");

await check("memory+sediment dual jiti load shares mint capability (no already-installed throw)", async () => {
  const memoryPath = `${repoRoot}/extensions/memory/index.ts`;
  const sedimentPath = `${repoRoot}/extensions/sediment/index.ts`;
  const memoryMod = await loadFresh(memoryPath);
  const sedimentMod = await loadFresh(sedimentPath);
  if (typeof memoryMod?.default !== "function") {
    throw new Error(`memory factory missing: ${typeof memoryMod?.default}`);
  }
  if (typeof sedimentMod?.default !== "function") {
    throw new Error(`sediment factory missing: ${typeof sedimentMod?.default}`);
  }
  // Third prospective-merge instance (would previously throw already installed).
  const mergePath = `${repoRoot}/extensions/_shared/csj-prospective-merge.ts`;
  const mergeMod = await loadFresh(mergePath);
  if (!mergeMod || typeof mergeMod !== "object") {
    throw new Error("csj-prospective-merge third instance failed to load");
  }
});

await check("same-version mint reinstall returns shared fn; bad nonce / shape conflict fail closed", async () => {
  const refPath = `${repoRoot}/extensions/_shared/canonical-ref-move.ts`;
  const refMove = await loadFresh(refPath);
  const nonce = Symbol.for("pi-astack/csj-witness-mint-install-nonce");
  const mintA = refMove.installCsjWitnessMintCapability(nonce);
  const mintB = refMove.installCsjWitnessMintCapability(nonce);
  if (typeof mintA !== "function" || mintA !== mintB) {
    throw new Error("same-version reinstall did not return shared mint");
  }
  let badNonce = false;
  try {
    refMove.installCsjWitnessMintCapability(Symbol("not-install-nonce"));
  } catch (err) {
    badNonce = /CAPABILITY|nonce invalid/i.test(String(err?.code || err?.message || err));
  }
  if (!badNonce) throw new Error("invalid nonce must fail closed");
  const capKey = Symbol.for("pi-astack/csj-witness-mint-capability/v1");
  const saved = globalThis[capKey];
  try {
    globalThis[capKey] = Object.freeze({ version: 999, shape: "foreign", mint: () => null });
    let conflict = false;
    try {
      refMove.installCsjWitnessMintCapability(nonce);
    } catch (err) {
      conflict = /version\/shape conflict|CAPABILITY/i.test(String(err?.message || err));
    }
    if (!conflict) throw new Error("version/shape conflict must fail closed");
  } finally {
    globalThis[capKey] = saved;
  }
});

// ── Summary ────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`✅ jiti singleton: all checks passed`);
  process.exit(0);
} else {
  console.error(`❌ jiti singleton: ${failures.length} failure(s)`);
  for (const { name, err } of failures) {
    console.error(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
