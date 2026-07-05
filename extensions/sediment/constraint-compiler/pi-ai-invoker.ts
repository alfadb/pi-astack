import type {
  ConstraintCompilerInvokeResult,
  ConstraintCompilerInvoker,
} from "./types";
import { auditStreamSimple } from "../../_shared/llm-audit";

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

interface StreamSimpleLike {
  streamSimple(
    model: unknown,
    opts: { messages: unknown[] },
    config: { apiKey: string; headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number; maxRetries?: number },
  ): { result(): Promise<{ stopReason?: string; errorMessage?: string; content?: Array<{ type: string; text?: string }> }> };
}

function parseModelRef(modelRef: string): { provider: string; modelId: string } | null {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) return null;
  return { provider: modelRef.slice(0, slash), modelId: modelRef.slice(slash + 1) };
}

function extractText(content: Array<{ type: string; text?: string }> | undefined): string {
  return (content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

export function createPiAiConstraintCompilerInvoker(input: {
  modelRegistry: ModelRegistryLike;
  defaultModelRef: string;
  timeoutMs?: number;
  maxRetries?: number;
  streamSimpleImpl?: StreamSimpleLike;
  projectRoot?: string;
}): ConstraintCompilerInvoker {
  return async (request): Promise<ConstraintCompilerInvokeResult> => {
    const modelRef = request.modelRef || input.defaultModelRef;
    const started = Date.now();
    const parsed = parseModelRef(modelRef);
    if (!parsed) {
      return { ok: false, error: `invalid model ref ${modelRef || "<empty>"}; expected provider/model`, modelRef };
    }

    const model = input.modelRegistry.find(parsed.provider, parsed.modelId);
    if (!model) {
      return { ok: false, error: `model not found: ${modelRef}`, modelRef };
    }

    const auth = await input.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      return { ok: false, error: `model auth unavailable: ${auth.error || "missing api key"}`, modelRef };
    }

    const piAi: StreamSimpleLike = input.streamSimpleImpl ?? await import("@earendil-works/pi-ai/compat") as StreamSimpleLike;
    const result = await auditStreamSimple(
      input.projectRoot ?? process.cwd(),
      { module: "sediment", operation: "constraint_compiler", model_ref: modelRef, prompt_chars: request.prompt.text.length },
      piAi,
      model,
      { messages: [{ role: "user", content: [{ type: "text", text: request.prompt.text }] }] },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        signal: request.signal,
        timeoutMs: input.timeoutMs ?? 1_200_000,
        maxRetries: input.maxRetries ?? 0,
      },
    );
    const durationMs = Date.now() - started;
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      return { ok: false, error: result.errorMessage || result.stopReason || "model call failed", modelRef, durationMs };
    }

    const text = extractText(result.content);
    if (!text) {
      return { ok: false, error: "model returned empty text", modelRef, durationMs };
    }

    return { ok: true, text, modelRef, durationMs };
  };
}
