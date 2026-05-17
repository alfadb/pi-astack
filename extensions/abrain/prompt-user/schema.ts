/**
 * Validator for `PromptUserParams` (ADR 0022 P2, R7.2 simplification).
 *
 * Pure logic — no I/O, no UI, no audit side effects. The handler calls
 * `validatePromptUserParams` first thing; only after `{ ok: true }` does
 * anything else happen.
 *
 * R7.2 (2026-05-17) simplification (per user request):
 *
 *   - 删除所有 user-visible 字段的长度上限 (MAX_HEADER_DISPLAY_CELLS /
 *     MAX_REASON_LEN / MAX_QUESTION_LEN / MAX_OPTION_LABEL_LEN /
 *     MAX_OPTION_LABEL_WORDS / MAX_OPTION_DESC_LEN /
 *     MAX_OPTION_DESC_DISPLAY_CELLS) 和总 payload 4KB soft cap
 *     (MAX_PARAMS_BYTES)。OptionList / pi-tui Text 都能自动 wrap,
 *     技术理由消失;长度由 LLM 自决。
 *
 *   - 删除 PromptUserOption.description 字段。R7.1 之前是 `{label,
 *     description}` 二字段,用户反馈"为什么要一个名称+一个描述,LLM 自己
 *     决定如何输入" — 合并为单字段 `label`。validator silent-drop 老
 *     LLM 仍传的 description (未声明字段不报错),避免迁移期 LLM 调用挂。
 *
 *   - 删除 displayWidth() / countWords() — 不再有 cell 或 word 计数
 *     校验需要它们。
 *
 * 保留的硬约束 (结构性 / 安全性,不是长度):
 *
 *   - MIN/MAX_QUESTIONS = [1, 4]  (ADR §D1: UI 装不下更多)
 *   - MIN/MAX_OPTIONS = [2, 4]    (ADR §D1: 同上)
 *   - ID_REGEX                    (snake_case, answer key)
 *   - VALID_TYPES                 (4 种合法类型)
 *   - FORBIDDEN_TOP_LEVEL_KEYS    (INV-G 拒 vault 字段)
 *   - hasControlChars             (TUI 安全: \n\r\t 造布局攻击)
 *   - timeoutSec clamp [30, 1800] (防 0 / Infinity 误传)
 *
 * INV-G: refuse any vault-shaped field (`key`, `scope`) at the
 * schema boundary, not later. Closes the door on a future LLM
 * trying to use prompt_user as a vault surface.
 *
 * INV-H: `answers` is always `Record<string, string[]>` — that
 * contract starts at validation; we reject duplicate ids that would
 * collide in `answers`.
 *
 * INV-D (R7.2 update): the 4 user-visible fields (reason / header /
 * question / option.label) all flow into the UI and audit. We do
 * NOT redact here — redaction is a separate concern handled by
 * `redactPromptParams` in the handler entry. R7.2 删除了第 5 字段
 * option.description。
 *
 * Errors are RETURNED, never thrown — the handler converts them into
 * `{ ok:false, reason:"schema-invalid", detail }`.
 */

import type {
  PromptUserOption,
  PromptUserParams,
  PromptUserQuestion,
  PromptUserQuestionType,
} from "./types";

// ── Bounds (structural / safety only, R7.2 simplified) ──────────────

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const DEFAULT_TIMEOUT_SEC = 600;
export const MIN_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 1800;

export const VALID_TYPES: readonly PromptUserQuestionType[] = [
  "single",
  "multi",
  "text",
  "secret",
] as const;

const ID_REGEX = /^[a-z][a-z0-9_]{0,31}$/;
const FORBIDDEN_TOP_LEVEL_KEYS = ["scope", "key", "vault", "secret_key"];

function hasControlChars(s: string): boolean {
  // R7.2 keep: 拒所有 C0 控制字符 (\t 0x09 / \n 0x0a / \r 0x0d) + DEL (0x7f)。
  // 不是长度限制,而是 TUI 布局安全 —— \n 会让单个 header / label
  // 在终端中竖向展开破坏 chip 布局; \r 是 cursor-reset attack。
  // jsonl 安全(JSON.stringify escapes \n)所以这是 UX hardening 不是 P0 injection。
  return /[\x00-\x1f\x7f]/.test(s);
}

