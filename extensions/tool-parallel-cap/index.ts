/**
 * tool-parallel-cap — cap Anthropic Messages requests to **at most one
 * tool_use per assistant message** for designated models. No model is
 * hardcoded here; targets come from PI_ASTACK_PARALLEL_CAP_MODELS env
 * (comma-separated provider/model id substrings). Empty list = no cap.
 *
 * ## Why this extension
 *
 * Some Anthropic-family models routinely emit 10+ parallel tool_use blocks
 * in a single assistant message during dogfood (e.g. opening multiple
 * files, kicking off ad-hoc bash commands, and queuing edits all at once).
 * The harness runs them concurrently which:
 *   - amplifies the impact of any single failing tool call (one fails →
 *     next-turn context is a tangle of partially-applied state)
 *   - blocks the verify-after-edit feedback loop (parallel edits return
 *     all at once; the model has no incentive to inspect each)
 *   - magnifies the edit-batch atomic-rollback class of bugs because
 *     multiple concurrent edits with overlapping oldText windows can
 *     race in surprising ways
 *
 * The Anthropic Messages API exposes the protocol-level lever for this:
 *   tool_choice: { type: "auto", disable_parallel_tool_use: true }
 *
 * Per Anthropic docs (release-notes/api), this caps each model turn at
 * at most one tool_use. The model still chooses freely whether to use a
 * tool (type: auto), but cannot emit two in the same message.
 *
 * ## Payload preservation
 *
 * This extension reads any existing `payload.tool_choice` and spreads it
 * first, then adds `disable_parallel_tool_use:true`. That keeps unrelated
 * provider payload fields intact if another hook already populated them.
 *
 * ## Sub-agent isolation
 *
 * Sub-agents (dispatch_parallel research workers, blind-review committees)
 * are intentionally allowed parallel tool use — that is the whole point of
 * dispatching them. `isSubAgentSession(ctx)` is the canonical guard.
 *
 * ## Configuration
 *
 * - Disable entirely: `PI_ASTACK_DISABLE_PARALLEL_CAP=1`
 * - Override target model substrings (comma-separated):
 *     `PI_ASTACK_PARALLEL_CAP_MODELS=provider/model-a,provider/model-b`
 *   Empty default (set in code) = no cap; set the env to opt in.
 * - Match is `.includes()` against `ctx.model.modelId` AND `payload.model`
 *   — both are checked so a substring match in either side triggers.
 *
 * ## Why model-targeted (not blanket)
 *
 * Capping every model would force unnecessary serialization on models
 * that don't reliably hit the 10+ parallel pattern. Targeting keeps the
 * intervention narrow and reversible per-model via env.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isSubAgentSession } from "../_shared/pi-internals";

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// No model hardcoded in code. Configure via
// PI_ASTACK_PARALLEL_CAP_MODELS env (comma-separated provider/model id
// substrings) or pi-astack-settings.json. Empty default = no cap applied.
const DEFAULT_TARGETS: string[] = [];

function readTargetModelSubstrings(): string[] {
  const env = process.env.PI_ASTACK_PARALLEL_CAP_MODELS;
  if (!env) return DEFAULT_TARGETS;
  const parts = env
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : DEFAULT_TARGETS;
}

/**
 * Detect whether the payload is Anthropic Messages-shaped.
 *
 * We deliberately keep this lightweight and local.
 *
 * Heuristic:
 *   - `messages` is an array (both Anthropic Messages and OpenAI Chat
 *     Completions use this; we discriminate by presence of `system`)
 *   - `system` is present (Anthropic-only at the top level; OpenAI Chat
 *     Completions puts the system message INSIDE messages[])
 *   - `model` is a string
 *
 * False negatives (Anthropic Messages without a system block) are safe
 * — we just don't intervene. False positives (something else with
 * `messages` + `system` + `model`) are extremely unlikely in pi's
 * current provider set.
 */
export function isAnthropicMessagesShape(payload: unknown): payload is Obj & {
  model: string;
  messages: unknown[];
} {
  if (!isObj(payload)) return false;
  if (typeof payload.model !== "string") return false;
  if (!Array.isArray(payload.messages)) return false;
  // Anthropic Messages top-level system is string OR array. OpenAI
  // Chat Completions has NO top-level system (it goes into messages[]).
  // OpenAI Responses uses `input` (array) instead of `messages`.
  if (Array.isArray(payload.input)) return false;
  // Presence of `system` is a positive Anthropic signal but not strictly
  // required (some Anthropic requests omit it). Use it as a tie-breaker
  // when both messages and input could be ambiguous.
  return true;
}

