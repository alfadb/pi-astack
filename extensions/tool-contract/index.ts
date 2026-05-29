import { defineTool, getMarkdownTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { FOOTER_STATUS_KEYS } from "../_shared/footer-status";
import { isSubAgentSession } from "../_shared/pi-internals";
import {
  FINAL_ANSWER_TOOL_NAME,
  detectProtocolMarkupMismatch,
  injectToolChoiceIntoPayload,
  type ToolChoiceInjectionResult,
} from "./payload";
import { FORCE_DISABLED, resolveToolContractSettings } from "./settings";

interface FinalAnswerDetails {
  summary: string;
}

class TopSpacer implements Component {
  constructor(private readonly child: Component) {}

  render(width: number): string[] {
    return [" ".repeat(width), ...this.child.render(width)];
  }

  invalidate(): void {
    this.child.invalidate();
  }
}

const STATUS_KEY = FOOTER_STATUS_KEYS.toolContract;

const finalAnswerTool = defineTool({
  name: FINAL_ANSWER_TOOL_NAME,
  label: "Final answer",
  description:
    "Return the final user-facing answer and terminate the current agent turn. " +
    "Use this only after you have completed all necessary work and no more tool calls are needed.",
  promptSnippet: "final_answer(summary) — finish the turn with the user-facing answer",
  promptGuidelines: [
    "When you are ready to answer the user, call final_answer with the complete user-facing answer instead of writing the answer as plain assistant text.",
    "Call any needed work tools first (read/bash/edit/write/web/memory/etc.); call final_answer only as the final action of the turn.",
    "Do not output textual tool-call markup such as <invoke>, <tool_call>, or <function_calls>; use real tool calls only.",
    "After calling final_answer, do not emit another assistant response in the same turn.",
  ],
  parameters: Type.Object({
    summary: Type.String({
      description: "Complete final answer to show to the user, in the user's language.",
    }),
  }),
  executionMode: "sequential",

  async execute(_toolCallId, params: { summary: string }) {
    const summary = String(params.summary ?? "").trim();
    return {
      content: [{ type: "text" as const, text: summary }],
      details: { summary } satisfies FinalAnswerDetails,
      terminate: true,
    };
  },

  renderResult(result, _options, theme) {
    const details = result.details as FinalAnswerDetails | undefined;
    const text = details?.summary
      ?? (result.content[0]?.type === "text" ? result.content[0].text : "");
    // Render the final answer through the Markdown component (headings, lists,
    // code blocks, tables, inline styles) instead of a raw plain-text node, so
    // it matches how normal assistant messages are displayed. Do not wrap it in
    // a custom background card: final answers should read like normal assistant
    // text, and the full-width color block is visually too heavy. Add exactly
    // one top spacer line so the final-answer block does not visually stick to
    // the preceding tool-call chrome; avoid Markdown paddingY because it would
    // add a bottom spacer too.
    return new TopSpacer(new Markdown(text, 0, 0, getMarkdownTheme()));
  },
});

function isSettingsEnabled(): boolean {
  if (FORCE_DISABLED) return false;
  return resolveToolContractSettings().enabled;
}

function setStatus(ctx: unknown, message: string | undefined): void {
  try {
    const ui = (ctx as { ui?: { setStatus?(key: string, text: string | undefined): void } } | undefined)?.ui;
    ui?.setStatus?.(STATUS_KEY, message);
  } catch {
    // Footer status is diagnostic only.
  }
}

function notify(ctx: unknown, message: string, type: "info" | "warning" | "error" = "warning"): void {
  try {
    const ui = (ctx as { ui?: { notify?(message: string, type?: "info" | "warning" | "error"): void } } | undefined)?.ui;
    ui?.notify?.(message, type);
  } catch {
    // Notification is diagnostic only.
  }
}

function modelApiFromCtx(ctx: unknown): unknown {
  return (ctx as { model?: { api?: unknown } } | undefined)?.model?.api;
}

function summarizeInjection(result: ToolChoiceInjectionResult): string | undefined {
  if (result.injected) {
    if (result.reason === "anthropic_thinking_auto") return "contract:auto";
    return result.provider === "anthropic-messages" ? "contract:any" : "contract:required";
  }
  switch (result.reason) {
    case "final_answer_not_available":
      return "contract:inactive";
    case "unsupported_provider":
      return "contract:unsupported";
    default:
      return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  if (!isSettingsEnabled()) return;

  pi.registerTool(finalAnswerTool);

  pi.registerMessageRenderer("tool-contract-warning", (message, _options, theme) => {
    const content = typeof message.content === "string" ? message.content : String(message.content ?? "");
    const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(theme.fg("warning", content), 0, 0));
    return box;
  });

  pi.on("before_provider_request", (event, ctx) => {
    const settings = resolveToolContractSettings();
    // FORCE_DISABLED is already checked before registering hooks; keep this
    // guard as defense-in-depth if factory initialization is refactored later.
    if (!settings.enabled || FORCE_DISABLED) return event.payload;
    if (settings.disableForSubAgent && isSubAgentSession(ctx)) return event.payload;

    const result = injectToolChoiceIntoPayload(event.payload, {
      modelApi: modelApiFromCtx(ctx),
      finalAnswerToolName: FINAL_ANSWER_TOOL_NAME,
    });
    const status = summarizeInjection(result);
    if (status) setStatus(ctx, status);
    return result.payload;
  });

  pi.on("message_end", (event, ctx) => {
    const settings = resolveToolContractSettings();
    // FORCE_DISABLED is already checked before registering hooks; keep this
    // guard as defense-in-depth if factory initialization is refactored later.
    if (!settings.enabled || !settings.checkMismatch || FORCE_DISABLED) return;
    if (settings.disableForSubAgent && isSubAgentSession(ctx)) return;

    const mismatch = detectProtocolMarkupMismatch(event.message);
    if (!mismatch.detected) return;

    const markerList = mismatch.markers.join(", ");
    const content =
      `⚠️ tool-contract: detected textual tool-call markup (${markerList}) in assistant text, ` +
      `but no real tool call was emitted. The provider likely treated a pseudo-tool-call as plain text. ` +
      `Preview: ${mismatch.preview}`;

    setStatus(ctx, "⚠️ protocol-mismatch");
    notify(ctx, "tool-contract: textual tool-call markup was emitted without a real tool call", "warning");
    try {
      pi.sendMessage({
        customType: "tool-contract-warning",
        content,
        display: true,
        details: mismatch,
      });
    } catch {
      // sendMessage is best-effort; footer + notify already surfaced it.
    }
  });
}

export {
  FINAL_ANSWER_TOOL_NAME,
  detectProtocolMarkupMismatch,
  injectToolChoiceIntoPayload,
};
