#!/usr/bin/env node
/**
 * Smoke test: prompt_user happy paths + schema validation + redaction
 * (ADR 0022 P2).
 *
 * Covers (≥ 22 assertions, INV-D / INV-G / INV-H / INV-I):
 *
 *   schema validation:
 *     - reject empty params / non-object
 *     - reject missing reason / questions
 *     - reject 0 / 5+ questions
 *     - reject duplicate ids
 *     - reject control chars in user-visible fields
 *     - reject vault-shaped fields (INV-G)
 *     - reject options on text/secret (cross-type consistency)
 *     - reject single/multi without options
 *     - reject options.length < 2 / > 4
 *     - reject header > 12 display cells (CJK width counted as 2)
 *     - reject id failing regex
 *     - reject > 4KB total params payload
 *     - normalized params expose no timeout/deadline field
 *
 *   redaction (INV-D, R4 fix — covers all 5 user-visible fields):
 *     - redactCredentials runs on reason / header / question /
 *       option.label / option.description (5 fields)
 *     - lengthBucket / redactSecretAnswer flow through service
 *
 *   handler:
 *     - sub-pi guard returns subagent-blocked
 *     - !ctx.hasUI returns ui-unavailable
 *     - successful single-question path returns ok:true with answers
 *       record array (INV-H)
 *     - secret type returns redactions field + placeholder (INV-C)
 *     - INV-I concurrent gate
 *     - soft cap on > 2 calls in same session
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let totalChecks = 0;

function check(name, fn) {
  totalChecks++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

async function asyncCheck(name, fn) {
  totalChecks++;
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

// ── Stage all prompt-user modules + redact into tmpDir ─────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-prompt-user-"));
const promptUserDir = path.join(tmpDir, "prompt-user");
const promptUserUiDir = path.join(promptUserDir, "ui");
fs.mkdirSync(promptUserUiDir, { recursive: true });

fs.writeFileSync(path.join(tmpDir, "redact.cjs"), transpile(path.join(repoRoot, "extensions/abrain/redact.ts")));
fs.writeFileSync(path.join(tmpDir, "redact.js"), `module.exports = require("./redact.cjs");\n`);

for (const m of ["types", "schema", "manager", "service", "handler"]) {
  const cjs = path.join(promptUserDir, `${m}.cjs`);
  fs.writeFileSync(cjs, transpile(path.join(repoRoot, "extensions/abrain/prompt-user", `${m}.ts`)));
  fs.copyFileSync(cjs, path.join(promptUserDir, `${m}.js`));
}
fs.writeFileSync(
  path.join(promptUserUiDir, "PromptDialog.cjs"),
  transpile(path.join(repoRoot, "extensions/abrain/prompt-user/ui/PromptDialog.ts")),
);
fs.copyFileSync(
  path.join(promptUserUiDir, "PromptDialog.cjs"),
  path.join(promptUserUiDir, "PromptDialog.js"),
);

// abrain/redact.ts is one level up from prompt-user/; rewrite `../redact`
// inside handler.cjs / service.cjs so it resolves to ../redact.cjs.
// (Module resolution would also try `../redact.js` which we don't
// produce here — easier to just rewrite.)
for (const m of ["handler", "service"]) {
  const cjs = path.join(promptUserDir, `${m}.cjs`);
  let src = fs.readFileSync(cjs, "utf8");
  src = src.replace(/require\(["']\.\.\/redact["']\)/g, 'require("../redact.cjs")');
  fs.writeFileSync(cjs, src);
}

console.log(`Smoke: prompt_user happy paths + schema (ADR 0022 P2)`);
console.log(`tmpDir=${tmpDir}`);
console.log("");

// Resolve modules via the .js shim path so we share the CJS module
// cache entry with handler.cjs's `require("./manager")` (which CJS
// resolves to manager.js). Loading manager.cjs directly creates a
// separate cache entry and a SEPARATE pending Map — INV-I and the
// soft-cap counter would silently desync. (Caught in P2 smoke first
// run before commit.)
const schema = require(path.join(promptUserDir, "schema"));
const handlerMod = require(path.join(promptUserDir, "handler"));
const manager = require(path.join(promptUserDir, "manager"));

// ── 1. schema validation ───────────────────────────────────────────

check("schema: non-object → schema-invalid", () => {
  const r = schema.validatePromptUserParams(null);
  if (r.ok) throw new Error("expected reject");
  if (!r.errors[0]?.includes("must be an object")) throw new Error(r.errors.join(","));
});

check("schema: missing reason → schema-invalid", () => {
  const r = schema.validatePromptUserParams({ questions: [] });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => e.includes("reason"))) throw new Error(r.errors.join(","));
});

check("schema: 0 questions → schema-invalid", () => {
  const r = schema.validatePromptUserParams({ reason: "x", questions: [] });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => e.includes("at least one question"))) throw new Error(r.errors.join(","));
});

check("schema: 5 questions → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: Array.from({ length: 5 }, (_, i) => ({
      id: `q${i}`, header: "h", question: "q?", type: "text",
    })),
  });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => e.includes("> 4"))) throw new Error(r.errors.join(","));
});

check("schema: duplicate id → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [
      { id: "same", header: "h", question: "q?", type: "text" },
      { id: "same", header: "h", question: "q?", type: "text" },
    ],
  });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => e.includes("duplicate"))) throw new Error(r.errors.join(","));
});

check("INV-G: vault-shaped 'scope' field at top level → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    scope: "global",
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => e.includes("INV-G"))) throw new Error(r.errors.join(","));
});

check("INV-G: vault-shaped 'key' field at top level → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    key: "github-token",
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => e.includes("vault"))) throw new Error(r.errors.join(","));
});

check("schema: text type with options → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{
      id: "a", header: "h", question: "q?", type: "text",
      options: [{ label: "yes" }, { label: "no" }],
    }],
  });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => e.includes("forbidden"))) throw new Error(r.errors.join(","));
});

check("schema: single without options → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{ id: "a", header: "h", question: "q?", type: "single" }],
  });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => e.includes("required array"))) throw new Error(r.errors.join(","));
});

check("schema: options.length=1 → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{
      id: "a", header: "h", question: "q?", type: "single",
      options: [{ label: "only" }],
    }],
  });
  if (r.ok) throw new Error("expected reject");
});

// R7.2 (2026-05-17): 删除三个“长度限制 reject”的测试。原本这几条
// 验证: header > 12 cells 拒 / option.description > 80 cells 拒 /
// option.description ≤ 80 cells 放过。R7.2 删除了所有用户可见字段
// 的长度限制(用户反馈“LLM 自己决定长度”),同时删除了
// `description` 字段本身。替换为“这些增加名后不再 reject”的全覆盖。

check("R7.2: header > 12 display cells (CJK = 2) → ok (no length limit)", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{
      id: "a",
      header: "中文标头长度超过原限制但没关系",  // 12 chars × 2 = 24 cells
      question: "q?",
      type: "text",
    }],
  });
  if (!r.ok) throw new Error(`R7.2 长 header 不应 reject: ${r.errors.join(",")}`);
});

check("R7.2: option.description silently dropped (field no longer in schema)", () => {
  // 老 LLM 仍传 description 字段。validator 默认不拒未声明字段,
  // 使老 LLM 调用不中断。OptionList 不读它,UI 看不到。
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{
      id: "a", header: "h", question: "q?", type: "single",
      options: [
        { label: "yes", description: "任意长度的老字段应静默丢弃不报错" },
        { label: "no" },
      ],
    }],
  });
  if (!r.ok) throw new Error(`description silent drop 失败: ${r.errors.join(",")}`);
});

check("R7.2: long option.label → ok (no length limit)", () => {
  // 原 MAX_OPTION_LABEL_LEN=80 chars + MAX_OPTION_LABEL_WORDS=5 词。R7.2 全删。
  const longLabel = "TypeScript — 强类型 web 全栈语言,工具链成熟,与 React/Vue 生态集成严密,超过 5 词超过 80 字符";
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{
      id: "a", header: "h", question: "q?", type: "single",
      options: [{ label: longLabel }, { label: "no" }],
    }],
  });
  if (!r.ok) throw new Error(`R7.2 长 label 不应 reject: ${r.errors.join(",")}`);
});

check("schema: id failing regex → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{ id: "Has-Hyphen", header: "h", question: "q?", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject");
});

check("schema: normalized params expose no timeout/deadline field", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (!r.ok) throw new Error(r.errors.join(","));
  if ("timeoutSec" in r.normalized) throw new Error("timeoutSec leaked into normalized params");
});

check("schema: control char in reason → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "hello\x07world",
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject");
});

// P1-fix (OPUS review): hasControlChars must reject \t \n \r too.
check("P1-fix: header containing \\n → schema-invalid (TUI layout safety)", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{ id: "a", header: "abc\ndef", question: "q?", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject for \\n in header");
  if (!r.errors.some((e) => e.includes("control characters"))) throw new Error(r.errors.join(","));
});

check("P1-fix: question containing \\r → schema-invalid (cursor reset attack)", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{ id: "a", header: "h", question: "q?\rEVIL", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject for \\r in question");
});

check("P1-fix: reason containing \\t → schema-invalid (all C0 rejected)", () => {
  const r = schema.validatePromptUserParams({
    reason: "hello\tworld",
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject for \\t in reason");
});

check("R7.2: > 4KB total → ok (no payload size limit)", () => {
  // 原 MAX_PARAMS_BYTES=4096 限。R7.2 删,只保留 JSON-serializable 检查。
  const huge = "x".repeat(5000);
  const r = schema.validatePromptUserParams({
    reason: huge,
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (!r.ok) throw new Error(`R7.2 超4KB payload 不应 reject: ${r.errors.join(",")}`);
});

check("R7.2: circular reference still rejected (JSON-serializable check kept)", () => {
  const circular = { reason: "x", questions: [{ id: "a", header: "h", question: "q?", type: "text" }] };
  circular.self = circular;
  const r = schema.validatePromptUserParams(circular);
  if (r.ok) throw new Error("circular ref should still be rejected");
});

// ── 2. INV-D redaction (R7.2 update: 5→4 fields, 刪除 option.description) ──

check("R7.2 INV-D: redactPromptParams covers 4 user-visible fields (reason / header / question / option.label)", () => {
  const cred = "https://user:tok@host.local/x";
  const before = {
    reason: `release token to ${cred}`,
    questions: [{
      id: "a",
      header: `${cred}/h`,
      question: `confirm ${cred}`,
      type: "single",
      options: [
        { label: `${cred}/l` },
        { label: "no" },
      ],
    }],
  };
  const after = handlerMod.redactPromptParams(before);
  const all = JSON.stringify(after);
  if (all.includes("user:tok@")) {
    throw new Error(`credential leaked after redactPromptParams: ${all.slice(0, 200)}`);
  }
  // 4 user-visible 字段全覆盖:
  if (!after.reason.includes("***@")) throw new Error("reason missing ***@");
  if (!after.questions[0].header.includes("***@")) throw new Error("header missing ***@");
  if (!after.questions[0].question.includes("***@")) throw new Error("question missing ***@");
  if (!after.questions[0].options[0].label.includes("***@")) throw new Error("option.label missing ***@");
});

// ── 3. Handler guards (no UI, sub-pi) ──────────────────────────────

const recordedBlocked = [];
const recordedAsk = [];
const recordedResult = [];
const handlerDeps = {
  dialog: { buildDialog: () => { throw new Error("dialog not used in this fixture"); } },
  audit: {
    recordAsk: (ev) => recordedAsk.push(ev),
    recordResult: (ev) => recordedResult.push(ev),
  },
  recordBlocked: (ev) => recordedBlocked.push(ev),
};

await asyncCheck("handler: sub-pi (PI_ABRAIN_DISABLED=1) → subagent-blocked", async () => {
  const prev = process.env.PI_ABRAIN_DISABLED;
  process.env.PI_ABRAIN_DISABLED = "1";
  manager.__resetForTests();
  try {
    const json = await handlerMod.executePromptUserTool(
      { reason: "x", questions: [{ id: "a", header: "h", question: "q?", type: "text" }] },
      undefined,
      { ui: {}, hasUI: true },
      handlerDeps,
    );
    const r = JSON.parse(json);
    if (r.ok) throw new Error("expected reject");
    if (r.reason !== "subagent-blocked") throw new Error(`reason=${r.reason}`);
    if (!recordedBlocked.find((b) => b.reason === "subagent")) {
      throw new Error("audit recordBlocked(subagent) missing");
    }
  } finally {
    if (prev === undefined) delete process.env.PI_ABRAIN_DISABLED;
    else process.env.PI_ABRAIN_DISABLED = prev;
  }
});

await asyncCheck("handler: !ctx.hasUI → ui-unavailable", async () => {
  manager.__resetForTests();
  recordedBlocked.length = 0;
  const json = await handlerMod.executePromptUserTool(
    { reason: "x", questions: [{ id: "a", header: "h", question: "q?", type: "text" }] },
    undefined,
    { ui: {}, hasUI: false },
    handlerDeps,
  );
  const r = JSON.parse(json);
  if (r.ok || r.reason !== "ui-unavailable") throw new Error(`got ${JSON.stringify(r)}`);
  if (!recordedBlocked.find((b) => b.reason === "no-ui")) {
    throw new Error("audit recordBlocked(no-ui) missing");
  }
});

// R6 (2026-05-17): narrow-terminal rejection REMOVED. <PromptDialog> now
// renders inline as editor-region replacement (no centered overlay, no
// 60% width math), so cols=40 is fine and an old `cols < 60 → reject`
// would be a false-positive regression. Replacement assertion: narrow
// terminal MUST NOT reject; it must continue to schema validation.
await asyncCheck("R6: narrow terminal (40 cols) does NOT reject anymore", async () => {
  manager.__resetForTests();
  recordedBlocked.length = 0;
  const origCols = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    configurable: true, get: () => 40,
  });
  try {
    // Pass intentionally invalid params (empty questions) so we can
    // confirm we reached schema validation — i.e. the narrow-cols
    // guard did NOT short-circuit with ui-unavailable.
    const json = await handlerMod.executePromptUserTool(
      { reason: "x", questions: [] },
      undefined,
      { ui: { custom: () => {}, notify: () => {} }, hasUI: true },
      handlerDeps,
    );
    const r = JSON.parse(json);
    if (r.reason !== "schema-invalid") {
      throw new Error(
        `narrow terminal should fall through to schema validation; expected schema-invalid (empty questions), got ${r.reason}: ${JSON.stringify(r)}`,
      );
    }
    // Audit must NOT record a no-ui width-related block.
    if (recordedBlocked.find((b) => b.reason === "no-ui" && /width \d+/.test(b.detail || ""))) {
      throw new Error("narrow terminal incorrectly emitted no-ui width audit row");
    }
  } finally {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true, get: () => origCols,
    });
  }
});

await asyncCheck("R6: cols=undefined (RPC mode) still passes through to schema", async () => {
  manager.__resetForTests();
  recordedBlocked.length = 0;
  const origCols = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    configurable: true, get: () => undefined,
  });
  try {
    const json = await handlerMod.executePromptUserTool(
      { reason: "x", questions: [] },
      undefined,
      { ui: { custom: () => {}, notify: () => {} }, hasUI: true },
      handlerDeps,
    );
    const r = JSON.parse(json);
    if (r.reason !== "schema-invalid") {
      throw new Error(
        `cols=undefined should not affect routing; expected schema-invalid, got ${r.reason}`,
      );
    }
  } finally {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true, get: () => origCols,
    });
  }
});

await asyncCheck("handler: schema-invalid path records detail (INV-G error visible)", async () => {
  manager.__resetForTests();
  recordedBlocked.length = 0;
  const json = await handlerMod.executePromptUserTool(
    { reason: "x", scope: "global", questions: [{ id: "a", header: "h", question: "q?", type: "text" }] },
    undefined,
    { ui: {}, hasUI: true },
    handlerDeps,
  );
  const r = JSON.parse(json);
  if (r.ok || r.reason !== "schema-invalid") throw new Error(`got ${JSON.stringify(r)}`);
  if (!r.detail || !r.detail.includes("INV-G")) throw new Error(`detail missing INV-G hint: ${r.detail}`);
});

// ── 4. Happy path with mocked ctx.ui.custom (single + secret + INV-H) ──

await asyncCheck("happy path: single question → ok:true, answers as array (INV-H)", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  const ui = {
    custom: async (factory, _opts) => {
      // Pretend ctx.ui.custom invokes the factory and the user picks.
      // The factory receives (tui, theme, kb, done). We mock done to
      // simulate user selecting "yes". We don't actually render.
      return await new Promise((resolve) => {
        // Provide enough stub TUI + theme so the factory doesn't crash;
        // but since the factory delegates to buildDialog (which uses
        // pi-tui), we instead inject a fake dialog into deps below.
        factory({}, {}, {}, resolve);
      });
    },
    notify: () => {},
  };
  const fakeDeps = {
    ...handlerDeps,
    dialog: {
      buildDialog: ({ onDone }) => {
        // Immediately answer.
        queueMicrotask(() =>
          onDone({ outcome: "submit", answers: { pick: ["yes"] }, rawSecrets: {} }),
        );
        return {}; // dummy component
      },
    },
  };
  const json = await handlerMod.executePromptUserTool(
    {
      reason: "test single",
      questions: [{
        id: "pick", header: "h", question: "q?", type: "single",
        options: [{ label: "yes" }, { label: "no" }],
      }],
    },
    undefined,
    { ui, hasUI: true },
    fakeDeps,
  );
  const r = JSON.parse(json);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  if (!Array.isArray(r.answers.pick)) {
    throw new Error(`INV-H violated: answers.pick is not array: ${typeof r.answers.pick}`);
  }
  if (r.answers.pick[0] !== "yes") throw new Error(`got ${r.answers.pick[0]}`);
});

await asyncCheck("INV-C secret: ok:true with placeholder + redactions field", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  const ui = {
    custom: async (factory) => {
      return await new Promise((resolve) => factory({}, {}, {}, resolve));
    },
  };
  const deps = {
    ...handlerDeps,
    dialog: {
      buildDialog: ({ onDone }) => {
        queueMicrotask(() =>
          onDone({
            outcome: "submit",
            answers: { token: ["[secret submitted]"] },
            rawSecrets: { token: "ghp_AAAA1234567890" },
          }),
        );
        return {};
      },
    },
  };
  const json = await handlerMod.executePromptUserTool(
    {
      reason: "need a token",
      questions: [{ id: "token", header: "Token", question: "Enter token?", type: "secret" }],
    },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  const r = JSON.parse(json);
  if (!r.ok) throw new Error(JSON.stringify(r));
  if (r.answers.token[0] !== "[REDACTED_SECRET:token]") {
    throw new Error(`placeholder wrong: ${r.answers.token[0]}`);
  }
  if (!r.redactions?.token?.placeholder) throw new Error("redactions field missing");
  // Crucially, the raw secret value MUST NOT appear anywhere.
  const blob = JSON.stringify(r);
  if (blob.includes("ghp_AAAA")) throw new Error(`raw secret leaked: ${blob}`);
});

// P1-fix (DEEPSEEK review): INV-I reject must also emit audit row.
await asyncCheck("P1-fix: INV-I concurrent reject also calls recordBlocked", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  recordedBlocked.length = 0;
  // Open a hanging first prompt.
  const ui = {
    custom: async (factory) => await new Promise((_resolve) => {
      factory({}, {}, {}, () => { /* never */ });
    }),
  };
  const deps = { ...handlerDeps, dialog: { buildDialog: () => ({}) } };
  const firstPromise = handlerMod.executePromptUserTool(
    { reason: "first", questions: [{ id: "a", header: "h", question: "q?", type: "text" }] },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  await new Promise((r) => setImmediate(r));
  // Concurrent second should reject + write audit.
  await handlerMod.executePromptUserTool(
    { reason: "second", questions: [{ id: "b", header: "h", question: "q?", type: "text" }] },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  const invIBlocked = recordedBlocked.find(
    (b) => b.reason === "schema-invalid" && b.detail?.includes("INV-I"),
  );
  if (!invIBlocked) {
    throw new Error(
      `INV-I reject did not emit recordBlocked. Got: ${JSON.stringify(recordedBlocked)}`,
    );
  }
  manager.cancelAllPending("cancelled");
  await firstPromise;
});

