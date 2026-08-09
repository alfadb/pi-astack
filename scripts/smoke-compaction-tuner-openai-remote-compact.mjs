#!/usr/bin/env node
/**
 * Smoke: compaction-tuner OpenAI Responses remote compaction path.
 *
 * Locks path A:
 *   - remoteOpenAICompaction is opt-in and exact-allowlisted
 *   - /responses/compact success stores a recoverable summary marker
 *   - provider payload replay replaces that marker with the encrypted compaction item
 *   - skip/failure cases return structured non-completed outcomes for pi-core fallback
 *   - OpenAI Responses and Codex Responses request shapes match pi-ai conversion behavior
 */

import { createJiti } from "jiti";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  hostPackageRoot,
  hostPackageVersion,
  isRepoLocalPath,
  resolveExternalHostCodingAgent,
  resolveHostCodingAgent,
} from "./_resolve-host-pi.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const TARGET = "0.84.1";
const localCodingAgent = path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent");
const externalHost = resolveExternalHostCodingAgent(repoRoot);
const aliasHost = externalHost.external
  ? externalHost
  : resolveHostCodingAgent(repoRoot);
const aliasHostRoot = aliasHost.root && fs.existsSync(path.join(aliasHost.root, "package.json"))
  ? aliasHost.root
  : localCodingAgent;
const aliasHostIsExternal = Boolean(
  aliasHostRoot && !isRepoLocalPath(aliasHostRoot, repoRoot),
);

function versionAtLeast(actual, floor) {
  const a = String(actual).match(/^(\d+)\.(\d+)\.(\d+)/);
  const f = String(floor).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!a || !f) return false;
  const av = a.slice(1).map(Number);
  const fv = f.slice(1).map(Number);
  for (let i = 0; i < 3; i++) {
    if (av[i] !== fv[i]) return av[i] > fv[i];
  }
  return true;
}

function packageDist(root, name, file) {
  if (name === "@earendil-works/pi-coding-agent") {
    return path.join(root, "dist", file);
  }
  const nested = hostPackageRoot(root, name);
  if (nested) return path.join(nested, "dist", file);
  return path.join(repoRoot, "node_modules", name, "dist", file);
}

function loaderLikeAliases(hostRoot = aliasHostRoot) {
  return {
    "@earendil-works/pi-ai": packageDist(hostRoot, "@earendil-works/pi-ai", "compat.js"),
    "@earendil-works/pi-ai/compat": packageDist(hostRoot, "@earendil-works/pi-ai", "compat.js"),
    "@earendil-works/pi-ai/oauth": packageDist(hostRoot, "@earendil-works/pi-ai", "oauth.js"),
    "@earendil-works/pi-coding-agent": packageDist(hostRoot, "@earendil-works/pi-coding-agent", "index.js"),
    "@earendil-works/pi-agent-core": packageDist(hostRoot, "@earendil-works/pi-agent-core", "index.js"),
    "@earendil-works/pi-tui": packageDist(hostRoot, "@earendil-works/pi-tui", "index.js"),
    typebox: path.join(repoRoot, "node_modules/typebox/build/cjs/index.js"),
    "typebox/compile": path.join(repoRoot, "node_modules/typebox/compile/index.cjs"),
    "typebox/value": path.join(repoRoot, "node_modules/typebox/value/index.cjs"),
  };
}

let failures = 0;
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function readRel(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), "utf8");
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

console.log("Smoke: compaction-tuner OpenAI remote compact\n");

const indexSrc = readRel("extensions/compaction-tuner/index.ts");
const settingsSrc = readRel("extensions/compaction-tuner/settings.ts");
const helperSrc = readRel("extensions/compaction-tuner/openai-remote-compact.ts");
const responsesLoaderSrc = readRel("extensions/compaction-tuner/openai-responses-shared-loader.ts");
const schemaSrc = readRel("pi-astack-settings.schema.json");
const packageSrc = readRel("package.json");

console.log("source anchors:");
console.log(
  `  note  pi-like alias host via ${aliasHost.source ?? "unresolved"}: ${aliasHostRoot}` +
    ` (external=${aliasHostIsExternal}, coding-agent@${hostPackageVersion(aliasHostRoot, "@earendil-works/pi-coding-agent") ?? "?"}` +
    `, pi-ai@${hostPackageVersion(aliasHostRoot, "@earendil-works/pi-ai") ?? "?"})`,
);
if (!aliasHostIsExternal) {
  console.log(
    `  note  no external host for pi-like alias; falling back to ${aliasHostRoot}` +
      `; tried: ${(externalHost.tried || []).join(" | ")}`,
  );
}

check("remote helper is wired into session_before_compact and before_provider_request", () => {
  if (!indexSrc.includes('pi.on("session_before_compact"')) throw new Error("session_before_compact hook missing");
  if (!indexSrc.includes('pi.on("before_provider_request"')) throw new Error("before_provider_request hook missing");
  if (!indexSrc.includes("tryRunRemoteOpenAICompaction")) throw new Error("remote compact helper not used");
  if (!indexSrc.includes("injectRemoteOpenAICompactionIntoPayload")) throw new Error("remote injection helper not used");
});

check("remote-enabled skip/failure falls back to pi core default", () => {
  if (!indexSrc.includes("if (settings.remoteOpenAICompaction.enabled)")) throw new Error("remote enabled branch missing");
  if (!indexSrc.includes("return undefined")) throw new Error("fallback-to-default return missing");
  if (!indexSrc.includes("remote_openai_compaction_hook_threw")) throw new Error("hook throw audit anchor missing");
  if (!indexSrc.includes('outcome: "fallback_to_default"')) throw new Error("fallback audit outcome missing");
});

