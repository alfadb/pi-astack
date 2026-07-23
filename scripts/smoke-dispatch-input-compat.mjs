#!/usr/bin/env node
/**
 * Regression test for the `raw.slice(...).map is not a function` bug in
 * dispatch_parallel (2026-05-09, renamed from dispatch_agents 2026-05-13).
 *
 * Failure chain that produced the cryptic error:
 *   1. LLM hand-stringifies the entire `tasks` array into the tool_use input.
 *   2. The inner prompt string contains an unescaped `"` (extremely common in
 *      Chinese prompts using `"…"` for emphasis), so the outer JSON.parse
 *      rejects the value mid-string.
 *   3. unwrapStringified silently returns the raw broken string.
 *   4. coerceTasksParam's old fallback `return raw as any` smuggles the string
 *      past the `unknown[]` signature.
 *   5. raw.slice(...).map(...) crashes — it's String.prototype.slice now.
 *
 * The fix has two parts:
 *   A. coerceTasksParam returns `[]` on failure (honest signature).
 *   B. dispatch_parallel `prepareArguments` throws an actionable error before
 *      the .slice().map() chain when raw is empty/non-array.
 *
 * This script transpiles the live TS source (no rebuild step required) and
 * exercises the four scenarios that matter:
 *   - Happy path: plain array of task objects
 *   - Single-stringified array (still recoverable; common LLM behavior)
 *   - Broken-stringified array with unescaped inner quote (THE BUG)
 *   - Triple-stringified (exceeds maxDepth=2; documents historical concern)
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const requireFromHere = createRequire(import.meta.url);
const ts = requireFromHere("typescript");

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpileTsToCjs(srcPath) {
  const source = fs.readFileSync(srcPath, "utf8");
  const out = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: srcPath,
  });
  return out.outputText;
}

function loadModuleFromString(code, fakePath) {
  const Module = requireFromHere("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  m._compile(code, fakePath);
  return m.exports;
}

const inputCompatSrc = path.join(repoRoot, "extensions/dispatch/input-compat.ts");
const taskProfileSrc = path.join(repoRoot, "extensions/dispatch/task-profile.ts");
const toolNameCompatSrc = path.join(repoRoot, "extensions/_shared/tool-name-compat.ts");
const compiled = transpileTsToCjs(inputCompatSrc);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-input-compat-"));
const dispatchDir = path.join(tmpDir, "dispatch");
fs.mkdirSync(dispatchDir, { recursive: true });
fs.mkdirSync(path.join(tmpDir, "_shared"), { recursive: true });
const tmpFile = path.join(dispatchDir, "input-compat.cjs");
fs.writeFileSync(tmpFile, compiled);
fs.writeFileSync(path.join(dispatchDir, "task-profile.js"), transpileTsToCjs(taskProfileSrc));
fs.writeFileSync(path.join(tmpDir, "_shared", "tool-name-compat.js"), transpileTsToCjs(toolNameCompatSrc));
const { coerceTasksParam, normalizeTaskSpec } = loadModuleFromString(
  compiled,
  tmpFile,
);

console.log("dispatch input-compat regression");

// ── coerceTasksParam contract ────────────────────────────────────
check("plain array passes through", () => {
  const r = coerceTasksParam([
    { model: "provider-a/model-a", thinking: "high", prompt: "hi" },
  ]);
  if (!Array.isArray(r) || r.length !== 1) throw new Error(`got ${typeof r} len ${r?.length}`);
});

check("single task object wraps to [task]", () => {
  const r = coerceTasksParam({ model: "x", thinking: "low", prompt: "y" });
  if (!Array.isArray(r) || r.length !== 1) throw new Error("not wrapped");
});

check("single-stringified array unwraps to array", () => {
  const inner = [{ model: "provider-a/model-a", thinking: "high", prompt: "hi" }];
  const r = coerceTasksParam(JSON.stringify(inner));
  if (!Array.isArray(r) || r.length !== 1) throw new Error(`got ${typeof r}`);
});

check("BUG REPRO: broken-stringified array with unescaped inner quote returns []", () => {
  // Reconstruct the exact shape captured from session log 2026-05-09:
  // a string that *looks* like a stringified JSON array but the inner prompt
  // has unescaped `"` characters that break outer JSON.parse mid-string.
  const broken =
    '[\n  {\n    "model": "provider-a/model-a",\n    "prompt": "用户给了你"推翻一切"的权力"\n  }\n]';
  // sanity: confirm this really is malformed
  let parseFailed = false;
  try {
    JSON.parse(broken);
  } catch {
    parseFailed = true;
  }
  if (!parseFailed) throw new Error("test fixture is no longer broken; update fixture");

  const r = coerceTasksParam(broken);
  if (!Array.isArray(r)) throw new Error(`coerceTasksParam returned ${typeof r}, expected array`);
  if (r.length !== 0) throw new Error(`expected empty array, got length ${r.length}`);
  // The crucial property: r.slice(...).map(...) MUST NOT throw cryptically.
  const sliced = r.slice(0, 16);
  const mapped = sliced.map((t) => t);
  if (mapped.length !== 0) throw new Error("post-slice map should be empty");
});

check("triple-stringified exceeds maxDepth=2 → returns []", () => {
  const inner = [{ model: "provider-a/model-a", thinking: "high", prompt: "hi" }];
  const triple = JSON.stringify(JSON.stringify(JSON.stringify(inner)));
  const r = coerceTasksParam(triple);
  if (!Array.isArray(r)) throw new Error(`returned ${typeof r}`);
  if (r.length !== 0) throw new Error(`expected empty, got len ${r.length}`);
});

check("undefined input returns []", () => {
  const r = coerceTasksParam(undefined);
  if (!Array.isArray(r) || r.length !== 0) throw new Error("not empty array");
});

check("normalizeTaskSpec canonicalizes legacy memory_get before dispatch schema validation", () => {
  const r = normalizeTaskSpec({ model: "x/y", prompt: "p", tools: ["memory_search", "memory_get", "abrain_get"] });
  if (r.tools !== "memory_search,abrain_get") throw new Error(`tools not canonicalized: ${JSON.stringify(r)}`);
});

check("normalizeTaskSpec preserves provided task title name (pass-through only)", () => {
  const r = normalizeTaskSpec({ model: "provider-a/model-a", thinking: "high", prompt: "hi", name: "schema audit" });
  if (r.name !== "schema audit") throw new Error(`name lost: ${JSON.stringify(r)}`);
});

check("normalizeTaskSpec does not invent a title when name is absent", () => {
  const r = normalizeTaskSpec({ model: "provider-a/model-a", thinking: "high", prompt: "first line title\nmore" });
  if (r.name !== undefined) throw new Error(`unexpected derived name: ${JSON.stringify(r)}`);
});

for (const profile of ["reviewer", "read_only", "research", "implementation", "heavy"]) {
  check(`normalizeTaskSpec accepts legal profile ${profile}`, () => {
    const r = normalizeTaskSpec({ model: "x/y", prompt: "p", taskProfile: profile });
    if (r.taskProfile !== profile) throw new Error(`profile changed: ${JSON.stringify(r)}`);
  });
}

for (const profile of ["reviewer/read_only", "implementation/heavy", "review", "readonly"]) {
  check(`normalizeTaskSpec rejects illegal profile ${profile}`, () => {
    let error;
    try { normalizeTaskSpec({ model: "x/y", prompt: "p", taskProfile: profile }); } catch (caught) { error = caught; }
    if (!error) throw new Error("expected profile rejection");
  });
}

check("illegal taskProfile does not silently override legal profile alias", () => {
  let error;
  try {
    normalizeTaskSpec({ model: "x/y", prompt: "p", taskProfile: "reviewer/read_only", profile: "research" });
  } catch (caught) { error = caught; }
  if (!error) throw new Error("expected invalid primary field rejection");
});

check("conflicting legal taskProfile/profile aliases are rejected", () => {
  let error;
  try {
    normalizeTaskSpec({ model: "x/y", prompt: "p", taskProfile: "research", profile: "heavy" });
  } catch (caught) { error = caught; }
  if (!error) throw new Error("expected alias conflict rejection");
});

// ── prepareArguments behavior under the bug payload ─────────────
// We can't easily import the dispatch extension itself (it pulls in pi runtime),
// but we can replicate the prepareArguments fragment to assert the actionable
// error path fires. This guards against future refactors silently dropping the
// throw.
function prepareArguments(args) {
  const rawTasks = args.tasks;
  const raw = coerceTasksParam(rawTasks);
  if (!Array.isArray(raw) || raw.length === 0) {
    const got =
      rawTasks === undefined
        ? "undefined"
        : typeof rawTasks === "string"
          ? `string of length ${rawTasks.length} starting with ${JSON.stringify(rawTasks.slice(0, 40))}`
          : `${typeof rawTasks} (${Array.isArray(rawTasks) ? "empty array" : "non-array"})`;
    throw new Error(
      `dispatch_parallel: 'tasks' must be a non-empty array of task objects {model, thinking, prompt, name}. ` +
        `Got ${got}. ` +
        `Pass tasks directly as a JSON array — do NOT wrap the entire array in a JSON string.`,
    );
  }
  const tasks = raw.slice(0, 16).map((t) => normalizeTaskSpec(t));
  return { tasks };
}

check("prepareArguments throws actionable error for broken-stringified payload", () => {
  const broken =
    '[\n  {\n    "model": "provider-a/model-a",\n    "prompt": "用户给了你"推翻一切"的权力"\n  }\n]';
  let caught = null;
  try {
    prepareArguments({ tasks: broken });
  } catch (e) {
    caught = e;
  }
  if (!caught) throw new Error("expected throw");
  const msg = String(caught.message);
  if (!msg.includes("must be a non-empty array")) throw new Error("msg lacks expected hint");
  if (!msg.includes("string of length")) throw new Error("msg lacks input shape diagnostic");
  if (!msg.includes("do NOT wrap")) throw new Error("msg lacks corrective guidance");
});

check("prepareArguments accepts well-formed array (smoke)", () => {
  const r = prepareArguments({
    tasks: [{ model: "provider-a/model-a", thinking: "high", prompt: "hi", name: "schema audit" }],
  });
  if (r.tasks.length !== 1) throw new Error("did not preserve task");
  if (r.tasks[0].model !== "provider-a/model-a") throw new Error("model lost");
  if (r.tasks[0].name !== "schema audit") throw new Error("name lost");
});

check("dispatch schemas require short task title name (source contract)", () => {
  const dispatchSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/index.ts"), "utf-8");
  const requiredName = /name:\s*Type\.String\(\{\s*description:\s*"Required short human-readable task title shown in the Task table \/ dispatch tool block\./g;
  const matches = dispatchSrc.match(requiredName) ?? [];
  if (matches.length < 2) {
    throw new Error(`expected required name on dispatch_agent + parallel task, found ${matches.length}`);
  }
  if (/name:\s*Type\.Optional\(Type\.String\(\{\s*description:\s*"(?:Short task name|Required short human-readable task title)/.test(dispatchSrc)) {
    throw new Error("dispatch name must not remain Type.Optional");
  }
  if (!/promptSnippet:\s*"dispatch_agent\(model, thinking, prompt, name, tools\?, timeoutMs\?\)/.test(dispatchSrc)) {
    throw new Error("dispatch_agent promptSnippet must list required name");
  }
  if (!/promptSnippet:\s*"dispatch_parallel\(\[\{model, thinking, prompt, name\}/.test(dispatchSrc)) {
    throw new Error("dispatch_parallel promptSnippet must list required name");
  }
  if (!/task objects \{model, thinking, prompt, name\}/.test(dispatchSrc)) {
    throw new Error("prepareArguments error text must mention required name");
  }
  if (!/Always pass name as a short human-readable task title/.test(dispatchSrc)) {
    throw new Error("dispatch_agent guidelines must require short task title");
  }
  if (!/Every task must include name as a short human-readable task title/.test(dispatchSrc)) {
    throw new Error("dispatch_parallel guidelines must require short task title");
  }
  if (!/name:'docs audit'/.test(dispatchSrc) || !/name:'code audit'/.test(dispatchSrc)) {
    throw new Error("dispatch_parallel example must include per-task name titles");
  }
  if (!/model\/thinking\/prompt\/name\/timeoutMs parameters/.test(dispatchSrc)) {
    throw new Error("single-task rejection text must list required name among parameters");
  }
});

check("dispatch_parallel concurrency is settings-driven, not fixed global worker count", () => {
  const dispatchSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/index.ts"), "utf-8");
  const settingsSrc = fs.readFileSync(path.join(repoRoot, "extensions/dispatch/settings.ts"), "utf-8");
  if (!/export const MAX_PROVIDER_CONCURRENCY = DEFAULT_DISPATCH_SETTINGS\.maxProviderConcurrency;/.test(dispatchSrc)) throw new Error("default fallback constant missing");
  if (!/export function readDispatchSettings\(\)/.test(settingsSrc)) throw new Error("dispatch settings helper missing");
  if (!/const maxProviderConcurrency = readDispatchSettings\(\)\.maxProviderConcurrency;/.test(dispatchSrc)) throw new Error("runtime settings read missing");
  if (!/providerFromModel\(tasks\[i\]\?\.model/.test(dispatchSrc)) throw new Error("provider grouping missing");
  if (!/activeByProvider\.get\(provider\) \?\? 0\) >= maxProviderConcurrency/.test(dispatchSrc)) throw new Error("same-provider cap not enforced from settings");
  if (!/const workers = new Array\(total\)/.test(dispatchSrc)) throw new Error("workers should cover all tasks so cross-provider fan-out is not globally capped");
  if (/const workers = new Array\(Math\.min\(MAX_CONCURRENCY, total\)\)/.test(dispatchSrc)) throw new Error("old fixed global worker cap still present");
  if (!/dispatch\.maxProviderConcurrency/.test(dispatchSrc)) throw new Error("tool guidance should name the config key");
});

// ── cleanup ──────────────────────────────────────────────────────
fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
