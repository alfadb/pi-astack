#!/usr/bin/env node
/**
 * smoke-empty-visible-output-retry — verify the empty-visible-output-retry
 * extension's pure detection and mutation helpers.
 */

import { createRequire } from "node:module";
import * as path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`); }
}

const ext = jiti(path.join(repoRoot, "extensions/empty-visible-output-retry/index.ts"));
const {
  RETRYABLE_EMPTY_VISIBLE_OUTPUT_ERROR,
  shouldRetryEmptyVisibleAssistantMessage,
  markEmptyVisibleOutputAsRetryable,
} = ext.__TEST;

console.log("[1] Positive cases");
{
  const msg = {
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "I know what to answer." },
      { type: "text", text: "" },
    ],
  };
  check("thinking + empty text is retryable", shouldRetryEmptyVisibleAssistantMessage(msg));

  const whitespace = {
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "I know what to answer." },
      { type: "text", text: "  \n\t" },
    ],
  };
  check("thinking + whitespace-only text is retryable", shouldRetryEmptyVisibleAssistantMessage(whitespace));

  const emptyTextOnly = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "" }],
  };
  check("empty text-only stop is retryable", shouldRetryEmptyVisibleAssistantMessage(emptyTextOnly));
}

console.log("[2] Negative cases");
{
  check("null is ignored", !shouldRetryEmptyVisibleAssistantMessage(null));
  check("user message is ignored", !shouldRetryEmptyVisibleAssistantMessage({ role: "user", stopReason: "stop", content: [{ type: "text", text: "" }] }));
  check("error stopReason is ignored", !shouldRetryEmptyVisibleAssistantMessage({ role: "assistant", stopReason: "error", content: [{ type: "text", text: "" }] }));
  check("aborted stopReason is ignored", !shouldRetryEmptyVisibleAssistantMessage({ role: "assistant", stopReason: "aborted", content: [{ type: "text", text: "" }] }));
  check("toolUse stopReason is ignored", !shouldRetryEmptyVisibleAssistantMessage({ role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "" }] }));
  check("visible text is ignored", !shouldRetryEmptyVisibleAssistantMessage({ role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "hello" }] }));
  check("toolCall is ignored", !shouldRetryEmptyVisibleAssistantMessage({ role: "assistant", stopReason: "stop", content: [{ type: "toolCall", name: "bash" }] }));
  check("empty content array is ignored", !shouldRetryEmptyVisibleAssistantMessage({ role: "assistant", stopReason: "stop", content: [] }));
  check("string content is ignored", !shouldRetryEmptyVisibleAssistantMessage({ role: "assistant", stopReason: "stop", content: "" }));
}

console.log("[3] Mutation");
{
  const msg = {
    role: "assistant",
    stopReason: "stop",
    content: [
      { type: "thinking", thinking: "internal reasoning" },
      { type: "text", text: "" },
    ],
  };
  const mutated = markEmptyVisibleOutputAsRetryable(msg);
  check("matching message is mutated", mutated);
  check("stopReason becomes error", msg.stopReason === "error");
  check("errorMessage is retryable text", msg.errorMessage === RETRYABLE_EMPTY_VISIBLE_OUTPUT_ERROR);
  check("error text hits pi retry regex: provider returned error", /provider.?returned.?error/i.test(msg.errorMessage));
  check("error text hits pi retry regex: ended without", /ended without/i.test(msg.errorMessage));

  const normal = {
    role: "assistant",
    stopReason: "stop",
    content: [{ type: "text", text: "done" }],
  };
  const normalBefore = JSON.stringify(normal);
  check("normal message not mutated", !markEmptyVisibleOutputAsRetryable(normal));
  check("normal message unchanged", JSON.stringify(normal) === normalBefore);
}

console.log("");
console.log(`pass=${pass}, fail=${fail}`);
if (fail > 0) process.exit(1);
process.exit(0);
