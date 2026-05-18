/**
 * Credential / secret redaction primitives, promoted from
 * `git-sync.ts` so they can be shared by `prompt_user` (ADR 0022) and
 * any future caller that must keep raw secrets out of audit / UI /
 * sediment / log surfaces.
 *
 * Why this lives in `abrain/redact.ts` (not `_shared/`):
 * ADR 0022 §D6.2 — `_shared/` promotion would need a separate
 * cross-extension API security review; we only have one consumer beyond
 * abrain today (sediment, via its own sanitizer.ts). Promote later when
 * a second extension legitimately needs it.
 *
 * Invariant trace:
 *   ADR 0020 INV 7 — `redactCredentials` must remain available for
 *     `getStatus().remote`, `formatSyncStatus()`, and sync audit error
 *     fields. `git-sync.ts` re-exports it so existing imports do not
 *     break.
 *   ADR 0022 INV-J — `redactCredentials` MUST be defined here; the
 *     `git-sync.ts` re-export is a compat shim, not a second definition.
 *     Smoke verifies `import from "./git-sync"` and `import from
 *     "./redact"` yield the SAME function reference (no drift).
 *   ADR 0022 INV-C — `redactSecretAnswer` is how `type:"secret"` raw
 *     answers are replaced before the value crosses any audit / LLM /
 *     log boundary.
 *   ADR 0022 INV-D (R7.2 updated 5→4) — `redactPromptParams` is the
 *     single funnel through which 4 user-visible fields (reason /
 *     header / question / option.label) get scrubbed before they reach
 *     UI / audit / sediment. R7.2 (2026-05-17) 删除了第 5 字段
 *     option.description —— 用户要求「合并为单字段 label,LLM
 *     自决长度」,description 从 schema 中被刪除。Lives here (not
 *     handler.ts) so both `handler.executePromptUserTool` AND
 *     `service.askPromptUser` can call it without circular import;
 *     calls are idempotent.
 */

import * as os from "node:os";
import type {
  PromptUserOption,
  PromptUserParams,
  PromptUserQuestion,
} from "./prompt-user/types";

/**
 * Redact userinfo from a URL so credentials don't leak into logs or UI.
 *
 * Originally added by Round 2 git-sync audit (opus M1 + deepseek m2):
 * `git remote get-url origin` returns the URL verbatim. If a user
 * configured `https://alice:ghp_xxx@git.example.com/repo.git` (a common
 * antipattern), the token would flow into `getStatus().remote`,
 * `formatSyncStatus()` UI output, and any push stderr captured into the
 * audit `error` field (e.g. `fatal: unable to access
 * 'https://alice:ghp_xxx@...'`). The audit log is on disk forever.
 * Invariant 4 ("No secrets in argv") was symmetric-asymmetric: argv-in
 * was locked down but the output side leaked. This redactor closes that
 * gap. SSH-style URLs (`git@host:path`) are not touched — they have no
 * embedded secret.
 *
 * ADR 0022 P1: moved here from git-sync.ts unchanged.
 * ADR 0022 P1-fix (OPUS review): scheme broadened from `https?:` to
 *   `[a-z][a-z0-9+\-.]*` so postgres:// / mysql:// / mongodb:// /
 *   redis:// / amqp:// / mongodb+srv:// connection strings get the
 *   same treatment as HTTP(S). LLM can paste any of these into
 *   prompt_user user-visible fields; the old regex left them raw on
 *   disk. Backward-compatible — every previously-matched URL is still
 *   matched (https? is a strict subset of the new scheme alphabet);
 *   smoke verifies git-sync's existing https URLs unchanged.
 */
export function redactCredentials(s: string): string {
  return s.replace(/([a-z][a-z0-9+\-.]*:\/\/)[^@\s\/]+@/gi, "$1***@");
}

/**
 * Light path-like sanitizer for user-visible fields in `prompt_user`.
 *
 * ADR 0022 INV-D requires `redactCredentials` + `sanitizeForMemory`
 * coverage on the 5 user-visible fields. The full `sanitizeForMemory`
 * lives in sediment/sanitizer.ts and pulls in vendor-specific
 * credential patterns (sk-... / AKIA... / PEM blocks), which is
 * overkill for prompt_user UI display (PromptDialog will literally
 * show those bytes back to the user).
 *
 * This light variant covers the two patterns most likely to leak via
 * LLM-supplied prompt text: HOME path expansion and bare IPv4. Lives
 * in abrain/redact.ts (not sediment) so prompt_user does NOT take a
 * runtime dependency on sediment internals.
 *
 * Composes with redactCredentials: call them in either order; both
 * are idempotent.
 */
