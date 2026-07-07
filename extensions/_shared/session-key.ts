const anonymousSessionIds = new WeakMap<object, string>();
let anonymousSessionCounter = 0;

export interface SessionKeyContext {
  sessionManager?: unknown;
}

export function uniqueSessionKey(ctx: SessionKeyContext): string {
  const sm = ctx.sessionManager;
  const accessors = isWeakMapKey(sm)
    ? sm as { getSessionId?: unknown; getSessionFile?: unknown }
    : undefined;

  const explicitId = callStringAccessor(accessors?.getSessionId, accessors) ?? callStringAccessor(accessors?.getSessionFile, accessors);
  if (explicitId) return explicitId;

  const identity = isWeakMapKey(sm) ? sm : isWeakMapKey(ctx) ? ctx : undefined;
  if (!identity) {
    anonymousSessionCounter += 1;
    return `anonymous:${anonymousSessionCounter}`;
  }

  let anonymousId = anonymousSessionIds.get(identity);
  if (!anonymousId) {
    anonymousSessionCounter += 1;
    anonymousId = `anonymous:${anonymousSessionCounter}`;
    anonymousSessionIds.set(identity, anonymousId);
  }
  return anonymousId;
}

function callStringAccessor(accessor: unknown, receiver: object | undefined): string | undefined {
  if (typeof accessor !== "function") return undefined;
  try {
    const value = accessor.call(receiver);
    return typeof value === "string" && value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function isWeakMapKey(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}
