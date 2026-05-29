export const FINAL_ANSWER_TOOL_NAME = "final_answer";

export type ToolContractProviderKind =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions"
  | "unknown";

export interface ToolChoiceInjectionOptions {
  /** pi Model.api, when available from ExtensionContext.model.api. */
  modelApi?: unknown;
  finalAnswerToolName?: string;
}

export interface ToolChoiceInjectionResult {
  payload: unknown;
  provider: ToolContractProviderKind;
  injected: boolean;
  reason:
    | "injected"
    | "not_object"
    | "no_tools"
    | "final_answer_not_available"
    | "unsupported_provider"
    | "anthropic_thinking_auto";
}

export interface ProtocolMarkupMismatch {
  detected: boolean;
  hasToolCall: boolean;
  markers: string[];
  preview: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function providerFromModelApi(api: unknown): ToolContractProviderKind {
  if (typeof api !== "string") return "unknown";
  switch (api) {
    case "anthropic-messages":
      return "anthropic-messages";
    case "openai-responses":
      return "openai-responses";
    case "openai-completions":
      return "openai-completions";
    default:
      return "unknown";
  }
}

function getTools(payload: unknown): unknown[] | undefined {
  if (!isRecord(payload)) return undefined;
  return Array.isArray(payload.tools) ? payload.tools : undefined;
}

function getDirectToolName(tool: unknown): string | undefined {
  return isRecord(tool) && typeof tool.name === "string" ? tool.name : undefined;
}

function getFunctionToolName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  const fn = tool.function;
  return isRecord(fn) && typeof fn.name === "string" ? fn.name : undefined;
}

function getToolName(tool: unknown, provider: ToolContractProviderKind = "unknown"): string | undefined {
  switch (provider) {
    case "openai-completions":
      return getFunctionToolName(tool) ?? getDirectToolName(tool);
    case "anthropic-messages":
    case "openai-responses":
      return getDirectToolName(tool) ?? getFunctionToolName(tool);
    default:
      return getFunctionToolName(tool) ?? getDirectToolName(tool);
  }
}

export function getPayloadToolNames(payload: unknown, provider: ToolContractProviderKind = "unknown"): string[] {
  return (getTools(payload) ?? [])
    .map((tool) => getToolName(tool, provider))
    .filter((name): name is string => typeof name === "string" && name.length > 0);
}

export function payloadHasFinalAnswerTool(
  payload: unknown,
  finalAnswerToolName = FINAL_ANSWER_TOOL_NAME,
  provider: ToolContractProviderKind = "unknown",
): boolean {
  return getPayloadToolNames(payload, provider).includes(finalAnswerToolName);
}

function countToolsWith(tools: unknown[], predicate: (tool: unknown) => boolean): number {
  return tools.reduce<number>((count, tool) => count + (predicate(tool) ? 1 : 0), 0);
}

export function inferToolContractProvider(
  payload: unknown,
  modelApi?: unknown,
): ToolContractProviderKind {
  const fromApi = providerFromModelApi(modelApi);
  if (fromApi !== "unknown") return fromApi;
  if (!isRecord(payload)) return "unknown";

  const tools = getTools(payload) ?? [];
  const anthropicTools = countToolsWith(tools, (tool) => isRecord(tool) && isRecord(tool.input_schema));
  const chatCompletionTools = countToolsWith(tools, (tool) => isRecord(tool) && isRecord(tool.function));
  const responseTools = countToolsWith(
    tools,
    (tool) => isRecord(tool) && tool.type === "function" && typeof tool.name === "string" && !isRecord(tool.function),
  );
  const maxShapeCount = Math.max(anthropicTools, chatCompletionTools, responseTools);
  const winners = [anthropicTools, chatCompletionTools, responseTools].filter((n) => n > 0 && n === maxShapeCount).length;
  if (winners === 1) {
    if (anthropicTools === maxShapeCount) return "anthropic-messages";
    if (chatCompletionTools === maxShapeCount) return "openai-completions";
    if (responseTools === maxShapeCount) return "openai-responses";
  }
  if (maxShapeCount > 0) return "unknown";

  // Fallback structure probes. Prefer payload-specific fields over generic
  // `messages`, which both Anthropic Messages and Chat Completions use.
  if (Array.isArray(payload.input)) return "openai-responses";
  if (Array.isArray(payload.system) || typeof payload.system === "string") return "anthropic-messages";
  if (Array.isArray(payload.messages)) return "openai-completions";
  return "unknown";
}

function hasAnthropicThinkingEnabled(payload: Record<string, unknown>): boolean {
  const thinking = payload.thinking;
  if (!isRecord(thinking)) return false;
  // Unknown thinking objects are treated as enabled so we avoid Anthropic's
  // 400: "Thinking may not be enabled when tool_choice forces tool use."
  return thinking.type !== "disabled";
}

export function injectToolChoiceIntoPayload(
  payload: unknown,
  options: ToolChoiceInjectionOptions = {},
): ToolChoiceInjectionResult {
  if (!isRecord(payload)) {
    return { payload, provider: "unknown", injected: false, reason: "not_object" };
  }
  const tools = getTools(payload);
  if (!tools || tools.length === 0) {
    return { payload, provider: "unknown", injected: false, reason: "no_tools" };
  }

  const finalAnswerToolName = options.finalAnswerToolName ?? FINAL_ANSWER_TOOL_NAME;
  const provider = inferToolContractProvider(payload, options.modelApi);
  if (!payloadHasFinalAnswerTool(payload, finalAnswerToolName, provider)) {
    return { payload, provider, injected: false, reason: "final_answer_not_available" };
  }

  switch (provider) {
    case "anthropic-messages": {
      const hasThinking = hasAnthropicThinkingEnabled(payload);
      return {
        payload: { ...payload, tool_choice: { type: hasThinking ? "auto" : "any" } },
        provider,
        injected: true,
        reason: hasThinking ? "anthropic_thinking_auto" : "injected",
      };
    }
    case "openai-responses":
    case "openai-completions":
      return {
        payload: { ...payload, tool_choice: "required" },
        provider,
        injected: true,
        reason: "injected",
      };
    default:
      return { payload, provider, injected: false, reason: "unsupported_provider" };
  }
}

function extractAssistantText(message: unknown): { hasToolCall: boolean; text: string } {
  if (!isRecord(message) || message.role !== "assistant") {
    return { hasToolCall: false, text: "" };
  }
  const content = Array.isArray(message.content) ? message.content : [];
  const hasToolCall = content.some((block) => isRecord(block) && block.type === "toolCall");
  const text = content
    .map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
  return { hasToolCall, text };
}

// Closed protocol markers only. Do not expand this into a prose-intent
// classifier; it detects textualized tool-call protocol tags only.
const PROTOCOL_MARKER_RE = /<\/?\s*(?:antml:)?(?:invoke|tool_call|tool_calls|function_call|function_calls|tool_use)\b/gi;

export function findTextualToolProtocolMarkers(text: string): string[] {
  const markers = new Set<string>();
  for (const match of text.matchAll(PROTOCOL_MARKER_RE)) {
    markers.add(match[0]);
  }
  return [...markers];
}

export function detectProtocolMarkupMismatch(message: unknown): ProtocolMarkupMismatch {
  const { hasToolCall, text } = extractAssistantText(message);
  const markers = hasToolCall ? [] : findTextualToolProtocolMarkers(text);
  const compact = text.replace(/\s+/g, " ").trim();
  return {
    detected: markers.length > 0,
    hasToolCall,
    markers,
    preview: compact.length > 240 ? `${compact.slice(0, 240)}…` : compact,
  };
}