/**
 * Pure: decide whether this payload + model combo should be capped.
 * Exported so smoke can exercise it without the runtime.
 */
export function shouldCapForPayload(
  payload: unknown,
  ctxModelId: string | undefined,
  targets: string[],
): boolean {
  if (!isAnthropicMessagesShape(payload)) return false;

  // Tools must be present; capping is moot if no tools are advertised.
  const tools = (payload as Obj).tools;
  if (!Array.isArray(tools) || tools.length === 0) return false;

  // tool_choice: { type: "none" } → user explicitly disabled tools.
  const tc = (payload as Obj).tool_choice;
  if (isObj(tc) && tc.type === "none") return false;

  // Model match: check both ctx.model.modelId and payload.model. Either
  // substring hit triggers. Targets is a list (Set conversion overkill).
  for (const t of targets) {
    if (typeof ctxModelId === "string" && ctxModelId.includes(t)) return true;
    if (payload.model.includes(t)) return true;
  }
  return false;
}

/**
 * Pure: produce a new payload object with `disable_parallel_tool_use: true`
 * merged into tool_choice. Preserves any existing tool_choice subfields.
 * Caller decides whether to call this based on `shouldCapForPayload`.
 */
export function applyParallelCap(payload: Obj): Obj {
  const existing = isObj(payload.tool_choice) ? payload.tool_choice : undefined;
  const existingType = typeof existing?.type === "string" ? existing.type : "auto";

  return {
    ...payload,
    tool_choice: {
      ...(existing ?? {}),
      type: existingType,
      disable_parallel_tool_use: true,
    },
  };
}

/**
 * Extract the current model id defensively.
 *
 * 3-T0 P1: pi's Model type (pi-ai types.d.ts) exposes `id`, NOT `modelId`.
 * The original code read `ctx.model.modelId` — a non-existent field — so
 * ctx-side model matching was dead code (only payload.model matched). Read
 * `id` first, keep `modelId` as a fallback in case a host wraps the model.
 */
function modelIdFromCtx(ctx: unknown): string | undefined {
  const m = (ctx as { model?: { id?: unknown; modelId?: unknown } } | undefined)?.model;
  if (m && typeof m.id === "string") return m.id;
  if (m && typeof m.modelId === "string") return m.modelId;
  return undefined;
}

/**
 * Extract the provider API discriminator (ctx.model.api), e.g.
 * "anthropic-messages" / "openai-completions" / "openai-responses".
 *
 * 3-T0 P1/P2 (all three reviewers): payload-shape detection alone can
 * false-positive on OpenAI Chat Completions (also has top-level messages[]),
 * which would inject the Anthropic-only `disable_parallel_tool_use` into a
 * non-Anthropic request. ctx.model.api is the authoritative provider gate.
 */
function modelApiFromCtx(ctx: unknown): string | undefined {
  const api = (ctx as { model?: { api?: unknown } } | undefined)?.model?.api;
  return typeof api === "string" ? api : undefined;
}

// ──────────────────────────────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (process.env.PI_ASTACK_DISABLE_PARALLEL_CAP === "1") return;

  const targets = readTargetModelSubstrings();

  pi.on("before_provider_request", (event, ctx) => {
    if (isSubAgentSession(ctx)) return; // sub-agents need parallel tool use

    // Authoritative provider gate (3-T0): only ever touch genuine Anthropic
    // Messages requests. ctx.model.api is the discriminator. When it is
    // present and NOT anthropic-messages, bail — this prevents injecting the
    // Anthropic-only disable_parallel_tool_use into an OpenAI Chat
    // Completions payload that merely shares the top-level messages[] shape.
    // When ctx.model is absent (rare), fall through to payload-shape +
    // model-substring gating below (still protected by the target match).
    const api = modelApiFromCtx(ctx);
    if (api !== undefined && api !== "anthropic-messages") return;

    const ctxModelId = modelIdFromCtx(ctx);
    if (!shouldCapForPayload(event.payload, ctxModelId, targets)) return;

    return applyParallelCap(event.payload as Obj);
  });
}

// ──────────────────────────────────────────────────────────────────────
// Test-only exports
// ──────────────────────────────────────────────────────────────────────

export const __TEST = {
  DEFAULT_TARGETS,
  readTargetModelSubstrings,
  isAnthropicMessagesShape,
  shouldCapForPayload,
  applyParallelCap,
  modelIdFromCtx,
  modelApiFromCtx,
};
