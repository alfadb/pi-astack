/**
 * ADR 0022 §D11 / INV-K (extended 2026-05-20 Batch B D7): cross-extension
 * defer check for compaction-tuner against the vault authorization
 * overlay.
 *
 * Symmetric to `./prompt-user-defer.ts` — same hook pattern (`globalThis`
 * lookup populated by `abrain/index.ts` activate()), same defense-in-depth
 * semantics (hook failure never blocks compaction), separate module so it
 * can be smoke-tested in isolation without staging the rest of the
 * compaction-tuner cross-extension dependency chain.
 *
 * Why a separate hook from prompt_user (not a single "any overlay" flag):
 *   - Different audit reasons aid debugging ("vault_dialog_pending" vs
 *     "prompt_user_pending"). Operators chasing "why didn't compaction
 *     fire at 90%?" need to know which substrate held it.
 *   - The two substrates have independent grant/concurrency semantics
 *     (INV-E vs INV-I) and may diverge in future. Coupling them through
 *     one boolean hook would force every future divergence to leak into
 *     compaction-tuner.
 *   - prompt_user returns a count (you can have ≥1 pending if multiple
 *     callers acquire); vault returns a boolean (vault never queues —
 *     concurrent gate rejects). Mixing types in one hook is brittle.
 *
 * Why a function returning boolean (not the flag itself):
 *   - Encapsulates "what counts as blocking" in one place. Future
 *     refinements (e.g. "block only if dialog older than 5s") edit one
 *     line here without touching the trigger path.
 *   - Defense-in-depth: hook can throw / return wrong type without
 *     breaking compaction. Returning bool means callers can't
 *     accidentally use a poisoned value.
 */

/**
 * Returns true iff a vault authorization dialog is currently waiting on
 * user input. Used by `compaction-tuner` to defer compaction during the
 * authorization overlay (ADR 0022 §D11 / INV-K extended).
 *
 * Semantics:
 *   - Hook absent       → false (abrain not loaded; compaction proceeds)
 *   - Hook returns false→ false (no pending vault dialog)
 *   - Hook returns true → true  (defer compaction)
 *   - Hook returns ≠ bool (truthy/falsy/non-bool) → false (strict guard
 *                          mirrors prompt-user-defer's "don't trust
 *                          poisoned values")
 *   - Hook throws       → false (defense-in-depth; user-visible
 *                          compaction failures are WORSE than missing a
 *                          single INV-K defer)
 *
 * The hook itself is wired by `abrain/index.ts` activate() as:
 *
 *   Object.defineProperty(globalThis, "__abrainVaultDialogInFlight", {
 *     value: () => isVaultDialogInFlight(),
 *     configurable: false, writable: false, enumerable: false,
 *   });
 */
export function isPendingVaultDialogBlocking(): boolean {
  const hook = (globalThis as { __abrainVaultDialogInFlight?: () => boolean })
    .__abrainVaultDialogInFlight;
  if (typeof hook !== "function") return false;
  try {
    const v = hook();
    return v === true;
  } catch {
    return false;
  }
}
