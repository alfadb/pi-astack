/**
 * Process-wide, provider-partitioned FIFO concurrency limiter.
 *
 * State lives under globalThis[Symbol.for(...)] so independent jiti module
 * copies share the same queues. This owner is intentionally separate from the
 * per-root TreeGovernor. Leases are in-memory only; no crash recovery is
 * claimed.
 */

export interface ProcessProviderLimiterConfig {
  scope: string;
  limits: Readonly<Record<string, number>>;
}

export interface ProviderLease {
  readonly scope: string;
  readonly provider: string;
  readonly leaseId: number;
  release(): void;
}

export interface ProviderLimiterSnapshot {
  scope: string;
  providers: Readonly<Record<string, { limit: number; active: number; pending: number }>>;
}

export type ProviderLimiterErrorCode =
  | "invalid_config"
  | "scope_config_conflict"
  | "unknown_provider"
  | "provider_disabled"
  | "acquire_aborted";

export class ProviderLimiterError extends Error {
  constructor(readonly code: ProviderLimiterErrorCode, message: string) {
    super(message);
    this.name = "ProviderLimiterError";
  }
}

interface Waiter {
  sequence: number;
  signal?: AbortSignal;
  onAbort?: () => void;
  settled: boolean;
  resolve: (lease: ProviderLease) => void;
  reject: (error: ProviderLimiterError) => void;
}

interface ProviderState {
  limit: number;
  active: number;
  queue: Waiter[];
}

interface ScopeState {
  scope: string;
  signature: string;
  providers: Map<string, ProviderState>;
  nextWaiterSequence: number;
  nextLeaseId: number;
}

interface ProcessLimiterSharedState {
  scopes: Map<string, ScopeState>;
}

const PROCESS_LIMITER_KEY = Symbol.for("pi-astack/dispatch/process-provider-limiter/v1");

function sharedState(): ProcessLimiterSharedState {
  const root = globalThis as Record<symbol, unknown>;
  let state = root[PROCESS_LIMITER_KEY] as ProcessLimiterSharedState | undefined;
  if (!state || !(state.scopes instanceof Map)) {
    state = { scopes: new Map<string, ScopeState>() };
    root[PROCESS_LIMITER_KEY] = state;
  }
  return state;
}

function invalid(message: string): never {
  throw new ProviderLimiterError("invalid_config", message);
}

function name(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 128 || /\s/.test(value)) {
    return invalid(`${field} must be a non-empty name without whitespace`);
  }
  return value;
}

function limit(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    return invalid(`${field} must be a finite non-negative integer`);
  }
  return value;
}

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeConfig(config: ProcessProviderLimiterConfig): {
  scope: string;
  entries: Array<[string, number]>;
  signature: string;
} {
  if (!config || typeof config !== "object") return invalid("provider limiter config is required");
  const scope = name(config.scope, "scope");
  if (!config.limits || typeof config.limits !== "object" || Array.isArray(config.limits)) {
    return invalid("limits must be an explicit provider-to-limit object");
  }
  const entries = Object.entries(config.limits)
    .map(([provider, value]) => [name(provider, "provider"), limit(value, `limits.${provider}`)] as [string, number])
    .sort(([a], [b]) => compareCodeUnits(a, b));
  if (entries.length === 0) return invalid("limits must declare at least one provider");
  return { scope, entries, signature: JSON.stringify(entries) };
}

function getOrCreateScope(config: ProcessProviderLimiterConfig): ScopeState {
  const normalized = normalizeConfig(config);
  const scopes = sharedState().scopes;
  const existing = scopes.get(normalized.scope);
  if (existing) {
    if (existing.signature !== normalized.signature) {
      throw new ProviderLimiterError(
        "scope_config_conflict",
        `provider limiter scope ${normalized.scope} already exists with different limits`,
      );
    }
    return existing;
  }
  const created: ScopeState = {
    scope: normalized.scope,
    signature: normalized.signature,
    providers: new Map(normalized.entries.map(([provider, providerLimit]) => [
      provider,
      { limit: providerLimit, active: 0, queue: [] },
    ])),
    nextWaiterSequence: 1,
    nextLeaseId: 1,
  };
  scopes.set(normalized.scope, created);
  return created;
}

function cleanWaiter(waiter: Waiter): void {
  if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
  waiter.onAbort = undefined;
}

function pump(scope: ScopeState, provider: string, state: ProviderState): void {
  while (state.active < state.limit && state.queue.length > 0) {
    const waiter = state.queue.shift()!;
    if (waiter.settled || waiter.signal?.aborted) {
      if (!waiter.settled) {
        waiter.settled = true;
        cleanWaiter(waiter);
        waiter.reject(new ProviderLimiterError("acquire_aborted", `provider ${provider} acquire was aborted`));
      }
      continue;
    }
    waiter.settled = true;
    cleanWaiter(waiter);
    state.active++;
    const leaseId = scope.nextLeaseId++;
    let released = false;
    const lease: ProviderLease = Object.freeze({
      scope: scope.scope,
      provider,
      leaseId,
      release: () => {
        if (released) return;
        released = true;
        state.active--;
        pump(scope, provider, state);
      },
    });
    waiter.resolve(lease);
  }
}

export class ProcessProviderLimiter {
  private readonly state: ScopeState;

  constructor(config: ProcessProviderLimiterConfig) {
    this.state = getOrCreateScope(config);
  }

  acquire(providerInput: string, options: { signal?: AbortSignal } = {}): Promise<ProviderLease> {
    const provider = name(providerInput, "provider");
    const state = this.state.providers.get(provider);
    if (!state) {
      return Promise.reject(new ProviderLimiterError(
        "unknown_provider",
        `provider ${provider} has no configured process limit`,
      ));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ProviderLimiterError("acquire_aborted", `provider ${provider} acquire was aborted`));
    }
    if (state.limit === 0) {
      return Promise.reject(new ProviderLimiterError("provider_disabled", `provider ${provider} is disabled`));
    }

    return new Promise<ProviderLease>((resolve, reject) => {
      const waiter: Waiter = {
        sequence: this.state.nextWaiterSequence++,
        signal: options.signal,
        settled: false,
        resolve,
        reject,
      };
      if (options.signal) {
        waiter.onAbort = () => {
          if (waiter.settled) return;
          waiter.settled = true;
          const index = state.queue.indexOf(waiter);
          if (index >= 0) state.queue.splice(index, 1);
          cleanWaiter(waiter);
          reject(new ProviderLimiterError("acquire_aborted", `provider ${provider} acquire was aborted`));
          pump(this.state, provider, state);
        };
        options.signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      state.queue.push(waiter);
      pump(this.state, provider, state);
    });
  }

  snapshot(): ProviderLimiterSnapshot {
    const providers: Record<string, { limit: number; active: number; pending: number }> = {};
    for (const [provider, state] of [...this.state.providers.entries()].sort(([a], [b]) => compareCodeUnits(a, b))) {
      providers[provider] = {
        limit: state.limit,
        active: state.active,
        pending: state.queue.filter((waiter) => !waiter.settled).length,
      };
    }
    return { scope: this.state.scope, providers };
  }
}
