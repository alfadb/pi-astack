#!/usr/bin/env node
/**
 * Smoke test: abrain vault prompt localizer.
 *
 * Verifies:
 *   - recordUserMessage / getLanguageHintSample ring behavior
 *   - extractUserMessageText handles string + array content shapes
 *   - localizePrompt falls back to English when no user context exists
 *   - localizePrompt calls the translator with hint + caches by (en, hint)
 *   - localizePrompt falls back to English on translator failure
 *   - no plaintext leakage in translator argument (only English template +
 *     recent user messages — both already in LLM context)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-i18n-"));
fs.writeFileSync(
  path.join(tmpDir, "llm-audit.cjs"),
  `module.exports = { auditStreamSimple: async () => ({ stopReason: "error", content: [] }) };\n`,
);
const i18nCjs = transpile(path.join(repoRoot, "extensions/abrain/i18n.ts"))
  .replace(/require\("\.\.\/_shared\/llm-audit"\)/g, 'require("./llm-audit.cjs")');
fs.writeFileSync(path.join(tmpDir, "i18n.cjs"), i18nCjs);
const i18n = require(path.join(tmpDir, "i18n.cjs"));

console.log("abrain — vault prompt localizer");

i18n.__resetI18nForTests();

await check("recordUserMessage trims, dedups whitespace, and bounds ring length", () => {
  i18n.__resetI18nForTests();
  i18n.recordUserMessage("  hello   world  ");
  i18n.recordUserMessage("second");
  i18n.recordUserMessage("third");
  i18n.recordUserMessage("fourth"); // ring max = 3, oldest should drop
  const sample = i18n.getLanguageHintSample();
  if (sample.includes("hello")) throw new Error(`oldest entry should be dropped: ${sample}`);
  if (!sample.includes("fourth")) throw new Error(`newest entry missing: ${sample}`);
});

await check("recordUserMessage truncates very long content", () => {
  i18n.__resetI18nForTests();
  i18n.recordUserMessage("x".repeat(5000));
  const sample = i18n.getLanguageHintSample();
  if (sample.length > 1300) throw new Error(`expected truncation, got length=${sample.length}`);
});

await check("extractUserMessageText accepts string content", () => {
  const text = i18n.extractUserMessageText({ role: "user", content: "你好" });
  if (text !== "你好") throw new Error(`got ${JSON.stringify(text)}`);
});

await check("extractUserMessageText accepts array of text parts", () => {
  const text = i18n.extractUserMessageText({
    role: "user",
    content: [{ type: "text", text: "你" }, { type: "image", url: "x" }, { type: "text", text: "好" }],
  });
  if (text !== "你\n好") throw new Error(`got ${JSON.stringify(text)}`);
});

await check("extractUserMessageText rejects non-user roles", () => {
  if (i18n.extractUserMessageText({ role: "assistant", content: "hi" }) !== null) throw new Error("must be null");
  if (i18n.extractUserMessageText(null) !== null) throw new Error("null must be null");
});

await check("localizePrompt falls back to English when no user context exists", async () => {
  i18n.__resetI18nForTests();
  let translatorCalled = 0;
  const translator = async () => { translatorCalled++; return "should not be called"; };
  const out = await i18n.localizePrompt("Release vault secret global:foo?", {}, translator);
  if (out !== "Release vault secret global:foo?") throw new Error(`unexpected: ${out}`);
  if (translatorCalled !== 0) throw new Error("translator must not be called without user context");
});

await check("localizePrompt calls translator with English + hint, returns its output, and caches", async () => {
  i18n.__resetI18nForTests();
  i18n.recordUserMessage("帮我看下当前 vault 设置");
  let translatorCalls = 0;
  let seenEn, seenHint;
  const translator = async (en, hint) => {
    translatorCalls++;
    seenEn = en;
    seenHint = hint;
    return "把 global:foo 释放给 LLM 吗？";
  };
  const first = await i18n.localizePrompt("Release vault secret global:foo?", { model: {}, modelRegistry: {} }, translator);
  if (first !== "把 global:foo 释放给 LLM 吗？") throw new Error(`first call wrong: ${first}`);
  if (translatorCalls !== 1) throw new Error(`expected 1 call, got ${translatorCalls}`);
  if (!seenEn.includes("global:foo")) throw new Error(`translator did not receive English`);
  if (!seenHint.includes("帮我看下")) throw new Error(`translator did not receive user hint`);
  // Same template + same hint → cache hit, no second call.
  const second = await i18n.localizePrompt("Release vault secret global:foo?", { model: {}, modelRegistry: {} }, translator);
  if (translatorCalls !== 1) throw new Error(`cache miss: translator called ${translatorCalls} times`);
  if (second !== first) throw new Error(`cached value mismatch`);
});

await check("localizePrompt falls back to English on translator failure", async () => {
  i18n.__resetI18nForTests();
  i18n.recordUserMessage("用户在用中文");
  const translator = async () => { throw new Error("simulated llm timeout"); };
  const out = await i18n.localizePrompt("Plaintext warning", {}, translator);
  if (out !== "Plaintext warning") throw new Error(`should fall back: ${out}`);
});

await check("localizePrompt falls back to English on null translator result", async () => {
  i18n.__resetI18nForTests();
  i18n.recordUserMessage("a");
  const translator = async () => null;
  const out = await i18n.localizePrompt("hello", {}, translator);
  if (out !== "hello") throw new Error(`expected English fallback, got: ${out}`);
});

await check("localizePrompt translator receives no secret material", async () => {
  i18n.__resetI18nForTests();
  i18n.recordUserMessage("user-input");
  let receivedEn, receivedHint;
  const translator = async (en, hint) => { receivedEn = en; receivedHint = hint; return en; };
  const englishWithSecretPathRef = "Release bash output? command: $VAULT_token";
  await i18n.localizePrompt(englishWithSecretPathRef, {}, translator);
  if (receivedEn !== englishWithSecretPathRef) throw new Error("translator should receive only the English template");
  if (receivedHint !== "user-input") throw new Error("hint should be only recent user messages");
});

await check("defaultTranslator returns null when no model/registry are present in ctx", async () => {
  const out = await i18n.defaultTranslator("hi", "你好", { /* no model, no modelRegistry */ });
  if (out !== null) throw new Error(`expected null, got ${out}`);
});

fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log(`all ok — vault prompt localizer holds (${total} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
