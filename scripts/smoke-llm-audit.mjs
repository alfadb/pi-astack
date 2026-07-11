#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

const {
  appendLlmAudit,
  auditProviderBoundaryEvent,
  auditStreamSimple,
  auditSessionEvent,
  MAX_SESSION_STREAM_AGGREGATES,
  _llmAuditStreamStateSizeForTests,
  _resetLlmAuditStreamStateForTests,
} = jiti(path.join(repoRoot, "extensions/_shared/llm-audit.ts"));
const {
  _resetDeviceIdCacheForTests,
  _setCurrentAnchorForTests,
} = jiti(path.join(repoRoot, "extensions/_shared/causal-anchor.ts"));
const { embedTexts } = jiti(path.join(repoRoot, "extensions/memory/embedding.ts"));
const {
  auditHmacHex,
  auditHmacHexStrict,
  _resetAuditHmacCachesForTests,
} = jiti(path.join(repoRoot, "extensions/_shared/audit-hmac.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-llm-audit-"));
process.env.ABRAIN_ROOT = path.join(tmpRoot, "abrain");
_resetDeviceIdCacheForTests();
process.on("exit", () => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});
const auditFile = path.join(tmpRoot, ".pi-astack", "llm-audit", "audit.jsonl");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    fail++;
    console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}`);
  }
}

function rows() {
  return fs.readFileSync(auditFile, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForJsonlRows(file, expected) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
      if (lines.length >= expected) return lines.map((line) => JSON.parse(line));
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${expected} JSONL rows in ${file}`);
}

