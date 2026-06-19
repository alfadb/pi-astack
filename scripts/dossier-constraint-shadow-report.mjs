#!/usr/bin/env node
/**
 * ADR 0039 P1 PR4 live dossier — manual Constraint Shadow Compiler report.
 *
 * User-initiated only. This script never registers runtime hooks and never
 * writes canonical rules or memory entries. It calls the real LLM only when
 * explicitly enabled by settings or --force, and writes artifacts only when
 * --write is passed.
 *
 * Usage:
 *   node scripts/dossier-constraint-shadow-report.mjs [--write] [--force]
 *     [--model provider/model] [--abrain ~/.abrain] [--project pi-global]
 *     [--include-projects active|all|none|id1,id2] [--max-prompt-chars N]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as piAi from "@earendil-works/pi-ai";
import { makeOracleRegistry } from "./_oracle-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const agentDir = path.resolve(repoRoot, "../..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

function arg(name, def) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < process.argv.length ? process.argv[index + 1] : def;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function transpile(srcPath) {
  const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  }).outputText;
  new (require("node:vm").Script)(out, { filename: srcPath });
  return out;
}

function stageTs(outRoot, src, dst = src.replace(/^extensions\//, "").replace(/\.ts$/, ".js")) {
  writeFile(path.join(outRoot, dst), transpile(path.join(repoRoot, src)));
}

function parseIncludeProjects(value) {
  if (!value || value === "active") return "active";
  if (value === "all") return "all";
  if (value === "none") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function readSettings() {
  const settingsPath = path.join(agentDir, "pi-astack-settings.json");
  return fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
}

function diagnosticsSummary(diagnostics) {
  const counts = new Map();
  for (const diagnostic of diagnostics ?? []) counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  return [...counts.entries()].map(([code, count]) => `${code}:${count}`).join(", ") || "none";
}

const WRITE = hasFlag("write");
const FORCE = hasFlag("force");
const abrainHome = path.resolve(arg("abrain", path.join(os.homedir(), ".abrain")));
const activeProjectId = arg("project", "pi-global");
const includeProjects = parseIncludeProjects(arg("include-projects", "active"));
const settingsConfig = readSettings();
const sediment = settingsConfig.sediment ?? {};
const shadowSettings = sediment.constraintShadowCompiler ?? {};
const enabled = Boolean(shadowSettings.enabled);
const configuredModel = typeof shadowSettings.model === "string" && shadowSettings.model.trim()
  ? shadowSettings.model.trim()
  : typeof sediment.curatorModel === "string" && sediment.curatorModel.trim()
    ? sediment.curatorModel.trim()
    : "";
const modelRef = arg("model", configuredModel);
const maxPromptChars = Number(arg("max-prompt-chars", shadowSettings.maxPromptChars ?? 0)) || 0;
const timeoutMs = Number(arg("timeout-ms", shadowSettings.timeoutMs ?? 1_200_000)) || 1_200_000;
const maxRetries = Number(arg("max-retries", shadowSettings.maxRetries ?? 0)) || 0;

console.log("constraint shadow report dossier — ADR 0039 P1 PR4");
console.log(`mode: ${WRITE ? "write shadow artifacts" : "dry-run"}`);
console.log(`abrainHome: ${abrainHome}`);
console.log(`activeProjectId: ${activeProjectId}`);
console.log(`includeProjects: ${Array.isArray(includeProjects) ? includeProjects.join(",") || "none" : includeProjects}`);
console.log(`model: ${modelRef || "<empty>"}`);

if (!enabled && !FORCE) {
  console.log("SKIP — sediment.constraintShadowCompiler.enabled is false. Pass --force for a one-shot manual run.");
  process.exit(0);
}
if (!WRITE) {
  console.log("SKIP — dry-run mode does not call the real LLM. Pass --write to write shadow artifacts.");
  process.exit(0);
}
if (!modelRef) {
  console.error("FAIL — no model configured. Set sediment.constraintShadowCompiler.model, sediment.curatorModel, or pass --model provider/model.");
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "constraint-shadow-dossier-"));
for (const file of [
  "extensions/_shared/runtime.ts",
  "extensions/memory/settings.ts",
  "extensions/memory/utils.ts",
  "extensions/memory/direction-impact.ts",
  "extensions/memory/parser.ts",
  "extensions/sediment/sanitizer.ts",
  "extensions/sediment/settings.ts",
  "extensions/sediment/constraint-compiler/types.ts",
  "extensions/sediment/constraint-compiler/diagnostics.ts",
  "extensions/sediment/constraint-compiler/normalize.ts",
  "extensions/sediment/constraint-compiler/legacy-scan.ts",
  "extensions/sediment/constraint-compiler/validate-decision.ts",
  "extensions/sediment/constraint-compiler/render.ts",
  "extensions/sediment/constraint-compiler/diff.ts",
  "extensions/sediment/constraint-compiler/prompt.ts",
  "extensions/sediment/constraint-compiler/llm-compiler.ts",
  "extensions/sediment/constraint-compiler/pi-ai-invoker.ts",
  "extensions/sediment/constraint-compiler/shadow-runner.ts",
]) {
  stageTs(tmp, file);
}

const modelsJsonPath = path.join(agentDir, "models.json");
const { registry } = makeOracleRegistry(modelsJsonPath);
const { createPiAiConstraintCompilerInvoker } = require(path.join(tmp, "sediment", "constraint-compiler", "pi-ai-invoker.js"));
const { runConstraintShadowCompiler } = require(path.join(tmp, "sediment", "constraint-compiler", "shadow-runner.js"));
const invoker = createPiAiConstraintCompilerInvoker({
  modelRegistry: registry,
  defaultModelRef: modelRef,
  timeoutMs,
  maxRetries,
  streamSimpleImpl: piAi,
});

const beforeRules = fs.existsSync(path.join(abrainHome, "rules"))
  ? JSON.stringify(fs.readdirSync(path.join(abrainHome, "rules"), { recursive: true }).sort())
  : "[]";
const result = await runConstraintShadowCompiler({
  abrainHome,
  cwd: repoRoot,
  activeProjectId,
  knownProjectIds: activeProjectId ? [activeProjectId] : [],
  includeProjects,
  includeStatuses: "all",
  maxPromptChars: maxPromptChars || undefined,
  modelRef,
  compilerInvoker: invoker,
  writeArtifacts: true,
});
const afterRules = fs.existsSync(path.join(abrainHome, "rules"))
  ? JSON.stringify(fs.readdirSync(path.join(abrainHome, "rules"), { recursive: true }).sort())
  : "[]";

console.log("\n-- result --");
console.log(`ok=${result.ok}`);
console.log(`inputRootHash=${result.inputRootHash}`);
console.log(`sourceCount=${result.sourceCount}`);
console.log(`diagnostics=${diagnosticsSummary(result.diagnostics)}`);
if (result.ok) {
  console.log(`constraints=${result.diff.summary.constraints}`);
  console.log(`exclusions=${result.diff.summary.exclusions}`);
  console.log(`unresolved=${result.diff.summary.unresolved}`);
  console.log(`unmappedSources=${result.diff.summary.unmappedSources}`);
  console.log(`shadowOutputHash=${result.view.shadowOutputHash}`);
}
if (result.artifacts) {
  console.log(`artifactRoot=${result.artifacts.root}`);
  console.log(`runDir=${result.artifacts.runDir}`);
  console.log(`latestDir=${result.artifacts.latestDir}`);
}
console.log(`rulesFileListChanged=${beforeRules !== afterRules}`);

fs.rmSync(tmp, { recursive: true, force: true });
process.exit(result.ok ? 0 : 1);