await asyncCheck("INV-I: concurrent prompt_user returns distinctive detail", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  // Open one prompt that never resolves (we don't call done()).
  let _firstDone;
  const ui = {
    custom: async (factory) => {
      return await new Promise((resolve) => {
        // Capture the done callback but never invoke it.
        factory({}, {}, {}, () => { /* never called for first */ });
        _firstDone = resolve;
      });
    },
  };
  const deps = {
    ...handlerDeps,
    dialog: {
      buildDialog: () => ({}),  // dummy
    },
  };
  // Fire first call but don't await it.
  const firstPromise = handlerMod.executePromptUserTool(
    {
      reason: "first",
      questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
    },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  // Wait one microtask so manager.acquirePending has run.
  await new Promise((r) => setImmediate(r));
  if (manager.getPendingPromptCount() !== 1) {
    throw new Error(`first call did not register; count=${manager.getPendingPromptCount()}`);
  }
  // Fire second concurrent call.
  const secondJson = await handlerMod.executePromptUserTool(
    {
      reason: "second",
      questions: [{ id: "b", header: "h", question: "q?", type: "text" }],
    },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  const second = JSON.parse(secondJson);
  if (second.ok) throw new Error("concurrent second should reject");
  if (second.reason !== "schema-invalid") throw new Error(`wrong reason: ${second.reason}`);
  if (!second.detail?.includes("INV-I")) throw new Error(`detail missing INV-I marker: ${second.detail}`);
  // Drain the first prompt with cancelAllPending so we don't leak it.
  manager.cancelAllPending("cancelled");
  await firstPromise;
});

// P1-fix (DEEPSEEK review): chained fallback multi uses ui.confirm per option.
await asyncCheck("P1-fix: fallback multi walks each option through ui.confirm", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  const confirmCalls = [];
  const inputCalls = [];
  const ui = {
    // custom MISSING → forces chained fallback
    confirm: async (title, message, _opts) => {
      confirmCalls.push({ title, message });
      // Include first option, skip second, decline Other.
      if (message.includes("yes")) return true;
      if (message.includes("no")) return false;
      if (message.includes("Other")) return false;
      return false;
    },
    input: async (prompt) => { inputCalls.push(prompt); return undefined; },
    select: async () => undefined,  // not used for multi
    notify: () => {},
  };
  const deps = { ...handlerDeps, dialog: { buildDialog: () => ({}) } };
  const json = await handlerMod.executePromptUserTool(
    {
      reason: "pick frameworks",
      questions: [{
        id: "frameworks", header: "Pick", question: "Which?", type: "multi",
        options: [{ label: "yes" }, { label: "no" }],
      }],
    },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  const r = JSON.parse(json);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  // Should have asked confirm for each option + Other (3 total).
  if (confirmCalls.length !== 3) {
    throw new Error(`expected 3 confirm calls (2 opts + Other), got ${confirmCalls.length}`);
  }
  // answers[frameworks] should be array of length 1 (only "yes" included).
  if (!Array.isArray(r.answers.frameworks)) throw new Error("INV-H violated: not array");
  if (r.answers.frameworks.length !== 1) {
    throw new Error(`expected ['yes'], got ${JSON.stringify(r.answers.frameworks)}`);
  }
  if (r.answers.frameworks[0] !== "yes") throw new Error(`got ${r.answers.frameworks[0]}`);
  if (!r.detail?.includes("fallback")) throw new Error(`detail should mark fallback path: ${r.detail}`);
});

await asyncCheck("P1-fix: fallback multi WITHOUT ctx.ui.confirm → ui-unavailable", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  const ui = {
    // No custom, no confirm.
    select: async () => undefined,
    input: async () => undefined,
    notify: () => {},
  };
  const deps = { ...handlerDeps, dialog: { buildDialog: () => ({}) } };
  const json = await handlerMod.executePromptUserTool(
    {
      reason: "x",
      questions: [{
        id: "a", header: "h", question: "q?", type: "multi",
        options: [{ label: "yes" }, { label: "no" }],
      }],
    },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  const r = JSON.parse(json);
  if (r.ok || r.reason !== "ui-unavailable") {
    throw new Error(`expected ui-unavailable, got ${JSON.stringify(r)}`);
  }
});

await asyncCheck("P1-fix: fallback single still works (regression check after multi split)", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  const ui = {
    select: async () => "yes",  // picks first option directly
    input: async () => undefined,
    notify: () => {},
  };
  const deps = { ...handlerDeps, dialog: { buildDialog: () => ({}) } };
  const json = await handlerMod.executePromptUserTool(
    {
      reason: "pick one",
      questions: [{
        id: "x", header: "h", question: "q?", type: "single",
        options: [{ label: "yes" }, { label: "no" }],
      }],
    },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  const r = JSON.parse(json);
  if (!r.ok) throw new Error(`single fallback regressed: ${JSON.stringify(r)}`);
  if (r.answers.x[0] !== "yes") throw new Error(`got ${r.answers.x[0]}`);
});

// P1-fix (DEEPSEEK review): redactPromptParams runs at service entry too.
await asyncCheck("P1-fix: service.askPromptUser entry re-runs redactPromptParams (defense-in-depth)", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  // The defensive call is idempotent; smoke verifies it doesn't break
  // legitimate calls and that credential URLs leaking past handler
  // would still get caught. We invoke service directly via require
  // path the same way handler does.
  const serviceMod = require(path.join(promptUserDir, "service"));
  const askPromptUser = serviceMod.askPromptUser;
  if (typeof askPromptUser !== "function") throw new Error("askPromptUser not exported");
  // Pre-redact via handler call (normal path).
  const recordedAsk = [];
  const audit = {
    recordAsk: (ev) => recordedAsk.push(ev),
    recordResult: () => {},
  };
  const ctx = {
    ui: { custom: async (factory) => await new Promise((resolve) => factory({}, {}, {}, resolve)) },
    hasUI: true,
  };
  const deps = {
    buildDialog: ({ onDone }) => {
      queueMicrotask(() => onDone({ outcome: "submit", answers: { a: ["x"] }, rawSecrets: {} }));
      return {};
    },
  };
  // Pass deliberately UN-redacted params (skipping handler):
  const result = await askPromptUser(
    ctx,
    {
      reason: "connect to https://user:secret@example.com/repo",  // raw credential
      questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
    },
    deps,
    audit,
  );
  // audit.recordAsk should have received SANITIZED reason, not raw.
  if (recordedAsk.length === 0) throw new Error("recordAsk not called");
  if (recordedAsk[0].reason.includes("user:secret")) {
    throw new Error(
      `service entry did NOT re-redact — raw credential leaked to audit: ${recordedAsk[0].reason}`,
    );
  }
  if (!recordedAsk[0].reason.includes("***@")) {
    throw new Error(`expected ***@ placeholder in audit reason: ${recordedAsk[0].reason}`);
  }
  void result;
});