check("settings default is disabled with an empty allowlist", () => {
  if (!/remoteOpenAICompaction:\s*{[\s\S]*enabled:\s*false/.test(settingsSrc)) throw new Error("default enabled:false missing");
  if (!/modelAllowlist:\s*\[\]/.test(settingsSrc)) throw new Error("default empty allowlist missing");
  if (!/timeoutMs:\s*120_000/.test(settingsSrc)) throw new Error("default timeout missing");
  if (!/auditPayload:\s*"off"/.test(settingsSrc)) throw new Error("default auditPayload:off missing");
  if (!/resolveRemoteOpenAICompactionSettings/.test(settingsSrc)) throw new Error("settings resolver missing");
});

check("schema and package expose remote OpenAI compaction", () => {
  if (!schemaSrc.includes('"remoteOpenAICompaction"')) throw new Error("schema section missing");
  if (!schemaSrc.includes('"modelAllowlist"')) throw new Error("schema allowlist missing");
  if (!schemaSrc.includes('"timeoutMs"')) throw new Error("schema timeout missing");
  if (!schemaSrc.includes('"auditPayload"')) throw new Error("schema auditPayload missing");
  if (!schemaSrc.includes('"enum": ["off", "shape", "full"]')) throw new Error("schema auditPayload enum missing");
  if (!packageSrc.includes('"smoke:compaction-tuner-openai-remote-compact"')) throw new Error("package smoke script missing");
  const pkg = JSON.parse(packageSrc);
  if (pkg.dependencies?.openai !== "6.26.0") throw new Error("openai runtime dependency missing");
});

check("helper parses compact output defensively and exports test anchors", () => {
  if (!helperSrc.includes("Array.isArray(output)")) throw new Error("defensive output array parsing missing");
  if (!helperSrc.includes("normalizeRemoteOpenAICompactResponse")) throw new Error("JSON string response normalization missing");
  if (!helperSrc.includes('type === "compaction_summary"')) throw new Error("compaction_summary parsing anchor missing");
  if (!helperSrc.includes('type === "compaction"')) throw new Error("legacy compaction parsing anchor missing");
  if (!helperSrc.includes("PI_ASTACK_OPENAI_REMOTE_COMPACTION_V1:")) throw new Error("summary marker prefix missing");
  if (!helperSrc.includes("buildCompactBody")) throw new Error("buildCompactBody test anchor missing");
});

check("runtime keeps remote compact payload audit in a sidecar", () => {
  if (!indexSrc.includes("remote-openai-compact-payloads.jsonl")) throw new Error("sidecar path missing");
  if (!indexSrc.includes("appendRemoteOpenAICompactPayloadAudit")) throw new Error("sidecar writer missing");
  if (!indexSrc.includes("payload_audit_id")) throw new Error("main audit ref id missing");
  if (!indexSrc.includes("payload_sha256")) throw new Error("main audit hash missing");
});

check("helper resolves deep convertResponsesMessages via lazy jiti-managed import.meta.resolve loader", () => {
  if (helperSrc.includes("@earendil-works/pi-ai/api/openai-responses-shared")) {
    throw new Error("public pi-ai api subpath import is rewritten incorrectly by pi's extension loader alias");
  }
  if (helperSrc.includes("node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js")) {
    throw new Error("helper should not depend on a concrete node_modules layout");
  }
  if (helperSrc.includes("openai-responses-shared-loader.mjs")) {
    throw new Error("legacy native .mjs bridge import must be removed");
  }
  if (!helperSrc.includes("./openai-responses-shared-loader")) {
    throw new Error("jiti-managed openai-responses-shared-loader import missing");
  }
  if (fs.existsSync(path.join(repoRoot, "extensions/compaction-tuner/openai-responses-shared-loader.mjs"))) {
    throw new Error("legacy openai-responses-shared-loader.mjs must be deleted");
  }
  if (!responsesLoaderSrc.includes("import.meta.resolve(COMPAT_SPEC)") &&
      !responsesLoaderSrc.includes('import.meta.resolve("@earendil-works/pi-ai/compat")') &&
      !responsesLoaderSrc.includes("import.meta.resolve(`${PI_AI_NAME}/compat`)")) {
    throw new Error("loader must resolve @earendil-works/pi-ai/compat via import.meta.resolve");
  }
  if (!responsesLoaderSrc.includes("openai-responses-shared.js")) {
    throw new Error("loader must target openai-responses-shared.js next to compat");
  }
  if (!responsesLoaderSrc.includes("await import(") && !responsesLoaderSrc.includes("await import (")) {
    throw new Error("loader must dynamic-import the shared helper");
  }
  if (!responsesLoaderSrc.includes("loadOpenAIResponsesShared")) {
    throw new Error("loader must export lazy loadOpenAIResponsesShared API");
  }
  if (/^const loaded = await /m.test(responsesLoaderSrc) || /^export const convertResponsesMessages = loaded\./m.test(responsesLoaderSrc)) {
    throw new Error("loader must not top-level-await / statically bind convertResponsesMessages");
  }
  if (!responsesLoaderSrc.includes("loadPromise")) {
    throw new Error("loader must cache the load Promise");
  }
  if (!responsesLoaderSrc.includes("@alfadb/pi-astack") || !responsesLoaderSrc.includes("refusing local")) {
    throw new Error("loader must reject package-local node_modules pi-ai by default");
  }
  if (!responsesLoaderSrc.includes("PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI") &&
      !responsesLoaderSrc.includes("TEST_ALLOW_LOCAL_PI_AI_ENV")) {
    throw new Error("loader must document a clear test-only local override env");
  }
  if (!responsesLoaderSrc.includes("ConvertResponsesMessages")) {
    throw new Error("loader must export accurate ConvertResponsesMessages type");
  }
  if (!responsesLoaderSrc.includes("@earendil-works/pi-ai")) {
    throw new Error("loader must validate package name @earendil-works/pi-ai");
  }
  if (/["'`][^"'`]*npm-global[^"'`]*["'`]|process\.env\.NODE_PATH|process\.cwd\s*\(/.test(responsesLoaderSrc)) {
    throw new Error("loader must not hardcode global npm paths, NODE_PATH, or cwd");
  }
  if (/["'`][^"'`]*node_modules\/@earendil-works\/pi-ai[^"'`]*["'`]/.test(responsesLoaderSrc)) {
    throw new Error("loader must not fall back to repository node_modules");
  }
  if (!/export async function compactInputMessages/.test(helperSrc)) {
    throw new Error("compactInputMessages must be async (awaits lazy convert)");
  }
  if (!/async function buildCompactBody/.test(helperSrc)) {
    throw new Error("buildCompactBody must be async");
  }
});

await checkAsync("extension loads under pi-like jiti aliases without resolving deep helper", async () => {
  const loaderLikeJiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: loaderLikeAliases(),
  });
  const factory = await loaderLikeJiti.import(path.join(repoRoot, "extensions/compaction-tuner/index.ts"), { default: true });
  if (typeof factory !== "function") throw new Error(`expected extension factory, got ${typeof factory}`);
});

