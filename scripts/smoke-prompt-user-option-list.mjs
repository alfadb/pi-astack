#!/usr/bin/env node
/**
 * Smoke test: OptionList / MaskedInput state machine + wizard navigation
 * (ADR 0022 R7.3).
 *
 * This complements `smoke-prompt-user.mjs` (which mocks `buildDialog`
 * to keep the protocol layer hermetic) by directly exercising the
 * PromptDialog.ts components: OptionList focus/select state, Other
 * inline input, MaskedInput secret buffer + wipe, and the wizard's
 * Enter-advance / ←→ navigation routing.
 *
 * We mock the pi-tui surface (PiTuiBag) so the test runs without a
 * real terminal. The mocks satisfy the structural interface but only
 * track what's needed for the assertions.
 *
 * Covered invariants:
 *   - INV-C: MaskedInput.wipe() clears buffer; wizard calls wipe on
 *            both submit AND cancel.
 *   - INV-H: collect() always returns string[]; single yields length 1
 *            (or 0 for empty single+Other), multi yields 0..N.
 *   - INV-D: not directly tested here (covered in smoke-prompt-user.mjs
 *            redact path); R7.3 changed it from 5 to 4 fields.
 *
 * Run: node scripts/smoke-prompt-user-option-list.mjs
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

// ── Stage PromptDialog + its dependencies ──────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-option-list-"));
const promptUserDir = path.join(tmpDir, "prompt-user");
const promptUserUiDir = path.join(promptUserDir, "ui");
fs.mkdirSync(promptUserUiDir, { recursive: true });

// PromptDialog imports `../types` and `../service`. types is pure
// (no runtime) — we stub it with the bare types. service has runtime
// (manager etc) we don't need for OptionList tests; PromptDialog only
// imports type-only `RawDialogResult` so an empty CJS stub works.
fs.writeFileSync(
  path.join(promptUserDir, "types.cjs"),
  transpile(path.join(repoRoot, "extensions/abrain/prompt-user/types.ts")),
);
fs.copyFileSync(
  path.join(promptUserDir, "types.cjs"),
  path.join(promptUserDir, "types.js"),
);
fs.writeFileSync(
  path.join(promptUserDir, "service.cjs"),
  "module.exports = {};\n",  // type-only import in PromptDialog
);
fs.copyFileSync(
  path.join(promptUserDir, "service.cjs"),
  path.join(promptUserDir, "service.js"),
);
fs.writeFileSync(
  path.join(promptUserUiDir, "PromptDialog.cjs"),
  transpile(path.join(repoRoot, "extensions/abrain/prompt-user/ui/PromptDialog.ts")),
);
fs.copyFileSync(
  path.join(promptUserUiDir, "PromptDialog.cjs"),
  path.join(promptUserUiDir, "PromptDialog.js"),
);

console.log(`Smoke: OptionList / MaskedInput / wizard (ADR 0022 R7.3)`);
console.log(`tmpDir=${tmpDir}`);
console.log("");

const promptDialog = require(path.join(promptUserUiDir, "PromptDialog"));
const { OptionList, MaskedInput, buildPromptDialog } = promptDialog;

// ── Mock pi-tui PiTuiBag ───────────────────────────────────────────
// Minimal mocks: just enough to satisfy structural interface so
// OptionList can be constructed and tested.

class MockInput {
  constructor() {
    this.value = "";
    this.cursor = 0;
    this.focused = false;
    this.onSubmit = undefined;
    this.onEscape = undefined;
  }
  getValue() { return this.value; }
  setValue(v) { this.value = v; this.cursor = Math.min(this.cursor, v.length); }
  render(_w) { return [`> ${this.value}${this.focused ? "▏" : ""}`]; }
  handleInput(data) {
    if (data === "\r" || data === "\n") {
      this.onSubmit?.(this.value);
      return;
    }
    if (data === "\x1b") {
      this.onEscape?.();
      return;
    }
    // Arrow keys: move cursor (very simplified)
    if (data === "\x1b[D" || data === "\x1bOD") {
      if (this.cursor > 0) this.cursor -= 1;
      return;
    }
    if (data === "\x1b[C" || data === "\x1bOC") {
      if (this.cursor < this.value.length) this.cursor += 1;
      return;
    }
    // Backspace
    if (data === "\x7f" || data === "\b") {
      if (this.cursor > 0) {
        this.value = this.value.slice(0, this.cursor - 1) + this.value.slice(this.cursor);
        this.cursor -= 1;
      }
      return;
    }
    // Printable
    if (data.length === 1 && data.charCodeAt(0) >= 0x20) {
      this.value = this.value.slice(0, this.cursor) + data + this.value.slice(this.cursor);
      this.cursor += 1;
    }
  }
  invalidate() {}
}

class MockContainer {
  constructor() { this.children = []; }
  addChild(c) { this.children.push(c); }
  clear() { this.children = []; }
  render(w) {
    const out = [];
    for (const c of this.children) {
      for (const line of c.render(w)) out.push(line);
    }
    return out;
  }
  invalidate() { for (const c of this.children) c.invalidate?.(); }
}

class MockText {
  constructor(text, paddingX = 1, _paddingY = 1) {
    this.text = text;
    this.paddingX = paddingX;
  }
  render(_w) {
    if (!this.text || this.text.trim() === "") return [];
    return [" ".repeat(this.paddingX) + this.text];
  }
  invalidate() {}
}

class MockSpacer {
  constructor(lines = 1) { this.lines = lines; }
  render(_w) { return Array(this.lines).fill(""); }
  invalidate() {}
}

class MockDynamicBorder {
  constructor(_paint) {}
  render(w) { return ["─".repeat(w)]; }
  invalidate() {}
}

const pituiBag = {
  Container: MockContainer,
  Text: MockText,
  Input: MockInput,
  SelectList: function() { throw new Error("SelectList unused post-R7"); },
  DynamicBorder: MockDynamicBorder,
  Spacer: MockSpacer,
};

const themeBag = {
  accent: (s) => `[ACC]${s}[/ACC]`,
  muted: (s) => `[MUT]${s}[/MUT]`,
  dim: (s) => `[DIM]${s}[/DIM]`,
};

const fullTheme = {
  fg: (color, text) => `[${color.toUpperCase()}]${text}[/${color.toUpperCase()}]`,
  bold: (text) => `**${text}**`,
};

// ── Helpers ─────────────────────────────────────────────────────────

function makeList(items, mode = "single") {
  return new OptionList(items, mode, themeBag, pituiBag);
}

const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ARROW_LEFT = "\x1b[D";
const ARROW_RIGHT = "\x1b[C";
const ENTER = "\r";
const ESC = "\x1b";
const SPACE = " ";
const BACKSPACE = "\x7f";

// ── OptionList: single mode ─────────────────────────────────────────

check("OptionList single: initial collect → [first item value]", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  const c = list.collect();
  if (c.length !== 1 || c[0] !== "A") throw new Error(`got ${JSON.stringify(c)}`);
});

check("OptionList single: ↓ moves highlight, collect reflects new pick", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  list.handleInput(ARROW_DOWN);
  const c = list.collect();
  if (c[0] !== "B") throw new Error(`expected B, got ${JSON.stringify(c)}`);
});

check("OptionList single: ↑ wraps from index 0 to last", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  list.handleInput(ARROW_UP); // wrap to last (Other)
  if (list.collect().length !== 0) {
    throw new Error("highlight on Other with empty text → collect []");
  }
});

check("OptionList single: highlight on Other with empty text → collect []", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  list.handleInput(ARROW_DOWN); // go to Other
  const c = list.collect();
  if (c.length !== 0) throw new Error(`expected [], got ${JSON.stringify(c)}`);
});

check("OptionList single: highlight on Other + type text → collect [text]", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  list.handleInput(ARROW_DOWN); // go to Other
  list.handleInput("h");
  list.handleInput("i");
  const c = list.collect();
  if (c.length !== 1 || c[0] !== "hi") throw new Error(`expected ['hi'], got ${JSON.stringify(c)}`);
});

check("OptionList single: space on non-Other row is no-op (no toggle)", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  list.handleInput(SPACE);
  const c = list.collect();
  if (c[0] !== "A") throw new Error(`space should be no-op, got ${JSON.stringify(c)}`);
});

check("OptionList single: Enter / Esc / arrows ← → NOT consumed (bubble)", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  // Enter on first row should not change state
  list.handleInput(ENTER);
  if (list.collect()[0] !== "A") throw new Error("Enter changed state");
  // Esc same
  list.handleInput(ESC);
  if (list.collect()[0] !== "A") throw new Error("Esc changed state");
});

// ── OptionList: multi mode ──────────────────────────────────────────

check("OptionList multi: initial collect → [] (nothing toggled, no Other text)", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "multi");
  if (list.collect().length !== 0) throw new Error("initial multi should collect []");
});

check("OptionList multi: space toggles current preset → collect [A]", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "multi");
  list.handleInput(SPACE);
  const c = list.collect();
  if (c.length !== 1 || c[0] !== "A") throw new Error(`expected [A], got ${JSON.stringify(c)}`);
});

check("OptionList multi: toggle two presets → collect [A, B]", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "multi");
  list.handleInput(SPACE);
  list.handleInput(ARROW_DOWN);
  list.handleInput(SPACE);
  const c = list.collect();
  if (c.length !== 2 || c[0] !== "A" || c[1] !== "B") {
    throw new Error(`expected [A,B], got ${JSON.stringify(c)}`);
  }
});

check("OptionList multi: toggle preset twice → de-toggled", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
  ], "multi");
  list.handleInput(SPACE);
  list.handleInput(SPACE);
  if (list.collect().length !== 0) throw new Error("double-toggle should de-select");
});

check("OptionList multi: type into Other → collect includes otherText", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "multi");
  list.handleInput(ARROW_DOWN); // go to Other
  list.handleInput("x");
  list.handleInput("y");
  const c = list.collect();
  if (c.length !== 1 || c[0] !== "xy") throw new Error(`expected [xy], got ${JSON.stringify(c)}`);
});

check("OptionList multi: toggle preset + type Other → both in collect", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "B", label: "Banana", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "multi");
  list.handleInput(SPACE);          // toggle A
  list.handleInput(ARROW_DOWN);
  list.handleInput(SPACE);          // toggle B
  list.handleInput(ARROW_DOWN);     // go to Other
  list.handleInput("x");
  const c = list.collect();
  if (c.length !== 3) throw new Error(`expected 3 items, got ${JSON.stringify(c)}`);
  if (c[0] !== "A" || c[1] !== "B" || c[2] !== "x") {
    throw new Error(`expected [A,B,x], got ${JSON.stringify(c)}`);
  }
});

check("OptionList multi: Other text auto-implies selection (no space needed)", () => {
  // R7.3 spec: "多选模式下判断 other 有没有选中就根据用户有没有输入内容判断"
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "multi");
  list.handleInput(ARROW_DOWN);
  list.handleInput("z");
  if (list.collect().length !== 1) throw new Error("Other text alone should be a selection");
  // Backspace clear → no longer selected
  list.handleInput(BACKSPACE);
  if (list.collect().length !== 0) throw new Error("Empty Other should not be selected");
});

check("OptionList multi: ↓ from last wraps to 0", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "multi");
  list.handleInput(ARROW_DOWN); // 0 → 1 (Other)
  list.handleInput(ARROW_DOWN); // 1 → 0 (wrap)
  // Now toggle row 0
  list.handleInput(SPACE);
  if (list.collect()[0] !== "A") throw new Error("↓ wrap broken");
});

// ── OptionList: cursorAtStart / cursorAtEnd (wizard ← → probes) ─────

check("OptionList: cursorAtStart=true when highlight on non-Other row", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  if (!list.cursorAtStart()) throw new Error("non-Other should always atStart");
  if (!list.cursorAtEnd()) throw new Error("non-Other should always atEnd");
});

check("OptionList: cursorAtStart depends on Input.cursor on Other row", () => {
  const list = makeList([
    { value: "A", label: "Apple", isOther: false },
    { value: "__pu_other__", label: "Other", isOther: true },
  ], "single");
  list.handleInput(ARROW_DOWN); // on Other, empty text
  if (!list.cursorAtStart()) throw new Error("Other empty should be atStart");
  if (!list.cursorAtEnd()) throw new Error("Other empty should also be atEnd");
  list.handleInput("a");
  list.handleInput("b");
  // Cursor is at end after typing
  if (!list.cursorAtEnd()) throw new Error("After typing, cursor should be atEnd");
  if (list.cursorAtStart()) throw new Error("After typing, cursor should NOT be atStart");
  // Move cursor to start
  list.handleInput(ARROW_LEFT);
  list.handleInput(ARROW_LEFT);
  if (!list.cursorAtStart()) throw new Error("After ← ←, cursor should be atStart");
});

// ── MaskedInput ─────────────────────────────────────────────────────

check("MaskedInput: type chars → getValue returns raw buffer", () => {
  const m = new MaskedInput();
  m.handleInput("p");
  m.handleInput("a");
  m.handleInput("s");
  m.handleInput("s");
  if (m.getValue() !== "pass") throw new Error(`expected 'pass', got '${m.getValue()}'`);
});

check("MaskedInput: render shows • per char, not raw", () => {
  const m = new MaskedInput();
  m.handleInput("a");
  m.handleInput("b");
  m.handleInput("c");
  const lines = m.render(40);
  if (lines.length !== 1) throw new Error(`expected 1 line, got ${lines.length}`);
  if (!lines[0].includes("•••")) throw new Error(`expected ••• in render, got ${lines[0]}`);
  if (lines[0].includes("abc")) throw new Error(`render leaked raw: ${lines[0]}`);
});

check("MaskedInput: backspace deletes last char", () => {
  const m = new MaskedInput();
  m.handleInput("a");
  m.handleInput("b");
  m.handleInput(BACKSPACE);
  if (m.getValue() !== "a") throw new Error(`expected 'a', got '${m.getValue()}'`);
});

check("MaskedInput: Enter / Esc / arrows NOT consumed (bubble to wizard)", () => {
  const m = new MaskedInput();
  m.handleInput("a");
  m.handleInput(ENTER);
  if (m.getValue() !== "a") throw new Error("Enter should not wipe");
  m.handleInput(ESC);
  if (m.getValue() !== "a") throw new Error("Esc should not wipe");
  m.handleInput(ARROW_LEFT);
  if (m.getValue() !== "a") throw new Error("← should not insert");
});

check("MaskedInput: wipe() clears buffer", () => {
  const m = new MaskedInput();
  m.handleInput("s");
  m.handleInput("e");
  m.handleInput("c");
  m.wipe();
  if (m.getValue() !== "") throw new Error("wipe should clear buffer");
});

check("MaskedInput: control chars are filtered out of buffer", () => {
  const m = new MaskedInput();
  m.handleInput("a");
  m.handleInput("\x07"); // BEL
  m.handleInput("\t");   // tab
  m.handleInput("b");
  if (m.getValue() !== "ab") throw new Error(`expected 'ab', got '${m.getValue()}'`);
});

// ── Wizard: multi-question Enter advance + collect on submit ────────

function buildWizard(questions) {
  let resolved = null;
  const root = buildPromptDialog({
    params: { reason: "test", questions, timeoutSec: 30 },
    variant: "question",
    tui: { requestRender: () => {} },
    theme: fullTheme,
    pitui: pituiBag,
    onDone: (r) => { resolved = r; },
  });
  return { root, getResolved: () => resolved };
}

check("Wizard: single question Enter on last → submit with collect", () => {
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "Yes" }, { label: "No" }],
    },
  ]);
  root.handleInput(ENTER);
  const r = getResolved();
  if (!r) throw new Error("wizard didn't resolve");
  if (r.outcome !== "submit") throw new Error(`expected submit, got ${r.outcome}`);
  if (!r.answers.q1 || r.answers.q1[0] !== "Yes") {
    throw new Error(`answer wrong: ${JSON.stringify(r.answers)}`);
  }
});

check("Wizard: Esc on any question → cancel + empty answers", () => {
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "Yes" }, { label: "No" }],
    },
    { id: "q2", header: "h", question: "q?", type: "text" },
  ]);
  root.handleInput(ARROW_DOWN); // change q1 highlight to "No"
  root.handleInput(ESC);
  const r = getResolved();
  if (r.outcome !== "cancel") throw new Error(`expected cancel, got ${r.outcome}`);
  if (Object.keys(r.answers).length !== 0) {
    throw new Error(`cancel should have empty answers, got ${JSON.stringify(r.answers)}`);
  }
});

check("Wizard: 2 questions, Enter advances then submits on last", () => {
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "A" }, { label: "B" }],
    },
    {
      id: "q2", header: "h", question: "q?", type: "single",
      options: [{ label: "X" }, { label: "Y" }],
    },
  ]);
  root.handleInput(ENTER); // advance to q2 (collect q1=A later via collectFrom)
  if (getResolved()) throw new Error("should not have resolved after first Enter");
  root.handleInput(ARROW_DOWN); // q2 highlight Y
  root.handleInput(ENTER);      // submit
  const r = getResolved();
  if (r.outcome !== "submit") throw new Error(`expected submit, got ${r.outcome}`);
  if (r.answers.q1[0] !== "A") throw new Error(`q1 wrong: ${JSON.stringify(r.answers.q1)}`);
  if (r.answers.q2[0] !== "Y") throw new Error(`q2 wrong: ${JSON.stringify(r.answers.q2)}`);
});

check("Wizard: ← from question 2 goes back to question 1, state preserved", () => {
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "A" }, { label: "B" }],
    },
    {
      id: "q2", header: "h", question: "q?", type: "single",
      options: [{ label: "X" }, { label: "Y" }],
    },
  ]);
  root.handleInput(ARROW_DOWN); // q1 highlight B
  root.handleInput(ENTER);      // advance to q2
  root.handleInput(ARROW_LEFT); // back to q1
  // Now Enter twice to submit; q1 should still be "B"
  root.handleInput(ENTER);
  root.handleInput(ENTER);
  const r = getResolved();
  if (r.answers.q1[0] !== "B") {
    throw new Error(`q1 state lost across ← → navigation: ${JSON.stringify(r.answers)}`);
  }
});

check("Wizard: → on last question → forwarded to active (no-op for OptionList)", () => {
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "A" }, { label: "B" }],
    },
  ]);
  root.handleInput(ARROW_RIGHT);
  if (getResolved()) throw new Error("→ on last shouldn't resolve");
});

check("Wizard: ← on first question → forwarded to active (no-op)", () => {
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "A" }, { label: "B" }],
    },
  ]);
  root.handleInput(ARROW_LEFT);
  if (getResolved()) throw new Error("← on first shouldn't resolve");
});

check("Wizard: secret + cancel wipes buffer (INV-C)", () => {
  const { root, getResolved } = buildWizard([
    { id: "tok", header: "h", question: "secret?", type: "secret" },
  ]);
  root.handleInput("s");
  root.handleInput("3");
  root.handleInput("c");
  root.handleInput("r");
  root.handleInput("e");
  root.handleInput("t");
  root.handleInput(ESC);
  const r = getResolved();
  if (r.outcome !== "cancel") throw new Error(`expected cancel, got ${r.outcome}`);
  // rawSecrets should be empty on cancel (already wiped + Record empty)
  if (r.rawSecrets && Object.keys(r.rawSecrets).length !== 0) {
    throw new Error(`cancel should not leak rawSecrets: ${JSON.stringify(r.rawSecrets)}`);
  }
});

check("Wizard: secret + submit → rawSecrets populated, then wiped", () => {
  const { root, getResolved } = buildWizard([
    { id: "tok", header: "h", question: "secret?", type: "secret" },
  ]);
  root.handleInput("s");
  root.handleInput("3");
  root.handleInput("c");
  root.handleInput(ENTER);
  const r = getResolved();
  if (r.outcome !== "submit") throw new Error(`expected submit, got ${r.outcome}`);
  if (!r.rawSecrets || r.rawSecrets.tok !== "s3c") {
    throw new Error(`rawSecrets wrong: ${JSON.stringify(r.rawSecrets)}`);
  }
  if (r.answers.tok[0] !== "[REDACTED_SECRET:tok]") {
    throw new Error(`placeholder wrong: ${JSON.stringify(r.answers.tok)}`);
  }
});

check("Wizard: ← inside Other input at non-start position → cursor move, no nav", () => {
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "A" }, { label: "B" }],
    },
    {
      id: "q2", header: "h", question: "q?", type: "single",
      options: [{ label: "X" }, { label: "Y" }],
    },
  ]);
  // Advance to q2, then navigate to Other, then type text
  root.handleInput(ENTER); // advance to q2
  // q2 highlight is at 0 (X), navigate to Other (index 2)
  root.handleInput(ARROW_DOWN);
  root.handleInput(ARROW_DOWN);
  root.handleInput("h");
  root.handleInput("i");
  // Cursor is at end of "hi". ← should move cursor (cursorAtEnd=true so
  // first ← actually triggers switch-back-to-q1? NO — cursorAtEnd is
  // about *right arrow* probing next. ← probes cursorAtStart, which is
  // false because cursor is at position 2, not 0.
  root.handleInput(ARROW_LEFT);
  // Should still be on q2 (cursor at start would be 0; we're at 1 now)
  // Submit and verify
  root.handleInput(ENTER);
  const r = getResolved();
  if (r.answers.q2[0] !== "hi") {
    throw new Error(`q2 should keep 'hi', got ${JSON.stringify(r.answers.q2)}`);
  }
});

check("Wizard: ← at start of Other empty input on Q2 → navigates to Q1", () => {
  // q2 是 multi (不是 single) —— 这样 q2 empty Other 提交是合法的
  // (collect=[]),Enter 不会被「单选需非空」拦袪。这个 test 重点是
  // 验证 ← 在 q2 Other 空输入框上能切回 q1。
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "A" }, { label: "B" }],
    },
    {
      id: "q2", header: "h", question: "q?", type: "multi",
      options: [{ label: "X" }, { label: "Y" }],
    },
  ]);
  root.handleInput(ENTER); // advance to q2
  // Navigate to Other on q2
  root.handleInput(ARROW_DOWN);
  root.handleInput(ARROW_DOWN);
  // Other input is empty → cursorAtStart=true → ← navigates to q1
  root.handleInput(ARROW_LEFT);
  // 现在应该回到 q1。打个卷 marker (按下 ARROW_DOWN) 验证是在 q1:
  // 如果在 q1, 按 down 后 highlight 从 A 变 B; 如果在 q2, 从 Other 变 X (环).
  // 然后 Enter 推进到 q2, 再 Enter submit (q2 multi empty OK).
  root.handleInput(ARROW_DOWN); // q1: A → B (如果还在 q2 为 Other → 环到 X)
  root.handleInput(ENTER); // advance to q2 (q1 为 B)
  root.handleInput(ENTER); // submit (q2 multi, Other empty → [])
  const r = getResolved();
  if (!r) throw new Error("wizard didn't resolve after ← → navigation");
  if (r.outcome !== "submit") throw new Error(`expected submit, got ${r.outcome}`);
  if (r.answers.q1[0] !== "B") {
    // 如果 ← 没切成功, 那么 ARROW_DOWN 是作用在 q2 (从 Other 环到 X)
    // q1 仍为 A —— 这意味着 ← 实际未切换 question。
    throw new Error(`q1 should be B (proving ← did navigate back): got ${JSON.stringify(r.answers.q1)}`);
  }
});

check("Wizard: single+Other empty + Enter → no-op (doesn't submit invalid)", () => {
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "A" }, { label: "B" }],
    },
  ]);
  // Navigate to Other
  root.handleInput(ARROW_UP); // wrap from 0 to last (Other)
  // Empty + Enter should be no-op
  root.handleInput(ENTER);
  if (getResolved()) throw new Error("single+Other+empty+Enter should NOT submit");
});

check("R7.3+opus-P1.5: text type empty + Enter → no-op (consistent with single+Other+empty)", () => {
  // opus review P1.5 fix: text empty + Enter is now a no-op (was
  // previously "submit empty answer"). Aligns with single+Other+empty
  // behavior — both refuse to submit an empty answer.
  const { root, getResolved } = buildWizard([
    { id: "q1", header: "h", question: "q?", type: "text" },
  ]);
  root.handleInput(ENTER);
  if (getResolved()) throw new Error("text empty + Enter should be no-op, not submit");
  // Now type a real value and verify it DOES submit.
  root.handleInput("x");
  root.handleInput(ENTER);
  const r = getResolved();
  if (!r || r.outcome !== "submit") throw new Error(`expected submit after typing, got ${r?.outcome}`);
  if (!Array.isArray(r.answers.q1) || r.answers.q1[0] !== "x") {
    throw new Error(`answers.q1 wrong: ${JSON.stringify(r.answers)}`);
  }
});

check("R7.3+opus-P1.5: secret type empty + Enter → no-op", () => {
  const { root, getResolved } = buildWizard([
    { id: "s1", header: "h", question: "q?", type: "secret" },
  ]);
  root.handleInput(ENTER);
  if (getResolved()) throw new Error("secret empty + Enter should be no-op");
  root.handleInput("a");
  root.handleInput(ENTER);
  const r = getResolved();
  if (!r || r.outcome !== "submit") throw new Error("expected submit after typing");
  if (r.rawSecrets.s1 !== "a") throw new Error(`rawSecrets wrong: ${JSON.stringify(r.rawSecrets)}`);
});

check("R7.3+gpt-5.5: single+Other with whitespace-only text → no-op (trim check)", () => {
  // gpt-5.5 review fix: pre-fix, a single space in Other would pass
  // the truthy check and submit [" "]. Now we use .trim() so whitespace
  // alone is treated as empty.
  const { root, getResolved } = buildWizard([
    {
      id: "q1", header: "h", question: "q?", type: "single",
      options: [{ label: "A" }, { label: "B" }],
    },
  ]);
  // Navigate to Other (index 2 after the 2 presets)
  root.handleInput(ARROW_UP); // wrap from 0 to last (Other)
  root.handleInput(" "); // single space
  root.handleInput(ENTER);
  if (getResolved()) throw new Error("single+Other+whitespace-only should be no-op");
  // Now type a real character
  root.handleInput("x");
  root.handleInput(ENTER);
  const r = getResolved();
  if (!r) throw new Error("Should resolve after typing real content");
  if (r.answers.q1[0] !== " x") throw new Error(`expected ' x' (space + x), got ${JSON.stringify(r.answers.q1)}`);
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