// ── Result type ─────────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** Echo of the validated params with `timeoutSec` clamped to the
   * documented range. Only present when `ok === true`. The handler uses
   * this clamped copy so downstream code never has to re-clamp. */
  normalized?: PromptUserParams;
}

// ── Validators (composable) ─────────────────────────────────────────

function validateOption(
  opt: unknown,
  qIdx: number,
  oIdx: number,
  errors: string[],
): asserts opt is PromptUserOption {
  const prefix = `questions[${qIdx}].options[${oIdx}]`;
  if (!opt || typeof opt !== "object") {
    errors.push(`${prefix}: must be an object`);
    return;
  }
  const o = opt as Record<string, unknown>;
  if (typeof o.label !== "string" || !o.label.trim()) {
    errors.push(`${prefix}.label: required non-empty string`);
  } else if (hasControlChars(o.label)) {
    // R7.2: 长度 / 词数限制全删,但 control chars 仍拒(TUI 安全)。
    errors.push(`${prefix}.label: contains control characters`);
  }
  // R7.2: `description` 字段已从 PromptUserOption 中删除。
  // 老 LLM 仍传 silent-drop —— validator 默认对未声明字段不报错,
  // 避免迁移期中断。OptionList 不读它,UI / audit 看不到。
  if (o.recommended !== undefined && typeof o.recommended !== "boolean") {
    errors.push(`${prefix}.recommended: must be boolean if present`);
  }
}

function validateQuestion(
  q: unknown,
  idx: number,
  seenIds: Set<string>,
  errors: string[],
): asserts q is PromptUserQuestion {
  const prefix = `questions[${idx}]`;
  if (!q || typeof q !== "object") {
    errors.push(`${prefix}: must be an object`);
    return;
  }
  const qq = q as Record<string, unknown>;

  // id
  if (typeof qq.id !== "string") {
    errors.push(`${prefix}.id: required string`);
  } else {
    if (!ID_REGEX.test(qq.id)) {
      errors.push(
        `${prefix}.id: must match /^[a-z][a-z0-9_]{0,31}$/, got ${JSON.stringify(qq.id)}`,
      );
    } else if (seenIds.has(qq.id)) {
      errors.push(`${prefix}.id: duplicate "${qq.id}" — ids must be unique`);
    } else {
      seenIds.add(qq.id);
    }
  }

  // header — R7.2: 不再限制 display cells (12)。pi-tui Text 自动 wrap。
  // 仅保留非空检查 + control chars 拒 (TUI 安全)。
  if (typeof qq.header !== "string" || !qq.header.trim()) {
    errors.push(`${prefix}.header: required non-empty string`);
  } else if (hasControlChars(qq.header)) {
    errors.push(`${prefix}.header: contains control characters`);
  }

  // question — R7.2: 删除 MAX_QUESTION_LEN (500 chars) 限制。
  if (typeof qq.question !== "string" || !qq.question.trim()) {
    errors.push(`${prefix}.question: required non-empty string`);
  } else if (hasControlChars(qq.question)) {
    errors.push(`${prefix}.question: contains control characters`);
  }

  // type
  if (typeof qq.type !== "string" || !VALID_TYPES.includes(qq.type as PromptUserQuestionType)) {
    errors.push(
      `${prefix}.type: must be one of ${VALID_TYPES.map((t) => `"${t}"`).join(" | ")}, got ${JSON.stringify(qq.type)}`,
    );
    return; // no point checking options without a valid type
  }
  const type = qq.type as PromptUserQuestionType;

  // options / type cross-consistency (ADR 0022 §D1)
  if (type === "single" || type === "multi") {
    if (!Array.isArray(qq.options)) {
      errors.push(`${prefix}.options: required array for type:"${type}"`);
      return;
    }
    if (qq.options.length < MIN_OPTIONS) {
      errors.push(`${prefix}.options: < ${MIN_OPTIONS} items (got ${qq.options.length})`);
    }
    if (qq.options.length > MAX_OPTIONS) {
      errors.push(`${prefix}.options: > ${MAX_OPTIONS} items (got ${qq.options.length})`);
    }
    const seenLabels = new Set<string>();
    let recommendedCount = 0;
    qq.options.forEach((opt, j) => {
      validateOption(opt, idx, j, errors);
      const o = opt as Record<string, unknown>;
      if (typeof o.label === "string") {
        const key = o.label.trim().toLowerCase();
        if (seenLabels.has(key)) {
          errors.push(`${prefix}.options[${j}].label: duplicate "${o.label}" within this question`);
        } else {
          seenLabels.add(key);
        }
      }
      if (o.recommended === true) recommendedCount += 1;
    });
    if (recommendedCount > 1) {
      errors.push(
        `${prefix}.options: only one option may have recommended:true (got ${recommendedCount})`,
      );
    }
  } else {
    // text / secret MUST NOT carry options
    if (qq.options !== undefined) {
      errors.push(
        `${prefix}.options: forbidden for type:"${type}" — options only apply to single/multi`,
      );
    }
  }
}

