#!/usr/bin/env node
/**
 * smoke-tool-parallel-cap — verify the tool-parallel-cap pure helpers AND
 * the composability invariant with tool-contract's injectToolChoiceIntoPayload.
 *
 * What this asserts:
 *   1. isAnthropicMessagesShape() rejects non-objects, OpenAI Responses
 *      (has `input` array), and missing required fields.
 *   2. shouldCapForPayload() gates on model substring (ctx OR payload.model),
 *      tools array non-empty, tool_choice !== "none", sub-agent guard.
 *   3. applyParallelCap() preserves existing tool_choice fields while
 *      adding disable_parallel_tool_use:true.
 *   4. Order-independence with tool-contract:
 *      - cap-first → tool-contract-second: final has BOTH type AND
 *        disable_parallel_tool_use (verifies tool-contract patch).
 *      - tool-contract-first → cap-second: same result via cap's spread.
 *   5. Env override PI_ASTACK_PARALLEL_CAP_MODELS works.
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
const tcPayload = jiti(path.join(repoRoot, "extensions/tool-contract/payload.ts"));

const {
  isAnthropicMessagesShape,
  shouldCapForPayload,
  applyParallelCap,
  readTargetModelSubstrings,
  DEFAULT_TARGETS,
  modelIdFromCtx,
  modelApiFromCtx,
} = cap.__TEST;

const { injectToolChoiceIntoPayload } = tcPayload;

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
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "hi" }],
    tools: [anthroTool],
  };
  check("matching modelId via payload.model → true", shouldCapForPayload(base, undefined, ["claude-opus-4-8"]) === true);
  check("matching modelId via ctx → true", shouldCapForPayload({ ...base, model: "other" }, "anthropic/claude-opus-4-8", ["claude-opus-4-8"]) === true);
  check("no model match → false", shouldCapForPayload({ ...base, model: "haiku" }, "haiku", ["claude-opus-4-8"]) === false);
  check("empty tools → false", shouldCapForPayload({ ...base, tools: [] }, undefined, ["claude-opus-4-8"]) === false);
  check("missing tools → false", shouldCapForPayload({ model: base.model, messages: base.messages }, undefined, ["claude-opus-4-8"]) === false);
  check("tool_choice none → false", shouldCapForPayload({ ...base, tool_choice: { type: "none" } }, undefined, ["claude-opus-4-8"]) === false);
  check("tool_choice auto → true (we augment)", shouldCapForPayload({ ...base, tool_choice: { type: "auto" } }, undefined, ["claude-opus-4-8"]) === true);
  check("tool_choice any → true (we augment)", shouldCapForPayload({ ...base, tool_choice: { type: "any" } }, undefined, ["claude-opus-4-8"]) === true);
  check("multiple targets, last matches → true", shouldCapForPayload(base, undefined, ["claude-opus-4-9", "claude-opus-4-8"]) === true);
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

// ─── ORDER-INDEPENDENCE WITH tool-contract ──────────────────────────
// Build a realistic Anthropic Messages payload with final_answer tool
// + edit tool, so tool-contract's payloadHasFinalAnswerTool() finds it.
console.log("[4] Composability with tool-contract (order-independent)");
{
  const FINAL_ANSWER_TOOL_NAME = "final_answer";
  const baseAnthropic = {
    model: "claude-opus-4-8",
    messages: [{ role: "user", content: "do something" }],
    system: "you are pi",
    tools: [
      { name: "edit", description: "edit a file", input_schema: { type: "object", properties: {}, required: [] } },
      { name: FINAL_ANSWER_TOOL_NAME, description: "finish the turn", input_schema: { type: "object", properties: {}, required: [] } },
    ],
    thinking: { type: "enabled", budget_tokens: 16000 },
  };

  // Scenario A: cap-parallel runs FIRST, tool-contract SECOND
  let payloadA = baseAnthropic;
  payloadA = applyParallelCap(payloadA);
  const injA = injectToolChoiceIntoPayload(payloadA, { finalAnswerToolName: FINAL_ANSWER_TOOL_NAME });
  payloadA = injA.payload;
  check("A: tool-contract injected (final_answer present)", injA.injected === true);
  check("A: type set to auto (thinking enabled)", payloadA.tool_choice.type === "auto");
  check("A: disable_parallel_tool_use SURVIVED tool-contract spread", payloadA.tool_choice.disable_parallel_tool_use === true);

  // Scenario B: tool-contract runs FIRST, cap-parallel SECOND
  let payloadB = baseAnthropic;
  const injB = injectToolChoiceIntoPayload(payloadB, { finalAnswerToolName: FINAL_ANSWER_TOOL_NAME });
  payloadB = injB.payload;
  payloadB = applyParallelCap(payloadB);
  check("B: type still auto", payloadB.tool_choice.type === "auto");
  check("B: disable_parallel_tool_use added by cap", payloadB.tool_choice.disable_parallel_tool_use === true);

  // Scenario C: only cap-parallel runs (tool-contract no-op because no final_answer)
  const noFinal = { ...baseAnthropic, tools: [baseAnthropic.tools[0]] };
  let payloadC = noFinal;
  payloadC = applyParallelCap(payloadC);
  const injC = injectToolChoiceIntoPayload(payloadC, { finalAnswerToolName: FINAL_ANSWER_TOOL_NAME });
  check("C: tool-contract no-op (final_answer missing)", injC.injected === false);
  check("C: cap-parallel result intact", injC.payload.tool_choice.disable_parallel_tool_use === true);
  check("C: type defaulted to auto", injC.payload.tool_choice.type === "auto");
}

// ─── env override ───────────────────────────────────────────────────
console.log("[5] PI_ASTACK_PARALLEL_CAP_MODELS env override");
{
  const before = process.env.PI_ASTACK_PARALLEL_CAP_MODELS;
  try {
    delete process.env.PI_ASTACK_PARALLEL_CAP_MODELS;
    const defaults = readTargetModelSubstrings();
    check("default = [claude-opus-4-8]", defaults.length === 1 && defaults[0] === "claude-opus-4-8");

    process.env.PI_ASTACK_PARALLEL_CAP_MODELS = "claude-opus-4-8, claude-opus-4-9 ,foo";
    const custom = readTargetModelSubstrings();
    check("custom parses comma-separated", custom.length === 3 && custom[0] === "claude-opus-4-8" && custom[1] === "claude-opus-4-9" && custom[2] === "foo");

    process.env.PI_ASTACK_PARALLEL_CAP_MODELS = "   ";
    const empty = readTargetModelSubstrings();
    check("whitespace-only falls back to defaults", empty.length === 1 && empty[0] === "claude-opus-4-8");
  } finally {
    if (before === undefined) delete process.env.PI_ASTACK_PARALLEL_CAP_MODELS;
    else process.env.PI_ASTACK_PARALLEL_CAP_MODELS = before;
  }
}

// ─── DEFAULT_TARGETS sanity ─────────────────────────────────────────
console.log("[6] DEFAULT_TARGETS invariant");
{
  check("DEFAULT_TARGETS is exactly [claude-opus-4-8]", DEFAULT_TARGETS.length === 1 && DEFAULT_TARGETS[0] === "claude-opus-4-8");
}

// ─── ctx extraction (3-T0 P1 dead-code + api gate) ──────────────────
console.log("[7] modelIdFromCtx / modelApiFromCtx");
{
  // pi's Model exposes `id`, NOT `modelId`. The old code read modelId and
  // silently got undefined → ctx-side matching was dead.
  check("reads ctx.model.id (the real field)", modelIdFromCtx({ model: { id: "claude-opus-4-8" } }) === "claude-opus-4-8");
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
