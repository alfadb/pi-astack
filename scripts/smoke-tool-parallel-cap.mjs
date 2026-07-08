#!/usr/bin/env node
/**
 * smoke-tool-parallel-cap — verify the tool-parallel-cap pure helpers.
 *
 * What this asserts:
 *   1. isAnthropicMessagesShape() rejects non-objects, OpenAI Responses
 *      (has `input` array), and missing required fields.
 *   2. shouldCapForPayload() gates on model substring (ctx OR payload.model),
 *      tools array non-empty, tool_choice !== "none", sub-agent guard.
 *   3. applyParallelCap() preserves existing tool_choice fields while
 *      adding disable_parallel_tool_use:true.
 *   4. Env override PI_ASTACK_PARALLEL_CAP_MODELS works.
 *
 * Loads .ts via jiti; no pi runtime needed.
 */

import { createRequire } from "node:module";
import * as path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`); }
}

const cap = jiti(path.join(repoRoot, "extensions/tool-parallel-cap/index.ts"));
const {
  isAnthropicMessagesShape,
  shouldCapForPayload,
  applyParallelCap,
  readTargetModelSubstrings,
  DEFAULT_TARGETS,
  modelIdFromCtx,
  modelApiFromCtx,
} = cap.__TEST;

// ─── basic shape detection ──────────────────────────────────────────
console.log("[1] isAnthropicMessagesShape");
{
  check("null → false", !isAnthropicMessagesShape(null));
  check("string → false", !isAnthropicMessagesShape("hi"));
  check("array → false", !isAnthropicMessagesShape([]));
  check("missing model → false", !isAnthropicMessagesShape({ messages: [] }));
  check("missing messages → false", !isAnthropicMessagesShape({ model: "x" }));
  check("model + messages → true", isAnthropicMessagesShape({ model: "x", messages: [] }));
  check("openai-responses (has input) → false", !isAnthropicMessagesShape({ model: "x", messages: [], input: [] }));
}

// ─── gate logic ─────────────────────────────────────────────────────
console.log("[2] shouldCapForPayload");
{
  const anthroTool = { name: "edit", input_schema: { type: "object" } };
  const base = {
    model: "provider/model-a",
    messages: [{ role: "user", content: "hi" }],
    tools: [anthroTool],
  };
  check("matching modelId via payload.model → true", shouldCapForPayload(base, undefined, ["model-a"]) === true);
  check("matching modelId via ctx → true", shouldCapForPayload({ ...base, model: "other" }, "provider/model-a", ["model-a"]) === true);
  check("no model match → false", shouldCapForPayload({ ...base, model: "model-b" }, "provider/model-b", ["model-a"]) === false);
  check("empty tools → false", shouldCapForPayload({ ...base, tools: [] }, undefined, ["model-a"]) === false);
  check("missing tools → false", shouldCapForPayload({ model: base.model, messages: base.messages }, undefined, ["model-a"]) === false);
  check("tool_choice none → false", shouldCapForPayload({ ...base, tool_choice: { type: "none" } }, undefined, ["model-a"]) === false);
  check("tool_choice auto → true (we augment)", shouldCapForPayload({ ...base, tool_choice: { type: "auto" } }, undefined, ["model-a"]) === true);
  check("tool_choice any → true (we augment)", shouldCapForPayload({ ...base, tool_choice: { type: "any" } }, undefined, ["model-a"]) === true);
  check("multiple targets, last matches → true", shouldCapForPayload(base, undefined, ["model-z", "model-a"]) === true);
}

// ─── pure mutation ──────────────────────────────────────────────────
console.log("[3] applyParallelCap");
{
  const noTC = { model: "x", messages: [], tools: [] };
  const r1 = applyParallelCap(noTC);
  check("noTC: tool_choice created with type auto", r1.tool_choice?.type === "auto");
  check("noTC: disable flag set", r1.tool_choice?.disable_parallel_tool_use === true);
  check("noTC: original payload not mutated", noTC.tool_choice === undefined);

  const autoTC = { model: "x", messages: [], tools: [], tool_choice: { type: "auto" } };
  const r2 = applyParallelCap(autoTC);
  check("autoTC: type preserved", r2.tool_choice.type === "auto");
  check("autoTC: disable flag added", r2.tool_choice.disable_parallel_tool_use === true);

  const anyTC = { model: "x", messages: [], tools: [], tool_choice: { type: "any" } };
  const r3 = applyParallelCap(anyTC);
  check("anyTC: type preserved (any)", r3.tool_choice.type === "any");
  check("anyTC: disable flag added", r3.tool_choice.disable_parallel_tool_use === true);

  const richTC = {
    model: "x",
    messages: [],
    tools: [],
    tool_choice: { type: "auto", custom_field: "preserved" },
  };
  const r4 = applyParallelCap(richTC);
  check("richTC: custom_field preserved", r4.tool_choice.custom_field === "preserved");
  check("richTC: disable flag added alongside", r4.tool_choice.disable_parallel_tool_use === true);
}

// ─── env override ───────────────────────────────────────────────────
console.log("[4] PI_ASTACK_PARALLEL_CAP_MODELS env override");
{
  const before = process.env.PI_ASTACK_PARALLEL_CAP_MODELS;
  try {
    delete process.env.PI_ASTACK_PARALLEL_CAP_MODELS;
    const defaults = readTargetModelSubstrings();
    check("default = []", defaults.length === 0);

    process.env.PI_ASTACK_PARALLEL_CAP_MODELS = "provider/model-a, provider/model-b ,foo";
    const custom = readTargetModelSubstrings();
    check("custom parses comma-separated", custom.length === 3 && custom[0] === "provider/model-a" && custom[1] === "provider/model-b" && custom[2] === "foo");

    process.env.PI_ASTACK_PARALLEL_CAP_MODELS = "   ";
    const empty = readTargetModelSubstrings();
    check("whitespace-only falls back to defaults", empty.length === 0);
  } finally {
    if (before === undefined) delete process.env.PI_ASTACK_PARALLEL_CAP_MODELS;
    else process.env.PI_ASTACK_PARALLEL_CAP_MODELS = before;
  }
}

// ─── DEFAULT_TARGETS sanity ─────────────────────────────────────────
console.log("[5] DEFAULT_TARGETS invariant");
{
  check("DEFAULT_TARGETS is empty", DEFAULT_TARGETS.length === 0);
}

// ─── ctx extraction (3-T0 P1 dead-code + api gate) ──────────────────
console.log("[6] modelIdFromCtx / modelApiFromCtx");
{
  // pi's Model exposes `id`, NOT `modelId`. The old code read modelId and
  // silently got undefined → ctx-side matching was dead.
  check("reads ctx.model.id (the real field)", modelIdFromCtx({ model: { id: "provider/model-a" } }) === "provider/model-a");
  check("falls back to ctx.model.modelId if id absent", modelIdFromCtx({ model: { modelId: "x" } }) === "x");
  check("prefers id over modelId", modelIdFromCtx({ model: { id: "a", modelId: "b" } }) === "a");
  check("undefined when no model", modelIdFromCtx({}) === undefined);
  check("undefined when ctx nullish", modelIdFromCtx(undefined) === undefined);

  check("reads ctx.model.api", modelApiFromCtx({ model: { api: "anthropic-messages" } }) === "anthropic-messages");
  check("api undefined when absent", modelApiFromCtx({ model: {} }) === undefined);
  check("api undefined when ctx nullish", modelApiFromCtx(undefined) === undefined);
  // The handler bails when api is present AND !== anthropic-messages; this
  // documents the discriminator value an OpenAI request would carry.
  check("openai-completions api is a non-anthropic value", modelApiFromCtx({ model: { api: "openai-completions" } }) === "openai-completions");
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
if (fail > 0) process.exit(1);
process.exit(0);