await checkAsync("no-alias import loads extension while remote conversion fails closed on repo-local pi-ai", async () => {
  // Plain jiti (no host alias): module graph must load; actual conversion must
  // refuse this package's local node_modules pi-ai unless test override is set.
  const plainJiti = createJiti(import.meta.url, { moduleCache: false });
  const factory = await plainJiti.import(
    path.join(repoRoot, "extensions/compaction-tuner/index.ts"),
    { default: true },
  );
  if (typeof factory !== "function") {
    throw new Error(`plain import expected extension factory, got ${typeof factory}`);
  }
  const plainLoader = await plainJiti.import(
    path.join(repoRoot, "extensions/compaction-tuner/openai-responses-shared-loader.ts"),
  );
  if (typeof plainLoader.__resetOpenAIResponsesSharedLoaderForTests === "function") {
    plainLoader.__resetOpenAIResponsesSharedLoaderForTests();
  }
  const prevOverride = process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI;
  const prevNodeEnv = process.env.NODE_ENV;
  delete process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI;
  delete process.env.NODE_ENV;
  try {
    let rejected = false;
    let detail = "";
    try {
      await plainLoader.loadOpenAIResponsesShared();
    } catch (err) {
      rejected = true;
      detail = err instanceof Error ? err.message : String(err);
    }
    if (!rejected) {
      throw new Error("expected fail-closed reject of repo-local pi-ai without alias/override");
    }
    if (!/refusing local|failed to resolve|@alfadb\/pi-astack|NODE_ENV/i.test(detail)) {
      throw new Error(`unexpected reject detail: ${detail}`);
    }
    console.log(`  note  no-alias fail-closed: ${detail.split("\n")[0]}`);
  } finally {
    if (prevOverride === undefined) delete process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI;
    else process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI = prevOverride;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    if (typeof plainLoader.__resetOpenAIResponsesSharedLoaderForTests === "function") {
      plainLoader.__resetOpenAIResponsesSharedLoaderForTests();
    }
  }
});

