/**
 * Validator for `PromptUserParams` (ADR 0022 P2).
 *
 * Pure logic — no I/O, no UI, no audit side effects. The handler calls
 * `validatePromptUserParams` first thing; only after `{ ok: true }` does
 * anything else happen.
 *
 * Why so strict at the schema layer:
 *   - INV-G: refuse any vault-shaped field (`key`, `scope`) at the
 *     schema boundary, not later. Closes the door on a future LLM
 *     trying to use prompt_user as a vault surface.
 *   - INV-H: `answers` is always `Record<string, string[]>` — that
 *     contract starts at validation; we reject duplicate ids that would
 *     collide in `answers`.
 *   - INV-D: the 5 user-visible fields (reason / header / question /
 *     option.label / option.description) all flow into the UI and
 *     audit. We do NOT redact here — redaction is a separate concern
 *     handled by `redactPromptParams` in the handler entry. But we DO
 *     enforce bounded sizes here so a 1MB `reason` cannot crash the
 *     dialog renderer.
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

// ── Bounds (ADR 0022 §D1 / R4) ──────────────────────────────────────

export const MIN_QUESTIONS = 1;
export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_DISPLAY_CELLS = 12;
export const MAX_REASON_LEN = 1000;
export const MAX_QUESTION_LEN = 500;
export const MAX_OPTION_LABEL_LEN = 80;
export const MAX_OPTION_DESC_LEN = 200;
export const MAX_OPTION_LABEL_WORDS = 5;
export const DEFAULT_TIMEOUT_SEC = 600;
export const MIN_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 1800;
export const MAX_PARAMS_BYTES = 4096; // §D1: total payload soft-cap

export const VALID_TYPES: readonly PromptUserQuestionType[] = [
  "single",
  "multi",
  "text",
  "secret",
] as const;

const ID_REGEX = /^[a-z][a-z0-9_]{0,31}$/;
const FORBIDDEN_TOP_LEVEL_KEYS = ["scope", "key", "vault", "secret_key"];

/**
 * Count Unicode display cells (East Asian Wide / Fullwidth = 2, the
 * rest = 1). Not perfect — does not handle emoji ZWJ sequences or
 * variation selectors — but matches the budget Claude Code /
 * Codex use and is good enough for a 12-cell header bound.
 *
 * The crucial property under test: `"中文" → 4`, `"abcd" → 4`,
 * `"a中" → 3`. JS `string.length` would say 2/4/2 — we MUST not use
 * that for the header bound.
 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    // East Asian Wide / Fullwidth ranges (a practical, not exhaustive, list)
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||           // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) ||           // CJK Radicals / Symbols
      (cp >= 0x3041 && cp <= 0x33ff) ||           // Hiragana, Katakana, CJK Symbols
      (cp >= 0x3400 && cp <= 0x4dbf) ||           // CJK Unified Extension A
      (cp >= 0x4e00 && cp <= 0x9fff) ||           // CJK Unified Ideographs
      (cp >= 0xa000 && cp <= 0xa4cf) ||           // Yi
      (cp >= 0xac00 && cp <= 0xd7a3) ||           // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||           // CJK Compatibility Ideographs
      (cp >= 0xfe30 && cp <= 0xfe4f) ||           // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) ||           // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||         // Emoji (rough — keeps us conservative)
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||         // CJK Extension B-F
      (cp >= 0x30000 && cp <= 0x3fffd)
    ) {
      w += 2;
    } else if (cp >= 0x20) {
      w += 1;
    }
    // control chars (< 0x20) add 0 — we reject them separately
  }
  return w;
}

function hasControlChars(s: string): boolean {
  // ADR 0022 P1-fix (OPUS review): reject ALL C0 controls including
  // \t (0x09) / \n (0x0a) / \r (0x0d), plus DEL (0x7f). The earlier
  // implementation allowed \t / \n / \r through; the comment lied.
  //
  // Concrete failure mode that motivated the tightening:
  // `header = "abc\n\n\n\n\n"` has displayWidth=3 (each \n is 0
  // cells per the East Asian Wide budget), so it passed the 12-cell
  // bound — but PromptDialog rendered as a vertical stack of blanks
  // pushing every subsequent question off-screen. \r is also a
  // cursor-reset attack on terminals that survive the TUI buffer.
  // jsonl is safe (JSON.stringify escapes \n), so this is a P1 UX
  // hardening, not a P0 injection bug.
  return /[\x00-\x1f\x7f]/.test(s);
}

function countWords(s: string): number {
  // Simple whitespace split; good enough for the "1-5 words" guideline.
  // For pure-CJK labels (no spaces), each character is conceptually
  // its own word — we don't penalize "确定" (2 chars / 0 spaces).
  // To keep the rule meaningful for English, we count whitespace-
  // separated tokens.
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
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
  } else {
    if (o.label.length > MAX_OPTION_LABEL_LEN) {
      errors.push(`${prefix}.label: > ${MAX_OPTION_LABEL_LEN} chars`);
    }
    if (countWords(o.label) > MAX_OPTION_LABEL_WORDS) {
      errors.push(`${prefix}.label: > ${MAX_OPTION_LABEL_WORDS} words (keep it terse)`);
    }
    if (hasControlChars(o.label)) {
      errors.push(`${prefix}.label: contains control characters`);
    }
  }
  if (o.description !== undefined) {
    if (typeof o.description !== "string") {
      errors.push(`${prefix}.description: must be string if present`);
    } else if (o.description.length > MAX_OPTION_DESC_LEN) {
      errors.push(`${prefix}.description: > ${MAX_OPTION_DESC_LEN} chars`);
    } else if (hasControlChars(o.description)) {
      errors.push(`${prefix}.description: contains control characters`);
    }
  }
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

  // header
  if (typeof qq.header !== "string" || !qq.header.trim()) {
    errors.push(`${prefix}.header: required non-empty string`);
  } else {
    if (hasControlChars(qq.header)) {
      errors.push(`${prefix}.header: contains control characters`);
    }
    const w = displayWidth(qq.header);
    if (w > MAX_HEADER_DISPLAY_CELLS) {
      errors.push(
        `${prefix}.header: ${w} display cells, max ${MAX_HEADER_DISPLAY_CELLS} ` +
        `(CJK chars count as 2; current ${JSON.stringify(qq.header)})`,
      );
    }
  }

  // question
  if (typeof qq.question !== "string" || !qq.question.trim()) {
    errors.push(`${prefix}.question: required non-empty string`);
  } else if (qq.question.length > MAX_QUESTION_LEN) {
    errors.push(`${prefix}.question: > ${MAX_QUESTION_LEN} chars`);
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

  // reason
  if (typeof p.reason !== "string" || !p.reason.trim()) {
    errors.push("params.reason: required non-empty string explaining why you must pause");
  } else if (p.reason.length > MAX_REASON_LEN) {
    errors.push(`params.reason: > ${MAX_REASON_LEN} chars`);
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

  // timeoutSec (optional)
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

  // Payload total-size soft check (mostly to fail closed on accidental
  // 1MB pastes; matches §D1)
  try {
    const serialized = JSON.stringify(p);
    if (serialized.length > MAX_PARAMS_BYTES) {
      errors.push(
        `params: serialized size ${serialized.length} bytes > ${MAX_PARAMS_BYTES} (keep prompts terse)`,
      );
    }
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
