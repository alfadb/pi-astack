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
 *     [--merged-source-verifier] [--verifier-model provider/model]
 *     [--verifier-max-prompt-chars N]
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import * as piAi from "@earendil-works/pi-ai/compat";
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

function nonNegativeInteger(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
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
const maxPromptChars = nonNegativeInteger(arg("max-prompt-chars", shadowSettings.maxPromptChars ?? 0));
const timeoutMs = Number(arg("timeout-ms", shadowSettings.timeoutMs ?? 1_200_000)) || 1_200_000;
const maxRetries = Number(arg("max-retries", shadowSettings.maxRetries ?? 0)) || 0;
const maxCompileRetries = Number(arg("max-compile-retries", shadowSettings.maxCompileRetries ?? 0)) || 0;
const escalationModelRef = arg("escalation-model", typeof shadowSettings.escalationModelRef === "string" ? shadowSettings.escalationModelRef : "") || "";
const verifierSettings = shadowSettings.mergedSourceVerifier ?? {};
const mergedSourceVerifierEnabled = hasFlag("merged-source-verifier") || Boolean(verifierSettings.enabled);
const configuredVerifierModel = typeof verifierSettings.model === "string" && verifierSettings.model.trim() ? verifierSettings.model.trim() : "";
const verifierModelRef = arg("verifier-model", configuredVerifierModel || modelRef);
const verifierMaxPromptChars = nonNegativeInteger(arg("verifier-max-prompt-chars", verifierSettings.maxPromptChars ?? 0));
const verifierPromptCap = verifierMaxPromptChars || maxPromptChars || undefined;

console.log("constraint shadow report dossier — ADR 0039 P1 PR4");
console.log(`mode: ${WRITE ? "write shadow artifacts" : "dry-run"}`);
console.log(`abrainHome: ${abrainHome}`);
console.log(`activeProjectId: ${activeProjectId}`);
console.log(`includeProjects: ${Array.isArray(includeProjects) ? includeProjects.join(",") || "none" : includeProjects}`);
console.log(`model: ${modelRef || "<empty>"}`);
console.log(`mergedSourceVerifier: ${mergedSourceVerifierEnabled ? "enabled" : "disabled"}`);
if (mergedSourceVerifierEnabled) {
  console.log(`verifierModel: ${verifierModelRef || "<empty>"}`);
}

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
  "extensions/_shared/causal-anchor.ts",
  "extensions/_shared/durable-write.ts",
  "extensions/_shared/audit-hmac.ts",
  "extensions/_shared/rotating-jsonl.ts",
  "extensions/_shared/llm-audit.ts",
  "extensions/_shared/jcs.ts",
  "extensions/_shared/proposition.ts",
  "extensions/_shared/l1-schema-registry.ts",
  "extensions/memory/settings.ts",
  "extensions/memory/utils.ts",
  "extensions/memory/direction-impact.ts",
  "extensions/memory/parser.ts",
  "extensions/sediment/sanitizer.ts",
  "extensions/sediment/settings.ts",
  "extensions/sediment/knowledge-evidence.ts",
  "extensions/sediment/constraint-compiler/types.ts",
  "extensions/sediment/constraint-evidence/types.ts",
  "extensions/sediment/constraint-evidence/canonical-json.ts",
  "extensions/sediment/constraint-evidence/hash-envelope.ts",
  "extensions/sediment/constraint-evidence/diagnostics.ts",
  "extensions/sediment/constraint-evidence/read.ts",
  "extensions/sediment/constraint-evidence/status.ts",
  "extensions/sediment/constraint-evidence/append.ts",
  "extensions/sediment/constraint-compiler/diagnostics.ts",
  "extensions/sediment/constraint-compiler/normalize.ts",
  "extensions/sediment/constraint-compiler/legacy-scan.ts",
  "extensions/sediment/constraint-compiler/event-scan.ts",
  "extensions/sediment/constraint-compiler/event-report.ts",
  "extensions/sediment/constraint-compiler/merged-source-verifier.ts",
  "extensions/sediment/constraint-compiler/merged-source-verifier-prompt.ts",
  "extensions/sediment/constraint-compiler/merged-source-verifier-llm.ts",
  "extensions/sediment/constraint-compiler/validate-decision.ts",
  "extensions/sediment/constraint-compiler/render.ts",
  "extensions/sediment/constraint-compiler/projection.ts",
  "extensions/sediment/constraint-compiler/corpus-split.ts",
  "extensions/sediment/constraint-compiler/diff.ts",
  "extensions/sediment/constraint-compiler/prompt.ts",
  "extensions/sediment/constraint-compiler/llm-compiler.ts",
  "extensions/sediment/constraint-compiler/pi-ai-invoker.ts",
  "extensions/sediment/constraint-compiler/shadow-runner.ts",
]) {
  stageTs(tmp, file);
}
fs.mkdirSync(path.join(tmp, "schemas"), { recursive: true });
fs.copyFileSync(path.join(repoRoot, "schemas", "l1-schema-role-registry.json"), path.join(tmp, "schemas", "l1-schema-role-registry.json"));
writeFile(path.join(tmp, "_shared", "pi-internals.js"), "exports.isSubAgentSession = () => false;\n");

const modelsJsonPath = path.join(agentDir, "models.json");
const { registry } = await makeOracleRegistry(modelsJsonPath);
const { listAbrainProjects } = require(path.join(tmp, "_shared", "runtime.js"));
const { createPiAiConstraintCompilerInvoker, createPiAiMergedSourceVerifierInvoker } = require(path.join(tmp, "sediment", "constraint-compiler", "pi-ai-invoker.js"));
const { runConstraintShadowCompiler } = require(path.join(tmp, "sediment", "constraint-compiler", "shadow-runner.js"));
const invoker = createPiAiConstraintCompilerInvoker({
  modelRegistry: registry,
  defaultModelRef: modelRef,
  timeoutMs,
  maxRetries,
  streamSimpleImpl: piAi,
  projectRoot: repoRoot,
});
const verifierInvoker = mergedSourceVerifierEnabled ? createPiAiMergedSourceVerifierInvoker({
  modelRegistry: registry,
  defaultModelRef: verifierModelRef,
  timeoutMs,
  maxRetries,
  streamSimpleImpl: piAi,
  projectRoot: repoRoot,
}) : undefined;

const beforeRules = fs.existsSync(path.join(abrainHome, "rules"))
  ? JSON.stringify(fs.readdirSync(path.join(abrainHome, "rules"), { recursive: true }).sort())
  : "[]";
const result = await runConstraintShadowCompiler({
  abrainHome,
  cwd: repoRoot,
  activeProjectId,
  knownProjectIds: Array.from(new Set([...(activeProjectId ? [activeProjectId] : []), ...listAbrainProjects(abrainHome)])).sort(),
  includeProjects,
  includeStatuses: "all",
  maxPromptChars: maxPromptChars || undefined,
  modelRef,
  maxCompileRetries,
  escalationModelRef: escalationModelRef || undefined,
  compilerInvoker: invoker,
  ...(mergedSourceVerifierEnabled ? {
    generateMergedSourceVerifier: true,
    verifierInvoker,
    verifierModelRef,
    verifierMaxPromptChars: verifierPromptCap,
  } : {}),
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
