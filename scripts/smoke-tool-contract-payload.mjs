#!/usr/bin/env node
/**
 * Smoke: tool-contract payload injection + protocol mismatch detection.
 *
 * Locks the downstream final_answer + tool_choice contract:
 *   - OpenAI Responses / Chat Completions get tool_choice:"required"
 *   - Anthropic Messages gets tool_choice:{type:"any"}; when Anthropic
 *     thinking is enabled, it degrades to {type:"auto"} to avoid provider 400s
 *   - Injection only happens when final_answer is actually in the tools list
 *   - The mismatch detector only matches closed protocol tags, not
 *     natural-language intent keywords.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;

function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function compileTsModule(srcPath, outPath) {
  const src = fs.readFileSync(srcPath, "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      skipLibCheck: true,
    },
    fileName: srcPath,
  });
  fs.writeFileSync(outPath, out.outputText, "utf8");
}

console.log("Smoke: tool-contract payload contract\n");

const payloadSrcPath = path.join(repoRoot, "extensions/tool-contract/payload.ts");
const indexSrcPath = path.join(repoRoot, "extensions/tool-contract/index.ts");
const settingsSrcPath = path.join(repoRoot, "extensions/tool-contract/settings.ts");
const schemaPath = path.join(repoRoot, "pi-astack-settings.schema.json");
const packagePath = path.join(repoRoot, "package.json");

const payloadSrc = fs.readFileSync(payloadSrcPath, "utf8");
const indexSrc = fs.readFileSync(indexSrcPath, "utf8");
const settingsSrc = fs.readFileSync(settingsSrcPath, "utf8");
const schemaSrc = fs.readFileSync(schemaPath, "utf8");
const packageSrc = fs.readFileSync(packagePath, "utf8");

console.log("source anchors:");

check("final_answer terminating tool is registered", () => {
  if (!/name:\s*FINAL_ANSWER_TOOL_NAME/.test(indexSrc)) throw new Error("final_answer tool name anchor missing");
  if (!/terminate:\s*true/.test(indexSrc)) throw new Error("final_answer must set terminate:true");
  if (!/pi\.registerTool\(finalAnswerTool\)/.test(indexSrc)) throw new Error("finalAnswerTool registration missing");
});

check("before_provider_request hook injects via shared payload helper", () => {
  if (!/pi\.on\("before_provider_request"/.test(indexSrc)) throw new Error("before_provider_request hook missing");
  if (!/injectToolChoiceIntoPayload\(event\.payload/.test(indexSrc)) throw new Error("payload injection helper not used");
});

check("tool-contract and sub-agent path are gated off by default", () => {
  if (!/enabled:\s*false/.test(settingsSrc)) throw new Error("enabled default must be false");
  if (!schemaSrc.includes('"default": false')) throw new Error("schema enabled default must include false");
  if (!/disableForSubAgent/.test(settingsSrc)) throw new Error("disableForSubAgent setting missing");
  if (!/disableForSubAgent:\s*true/.test(settingsSrc)) throw new Error("disableForSubAgent default must be true");
  if (!/isSubAgentSession\(ctx\)/.test(indexSrc)) throw new Error("isSubAgentSession guard missing");
});

check("mismatch detector does not contain natural-language intent keywords", () => {
  const forbidden = ["需要", "想要", "should", "need to", "want to", "use a tool", "call a tool"];
  for (const needle of forbidden) {
    if (payloadSrc.includes(needle)) {
      throw new Error(`natural-language intent keyword found in detector source: ${needle}`);
    }
  }
  if (!/PROTOCOL_MARKER_RE/.test(payloadSrc)) throw new Error("closed protocol marker regex anchor missing");
});

check("schema and npm script expose toolContract smoke", () => {
  if (!schemaSrc.includes('"toolContract"')) throw new Error("toolContract schema section missing");
  if (!packageSrc.includes('"smoke:tool-contract"')) throw new Error("smoke:tool-contract package script missing");
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-tool-contract-"));
const compiledPayload = path.join(tmpDir, "payload.cjs");
compileTsModule(payloadSrcPath, compiledPayload);
const payload = require(compiledPayload);

function responsesPayload(extra = {}) {
  return {
    model: "provider-a/model-a",
    input: [],
    stream: true,
    tools: [
      { type: "function", name: "read", description: "read", parameters: { type: "object" } },
      { type: "function", name: "final_answer", description: "finish", parameters: { type: "object" } },
    ],
    ...extra,
  };
}

function completionsPayload(extra = {}) {
  return {
    model: "provider-b/model-b",
    messages: [],
    stream: true,
    tools: [
      { type: "function", function: { name: "read", description: "read", parameters: { type: "object" } } },
      { type: "function", function: { name: "final_answer", description: "finish", parameters: { type: "object" } } },
    ],
    ...extra,
  };
}

function anthropicPayload(extra = {}) {
  return {
    model: "provider-c/model-c",
    system: [{ type: "text", text: "sys" }],
    messages: [],
    stream: true,
    tools: [
      { name: "read", description: "read", input_schema: { type: "object", properties: {}, required: [] } },
      { name: "final_answer", description: "finish", input_schema: { type: "object", properties: {}, required: ["summary"] } },
    ],
    ...extra,
  };
}

console.log("\nruntime payload checks:");

check("OpenAI Responses payload gets tool_choice required", () => {
  const result = payload.injectToolChoiceIntoPayload(responsesPayload(), { modelApi: "openai-responses" });
  if (!result.injected) throw new Error(`not injected: ${JSON.stringify(result)}`);
  if (result.payload.tool_choice !== "required") throw new Error(`wrong tool_choice: ${JSON.stringify(result.payload.tool_choice)}`);
});

check("OpenAI Chat Completions / DeepSeek payload gets tool_choice required", () => {
  const result = payload.injectToolChoiceIntoPayload(completionsPayload(), { modelApi: "openai-completions" });
  if (!result.injected) throw new Error(`not injected: ${JSON.stringify(result)}`);
  if (result.payload.tool_choice !== "required") throw new Error(`wrong tool_choice: ${JSON.stringify(result.payload.tool_choice)}`);
});

check("Anthropic Messages payload gets tool_choice any when thinking is absent", () => {
  const result = payload.injectToolChoiceIntoPayload(anthropicPayload(), { modelApi: "anthropic-messages" });
  if (!result.injected) throw new Error(`not injected: ${JSON.stringify(result)}`);
  if (JSON.stringify(result.payload.tool_choice) !== JSON.stringify({ type: "any" })) {
    throw new Error(`wrong tool_choice: ${JSON.stringify(result.payload.tool_choice)}`);
  }
});

check("Anthropic Messages payload gets tool_choice auto when thinking is enabled", () => {
  const p = anthropicPayload({ thinking: { type: "adaptive", display: "summarized" } });
  const result = payload.injectToolChoiceIntoPayload(p, { modelApi: "anthropic-messages" });
  if (!result.injected) throw new Error(`not injected: ${JSON.stringify(result)}`);
  if (JSON.stringify(result.payload.tool_choice) !== JSON.stringify({ type: "auto" })) {
    throw new Error(`wrong tool_choice: ${JSON.stringify(result.payload.tool_choice)}`);
  }
  if (result.reason !== "anthropic_thinking_auto") throw new Error(`wrong reason: ${result.reason}`);
});

check("provider is inferred from payload shape when model api is absent", () => {
  const a = payload.injectToolChoiceIntoPayload(anthropicPayload());
  const r = payload.injectToolChoiceIntoPayload(responsesPayload());
  const c = payload.injectToolChoiceIntoPayload(completionsPayload());
  if (a.provider !== "anthropic-messages") throw new Error(`anthropic inference failed: ${a.provider}`);
  if (r.provider !== "openai-responses") throw new Error(`responses inference failed: ${r.provider}`);
  if (c.provider !== "openai-completions") throw new Error(`completions inference failed: ${c.provider}`);
});

check("no final_answer tool means no injection", () => {
  const p = responsesPayload({ tools: [{ type: "function", name: "read", parameters: { type: "object" } }] });
  const result = payload.injectToolChoiceIntoPayload(p, { modelApi: "openai-responses" });
  if (result.injected) throw new Error("injected without final_answer");
  if (result.reason !== "final_answer_not_available") throw new Error(`wrong reason: ${result.reason}`);
});

check("ambiguous mixed tool shapes are not guessed into a provider", () => {
  const p = {
    model: "mixed",
    messages: [],
    stream: true,
    tools: [
      { name: "final_answer", description: "finish", input_schema: { type: "object" } },
      { type: "function", function: { name: "final_answer", parameters: { type: "object" } } },
    ],
  };
  const result = payload.injectToolChoiceIntoPayload(p);
  if (result.injected) throw new Error(`ambiguous mixed shape should not inject: ${JSON.stringify(result)}`);
  if (result.reason !== "unsupported_provider") throw new Error(`wrong reason: ${result.reason}`);
});

check("chat-completions function.name wins over conflicting top-level name", () => {
  const p = completionsPayload({
    tools: [
      {
        type: "function",
        name: "not_final_answer",
        function: { name: "final_answer", description: "finish", parameters: { type: "object" } },
      },
    ],
  });
  const result = payload.injectToolChoiceIntoPayload(p, { modelApi: "openai-completions" });
  if (!result.injected) throw new Error(`function.name final_answer should inject: ${JSON.stringify(result)}`);
  if (result.payload.tool_choice !== "required") throw new Error(`wrong tool_choice: ${JSON.stringify(result.payload.tool_choice)}`);
});

console.log("\nprotocol mismatch checks:");

check("bare <invoke> assistant text without real toolCall is flagged", () => {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: "<invoke name=\"read\">{}</invoke>" }],
  };
  const mismatch = payload.detectProtocolMarkupMismatch(msg);
  if (!mismatch.detected) throw new Error("expected mismatch");
  if (!mismatch.markers.some((m) => /invoke/i.test(m))) throw new Error(`missing invoke marker: ${JSON.stringify(mismatch.markers)}`);
});

check("real toolCall suppresses textual marker alarm", () => {
  const msg = {
    role: "assistant",
    content: [
      { type: "text", text: "debug mention <invoke>" },
      { type: "toolCall", id: "1", name: "read", arguments: { path: "x" } },
    ],
  };
  const mismatch = payload.detectProtocolMarkupMismatch(msg);
  if (mismatch.detected) throw new Error(`unexpected mismatch: ${JSON.stringify(mismatch)}`);
});

check("natural language saying a tool is needed is not flagged", () => {
  const msg = {
    role: "assistant",
    content: [{ type: "text", text: "I should inspect the file before answering." }],
  };
  const mismatch = payload.detectProtocolMarkupMismatch(msg);
  if (mismatch.detected) throw new Error(`natural language was flagged: ${JSON.stringify(mismatch)}`);
});

console.log();
if (failures.length === 0) {
  console.log(`all ok — tool-contract payload invariants hold (${total} checks).`);
  process.exit(0);
}

console.error(`FAILED — ${failures.length}/${total} checks failed`);
for (const failure of failures) {
  console.error(`\n[${failure.name}]`);
  console.error(failure.err?.stack ?? failure.err?.message ?? String(failure.err));
}
process.exit(1);
