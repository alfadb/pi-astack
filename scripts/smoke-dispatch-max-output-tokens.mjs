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
const inputCompatCompiled = transpileTsToCjs(inputCompatSrc);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dispatch-max-output-"));
const tmpFile = path.join(tmpDir, "input-compat.cjs");
fs.writeFileSync(tmpFile, inputCompatCompiled);
const { normalizeMaxOutputTokens, normalizeTaskSpec } = loadModuleFromString(
  inputCompatCompiled,
  tmpFile,
);

console.log("dispatch maxOutputTokens regression");

check("input-compat normalizes positive integer budgets", () => {
  if (normalizeMaxOutputTokens("2048") !== 2048) throw new Error("string budget not normalized");
  if (normalizeMaxOutputTokens(2048.9) !== 2048) throw new Error("fractional budget not floored");
  if (normalizeMaxOutputTokens(0) !== undefined) throw new Error("zero budget should be rejected");
  if (normalizeMaxOutputTokens("nope") !== undefined) throw new Error("invalid budget should be rejected");
});

check("normalizeTaskSpec preserves maxOutputTokens", () => {
  const task = normalizeTaskSpec({
    model: "provider-a/model-a",
    thinking: "high",
    prompt: "hi",
    maxOutputTokens: "4096",
  });
  if (task.maxOutputTokens !== 4096) throw new Error(`got ${task.maxOutputTokens}`);
});

check("runInProcess resolves and installs maxTokens on createLoopConfig", () => {
  if (!/export function resolveMaxOutputTokens\(model: any, requested\?: number\)/.test(dispatchSrc)) {
    throw new Error("resolveMaxOutputTokens helper missing");
  }
  if (!/if \(modelCap === undefined\) return requestedCap;[\s\S]{0,160}?return Math\.min\(requestedCap, modelCap\);/.test(dispatchSrc)) {
    throw new Error("requested budget must be clamped to model.maxTokens");
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

check("runInProcess surfaces the effective budget on AgentResult", () => {
  if (!/maxOutputTokens\?: number;/.test(dispatchSrc)) throw new Error("AgentResult field missing");
  if (!/const effectiveMaxOutputTokens = resolveMaxOutputTokens\(model, heartbeatCtx\?\.maxOutputTokens\);/.test(dispatchSrc)) {
    throw new Error("effective budget not derived from heartbeatCtx");
  }
  if (!/const resultWithBudget = effectiveMaxOutputTokens === undefined[\s\S]{0,180}?\{ \.\.\.result, maxOutputTokens: effectiveMaxOutputTokens \};/.test(dispatchSrc)) {
    throw new Error("effective budget not added to AgentResult");
  }
  if (!/return enrichHeartbeat\(resultWithBudget\);/.test(dispatchSrc)) {
    throw new Error("enriched result must preserve maxOutputTokens");
  }
});

check("dispatch_agent schema and prepareArguments expose maxOutputTokens", () => {
  const block = dispatchSrc.match(/name: "dispatch_agent",[\s\S]*?name: "dispatch_parallel",/)?.[0] ?? "";
  if (!/maxOutputTokens: Type\.Optional\(Type\.Number/.test(block)) throw new Error("schema field missing");
  if (!/n\.maxOutputTokens !== undefined \? \{ maxOutputTokens: n\.maxOutputTokens \}/.test(block)) {
    throw new Error("prepareArguments does not preserve maxOutputTokens");
  }
  if (!/maxOutputTokens: params\.maxOutputTokens/.test(block)) {
    throw new Error("runInProcess heartbeatCtx does not receive dispatch_agent budget");
  }
  if (!/max_output_tokens: result\.maxOutputTokens/.test(block)) throw new Error("audit field missing");
  if (!/maxOutputTokens: result\.maxOutputTokens/.test(block)) throw new Error("details field missing");
});

check("dispatch_parallel supports per-task and top-level defaults", () => {
  const block = dispatchSrc.match(/name: "dispatch_parallel",[\s\S]*?ADR 0030: register dispatch_hub/)?.[0] ?? "";
  if (!/maxOutputTokens: Type\.Optional\(Type\.Number/.test(block)) throw new Error("schema field missing");
  if (!/const topMaxOutputTokens = normalizeMaxOutputTokens\(\(args as any\)\.maxOutputTokens\);/.test(block)) {
    throw new Error("top-level default is not normalized");
  }
  if (!/n\.maxOutputTokens !== undefined \? \{ maxOutputTokens: n\.maxOutputTokens \}/.test(block)) {
    throw new Error("per-task budget not preserved by prepareArguments");
  }
  if (!/maxOutputTokens: t\.maxOutputTokens \?\? params\.maxOutputTokens/.test(block)) {
    throw new Error("per-task budget must override top-level default");
  }
  if (!/max_output_tokens: res\.maxOutputTokens/.test(block)) throw new Error("per-task audit field missing");
  if (!/maxOutputTokens: r\.maxOutputTokens/.test(block)) throw new Error("per-task details field missing");
});

check("tool declaration tells callers to prefer omitting maxOutputTokens", () => {
  if (!/Prefer omitting maxOutputTokens/.test(dispatchSrc)) throw new Error("prefer-omit guidance missing");
  if (!/model registry maxTokens \(the largest configured cap\)/.test(dispatchSrc)) {
    throw new Error("schema must say omitted maxOutputTokens uses the largest configured cap");
  }
  if (!/low values can cause stopReason=length truncation/.test(dispatchSrc)) {
    throw new Error("schema must warn that low explicit budgets can truncate output");
  }
});

fs.rmSync(tmpDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.log(`\n${failures.length} failure(s)`);
  process.exit(1);
}
console.log("\nall ok");
