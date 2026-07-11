#!/usr/bin/env node
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
} = jiti(path.join(repoRoot, "extensions/_shared/llm-audit.ts"));
const { embedTexts } = jiti(path.join(repoRoot, "extensions/memory/embedding.ts"));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-llm-audit-"));
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

async function writeGenericGrowingProjection(count) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-llm-audit-growth-"));
  const file = path.join(root, ".pi-astack", "llm-audit", "audit.jsonl");
  let partial = "";
  for (let i = 0; i < count; i++) {
    partial += "x";
    auditSessionEvent(root, { module: "smoke", operation: "growth", session_scope: "test" }, {
      type: "message_update",
      message: {
        role: "assistant",
        responseId: `growth-${count}`,
        content: [{ type: "thinking", thinking: `cumulative-secret-${partial}` }],
      },
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "x",
      },
    });
  }
  const projectedRows = await waitForJsonlRows(file, count);
  return { raw: fs.readFileSync(file, "utf8"), rows: projectedRows };
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

await check("apiKey and sensitive headers are redacted", async () => {
  await appendLlmAudit(tmpRoot, {
    row_type: "manual",
    module: "smoke",
    operation: "redact",
    request: {
      config: {
        apiKey: "sk-secret",
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
  ].filter((secret) => raw.includes(secret));
  if (leaked.length > 0) throw new Error(`secret leaked into audit log: ${leaked.join(", ")}: ${raw}`);
  if (!raw.includes("keep-me")) throw new Error("non-sensitive header should be preserved");
  if (!raw.includes("ordinary-key-value")) throw new Error("ordinary Key header should be preserved");
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
  if (error.error?.message || !error.error?.message_length?.chars) throw new Error(`error row retained raw message or missed length shape: ${JSON.stringify(error)}`);
  const raw = fs.readFileSync(auditFile, "utf8");
  if (raw.includes("error-path-api-key") || raw.includes("boom secret should stay in message")) {
    throw new Error("error-path request credential or raw error body leaked");
  }
});

await check("auditSessionEvent message_end records shape only without final body", async () => {
  const finalText = "complete session content " + "y".repeat(3000);
  const thinking = "plaintext-thinking-must-not-persist";
  auditSessionEvent(tmpRoot, { module: "smoke", operation: "session_event", session_scope: "test" }, {
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

await check("auditSessionEvent message_update records shape only without cumulative partial or raw delta", async () => {
  const rawDelta = "generic-raw-delta-must-not-persist";
  const partialMarker = "generic-growing-partial-must-not-persist";
  auditSessionEvent(tmpRoot, { module: "smoke", operation: "session_event", session_scope: "test" }, {
    type: "message_update",
    message: {
      role: "assistant",
      responseId: "generic-response-id",
      content: [{ type: "thinking", thinking: partialMarker }],
    },
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 3,
      delta: rawDelta,
      partial: {
        role: "assistant",
        responseId: "generic-response-id",
        content: [{ type: "thinking", thinking: partialMarker }],
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const eventRows = rows().filter((r) => r.row_type === "session_event" && r.event_type === "message_update");
  const last = eventRows.at(-1);
  if (!last) throw new Error("missing message_update audit row");
  if (last.assistant_event_type !== "thinking_delta") throw new Error(`missing delta shape: ${JSON.stringify(last)}`);
  if (last.delta_chars !== rawDelta.length || last.delta_bytes !== Buffer.byteLength(rawDelta)) {
    throw new Error(`wrong delta lengths: ${JSON.stringify(last)}`);
  }
  if (last.content_index !== 3 || last.response_id !== "generic-response-id") {
    throw new Error(`missing response/content metadata: ${JSON.stringify(last)}`);
  }
  for (const forbidden of ["event", "message", "assistantMessageEvent", "partial", "delta"]) {
    if (Object.hasOwn(last, forbidden)) throw new Error(`message_update retained forbidden key ${forbidden}: ${JSON.stringify(last)}`);
  }
  const raw = fs.readFileSync(auditFile, "utf8");
  if (raw.includes(rawDelta) || raw.includes(partialMarker)) {
    throw new Error("message_update persisted raw delta or cumulative partial body");
  }
});

await check("generic message_update projection stays linear as cumulative partial grows", async () => {
  const small = await writeGenericGrowingProjection(80);
  const large = await writeGenericGrowingProjection(160);
  if (small.rows.length !== 80 || large.rows.length !== 160) {
    throw new Error(`wrong generic growth row counts: ${small.rows.length}/${large.rows.length}`);
  }
  const ratio = large.raw.length / small.raw.length;
  if (ratio >= 2.2) throw new Error(`generic audit growth is not linear: ratio=${ratio}`);
  if (small.raw.includes("cumulative-secret") || large.raw.includes("cumulative-secret")) {
    throw new Error("generic projection retained cumulative partial content");
  }
  for (const row of [...small.rows, ...large.rows]) {
    if (Object.hasOwn(row, "event") || Object.hasOwn(row, "message") || Object.hasOwn(row, "assistantMessageEvent") || Object.hasOwn(row, "delta")) {
      throw new Error(`generic projection retained a raw event field: ${JSON.stringify(row)}`);
    }
  }
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

await check("embedding fetch records request and raw response", async () => {
  const oldFetch = globalThis.fetch;
  const oldCwd = process.cwd();
  try {
    process.chdir(tmpRoot);
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body.input?.[0] !== "embedding audit text") throw new Error(`bad embedding request body: ${JSON.stringify(body)}`);
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2] }] }), {
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
  if (start.request_body?.input?.[0] !== "embedding audit text") throw new Error("embedding input missing from audit start row");
  if (!String(end.raw_response_text || "").includes("0.2")) throw new Error("embedding raw response missing from audit end row");
  const raw = fs.readFileSync(auditFile, "utf8");
  if (raw.includes("embedding-api-key")) throw new Error("embedding audit leaked API key");
});

if (fail) {
  console.error(`llm-audit smoke failed: ${fail}/${pass + fail}`);
  process.exit(1);
}
console.log(`llm-audit smoke passed: ${pass}/${pass + fail}`);