await checkAsync("host-aliased loader loads convertResponsesMessages from host pi-ai and converts a minimal fixture", async () => {
  if (!aliasHostIsExternal) {
    // Generic/dev layout without external host: test-only local override only.
    // Mark clearly — this is NOT production host acceptance.
    console.log(
      "  note  TEST-ONLY local path (no external host): NODE_ENV=test + PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI=1;" +
        " NOT a production host acceptance",
    );
    const prevOverride = process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI;
    const prevNodeEnv = process.env.NODE_ENV;
    process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI = "1";
    process.env.NODE_ENV = "test";
    try {
      const localJiti = createJiti(import.meta.url, {
        moduleCache: false,
        alias: loaderLikeAliases(localCodingAgent),
      });
      const localLoader = await localJiti.import(
        path.join(repoRoot, "extensions/compaction-tuner/openai-responses-shared-loader.ts"),
      );
      if (typeof localLoader.__resetOpenAIResponsesSharedLoaderForTests === "function") {
        localLoader.__resetOpenAIResponsesSharedLoaderForTests();
      }
      const loaded = await localLoader.loadOpenAIResponsesShared();
      if (typeof loaded.convertResponsesMessages !== "function") {
        throw new Error("test-only local loader did not export convertResponsesMessages");
      }
      if (!String(loaded.sourcePath || "").includes(`${path.sep}node_modules${path.sep}@earendil-works${path.sep}pi-ai${path.sep}`)) {
        throw new Error(`unexpected test-only local shared source: ${loaded.sourcePath}`);
      }
      console.log(`  note  TEST-ONLY deep helper source: ${loaded.sourcePath}`);
    } finally {
      if (prevOverride === undefined) delete process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI;
      else process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI = prevOverride;
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
    }
    return;
  }

  const hostAiVersion = hostPackageVersion(aliasHostRoot, "@earendil-works/pi-ai");
  const hostAgentVersion = hostPackageVersion(aliasHostRoot, "@earendil-works/pi-coding-agent");
  // 0.84.x gate: real host and host pi-ai must both be >= TARGET within the same
  // 0.84.x line (same-target compatibility). This rejects old 0.83.x/0.84.0 and
  // arbitrary future versions (0.85.0+, 1.x) — it never soft-passes off-minor.
  if (!versionAtLeast(hostAgentVersion, TARGET) || !String(hostAgentVersion).startsWith("0.84.")) {
    throw new Error(`external host pi-coding-agent@${hostAgentVersion} is not ${TARGET}+/0.84.x at ${aliasHostRoot}`);
  }
  if (!versionAtLeast(hostAiVersion, TARGET) || !String(hostAiVersion).startsWith("0.84.")) {
    throw new Error(`external host pi-ai@${hostAiVersion} is not ${TARGET}+/0.84.x under ${aliasHostRoot}`);
  }

  const hostJiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: loaderLikeAliases(aliasHostRoot),
  });
  const hostLoader = await hostJiti.import(
    path.join(repoRoot, "extensions/compaction-tuner/openai-responses-shared-loader.ts"),
  );
  if (typeof hostLoader.__resetOpenAIResponsesSharedLoaderForTests === "function") {
    hostLoader.__resetOpenAIResponsesSharedLoaderForTests();
  }
  const loaded = await hostLoader.loadOpenAIResponsesShared();
  if (typeof loaded.convertResponsesMessages !== "function") {
    throw new Error("host-aliased loader did not export convertResponsesMessages");
  }
  const source = String(loaded.sourcePath || "");
  const repoLocalAi = path.join(repoRoot, "node_modules/@earendil-works/pi-ai");
  const repoLocalAiReal = fs.existsSync(repoLocalAi) ? fs.realpathSync(repoLocalAi) : repoLocalAi;
  if (source === repoLocalAiReal || source.startsWith(repoLocalAiReal + path.sep) ||
      source === repoLocalAi || source.startsWith(repoLocalAi + path.sep)) {
    throw new Error(`helper resolved to repo local pi-ai, expected host: ${source}`);
  }
  if (!source.includes(`${path.sep}@earendil-works${path.sep}pi-ai${path.sep}`) || !source.endsWith(`${path.sep}openai-responses-shared.js`)) {
    throw new Error(`unexpected host shared source: ${source}`);
  }
  const hostAiRoot = hostPackageRoot(aliasHostRoot, "@earendil-works/pi-ai");
  if (!hostAiRoot || !(source === hostAiRoot || source.startsWith(hostAiRoot + path.sep))) {
    throw new Error(
      `shared source not under host pi-ai root ${hostAiRoot}: ${source}`,
    );
  }
  console.log(`  note  deep helper source (host): ${source}`);

  // Real convert call with a minimal fixture — not just "export is a function".
  const converted = loaded.convertResponsesMessages(
    {
      id: "gpt-5.5",
      provider: "openai",
      api: "openai-responses",
      baseUrl: "https://example.invalid/v1",
      input: ["text"],
      output: ["text"],
      reasoning: true,
      maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
    {
      systemPrompt: "system prompt",
      messages: [
        { role: "user", content: "hello from smoke", timestamp: 1 },
      ],
    },
    new Set(["openai", "openai-codex", "opencode"]),
  );
  if (!Array.isArray(converted) || converted.length === 0) {
    throw new Error(`host convertResponsesMessages returned non-array/empty: ${JSON.stringify(converted)?.slice(0, 200)}`);
  }
  const hasUserOrDeveloper = converted.some(
    (item) => item && typeof item === "object" && (item.role === "user" || item.role === "developer" || item.role === "system"),
  );
  if (!hasUserOrDeveloper) {
    throw new Error(`host convertResponsesMessages missing expected roles: ${JSON.stringify(converted).slice(0, 300)}`);
  }
  console.log(`  note  host convertResponsesMessages ok: ${converted.length} input item(s)`);
});

await checkAsync("real host loadExtensions loads compaction-tuner with 0 errors", async () => {
  if (!aliasHostIsExternal) {
    console.log(
      "  note  TEST-ONLY skip of real host loadExtensions (no external host);" +
        " NOT a production host acceptance",
    );
    return;
  }
  // loadExtensions is host-internal (not re-exported from public index).
  const hostLoaderEntry = path.join(aliasHostRoot, "dist", "core", "extensions", "loader.js");
  if (!fs.existsSync(hostLoaderEntry)) {
    throw new Error(`host extension loader missing: ${hostLoaderEntry}`);
  }
  const hostMod = await import(pathToFileURL(hostLoaderEntry).href);
  if (typeof hostMod.loadExtensions !== "function") {
    throw new Error(`host loader at ${hostLoaderEntry} does not export loadExtensions`);
  }
  const extPath = path.join(repoRoot, "extensions/compaction-tuner/index.ts");
  const result = await hostMod.loadExtensions([extPath], repoRoot);
  const errors = result?.errors ?? [];
  if (errors.length !== 0) {
    throw new Error(
      `host loadExtensions returned ${errors.length} error(s): ` +
        errors.map((e) => `${e.path}: ${e.error}`).join(" | "),
    );
  }
  if (!Array.isArray(result?.extensions) || result.extensions.length < 1) {
    throw new Error(`host loadExtensions returned no extensions: ${JSON.stringify(result)}`);
  }
  console.log(
    `  note  host loadExtensions ok via ${aliasHost.source}: ${result.extensions.length} extension(s), 0 errors`,
  );
});

// Runtime helper imports: dual test-only local override so plain jiti can load
// convert for body-shape unit tests without pretending to be host production.
const __prevBodyShapeOverride = process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI;
const __prevBodyShapeNodeEnv = process.env.NODE_ENV;
process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI = "1";
process.env.NODE_ENV = "test";
const remote = await jiti.import(path.join(repoRoot, "extensions/compaction-tuner/openai-remote-compact.ts"));
const tuner = await jiti.import(path.join(repoRoot, "extensions/compaction-tuner/index.ts"));
const {
  REMOTE_OPENAI_COMPACTION_MARKER_PREFIX,
  tryRunRemoteOpenAICompaction,
  injectRemoteOpenAICompactionIntoPayload,
  __TEST,
} = remote;
const {
  DEFAULT_COMPACTION_TUNER_SETTINGS,
  remoteOpenAICompactPayloadAuditPath,
  runRemoteOpenAICompaction,
} = tuner;

