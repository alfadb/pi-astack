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
 *     - clamp timeoutSec to [30, 1800]
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

check("schema: header > 12 display cells (CJK = 2) → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{
      id: "a",
      header: "中文标头长度超过限制", // 10 chars × 2 cells = 20 cells
      question: "q?",
      type: "text",
    }],
  });
  if (r.ok) throw new Error("expected reject");
  if (!r.errors.some((e) => /display cells/.test(e))) throw new Error(r.errors.join(","));
});

check("schema: header within budget (ASCII 12 chars) → ok", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{ id: "a", header: "abcdefghijkl", question: "q?", type: "text" }],
  });
  if (!r.ok) throw new Error(`unexpected reject: ${r.errors.join(", ")}`);
});

check("schema: id failing regex → schema-invalid", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{ id: "Has-Hyphen", header: "h", question: "q?", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject");
});

check("schema: timeoutSec clamped to [30, 1800]", () => {
  const r1 = schema.validatePromptUserParams({
    reason: "x", timeoutSec: 1,
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (!r1.ok || r1.normalized.timeoutSec !== 30) {
    throw new Error(`low not clamped: ${r1.normalized?.timeoutSec}`);
  }
  const r2 = schema.validatePromptUserParams({
    reason: "x", timeoutSec: 99999,
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (!r2.ok || r2.normalized.timeoutSec !== 1800) {
    throw new Error(`high not clamped: ${r2.normalized?.timeoutSec}`);
  }
});

check("schema: default timeoutSec = 600 when omitted", () => {
  const r = schema.validatePromptUserParams({
    reason: "x",
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (!r.ok || r.normalized.timeoutSec !== 600) throw new Error("default missing");
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

check("schema: > 4KB total → schema-invalid", () => {
  const huge = "x".repeat(5000);
  const r = schema.validatePromptUserParams({
    reason: huge,
    questions: [{ id: "a", header: "h", question: "q?", type: "text" }],
  });
  if (r.ok) throw new Error("expected reject");
});

// ── 2. INV-D redaction: handler-entry redactPromptParams covers all 5 fields ──

check("INV-D: redactPromptParams covers reason / header / question / option.label / option.description", () => {
  const cred = "https://user:tok@host.local/x";
  const before = {
    reason: `release token to ${cred}`,
    questions: [{
      id: "a",
      header: `${cred}/h`,
      question: `confirm ${cred}`,
      type: "single",
      options: [
        { label: `${cred}/l`, description: `desc ${cred}` },
        { label: "no" },
      ],
    }],
    timeoutSec: 600,
  };
  const after = handlerMod.redactPromptParams(before);
  const all = JSON.stringify(after);
  if (all.includes("user:tok@")) {
    throw new Error(`credential leaked after redactPromptParams: ${all.slice(0, 200)}`);
  }
  // Spot-check each of the 5 fields explicitly:
  if (!after.reason.includes("***@")) throw new Error("reason missing ***@");
  if (!after.questions[0].header.includes("***@")) throw new Error("header missing ***@");
  if (!after.questions[0].question.includes("***@")) throw new Error("question missing ***@");
  if (!after.questions[0].options[0].label.includes("***@")) throw new Error("option.label missing ***@");
  if (!after.questions[0].options[0].description.includes("***@")) throw new Error("option.description missing ***@");
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

// P1-fix (DEEPSEEK review): narrow terminal rejection.
await asyncCheck("P1-fix: narrow terminal (< 60 cols) → ui-unavailable", async () => {
  manager.__resetForTests();
  recordedBlocked.length = 0;
  // Mock process.stdout.columns by stashing original + replacing.
  const origCols = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    configurable: true, get: () => 40,
  });
  try {
    const json = await handlerMod.executePromptUserTool(
      { reason: "x", questions: [{ id: "a", header: "h", question: "q?", type: "text" }] },
      undefined,
      { ui: { custom: () => {}, notify: () => {} }, hasUI: true },
      handlerDeps,
    );
    const r = JSON.parse(json);
    if (r.ok || r.reason !== "ui-unavailable") {
      throw new Error(`expected ui-unavailable for narrow terminal, got ${JSON.stringify(r)}`);
    }
    if (!r.detail?.includes("60 cells")) {
      throw new Error(`detail should mention 60 cells: ${r.detail}`);
    }
    if (!recordedBlocked.find((b) => b.reason === "no-ui" && b.detail?.includes("width 40"))) {
      throw new Error("audit row for narrow terminal missing");
    }
  } finally {
    Object.defineProperty(process.stdout, "columns", {
      configurable: true, get: () => origCols,
    });
  }
});

await asyncCheck("P1-fix: terminal cols undefined (RPC mode) → fallback to 80, no reject", async () => {
  manager.__resetForTests();
  recordedBlocked.length = 0;
  const origCols = process.stdout.columns;
  Object.defineProperty(process.stdout, "columns", {
    configurable: true, get: () => undefined,
  });
  try {
    // Should pass the cols check (fallback 80 >= 60) and continue
    // to schema validation. We pass intentionally invalid params so
    // the smoke can confirm we made it PAST the cols guard.
    const json = await handlerMod.executePromptUserTool(
      { reason: "x", questions: [] },
      undefined,
      { ui: { custom: () => {}, notify: () => {} }, hasUI: true },
      handlerDeps,
    );
    const r = JSON.parse(json);
    if (r.reason !== "schema-invalid") {
      throw new Error(
        `cols-undefined should fall back to 80; expected schema-invalid (from empty questions), got ${r.reason}`,
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
      timeoutSec: 30,
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
    { reason: "first", timeoutSec: 30, questions: [{ id: "a", header: "h", question: "q?", type: "text" }] },
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
      timeoutSec: 30,
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
      timeoutSec: 30,
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
      timeoutSec: 30,
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
      timeoutSec: 30,
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
      timeoutSec: 30,
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
    timeoutSec: 30,
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
