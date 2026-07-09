#!/usr/bin/env node
/**
 * Deterministic smoke for thinking-preserve.
 * No LLM, no secrets, no provider calls.
 */
import { createJiti } from "jiti";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const mod = await jiti.import(path.join(__dirname, "..", "extensions/thinking-preserve/index.ts"));
const registerThinkingPreserve = mod.default ?? mod;
const {
  appendVisibleThinkingDelta,
  cleanThinkingPlaceholders,
  isAccumulatedThinkingClearlyLonger,
  preserveThinkingOnMessageEnd,
} = mod.__TEST;

let fails = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`);
  if (!cond) fails++;
};

function createHarness() {
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      handlers.set(name, handler);
    },
  };
  registerThinkingPreserve(pi);

  const emitUpdate = (ctx, assistantMessageEvent) => {
    handlers.get("message_update")?.({ type: "message_update", assistantMessageEvent }, ctx);
  };
  const emitEnd = (ctx, message) => {
    handlers.get("message_end")?.({ type: "message_end", message }, ctx);
  };
  const emitLifecycle = (ctx, name) => {
    handlers.get(name)?.({ type: name }, ctx);
  };

  return { handlers, emitUpdate, emitEnd, emitLifecycle };
}

function ctx(id) {
  return { sessionManager: { getSessionId: () => id } };
}

function assistantMessage(thinking, extra = {}) {
  return {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking,
        thinkingSignature: "sig-preserved",
        encrypted_content: "opaque-not-read",
        ...extra,
      },
      { type: "text", text: "visible answer <!-- --> stays untouched" },
    ],
  };
}

// Pure helpers.
{
  ok(
    cleanThinkingPlaceholders("before\n<!-- -->\n after  \n") === "before\n after",
    "standalone placeholder line is removed and whitespace is trimmed in thinking",
  );
  ok(
    cleanThinkingPlaceholders("inline <!-- --> marker stays") === "inline <!-- --> marker stays",
    "inline placeholder-looking text is not removed",
  );
  ok(
    appendVisibleThinkingDelta("hello ", "hello world") === "hello world",
    "cumulative delta replay replaces the accumulated value instead of duplicating it",
  );
  ok(
    !isAccumulatedThinkingClearlyLonger("short visible thinking", "a much longer final summary that should win"),
    "shorter accumulated thinking is not considered clearly longer",
  );
}

// 1) Accumulated visible thinking replaces a much shorter final summary.
{
  const h = createHarness();
  const c = ctx("replace-session");
  const visibleThinking = [
    "First visible reasoning paragraph with concrete details.\n",
    "Second visible reasoning paragraph that upstream later summarized.\n",
    "Third visible reasoning paragraph kept from thinking_delta.\n",
  ];
  for (const delta of visibleThinking) h.emitUpdate(c, { type: "thinking_delta", delta });

  const msg = assistantMessage("Brief summary.");
  h.emitEnd(c, msg);

  ok(
    msg.content[0].thinking === visibleThinking.join("").trim(),
    "message_end replaces short final thinking summary with accumulated visible thinking",
  );
  ok(msg.content[0].thinkingSignature === "sig-preserved", "replacement preserves thinkingSignature");
  ok(msg.content[0].encrypted_content === "opaque-not-read", "replacement preserves opaque encrypted_content field");
  ok(msg.content[1].text === "visible answer <!-- --> stays untouched", "assistant text block is not cleaned or modified");

  h.emitEnd(c, msg);
  ok(
    msg.content[0].thinking === visibleThinking.join("").trim(),
    "second message_end after state cleanup does not duplicate or grow thinking",
  );
}

// 2) Summary/no longer delta does not incorrectly expand final thinking.
{
  const h = createHarness();
  const c = ctx("no-expand-session");
  h.emitUpdate(c, { type: "thinking_delta", delta: "brief stream" });

  const finalThinking = "This final thinking is longer and more specific than the brief stream.";
  const msg = assistantMessage(finalThinking);
  h.emitEnd(c, msg);

  ok(msg.content[0].thinking === finalThinking, "longer final thinking is left unchanged");
}

// 3) Standalone placeholder lines are removed only from thinking blocks.
{
  const msg = assistantMessage("before\n\n<!-- -->\n\nafter\n");
  const changed = preserveThinkingOnMessageEnd(msg, undefined);

  ok(changed, "placeholder cleanup reports a mutation");
  ok(msg.content[0].thinking === "before\n\nafter", "standalone placeholder line is removed from thinking block");
  ok(msg.content[1].text.includes("<!-- -->"), "placeholder in normal assistant text is untouched");
}

// 4) Lifecycle clears state and sessions stay isolated.
{
  const h = createHarness();
  const a = ctx("session-A");
  const b = ctx("session-B");

  h.emitUpdate(a, { type: "thinking_delta", delta: "A visible thinking that should be cleared by lifecycle. ".repeat(3) });
  h.emitUpdate(b, { type: "thinking_delta", delta: "B visible thinking that remains isolated and available. ".repeat(3) });
  h.emitLifecycle(a, "agent_start");

  const msgA = assistantMessage("A summary.");
  h.emitEnd(a, msgA);
  ok(msgA.content[0].thinking === "A summary.", "agent_start clears state for that session");

  const msgB = assistantMessage("B summary.");
  h.emitEnd(b, msgB);
  ok(
    msgB.content[0].thinking.startsWith("B visible thinking") && !msgB.content[0].thinking.includes("A visible thinking"),
    "lifecycle cleanup does not leak across sessions",
  );
}

// Extension registers the intended hooks.
{
  const h = createHarness();
  for (const name of ["message_update", "message_end", "session_start", "agent_start", "agent_end", "session_shutdown"]) {
    ok(h.handlers.has(name), `extension registers ${name}`);
  }
}

console.log(fails === 0 ? "\nALL PASS - thinking preserve" : `\n${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
