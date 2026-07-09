import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { uniqueSessionKey } from "../_shared/session-key";

interface MessagePartLike {
  type?: unknown;
  thinking?: unknown;
}

interface AssistantMessageLike {
  role?: unknown;
  content?: unknown;
}

interface ThinkingPreserveState {
  thinking: string;
}

function sessionIdOf(ctx: ExtensionContext): string {
  return uniqueSessionKey(ctx);
}

function asMessageParts(content: unknown): MessagePartLike[] {
  return Array.isArray(content)
    ? content.filter((part): part is MessagePartLike => Boolean(part) && typeof part === "object")
    : [];
}

export function cleanThinkingPlaceholders(thinking: string): string {
  const lines = thinking
    .split(/\r?\n/)
    .filter((line) => !/^\s*<!--\s*-->\s*$/.test(line))
    .map((line) => line.replace(/[ \t]+$/g, ""));

  while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") lines.pop();

  const compactLines: string[] = [];
  for (const line of lines) {
    if (line.trim() === "" && compactLines.at(-1)?.trim() === "") continue;
    compactLines.push(line);
  }

  return compactLines.join("\n");
}

export function appendVisibleThinkingDelta(existing: string, delta: string): string {
  if (!delta) return existing;
  if (!existing) return delta;

  // Some runtimes can replay the full accumulated value as a delta-like event.
  if (delta === existing || delta.startsWith(existing)) return delta;

  // Avoid obvious duplicate replay of a large trailing chunk without hiding
  // normal short repeated words/tokens in visible thinking.
  if (delta.length >= 200 && existing.endsWith(delta)) return existing;

  const maxOverlap = Math.min(existing.length, delta.length);
  for (let size = maxOverlap; size > 0; size--) {
    if (existing.endsWith(delta.slice(0, size))) {
      return existing + delta.slice(size);
    }
  }
  return existing + delta;
}

export function isAccumulatedThinkingClearlyLonger(accumulated: string, finalThinking: string): boolean {
  const acc = cleanThinkingPlaceholders(accumulated).trim();
  const fin = cleanThinkingPlaceholders(finalThinking).trim();
  if (!acc) return false;
  if (!fin) return acc.length >= 32;
  if (acc === fin) return false;
  if (fin.includes(acc)) return false;

  const minimumDelta = Math.max(32, Math.ceil(fin.length * 0.25));
  return acc.length >= fin.length + minimumDelta;
}

export function preserveThinkingOnMessageEnd(message: unknown, accumulatedThinking: string | undefined): boolean {
  if (!message || typeof message !== "object") return false;

  const msg = message as AssistantMessageLike;
  if (msg.role !== "assistant") return false;

  const parts = asMessageParts(msg.content);
  let mutated = false;
  let replacedAccumulated = false;

  for (const part of parts) {
    if (part.type !== "thinking" || typeof part.thinking !== "string") continue;

    const cleanedFinal = cleanThinkingPlaceholders(part.thinking);
    let nextThinking = cleanedFinal;

    if (!replacedAccumulated && isAccumulatedThinkingClearlyLonger(accumulatedThinking ?? "", cleanedFinal)) {
      nextThinking = cleanThinkingPlaceholders(accumulatedThinking ?? "");
      replacedAccumulated = true;
    }

    if (part.thinking !== nextThinking) {
      part.thinking = nextThinking;
      mutated = true;
    }
  }

  return mutated;
}

export default function (pi: ExtensionAPI): void {
  const states = new Map<string, ThinkingPreserveState>();

  const clearState = (_event: unknown, ctx: ExtensionContext) => {
    states.delete(sessionIdOf(ctx));
  };

  pi.on("session_start", clearState);
  pi.on("agent_start", clearState);
  pi.on("agent_end", clearState);
  pi.on("session_shutdown", clearState);

  pi.on("message_update", (event, ctx) => {
    const assistant = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } } | undefined)?.assistantMessageEvent;
    if (!assistant || assistant.type !== "thinking_delta" || typeof assistant.delta !== "string" || assistant.delta === "") return;

    const sessionId = sessionIdOf(ctx);
    const state = states.get(sessionId) ?? { thinking: "" };
    state.thinking = appendVisibleThinkingDelta(state.thinking, assistant.delta);
    states.set(sessionId, state);
  });

  pi.on("message_end", (event, ctx) => {
    const sessionId = sessionIdOf(ctx);
    const state = states.get(sessionId);
    preserveThinkingOnMessageEnd((event as { message?: unknown } | undefined)?.message, state?.thinking);
    states.delete(sessionId);
  });
}

export const __TEST = {
  appendVisibleThinkingDelta,
  cleanThinkingPlaceholders,
  isAccumulatedThinkingClearlyLonger,
  preserveThinkingOnMessageEnd,
};
