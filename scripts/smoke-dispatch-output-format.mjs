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

const { formatResult } = dispatchModule;
if (typeof formatResult !== "function") {
  console.error("formatResult not exported from dispatch/index.ts");
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