await asyncCheck("soft cap: 3rd call in same session has detail batching warning", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  const ui = {
    custom: async (factory) => await new Promise((resolve) => factory({}, {}, {}, resolve)),
  };
  const deps = {
    ...handlerDeps,
    dialog: {
      buildDialog: ({ onDone }) => {
        queueMicrotask(() =>
          onDone({ outcome: "submit", answers: { a: ["x"] }, rawSecrets: {} }),
        );
        return {};
      },
    },
  };
  const mkParams = () => ({
    reason: "x",
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  await handlerMod.executePromptUserTool(mkParams(), undefined, { ui, hasUI: true }, deps);
  await handlerMod.executePromptUserTool(mkParams(), undefined, { ui, hasUI: true }, deps);
  const thirdJson = await handlerMod.executePromptUserTool(
    mkParams(), undefined, { ui, hasUI: true }, deps,
  );
  const third = JSON.parse(thirdJson);
  if (!third.ok) throw new Error(`third should still succeed: ${JSON.stringify(third)}`);
  if (!third.detail || !third.detail.includes("consider batching")) {
    throw new Error(`soft-cap warning missing: ${third.detail}`);
  }
});

// ── R8 (post-T0 OPUS xhigh P1#1): INV-C teardown on manager-side cancel ──
//
// Pre-fix: MaskedInput.wipe() was reached ONLY via the wizard's
// Enter/Esc handlers (finishWithSubmit / finishWithCancel). When the
// MANAGER side settled the promise (ctx.signal abort /
// cancelAllPending), the dialog stayed on screen with the secret
// buffer intact. INV-C "secret raw never leaves PromptDialog closure"
// was violated for a window of seconds to minutes.
//
// Post-fix: service.ts captures the dialog root (which now exposes
// __wipeSecrets) and the pi-side `done` callback, then registers a
// manager disposer that calls both on EVERY terminal resolution.

await asyncCheck("R8 P1#1: session drain → service.ts disposer calls dialog.__wipeSecrets + done(null)", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  let wipeCalls = 0;
  let doneCalls = [];
  const ui = {
    custom: (factory) => {
      // Never resolve from the factory; hold the dialog open until the
      // simulated session shutdown drains pending prompts.
      return new Promise(() => {
        factory({}, {}, {}, (v) => { doneCalls.push(v); });
      });
    },
  };
  const fakeDialog = {
    __wipeSecrets: () => { wipeCalls += 1; },
  };
  const deps = {
    ...handlerDeps,
    dialog: {
      buildDialog: ({ onDone }) => {
        // Capture onDone but don't call it — dialog is "hanging".
        void onDone;
        return fakeDialog;
      },
    },
  };
  const promise = handlerMod.executePromptUserTool(
    {
      reason: "test INV-C teardown",
      questions: [{
        id: "tok",
        header: "Token",
        question: "Enter:",
        type: "secret",
      }],
    },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  // Yield so service.ts kicks off the dialog factory + registers disposer.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  // Trigger manager-side cancel (simulates session_shutdown).
  manager.cancelAllPending("cancelled");
  const json = await promise;
  const r = JSON.parse(json);
  if (r.ok) throw new Error(`expected !ok on cancel, got ${JSON.stringify(r)}`);
  // The disposer MUST have fired __wipeSecrets exactly once.
  if (wipeCalls !== 1) {
    throw new Error(`expected __wipeSecrets called exactly once, got ${wipeCalls}`);
  }
  // The disposer MUST have called done(null) to tear pi's editor region.
  if (doneCalls.length !== 1 || doneCalls[0] !== null) {
    throw new Error(`expected done(null) called once, got ${JSON.stringify(doneCalls)}`);
  }
});

await asyncCheck("R8 P1#1: ctx.signal abort → disposer fires teardown", async () => {
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  let wipeCalls = 0;
  let doneCalls = [];
  const ui = {
    custom: (factory) => {
      return new Promise(() => {
        factory({}, {}, {}, (v) => { doneCalls.push(v); });
      });
    },
  };
  const fakeDialog = { __wipeSecrets: () => { wipeCalls += 1; } };
  const deps = {
    ...handlerDeps,
    dialog: { buildDialog: () => fakeDialog },
  };
  const ac = new AbortController();
  const promise = handlerMod.executePromptUserTool(
    {
      reason: "test signal abort",
      questions: [{ id: "s", header: "h", question: "q?", type: "secret" }],
    },
    ac.signal,
    { ui, hasUI: true, signal: ac.signal },
    deps,
  );
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  ac.abort();
  const json = await promise;
  const r = JSON.parse(json);
  if (r.ok) throw new Error(`expected !ok on signal abort: ${JSON.stringify(r)}`);
  if (wipeCalls !== 1) {
    throw new Error(`signal abort: __wipeSecrets calls=${wipeCalls}, expected 1`);
  }
  if (doneCalls.length !== 1 || doneCalls[0] !== null) {
    throw new Error(`signal abort: done calls=${JSON.stringify(doneCalls)}, expected [null]`);
  }
});

await asyncCheck("R8 P1#1: successful submit → disposer still runs (idempotent re-wipe)", async () => {
  // PromptDialog already wipes secrets in finishWithSubmit before
  // onDone fires. The disposer then runs on manager success-path
  // settlement. MaskedInput.wipe() is idempotent (string reassign),
  // so the second wipe call is harmless. Verify both fire.
  manager.__resetForTests();
  handlerMod.resetSoftCapCounter();
  let wipeCalls = 0;
  let doneCalls = [];
  const ui = {
    custom: (factory) => new Promise((resolve) => {
      factory({}, {}, {}, (v) => { doneCalls.push(v); resolve(v); });
    }),
  };
  const fakeDialog = { __wipeSecrets: () => { wipeCalls += 1; } };
  const deps = {
    ...handlerDeps,
    dialog: {
      buildDialog: ({ onDone }) => {
        // Immediately submit a successful answer.
        queueMicrotask(() =>
          onDone({
            outcome: "submit",
            answers: { s: ["[REDACTED_SECRET:s]"] },
            rawSecrets: { s: "ghp_test" },
          }),
        );
        return fakeDialog;
      },
    },
  };
  const json = await handlerMod.executePromptUserTool(
    {
      reason: "test successful path disposer",
      questions: [{ id: "s", header: "h", question: "q?", type: "secret" }],
    },
    undefined,
    { ui, hasUI: true },
    deps,
  );
  const r = JSON.parse(json);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  // Disposer must have fired at least once (it's the manager's
  // teardown). Whether it ran 1 or 2 times depends on real PromptDialog
  // also calling wipe, but in the FAKE dialog only the disposer calls
  // it. Either way it must be ≥ 1.
  if (wipeCalls < 1) {
    throw new Error(`success path: __wipeSecrets calls=${wipeCalls}, expected ≥ 1`);
  }
  // done was called with the real submit payload by the fake factory,
  // and the disposer also tries done(null) but the service.ts impl
  // clears dialogDone in the success-path onDone wrapper BEFORE calling
  // handleDone, so the disposer sees dialogDone=null and skips done(null).
  // Verify only the real submit done call landed.
  if (doneCalls.length !== 1) {
    throw new Error(`success path: done calls=${JSON.stringify(doneCalls)}, expected 1 (the submit, not extra null)`);
  }
});

// ── Summary ────────────────────────────────────────────────────────

console.log("");
console.log(`Total: ${totalChecks}  Passed: ${totalChecks - failures.length}  Failed: ${failures.length}`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const { name, err } of failures) {
    console.log(`  - ${name}\n    ${err.stack || err.message}`);
  }
  process.exit(1);
}

try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
process.exit(0);
