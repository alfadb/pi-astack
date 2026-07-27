/**
 * Shared pi-router UI form transport (ADR 0022 / pi-router Web/RPC bridge).
 *
 * Used by:
 *   - prompt_user service (LLM-facing, manager + prompt_user audit lane)
 *   - vault authorization (vault_release / bash_output_release) which
 *     MUST NOT go through askPromptUser's pending manager or the
 *     prompt_user audit lane — callers own concurrency + audit.
 *
 * Security contract:
 *   - Never log PI_ROUTER_UI_TOKEN, Authorization headers, or answer
 *     plaintext (vault secrets / bash output must stay out of this
 *     layer entirely — vault only sends choice labels).
 *   - form_cancelled (409) is real user cancellation.
 *   - form_timeout / network / auth / malformed are substrate failures
 *     (never lie as user-rejected).
 */

/** Daemon-injected loopback form intake (pi-router bridge). */
export interface RouterUiEnv {
  endpoint: string;
  token: string;
  instanceId: string;
}

/**
 * Read PI_ROUTER_UI_* env. All three must be non-empty or the router
 * path is unavailable (caller falls through).
 */
export function readRouterUiEnv(
  env: NodeJS.ProcessEnv = process.env,
): RouterUiEnv | null {
  const endpoint = env.PI_ROUTER_UI_ENDPOINT?.trim() ?? "";
  const token = env.PI_ROUTER_UI_TOKEN?.trim() ?? "";
  const instanceId = env.PI_ROUTER_INSTANCE_ID?.trim() ?? "";
  if (!endpoint || !token || !instanceId) return null;
  return { endpoint, token, instanceId };
}

export type RouterFormVariant =
  | "question"
  | "vault_release"
  | "bash_output_release";

export interface RouterFormQuestion {
  id: string;
  header: string;
  question: string;
  type: string;
  options?: Array<{ label: string }>;
}

/**
 * Transport-level result. Callers map this into their own result types
 * (PromptUserResult / AskVaultAuthorizationResult) and audit lanes.
 *
 *   ok:true          — HTTP 200 with answers object (never an Array)
 *   user-rejected    — 409 form_cancelled (real user cancel on Web)
 *   cancelled        — 504 / form_timeout, or AbortSignal abort
 *                      (see `cause` to distinguish without parsing detail)
 *   ui-unavailable   — network / auth / other HTTP / malformed body
 *
 * When reason is "cancelled", `cause` is a narrow structured discriminator:
 *   - "abort"   — AbortSignal / fetch abort mid-flight
 *   - "timeout" — form_timeout / HTTP 504
 * prompt_user keeps both as PromptUserResult reason "cancelled"; only
 * vault fallback policy distinguishes them.
 */
export type RouterFormCancelCause = "abort" | "timeout";

export type RouterFormResult =
  | { ok: true; answers: Record<string, string[]> }
  | {
      ok: false;
      reason: "user-rejected" | "cancelled" | "ui-unavailable";
      detail?: string;
      /** Present only when reason === "cancelled". */
      cause?: RouterFormCancelCause;
    };

export interface PostRouterFormArgs {
  routerEnv: RouterUiEnv;
  variant: RouterFormVariant;
  reason: string;
  questions: RouterFormQuestion[];
  signal?: AbortSignal;
  /** Test seam; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * POST a form request to the pi-router daemon and map the hanging
 * HTTP response into a transport-level result.
 */
export async function postRouterForm(
  args: PostRouterFormArgs,
): Promise<RouterFormResult> {
  const { routerEnv, variant, reason, questions, signal } = args;
  const fetchImpl = args.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const body = {
    instanceId: routerEnv.instanceId,
    variant,
    reason,
    questions: questions.map((q) => ({
      id: q.id,
      header: q.header,
      question: q.question,
      type: q.type,
      ...(q.options && q.options.length > 0
        ? { options: q.options.map((o) => ({ label: o.label })) }
        : q.type === "single" || q.type === "multi"
          ? { options: [] as Array<{ label: string }> }
          : {}),
    })),
  };

  const ac = new AbortController();
  const onAbort = (): void => {
    try {
      ac.abort();
    } catch {
      /* ignore */
    }
  };

  if (signal?.aborted) {
    return {
      ok: false,
      reason: "cancelled",
      cause: "abort",
      detail: "aborted before router form request",
    };
  }
  if (signal && typeof signal.addEventListener === "function") {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    let response: Response;
    try {
      response = await fetchImpl(routerEnv.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${routerEnv.token}`,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (err) {
      if (signal?.aborted || ac.signal.aborted) {
        return {
          ok: false,
          reason: "cancelled",
          cause: "abort",
          detail: "router form request aborted",
        };
      }
      const msg = (err as Error)?.message ?? String(err);
      return {
        ok: false,
        reason: "ui-unavailable",
        detail: `router form network error: ${msg}`.slice(0, 200),
      };
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const kind =
      payload && typeof payload === "object" && payload !== null
        ? String((payload as { kind?: unknown }).kind ?? "")
        : "";
    const message =
      payload && typeof payload === "object" && payload !== null
        ? String((payload as { message?: unknown }).message ?? "")
        : "";

    if (response.status === 200) {
      const answersRaw =
        payload && typeof payload === "object" && payload !== null
          ? (payload as { answers?: unknown }).answers
          : undefined;
      // Wire contract: answers is a non-null object keyed by qid.
      // Arrays are objects in JS — reject them explicitly so a malformed
      // `{answers:[]}` cannot become ok:true with empty per-qid answers.
      if (
        !answersRaw ||
        typeof answersRaw !== "object" ||
        Array.isArray(answersRaw)
      ) {
        return {
          ok: false,
          reason: "ui-unavailable",
          detail: "router form 200 response missing answers object",
        };
      }
      const answers: Record<string, string[]> = {};
      for (const q of questions) {
        const rawVal = (answersRaw as Record<string, unknown>)[q.id];
        const asArray: string[] = Array.isArray(rawVal)
          ? rawVal.map((v) => String(v))
          : rawVal === undefined || rawVal === null
            ? []
            : [String(rawVal)];
        answers[q.id] = asArray;
      }
      return { ok: true, answers };
    }

    if (response.status === 409 && kind === "form_cancelled") {
      return {
        ok: false,
        reason: "user-rejected",
        detail: message || "router form cancelled",
      };
    }

    if (response.status === 504 || kind === "form_timeout") {
      return {
        ok: false,
        reason: "cancelled",
        cause: "timeout",
        detail: message || "router form timed out waiting for a response",
      };
    }

    return {
      ok: false,
      reason: "ui-unavailable",
      detail: `router form HTTP ${response.status}${kind ? ` (${kind})` : ""}${message ? `: ${message}` : ""}`.slice(
        0,
        200,
      ),
    };
  } finally {
    if (signal && typeof signal.removeEventListener === "function") {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
