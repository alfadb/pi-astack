#!/usr/bin/env node
/**
 * Smoke: dispatch maxOutputTokens request-budget wiring.
 *
 * Regression guard for providers that otherwise use a small upstream default
 * completion budget and return stopReason="length". The important contract is
 * that dispatch always resolves a provider output cap, injects it into the
 * sub-agent loop config as maxTokens, and surfaces the effective cap in audit /
 * details so truncation investigations have the request budget attached.
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
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: srcPath,
  });
  return out.outputText;
}

function loadModuleFromString(code, fakePath) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  m._compile(code, fakePath);
  return m.exports;
}

const dispatchSrc = fs.readFileSync(
  path.join(repoRoot, "extensions/dispatch/index.ts"),
  "utf-8",
);
const inputCompatSrc = path.join(repoRoot, "extensions/dispatch/input-compat.ts");
const taskProfileSrc = path.join(repoRoot, "extensions/dispatch/task-profile.ts");
const inputCompatCompiled = transpileTsToCjs(inputCompatSrc);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dispatch-max-output-"));
const tmpFile = path.join(tmpDir, "input-compat.cjs");
fs.writeFileSync(tmpFile, inputCompatCompiled);
fs.writeFileSync(path.join(tmpDir, "task-profile.js"), transpileTsToCjs(taskProfileSrc));
const { normalizeTaskSpec } = loadModuleFromString(
  inputCompatCompiled,
  tmpFile,
);

console.log("dispatch maxOutputTokens regression");

check("normalizeTaskSpec ignores caller maxOutputTokens", () => {
  const task = normalizeTaskSpec({
    model: "provider-a/model-a",
    thinking: "high",
    prompt: "hi",
    maxOutputTokens: "4096",
  });
  if ("maxOutputTokens" in task) throw new Error("caller budget must not survive normalization");
});

check("runInProcess awaits modelRegistry.refresh then passes parent ModelRuntime", () => {
  if (!/export async function refreshModelRegistry\(modelRegistry: any\): Promise<any>/.test(dispatchSrc)) {
    throw new Error("async modelRegistry refresh helper missing (must be exported)");
  }
  if (!/model-registry-refresh-singleflight/.test(dispatchSrc) || !/WeakMap/.test(dispatchSrc)) {
    throw new Error("refresh must singleflight via globalThis Symbol.for WeakMap");
  }
  if (!/await pending/.test(dispatchSrc) && !/await modelRegistry\.refresh\(\)/.test(dispatchSrc)) {
    throw new Error("refresh helper must await Promise refresh / inflight");
  }
  if (!/export function resolveParentModelRuntime\(modelRegistry: unknown\): (unknown|ModelRuntime)/.test(dispatchSrc)) {
    throw new Error("resolveParentModelRuntime helper missing");
  }
  if (!/\(modelRegistry as \{ runtime\?: unknown \}\)\.runtime|modelRegistry\.runtime/.test(dispatchSrc)) {
    throw new Error("parent ModelRuntime must be taken from registry.runtime");
  }
  const refreshIdx = dispatchSrc.search(/const refreshedModelRegistry = await refreshModelRegistry\(modelRegistry\);/);
  const resolveIdx = dispatchSrc.search(/const model = resolveModel\(modelStr, refreshedModelRegistry\);/);
  const runtimeIdx = dispatchSrc.search(/const parentModelRuntime = resolveParentModelRuntime\(refreshedModelRegistry\);/);
  const createSessionIdx = dispatchSrc.search(/await createAgentSession\(/);
  if (refreshIdx < 0 || resolveIdx < 0 || runtimeIdx < 0 || createSessionIdx < 0) {
    throw new Error("could not locate refresh / runtime / session lifecycle sites");
  }
  if (!(refreshIdx < resolveIdx && resolveIdx < runtimeIdx && runtimeIdx < createSessionIdx)) {
    throw new Error("must await refresh → resolve model → resolve parent runtime → createAgentSession");
  }
  if (!/modelRuntime: parentModelRuntime,/.test(dispatchSrc)) {
    throw new Error("createAgentSession must receive parent ModelRuntime");
  }
  if (/modelRegistry: refreshedModelRegistry,/.test(dispatchSrc)) {
    throw new Error("createAgentSession must not pass stale modelRegistry option on pi 0.80.10+");
  }
});

check("runInProcess resolves model maxTokens and installs it on createLoopConfig", () => {
  if (!/export function resolveMaxOutputTokens\(model: any\): number \| undefined/.test(dispatchSrc)) {
    throw new Error("resolveMaxOutputTokens helper must only accept model");
  }
  if (!/const modelMax = Number\(model\?\.maxTokens\);[\s\S]{0,120}?return Number\.isFinite\(modelMax\) && modelMax > 0 \? Math\.floor\(modelMax\) : undefined;/.test(dispatchSrc)) {
    throw new Error("effective budget must come directly from model.maxTokens");
  }
  if (!/return \{ \.\.\.\(config as Record<string, unknown>\), maxTokens: maxOutputTokens \};/.test(dispatchSrc)) {
    throw new Error("createLoopConfig wrapper must inject maxTokens");
  }
  const createSessionIdx = dispatchSrc.search(/await createAgentSession\(/);
  const installIdx = dispatchSrc.search(/installMaxOutputTokensOnSession\(session, effectiveMaxOutputTokens\)/);
  const promptIdx = dispatchSrc.search(/await session\.prompt\(prompt\)/);
  if (createSessionIdx < 0 || installIdx < 0 || promptIdx < 0) throw new Error("could not locate session lifecycle sites");
  if (!(createSessionIdx < installIdx && installIdx < promptIdx)) {
    throw new Error("maxTokens must be installed after session creation and before prompt execution");
  }
});

check("runInProcess surfaces the model-derived budget on AgentResult", () => {
  if (!/maxOutputTokens\?: number;/.test(dispatchSrc)) throw new Error("AgentResult field missing");
  if (!/const effectiveMaxOutputTokens = resolveMaxOutputTokens\(model\);/.test(dispatchSrc)) {
    throw new Error("effective budget must be derived from model only");
  }
  if (/heartbeatCtx\?\.maxOutputTokens/.test(dispatchSrc)) {
    throw new Error("heartbeatCtx must not carry caller output budget");
  }
  if (!/const resultWithBudget:\s*AgentResult\s*=\s*\{[\s\S]{0,240}?\.\.\.result,[\s\S]{0,180}?maxOutputTokens:\s*effectiveMaxOutputTokens/.test(dispatchSrc)) {
    throw new Error("effective budget not added to AgentResult");
  }
  if (!/const resultWithHeartbeat\s*=\s*enrichHeartbeat\(resultWithBudget\);[\s\S]{0,180}?return finalizeReasoningTrace\(resultWithHeartbeat/.test(dispatchSrc)) {
    throw new Error("heartbeat enrichment and reasoning finalization must preserve maxOutputTokens");
  }
});

check("dispatch_agent does not expose caller output budget", () => {
  const block = dispatchSrc.match(/name: "dispatch_agent",[\s\S]*?name: "dispatch_parallel",/)?.[0] ?? "";
  if (/maxOutputTokens: Type\.Optional\(Type\.Number/.test(block)) throw new Error("schema must not expose maxOutputTokens");
  if (/n\.maxOutputTokens/.test(block)) throw new Error("prepareArguments must not preserve maxOutputTokens");
  if (/params\.maxOutputTokens/.test(block)) throw new Error("execute must not read caller maxOutputTokens");
  if (!/max_output_tokens: result\.maxOutputTokens/.test(block)) throw new Error("audit field missing");
  if (!/maxOutputTokens: result\.maxOutputTokens/.test(block)) throw new Error("details field missing");
});

check("dispatch_parallel does not expose per-task or top-level output budget", () => {
  const start = dispatchSrc.indexOf('name: "dispatch_parallel"');
  const end = dispatchSrc.lastIndexOf("\n  });\n}");
  if (start < 0 || end <= start) throw new Error("could not locate dispatch_parallel registration");
  const block = dispatchSrc.slice(start, end + "\n  });".length);
  if (/maxOutputTokens: Type\.Optional\(Type\.Number/.test(block)) throw new Error("schema must not expose maxOutputTokens");
  if (/normalizeMaxOutputTokens/.test(block)) throw new Error("top-level output budget must not be normalized");
  if (/n\.maxOutputTokens/.test(block)) throw new Error("per-task budget must not be preserved by prepareArguments");
  if (/t\.maxOutputTokens|params\.maxOutputTokens/.test(block)) throw new Error("worker must not read caller output budget");
  if (!/max_output_tokens: res\.maxOutputTokens/.test(block)) throw new Error("per-task audit field missing");
  if (!/maxOutputTokens: r\.maxOutputTokens/.test(block)) throw new Error("per-task details field missing");
});

check("tool declaration says output budget is internal", () => {
  if (!/Output budget is internal/.test(dispatchSrc)) throw new Error("internal-budget guidance missing");
  if (!/callers cannot lower it/.test(dispatchSrc)) throw new Error("caller budget rejection guidance missing");
  if (/Prefer omitting maxOutputTokens/.test(dispatchSrc)) throw new Error("old prefer-omit guidance should be gone");
});

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
