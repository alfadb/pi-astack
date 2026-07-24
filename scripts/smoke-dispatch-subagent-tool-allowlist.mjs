#!/usr/bin/env node
/**
 * Dispatch sub-agent tool-registry smoke.
 *
 * Covers both halves of the contract:
 *   - dispatch keeps only the five structural denials and wires them through
 *     validateTools + createAgentSession({ excludeTools })
 *   - requested names are validated against the created target session before
 *     prompt(), including tools registered dynamically by an extension factory
 */

import fs, { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createJiti } from "jiti";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const dispatchPath = resolve(repoRoot, "extensions/dispatch/index.ts");
const src = readFileSync(dispatchPath, "utf8");
const jiti = createJiti(import.meta.url);
const dispatch = await jiti.import(dispatchPath);

let pass = 0;
let fail = 0;
function ok(message) { pass++; console.log(`  ✓ ${message}`); }
function bad(message) { fail++; console.log(`  ✗ ${message}`); }
function check(condition, success, failure = success) {
  if (condition) ok(success);
  else bad(failure);
}

const EXPECTED_DEFAULT = [
  "read", "grep", "find", "ls",
  "web_search", "web_fetch",
  "memory_search", "abrain_get", "memory_decide",
];
const DISABLED = [
  "dispatch_agent",
  "dispatch_parallel",
  "workflow_run",
  "prompt_user",
  "vault_release",
];

console.log("\n  source contract:");
check(!src.includes("KNOWN_TOOLS"), "static KNOWN_TOOLS allowlist removed");

