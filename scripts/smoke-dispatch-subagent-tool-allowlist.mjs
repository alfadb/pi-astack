#!/usr/bin/env node
/**
 * Dispatch sub-agent tool-registry smoke.
 *
 * Covers both halves of the contract:
 *   - dispatch keeps only the six structural denials and wires them through
 *     validateTools + createAgentSession({ excludeTools })
 *   - requested names are validated against the created target session before
 *     prompt(), including tools registered dynamically by an extension factory
 */

import { readFileSync } from "node:fs";
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
  "memory_search", "memory_get", "memory_decide",
];
const DISABLED = [
  "dispatch_agent",
  "dispatch_parallel",
  "dispatch_hub",
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
    "structural disabled set is exactly the six required tools",
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
  /excludeTools:\s*\[\.\.\.DISABLED_SUBAGENT_TOOLS\]/.test(src),
  "createAgentSession applies the disabled set through excludeTools",
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
  /session\.dispose\(\)/.test(rejectionBlock) && /failureType:\s*"tool_rejected"/.test(rejectionBlock),
  "registry rejection disposes the target session and returns tool_rejected",
);
check(
  /SettingsManager\.create[\s\S]*?projectTrusted:\s*false/.test(src),
  "shared sub-agent loader remains projectTrusted:false",
);

console.log("\n  parser and structural validation:");
const resolvedDefault = dispatch.resolveSubAgentTools(undefined);
check(
  JSON.stringify(resolvedDefault) === JSON.stringify(EXPECTED_DEFAULT),
  "undefined tools resolves to the unchanged default set",
);
const exactNames = dispatch.resolveSubAgentTools(" read,read, Read , dynamic_extension_tool, dynamic_extension_tool ");
check(
  JSON.stringify(exactNames) === JSON.stringify(["read", "Read", "dynamic_extension_tool"]),
  "tool parsing trims and exact-deduplicates without case normalization",
);
for (const name of DISABLED) {
  const verdict = dispatch.validateTools(`  ${name.toUpperCase()}  `);
  check(!verdict.ok, `validateTools denies ${name} case-insensitively`);
}
for (const name of ["dynamic_extension_tool", "lsp_diagnostics", "lsp_diagnosticz", "goal_set", "workflow_validate", "bash"]) {
  const verdict = dispatch.validateTools(name);
  check(verdict.ok, `validateTools defers non-disabled name ${name} to target registry`);
}

console.log("\n  real target-session registry:");
const dynamicNames = [
  "web_search",
  "web_fetch",
  "memory_search",
  "memory_get",
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
