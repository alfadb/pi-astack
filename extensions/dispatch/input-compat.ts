/**
 * input-compat — normalize stringified/coerced arguments before schema validation.
 *
 * Part of pi-astack ADR 0009 § input compatibility contract.
 * Used as the prepareArguments hook for dispatch_agent / dispatch_parallel.
 *
 * Handles:
 *  - JSON-stringified arrays/objects (up to 2 levels of unwrap)
 *  - tools array → CSV string coercion
 *  - timeoutMs string → number coercion
 *  - task array coercion (single task → [task])
 */

// ── types ──────────────────────────────────────────────────────

export interface TaskSpec {
  id?: string;
  model: string;
  thinking: string;
  prompt: string;
  role?: string;
  tools?: string;
  timeoutMs?: number;
}

// ── core: unwrap stringified values ────────────────────────────

/**
 * Unwrap JSON-stringified values up to maxDepth levels.
 *
 * Handles the case where the model or an RPC layer stringified
 * an array/object argument. Only unwraps if the result would be
 * a different type from the input (string → object/array).
 */
export function unwrapStringified(value: unknown, maxDepth = 2): unknown {
  let current = value;
  for (let i = 0; i < maxDepth; i++) {
    if (typeof current !== "string") break;
    try {
      const parsed = JSON.parse(current);
      // Only unwrap if the result is substantively different
      if (typeof parsed !== "string") return parsed;
      current = parsed;
    } catch {
      // Not valid JSON — keep original value, let schema validator handle it
      return current;
    }
  }
  return current;
}

// ── field normalization ────────────────────────────────────────

/**
 * Normalize the tools field: array → CSV, JSON-stringified array → CSV.
 */
export function normalizeTools(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const unwrapped = unwrapStringified(raw);
  if (Array.isArray(unwrapped)) return unwrapped.join(",");
  if (typeof unwrapped === "string") return unwrapped;
  return undefined;
}

/**
 * Normalize timeoutMs: string → number.
 */
export function normalizeTimeout(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const n = Number(raw);
    return isNaN(n) ? undefined : n;
  }
  return undefined;
}

// ── task normalization ─────────────────────────────────────────

/**
 * Normalize a single task spec.
 */
export function normalizeTaskSpec(raw: unknown): TaskSpec {
  const t = (unwrapStringified(raw) as any) ?? {};

  return {
    id: t.id,
    model: String(t.model ?? ""),
    thinking: String(t.thinking ?? "low"),
    prompt: String(t.prompt ?? ""),
    role: t.role ? String(t.role) : undefined,
    tools: normalizeTools(t.tools),
    timeoutMs: normalizeTimeout(t.timeoutMs),
  };
}

/**
 * Coerce the tasks parameter: stringified array → array, single task → [task].
 *
 * Returns an empty array (NOT the raw input) when coercion fails. Returning
 * `raw as any` would let a string sneak past the `unknown[]` signature, after
 * which `String.prototype.slice` masquerades as `Array.prototype.slice` and
 * blows up with `raw.slice(...).map is not a function` two frames later. The
 * canonical failure mode is a model that hand-stringified an array whose
 * inner string contained an unescaped `"` (e.g. `"...用户给了你"推翻一切"的权力..."`),
 * which JSON.parse rejects mid-string. We surface that as an empty array so
 * `prepareArguments` can throw an actionable error instead of a cryptic one.
 */
export function coerceTasksParam(raw: unknown): unknown[] {
  const unwrapped = unwrapStringified(raw);

  if (Array.isArray(unwrapped)) return unwrapped;
  if (typeof unwrapped === "object" && unwrapped !== null && "model" in unwrapped) {
    // Single task object → wrap in array
    return [unwrapped];
  }
  // Give up — fall through to prepareArguments's actionable error path.
  return [];
}

// ── error formatting ───────────────────────────────────────────

/**
 * Format a user-friendly error for model consumption.
 *
 * Four required elements:
 *  1. Field name
 *  2. Expected type
 *  3. What was received + unwrap progress
 *  4. Corrected example
 */
export function formatCompatError(
  field: string,
  expected: string,
  got: unknown,
  example: string,
): string {
  const gotPreview =
    typeof got === "string"
      ? `string: "${got.slice(0, 100)}${got.length > 100 ? "..." : ""}"`
      : `type ${typeof got}`;

  return [
    `Field '${field}': expected ${expected}.`,
    `Got: ${gotPreview}.`,
    `Hint: ${example}`,
  ].join("\n");
}
