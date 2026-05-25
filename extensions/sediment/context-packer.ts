/**
 * context-packer — build token-budgeted classifier input window (ADR 0025 §4.1.2).
 *
 * Takes the full branch and constructs a ConversationWindow optimized for
 * the correction classifier.  Different from buildRunWindow (which serves
 * the extractor): the classifier needs only the most recent turns since
 * correction signals are typically in the latest user/assistant exchange.
 *
 * Target: ~30K tokens (~120K chars), ~50 most recent entries.
 */

import { entryToText } from "./checkpoint";
import { getCurrentRuleInjectionNonce, stripCurrentRuleInjection } from "../abrain/rule-injector";

export interface ConversationTurn {
  role: string;
  text: string;
  timestamp: string;
}

export interface PackedWindow {
  turns: ConversationTurn[];
  chars: number;
  estimatedTokens: number;
}

const TARGET_CHARS = 120_000;   // ~30K tokens
const MAX_ENTRIES = 50;

/**
 * Build a packed conversation window from the most recent branch entries.
 * Truncates individual entries at 20K chars to prevent large tool outputs
 * from dominating the window.
 */
export function packClassifierWindow(branchEntries: unknown[]): PackedWindow {
  const maxEntryChars = 20_000;
  const candidates = branchEntries.slice(-MAX_ENTRIES);
  const turns: ConversationTurn[] = [];
  let chars = 0;

  for (let i = candidates.length - 1; i >= 0; i--) {
    const entry = candidates[i];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const type = typeof e.type === "string" ? e.type : "unknown";
    const timestamp = typeof e.timestamp === "string" ? e.timestamp : "";

    // Only include message-type entries (user, assistant, toolResult, bashExecution)
    if (type !== "message" || !e.message || typeof e.message !== "object") continue;
    const msg = e.message as Record<string, unknown>;
    const role = typeof msg.role === "string" ? msg.role : "unknown";

    // Build text representation
    let text: string;
    if (role === "toolResult") {
      const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
      const content = stripCurrentRules(extractTextContent(msg.content));
      text = `[toolResult:${toolName}]\n${truncate(content, maxEntryChars)}`;
    } else if (role === "bashExecution") {
      const cmd = typeof msg.command === "string" ? msg.command : "";
      const exitCode = typeof msg.exitCode === "number" ? String(msg.exitCode) : "?";
      const output = stripCurrentRules(typeof msg.output === "string" ? msg.output : extractTextContent(msg.content));
      text = `[bashExecution] cmd: ${cmd} (exit ${exitCode})\n${truncate(output, maxEntryChars)}`;
    } else {
      text = truncate(stripCurrentRules(extractTextContent(msg.content)), maxEntryChars);
    }

    if (turns.length > 0 && chars + text.length > TARGET_CHARS) break;

    turns.push({ role, text, timestamp });
    chars += text.length;
  }

  turns.reverse();
  return {
    turns,
    chars,
    estimatedTokens: Math.ceil(chars / 3),
  };
}

/**
 * Build a plain-text transcript from packed turns for the classifier prompt.
 */
export function packedWindowToText(window: PackedWindow): string {
  return window.turns
    .map((t) => `[${t.role}] ${t.timestamp ? `(${t.timestamp.slice(0, 19)}) ` : ""}${t.text}`)
    .join("\n\n");
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") return p.text;
      if (p.type === "thinking" && typeof p.thinking === "string") return `[thinking] ${p.thinking}`;
      if (p.type === "toolCall") return `[toolCall:${String(p.name ?? "?")}] ${JSON.stringify(p.arguments ?? {})}`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function stripCurrentRules(text: string): string {
  return stripCurrentRuleInjection(text, getCurrentRuleInjectionNonce());
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.8);
  const tail = maxChars - head;
  return text.slice(0, head) + `\n[... truncated ${text.length - head - tail} chars ...]\n` + text.slice(text.length - tail);
}
