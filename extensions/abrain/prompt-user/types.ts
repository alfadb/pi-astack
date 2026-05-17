/**
 * Types for the `prompt_user` LLM-facing synchronous question tool
 * (ADR 0022). Pure TypeScript — no runtime imports, no side effects.
 *
 * These types are deliberately defined in a leaf module so that:
 *   - The schema validator (`schema.ts`, P2) can depend on them
 *     without pulling in runtime modules.
 *   - The PromptDialog UI component (`ui/PromptDialog.ts`, P2) can
 *     import the same canonical shape.
 *   - Future callers (slash commands, internal service) reuse one
 *     definition.
 *
 * INV-H (ADR 0022): `answers` is ALWAYS `Record<string, string[]>`.
 * Even `single` / `text` / `secret` come back as a 1-element array, so
 * caller code never has to branch on type.
 *
 * INV-G: `PromptUserParams` does NOT and MUST NOT include `scope` /
 * `key` / any vault-shaped field. `prompt_user` is not a vault surface.
 */

/**
 * Allowed answer types. Constrained to 4 per ADR 0022 §D1 (no
 * boolean / scale / date / slider in P0 — adding new types later
 * requires updating the validator, the UI component, the audit
 * field redactor, and smoke fixtures, so we keep the surface small).
 *
 *   - `single`: pick exactly one option
 *   - `multi`:  pick 0..N options (server still enforces "Other"
 *              option appended)
 *   - `text`:   free-form short answer; no options array allowed
 *   - `secret`: masked input; raw never leaves PromptDialog closure
 *              (INV-C). No options array allowed.
 */
export type PromptUserQuestionType = "single" | "multi" | "text" | "secret";

/**
 * One option for `single` / `multi` questions.
 *
 *   - `label`:       任意长度的选项文本 (R7.2 合并后唯一的用户可见
 *                    字段)。OptionList 在渲染时会自动 wrap 到多行,LLM
 *                    可以写“TypeScript” 这样的短标签也可以写
 *                    “TypeScript — 强类型 web 全栈” 这样的带描述的
 *                    长文本。
 *   - `recommended`: optional; the UI appends "(Recommended)" suffix
 *                    to at most ONE option per question (validator
 *                    enforces this).
 *
 * 历史: R7.1 之前有一个独立的 `description?: string` 字段。
 * 用户反馈 “为什么要一个名称+一个描述,直接一个描述就可以
 * 了,LLM 自己决定如何输入”——R7.2 合并为单一 `label` 字段。
 * 老调用仍传 `description` 由 schema validator silent drop
 * (不报错但不渲染,避免迁移期间 LLM 中断)。
 *
 * 用户可见字段 `label` 过完整的 `redactCredentials` +
 * `sanitizeForMemory` 才会进入 UI / audit。LLM 写的任何 URL
 * credential 都会被剩下 ***@host 的占位。
 */
export interface PromptUserOption {
  label: string;
  recommended?: boolean;
}

/**
 * One question in a `prompt_user(...)` call.
 *
 * `id` is a snake_case identifier the LLM picks. Schema validator
 * enforces `/^[a-z][a-z0-9_]{0,31}$/`. The handler uses `id` for the
 * secret placeholder (`[REDACTED_SECRET:<id>]`), the audit metadata
 * row, and the `answers` Record key. It is NEVER a user-facing label.
 *
 * `header` is what the UI shows as the chip / section header. ≤ 12
 * display cells (CJK = 2, ASCII = 1). The validator counts display
 * cells, not JS `string.length`. This bound matches Claude Code
 * `AskUserQuestion` and Codex `request_user_input` field shapes; with
 * narrow terminals 13+ cells start to wrap awkwardly.
 *
 * `question` is the full sentence shown above the chips. No length
 * cap in P0 beyond the 4KB total params payload limit (§D1).
 *
 * `options` MUST be present for `single` / `multi`, and MUST be
 * absent for `text` / `secret`. The validator rejects mismatches.
 * Server-side normalization appends "Other (specify)" to the options
 * list for `single` / `multi` (INV: LLM cannot disable Other).
 */
export interface PromptUserQuestion {
  id: string;
  header: string;
  question: string;
  type: PromptUserQuestionType;
  options?: PromptUserOption[];
}

/**
 * Full param payload for `prompt_user(...)`.
 *
 * `reason` explains why the LLM must pause (NOT a re-statement of the
 * questions). It is shown to the user in the dialog footer and
 * sediment audit. Same redaction pass as other user-visible fields.
 *
 * `questions.length` ∈ [1, 4] (§D1). 5+ rejected as `schema-invalid`.
 *
 * `timeoutSec` clamped to [30, 1800], default 600 (§D1 / §D8.4).
 */
export interface PromptUserParams {
  reason: string;
  questions: PromptUserQuestion[];
  timeoutSec?: number;
}

/**
 * Why a `prompt_user` call did not produce an answer. Exactly 6 in P0
 * (ADR 0022 §D1). Adding new reasons requires updating handler audit,
 * smoke fixtures, and LLM-facing tool description simultaneously.
 *
 *   - `user-rejected`:    user pressed Esc / clicked Reject
 *   - `timeout`:          `timeoutSec` elapsed with no answer
 *   - `ui-unavailable`:   `!ctx.hasUI`, or `ctx.ui.custom` unavailable
 *                         AND `type:"secret"` was requested (no
 *                         masked input via chained fallback)
 *   - `subagent-blocked`: caller is a sub-pi process (handler
 *                         defense-in-depth; dispatch layer should
 *                         have stripped the tool already)
 *   - `schema-invalid`:   validator rejected `params`; `detail` carries
 *                         the human-readable error list. Also returned
 *                         when a second concurrent prompt is attempted
 *                         (INV-I), with `detail:"another prompt is
 *                         pending"`.
 *   - `cancelled`:        `ctx.signal` aborted, or `session_shutdown`
 *                         finalizer triggered (INV-B)
 */
export type PromptUserFailureReason =
  | "user-rejected"
  | "timeout"
  | "ui-unavailable"
  | "subagent-blocked"
  | "schema-invalid"
  | "cancelled";

/**
 * Result of a `prompt_user(...)` call.
 *
 * Success branch (`ok: true`):
 *   - `answers[id]` is ALWAYS an array (INV-H). For `single` / `text`
 *     / `secret`, `length === 1`. For `multi`, `length >= 0`.
 *   - `redactions` is populated ONLY when at least one question had
 *     `type:"secret"`; the value placeholder is `[REDACTED_SECRET:<id>]`.
 *   - `detail` is an optional sanitized short string used for soft-cap
 *     warnings (§D8.4: "third prompt_user call in same turn — consider
 *     batching"). LLM-readable but non-fatal.
 *
 * Failure branch (`ok: false`):
 *   - `reason` is one of `PromptUserFailureReason`.
 *   - `detail` carries error-context (validator messages, etc).
 *     Always sanitized — credential redaction runs before detail
 *     leaves the handler.
 *   - `durationMs` is returned even on failure so callers can
 *     observe latency uniformly.
 */
export type PromptUserResult =
  | {
      ok: true;
      answers: Record<string, string[]>;
      durationMs: number;
      redactions?: Record<string, { type: "secret"; placeholder: string }>;
      detail?: string;
    }
  | {
      ok: false;
      reason: PromptUserFailureReason;
      durationMs: number;
      detail?: string;
    };
