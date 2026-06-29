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
import fs from "node:fs";
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
  if (!/resolveRemoteOpenAICompactionSettings/.test(settingsSrc)) throw new Error("settings resolver missing");
});

check("schema and package expose remote OpenAI compaction", () => {
  if (!schemaSrc.includes('"remoteOpenAICompaction"')) throw new Error("schema section missing");
  if (!schemaSrc.includes('"modelAllowlist"')) throw new Error("schema allowlist missing");
  if (!schemaSrc.includes('"timeoutMs"')) throw new Error("schema timeout missing");
  if (!packageSrc.includes('"smoke:compaction-tuner-openai-remote-compact"')) throw new Error("package smoke script missing");
});

check("helper parses CompactedResponse.output and exports test anchors", () => {
  if (!/response\.output\.find\(\(candidate\) => candidate\.type === "compaction"\)/.test(helperSrc)) {
    throw new Error("CompactedResponse.output parsing anchor missing");
  }
  if (!helperSrc.includes("PI_ASTACK_OPENAI_REMOTE_COMPACTION_V1:")) throw new Error("summary marker prefix missing");
  if (!helperSrc.includes("buildCompactBody")) throw new Error("buildCompactBody test anchor missing");
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
const {
  REMOTE_OPENAI_COMPACTION_MARKER_PREFIX,
  tryRunRemoteOpenAICompaction,
  injectRemoteOpenAICompactionIntoPayload,
  __TEST,
} = remote;

const settings = {
  enabled: true,
  modelAllowlist: ["openai/gpt-5.5", "openai-codex/gpt-5-codex"],
  timeoutMs: 1234,
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

function compactedResponse(item = { type: "compaction", encrypted_content: "encrypted-blob", id: "cmp_123" }) {
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
  if (parsed?.item.encrypted_content !== "encrypted-blob") throw new Error("encrypted content not encoded");
  if (!parsed?.fallbackText?.includes("fallback marker")) throw new Error("fallback text missing");
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
  if (result.payload.input[0].type !== "compaction") throw new Error(`first item not compaction: ${JSON.stringify(result.payload.input[0])}`);
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
    item: { type: "compaction", encrypted_content: "", id: "cmp_bad" },
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
    item: { type: "compaction", encrypted_content: "encrypted-blob", id: "cmp_123" },
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