const disabledMatch = src.match(/const DISABLED_SUBAGENT_TOOLS = \[([\s\S]*?)\] as const;/);
if (!disabledMatch) {
  bad("could not locate DISABLED_SUBAGENT_TOOLS");
} else {
  const actual = [...disabledMatch[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  check(
    JSON.stringify(actual) === JSON.stringify(DISABLED),
    "structural disabled set is exactly the five required tools",
    `structural disabled set drifted: ${actual.join(", ")}`,
  );
}

const defaultMatch = src.match(/const DEFAULT_SUBAGENT_TOOLS\s*=\s*"([^"]+)"/);
if (!defaultMatch) {
  bad("could not locate DEFAULT_SUBAGENT_TOOLS");
} else {
  const actual = defaultMatch[1].split(",");
  check(
    JSON.stringify(actual) === JSON.stringify(EXPECTED_DEFAULT),
    "DEFAULT_SUBAGENT_TOOLS remains unchanged",
    `default tools drifted: ${actual.join(", ")}`,
  );
}

check(
  /excludeTools:\s*resolveSubAgentExcludeTools\(\s*\)/.test(src),
  "createAgentSession applies the permanent disabled set through excludeTools",
);
check(
  !/\bpi\.getAllTools\s*\(/.test(src),
  "dispatch never treats the parent ExtensionAPI registry as authoritative",
);

const createIndex = src.indexOf("const result = await createAgentSession({");
const registryIndex = src.indexOf("validateSessionToolRegistry(session, tools)", createIndex);
const promptIndex = src.indexOf("await session.prompt(prompt)", createIndex);
check(
  createIndex >= 0 && registryIndex > createIndex && promptIndex > registryIndex,
  "target-session registry validation runs after creation and before prompt",
);
const rejectionBlock = src.slice(registryIndex, promptIndex);
check(
  /await disposeSubAgentSession\(session\)/.test(rejectionBlock) && /failureType:\s*"tool_rejected"/.test(rejectionBlock),
  "registry rejection emits shutdown, disposes the target session, and returns tool_rejected",
);
check(
  /SettingsManager\.create[\s\S]*?projectTrusted:\s*false/.test(src),
  "per-session sub-agent loader remains projectTrusted:false",
);

console.log("\n  parser and structural validation:");
const resolvedDefault = dispatch.resolveSubAgentTools(undefined);
check(
  JSON.stringify(resolvedDefault) === JSON.stringify(EXPECTED_DEFAULT),
  "undefined tools resolves to the unchanged default set",
);
const exactNames = dispatch.resolveSubAgentTools(" read,read, Read , memory_get,abrain_get, dynamic_extension_tool, dynamic_extension_tool ");
check(
  JSON.stringify(exactNames) === JSON.stringify(["read", "Read", "abrain_get", "dynamic_extension_tool"]),
  "tool parsing canonicalizes legacy memory_get, trims, and exact-deduplicates without case normalization",
);
for (const name of DISABLED) {
  const verdict = dispatch.validateTools(`  ${name.toUpperCase()}  `);
  check(!verdict.ok, `validateTools denies ${name} case-insensitively`);
}
for (const name of ["dynamic_extension_tool", "lsp_diagnostics", "lsp_diagnosticz", "goal_set", "workflow_validate", "bash"]) {
  const verdict = dispatch.validateTools(name);
  check(verdict.ok, `validateTools defers non-disabled name ${name} to target registry`);
}
check(
  JSON.stringify(dispatch.resolveSubAgentExcludeTools()) === JSON.stringify(DISABLED),
  "SDK exclusion remains the exact five-tool deny set",
);
// Permanent recursive-dispatch retirement: extra JS args cannot lift the five denials.
const permanentDenyArgs = [
  undefined,
  null,
  { mode: "shadow", allowedTools: ["dispatch_agent", "dispatch_parallel"] },
  { maxDepth: 1, allowsMutation: true },
  "read,dispatch_agent,dispatch_parallel",
];
for (const extra of permanentDenyArgs) {
  for (const name of DISABLED) {
    const verdict = dispatch.validateTools(
      name === "dispatch_agent" ? `read,${name}` : name,
      extra,
    );
    check(!verdict.ok, `validateTools permanently denies ${name} even with extra arg ${JSON.stringify(extra)}`);
  }
  const excluded = dispatch.resolveSubAgentExcludeTools(extra);
  check(
    JSON.stringify(excluded) === JSON.stringify(DISABLED) && excluded !== DISABLED,
    `resolveSubAgentExcludeTools ignores extra arg and returns a fresh permanent five-tool set (extra=${JSON.stringify(extra)})`,
  );
}
check(
  dispatch.validateTools.length === 1,
  "validateTools is single-argument (no delegation exception parameter)",
);
check(
  dispatch.resolveSubAgentExcludeTools.length === 0,
  "resolveSubAgentExcludeTools is zero-argument (no toolsStr / exception parameter)",
);
check(
  dispatch.disposeSubAgentSession.length === 1,
  "disposeSubAgentSession is single-argument (no sessionManager parameter)",
);
check(
  !src.includes("delegation-shadow-bridge") &&
    !src.includes("delegation-capability") &&
    !src.includes("delegation-broker") &&
    !src.includes("delegation-audit") &&
    !src.includes("tree-governor") &&
    !src.includes("process-provider-limiter") &&
    !src.includes("shadowDelegationSchema"),
  "production dispatch index has no active delegation scaffolding modules",
);
check(
  src.includes("不得再次派发") &&
    src.includes("dispatch_agent / dispatch_parallel / workflow_run"),
  "role clarification still permanently forbids recursive dispatch",
);

const retiredRuntime = [
  "extensions/dispatch/delegation-capability.ts",
  "extensions/dispatch/delegation-broker.ts",
  "extensions/dispatch/delegation-audit.ts",
  "extensions/dispatch/delegation-shadow-bridge.ts",
  "extensions/dispatch/tree-governor.ts",
  "extensions/dispatch/process-provider-limiter.ts",
  "scripts/smoke-dispatch-delegation.mjs",
  "scripts/smoke-dispatch-delegation-core.mjs",
  "scripts/smoke-dispatch-delegation-shadow.mjs",
  "scripts/smoke-dispatch-delegation-production-replay.mjs",
];
for (const rel of retiredRuntime) {
  const full = resolve(repoRoot, rel);
  check(!existsSync(full), `retired path absent: ${rel}`);
}

const productionExtensionsRoot = resolve(repoRoot, "extensions");
function walkTs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walkTs(full, out);
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}
const bannedImport = /delegation-shadow-bridge|delegation-capability|delegation-broker|delegation-audit|tree-governor|process-provider-limiter|shadowDelegationSchema/;
const offenders = [];
for (const file of walkTs(productionExtensionsRoot)) {
  const body = readFileSync(file, "utf8");
  if (bannedImport.test(body)) offenders.push(file.slice(repoRoot.length + 1));
}
check(
  offenders.length === 0,
  "no active delegation scaffolding tokens under extensions/",
  `active delegation scaffolding tokens under extensions/: ${offenders.join(", ")}`,
);

const workflowSrc = readFileSync(resolve(repoRoot, "extensions/workflow/index.ts"), "utf8");
check(
  /validateTools\(req\.tools\)/.test(workflowSrc) &&
    /enforceMutatingEnvGate/.test(workflowSrc),
  "workflow keeps its independent deny/gate on top of dispatch validateTools",
);

const workflowDslPath = resolve(repoRoot, "extensions/workflow/dsl.ts");
const workflowDsl = await jiti.import(workflowDslPath);
const forbiddenTools = [...workflowDsl.FORBIDDEN_TOOLS].sort();
const expectedForbidden = ["dispatch_agent", "dispatch_parallel", "dispatch_parallel_subagent"].sort();
check(
  JSON.stringify(forbiddenTools) === JSON.stringify(expectedForbidden),
  "workflow/dsl.ts FORBIDDEN_TOOLS is exactly dispatch_agent, dispatch_parallel, dispatch_parallel_subagent",
  `workflow/dsl.ts FORBIDDEN_TOOLS drifted: ${forbiddenTools.join(", ")}`,
);

console.log("\n  real target-session registry:");
const dynamicNames = [
  "web_search",
  "web_fetch",
  "memory_search",
  "abrain_get",
  "memory_decide",
  "dynamic_extension_tool",
  "lsp_diagnostics",
  ...DISABLED,
];
const settingsManager = SettingsManager.inMemory();
const resourceLoader = new DefaultResourceLoader({
  cwd: repoRoot,
  agentDir: resolve(repoRoot, ".dispatch-smoke-agent-not-present"),
  settingsManager,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: [(pi) => {
    for (const name of dynamicNames) {
      pi.registerTool({
        name,
        label: name,
        description: `Smoke tool ${name}`,
        parameters: Type.Object({}),
        async execute() {
          return { content: [{ type: "text", text: name }], details: {} };
        },
      });
    }
  }],
});
await resourceLoader.reload();

const typo = "lsp_diagnosticz";
const requested = [...EXPECTED_DEFAULT, "dynamic_extension_tool", "lsp_diagnostics", typo, ...DISABLED];
const { session } = await createAgentSession({
  cwd: repoRoot,
  tools: requested,
  excludeTools: DISABLED,
  resourceLoader,
  settingsManager,
  sessionManager: SessionManager.inMemory(repoRoot),
});

try {
  const available = session.getAllTools().map((tool) => tool.name);
  const active = session.getActiveToolNames();

  check(
    dispatch.validateSessionToolRegistry(session, EXPECTED_DEFAULT).ok,
    "unchanged default set validates against a target registry that registers it",
  );
  check(
    available.includes("dynamic_extension_tool") && active.includes("dynamic_extension_tool"),
    "dynamically registered extension tool is explicitly requestable and active",
  );
  check(
    dispatch.validateSessionToolRegistry(session, ["lsp_diagnostics"]).ok,
    "lsp_diagnostics is accepted when the target loader actually registers it",
  );

  const typoVerdict = dispatch.validateSessionToolRegistry(
    session,
    [...EXPECTED_DEFAULT, "dynamic_extension_tool", "lsp_diagnostics", typo],
  );
  check(!typoVerdict.ok, "misspelled tool is rejected by the target registry");
  check(
    typoVerdict.reason?.includes(typo) &&
      typoVerdict.reason?.includes("Available tools:") &&
      typoVerdict.reason?.includes("lsp_diagnostics"),
    "tool_rejected reason names the typo and target session's available tools",
  );

  const caseVerdict = dispatch.validateSessionToolRegistry(session, ["Dynamic_Extension_Tool"]);
  check(!caseVerdict.ok, "non-denylisted tool names retain SDK case-sensitive matching");

  for (const name of DISABLED) {
    check(
      !available.includes(name) && !active.includes(name),
      `excludeTools keeps registered ${name} unavailable`,
    );
  }
} finally {
  session.dispose();
}

console.log("\n  configured global loader:");
const globalSettingsPath = resolve(getAgentDir(), "settings.json");
let hasPiLsp = false;
try {
  const globalSettings = JSON.parse(readFileSync(globalSettingsPath, "utf8"));
  hasPiLsp = Array.isArray(globalSettings.packages) &&
    globalSettings.packages.some((entry) => typeof entry === "string" && entry.includes("pi-lsp"));
} catch {
  // A package checkout need not have a global pi installation.
}

if (!hasPiLsp) {
  ok("pi-lsp is not configured globally; real lsp_diagnostics probe skipped");
} else {
  const cwd = process.cwd();
  const globalSettingsManager = SettingsManager.create(cwd, getAgentDir(), { projectTrusted: false });
  const globalResourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager: globalSettingsManager,
    noExtensions: false,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await globalResourceLoader.reload();
  const { session: globalSession } = await createAgentSession({
    cwd,
    tools: ["lsp_diagnostics"],
    excludeTools: DISABLED,
    resourceLoader: globalResourceLoader,
    settingsManager: globalSettingsManager,
    sessionManager: SessionManager.inMemory(cwd),
  });
  try {
    check(
      globalResourceLoader.getExtensions().errors.length === 0 &&
        dispatch.validateSessionToolRegistry(globalSession, ["lsp_diagnostics"]).ok,
      "configured global pi-lsp registers usable lsp_diagnostics in the target session",
    );
  } finally {
    globalSession.dispose();
  }
}

console.log();
if (fail === 0) {
  console.log(`✅ dispatch sub-agent dynamic tool registry: all ${pass} checks passed`);
  process.exit(0);
}

console.error(`❌ dispatch sub-agent dynamic tool registry: ${fail} failure(s) out of ${pass + fail}`);
process.exit(1);