function assertNoForbiddenAuditKeys(value, at = "row") {
  const forbidden = new Set([
    "prompt", "text", "content", "reasoning", "tool_output", "request_body",
    "raw_response_text", "parsed_response", "request_payload", "event", "message",
    "delta", "base64", "url", "headers", "credential", "credentials", "signature",
    "encrypted_content",
  ]);
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenAuditKeys(item, `${at}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
    if (forbidden.has(normalized)) throw new Error(`forbidden audit key ${key} at ${at}`);
    assertNoForbiddenAuditKeys(child, `${at}.${key}`);
  }
}

async function emitStream(root, operation, responseId, count = 1200) {
  const meta = { module: "smoke", operation, session_scope: "test" };
  for (let index = 0; index < count; index++) {
    const kind = index % 3 === 0 ? "thinking" : index % 3 === 1 ? "text" : "tool";
    const raw = `${kind}-raw-${index % 11}-must-not-persist`;
    const identity = index === 0 ? {} : { responseId, provider: "fake", model: "fake-model" };
    await auditSessionEvent(root, meta, {
      type: "message_update",
      timestamp: `2026-07-11T00:00:${String(index % 60).padStart(2, "0")}.000Z`,
      message: { role: "assistant", ...identity },
      assistantMessageEvent: {
        type: `${kind}_delta`,
        contentIndex: index % 70,
        delta: raw,
        partial: {
          ...identity,
          content: [{ type: kind, [kind]: `cumulative-${raw}` }],
        },
      },
    });
  }
  await auditSessionEvent(root, meta, {
    type: "message_end",
    message: { role: "assistant", responseId, provider: "fake", model: "fake-model", content: [] },
  });
}

console.log("llm-audit smoke");

await check("package manifest loads llm-audit after provider payload mutators", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const manifestExtensions = pkg.pi?.extensions;
  if (!Array.isArray(manifestExtensions)) throw new Error("package.json pi.extensions must be an array");
  if (manifestExtensions.includes("./extensions")) throw new Error("pi.extensions must be explicit so llm-audit can load after mutators");
  const extensionDirs = fs.readdirSync(path.join(repoRoot, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `./extensions/${entry.name}/index.ts`)
    .filter((entryPath) => fs.existsSync(path.join(repoRoot, entryPath)));
  const missing = extensionDirs.filter((entryPath) => !manifestExtensions.includes(entryPath));
  if (missing.length > 0) throw new Error(`package.json pi.extensions missing entries: ${missing.join(", ")}`);
  const auditIndex = manifestExtensions.indexOf("./extensions/llm-audit/index.ts");
  if (auditIndex !== manifestExtensions.length - 1) throw new Error("llm-audit must be last in pi.extensions");
  for (const mutator of [
    "./extensions/compaction-tuner/index.ts",
    "./extensions/openai-service-tier/index.ts",
    "./extensions/tool-parallel-cap/index.ts",
  ]) {
    const mutatorIndex = manifestExtensions.indexOf(mutator);
    if (mutatorIndex < 0) throw new Error(`provider mutator missing from pi.extensions: ${mutator}`);
    if (mutatorIndex > auditIndex) throw new Error(`llm-audit must load after provider mutator ${mutator}`);
  }
});

await check("appendLlmAudit writes JSONL", async () => {
  await appendLlmAudit(tmpRoot, { row_type: "manual", module: "smoke", operation: "append", value: 42 });
  const all = rows();
  if (all.length !== 1) throw new Error(`expected 1 row, got ${all.length}`);
  if (all[0].value !== 42 || !all[0].ts) throw new Error(`bad row: ${JSON.stringify(all[0])}`);
});

await check("generic append drops forbidden containers and redacts explicit API keys", async () => {
  await appendLlmAudit(tmpRoot, {
    row_type: "manual",
    module: "smoke",
    operation: "redact",
    request: {
      config: {
        apiKey: "sk-secret",
        systemPrompt: "system-prompt-must-not-persist",
        thinkingSignature: "thinking-signature-must-not-persist",
        baseUrl: "https://private-base-url.example",
        Authorization: "Bearer misplaced-secret",
        "X-API-Key": "misplaced-api-key-secret",
        headers: {
          Authorization: "Bearer secret",
          Cookie: "sid=secret",
          "X-API-Key": "x-api-key-secret",
          "Service-Api-Key": "api-key-secret",
          Apikey: "apikey-secret",
          "Api_Key": "api_key-secret",
          "X-Client-Secret": "client-secret",
          "X-Credential-Id": "credential-secret",
          "X-Trace-Id": "keep-me",
          Key: "ordinary-key-value",
          "X-Custom-Token": "secret-token",
        },
      },
    },
  });
  const raw = fs.readFileSync(auditFile, "utf8");
  const leaked = [
    "sk-secret",
    "Bearer secret",
    "sid=secret",
    "x-api-key-secret",
    "api-key-secret",
    "apikey-secret",
    "api_key-secret",
    "client-secret",
    "credential-secret",
    "secret-token",
    "system-prompt-must-not-persist",
    "thinking-signature-must-not-persist",
    "https://private-base-url.example",
    "Bearer misplaced-secret",
    "misplaced-api-key-secret",
  ].filter((secret) => raw.includes(secret));
  if (leaked.length > 0) throw new Error(`secret leaked into audit log: ${leaked.join(", ")}: ${raw}`);
  if (raw.includes("keep-me") || raw.includes("ordinary-key-value")) throw new Error("headers container must be dropped in full");
  assertNoForbiddenAuditKeys(rows().at(-1));
});

await check("auditStreamSimple records allowlisted shapes without prompt, output, tool, signature, or credentials", async () => {
  const promptText = "stream-prompt-body-must-not-persist";
  const visibleText = "stream-visible-final-must-not-persist-" + "x".repeat(5000);
  const toolOutput = "stream-tool-output-must-not-persist";
  const fakePiAi = {
    streamSimple() {
      return {
        async result() {
          return {
            role: "assistant",
            provider: "fake",
            api: "fake-api",
            model: "model",
            stopReason: "stop",
            usage: { input: 1, output: 2, totalTokens: 3 },
            content: [
              { type: "text", text: visibleText },
              { type: "toolResult", output: toolOutput },
              { type: "thinking", thinking: "stream-thinking-must-not-persist", signature: "stream-signature-must-not-persist" },
            ],
            encryptedContent: "stream-encrypted-payload-must-not-persist",
          };
        },
      };
    },
  };
  const result = await auditStreamSimple(
    tmpRoot,
    {
      module: "smoke",
      operation: "fake_stream",
      model_ref: "fake/model",
      prompt: "meta-prompt-must-not-persist",
      output: "meta-output-must-not-persist",
      accessToken: "meta-access-token-must-not-persist",
    },
    fakePiAi,
    { provider: "fake", id: "model", api: "fake-api", accessToken: "model-token-must-not-persist" },
    {
      messages: [{ role: "user", content: [{ type: "text", text: promptText }] }],
      tools: [{ name: "danger", output: toolOutput }],
    },
    {
      apiKey: "fake-key",
      accessToken: "config-access-token-must-not-persist",
      headers: { Authorization: "Bearer fake" },
    },
  );
  if (result.content[0].text !== visibleText) throw new Error("wrapper changed final message");
  const all = rows().filter((r) => r.call_id && r.operation === "fake_stream");
  const start = all.find((r) => r.row_type === "start");
  const end = all.find((r) => r.row_type === "end");
  if (!start || !end) throw new Error(`missing start/end rows: ${JSON.stringify(all)}`);
  if (start.request_shape?.messages_count !== 1 || start.request_shape?.tools_count !== 1) throw new Error(`request shape missing: ${JSON.stringify(start)}`);
  if (typeof start.request_shape?.bytes !== "number" || typeof start.config_shape?.bytes !== "number") throw new Error("request/config byte shape missing");
  if (end.final_message_shape?.content_blocks !== 3 || end.final_message_shape?.content_block_lengths?.[0]?.text_length?.chars !== visibleText.length) {
    throw new Error(`final message shape missing: ${JSON.stringify(end)}`);
  }
  if (end.usage?.totalTokens !== 3 || end.stopReason !== "stop") throw new Error(`terminal metadata missing: ${JSON.stringify(end)}`);
  for (const forbiddenKey of ["request", "opts", "config", "final_message"]) {
    if (Object.hasOwn(start, forbiddenKey) || Object.hasOwn(end, forbiddenKey)) throw new Error(`raw field persisted: ${forbiddenKey}`);
  }
  const raw = fs.readFileSync(auditFile, "utf8");
  for (const forbidden of [
    promptText, visibleText, toolOutput, "stream-thinking-must-not-persist",
    "stream-signature-must-not-persist", "stream-encrypted-payload-must-not-persist",
    "meta-prompt-must-not-persist", "meta-output-must-not-persist", "meta-access-token-must-not-persist",
    "model-token-must-not-persist", "config-access-token-must-not-persist", "fake-key", "Bearer fake",
  ]) {
    if (raw.includes(forbidden)) throw new Error(`auditStreamSimple leaked forbidden value: ${forbidden}`);
  }
});

await check("auditStreamSimple records error rows and rethrows", async () => {
  const fakePiAi = {
    streamSimple() {
      return {
        async result() {
          throw new Error("boom secret should stay in message");
        },
      };
    },
  };
  let threw = false;
  try {
    await auditStreamSimple(
      tmpRoot,
      { module: "smoke", operation: "fake_stream_error", model_ref: "fake/model" },
      fakePiAi,
      { provider: "fake", id: "model" },
      { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
      { headers: { "X-API-Key": "error-path-api-key" } },
    );
  } catch (err) {
    threw = err?.message === "boom secret should stay in message";
  }
  if (!threw) throw new Error("auditStreamSimple did not rethrow original error");
  const all = rows().filter((r) => r.call_id && r.operation === "fake_stream_error");
  const start = all.find((r) => r.row_type === "start");
  const error = all.find((r) => r.row_type === "error");
  if (!start || !error) throw new Error(`missing start/error rows: ${JSON.stringify(all)}`);
  if (typeof error.duration_ms !== "number") throw new Error(`missing duration_ms on error row: ${JSON.stringify(error)}`);
  if (error.error?.message || !error.error?.detail_length?.chars) throw new Error(`error row retained raw message or missed length shape: ${JSON.stringify(error)}`);
  const raw = fs.readFileSync(auditFile, "utf8");
  if (raw.includes("error-path-api-key") || raw.includes("boom secret should stay in message")) {
    throw new Error("error-path request credential or raw error body leaked");
  }
});

await check("auditSessionEvent message_end records shape only without final body", async () => {
  const finalText = "complete session content " + "y".repeat(3000);
  const thinking = "plaintext-thinking-must-not-persist";
  await auditSessionEvent(tmpRoot, { module: "smoke", operation: "session_event", session_scope: "test" }, {
    type: "message_end",
    message: {
      role: "assistant",
      provider: "fake-provider",
      api: "fake-api",
      model: "fake-model",
      responseId: "shape-response-id",
      stopReason: "stop",
      content: [{ type: "text", text: finalText }, { type: "thinking", thinking }],
      usage: { input: 9, output: 10 },
      thinkingSignature: "opaque-signature-must-not-persist",
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const eventRows = rows().filter((r) => r.row_type === "session_event" && r.event_type === "message_end");
  const last = eventRows.at(-1);
  if (!last) throw new Error("missing message_end audit row");
  if (last.message_shape?.role !== "assistant" || last.message_shape?.responseId !== "shape-response-id") {
    throw new Error(`message_end shape missing identity metadata: ${JSON.stringify(last)}`);
  }
  if (last.message_shape?.content_blocks !== 2 || last.message_shape?.content_types?.join(",") !== "text,thinking") {
    throw new Error(`message_end shape missing content metadata: ${JSON.stringify(last)}`);
  }
  if (last.message_shape?.content_block_lengths?.[0]?.text_length?.chars !== finalText.length) {
    throw new Error(`message_end shape missing text length: ${JSON.stringify(last)}`);
  }
  if (last.usage?.input !== 9 || last.usage?.output !== 10) throw new Error(`message_end usage missing: ${JSON.stringify(last)}`);
  for (const forbidden of ["event", "message", "assistantMessageEvent", "content", "thinkingSignature"]) {
    if (Object.hasOwn(last, forbidden)) throw new Error(`message_end retained forbidden key ${forbidden}: ${JSON.stringify(last)}`);
  }
  const raw = fs.readFileSync(auditFile, "utf8");
  for (const forbidden of [finalText, thinking, "opaque-signature-must-not-persist"]) {
    if (raw.includes(forbidden)) throw new Error(`message_end persisted forbidden body: ${forbidden.slice(0, 40)}`);
  }
});

await check("1200 deltas produce one bounded summary before terminal without raw bodies", async () => {
  _resetLlmAuditStreamStateForTests();
  _setCurrentAnchorForTests("11111111-1111-7111-8111-111111111111", 7);
  await emitStream(tmpRoot, "aggregate-1200", "aggregate-response", 1200);
  const projected = rows().filter((row) => row.operation === "aggregate-1200");
  if (projected.length !== 2) throw new Error(`expected summary+terminal only, got ${projected.length}`);
  const [summary, terminal] = projected;
  if (summary.row_type !== "session_stream_summary" || terminal.event_type !== "message_end") {
    throw new Error(`summary must precede terminal: ${JSON.stringify(projected)}`);
  }
  if (summary.event_type_counts?.message_update !== 1200 || summary.delta_stats?.total?.count !== 1200) {
    throw new Error(`wrong aggregate event count: ${JSON.stringify(summary)}`);
  }
  if (summary.delta_stats?.by_kind?.thinking_delta?.count !== 400 || summary.delta_stats?.by_kind?.text_delta?.count !== 400 || summary.delta_stats?.by_kind?.tool_delta?.count !== 400) {
    throw new Error(`wrong per-kind aggregate counts: ${JSON.stringify(summary.delta_stats)}`);
  }
  if (summary.content_index_distinct_count !== 64 || !summary.content_index_overflow || summary.content_index_overflow_count <= 0) {
    throw new Error(`content-index bound missing: ${JSON.stringify(summary)}`);
  }
  if (!summary.complete || summary.incomplete || summary.flush_reason !== "message_end") throw new Error("message_end summary completion flags are wrong");
  if (summary.session_id !== "11111111-1111-7111-8111-111111111111" || summary.turn_id !== 7) throw new Error("causal anchor missing from summary");
  if (summary.response_id !== "aggregate-response" || summary.provider !== "fake" || summary.model !== "fake-model") throw new Error("late stream identity was not merged into summary");
  const hmac = summary.delta_stats?.total?.rolling_hmac;
  if (hmac?.algorithm !== "hmac-sha256" || !/^[0-9a-f]{64}$/.test(hmac?.digest ?? "") || !hmac?.key_id) {
    throw new Error(`opaque HMAC metadata missing: ${JSON.stringify(hmac)}`);
  }
  const keyFile = path.join(tmpRoot, ".pi-astack", "llm-audit", ".audit-hmac-key");
  if (fs.statSync(keyFile).size !== 32 || (fs.statSync(keyFile).mode & 0o777) !== 0o600) throw new Error("project audit HMAC key is not a private 32-byte key");
  const raw = fs.readFileSync(auditFile, "utf8");
  for (const marker of ["thinking-raw-", "text-raw-", "tool-raw-", "cumulative-"]) {
    if (raw.includes(marker)) throw new Error(`stream summary leaked raw marker ${marker}`);
  }
  assertNoForbiddenAuditKeys(summary);
});

await check("rolling HMAC is stable for the same framed delta sequence", async () => {
  const first = rows().find((row) => row.operation === "aggregate-1200" && row.row_type === "session_stream_summary");
  _resetLlmAuditStreamStateForTests();
  await emitStream(tmpRoot, "aggregate-1200-repeat", "different-response-id", 1200);
  const second = rows().find((row) => row.operation === "aggregate-1200-repeat" && row.row_type === "session_stream_summary");
  if (!first || !second) throw new Error("missing stable-HMAC summaries");
  if (first.delta_stats.total.rolling_hmac.digest !== second.delta_stats.total.rolling_hmac.digest) {
    throw new Error("same delta sequence produced a different rolling HMAC");
  }
});

await check("LRU is capped at 256 and agent_end flushes every aggregate before terminal", async () => {
  _resetLlmAuditStreamStateForTests();
  _setCurrentAnchorForTests("22222222-2222-7222-8222-222222222222", 8);
  const meta = { module: "smoke", operation: "bounded-stream", session_scope: "test" };
  for (let index = 0; index < MAX_SESSION_STREAM_AGGREGATES + 1; index++) {
    await auditSessionEvent(tmpRoot, meta, {
      type: "message_start",
      message: { responseId: `bounded-${index}`, model: "bounded-model" },
    });
    await auditSessionEvent(tmpRoot, meta, {
      type: "message_update",
      message: { responseId: `bounded-${index}`, model: "bounded-model" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: `bounded-secret-${index}` },
    });
  }
  if (_llmAuditStreamStateSizeForTests() !== MAX_SESSION_STREAM_AGGREGATES) throw new Error("stream aggregate map exceeded its cap");
  const beforeEnd = rows().filter((row) => row.operation === "bounded-stream" && row.row_type === "session_stream_summary");
  if (beforeEnd.length !== 1 || beforeEnd[0].flush_reason !== "lru_eviction" || !beforeEnd[0].incomplete) {
    throw new Error(`expected one incomplete LRU summary: ${JSON.stringify(beforeEnd)}`);
  }
  await auditSessionEvent(tmpRoot, meta, { type: "agent_end", messages: [] });
  if (_llmAuditStreamStateSizeForTests() !== 0) throw new Error("agent_end left aggregates resident");
  const projected = rows().filter((row) => row.operation === "bounded-stream");
  const summaries = projected.filter((row) => row.row_type === "session_stream_summary");
  if (summaries.length !== MAX_SESSION_STREAM_AGGREGATES + 1) throw new Error(`wrong summary count ${summaries.length}`);
  if (projected.at(-1)?.event_type !== "agent_end") throw new Error("agent_end terminal row was not last");
  if (summaries.slice(1).some((row) => row.flush_reason !== "agent_end" || !row.incomplete || row.complete)) {
    throw new Error("agent_end summaries must be incomplete");
  }
  if (fs.readFileSync(auditFile, "utf8").includes("bounded-secret-")) throw new Error("LRU/agent_end summaries leaked deltas");
});

await check("parallel unknown streams never compatibility-merge and bounded type maps include other", async () => {
  _resetLlmAuditStreamStateForTests();
  _setCurrentAnchorForTests("44444444-4444-7444-8444-444444444444", 10);
  const meta = { module: "smoke", operation: "parallel-unknown" };
  await auditSessionEvent(tmpRoot, meta, { type: "message_start", message: { role: "assistant" } });
  await auditSessionEvent(tmpRoot, meta, { type: "message_start", message: { role: "assistant" } });
  await auditSessionEvent(tmpRoot, meta, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "ambiguous-one" } });
  await auditSessionEvent(tmpRoot, meta, { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "ambiguous-two" } });
  await auditSessionEvent(tmpRoot, meta, { type: "message_end", message: { role: "assistant" } });
  const unknown = rows().filter((row) => row.operation === "parallel-unknown" && row.row_type === "session_stream_summary");
  if (unknown.length !== 4 || new Set(unknown.map((row) => row.stream_ordinal)).size !== 4) throw new Error(`parallel unknown streams merged: ${JSON.stringify(unknown)}`);
  if (unknown.some((row) => row.complete || !row.incomplete || row.flush_reason !== "message_end_ambiguous")) throw new Error("ambiguous terminal marked a stream complete");
  const deltaSummaries = unknown.filter((row) => row.delta_stats.total.count > 0);
  if (deltaSummaries.length !== 2 || deltaSummaries.some((row) => row.delta_stats.total.count !== 1 || !row.orphan)) throw new Error("ambiguous updates did not become independent orphans");

  _resetLlmAuditStreamStateForTests();
  const capMeta = { module: "smoke", operation: "type-cap" };
  await auditSessionEvent(tmpRoot, capMeta, { type: "message_start", message: { responseId: "cap" } });
  for (let index = 0; index < 80; index++) {
    await auditSessionEvent(tmpRoot, capMeta, { type: "message_update", message: { responseId: "cap" }, assistantMessageEvent: { type: `custom_${index}`, delta: "x" } });
  }
  await auditSessionEvent(tmpRoot, capMeta, { type: "message_end", message: { responseId: "cap" } });
  const capped = rows().find((row) => row.operation === "type-cap" && row.row_type === "session_stream_summary");
  if (!capped || Object.keys(capped.type_counts).length !== 32 || !capped.type_counts.other) throw new Error(`type map did not reserve other inside cap: ${JSON.stringify(capped?.type_counts)}`);
});

await check("duplicate responseId ambiguity flushes associated orphans at message_end", async () => {
  _resetLlmAuditStreamStateForTests();
  _setCurrentAnchorForTests("55555555-5555-7555-8555-555555555555", 11);
  const meta = { module: "smoke", operation: "duplicate-response-orphan" };
  await auditSessionEvent(tmpRoot, meta, { type: "message_start", message: { responseId: "duplicate-id" } });
  await auditSessionEvent(tmpRoot, meta, { type: "message_start", message: { responseId: "duplicate-id" } });
  await auditSessionEvent(tmpRoot, meta, { type: "message_update", message: { responseId: "duplicate-id" }, assistantMessageEvent: { type: "text_delta", delta: "ambiguous-duplicate" } });
  assert.equal(_llmAuditStreamStateSizeForTests(), 3);
  await auditSessionEvent(tmpRoot, meta, { type: "message_end", message: { responseId: "duplicate-id" } });
  assert.equal(_llmAuditStreamStateSizeForTests(), 0, "message_end left a duplicate-response orphan for agent_end");
  const summaries = rows().filter((row) => row.operation === "duplicate-response-orphan" && row.row_type === "session_stream_summary");
  assert.equal(summaries.length, 3);
  assert(summaries.every((row) => row.incomplete && !row.complete && row.flush_reason === "message_end_ambiguous"));
  assert.equal(summaries.filter((row) => row.orphan && row.delta_stats.total.count === 1).length, 1);
});

await check("weak and symlink HMAC keys fail open ephemerally while strict use rejects", async () => {
  for (const [label, bytes] of [
    ["zero", Buffer.alloc(32)],
    ["repeated", Buffer.alloc(32, 0x5a)],
    ["low-unique", Buffer.from(Array.from({ length: 32 }, (_, index) => index % 4))],
    ["period-16", Buffer.from(Array.from({ length: 32 }, (_, index) => index % 16))],
    ["monotonic", Buffer.from(Array.from({ length: 32 }, (_, index) => index))],
  ]) {
    const root = path.join(tmpRoot, `weak-key-${label}`);
    const sink = path.join(root, ".pi-astack", "llm-audit");
    fs.mkdirSync(sink, { recursive: true, mode: 0o700 });
    const keyFile = path.join(sink, ".audit-hmac-key");
    fs.writeFileSync(keyFile, bytes, { mode: 0o600 });
    _resetAuditHmacCachesForTests();
    const fallback = auditHmacHex(root, "smoke", "value");
    if (!fallback.key_id.startsWith("ephemeral-")) throw new Error(`${label} weak key was accepted`);
    let strictRejected = false;
    try { auditHmacHexStrict(root, "smoke", "value"); } catch { strictRejected = true; }
    if (!strictRejected || !fs.readFileSync(keyFile).equals(bytes)) throw new Error(`${label} strict key handling mutated or accepted weak material`);
  }
  const root = path.join(tmpRoot, "symlink-key");
  const sink = path.join(root, ".pi-astack", "llm-audit");
  const external = path.join(tmpRoot, "external-hmac-key");
  fs.mkdirSync(sink, { recursive: true, mode: 0o700 });
  fs.writeFileSync(external, Buffer.alloc(32, 0x33), { mode: 0o644 });
  fs.symlinkSync(external, path.join(sink, ".audit-hmac-key"));
  _resetAuditHmacCachesForTests();
  if (!auditHmacHex(root, "smoke", "value").key_id.startsWith("ephemeral-")) throw new Error("symlink key did not fail open ephemerally");
  if ((fs.statSync(external).mode & 0o777) !== 0o644) throw new Error("external symlink target permissions were changed");

  for (const part of ["module", "sink"]) {
    const dirRoot = path.join(tmpRoot, `symlink-${part}-directory`);
    const outside = path.join(tmpRoot, `external-${part}-directory`);
    fs.mkdirSync(dirRoot, { mode: 0o700 });
    fs.mkdirSync(outside, { mode: 0o755 });
    if (part === "module") fs.symlinkSync(outside, path.join(dirRoot, ".pi-astack"));
    else {
      fs.mkdirSync(path.join(dirRoot, ".pi-astack"), { mode: 0o700 });
      fs.symlinkSync(outside, path.join(dirRoot, ".pi-astack", "llm-audit"));
    }
    _resetAuditHmacCachesForTests();
    if (!auditHmacHex(dirRoot, "smoke", "value").key_id.startsWith("ephemeral-")) throw new Error(`${part} directory symlink was accepted`);
    if ((fs.statSync(outside).mode & 0o777) !== 0o755 || fs.readdirSync(outside).length !== 0) throw new Error(`${part} directory symlink target was modified`);
  }

  for (const [label, target] of [["module-mode", ".pi-astack"], ["sink-mode", path.join(".pi-astack", "llm-audit")]]) {
    const modeRoot = path.join(tmpRoot, `unsafe-${label}`);
    const sink = path.join(modeRoot, ".pi-astack", "llm-audit");
    fs.mkdirSync(sink, { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(modeRoot, target), 0o755);
    _resetAuditHmacCachesForTests();
    if (!auditHmacHex(modeRoot, "smoke", "value").key_id.startsWith("ephemeral-")) throw new Error(`${label} was accepted`);
    if ((fs.statSync(path.join(modeRoot, target)).mode & 0o777) !== 0o755) throw new Error(`${label} was automatically chmodded`);
  }

  const modeKeyRoot = path.join(tmpRoot, "unsafe-key-mode");
  const modeKeySink = path.join(modeKeyRoot, ".pi-astack", "llm-audit");
  fs.mkdirSync(modeKeySink, { recursive: true, mode: 0o700 });
  const modeKeyFile = path.join(modeKeySink, ".audit-hmac-key");
  const modeKeyBytes = randomBytes(32);
  fs.writeFileSync(modeKeyFile, modeKeyBytes, { mode: 0o644 });
  _resetAuditHmacCachesForTests();
  if (!auditHmacHex(modeKeyRoot, "smoke", "value").key_id.startsWith("ephemeral-")) throw new Error("0644 key was accepted");
  if ((fs.statSync(modeKeyFile).mode & 0o777) !== 0o644 || !fs.readFileSync(modeKeyFile).equals(modeKeyBytes)) throw new Error("unsafe existing key was modified");
});

await check("append failures remain fail-open for stream aggregation", async () => {
  _resetLlmAuditStreamStateForTests();
  _setCurrentAnchorForTests("33333333-3333-7333-8333-333333333333", 9);
  const badRoot = path.join(tmpRoot, "append-fail-open");
  fs.mkdirSync(badRoot);
  fs.writeFileSync(path.join(badRoot, ".pi-astack"), "blocks audit directory");
  const meta = { module: "smoke", operation: "fail-open" };
  await auditSessionEvent(badRoot, meta, {
    type: "message_update",
    message: { responseId: "fail-open-response", model: "fake" },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "business-must-continue" },
  });
  await auditSessionEvent(badRoot, meta, { type: "agent_end", messages: [] });
  if (_llmAuditStreamStateSizeForTests() !== 0) throw new Error("failed append retained aggregate state");
});

await check("provider boundary events record payload/header shape only", async () => {
  await auditProviderBoundaryEvent(tmpRoot, { module: "smoke", operation: "provider_request" }, {
    type: "before_provider_request",
    payload: {
      model: "fake-model",
      messages: [{ role: "user", content: "provider payload text must not persist" }],
      tools: [{ name: "tool", output: "tool output must not persist" }],
      headers: { Authorization: "Bearer nested-secret", "X-Trace-Id": "provider-trace" },
    },
  }, { model: { provider: "fake", id: "fake-model", api: "chat" } });
  await auditProviderBoundaryEvent(tmpRoot, { module: "smoke", operation: "provider_response" }, {
    type: "after_provider_response",
    status: 200,
    headers: { "x-request-id": "provider-request-id", "set-cookie": "cookie-secret" },
    usage: { input: 1, output: 2, totalTokens: 3 },
  }, { model: { provider: "fake", id: "fake-model", api: "chat" } });

  const all = rows().filter((r) => r.row_type === "provider_event");
  const request = all.find((r) => r.operation === "provider_request");
  const response = all.find((r) => r.operation === "provider_response");
  if (!request || !response) throw new Error(`missing provider event rows: ${JSON.stringify(all)}`);
  if (request.request_payload_shape?.model !== "fake-model" || request.request_payload_shape?.messages_count !== 1) {
    throw new Error(`provider request shape missing: ${JSON.stringify(request)}`);
  }
  if (request.request_payload_shape?.tools_count !== 1 || typeof request.request_payload_shape?.payload_bytes !== "number") {
    throw new Error(`provider request byte/tool shape missing: ${JSON.stringify(request)}`);
  }
  if (request.model?.provider !== "fake" || request.model?.id !== "fake-model") throw new Error("provider model metadata missing");
  if (request.request_payload || request.event || request.response_headers) throw new Error(`provider request retained raw fields: ${JSON.stringify(request)}`);
  if (response.response_status !== 200 || response.response_headers_shape?.non_sensitive_header_names?.[0] !== "x-request-id") {
    throw new Error(`provider response metadata missing: ${JSON.stringify(response)}`);
  }
  if (response.usage?.totalTokens !== 3) throw new Error(`provider usage shape missing: ${JSON.stringify(response)}`);
  const raw = fs.readFileSync(auditFile, "utf8");
  for (const forbidden of [
    "provider payload text must not persist",
    "tool output must not persist",
    "Bearer nested-secret",
    "cookie-secret",
    "provider-trace",
    "provider-request-id",
  ]) {
    if (raw.includes(forbidden)) throw new Error(`provider event persisted forbidden value: ${forbidden}`);
  }
});

await check("embedding audit records only counts, dimensions, bytes, and usage", async () => {
  const oldFetch = globalThis.fetch;
  const oldCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.input?.[0] !== "embedding audit text") throw new Error(`bad embedding request body: ${JSON.stringify(body)}`);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { input: 3, totalTokens: 3 } }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "emb-smoke" },
      });
    };
    const vecs = await embedTexts(["embedding audit text"], {
      baseUrl: "https://embedding.example/v1",
      apiKey: "embedding-api-key",
      model: "embedding-model",
      dim: 2,
      batchSize: 1,
      tpmLimit: 1_000_000,
      timeoutMs: 1000,
      maxRetries: 0,
      multiVector: false,
      multiVectorMaxChunks: 1,
    });
    if (vecs.length !== 1 || vecs[0][1] !== 0.2) throw new Error(`bad embedding vectors: ${JSON.stringify(vecs)}`);
  } finally {
    globalThis.fetch = oldFetch;
    process.chdir(oldCwd);
  }
  const all = rows().filter((r) => r.operation === "embedding" && r.api_kind === "openai.embeddings");
  const start = all.find((r) => r.row_type === "start");
  const end = all.find((r) => r.row_type === "end");
  if (!start || !end) throw new Error(`missing embedding audit rows: ${JSON.stringify(all)}`);
  if (start.input_count !== 1 || start.total_input_chars !== "embedding audit text".length || start.max_input_chars !== "embedding audit text".length) {
    throw new Error(`embedding input shape missing: ${JSON.stringify(start)}`);
  }
  if (end.vector_count !== 1 || end.dimension !== 2 || end.response_bytes <= 0 || end.usage?.totalTokens !== 3) {
    throw new Error(`embedding response shape missing: ${JSON.stringify(end)}`);
  }
  const raw = fs.readFileSync(auditFile, "utf8");
  for (const forbidden of ["embedding audit text", "embedding-api-key", "https://embedding.example/v1", "[0.1,0.2]"]) {
    if (raw.includes(forbidden)) throw new Error(`embedding audit leaked forbidden value: ${forbidden}`);
  }
  for (const row of all) assertNoForbiddenAuditKeys(row);
});

await check("all emitted audit rows satisfy the generic forbidden-key contract", async () => {
  for (const row of rows()) assertNoForbiddenAuditKeys(row);
});

if (fail) {
  console.error(`llm-audit smoke failed: ${fail}/${pass + fail}`);
  process.exit(1);
}
console.log(`llm-audit smoke passed: ${pass}/${pass + fail}`);
