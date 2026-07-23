#!/usr/bin/env node
/**
 * smoke-foldable-tool-results verifies pi's native Ctrl+O expand/collapse
 * wiring for extension tools. The core ToolExecutionComponent owns the
 * expanded state and passes options.expanded/options.isPartial plus render
 * context into ToolDefinition.renderResult. These tools should only consume
 * that state; they must not introduce a separate keybinding or state machine.
 *
 * Run: node scripts/smoke-foldable-tool-results.mjs
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const jiti = createJiti(import.meta.url);

let fails = 0;
const ok = (condition, message) => {
  console.log(`${condition ? "PASS" : "FAIL"}: ${message}`);
  if (!condition) fails++;
};

const theme = {
  fg: (_role, text) => text,
  bold: (text) => text,
};

const webSearchSrc = fs.readFileSync(path.join(root, "extensions/web-search/index.ts"), "utf-8");
const memorySrc = fs.readFileSync(path.join(root, "extensions/memory/index.ts"), "utf-8");
const context7Src = fs.readFileSync(path.join(root, "extensions/context7/index.ts"), "utf-8");

function toolBlock(src, name) {
  const idx = src.indexOf(`name: "${name}"`);
  if (idx === -1) return null;
  const nextIdx = src.indexOf("pi.registerTool({", idx + 1);
  return src.slice(idx, nextIdx === -1 ? src.length : nextIdx);
}

for (const name of ["web_search", "web_fetch"]) {
  const block = toolBlock(webSearchSrc, name);
  ok(!!block, `web-search/index.ts registers ${name}`);
  ok(!!block && /renderResult\s*:/.test(block), `${name} registerTool() has renderResult wired`);
}
for (const name of ["memory_search", "abrain_get", "memory_list", "memory_activity", "memory_decide"]) {
  const block = toolBlock(memorySrc, name);
  ok(!!block, `memory/index.ts registers ${name}`);
  ok(!!block && /renderResult\s*:/.test(block), `${name} registerTool() has renderResult wired`);
}
for (const name of ["context7_resolve", "context7_docs"]) {
  const block = toolBlock(context7Src, name);
  ok(!!block, `context7/index.ts registers ${name}`);
  ok(!!block && /renderResult\s*:/.test(block), `${name} registerTool() has renderResult wired`);
}

const { renderFoldableToolResult, __foldableToolResultTest } = await jiti.import(
  path.join(root, "extensions/_shared/foldable-tool-result.ts"),
);
const { visibleTextWidth } = __foldableToolResultTest;

function textResult(text, extra = {}) {
  return { content: [{ type: "text", text }], details: {}, ...extra };
}

function renderLines(result, options, context) {
  const view = renderFoldableToolResult(result, options, theme, {
    toolName: "smoke_tool",
    fullOutputLabel: "smoke tool",
  }, context);
  return view.render(40);
}

function assertLinesFitWidth(lines, width, label) {
  const bad = lines.filter((line) => visibleTextWidth(line) > width);
  ok(bad.length === 0, `${label}: every render() line <= width ${width} (bad=${JSON.stringify(bad)})`);
}

{
  const longText = Array.from({ length: 20 }, (_, i) => `line ${i}: ${"x".repeat(60)}`).join("\n");
  const lines = renderLines(textResult(longText), { expanded: false, isPartial: false });
  assertLinesFitWidth(lines, 40, "folded multiline");
  ok(lines.length <= 7, "folded multiline: preview is capped to 6 lines plus hint");
  ok(lines.some((line) => /expand for full smoke tool output/.test(line)), "folded multiline: has expand hint");
  ok(!lines.some((line) => line.includes("line 15:")), "folded multiline: tail lines are hidden");
}

{
  const oneHugeLine = "x".repeat(5000);
  const lines = renderLines(textResult(oneHugeLine), { expanded: false, isPartial: false });
  assertLinesFitWidth(lines, 40, "folded huge single line");
  ok(lines.length === 2, "folded huge single line: one preview line plus hint, no wrapped flood");
}

{
  const longText = Array.from({ length: 20 }, (_, i) => `line ${i}: content`).join("\n");
  const lines = renderLines(textResult(longText), { expanded: true, isPartial: false });
  assertLinesFitWidth(lines, 40, "expanded");
  ok(lines.some((line) => line.includes("line 0:")), "expanded: includes first line");
  ok(lines.some((line) => line.includes("line 19:")), "expanded: includes last line");
  ok(!lines.some((line) => /expand for full/.test(line)), "expanded: no expand hint appended");
}

{
  const errText = "web_fetch failed: getaddrinfo ENOTFOUND example.invalid\nsecond diagnostic line";
  const lines = renderLines(textResult(errText), { expanded: false, isPartial: false }, { isError: true });
  assertLinesFitWidth(lines, 40, "error folded");
  const joined = lines.join("");
  ok(joined.includes("ENOTFOUND"), "error result: failure reason visible while folded");
  ok(lines.some((line) => line.includes("second diagnostic line")), "error result: full error text rendered from context.isError");
}

{
  const text = "a".repeat(200);
  const lines = renderLines(textResult(text), { expanded: true, isPartial: false });
  assertLinesFitWidth(lines, 40, "expanded long unbroken line");
}

{
  const view = renderFoldableToolResult(textResult("partial streaming body"), { expanded: false, isPartial: true }, theme, {
    toolName: "smoke_tool",
    fullOutputLabel: "smoke tool",
  });
  const lines = view.render(40);
  assertLinesFitWidth(lines, 40, "partial");
  ok(lines.length === 1 && /expand for full smoke tool output/.test(lines[0]), "partial: one-line expand placeholder");
}

console.log(fails === 0 ? "\nAll smoke checks passed." : `\n${fails} smoke check(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
