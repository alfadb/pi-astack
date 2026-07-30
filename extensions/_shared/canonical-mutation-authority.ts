import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { classifyForegroundLocalExecutorPosture } from "../sediment/local-executor-authority";

export const CANONICAL_MUTATION_NOT_AUTHORIZED =
  "canonical_mutation_not_authorized" as const;

export type CanonicalMutationAuthorityRole = "daemon" | "foreground_observed";

export class CanonicalMutationAuthorityError extends Error {
  readonly code = CANONICAL_MUTATION_NOT_AUTHORIZED;

  constructor() {
    super(CANONICAL_MUTATION_NOT_AUTHORIZED);
    this.name = "CanonicalMutationAuthorityError";
  }
}

export function isCanonicalMutationAuthorityError(
  error: unknown,
): error is { code: typeof CANONICAL_MUTATION_NOT_AUTHORIZED } {
  return !!error
    && typeof error === "object"
    && (error as { code?: unknown }).code === CANONICAL_MUTATION_NOT_AUTHORIZED;
}

interface CanonicalMutationAuthorityLease {
  active: boolean;
  readonly canonicalAbrainRoot: string;
  readonly role: CanonicalMutationAuthorityRole;
  readonly revalidate: () => void | Promise<void>;
}

interface CanonicalMutationAuthorityState {
  readonly version: 1;
  readonly context: AsyncLocalStorage<CanonicalMutationAuthorityLease>;
}

const STATE_KEY = Symbol.for("pi-astack/canonical-mutation-authority/state/v1");

function authorityState(): CanonicalMutationAuthorityState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[STATE_KEY] as Partial<CanonicalMutationAuthorityState> | undefined;
  if (existing?.version === 1 && existing.context instanceof AsyncLocalStorage) {
    return existing as CanonicalMutationAuthorityState;
  }
  const created: CanonicalMutationAuthorityState = {
    version: 1,
    context: new AsyncLocalStorage<CanonicalMutationAuthorityLease>(),
  };
  global[STATE_KEY] = created;
  return created;
}

const authorityContext = authorityState().context;

function closed(): never {
  throw new CanonicalMutationAuthorityError();
}

function canonicalAbrainRoot(input: string): string {
  try {
    const canonical = fs.realpathSync.native(path.resolve(input));
    const stat = fs.lstatSync(canonical);
    if (stat.isSymbolicLink() || !stat.isDirectory()) closed();
    return canonical;
  } catch (error) {
    if (error instanceof CanonicalMutationAuthorityError) throw error;
    closed();
  }
}

export interface CanonicalMutationAuthorityContextOptions {
  abrainHome: string;
  role: CanonicalMutationAuthorityRole;
  revalidate: () => void | Promise<void>;
}

/**
 * Bind a short-lived canonical mutation authority lease to one callback.
 * Detached async work may inherit the ALS value, but the shared lease is
 * invalidated as soon as the authorized callback settles.
 */
export async function withCanonicalMutationAuthority<T>(
  options: CanonicalMutationAuthorityContextOptions,
  operation: () => Promise<T> | T,
): Promise<T> {
  const lease: CanonicalMutationAuthorityLease = {
    active: true,
    canonicalAbrainRoot: canonicalAbrainRoot(options.abrainHome),
    role: options.role,
    revalidate: options.revalidate,
  };
  try {
    return await authorityContext.run(lease, async () => {
      await assertCanonicalMutationAuthorized(options.abrainHome);
      return operation();
    });
  } finally {
    lease.active = false;
  }
}

/**
 * Execution-time mutation fence. Store absence preserves legacy behavior.
 * Once the authority store exists, every mutation must carry an active lease
 * for the same canonical root and successfully revalidate at this call site.
 */
export async function assertCanonicalMutationAuthorized(abrainHome: string): Promise<void> {
  if (classifyForegroundLocalExecutorPosture(abrainHome) === "legacy") return;

  const lease = authorityContext.getStore();
  if (!lease?.active) closed();

  let root: string;
  try {
    root = canonicalAbrainRoot(abrainHome);
  } catch {
    closed();
  }
  if (lease.canonicalAbrainRoot !== root) closed();

  try {
    await lease.revalidate();
  } catch {
    closed();
  }
  if (!lease.active || authorityContext.getStore() !== lease) closed();
}
