/**
 * abrain — vault prompt localizer.
 *
 * The TUI authorization prompts must show users WHAT they are authorizing,
 * and the text must match the language the user is currently speaking to the
 * LLM. We don't infer language from env vars or system locale — we observe
 * recent user messages and ask the active session model to translate the
 * English template into that language.
 *
 * Failure modes (no user messages yet, no active model, LLM timeout, etc.)
 * fall back to English. Translation is cached per (template, user-language
 * fingerprint) so repeated prompts in the same conversation don't pay the
 * LLM round-trip twice.
 *
 * Translation requests carry only:
 *   - the English prompt template (already going to be shown in the TUI),
 *   - recent user messages (already in LLM context).
 * No plaintext secret material enters the translation request — bash command
 * previews are pre-rewritten so they contain only `$VAULT_*` variable refs.
 */

import { auditStreamSimple } from "../_shared/llm-audit";

const RING_MAX = 3;
const RING_TEXT_MAX = 1200;
const CACHE_MAX = 200;
// Long enough for a slow reasoning model to localize the bash authorization
// prompt, which is meaningfully bigger than the vault_release one (it carries
// the keys list + command preview + an extra encoded-secret caveat). Pre-bump:
// 5s was occasionally truncating to English on the bash path in live testing.
const TRANSLATE_TIMEOUT_MS = 12_000;

const userMessageRing: string[] = [];
const cache = new Map<string, string>();

export function recordUserMessage(text: string): void {
  const trimmed = (text ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return;
  userMessageRing.push(trimmed.slice(0, RING_TEXT_MAX));
  while (userMessageRing.length > RING_MAX) userMessageRing.shift();
}

export function getLanguageHintSample(): string {
  return userMessageRing.join("\n---\n");
}

export function __resetI18nForTests(): void {
  userMessageRing.length = 0;
  cache.clear();
}

function cacheKey(en: string, hint: string): string {
  return `${en}\u0000${hint.slice(0, 200)}`;
}

function rememberLocalized(en: string, hint: string, value: string): void {
  if (cache.size >= CACHE_MAX) {
    // Drop the oldest entry. Map iteration is insertion order so the first
    // key is the oldest.
    const first = cache.keys().next().value;
    if (first !== undefined) cache.delete(first);
  }
  cache.set(cacheKey(en, hint), value);
}

function stripCodeFence(text: string): string {
  const m = text.match(/^```[^\n]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1]!.trim() : text.trim();
}

/**
 * Callback that performs the actual translation. Defaults to calling the
 * active session model via @earendil-works/pi-ai. Tests can override.
 *
 * Returning `null` (or throwing) instructs the caller to fall back to the
 * original English template.
 */
export type Translator = (en: string, userHint: string, ctx: unknown) => Promise<string | null>;

export async function defaultTranslator(en: string, userHint: string, ctx: unknown): Promise<string | null> {
  const c = ctx as { model?: unknown; modelRegistry?: { getApiKeyAndHeaders?(model: unknown): Promise<{ ok?: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }> } } | undefined;
  const model = c?.model;
  const registry = c?.modelRegistry;
  if (!model || typeof registry?.getApiKeyAndHeaders !== "function") return null;
  const auth = await registry.getApiKeyAndHeaders(model);
  if (!auth?.ok || !auth?.apiKey) return null;

  const piAi: {
    streamSimple(
      model: unknown,
      opts: { messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }> },
      config: { apiKey: string; headers?: Record<string, string>; timeoutMs?: number; maxRetries?: number; signal?: AbortSignal },
    ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
  } = await import("@earendil-works/pi-ai/compat");

  const prompt = [
    "You are a vault authorization prompt localizer.",
    "Translate the prompt below into the language the user is currently speaking.",
    "",
    "Rules:",
    "1. Detect the user's language from the recent user messages, NOT from the prompt itself.",
    "2. If the user is speaking English, return the prompt UNCHANGED.",
    "3. Preserve verbatim: scope labels like `global:key-name` or `project:<id>:key-name`,",
    "   variable references like `$VAULT_*` / `$PVAULT_*` / `$GVAULT_*`, file paths, code spans,",
    "   the command preview text, and the security caveat about base64/hex/xxd/xor encoding.",
    "4. Keep the multi-line structure: one line per concept, same order.",
    "5. Output ONLY the translated prompt text. No code fence, no explanations, no quoting.",
    "",
    "### Recent user messages (for language detection)",
    userHint || "(none yet)",
    "",
    "### Prompt to translate",
    en,
  ].join("\n");

  const final = await auditStreamSimple(
    process.cwd(),
    { module: "abrain", operation: "vault_prompt_i18n", prompt_chars: prompt.length },
    piAi,
    model,
    { messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] },
    { apiKey: auth.apiKey, headers: auth.headers, timeoutMs: TRANSLATE_TIMEOUT_MS, maxRetries: 0 },
  );
  if (final.stopReason === "error" || final.stopReason === "aborted") return null;
  const text = (final.content ?? [])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("")
    .trim();
  if (!text) return null;
  return stripCodeFence(text);
}

/**
 * Localize an English prompt to the user's current conversation language.
 * Safe to call from synchronous-looking authorization paths — failure modes
 * fall back to the original English text without throwing.
 */
export async function localizePrompt(en: string, ctx: unknown, translator: Translator = defaultTranslator): Promise<string> {
  const hint = getLanguageHintSample();
  if (!hint) return en;
  const cached = cache.get(cacheKey(en, hint));
  if (cached !== undefined) return cached;
  try {
    const localized = await translator(en, hint, ctx);
    if (!localized || typeof localized !== "string") {
      rememberLocalized(en, hint, en);
      return en;
    }
    rememberLocalized(en, hint, localized);
    return localized;
  } catch {
    rememberLocalized(en, hint, en);
    return en;
  }
}

/**
 * Extract a plain-text payload from a message_start event's `message.content`,
 * which may be a string or an array of typed content parts. Returns null if
 * nothing usable was found. Used by the abrain message_start hook to track
 * the user's language.
 */
export function extractUserMessageText(message: unknown): string | null {
  const m = message as { role?: string; content?: unknown } | undefined;
  if (!m || m.role !== "user") return null;
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return null;
  const parts: string[] = [];
  for (const part of m.content) {
    if (!part || typeof part !== "object") continue;
    const obj = part as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") parts.push(obj.text);
  }
  return parts.join("\n") || null;
}
