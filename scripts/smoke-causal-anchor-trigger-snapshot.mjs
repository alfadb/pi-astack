#!/usr/bin/env node
/**
 * Smoke: ADR 0027 PR-B+ R1 P0-β — trigger-time anchor snapshot via ALS.
 *
 * Pins the contract that `runWithTriggerAnchor(snapshot, ...)`:
 *   1. Makes getCurrentAnchor() return the snapshot inside the scope
 *   2. Propagates through awaits, setTimeouts, microtasks, Promise chains
 *   3. Propagates into fire-and-forget promises CREATED inside the scope,
 *      even after the scope's synchronous portion has returned
 *   4. Does NOT leak to async work created OUTSIDE the scope (e.g., the
 *      next pi event loop tick when user submits the next prompt)
 *   5. Falls back to live module-level state when no scope is active
 *
 * Why this smoke matters: this is the structural defense for P0-β —
 * without ALS propagation, sediment Lane C / curator audit rows would
 * carry the WRONG turn_id after long-running LLM work completes
 * post-next-prompt. This smoke pins the propagation behavior of Node's
 * AsyncLocalStorage so a future refactor that changes the wrap pattern
 * (e.g., to dispatch directly instead of through ALS) cannot silently
 * regress.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
function check(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => console.log(`  ok    ${name}`),
        (err) => {
          failures.push({ name, err });
          console.log(`  FAIL  ${name}\n        ${err.message}`);
        },
      );
    }
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: srcPath,
  }).outputText;
}

function loadCJS(code, fakePath, stubMap) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  const origLoad = Module._load;
  if (stubMap) {
    Module._load = function patched(request, parent, ...rest) {
      if (stubMap.has(request)) return stubMap.get(request);
      return origLoad.call(this, request, parent, ...rest);
    };
  }
  try {
    m._compile(code, fakePath);
  } finally {
    if (stubMap) Module._load = origLoad;
  }
  return m.exports;
}

// ── Stage causal-anchor.ts ─────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "causal-anchor-trigger-"));

const piInternalsStub = {
  isSubAgentSession: () => false,
};
const piApiStub = {};

const anchorSrc = path.join(repoRoot, "extensions/_shared/causal-anchor.ts");
const anchorCjs = transpile(anchorSrc);
const anchorPath = path.join(tmpDir, "causal-anchor.cjs");
fs.writeFileSync(anchorPath, anchorCjs);
const anchor = loadCJS(
  anchorCjs,
  anchorPath,
  new Map([
    ["./pi-internals", piInternalsStub],
    ["@earendil-works/pi-coding-agent", piApiStub],
  ]),
);

const {
  getCurrentAnchor,
  runWithTriggerAnchor,
  spreadAnchor,
  _setCurrentAnchorForTests,
  _resetCausalAnchorForTests,
} = anchor;

// ── Tests ──────────────────────────────────────────────────────

console.log("causal-anchor trigger-time snapshot (ADR 0027 PR-B+ R1 P0-β)");

const ANCHOR_N   = { session_id: "s-aaa", turn_id: 10 };
const ANCHOR_N1  = { session_id: "s-aaa", turn_id: 11 };

await check("no-scope: getCurrentAnchor returns live state", () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-live", 7);
  const a = getCurrentAnchor();
  if (!a || a.session_id !== "s-live" || a.turn_id !== 7) {
    throw new Error(`expected live anchor, got ${JSON.stringify(a)}`);
  }
});

await check("scope: getCurrentAnchor returns scope snapshot, NOT live", () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-live", 7); // live state set

  // Enter scope with a DIFFERENT anchor
  return runWithTriggerAnchor(ANCHOR_N, () => {
    const a = getCurrentAnchor();
    if (!a || a.turn_id !== 10) {
      throw new Error(`expected snapshot turn_id=10, got ${JSON.stringify(a)}`);
    }
    if (a.session_id !== "s-aaa") {
      throw new Error(`expected snapshot session_id=s-aaa, got ${JSON.stringify(a)}`);
    }
  });
});

await check("scope propagates through await chain", async () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-live", 99);

  await runWithTriggerAnchor(ANCHOR_N, async () => {
    await new Promise((r) => setTimeout(r, 5));
    const a = getCurrentAnchor();
    if (a?.turn_id !== 10) {
      throw new Error(`after await: expected turn_id=10, got ${JSON.stringify(a)}`);
    }
    await Promise.resolve();
    const b = getCurrentAnchor();
    if (b?.turn_id !== 10) {
      throw new Error(`after Promise.resolve: expected turn_id=10, got ${JSON.stringify(b)}`);
    }
  });
});

await check("scope propagates into fire-and-forget — CRITICAL P0-β regression test", async () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-live", 50); // simulate "live state was at 50"

  let bgAnchorSeen;
  const bgDone = new Promise((resolve) => {
    runWithTriggerAnchor(ANCHOR_N, () => {
      // Inside scope: kick off bg promise without awaiting it
      void (async () => {
        await new Promise((r) => setTimeout(r, 30)); // simulate ~30ms async work
        // While bg work is sleeping, simulate user submitting next prompt
        // → before_agent_start bumps live turn_id
        // (done in the outer .then() below)
        bgAnchorSeen = getCurrentAnchor();
        resolve();
      })();
    });
  });

  // Simulate next-prompt advancing live state DURING bg work
  await new Promise((r) => setTimeout(r, 10));
  _setCurrentAnchorForTests("s-live", 51); // live advanced N → N+1

  // Wait for bg to complete
  await bgDone;

  // CRITICAL: bg work must see the ORIGINAL scope snapshot (turn 10),
  // NOT the advanced live state (turn 51).
  if (!bgAnchorSeen) {
    throw new Error("bg work saw no anchor");
  }
  if (bgAnchorSeen.turn_id !== 10) {
    throw new Error(
      `P0-β REGRESSION: bg work saw live turn_id=${bgAnchorSeen.turn_id} instead of snapshot turn_id=10`,
    );
  }
});

await check("scope does NOT leak to setTimeout created OUTSIDE scope", async () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-live", 100);

  // Set up a "next user prompt" task BEFORE entering scope
  let outsideAnchorSeen;
  const outsideDone = new Promise((resolve) => {
    setTimeout(() => {
      outsideAnchorSeen = getCurrentAnchor();
      resolve();
    }, 30);
  });

  // Now run scope with a different snapshot
  await runWithTriggerAnchor(ANCHOR_N, async () => {
    await new Promise((r) => setTimeout(r, 5));
  });

  await outsideDone;

  // The outside setTimeout was created BEFORE the scope existed, so it
  // should see live state, not the scope snapshot.
  if (!outsideAnchorSeen || outsideAnchorSeen.session_id !== "s-live") {
    throw new Error(
      `scope leaked to outside task: ${JSON.stringify(outsideAnchorSeen)}`,
    );
  }
});

await check("nested scopes: inner overrides outer", async () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-live", 200);

  await runWithTriggerAnchor(ANCHOR_N, async () => {
    if (getCurrentAnchor()?.turn_id !== 10) throw new Error("outer scope failed");

    await runWithTriggerAnchor(ANCHOR_N1, async () => {
      const inner = getCurrentAnchor();
      if (inner?.turn_id !== 11) {
        throw new Error(`inner override failed: ${JSON.stringify(inner)}`);
      }
    });

    // After inner scope exits, outer scope restored
    if (getCurrentAnchor()?.turn_id !== 10) {
      throw new Error("outer scope not restored after inner exit");
    }
  });

  // After outer exits, back to live
  if (getCurrentAnchor()?.turn_id !== 200) {
    throw new Error("live state not restored after all scopes exit");
  }
});

await check("scope with anchor=undefined: getCurrentAnchor returns undefined (not live fallback)", async () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-live", 5);

  await runWithTriggerAnchor(undefined, async () => {
    const a = getCurrentAnchor();
    if (a !== undefined) {
      throw new Error(
        `scope explicitly set undefined; getCurrentAnchor should return undefined (NOT fallback to live ${JSON.stringify(a)})`,
      );
    }
  });

  // Outside scope: back to live
  if (getCurrentAnchor()?.turn_id !== 5) {
    throw new Error("live state not visible after undefined scope");
  }
});

await check("spreadAnchor inside scope reflects snapshot", async () => {
  _resetCausalAnchorForTests();
  _setCurrentAnchorForTests("s-live", 77);

  await runWithTriggerAnchor(ANCHOR_N, async () => {
    const spread = spreadAnchor(getCurrentAnchor());
    if (spread.turn_id !== 10) {
      throw new Error(`spread saw wrong turn: ${JSON.stringify(spread)}`);
    }
    if (spread.session_id !== "s-aaa") {
      throw new Error(`spread saw wrong session: ${JSON.stringify(spread)}`);
    }
  });
});

await check(
  "concurrent scopes: parallel runWithTriggerAnchor calls don't cross-contaminate",
  async () => {
    _resetCausalAnchorForTests();
    _setCurrentAnchorForTests("s-live", 1000);

    let scopeAResult, scopeBResult;

    const a = runWithTriggerAnchor({ session_id: "s-A", turn_id: 1 }, async () => {
      await new Promise((r) => setTimeout(r, 20));
      scopeAResult = getCurrentAnchor();
    });

    const b = runWithTriggerAnchor({ session_id: "s-B", turn_id: 2 }, async () => {
      await new Promise((r) => setTimeout(r, 10));
      scopeBResult = getCurrentAnchor();
    });

    await Promise.all([a, b]);

    if (scopeAResult?.session_id !== "s-A" || scopeAResult?.turn_id !== 1) {
      throw new Error(`scope A cross-contaminated: ${JSON.stringify(scopeAResult)}`);
    }
    if (scopeBResult?.session_id !== "s-B" || scopeBResult?.turn_id !== 2) {
      throw new Error(`scope B cross-contaminated: ${JSON.stringify(scopeBResult)}`);
    }
  },
);

await check(
  "end-to-end P0-β scenario: handler dispatches LLM extractor that completes after next turn",
  async () => {
    // Simulate the actual sediment Lane C scenario:
    //  1. agent_end fires for turn N → handler entered, snapshot captured
    //  2. Handler kicks off fire-and-forget LLM extractor (~30ms simulated)
    //  3. Handler returns synchronously; before_agent_start fires for N+1
    //  4. _currentTurnId advanced to N+1
    //  5. LLM extractor completes, writes audit row → MUST see turn N anchor

    _resetCausalAnchorForTests();
    _setCurrentAnchorForTests("s-real", 5); // we're at turn 5

    // Audit writer simulator (mirrors writer.ts:754 spreadAnchor call)
    const auditRows = [];
    const writeAudit = (kind) => {
      auditRows.push({ kind, ...spreadAnchor(getCurrentAnchor()) });
    };

    // simulate sediment agent_end handler
    const handlerPromise = runWithTriggerAnchor(getCurrentAnchor(), async () => {
      // Sync audit write inside handler (this works either way)
      writeAudit("agent_end_sync_start");

      // Fire-and-forget LLM extractor
      void (async () => {
        await new Promise((r) => setTimeout(r, 30));
        // By now, the outer handler has returned AND _currentTurnId
        // advanced. But our scope-captured anchor must still apply.
        writeAudit("llm_extractor_metrics");
      })();

      // Handler returns immediately (fire-and-forget pattern)
    });

    await handlerPromise; // wait for sync portion to settle

    // Now simulate: user submits next prompt, _currentTurnId bumps
    await new Promise((r) => setTimeout(r, 5));
    _setCurrentAnchorForTests("s-real", 6); // turn 6 now live

    // Wait for fire-and-forget LLM extractor to complete
    await new Promise((r) => setTimeout(r, 50));

    // Verify both audit rows carry turn 5, not turn 6
    if (auditRows.length !== 2) {
      throw new Error(`expected 2 audit rows, got ${auditRows.length}: ${JSON.stringify(auditRows)}`);
    }
    const syncRow = auditRows.find((r) => r.kind === "agent_end_sync_start");
    const bgRow = auditRows.find((r) => r.kind === "llm_extractor_metrics");
    if (syncRow.turn_id !== 5) {
      throw new Error(`sync audit row has wrong turn: ${JSON.stringify(syncRow)}`);
    }
    if (bgRow.turn_id !== 5) {
      throw new Error(
        `P0-β REGRESSION: bg LLM extractor audit has turn ${bgRow.turn_id} (live), should be 5 (trigger snapshot): ${JSON.stringify(bgRow)}`,
      );
    }
  },
);

// ── Summary ────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`✅ causal-anchor trigger snapshot: all checks passed`);
  process.exit(0);
} else {
  console.error(`❌ causal-anchor trigger snapshot: ${failures.length} failure(s)`);
  for (const { name, err } of failures) {
    console.error(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