const settings = {
  enabled: true,
  modelAllowlist: ["openai/gpt-5.5", "openai-codex/gpt-5-codex"],
  timeoutMs: 1234,
  auditPayload: "off",
};

const openaiModel = {
  provider: "openai",
  id: "gpt-5.5",
  api: "openai-responses",
  baseUrl: "https://example.invalid/v1",
  input: ["text"],
  output: ["text"],
  reasoning: true,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const codexModel = {
  provider: "openai-codex",
  id: "gpt-5-codex",
  api: "openai-codex-responses",
  baseUrl: "https://example.invalid/v1",
  input: ["text"],
  output: ["text"],
  reasoning: true,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function eventFixture(extra = {}) {
  return {
    type: "session_before_compact",
    reason: "threshold",
    willRetry: false,
    signal: new AbortController().signal,
    preparation: {
      previousSummary: "previous durable summary",
      messagesToSummarize: [
        { role: "user", content: [{ type: "text", text: "summarize this message" }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "assistant response" }],
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.5",
          stopReason: "stop",
          timestamp: 2,
        },
      ],
      turnPrefixMessages: [
        { role: "user", content: [{ type: "text", text: "turn prefix" }], timestamp: 3 },
      ],
      firstKeptEntryId: "entry-kept",
      tokensBefore: 98765,
      isSplitTurn: true,
      ...extra.preparation,
    },
    ...extra,
  };
}

function compactedResponse(item = { type: "compaction_summary", encrypted_content: "encrypted-blob", id: "cmp_123" }) {
  return {
    id: "resp_compact_123",
    object: "response.compaction",
    output: [
      { type: "message", role: "assistant", content: [], status: "completed", id: "msg_1" },
      item,
    ],
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
  };
}

function runtimeSettings(auditPayload) {
  return {
    ...DEFAULT_COMPACTION_TUNER_SETTINGS,
    enabled: true,
    remoteOpenAICompaction: {
      ...DEFAULT_COMPACTION_TUNER_SETTINGS.remoteOpenAICompaction,
      enabled: true,
      modelAllowlist: ["openai/gpt-5.5"],
      timeoutMs: 1234,
      auditPayload,
    },
  };
}

function runtimeCtx(compactFn) {
  return {
    model: openaiModel,
    sessionManager: {
      getSessionId: () => "sess-remote-audit",
      getSessionFile: () => "/tmp/sess-remote-audit.json",
    },
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key" }),
    },
    getSystemPrompt: () => "system prompt",
    __testRemoteOpenAICompactFn: compactFn,
  };
}

function compactionAuditPath(projectRoot) {
  return path.join(projectRoot, ".pi-astack", "compaction-tuner", "audit.jsonl");
}

