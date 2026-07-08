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

await check("auditStreamSimple records start/end and full final message", async () => {
  const fullText = "完整 final message\n" + "x".repeat(5000);
  const fakePiAi = {
    streamSimple(model, opts, config) {
      return {
        async result() {
          return {
            stopReason: "stop",
            usage: { input: 1, output: 2, totalTokens: 3 },
            content: [{ type: "text", text: fullText }],
          };
        },
      };
    },
  };
  const result = await auditStreamSimple(
    tmpRoot,
    { module: "smoke", operation: "fake_stream", model_ref: "fake/model" },
    fakePiAi,
    { provider: "fake", id: "model" },
    { messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] },
    { apiKey: "fake-key", headers: { Authorization: "Bearer fake" } },
  );
  if (result.content[0].text !== fullText) throw new Error("wrapper changed final message");
  const all = rows().filter((r) => r.call_id && r.operation === "fake_stream");
  const start = all.find((r) => r.row_type === "start");
  const end = all.find((r) => r.row_type === "end");
  if (!start || !end) throw new Error(`missing start/end rows: ${JSON.stringify(all)}`);
  if (end.final_message?.content?.[0]?.text !== fullText) throw new Error("final message was truncated or changed");
  const raw = fs.readFileSync(auditFile, "utf8");
  if (raw.includes("fake-key") || raw.includes("Bearer fake")) throw new Error("auditStreamSimple leaked credentials");
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
  const raw = fs.readFileSync(auditFile, "utf8");
  if (raw.includes("error-path-api-key")) throw new Error("error-path request header leaked credentials");
});

await check("auditSessionEvent records message_end complete content", async () => {
  const content = [{ type: "text", text: "complete session content " + "y".repeat(3000) }];
  auditSessionEvent(tmpRoot, { module: "smoke", operation: "session_event", session_scope: "test" }, {
    type: "message_end",
    message: { role: "assistant", content, usage: { input: 9, output: 10 } },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const eventRows = rows().filter((r) => r.row_type === "session_event" && r.event_type === "message_end");
  const last = eventRows.at(-1);
  if (!last) throw new Error("missing message_end audit row");
  if (last.message?.content?.[0]?.text !== content[0].text) throw new Error("message_end content was not preserved");
});

await check("provider boundary events record request payload and response headers", async () => {
  await auditProviderBoundaryEvent(tmpRoot, { module: "smoke", operation: "provider_request" }, {
    type: "before_provider_request",
    payload: {
      model: "fake-model",
      messages: [{ role: "user", content: "provider payload text" }],
      headers: { Authorization: "Bearer nested-secret", "X-Trace-Id": "provider-trace" },
    },
  }, { model: { provider: "fake", id: "fake-model", api: "chat" } });
  await auditProviderBoundaryEvent(tmpRoot, { module: "smoke", operation: "provider_response" }, {
    type: "after_provider_response",
    status: 200,
    headers: { "x-request-id": "provider-request-id", "set-cookie": "cookie-secret" },
  }, { model: { provider: "fake", id: "fake-model", api: "chat" } });

  const all = rows().filter((r) => r.row_type === "provider_event");
  const request = all.find((r) => r.operation === "provider_request");
  const response = all.find((r) => r.operation === "provider_response");
  if (!request || !response) throw new Error(`missing provider event rows: ${JSON.stringify(all)}`);
  if (request.request_payload?.messages?.[0]?.content !== "provider payload text") throw new Error("provider request payload missing");
  if (request.model?.provider !== "fake" || request.model?.id !== "fake-model") throw new Error("provider model metadata missing");
  if (response.response_status !== 200 || response.response_headers?.["x-request-id"] !== "provider-request-id") throw new Error("provider response metadata missing");
  const raw = fs.readFileSync(auditFile, "utf8");
  if (raw.includes("Bearer nested-secret") || raw.includes("cookie-secret")) throw new Error("provider event leaked sensitive headers");
  if (!raw.includes("provider-trace")) throw new Error("provider event dropped non-sensitive header");
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