// ── Public entry ────────────────────────────────────────────────────

/**
 * Validate raw `prompt_user(params)` call arguments.
 *
 * On success returns `{ ok: true, normalized }` where `normalized`
 * carries a `timeoutSec` clamped to `[MIN_TIMEOUT_SEC, MAX_TIMEOUT_SEC]`
 * (defaulting to `DEFAULT_TIMEOUT_SEC` when omitted). Other fields
 * are echoed verbatim — redaction is the next layer's job.
 *
 * On failure returns `{ ok: false, errors }` with one or more
 * human-readable strings. The handler joins them into the
 * `schema-invalid` detail message; the LLM gets to see them and retry.
 */
export function validatePromptUserParams(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== "object") {
    return { ok: false, errors: ["params: must be an object"] };
  }
  const p = raw as Record<string, unknown>;

  // INV-G hard gate: refuse vault-shaped top-level fields up front so the
  // failure mode is unambiguous (`schema-invalid: scope is not a valid
  // prompt_user field`) rather than silently ignored.
  for (const k of FORBIDDEN_TOP_LEVEL_KEYS) {
    if (k in p) {
      errors.push(
        `params.${k}: forbidden — prompt_user is not a vault surface (INV-G). ` +
        `Use vault_release for vault operations.`,
      );
    }
  }

  // reason — R7.2: 删除 MAX_REASON_LEN (1000 chars) 限制。
  if (typeof p.reason !== "string" || !p.reason.trim()) {
    errors.push("params.reason: required non-empty string explaining why you must pause");
  } else if (hasControlChars(p.reason)) {
    errors.push("params.reason: contains control characters");
  }

  // questions
  if (!Array.isArray(p.questions)) {
    errors.push("params.questions: required array");
  } else if (p.questions.length < MIN_QUESTIONS) {
    errors.push(
      `params.questions: < ${MIN_QUESTIONS} items — at least one question required`,
    );
  } else if (p.questions.length > MAX_QUESTIONS) {
    errors.push(
      `params.questions: > ${MAX_QUESTIONS} items — keep prompts focused (got ${p.questions.length})`,
    );
  } else {
    const seenIds = new Set<string>();
    p.questions.forEach((q, i) => validateQuestion(q, i, seenIds, errors));
  }

  // timeoutSec (optional, clamped)
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  if (p.timeoutSec !== undefined) {
    if (typeof p.timeoutSec !== "number" || !Number.isFinite(p.timeoutSec)) {
      errors.push("params.timeoutSec: must be a finite number if present");
    } else {
      timeoutSec = Math.max(
        MIN_TIMEOUT_SEC,
        Math.min(MAX_TIMEOUT_SEC, Math.floor(p.timeoutSec)),
      );
    }
  }

  // R7.2: 删除 4KB payload 总长度检查。仍保留 JSON-serializable 检查
  // (防 circular ref) —— 这不是长度限制,是结构完整性。
  try {
    JSON.stringify(p);
  } catch {
    errors.push("params: not JSON-serializable (circular reference?)");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const normalized: PromptUserParams = {
    reason: p.reason as string,
    questions: p.questions as PromptUserQuestion[],
    timeoutSec,
  };
  return { ok: true, errors: [], normalized };
}
