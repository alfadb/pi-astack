#!/usr/bin/env node
/**
 * Smoke: model-fallback mutation timing invariants (rewritten 2026-05-21).
 *
 * History: previous version of this smoke simulated old pi's
 * synchronous `_handleAgentEvent` + `_createRetryPromiseForAgentEnd`
 * dispatcher. That dispatcher no longer exists — new pi uses async
 * `_handleAgentEvent` + async `_handlePostAgentRun` for the actual
 * retry path. The old simulation kept passing trivially but no
 * longer proved anything about real pi behavior (see GPT-5.5 review
 * 2026-05-21).
 *
 * This rewrite uses SOURCE-ANCHOR assertions on the model-fallback
 * extension and on pi's internal dispatcher. The invariants under
 * test (proven by GPT-5.5's trace):
 *
 *   I-1. model-fallback's `message_end` handler mutates
 *        `event.message.errorMessage` SYNCHRONOUSLY when the message
 *        is an error. Adding the "connection lost — " prefix lets
 *        pi's retry regex match arbitrary upstream error wordings.
 *
 *   I-2. model-fallback's `agent_end` handler does NOT mutate
 *        errorMessage. The historical "defensive mutation" block
 *        was idempotent no-op (message_end always ran first) and
 *        was removed 2026-05-21. Re-adding it would be wasted work
 *        and a maintenance trap.
 *
 *   I-3. Pi's `_handleAgentEvent` is async and awaits extension
 *        handlers BEFORE evaluating `_willRetryAfterAgentEnd`. This
 *        is what makes (I-1) sufficient: by the time retry is
 *        evaluated, the prefix is already on `errorMessage`.
 *
 *   I-4. Pi's retry regex (`_isRetryableError`) contains
 *        "connection.?lost" so the model-fallback prefix actually
 *        triggers retry. If pi ever drops this pattern, the entire
 *        model-fallback approach silently stops working.
 *
 *   I-5. The pi event payload's `message` field is passed BY
 *        REFERENCE through message_end → agent_end → _handlePostAgentRun.
 *        Mutation in message_end propagates. (Verified once by GPT-5.5
 *        trace; we lock the source files we depend on so a future pi
 *        refactor that inserts a structuredClone() trips this check.)
 *
 * Failure mode of this smoke when implementation drifts:
 *   - I-1 fail   → model-fallback won't retry; user sees errors not auto-recovered.
 *   - I-2 fail   → harmless dead code reintroduced; not a bug but maintenance debt.
 *   - I-3 fail   → race between mutation and retry-evaluation possible.
 *   - I-4 fail   → prefix has no effect; retry never triggers.
 *   - I-5 fail   → mutation lost across the boundary; same as I-1 failure.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Resolve pi-coding-agent install root via Node's normal resolution so
// this works whether pi is installed globally via volta, npm -g, or
// hoisted under the project.
function resolvePiRuntimeRoot() {
  // Try standard global locations first.
  const candidates = [
    "/home/worker/.volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent",
    path.join(process.env.HOME || "", ".volta/tools/image/packages/@earendil-works/pi-coding-agent/lib/node_modules/@earendil-works/pi-coding-agent"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "dist/core/agent-session.js"))) return c;
  }
  // Fallback: try require.resolve from the project root.
  try {
    const pkgPath = require.resolve("@earendil-works/pi-coding-agent/package.json", { paths: [repoRoot] });
    return path.dirname(pkgPath);
  } catch {
    return null;
  }
}

const piRoot = resolvePiRuntimeRoot();
const failures = [];
let totalChecks = 0;
function check(name, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

console.log("Smoke: model-fallback mutation timing (source-anchor invariants)\n");

const mfSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/model-fallback/index.ts"),
  "utf8",
);

// ──────────────────────────────────────────────────────────────────
// I-1: message_end handler synchronously mutates errorMessage prefix
// ──────────────────────────────────────────────────────────────────

console.log("I-1: model-fallback message_end mutation");

check("model-fallback registers a message_end handler", () => {
  // Two message_end handlers actually exist: the sub-pi lightweight one
  // (gated on PI_ABRAIN_DISABLED==="1") and the main-pi full one. Both
  // should be present.
  const matches = mfSrc.match(/pi\.on\(\s*["']message_end["']/g) || [];
  if (matches.length < 2) {
    throw new Error(
      `expected at least 2 pi.on("message_end", ...) — sub-pi + main-pi handlers; ` +
      `found ${matches.length}`,
    );
  }
});

check("message_end handler is synchronous (not async)", () => {
  // Critical: if message_end becomes async, pi's downstream
  // _willRetryAfterAgentEnd (sync) and even the async
  // _handlePostAgentRun could race with mutation depending on
  // microtask ordering. Stay sync.
  if (/pi\.on\(\s*["']message_end["']\s*,\s*async\s/.test(mfSrc)) {
    throw new Error(
      "message_end handler is `async` — this can introduce a microtask race " +
      "with pi's retry evaluation. Keep it synchronous.",
    );
  }
});

check("message_end mutation adds RETRYABLE_PREFIX in-place on errorMessage", () => {
  // The exact mutation pattern. We grep for the assignment because
  // any structural alternative (e.g. building a new object) would
  // break the by-reference propagation invariant (I-5).
  const re = /msg\.errorMessage\s*=\s*RETRYABLE_PREFIX\s*\+\s*msg\.errorMessage/;
  if (!re.test(mfSrc)) {
    throw new Error(
      "Did not find `msg.errorMessage = RETRYABLE_PREFIX + msg.errorMessage` " +
      "in model-fallback. This is the in-place mutation that retry depends on.",
    );
  }
});

check("RETRYABLE_PREFIX value is 'connection lost — '", () => {
  // Matched against pi's retry regex (verified by I-4).
  const m = mfSrc.match(/const\s+RETRYABLE_PREFIX\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error("RETRYABLE_PREFIX constant not found");
  // Em dash, not hyphen. The pi regex matches "connection.?lost" so the
  // exact prefix wording doesn't matter for retry, but it does affect
  // log readability.
  if (!m[1].includes("connection") || !m[1].includes("lost")) {
    throw new Error(`RETRYABLE_PREFIX="${m[1]}" missing "connection"/"lost" — ` +
      `pi's regex won't match`);
  }
});

// ──────────────────────────────────────────────────────────────────
// I-2: agent_end handler does NOT mutate errorMessage
// ──────────────────────────────────────────────────────────────────

console.log("\nI-2: model-fallback agent_end has NO mutation");

check("agent_end handler does NOT assign to msg.errorMessage", () => {
  // Find the agent_end handler block by anchor and scan for assignments.
  const startIdx = mfSrc.indexOf('pi.on("agent_end"');
  if (startIdx < 0) throw new Error('pi.on("agent_end", ...) not found');
  // Take up to the closing `});` at the same indent. Cheap heuristic:
  // grab the next 4000 chars (handler is much shorter).
  const block = mfSrc.slice(startIdx, startIdx + 6000);
  if (/msg\.errorMessage\s*=/.test(block)) {
    throw new Error(
      "agent_end handler contains an assignment to msg.errorMessage — the " +
      "'defensive mutation' was removed 2026-05-21 as dead code (message_end " +
      "always runs first). Re-adding it is harmless but wasteful.",
    );
  }
});

check("agent_end comment explicitly says no mutation here", () => {
  if (!/No mutation here/.test(mfSrc)) {
    throw new Error(
      "Expected an explicit 'No mutation here' comment in agent_end handler " +
      "so a future maintainer knows the omission is intentional",
    );
  }
});

// ──────────────────────────────────────────────────────────────────
// I-3 + I-4: pi internal dispatcher and regex invariants
// ──────────────────────────────────────────────────────────────────

console.log("\nI-3/I-4: pi-coding-agent internal invariants");

if (!piRoot) {
  // Pi not installed locally — skip pi-internal checks but flag it,
  // so a CI environment without pi installed knows why these aren't
  // running. Not a hard failure: the source-anchor on model-fallback
  // alone is enough to detect the most common regression.
  check("pi-coding-agent runtime locatable", () => {
    throw new Error(
      "Could not locate pi-coding-agent install. I-3 / I-4 / I-5 checks " +
      "skipped. If you're running this in CI install pi-coding-agent first.",
    );
  });
} else {
  const piSession = fs.readFileSync(
    path.join(piRoot, "dist/core/agent-session.js"),
    "utf8",
  );

  check("I-3: _handleAgentEvent is async (awaits extension handlers)", () => {
    if (!/_handleAgentEvent\s*=\s*async\s*\(event\)\s*=>/.test(piSession)) {
      throw new Error(
        "Pi's _handleAgentEvent is no longer `async (event) =>` — model-fallback's " +
        "mutation timing assumption broken. Re-trace and adjust handler placement.",
      );
    }
  });

  check("I-3: _emitExtensionEvent is awaited inside _handleAgentEvent", () => {
    // We look for the specific sequence: await _emitExtensionEvent(event)
    // then _emit(...willRetry: _willRetryAfterAgentEnd(event)). This is
    // the ordering that makes mutation in extension agent_end (if it
    // existed) also work — but more importantly proves message_end
    // mutation propagates to the willRetry computation.
    if (!/await\s+this\._emitExtensionEvent\(event\)/.test(piSession)) {
      throw new Error("await _emitExtensionEvent(event) not found in pi's dispatcher");
    }
  });

  check("I-3: _handlePostAgentRun reads _lastAssistantMessage (set in message_end)", () => {
    if (!/_handlePostAgentRun[\s\S]{0,200}_lastAssistantMessage/.test(piSession)) {
      throw new Error(
        "_handlePostAgentRun no longer reads _lastAssistantMessage. The retry path " +
        "may have moved to a different field; message_end mutation may not propagate.",
      );
    }
  });

  check("I-3: message_end handler stores _lastAssistantMessage by reference", () => {
    // Look for: this._lastAssistantMessage = event.message
    // (NOT a clone or copy)
    if (!/this\._lastAssistantMessage\s*=\s*event\.message/.test(piSession)) {
      throw new Error(
        "Pi no longer stores _lastAssistantMessage = event.message directly. " +
        "If it copies / clones, model-fallback's in-place mutation will be lost.",
      );
    }
  });

  check("I-4: piSession delegates retryability to isRetryableAssistantError and pi-ai retry.js keeps connection.?lost", () => {
    if (!/isRetryableAssistantError/.test(piSession)) {
      throw new Error(
        "agent-session.js no longer references isRetryableAssistantError. This looks like pi-session delegate drift; re-check _isRetryableError(message).",
      );
    }
    if (!/_isRetryableError\s*\([^)]*message[^)]*\)\s*\{[\s\S]{0,400}return\s+isRetryableAssistantError\(message\)/.test(piSession)) {
      throw new Error(
        "agent-session.js no longer delegates _isRetryableError(message) to isRetryableAssistantError(message). This looks like agent-session delegate drift.",
      );
    }
    const retryPath = path.join(piRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "utils", "retry.js");
    if (!fs.existsSync(retryPath)) {
      throw new Error(
        `pi-ai retry helper not found at ${retryPath}. This looks like pi-ai retry pattern drift or install corruption.`,
      );
    }
    const retrySrc = fs.readFileSync(retryPath, "utf8");
    if (!/connection\.\?lost/.test(retrySrc)) {
      throw new Error(
        "pi-ai retry helper no longer contains connection.?lost. This looks like pi-ai retry pattern drift, not just agent-session delegate drift.",
      );
    }
  });

  check("I-5: no structuredClone of message between message_end and retry path", () => {
    // Defense against a hypothetical pi refactor that defensively
    // clones the message somewhere along the path. If pi ever adds
    // such a clone, model-fallback's in-place mutation gets discarded.
    if (/structuredClone\([^)]*message[^)]*\)|JSON\.parse\(JSON\.stringify\(.*?message/.test(piSession)) {
      throw new Error(
        "Pi appears to clone the message object somewhere in agent-session.js. " +
        "Verify the clone is NOT between message_end (where mutation happens) " +
        "and _handlePostAgentRun (where errorMessage is read for retry).",
      );
    }
  });
}

// ──────────────────────────────────────────────────────────────────
// I-6: Handler A allows sub-agent (in-process + legacy sub-pi) to retry
// ──────────────────────────────────────────────────────────────────

console.log("\nI-6: Handler A retry policy for sub-agent / legacy sub-pi");

// Locate Handler A precisely: the lightweight message_end handler that
// runs in sub-agent contexts. It is the FIRST `pi.on("message_end", ...)`
// in the file (Handler B is the second, full main-pi handler).
const handlerAStart = mfSrc.indexOf('pi.on("message_end"');
if (handlerAStart < 0) throw new Error('Handler A not located — no pi.on("message_end") found');
const handlerBStart = mfSrc.indexOf('pi.on("message_end"', handlerAStart + 1);
// PRECISE Handler A body bounds: from `pi.on(...` to the FIRST `});` that
// closes the handler. Using indexOf(handlerBStart) is too wide — it would
// include the `session_start` handler in between which legitimately uses
// `if (isSubAgentSession(ctx)) return;` for its OWN opt-out.
const handlerACloseIdx = mfSrc.indexOf("});", handlerAStart);
if (handlerACloseIdx < 0) throw new Error("Handler A closing `});` not found");
const handlerABody = mfSrc.slice(handlerAStart, handlerACloseIdx + 3);

check("I-6: Handler A does NOT early-return on `if (isSubAgentSession(ctx)) return`", () => {
  // The exact regression pattern. If a future maintainer re-introduces
  // this as the first line of Handler A, sub-agent retry breaks silently.
  const faultyPattern = /if\s*\(\s*isSubAgentSession\(ctx\)\s*\)\s*return\s*;/;
  if (faultyPattern.test(handlerABody)) {
    throw new Error(
      "Handler A contains `if (isSubAgentSession(ctx)) return;` — this is the " +
      "exact regression that disabled sub-agent retry pre-2026-05-28. Per user " +
      "directive sub-agent MUST be allowed to retry (only model switching is " +
      "disallowed; that's Handler B + agent_end's job). Use a combined guard " +
      "like `if (!isSub && !isLegacySubPi) return;` so sub-agent falls through.",
    );
  }
});

check("I-6: Handler A guard treats sub-agent and legacy sub-pi symmetrically", () => {
  // Expected guard shape: only main pi (neither sub-agent nor legacy
  // sub-pi) early-returns. We check for both signals being inspected.
  const hasSubCheck = /isSubAgentSession\(ctx\)/.test(handlerABody);
  const hasLegacyCheck = /PI_ABRAIN_DISABLED/.test(handlerABody);
  if (!hasSubCheck || !hasLegacyCheck) {
    throw new Error(
      `Handler A is missing required guard signals: ` +
      `isSubAgentSession check=${hasSubCheck}, PI_ABRAIN_DISABLED check=${hasLegacyCheck}. ` +
      `Handler A must inspect BOTH to correctly identify sub-agent contexts that should retry.`,
    );
  }
  // Verify the combined-guard pattern: there should be a `return` gated
  // on the NEGATION of both signals (i.e. main pi only).
  const mainOnlyReturn =
    /if\s*\(\s*!\s*isSub\b[\s\S]{0,80}!\s*isLegacySubPi[\s\S]{0,80}\)\s*return/.test(handlerABody) ||
    /if\s*\(\s*!\s*isLegacySubPi[\s\S]{0,80}!\s*isSub\b[\s\S]{0,80}\)\s*return/.test(handlerABody);
  if (!mainOnlyReturn) {
    throw new Error(
      "Handler A's guard does not match the expected 'main pi only return' shape: " +
      "`if (!isSub && !isLegacySubPi) return;` (or equivalent reordering). " +
      "This is the only safe shape — it lets sub-agent and legacy sub-pi both fall " +
      "through to prefix injection while keeping main pi on Handler B's full path.",
    );
  }
});

check("I-6: Handler B retains sub-agent opt-out (no model switching)", () => {
  // Handler B (the second message_end handler, runs ONLY in main pi)
  // MUST still opt-out for sub-agent. If a future change accidentally
  // lets Handler B run in sub-agent context, model switching could leak
  // back — violating the user directive.
  if (handlerBStart < 0) throw new Error("Handler B not located (no second message_end handler)");
  const handlerBEnd = mfSrc.indexOf('pi.on("agent_end"', handlerBStart);
  const handlerBBody = mfSrc.slice(handlerBStart, handlerBEnd > 0 ? handlerBEnd : handlerBStart + 8000);
  const optOut = /if\s*\(\s*isSubAgentSession\(ctx\)\s*\)\s*return\s*;/.test(handlerBBody);
  if (!optOut) {
    throw new Error(
      "Handler B (full main-pi handler) no longer opts out for sub-agent. This means " +
      "sub-agent might enter the fallback state machine (consecutiveErrors / isOnFallback / " +
      "canaryLog) which violates the user directive that sub-agent must NOT switch models.",
    );
  }
});

check("I-6: agent_end handler retains sub-agent opt-out (no model switching)", () => {
  // The agent_end handler is where setModel() is called for fallback
  // chain switching. Sub-agent MUST stay opt-out here — that's the
  // "不允许切换模型" half of the directive.
  const agentEndStart = mfSrc.indexOf('pi.on("agent_end"');
  if (agentEndStart < 0) throw new Error('agent_end handler not located');
  const agentEndBody = mfSrc.slice(agentEndStart, agentEndStart + 12000);
  const optOut = /if\s*\(\s*isSubAgentSession\(ctx\)\s*\)\s*return\s*;/.test(agentEndBody);
  if (!optOut) {
    throw new Error(
      "agent_end handler no longer opts out for sub-agent. Sub-agent must NEVER " +
      "trigger fallback chain (setModel / sendMessage with new model) — that's the " +
      "core of the user directive 'sub_agent 不允许切换模型'. " +
      "Re-add `if (isSubAgentSession(ctx)) return;` near the top of agent_end.",
    );
  }
});

// ──────────────────────────────────────────────────────────────────
// Wrap-up
// ──────────────────────────────────────────────────────────────────

console.log(`\nTotal: ${totalChecks}  Passed: ${totalChecks - failures.length}  Failed: ${failures.length}`);
if (failures.length) {
  console.log("\nFAILED — model-fallback mutation timing invariants broken.");
  console.log("Re-read the file header for what each invariant guards.");
  process.exit(1);
}
