#!/usr/bin/env node
/**
 * Regression test for dispatch_agent output truncation bug (fixed 2026-05-19).
 *
 * BUG (pre-fix, commit cadc049 2026-05-06): `formatResult` in
 * `extensions/dispatch/index.ts` hard-sliced `result.output` to 500
 * chars + "..." when wrapping the sub-agent's response into the
 * tool_result text. This silently truncated any review / analysis
 * output longer than ~80 words; caller LLM appeared to receive a
 * half-finished reply with no way to retrieve the missing tail
 * (sub-agent is a single-shot subprocess).
 *
 * Symptom observed 2026-05-19: dispatch_agent OPUS review repeatedly
 * cut off mid-sentence at ~500 chars; dispatch_parallel with the SAME
 * model + prompt returned the full ~5000-char output because
 * dispatch_parallel uses `lines.push(r.output)` (no truncation, line
 * ~850), not `formatResult`.
 *
 * INVARIANT (locked here): `formatResult` MUST embed `result.output`
 * verbatim. No length-based slice. Test asserts:
 *   1. Short output (<500) is unchanged.
 *   2. Long output (>500, well above the old slice boundary) is
 *      embedded in full — every byte present, no '...' marker.
 *   3. Error path is unchanged (no body output rendered for errors).
 *   4. Usage suffix renders correctly.
 *   5. Retry summary renders correctly when present.
 *
 * Negative test: temporarily re-introducing the slice triggers #2 fail.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// Transpile dispatch/index.ts and import formatResult.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dispatch-fmt-"));
const srcPath = path.join(repoRoot, "extensions/dispatch/index.ts");
const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  },
});

// dispatch/index.ts imports many pi runtime types via `import type` (compiled
// away) plus a few real imports (Type from typebox, host process modules).
// Stub anything that would require a real pi runtime; formatResult itself is
// a pure string function so it survives stubs.
const cjsPath = path.join(tmpDir, "dispatch.cjs");
fs.writeFileSync(cjsPath, out.outputText);

// Also stage input-compat which dispatch imports at runtime.
const inputCompatSrc = path.join(repoRoot, "extensions/dispatch/input-compat.ts");
const inputCompatOut = ts.transpileModule(fs.readFileSync(inputCompatSrc, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
  },
});
fs.writeFileSync(path.join(tmpDir, "input-compat.cjs"), inputCompatOut.outputText);
fs.copyFileSync(path.join(tmpDir, "input-compat.cjs"), path.join(tmpDir, "input-compat.js"));

// Stub `typebox` (dispatch/index.ts: `import { Type } from "typebox"`).
// Also stub `../_shared/footer-status` which dispatch imports at module
// load time. Both are needed because the file's default export
// `function (pi) { pi.registerTool(...) }` body runs Type.Object at
// registration site — but registerTool itself is only called when
// activate(pi) runs, which our smoke doesn't do. The bare `import` lines
// at file top still resolve through require() during module load.
const typeboxDir = path.join(tmpDir, "node_modules", "typebox");
fs.mkdirSync(typeboxDir, { recursive: true });
fs.writeFileSync(
  path.join(typeboxDir, "package.json"),
  JSON.stringify({ name: "typebox", main: "index.js" }),
);
fs.writeFileSync(
  path.join(typeboxDir, "index.js"),
  `
const make = (descOrInner) => ({ kind: "stub", desc: descOrInner });
exports.Type = new Proxy({}, { get: () => make });
`,
);

// Stub `../_shared/footer-status` — sibling extension folder, just exports a
// few string constants used in applyDispatchStatus(). Provide an empty object.
const sharedDir = path.join(tmpDir, "..", "_shared");
fs.mkdirSync(sharedDir, { recursive: true });
fs.writeFileSync(
  path.join(sharedDir, "footer-status.js"),
  `module.exports = { FOOTER_STATUS_KEYS: { dispatch: "dispatch" } };\n`,
);

// Stub `../_shared/pi-internals` — ADR 0027 PR-B added the
// markSessionAsSubAgent import. formatResult doesn’t use it, but it’s
// resolved at module load time. No-op stub keeps the loader happy.
fs.writeFileSync(
  path.join(sharedDir, "pi-internals.js"),
  `module.exports = {
  markSessionAsSubAgent: () => {},
  isSubAgentSession: () => false,
};\n`,
);

// Stub `@earendil-works/pi-coding-agent` — v3 in-process migration added
// real (non-type) imports: createAgentSession, DefaultResourceLoader,
// SessionManager, SettingsManager, getAgentDir. formatResult doesn't call
// any of them, but they're resolved at module load time.
const piCdDir = path.join(tmpDir, "node_modules", "@earendil-works", "pi-coding-agent");
fs.mkdirSync(piCdDir, { recursive: true });
fs.writeFileSync(
  path.join(piCdDir, "package.json"),
  JSON.stringify({ name: "@earendil-works/pi-coding-agent", main: "index.js" }),
);
fs.writeFileSync(
  path.join(piCdDir, "index.js"),
  `
exports.createAgentSession = async () => ({ session: { prompt: async () => {}, subscribe: () => () => {}, dispose: () => {}, abort: async () => {} } });
exports.DefaultResourceLoader = class { reload() { return Promise.resolve(); } };
exports.getAgentDir = () => "/tmp/.pi/agent";
exports.SessionManager = { inMemory: () => ({}) };
exports.SettingsManager = { create: () => ({}) };
`,
);

// formatResult itself doesn't touch pi.registerTool, but the module's
// default export does. Wrap require so the registerTool side-effects can run
// against a no-op pi object — registerTool needs to exist on the proxy.
const moduleDir = path.dirname(cjsPath);
process.chdir(moduleDir); // so require resolves @sinclair/typebox from local node_modules

let dispatchModule;
try {
  dispatchModule = require(cjsPath);
} catch (err) {
  console.error(`Failed to load dispatch module: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}

const { formatResult, classifyError, classifyWithRetry, mergeAssistantTurn } = dispatchModule;
if (typeof formatResult !== "function") {
  console.error("formatResult not exported from dispatch/index.ts");
  console.error("Available exports:", Object.keys(dispatchModule));
  process.exit(1);
}
if (typeof classifyError !== "function") {
  console.error("classifyError not exported from dispatch/index.ts");
  console.error("Available exports:", Object.keys(dispatchModule));
  process.exit(1);
}
if (typeof classifyWithRetry !== "function") {
  console.error("classifyWithRetry not exported from dispatch/index.ts");
  console.error("Available exports:", Object.keys(dispatchModule));
  process.exit(1);
}
if (typeof mergeAssistantTurn !== "function") {
  console.error("mergeAssistantTurn not exported from dispatch/index.ts");
  console.error("Available exports:", Object.keys(dispatchModule));
  process.exit(1);
}

console.log("Smoke: dispatch formatResult — output truncation regression test");
console.log("");

// ── Fixtures ───────────────────────────────────────────────────────

function makeResult(output, opts = {}) {
  return {
    output,
    durationMs: opts.durationMs ?? 1234,
    error: opts.error,
    failureType: opts.failureType,
    stopReason: opts.stopReason,
    usage: opts.usage,
    retryHistory: opts.retryHistory,
  };
}

// ── INVARIANT: no output truncation in formatResult ───────────────

check("short output (<500 chars) embedded verbatim", () => {
  const out = "Short single-line analysis output.";
  const text = formatResult("dispatch", "openai/gpt-5.5", makeResult(out));
  if (!text.includes(out)) {
    throw new Error(`short output missing from rendered text:\n${text}`);
  }
  if (text.includes("...")) {
    // Defensive: short outputs should not gain trailing '...' either.
    throw new Error(`short output gained spurious '...': ${text}`);
  }
});

check("output exactly at old boundary (500 chars) embedded verbatim", () => {
  const out = "X".repeat(500);
  const text = formatResult("dispatch", "m", makeResult(out));
  if (!text.includes(out)) {
    throw new Error(`500-char output not embedded verbatim`);
  }
  // The pre-fix code path triggered slice only when length > 500, so this
  // case was actually safe pre-fix. We assert the trailing X (index 499)
  // shows up; if not, formatResult is doing some other mutation.
  const xRun = text.match(/X+/);
  if (!xRun || xRun[0].length < 500) {
    throw new Error(`expected 500 consecutive X's, got run length ${xRun?.[0].length}`);
  }
});

check("long output (5000 chars) embedded verbatim — no '...' truncation", () => {
  // This is the core invariant. Pre-fix this would be sliced to 500 chars
  // + '...'. Post-fix the full 5000-char body must be present.
  const out = "Y".repeat(5000);
  const text = formatResult("dispatch", "m", makeResult(out));

  // Count consecutive Y's in the rendered text.
  const yRun = text.match(/Y+/);
  if (!yRun) throw new Error(`no Y run found in rendered text:\n${text.slice(0, 200)}`);
  if (yRun[0].length !== 5000) {
    throw new Error(
      `LONG-OUTPUT TRUNCATION: expected 5000 consecutive Y's in rendered text, got ${yRun[0].length}. ` +
      `This is the bug fixed 2026-05-19 — formatResult must not slice output.`,
    );
  }

  // The legacy bug emitted '...' as the truncation marker. Catch any
  // re-introduction by asserting no '...' immediately after a Y run.
  if (/Y\.\.\./.test(text)) {
    throw new Error(`re-introduced '...' truncation marker after Y run`);
  }
});

check("very long output (50000 chars) still embedded verbatim", () => {
  // Defense in depth: even if someone re-introduces a bigger ceiling
  // (e.g. slice(0, 10000)), 50k chars catches it.
  const out = "Z".repeat(50000);
  const text = formatResult("dispatch", "m", makeResult(out));
  const zRun = text.match(/Z+/);
  if (!zRun || zRun[0].length !== 50000) {
    throw new Error(
      `expected 50000 consecutive Z's, got ${zRun?.[0].length} — ` +
      `formatResult is applying some length cap`,
    );
  }
});

check("output containing markdown / newlines preserved verbatim", () => {
  // Real LLM outputs contain markdown. Ensure no normalization happens.
  const out = "# Heading\n\n- bullet 1\n- bullet 2\n\n```code block```\n\n**bold**";
  const text = formatResult("dispatch", "m", makeResult(out));
  if (!text.includes(out)) {
    throw new Error(`markdown structure not preserved in rendered text:\n${text}`);
  }
});

// ── Error path: error message rendered, output NOT rendered ───────

check("error result renders error string, NOT output body", () => {
  const out = "would-be-output-payload";
  const text = formatResult("dispatch", "m", makeResult(out, { error: "timeout after 30000ms" }));
  if (!text.includes("timeout after 30000ms")) {
    throw new Error(`error path missing error message:\n${text}`);
  }
  if (text.includes(out)) {
    throw new Error(`error path leaked output body (should only show error):\n${text}`);
  }
  if (!text.includes("❌")) {
    throw new Error(`error path missing ❌ marker:\n${text}`);
  }
});

// ── Usage suffix renders correctly ────────────────────────────────

check("usage block renders ↑input ↓output $cost", () => {
  const out = "ok";
  const text = formatResult(
    "dispatch",
    "openai/gpt-5.5",
    makeResult(out, { usage: { input: 1234, output: 5678, total: 6912, cost: 0.12345 } }),
  );
  if (!/↑1234/.test(text)) throw new Error(`missing ↑input: ${text}`);
  if (!/↓5678/.test(text)) throw new Error(`missing ↓output: ${text}`);
  if (!/\$0\.1235/.test(text)) throw new Error(`missing $cost (4 decimals, rounded): ${text}`);
});

check("missing usage → no usage suffix", () => {
  const out = "ok";
  const text = formatResult("dispatch", "m", makeResult(out));
  if (/[↑↓]/.test(text)) throw new Error(`spurious usage markers when usage absent: ${text}`);
  if (/\$\d/.test(text)) throw new Error(`spurious $cost when usage absent: ${text}`);
});

// ── Retry summary renders ─────────────────────────────────────────

check("retry history renders one-line summary", () => {
  const out = "ok";
  const text = formatResult(
    "dispatch",
    "m",
    makeResult(out, {
      retryHistory: {
        entries: [{ errorPreview: "connection lost — eof" }],
        finalOutcome: "succeeded",
      },
    }),
  );
  if (!/retries: 1 attempt, recovered/.test(text)) {
    throw new Error(`retry summary missing or malformed:\n${text}`);
  }
});

check("no retry → no retry line", () => {
  const out = "ok";
  const text = formatResult("dispatch", "m", makeResult(out));
  if (/retries:/.test(text)) {
    throw new Error(`spurious retry line when no retries:\n${text}`);
  }
});

// ── Header format ─────────────────────────────────────────────────

check("failureType prefix rendered when present", () => {
  const text = formatResult("dispatch", "m", makeResult("", {
    error: "timeout after 60000ms",
    failureType: "timeout",
    durationMs: 60000,
  }));
  if (!text.includes("[timeout]")) {
    throw new Error(`missing [timeout] prefix:\n${text}`);
  }
});

check("no failureType → no prefix", () => {
  const text = formatResult("dispatch", "m", makeResult("", {
    error: "plain error",
    durationMs: 100,
  }));
  if (/\[\w+\]/.test(text)) {
    throw new Error(`unexpected failureType prefix when none was set:\n${text}`);
  }
});

check("timeout_partial renders partial output in error branch", () => {
  const partial = "PARTIAL_REASONING_BLOCK_" + "Z".repeat(200);
  const text = formatResult("dispatch", "m", makeResult(partial, {
    error: "timeout after 60000ms (partial output captured)",
    failureType: "timeout_partial",
    durationMs: 60000,
  }));
  if (!text.includes("[timeout_partial]")) {
    throw new Error(`missing [timeout_partial] prefix:\n${text}`);
  }
  if (!text.includes(partial)) {
    throw new Error(`timeout_partial dropped its partial output — defeats the whole point of the classification:\n${text}`);
  }
  if (!/partial output \(\d+ chars\):/.test(text)) {
    throw new Error(`partial output header missing:\n${text}`);
  }
});

check("truncated renders partial output in error branch", () => {
  const partial = "halfway through response...";
  const text = formatResult("dispatch", "m", makeResult(partial, {
    error: "output truncated (max tokens reached)",
    failureType: "truncated",
    stopReason: "length",
    durationMs: 1000,
  }));
  if (!text.includes("[truncated]")) {
    throw new Error(`missing [truncated] prefix:\n${text}`);
  }
  if (!text.includes(partial)) {
    throw new Error(`truncated dropped its captured output:\n${text}`);
  }
  if (!text.includes("(stop=length)")) {
    throw new Error(`stopReason hint missing for truncated:\n${text}`);
  }
});

check("non-partial failure does NOT render output in error branch", () => {
  const sensitive = "SHOULD_NOT_LEAK_TO_RENDERED_OUTPUT";
  const text = formatResult("dispatch", "m", makeResult(sensitive, {
    error: "network reset",
    failureType: "network",
    durationMs: 5000,
  }));
  if (text.includes(sensitive)) {
    throw new Error(`non-partial failure leaked its output field:\n${text}`);
  }
});

// ── classifyError: HTTP status detection ───────────────────────────

check("classifyError: HTTP 401 → auth", () => {
  if (classifyError("HTTP 401 Unauthorized") !== "auth") {
    throw new Error(`expected auth, got ${classifyError("HTTP 401 Unauthorized")}`);
  }
});

check("classifyError: HTTP 403 → auth", () => {
  if (classifyError("forbidden 403") !== "auth") throw new Error("expected auth");
});

check("classifyError: 'invalid api key' → auth", () => {
  if (classifyError("Invalid API key provided") !== "auth") throw new Error("expected auth");
});

check("classifyError: HTTP 429 → rate_limit", () => {
  if (classifyError("HTTP 429: Too Many Requests") !== "rate_limit") throw new Error("expected rate_limit");
});

check("classifyError: quota exceeded → rate_limit", () => {
  if (classifyError("Daily quota exceeded") !== "rate_limit") throw new Error("expected rate_limit");
});

check("classifyError: ECONNRESET → network", () => {
  if (classifyError("fetch failed: ECONNRESET") !== "network") throw new Error("expected network");
});

check("classifyError: ETIMEDOUT → network", () => {
  if (classifyError("connect ETIMEDOUT 1.2.3.4:443") !== "network") throw new Error("expected network");
});

check("classifyError: HTTP 503 → server_error", () => {
  if (classifyError("HTTP 503 Service Unavailable") !== "server_error") throw new Error("expected server_error");
});

check("classifyError: overloaded → server_error", () => {
  if (classifyError("AnthropicError: overloaded_error") !== "server_error") throw new Error("expected server_error");
});

check("classifyError: context_length_exceeded → context_overflow", () => {
  if (classifyError("context_length_exceeded: 200000 tokens") !== "context_overflow") throw new Error("expected context_overflow");
});

check("classifyError: gibberish → fallback (crash)", () => {
  if (classifyError("some unexpected gibberish") !== "crash") throw new Error("expected crash");
});

check("classifyError: undefined → fallback (agent_error)", () => {
  if (classifyError(undefined, "agent_error") !== "agent_error") throw new Error("expected agent_error");
});

// ── classifyError: priority order locked ────────────────────────────

check("classifyError: auth wins over server_error when both present", () => {
  // Real-world: "HTTP 401 from upstream, then 503 retry". auth is more actionable.
  if (classifyError("HTTP 401 then HTTP 503 fallback") !== "auth") {
    throw new Error(`expected auth to win, got ${classifyError("HTTP 401 then HTTP 503 fallback")}`);
  }
});

check("classifyError: rate_limit wins over server_error", () => {
  if (classifyError("HTTP 429 (rate-limited), retry attempt 3 of 5 failed with 503") !== "rate_limit") {
    throw new Error("expected rate_limit to win");
  }
});

// ── classifyError: NOT_TIME_UNIT guard against false positives ────────────

check("classifyError: 'retry after 401 ms' → NOT auth (time-unit guard)", () => {
  const got = classifyError("retry after 401 ms", "crash");
  if (got === "auth") {
    throw new Error(`time-unit guard failed: "401 ms" should not match auth, got ${got}`);
  }
});

check("classifyError: 'timeout after 500 ms' → NOT server_error (time-unit guard)", () => {
  const got = classifyError("timeout after 500 ms", "crash");
  if (got === "server_error") {
    throw new Error(`time-unit guard failed: "500 ms" should not match server_error, got ${got}`);
  }
});

check("classifyError: 'rate-limited after 429 minutes' → still rate_limit (keyword wins)", () => {
  // The 429 number itself is blocked by NOT_TIME_UNIT ("429 minutes"), but
  // the keyword "rate-limited" should still trigger rate_limit. This tests
  // that keyword fallback works when numeric pattern is blocked.
  if (classifyError("rate-limited after 429 minutes") !== "rate_limit") {
    throw new Error("keyword fallback failed when numeric blocked");
  }
});

check("classifyError: 'timeout 500ms' (no space) → NOT server_error", () => {
  // No word boundary between 500 and ms when there's no space — already safe
  // pre-guard. Lock it.
  const got = classifyError("timeout 500ms", "crash");
  if (got === "server_error") throw new Error(`"500ms" matched server_error: ${got}`);
});

// ── classifyWithRetry: R2 P0 fix — catch path retry observability ──────────
// 本轮 R2 P0 修复的核心约定：retry_exhausted 是 fallback，不会吞掉 HTTP 具体分类。
// 这些 test 锁住优先级顺序，防止 catch 路径被重构时静默破坏 retry observability。

const EXHAUSTED_RETRY = {
  entries: [{ attempt: 1, startedAt: 1000 }, { attempt: 2, startedAt: 2000 }],
  finalOutcome: "exhausted",
  finalAttempt: 2,
};

check("classifyWithRetry: rate_limit wins over retry_exhausted", () => {
  // Real scenario: pi-ai retried 3 times on 429, finally rejected.
  // Caller MUST see rate_limit (root cause), not retry_exhausted (fact about
  // the retry loop). This is the R2 P0 fix: priority is specific > exhausted > fallback.
  const got = classifyWithRetry("HTTP 429 Too Many Requests", EXHAUSTED_RETRY, "crash");
  if (got !== "rate_limit") {
    throw new Error(`R2 P0 broken: expected rate_limit (root cause), got ${got}`);
  }
});

check("classifyWithRetry: server_error wins over retry_exhausted", () => {
  const got = classifyWithRetry("HTTP 503 from upstream", EXHAUSTED_RETRY, "crash");
  if (got !== "server_error") throw new Error(`expected server_error, got ${got}`);
});

check("classifyWithRetry: auth wins over retry_exhausted", () => {
  const got = classifyWithRetry("401 Unauthorized", EXHAUSTED_RETRY, "crash");
  if (got !== "auth") throw new Error(`expected auth, got ${got}`);
});

check("classifyWithRetry: unclassifiable + exhausted → retry_exhausted", () => {
  // Generic error message that classifyError can't categorise + exhaustion
  // → retry_exhausted is the right fallback (more informative than crash).
  const got = classifyWithRetry("some opaque internal error", EXHAUSTED_RETRY, "crash");
  if (got !== "retry_exhausted") throw new Error(`expected retry_exhausted, got ${got}`);
});

check("classifyWithRetry: unclassifiable + no retry → fallback", () => {
  const got = classifyWithRetry("some opaque internal error", undefined, "crash");
  if (got !== "crash") throw new Error(`expected crash, got ${got}`);
});

check("classifyWithRetry: agent_error fallback works", () => {
  const got = classifyWithRetry("opaque", undefined, "agent_error");
  if (got !== "agent_error") throw new Error(`expected agent_error, got ${got}`);
});

check("classifyWithRetry: succeeded retries do NOT trigger retry_exhausted", () => {
  const recovered = { entries: [{ attempt: 1, startedAt: 0 }], finalOutcome: "succeeded" };
  const got = classifyWithRetry("opaque", recovered, "crash");
  if (got !== "crash") {
    throw new Error(`recovered retries shouldn't trigger retry_exhausted; got ${got}`);
  }
});

check("classifyWithRetry: mid-flight (entries present, no finalOutcome) → fallback", () => {
  // R3 P1-2: pi-ai crashed between auto_retry_start and auto_retry_end.
  // finalOutcome === undefined — not exhausted, not succeeded. Should NOT
  // promote to retry_exhausted (we don't know the outcome).
  const midflight = { entries: [{ attempt: 1, startedAt: 0 }] };
  const got = classifyWithRetry("opaque", midflight, "crash");
  if (got !== "crash") {
    throw new Error(`mid-flight should fall back to crash, not retry_exhausted; got ${got}`);
  }
});

check("classifyWithRetry: empty string + exhausted → retry_exhausted", () => {
  // R3 P1-3: empty errorMessage is falsy via matchErrorCategory's `!msg`
  // check, so it falls through to the retry_exhausted branch.
  const got = classifyWithRetry("", EXHAUSTED_RETRY, "crash");
  if (got !== "retry_exhausted") {
    throw new Error(`expected retry_exhausted for empty msg + exhausted; got ${got}`);
  }
});

check("classifyWithRetry: undefined msg + exhausted → retry_exhausted", () => {
  const got = classifyWithRetry(undefined, EXHAUSTED_RETRY, "crash");
  if (got !== "retry_exhausted") {
    throw new Error(`expected retry_exhausted for undefined msg + exhausted; got ${got}`);
  }
});

// ── mergeAssistantTurn: R3 P0 fix — multi-turn finalOutput preservation ──────
// Pre-fix bug: subscribe callback had `finalOutput = "";` unconditional wipe
// followed by `if (turnText.length > 0) finalOutput = turnText;`. Net effect:
// any tool-only or error turn wiped the prior turn's text. mergeAssistantTurn
// is the pure replacement; these tests lock its behaviour so that regression
// cannot recur silently in the subscribe callback.

check("mergeAssistantTurn: text turn replaces prior", () => {
  const next = mergeAssistantTurn("old text", {
    content: [{ type: "text", text: "new text" }],
  });
  if (next !== "new text") throw new Error(`expected "new text", got ${JSON.stringify(next)}`);
});

check("mergeAssistantTurn: tool-only turn preserves prior (R3 P0)", () => {
  // This is the regression case. If anyone re-introduces the wipe, this fails.
  const prior = "Sub-agent's earlier analysis";
  const next = mergeAssistantTurn(prior, {
    content: [{ type: "toolCall", text: undefined }],
  });
  if (next !== prior) {
    throw new Error(`tool-only turn wiped prior text — R3 P0 regression: got ${JSON.stringify(next)}`);
  }
});

check("mergeAssistantTurn: empty content array preserves prior", () => {
  const prior = "keep me";
  const next = mergeAssistantTurn(prior, { content: [] });
  if (next !== prior) throw new Error(`empty content wiped prior: ${next}`);
});

check("mergeAssistantTurn: undefined content preserves prior", () => {
  const prior = "keep me";
  const next = mergeAssistantTurn(prior, {});
  if (next !== prior) throw new Error(`undefined content wiped prior: ${next}`);
});

check("mergeAssistantTurn: null message preserves prior", () => {
  const prior = "keep me";
  const next = mergeAssistantTurn(prior, null);
  if (next !== prior) throw new Error(`null message wiped prior: ${next}`);
});

check("mergeAssistantTurn: mixed text + toolCall — text wins", () => {
  const next = mergeAssistantTurn("", {
    content: [
      { type: "text", text: "Let me check" },
      { type: "toolCall" },
    ],
  });
  if (next !== "Let me check") throw new Error(`mixed turn lost text: ${next}`);
});

check("mergeAssistantTurn: multiple text parts concatenate", () => {
  const next = mergeAssistantTurn("", {
    content: [
      { type: "text", text: "part1 " },
      { type: "text", text: "part2" },
    ],
  });
  if (next !== "part1 part2") throw new Error(`concat broken: ${next}`);
});

check("mergeAssistantTurn: text=undefined defensive", () => {
  // typeof guard: a text part missing its .text field shouldn't crash.
  const next = mergeAssistantTurn("prior", {
    content: [{ type: "text" }],
  });
  if (next !== "prior") throw new Error(`undefined text part should be skipped: ${next}`);
});

// ── R3 P1-1: agent_error / retry_exhausted positive partial-output render ────
// Lock the contract: when agent_error / retry_exhausted have finalOutput
// (because mergeAssistantTurn preserved earlier-turn text), formatResult
// renders that partial output. Without these tests, the PARTIAL_OUTPUT_FAILURES
// expansion is unverified.

check("agent_error renders partial output in error branch", () => {
  const partial = "AGENT_PARTIAL_BEFORE_ERROR_" + "X".repeat(100);
  const text = formatResult("dispatch", "m", makeResult(partial, {
    error: "provider returned error",
    failureType: "agent_error",
    durationMs: 100,
  }));
  if (!text.includes("[agent_error]")) {
    throw new Error(`missing [agent_error] prefix:\n${text}`);
  }
  if (!text.includes(partial)) {
    throw new Error(`agent_error suppressed partial output — PARTIAL_OUTPUT_FAILURES expansion broken:\n${text}`);
  }
});

check("retry_exhausted renders partial output in error branch", () => {
  const partial = "RETRY_PARTIAL_" + "Y".repeat(100);
  const text = formatResult("dispatch", "m", makeResult(partial, {
    error: "all retries failed",
    failureType: "retry_exhausted",
    durationMs: 5000,
    retryHistory: {
      entries: [{ attempt: 1, startedAt: 0 }, { attempt: 2, startedAt: 1000 }],
      finalOutcome: "exhausted",
    },
  }));
  if (!text.includes("[retry_exhausted]")) {
    throw new Error(`missing [retry_exhausted] prefix:\n${text}`);
  }
  if (!text.includes(partial)) {
    throw new Error(`retry_exhausted suppressed partial output:\n${text}`);
  }
  if (!/retries: 2 attempts, all failed/.test(text)) {
    throw new Error(`retry summary missing under retry_exhausted:\n${text}`);
  }
});

check("rate_limit does NOT render output in error branch (non-partial)", () => {
  const sensitive = "upstream_partial_state";
  const text = formatResult("dispatch", "m", makeResult(sensitive, {
    error: "HTTP 429",
    failureType: "rate_limit",
    durationMs: 1000,
  }));
  if (text.includes(sensitive)) {
    throw new Error(`rate_limit leaked output field — should be in blacklist:\n${text}`);
  }
});

check("auth does NOT render output in error branch (non-partial)", () => {
  const text = formatResult("dispatch", "m", makeResult("any_text", {
    error: "401 Unauthorized",
    failureType: "auth",
    durationMs: 100,
  }));
  if (text.includes("any_text")) {
    throw new Error(`auth leaked output field:\n${text}`);
  }
});

// ── R3 P1-4: document NOT_TIME_UNIT English-only contract ────────────────
// pi-ai produces English-only error messages, so NOT_TIME_UNIT's English
// time-unit alternation is sufficient. If pi-ai ever localises errors,
// the patterns must be extended. These tests lock the current limitation
// so the assumption is visible and grep-able.

check("classifyError: known limitation — CJK time units bypass guard", () => {
  // "401 毫秒" should ideally not match auth, but NOT_TIME_UNIT only
  // covers English units (ms/sec/min/hour/day). Lock current behaviour
  // so any change is intentional and tested.
  const got = classifyError("401 毫秒", "crash");
  if (got !== "auth") {
    throw new Error(
      `unexpected: "401 毫秒" returned ${got} — has NOT_TIME_UNIT been extended to CJK? ` +
      `Update this test if intentional.`,
    );
  }
});

// ── R3-r3 source-invariant smoke (Opus's recommendation) ────────────────
// These do source-level grep against index.ts to lock STRUCTURAL invariants
// that can't be observed via pure-function smoke. If a future refactor
// inlines mergeAssistantTurn or re-introduces the unconditional wipe, these
// fail loudly with a pointer to the regression bug.

const _fs = require("node:fs");
const _indexSrc = _fs.readFileSync(
  require("node:path").resolve(__dirname, "..", "extensions/dispatch/index.ts"),
  "utf8",
);

check("source invariant: finalOutput has exactly 2 write sites", () => {
  // Permitted: line ~420 `let finalOutput = "";` initializer, and the
  // single subscribe call `finalOutput = mergeAssistantTurn(...)`. Any
  // extra write site means someone re-introduced an inline merge.
  const writes = _indexSrc.match(/finalOutput\s*=(?!=)/g) ?? [];
  if (writes.length !== 2) {
    throw new Error(
      `expected exactly 2 finalOutput writes (init + mergeAssistantTurn call), got ${writes.length}. ` +
        `If you inlined the merge logic, R3 P0 wipe bug can resurface — keep mergeAssistantTurn as the single write site.`,
    );
  }
});

check("source invariant: no unconditional finalOutput wipe in subscribe", () => {
  // Locks against re-introducing the R3 P0 bug specifically.
  if (/finalOutput\s*=\s*""\s*;\s*\n[\s\S]{0,400}message_end/.test(_indexSrc)) {
    throw new Error("R3 P0 regression: detected `finalOutput = \"\";` near message_end branch");
  }
  // Also detect the inverse pattern (wipe just after message_end check).
  if (/message_end[\s\S]{0,200}finalOutput\s*=\s*""\s*;/.test(_indexSrc)) {
    throw new Error("R3 P0 regression: detected `finalOutput = \"\";` after message_end check");
  }
});

check("source invariant: errorMessage uses || fallback, not ??", () => {
  // R3-r3 P1: ?? leaves empty string as-is → downstream truthy-check
  // misses the error. || covers empty string too.
  if (/baseError\s*=\s*errorMessage\s*\?\?/.test(_indexSrc)) {
    throw new Error(
      `R3-r3 P1 regression: baseError uses ?? — empty errorMessage will silently render as success. Use ||.`,
    );
  }
});

// ── R3-r3 P1 fix: empty errorMessage → explicit fallback string ────────────
// We can't directly test the runInProcess branch without an integration
// smoke. The source-invariant above locks the use of || vs ??, which is
// the actual fix surface. This documentation test pairs with it.

check("R3-r3 P1: behavioural contract for empty error sentinel", () => {
  // Locking the contract: any error result returned to the caller must
  // have a non-empty `error` string so downstream `if (result.error)` works.
  // The result-format layer should never see error="".
  // formatResult treats error="" as success (this is correct given the
  // contract). Verify behaviour.
  const ambiguous = formatResult("d", "m", makeResult("agent output", {
    error: "",
    durationMs: 100,
  }));
  // Empty error string → success rendering (no error block):
  if (ambiguous.includes("❌") || /^_error/m.test(ambiguous)) {
    throw new Error(
      `formatResult treated error="" as failure, breaking contract assumption that runInProcess never emits empty error strings: ${ambiguous}`,
    );
  }
  // — this is why runInProcess must use || not ??.
});

check("classifyError: known limitation — microsecond unit bypass", () => {
  // "401 μs" / "401 us" — not in alternation. Locks the gap.
  const got = classifyError("401 us", "crash");
  if (got !== "auth") {
    throw new Error(
      `unexpected: "401 us" returned ${got} — has us been added to NOT_TIME_UNIT? ` +
      `Update this test if intentional.`,
    );
  }
});

// ── Header format ─────────────────────────────────────────────

check("header includes label, model, ✅, duration", () => {
  const text = formatResult(
    "dispatch",
    "anthropic/claude-opus-4-7",
    makeResult("body", { durationMs: 12345 }),
  );
  if (!/## dispatch \(anthropic\/claude-opus-4-7\) ✅ 12\.3s/.test(text)) {
    throw new Error(`header malformed:\n${text}`);
  }
});

// ── Summary ───────────────────────────────────────────────────────

console.log("");
if (failures.length > 0) {
  console.error(`${failures.length}/${total} checks failed`);
  for (const f of failures) console.error(`- ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}

console.log(`all ok — dispatch formatResult output truncation invariant holds (${total} assertions, long-output verbatim verified).`);

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(0);