export function sanitizePathLike(s: string): string {
  if (!s) return s;
  let out = s;
  const home = os.homedir();
  if (home && out.includes(home)) {
    out = out.split(home).join("$HOME");
  }
  out = out.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[HOST]");
  return out;
}

/**
 * Single funnel for INV-D redaction of `PromptUserParams`.
 *
 * Covers all 4 user-visible fields (R7.2 update: 从 R4 的 5 字段减为 4,
 * 删除 `option.description`,合并到 `option.label`。):
 *
 *   - `reason`
 *   - `question.header`
 *   - `question.question`
 *   - `option.label`
 *
 * Each field passes through `redactCredentials` (URL credentials in
 * any scheme) then `sanitizePathLike` (home-path / IPv4) so a single
 * LLM-injected `"deploy to postgres://u:p@10.0.0.1/db at /home/alice/x"`
 * becomes `"deploy to postgres://***@[HOST]/db at $HOME/x"` before it
 * touches PromptDialog, audit jsonl, or any future sediment evidence
 * pre-pass.
 *
 * R7.2: 老 LLM 如果仍传 `option.description`,validator silent-drop
 * 不报错但也不会进入 PromptUserOption 类型,这里也不需要 redact
 * (字段不存在于 redact 路径 = 不会进 UI 或 audit)。
 *
 * Idempotent: `***@` doesn't match `[^@\s\/]+@`, `$HOME` doesn't
 * match the home-path literal, and `[HOST]` doesn't match the IPv4
 * regex. Safe to call twice (handler entry + service entry both call
 * it as defense-in-depth; second call is a no-op on the second pass).
 *
 * ADR 0022 P1-fix (OPUS + DEEPSEEK review): moved here from
 * handler.ts so service.askPromptUser can call it at its entry too
 * (future slash command callers go through service, not handler).
 */
export function redactPromptParams(p: PromptUserParams): PromptUserParams {
  const scrub = (s: string): string => sanitizePathLike(redactCredentials(s));

  // R7.4 (opus post-fix review P1.NEW): 三层全部采用显式白名单重建,
  // 不用 `...spread`。R7.2 + opus P0.1 只修了 option 级,但 question / params
  // 两层仍是 spread,老 LLM 传 description 在 question 级 / params 级同样会
  // 随 spread 透传。今天不活跃(下游不读),但 future debug `JSON.stringify`
  // 会重新打开同一类漏洞。全三层显式重建杭绝这个 regression 路径。
  const redactOption = (o: PromptUserOption): PromptUserOption => {
    const out: PromptUserOption = { label: scrub(o.label) };
    if (o.recommended !== undefined) out.recommended = o.recommended;
    return out;
  };
  const redactQuestion = (q: PromptUserQuestion): PromptUserQuestion => {
    const out: PromptUserQuestion = {
      id: q.id,
      header: scrub(q.header),
      question: scrub(q.question),
      type: q.type,
    };
    if (q.options !== undefined) out.options = q.options.map(redactOption);
    return out;
  };
  const out: PromptUserParams = {
    reason: scrub(p.reason),
    questions: p.questions.map(redactQuestion),
  };
  if (p.timeoutSec !== undefined) out.timeoutSec = p.timeoutSec;
  return out;
}

/**
 * Replace a `type:"secret"` raw answer with a stable placeholder before
 * it crosses any LLM / audit / log boundary.
 *
 * ADR 0022 INV-C: tool result returns `[REDACTED_SECRET:<id>]`; audit
 * stores only `lengthBucket(raw)` — never `raw`, never a hash, never
 * char count.
 *
 * `id` is taken from `PromptUserQuestion.id` (snake_case, schema-
 * validated). It MUST NOT be a user-supplied string at this layer:
 * by the time `redactSecretAnswer` is called the handler has already
 * validated the id regex `/^[a-z][a-z0-9_]{0,31}$/`.
 */
export function redactSecretAnswer(_raw: string, id: string): string {
  return `[REDACTED_SECRET:${id}]`;
}

/**
 * Coarse length bucket for `type:"secret"` answers, used in audit
 * metadata so operators can answer "did the user enter anything?"
 * without ever storing length on disk.
 *
 * Buckets are intentionally coarse (3 levels) so they leak less entropy
 * than a numeric length. Empty string falls into "1-8" by convention —
 * smoke verifies this so future "0 length" handling doesn't drift.
 *
 * ADR 0022 §D6.3: audit metadata row carries `lengthBucket(raw)`, never
 * `raw.length` and never `raw`.
 */
export function lengthBucket(s: string): "1-8" | "9-32" | ">32" {
  const n = s.length;
  if (n <= 8) return "1-8";
  if (n <= 32) return "9-32";
  return ">32";
}
