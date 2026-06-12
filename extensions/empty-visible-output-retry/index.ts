/**
 * empty-visible-output-retry — treat "stop with no visible assistant text"
 * as a retryable provider failure.
 *
 * Some providers can return an assistant message that has hidden thinking
 * content but an empty visible text block, with `stopReason: "stop"` and no
 * `errorMessage`. pi currently treats that as a successful completion, so the
 * turn appears to stop silently in the UI.
 *
 * This extension mutates such assistant messages during `message_end`, before
 * pi persists the message and before its retry counter can be reset as a
 * success. The mutation intentionally uses pi's native retry path instead of
 * implementing a parallel retry loop.
 *
 * Disable entirely: `PI_ASTACK_DISABLE_EMPTY_VISIBLE_OUTPUT_RETRY=1`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const RETRYABLE_EMPTY_VISIBLE_OUTPUT_ERROR =
	"provider returned error: ended without visible assistant text after thinking";

interface MessagePartLike {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
}

interface AssistantMessageLike {
	role?: unknown;
	stopReason?: unknown;
	errorMessage?: unknown;
	content?: unknown;
}

function asMessageParts(content: unknown): MessagePartLike[] {
	return Array.isArray(content)
		? content.filter((part): part is MessagePartLike => Boolean(part) && typeof part === "object")
		: [];
}

function textOf(part: MessagePartLike): string {
	return typeof part.text === "string" ? part.text : "";
}

function thinkingOf(part: MessagePartLike): string {
	return typeof part.thinking === "string" ? part.thinking : "";
}

/**
 * Return true when an assistant message ended normally but produced no visible
 * user-facing content. Tool-use messages are explicitly excluded: a tool call
 * without visible text is normal.
 *
 * Exported for smoke coverage.
 */
export function shouldRetryEmptyVisibleAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;

	const msg = message as AssistantMessageLike;
	if (msg.role !== "assistant" || msg.stopReason !== "stop") return false;

	const parts = asMessageParts(msg.content);
	if (parts.length === 0) return false;
	if (parts.some((part) => part.type === "toolCall")) return false;

	const visibleText = parts
		.filter((part) => part.type === "text")
		.map(textOf)
		.join("")
		.trim();
	if (visibleText !== "") return false;

	const hasTextPart = parts.some((part) => part.type === "text");
	const hasThinkingPart = parts.some(
		(part) => part.type === "thinking" && thinkingOf(part).trim() !== "",
	);

	return hasTextPart || hasThinkingPart;
}

/**
 * Mutate `message` into a pi-retryable provider error when it matches the empty
 * visible output failure mode. Returns true iff a mutation was applied.
 *
 * Exported for smoke coverage.
 */
export function markEmptyVisibleOutputAsRetryable(message: unknown): boolean {
	if (!shouldRetryEmptyVisibleAssistantMessage(message)) return false;

	const msg = message as AssistantMessageLike;
	msg.stopReason = "error";
	msg.errorMessage = RETRYABLE_EMPTY_VISIBLE_OUTPUT_ERROR;
	return true;
}

export default function (pi: ExtensionAPI) {
	if (process.env.PI_ASTACK_DISABLE_EMPTY_VISIBLE_OUTPUT_RETRY === "1") return;

	pi.on("message_end", async (event) => {
		markEmptyVisibleOutputAsRetryable(event.message);
	});
}

export const __TEST = {
	RETRYABLE_EMPTY_VISIBLE_OUTPUT_ERROR,
	shouldRetryEmptyVisibleAssistantMessage,
	markEmptyVisibleOutputAsRetryable,
};