function summaryPayload(summary) {
  return {
    model: "gpt-5.5",
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`,
          },
        ],
      },
      { role: "user", content: [{ type: "input_text", text: "next user message" }] },
    ],
  };
}

console.log("\nruntime checks:");

await checkAsync("successful remote compact stores marker and passes compact options", async () => {
  let observedBody;
  let observedOptions;
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key", headers: { "x-auth-header": "1" } },
    settings,
    sessionId: "sess-remote",
    systemPrompt: "system prompt",
    compactFn: async (body, options) => {
      observedBody = body;
      observedOptions = options;
      return compactedResponse();
    },
  });
  if (result.outcome !== "completed") throw new Error(`unexpected outcome ${JSON.stringify(result)}`);
  if (observedBody.model !== "gpt-5.5") throw new Error(`wrong model ${observedBody.model}`);
  if (observedBody.prompt_cache_key !== "sess-remote") throw new Error("prompt_cache_key missing");
  if (observedOptions.timeout !== 1234) throw new Error(`wrong timeout ${observedOptions.timeout}`);
  if (observedOptions.maxRetries !== 0) throw new Error(`wrong maxRetries ${observedOptions.maxRetries}`);
  if (!result.compaction.summary.startsWith(REMOTE_OPENAI_COMPACTION_MARKER_PREFIX)) throw new Error("summary marker missing");
  if (result.compaction.firstKeptEntryId !== "entry-kept") throw new Error("firstKeptEntryId not preserved");
  if (result.compaction.tokensBefore !== 98765) throw new Error("tokensBefore not preserved");
  const parsed = __TEST.parseRemoteOpenAICompactionMarker(result.compaction.summary);
  if (parsed?.item.type !== "compaction_summary") throw new Error(`compaction_summary type not preserved: ${JSON.stringify(parsed?.item)}`);
  if (parsed?.item.encrypted_content !== "encrypted-blob") throw new Error("encrypted content not encoded");
  if (!parsed?.fallbackText?.includes("fallback marker")) throw new Error("fallback text missing");
});

await checkAsync("JSON string compact response is parsed before validation", async () => {
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key" },
    settings,
    compactFn: async () => JSON.stringify(compactedResponse({ type: "compaction_summary", encrypted_content: "string-encrypted-blob", id: "cmp_string" })),
  });
  if (result.outcome !== "completed") throw new Error(`unexpected outcome ${JSON.stringify(result)}`);
  const parsed = __TEST.parseRemoteOpenAICompactionMarker(result.compaction.summary);
  if (parsed?.item.type !== "compaction_summary") throw new Error(`JSON string type not preserved: ${JSON.stringify(parsed?.item)}`);
  if (parsed?.item.encrypted_content !== "string-encrypted-blob") throw new Error("JSON string encrypted content not encoded");
  if (typeof result.response === "string") throw new Error("normalized response should not remain a string");
});

await checkAsync("legacy compaction compact response remains compatible", async () => {
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key" },
    settings,
    compactFn: async () => compactedResponse({ type: "compaction", encrypted_content: "legacy-encrypted-blob", id: "cmp_legacy" }),
  });
  if (result.outcome !== "completed") throw new Error(`unexpected outcome ${JSON.stringify(result)}`);
  const parsed = __TEST.parseRemoteOpenAICompactionMarker(result.compaction.summary);
  if (parsed?.item.type !== "compaction") throw new Error(`legacy compaction type not preserved: ${JSON.stringify(parsed?.item)}`);
  if (parsed?.item.encrypted_content !== "legacy-encrypted-blob") throw new Error("legacy encrypted content not encoded");
});

await checkAsync("invalid compact response fails for pi fallback", async () => {
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key" },
    settings,
    compactFn: async () => compactedResponse({ type: "message", role: "assistant", content: [], status: "completed", id: "msg_no_compaction" }),
  });
  if (result.outcome !== "failed") throw new Error(`unexpected outcome ${JSON.stringify(result)}`);
  if (result.reason !== "invalid_response") throw new Error(`wrong reason ${result.reason}`);
});

await checkAsync("missing compact output fails invalid_response without TypeError", async () => {
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key" },
    settings,
    compactFn: async () => ({ id: "resp_no_output", object: "response.compaction", usage: {} }),
  });
  if (result.outcome !== "failed") throw new Error(`unexpected outcome ${JSON.stringify(result)}`);
  if (result.reason !== "invalid_response") throw new Error(`wrong reason ${result.reason}`);
  if (result.error.includes("Cannot read properties") || result.error.includes("TypeError")) throw new Error(`TypeError leaked: ${result.error}`);
});

await checkAsync("non-array compact output fails invalid_response without TypeError", async () => {
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key" },
    settings,
    compactFn: async () => ({ id: "resp_bad_output", object: "response.compaction", output: {}, usage: {} }),
  });
  if (result.outcome !== "failed") throw new Error(`unexpected outcome ${JSON.stringify(result)}`);
  if (result.reason !== "invalid_response") throw new Error(`wrong reason ${result.reason}`);
  if (result.error.includes("Cannot read properties") || result.error.includes("TypeError")) throw new Error(`TypeError leaked: ${result.error}`);
});

await checkAsync("unsupported provider skips for pi fallback before network", async () => {
  let called = false;
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: { ...openaiModel, provider: "anthropic" },
    auth: { apiKey: "test-key" },
    settings: { ...settings, modelAllowlist: ["anthropic/claude-opus-4-8"] },
    compactFn: async () => {
      called = true;
      return compactedResponse();
    },
  });
  if (called) throw new Error("compactFn was called for unsupported provider");
  if (result.outcome !== "skipped" || result.reason !== "unsupported_provider") throw new Error(`unexpected result ${JSON.stringify(result)}`);
});

await checkAsync("missing allowlist skips for pi fallback before network", async () => {
  let called = false;
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key" },
    settings: { ...settings, modelAllowlist: [] },
    compactFn: async () => {
      called = true;
      return compactedResponse();
    },
  });
  if (called) throw new Error("compactFn was called for empty allowlist");
  if (result.outcome !== "skipped" || result.reason !== "empty_allowlist") throw new Error(`unexpected result ${JSON.stringify(result)}`);
});

await checkAsync("remote transport error fails for pi fallback", async () => {
  const result = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key" },
    settings,
    compactFn: async () => {
      throw new Error("upstream 500");
    },
  });
  if (result.outcome !== "failed") throw new Error(`unexpected result ${JSON.stringify(result)}`);
  if (result.reason !== "remote_error") throw new Error(`wrong reason ${result.reason}`);
  if (!result.error.includes("upstream 500")) throw new Error(`wrong error ${result.error}`);
});

await checkAsync("payload audit default off does not write sidecar or full payload refs", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-compact-off-"));
  const response = compactedResponse({ type: "compaction_summary", encrypted_content: "off-encrypted-content", id: "cmp_off" });
  const result = await runRemoteOpenAICompaction(
    eventFixture(),
    runtimeCtx(async () => response),
    runtimeSettings("off"),
    projectRoot,
  );
  if (!result?.compaction) throw new Error("remote compaction did not complete");
  const payloadPath = remoteOpenAICompactPayloadAuditPath(projectRoot);
  if (fs.existsSync(payloadPath)) throw new Error("payload sidecar was written in off mode");
  const auditRows = readJsonl(compactionAuditPath(projectRoot));
  const row = auditRows.find((r) => r.operation === "remote_openai_compaction");
  if (!row) throw new Error("main audit row missing");
  if (row.payload_audit_id || row.payload_sha256 || row.payload_bytes) throw new Error(`payload refs present in off mode: ${JSON.stringify(row)}`);
  if (JSON.stringify(row).includes("off-encrypted-content")) throw new Error("encrypted payload leaked into main audit row");
});

await checkAsync("payload audit full writes complete parsed response and main audit refs", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-compact-full-"));
  const response = compactedResponse({ type: "compaction_summary", encrypted_content: "full-encrypted-content", id: "cmp_full" });
  const result = await runRemoteOpenAICompaction(
    eventFixture(),
    runtimeCtx(async () => response),
    runtimeSettings("full"),
    projectRoot,
  );
  if (!result?.compaction) throw new Error("remote compaction did not complete");
  const payloadPath = remoteOpenAICompactPayloadAuditPath(projectRoot);
  const payloadRows = readJsonl(payloadPath);
  if (payloadRows.length !== 1) throw new Error(`expected 1 payload row, got ${payloadRows.length}`);
  const payloadRow = payloadRows[0];
  if (payloadRow.payload_mode !== "full") throw new Error(`wrong payload mode ${payloadRow.payload_mode}`);
  if (payloadRow.payload_kind !== "response_full") throw new Error(`wrong payload kind ${payloadRow.payload_kind}`);
  if (payloadRow.payload?.output?.[1]?.encrypted_content !== "full-encrypted-content") throw new Error("full encrypted_content missing from sidecar");
  const payloadJson = JSON.stringify(payloadRow.payload);
  if (payloadRow.payload_sha256 !== sha256(payloadJson)) throw new Error("payload hash mismatch");
  if (payloadRow.payload_bytes !== Buffer.byteLength(payloadJson, "utf8")) throw new Error("payload byte count mismatch");
  const auditRows = readJsonl(compactionAuditPath(projectRoot));
  const row = auditRows.find((r) => r.operation === "remote_openai_compaction");
  if (!row) throw new Error("main audit row missing");
  if (row.payload_audit_id !== payloadRow.payload_audit_id) throw new Error("main audit id does not reference sidecar row");
  if (row.payload_audit_path !== payloadPath) throw new Error("main audit path does not reference sidecar path");
  if (row.payload_sha256 !== payloadRow.payload_sha256) throw new Error("main audit hash does not match sidecar");
  if (row.payload_bytes !== payloadRow.payload_bytes) throw new Error("main audit bytes do not match sidecar");
  if (row.payload_mode !== "full") throw new Error(`wrong main payload mode ${row.payload_mode}`);
  if (JSON.stringify(row).includes("full-encrypted-content")) throw new Error("full encrypted payload leaked into main audit row");
});

await checkAsync("payload audit full stores parsed JSON string response", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-compact-full-string-"));
  const response = compactedResponse({ type: "compaction_summary", encrypted_content: "full-string-encrypted-content", id: "cmp_full_string" });
  const result = await runRemoteOpenAICompaction(
    eventFixture(),
    runtimeCtx(async () => JSON.stringify(response)),
    runtimeSettings("full"),
    projectRoot,
  );
  if (!result?.compaction) throw new Error("remote compaction did not complete");
  const payloadRows = readJsonl(remoteOpenAICompactPayloadAuditPath(projectRoot));
  if (payloadRows.length !== 1) throw new Error(`expected 1 payload row, got ${payloadRows.length}`);
  const payloadRow = payloadRows[0];
  if (typeof payloadRow.payload === "string") throw new Error("full sidecar payload should be parsed object, not JSON string");
  if (payloadRow.payload?.output?.[1]?.encrypted_content !== "full-string-encrypted-content") throw new Error("parsed JSON string encrypted_content missing from sidecar");
  const row = readJsonl(compactionAuditPath(projectRoot)).find((r) => r.operation === "remote_openai_compaction");
  if (!row || row.outcome !== "completed" || row.payload_audit_id !== payloadRow.payload_audit_id) throw new Error(`main audit did not reference parsed string sidecar ${JSON.stringify(row)}`);
});

await checkAsync("payload audit shape omits full encrypted_content", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-compact-shape-"));
  const response = compactedResponse({ type: "compaction_summary", encrypted_content: "shape-encrypted-content", id: "cmp_shape" });
  const result = await runRemoteOpenAICompaction(
    eventFixture(),
    runtimeCtx(async () => response),
    runtimeSettings("shape"),
    projectRoot,
  );
  if (!result?.compaction) throw new Error("remote compaction did not complete");
  const payloadRows = readJsonl(remoteOpenAICompactPayloadAuditPath(projectRoot));
  if (payloadRows.length !== 1) throw new Error(`expected 1 payload row, got ${payloadRows.length}`);
  const payloadRow = payloadRows[0];
  if (payloadRow.payload_kind !== "response_shape") throw new Error(`wrong payload kind ${payloadRow.payload_kind}`);
  const shapeJson = JSON.stringify(payloadRow.payload_shape);
  if (shapeJson.includes("shape-encrypted-content")) throw new Error("shape sidecar contains full encrypted_content");
  const itemShape = payloadRow.payload_shape?.output_items?.find((item) => item.type === "compaction_summary");
  if (itemShape?.encrypted_content_length !== "shape-encrypted-content".length) throw new Error(`wrong encrypted_content length ${JSON.stringify(itemShape)}`);
});

await checkAsync("payload audit covers invalid_response fallback", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-compact-invalid-"));
  const badResponse = compactedResponse({ type: "message", role: "assistant", content: [], status: "completed", id: "msg_no_compaction" });
  const result = await runRemoteOpenAICompaction(
    eventFixture(),
    runtimeCtx(async () => badResponse),
    runtimeSettings("full"),
    projectRoot,
  );
  if (result !== undefined) throw new Error("invalid response should fall back to pi core");
  const payloadRows = readJsonl(remoteOpenAICompactPayloadAuditPath(projectRoot));
  if (payloadRows.length !== 1) throw new Error(`expected 1 payload row, got ${payloadRows.length}`);
  if (payloadRows[0].remote_outcome !== "failed" || payloadRows[0].reason !== "invalid_response") throw new Error(`wrong invalid payload row ${JSON.stringify(payloadRows[0])}`);
  if (!payloadRows[0].payload?.output) throw new Error("invalid full response not captured in sidecar");
  const auditRows = readJsonl(compactionAuditPath(projectRoot));
  const row = auditRows.find((r) => r.operation === "remote_openai_compaction");
  if (!row || row.outcome !== "fallback_to_default" || row.reason !== "invalid_response") throw new Error(`wrong main invalid audit row ${JSON.stringify(row)}`);
  if (row.payload_audit_id !== payloadRows[0].payload_audit_id) throw new Error("invalid main row missing sidecar reference");
});

await checkAsync("payload audit covers remote_error with error shape only", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-remote-compact-error-"));
  const result = await runRemoteOpenAICompaction(
    eventFixture(),
    runtimeCtx(async () => {
      const error = new Error("upstream unavailable");
      error.status = 503;
      error.code = "temporarily_unavailable";
      throw error;
    }),
    runtimeSettings("full"),
    projectRoot,
  );
  if (result !== undefined) throw new Error("remote error should fall back to pi core");
  const payloadRows = readJsonl(remoteOpenAICompactPayloadAuditPath(projectRoot));
  if (payloadRows.length !== 1) throw new Error(`expected 1 payload row, got ${payloadRows.length}`);
  const payloadRow = payloadRows[0];
  if (payloadRow.payload_kind !== "error_shape") throw new Error(`wrong payload kind ${payloadRow.payload_kind}`);
  if (payloadRow.payload || payloadRow.payload_shape) throw new Error("remote_error sidecar should not fake a response payload");
  if (payloadRow.error_shape?.status !== 503 || payloadRow.error_shape?.code !== "temporarily_unavailable") throw new Error(`error shape missing fields ${JSON.stringify(payloadRow.error_shape)}`);
  const row = readJsonl(compactionAuditPath(projectRoot)).find((r) => r.operation === "remote_openai_compaction");
  if (!row || row.payload_audit_id !== payloadRow.payload_audit_id) throw new Error("remote_error main row missing sidecar reference");
});

await checkAsync("payload marker is replaced by the compaction item", async () => {
  const attempt = await tryRunRemoteOpenAICompaction({
    event: eventFixture(),
    model: openaiModel,
    auth: { apiKey: "test-key" },
    settings,
    compactFn: async () => compactedResponse(),
  });
  if (attempt.outcome !== "completed") throw new Error("setup compact failed");
  const result = injectRemoteOpenAICompactionIntoPayload(
    summaryPayload(attempt.compaction.summary),
    { model: { provider: "openai", id: "gpt-5.5", api: "openai-responses" } },
    settings,
  );
  if (!result.injected) throw new Error(`not injected: ${JSON.stringify(result)}`);
  if (result.payload.input[0].type !== "compaction_summary") throw new Error(`first item not compaction_summary: ${JSON.stringify(result.payload.input[0])}`);
  if (result.payload.input[0].encrypted_content !== "encrypted-blob") throw new Error("encrypted content not replayed");
  if (result.payload.input[1].role !== "user") throw new Error("non-marker input item was not preserved");
});

check("marker parsing rejects malformed encrypted content", () => {
  const bad = __TEST.encodeRemoteOpenAICompactionMarker({
    kind: "openai_responses_compaction",
    version: 1,
    provider: "openai",
    model: "gpt-5.5",
    api: "openai-responses",
    item: { type: "compaction_summary", encrypted_content: "", id: "cmp_bad" },
  });
  const parsed = __TEST.parseRemoteOpenAICompactionMarker(bad);
  if (parsed !== undefined) throw new Error("malformed marker parsed successfully");
});

check("injection rejects malformed markers without deleting fallback text", () => {
  const result = injectRemoteOpenAICompactionIntoPayload(
    summaryPayload(`${REMOTE_OPENAI_COMPACTION_MARKER_PREFIX}{not-json}`),
    { model: { provider: "openai", id: "gpt-5.5", api: "openai-responses" } },
    settings,
  );
  if (result.injected) throw new Error("malformed marker injected");
  if (result.reason !== "marker_invalid") throw new Error(`wrong reason ${result.reason}`);
  if (!result.payload.input[0].content[0].text.includes("{not-json}")) throw new Error("fallback marker text was not preserved");
});

check("injection skips unsupported API and unsupported model", () => {
  const marker = __TEST.encodeRemoteOpenAICompactionMarker({
    kind: "openai_responses_compaction",
    version: 1,
    provider: "openai",
    model: "gpt-5.5",
    api: "openai-responses",
    item: { type: "compaction_summary", encrypted_content: "encrypted-blob", id: "cmp_123" },
  });
  const unsupportedApi = injectRemoteOpenAICompactionIntoPayload(
    summaryPayload(marker),
    { model: { provider: "openai", id: "gpt-5.5", api: "openai-completions" } },
    settings,
  );
  if (unsupportedApi.reason !== "unsupported_api") throw new Error(`wrong API reason ${unsupportedApi.reason}`);
  const unsupportedModel = injectRemoteOpenAICompactionIntoPayload(
    summaryPayload(marker),
    { model: { provider: "openai", id: "gpt-5.4", api: "openai-responses" } },
    settings,
  );
  if (unsupportedModel.reason !== "unsupported_model") throw new Error(`wrong model reason ${unsupportedModel.reason}`);
});

await checkAsync("OpenAI Responses keeps system prompt in input", async () => {
  const { body } = await __TEST.buildCompactBody(eventFixture(), openaiModel, "system prompt", "sess-openai");
  if (body.instructions !== undefined) throw new Error("OpenAI Responses body should not use instructions");
  if (!Array.isArray(body.input) || body.input.length === 0) throw new Error("input missing");
  const first = body.input[0];
  if (first.role !== "developer" && first.role !== "system") throw new Error(`system prompt was not kept in input: ${JSON.stringify(first)}`);
  if (first.content !== "system prompt") throw new Error(`wrong system prompt content ${JSON.stringify(first)}`);
});

await checkAsync("Codex Responses moves system prompt into instructions", async () => {
  const { body } = await __TEST.buildCompactBody(eventFixture(), codexModel, "system prompt", "sess-codex");
  if (body.instructions !== "system prompt") throw new Error(`wrong instructions ${body.instructions}`);
  if (!Array.isArray(body.input)) throw new Error("input missing");
  const hasSystemInInput = body.input.some((item) => item?.role === "developer" || item?.role === "system");
  if (hasSystemInInput) throw new Error(`system prompt leaked into input ${JSON.stringify(body.input[0])}`);
});

if (__prevBodyShapeOverride === undefined) delete process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI;
else process.env.PI_ASTACK_TEST_ALLOW_LOCAL_PI_AI = __prevBodyShapeOverride;
if (__prevBodyShapeNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = __prevBodyShapeNodeEnv;

console.log(`\nfailures: ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
