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
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

function loaderLikeAliases() {
  return {
    "@earendil-works/pi-ai": path.join(repoRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-ai/compat": path.join(repoRoot, "node_modules/@earendil-works/pi-ai/dist/compat.js"),
    "@earendil-works/pi-ai/oauth": path.join(repoRoot, "node_modules/@earendil-works/pi-ai/dist/oauth.js"),
    "@earendil-works/pi-coding-agent": path.join(repoRoot, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    "@earendil-works/pi-agent-core": path.join(repoRoot, "node_modules/@earendil-works/pi-agent-core/dist/index.js"),
    "@earendil-works/pi-tui": path.join(repoRoot, "node_modules/@earendil-works/pi-tui/dist/index.js"),
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
const responsesBridgeSrc = readRel("extensions/compaction-tuner/openai-responses-shared-loader.mjs");
const schemaSrc = readRel("pi-astack-settings.schema.json");
const packageSrc = readRel("package.json");

console.log("source anchors:");

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

check("helper bypasses pi loader root alias through an ESM bridge", () => {
  if (helperSrc.includes("@earendil-works/pi-ai/api/openai-responses-shared")) {
    throw new Error("public pi-ai api subpath import is rewritten incorrectly by pi's extension loader alias");
  }
  if (helperSrc.includes("node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js")) {
    throw new Error("helper should not depend on a concrete node_modules layout");
  }
  if (!helperSrc.includes("./openai-responses-shared-loader.mjs")) {
    throw new Error("ESM bridge import missing");
  }
  if (!responsesBridgeSrc.includes('from "@earendil-works/pi-ai/api/openai-responses-shared"')) {
    throw new Error("ESM bridge should use the package public api export");
  }
});

await checkAsync("extension loads under pi-like jiti aliases", async () => {
  const loaderLikeJiti = createJiti(import.meta.url, {
    moduleCache: false,
    alias: loaderLikeAliases(),
  });
  const factory = await loaderLikeJiti.import(path.join(repoRoot, "extensions/compaction-tuner/index.ts"), { default: true });
  if (typeof factory !== "function") throw new Error(`expected extension factory, got ${typeof factory}`);
});

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

check("OpenAI Responses keeps system prompt in input", () => {
  const { body } = __TEST.buildCompactBody(eventFixture(), openaiModel, "system prompt", "sess-openai");
  if (body.instructions !== undefined) throw new Error("OpenAI Responses body should not use instructions");
  if (!Array.isArray(body.input) || body.input.length === 0) throw new Error("input missing");
  const first = body.input[0];
  if (first.role !== "developer" && first.role !== "system") throw new Error(`system prompt was not kept in input: ${JSON.stringify(first)}`);
  if (first.content !== "system prompt") throw new Error(`wrong system prompt content ${JSON.stringify(first)}`);
});

check("Codex Responses moves system prompt into instructions", () => {
  const { body } = __TEST.buildCompactBody(eventFixture(), codexModel, "system prompt", "sess-codex");
  if (body.instructions !== "system prompt") throw new Error(`wrong instructions ${body.instructions}`);
  if (!Array.isArray(body.input)) throw new Error("input missing");
  const hasSystemInInput = body.input.some((item) => item?.role === "developer" || item?.role === "system");
  if (hasSystemInInput) throw new Error(`system prompt leaked into input ${JSON.stringify(body.input[0])}`);
});

console.log(`\nfailures: ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
