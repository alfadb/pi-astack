/**
 * `<PromptDialog>` TUI component (ADR 0022 P2, R7.3 rewrite).
 *
 * R7.3 (2026-05-17) — major rewrite per user-driven UX simplification:
 *
 *   1. **OptionList replaces pi-tui SelectList** for `type: "single"`
 *      and `type: "multi"`. Solves three problems:
 *        - SelectList is single-pick only (no space-toggle multi).
 *        - SelectList hard-truncates description on one line.
 *        - "Other" had to swapBody(Input), hiding the option list.
 *      OptionList is self-rendered, supports space-toggle multi, wraps
 *      long labels, and renders an inline Input at the Other row that
 *      stays visible alongside the other options.
 *
 *   2. **`description` field removed** from PromptUserOption (R7.2).
 *      Per user: "为什么要一个名称+一个描述,LLM 自己决定如何输入" —
 *      single `label` field, any length, OptionList wraps to lines.
 *
 *   3. **Input mode state machine removed**. OptionList is ALWAYS in
 *      "list focused" — printable chars / backspace / space route to
 *      Other's Input only when highlight === Other row. No
 *      "press Enter to enter input mode" friction.
 *
 *   4. **Multi-question wizard with left/right navigation** (cc-style):
 *      buildDialog constructs ALL question components up-front and
 *      caches them. ← / → switch between questions (when cursor is at
 *      start/end of any text Input). Each question's state is
 *      preserved when navigating away and back. Enter on non-last
 *      advances; Enter on last collects all and submits.
 *
 *   5. **`recommended`** rendered as `… (Recommended)` suffix instead
 *      of `★ ` prefix — visually lighter in long wrapped labels.
 *
 *   6. **MaskedInput.collect()** replaces onSubmit-via-Enter. The
 *      Enter-to-submit logic moved up to the wizard layer so all four
 *      question types follow the same advance/submit protocol.
 *
 * Variants:
 *   - `question`            (this ADR's main path; LLM-driven)
 *   - `vault_release`       (P3 will route authorizeVaultRelease here)
 *   - `bash_output_release` (P3 will route authorizeVaultBashOutput here)
 *
 * INV-C: `type:"secret"` raw never leaves PromptDialog closure —
 *        MaskedInput.buffer is wiped on finish() (submit AND cancel).
 *        Wizard collects raw at submit time only, into the local
 *        `rawSecrets` Record passed back via onDone.
 * INV-D: All 4 user-visible fields (reason / header / question /
 *        option.label) are already redacted by service.askPromptUser
 *        before this file sees them. We render them verbatim.
 * INV-H: answers[id] is always `string[]`; collect() functions return
 *        arrays directly (length 0..N for multi, 1 for single/text/secret).
 *
 * Sub-pi: this file should NEVER be reached in sub-pi (handler guard
 * runs first). MaskedInput buffer is still wiped on dispose so an
 * unexpected re-entry can't leave plaintext sitting in component state.
 */

import type { PromptUserParams, PromptUserQuestion } from "../types";
import type { RawDialogResult } from "../service";

// ── pi-tui surface bag (injected at activation) ─────────────────────

export interface PiTuiBag {
  Container: new () => PiTuiContainer;
  Text: new (text: string, paddingX?: number, paddingY?: number) => PiTuiComponent;
  Input: new () => PiTuiInput;
  /**
   * Kept in the bag for type compatibility but UNUSED post-R7 — replaced
   * by self-rendered OptionList. Removing it would be a breaking change
   * for the activation wiring in `extensions/abrain/index.ts`; leaving
   * it harmless.
   */
  SelectList: new (
    items: Array<{ value: string; label: string; description?: string }>,
    maxVisible: number,
    theme: SelectListTheme,
  ) => PiTuiComponent;
  DynamicBorder: new (paint: (s: string) => string) => PiTuiComponent;
  Spacer: new (lines?: number) => PiTuiComponent;
}

interface SelectListTheme {
  selectedPrefix: (text: string) => string;
  selectedText: (text: string) => string;
  description: (text: string) => string;
  scrollInfo: (text: string) => string;
  noMatch: (text: string) => string;
}

export interface PiTuiComponent {
  render(width: number): string[];
  handleInput?(data: string): void;
  invalidate?(): void;
}

export interface PiTuiContainer extends PiTuiComponent {
  children: PiTuiComponent[];
  addChild(child: PiTuiComponent): void;
  clear(): void;
}

interface PiTuiInput extends PiTuiComponent {
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  focused: boolean;
  /** pi-tui Input exposes cursor + value publicly; we read them for
   * `cursorAtStart/End` detection in the wizard left/right routing. */
  cursor?: number;
  value?: string;
  getValue(): string;
  setValue(value: string): void;
}

export interface ThemeBag {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface TuiRuntime {
  requestRender(): void;
}

export interface BuildDialogArgs {
  params: PromptUserParams;
  variant: "question" | "vault_release" | "bash_output_release";
  tui: TuiRuntime;
  theme: ThemeBag;
  pitui: PiTuiBag;
  onDone: (result: RawDialogResult | null) => void;
}

// ── CJK-aware char-level wrap ───────────────────────────────────────

/**
 * Compute the display width of one Unicode codepoint. East Asian
 * Wide / Fullwidth = 2 cells, control chars = 0, everything else = 1.
 */
function cellWidth(cp: number): number {
  if (cp < 0x20) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x2fffd) ||
    (cp >= 0x30000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

/**
 * Wrap `text` to lines of ≤ `width` display cells, preferring ASCII
 * word boundaries; CJK wraps per-character. Empty input → `[""]`.
 */
function wrapToWidth(text: string, width: number): string[] {
  if (width <= 0) return [text];
  if (!text) return [""];
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  let pendingWord = "";
  let pendingWordWidth = 0;
  const flushWord = (): void => {
    if (!pendingWord) return;
    if (lineWidth + pendingWordWidth <= width) {
      line += pendingWord;
      lineWidth += pendingWordWidth;
    } else {
      if (line.trim()) lines.push(line);
      if (pendingWordWidth > width) {
        let chunk = "";
        let chunkWidth = 0;
        for (const ch of pendingWord) {
          const w = cellWidth(ch.codePointAt(0) ?? 0);
          if (chunkWidth + w > width) {
            lines.push(chunk);
            chunk = ch;
            chunkWidth = w;
          } else {
            chunk += ch;
            chunkWidth += w;
          }
        }
        line = chunk;
        lineWidth = chunkWidth;
      } else {
        line = pendingWord;
        lineWidth = pendingWordWidth;
      }
    }
    pendingWord = "";
    pendingWordWidth = 0;
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const w = cellWidth(cp);
    const isCJK = w === 2;
    const isSpace = ch === " ";
    if (isSpace) {
      flushWord();
      if (lineWidth + 1 <= width) {
        line += " ";
        lineWidth += 1;
      } else {
        if (line.trim()) lines.push(line);
        line = "";
        lineWidth = 0;
      }
      continue;
    }
    if (isCJK) {
      flushWord();
      if (lineWidth + w > width) {
        if (line.trim()) lines.push(line);
        line = ch;
        lineWidth = w;
      } else {
        line += ch;
        lineWidth += w;
      }
    } else {
      pendingWord += ch;
      pendingWordWidth += w;
    }
  }
  flushWord();
  if (line) lines.push(line);
  if (lines.length === 0) lines.push("");
  return lines;
}

// ── OptionList: self-rendered single/multi with inline Other ────────

/**
 * OptionList — R7.3 simplified state machine (no more input mode).
 *
 * Focus is ALWAYS on the list. There's no mode switch. The Other row
 * has a permanently-visible inline Input; whether that Input shows a
 * blinking cursor depends purely on `highlightIdx === otherIdx`.
 *
 * Key routing (handled inside OptionList.handleInput):
 *   - ↑ / ↓                  → move highlight (wraps top↔bottom)
 *   - space, non-Other, multi → toggle selected[idx]
 *   - space, Other row        → insert ' ' into otherInput buffer
 *   - any printable char      → if highlight=Other, route to otherInput;
 *                               else ignored (user must use space/arrows)
 *   - backspace               → if highlight=Other, route to otherInput;
 *                               else ignored
 *
 * The following keys are NOT handled here — they bubble up to the
 * wizard layer (`root.handleInput`):
 *   - Esc                    → wizard cancels the entire dialog
 *   - Enter                  → wizard advances / submits
 *   - ← / →                  → wizard handles question navigation
 *                              (after consulting cursorAtStart/End)
 *
 * INV-H preservation: collect() always returns string[].
 *   - single:
 *       - highlight on Other → [otherText] (or [] if empty)
 *       - highlight on preset → [opt.label]
 *   - multi: (toggled preset labels) + [otherText if non-empty]
 *
 * Note on multi mode: there is NO explicit "Other selected" flag.
 * The Other contribution is derived purely from `otherInput.getValue()`
 * being non-empty. This matches the user spec:
 *   "多选模式下判断 other 有没有选中就根据用户有没有输入内容判断"
 */
interface OptionListItem {
  value: string;
  label: string;           // displayed text (with optional "(Recommended)" suffix)
  isOther: boolean;
}

interface OptionListTheme {
  accent: (s: string) => string;
  muted: (s: string) => string;
  dim: (s: string) => string;
}

export class OptionList implements PiTuiComponent {
  private highlightIdx = 0;
  private readonly selected = new Set<number>();
  private readonly otherInput: PiTuiInput;
  /** Placeholder shown in empty Other input. */
  private static readonly OTHER_PLACEHOLDER = "(type to fill)";

  constructor(
    private readonly items: OptionListItem[],
    private readonly mode: "single" | "multi",
    private readonly themeBag: OptionListTheme,
    pitui: PiTuiBag,
  ) {
    this.otherInput = new pitui.Input();
    this.otherInput.focused = false;
  }

  private get otherIdx(): number {
    return this.items.length - 1;
  }

  private get otherText(): string {
    return this.otherInput.getValue();
  }

  /**
   * R7.3 collect interface: returns the canonical answer values.
   *
   * GPT-5.5 review fix: Other text uses `.trim()` check instead of truthy.
   * Pre-fix bug: in single mode, user could press space-on-Other then
   * Enter and pass [" "] (a whitespace string is truthy), bypassing
   * the "empty Other = no-op" guard. Same in multi mode (whitespace
   * Other would render `[×]` and contribute a blank entry to the
   * answer array).
   *
   * We submit the ORIGINAL otherText (not trimmed) on the small chance
   * the user genuinely wants leading/trailing space; the trim check is
   * only for "is this answer effectively non-empty".
   */
  collect(): string[] {
    if (this.mode === "single") {
      const item = this.items[this.highlightIdx];
      if (item.isOther) {
        const text = this.otherText;
        return text.trim() ? [text] : [];
      }
      return [item.value];
    }
    // multi
    const values: string[] = [];
    for (let i = 0; i < this.items.length; i++) {
      if (i === this.otherIdx) continue;
      if (this.selected.has(i)) values.push(this.items[i].value);
    }
    const text = this.otherText;
    if (text.trim()) values.push(text);
    return values;
  }

  /** Wizard left-arrow probe: should ← navigate to previous question? */
  cursorAtStart(): boolean {
    if (this.highlightIdx === this.otherIdx) {
      return (this.otherInput.cursor ?? 0) === 0;
    }
    return true;
  }

  /** Wizard right-arrow probe: should → navigate to next question? */
  cursorAtEnd(): boolean {
    if (this.highlightIdx === this.otherIdx) {
      const cur = this.otherInput.cursor ?? 0;
      const len = (this.otherInput.value ?? "").length;
      return cur >= len;
    }
    return true;
  }

  render(width: number): string[] {
    const lines: string[] = [];
    const descIndent = this.mode === "multi" ? 8 : 4;
    const descPad = " ".repeat(descIndent);
    const labelIndent = this.mode === "multi" ? 6 : 2; // "  [×] " or "  "
    const labelWidth = Math.max(1, width - labelIndent);

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      const isHighlight = i === this.highlightIdx;
      const arrow = isHighlight ? "→ " : "  ";
      // R7.3 checkbox semantics:
      //   - multi preset: "[×]" if selected, "[ ]" if not.
      //   - multi Other:  "[×]" if otherText.trim() non-empty, "[+]" else.
      //                   "+" hints at "add a custom answer" (implicit
      //                   selection via has-text rather than explicit
      //                   space-toggle). Uses `.trim()` so a single
      //                   space doesn't flip to [×] (gpt-5.5 review).
      //   - single:       no checkbox.
      let checkbox = "";
      if (this.mode === "multi") {
        if (item.isOther) {
          checkbox = this.otherText.trim() ? "[×] " : "[+] ";
        } else {
          checkbox = this.selected.has(i) ? "[×] " : "[ ] ";
        }
      }

      // Wrap label across multiple lines if it exceeds labelWidth.
      const labelLines = wrapToWidth(item.label, labelWidth);
      for (let li = 0; li < labelLines.length; li++) {
        const lineText = li === 0
          ? `${arrow}${checkbox}${labelLines[li]}`
          : `${" ".repeat(labelIndent)}${labelLines[li]}`;
        lines.push(
          isHighlight ? this.themeBag.accent(lineText) : this.themeBag.dim(lineText),
        );
      }

      // Other row's inline Input — ALWAYS rendered (R7.3 spec: Other
      // input box is permanent, not gated by selection or highlight).
      // Cursor visibility is the only thing that depends on highlight.
      if (item.isOther) {
        this.otherInput.focused = isHighlight;
        const text = this.otherText;
        if (!text) {
          // Empty: render placeholder hint with cursor if highlight.
          const cursor = isHighlight ? "▏" : "";
          lines.push(this.themeBag.muted(`${descPad}${cursor}${OptionList.OTHER_PLACEHOLDER}`));
        } else {
          // Non-empty: render the actual input (pi-tui Input handles
          // cursor positioning + horizontal scrolling for long text).
          // We feed it a width budget that leaves room for our pad.
          const inputLines = this.otherInput.render(Math.max(1, width - descIndent));
          for (const il of inputLines) {
            lines.push(descPad + il);
          }
        }
      }
    }
    return lines;
  }

  handleInput(data: string): void {
    // Up / Down
    if (data === "\x1b[A" || data === "\x1bOA") {
      this.highlightIdx = this.highlightIdx === 0
        ? this.items.length - 1
        : this.highlightIdx - 1;
      return;
    }
    if (data === "\x1b[B" || data === "\x1bOB") {
      this.highlightIdx = this.highlightIdx === this.items.length - 1
        ? 0
        : this.highlightIdx + 1;
      return;
    }
    // Esc / Enter / ←/→ bubble up to the wizard — DO NOT consume.
    if (data === "\x1b") return; // bare Esc, leave for wizard
    if (data === "\r" || data === "\n") return;
    if (data === "\x1b[D" || data === "\x1b[C" || data === "\x1bOD" || data === "\x1bOC") {
      // ← / → consumed by wizard *only* when cursorAtStart/End.
      // Otherwise the wizard will forward back to us, and we route to
      // otherInput if highlight=Other. We need to handle that forwarded
      // case here:
      if (this.highlightIdx === this.otherIdx) {
        this.otherInput.handleInput?.(data);
      }
      return;
    }

    // Highlight on Other row: route printable chars / backspace to
    // the inline Input. Space is a printable char in this context.
    if (this.highlightIdx === this.otherIdx) {
      this.otherInput.handleInput?.(data);
      return;
    }

    // Space on non-Other row: multi toggles, single no-op.
    if (data === " " && this.mode === "multi") {
      if (this.selected.has(this.highlightIdx)) {
        this.selected.delete(this.highlightIdx);
      } else {
        this.selected.add(this.highlightIdx);
      }
      return;
    }
    // Other keys: ignored on non-Other rows.
  }

  invalidate(): void {
    this.otherInput.invalidate?.();
  }
}

// ── MaskedInput: secret with collect-only contract ──────────────────

/**
 * Renders one `•` per character. Wipes the buffer on `wipe()` (called
 * by the wizard on finish — both submit and cancel).
 *
 * R7.3: no `onSubmit`/`onEscape` callbacks anymore. Enter / Esc are
 * handled by the wizard. `collect()` returns the raw buffer + the
 * INV-C placeholder; wizard writes raw to its closure-scoped
 * `rawSecrets` Record and immediately calls wipe().
 */
export class MaskedInput implements PiTuiComponent {
  private buffer = "";
  focused = false;

  /** Current secret length — used by service.ts to compute lengthBucket. */
  getValue(): string {
    return this.buffer;
  }

  render(_width: number): string[] {
    const masked = "•".repeat(this.buffer.length);
    const cursor = this.focused ? "▏" : "";
    return [`  ${masked}${cursor}`];
  }

  handleInput(data: string): void {
    if (!data) return;
    // Enter / Esc / arrows bubble to wizard.
    if (data === "\r" || data === "\n") return;
    if (data === "\x1b") return;
    if (data.startsWith("\x1b[") || data.startsWith("\x1bO")) return;
    // Backspace / DEL
    if (data === "\x7f" || data === "\b") {
      if (this.buffer.length > 0) {
        this.buffer = this.buffer.slice(0, -1);
      }
      return;
    }
    // Filter ALL C0 controls + DEL from the data — opus review P1.2.
    // Pre-fix: only data.length===1 was filtered, so a bracketed paste
    // like "abc\x07def" landed in the buffer with the BEL byte. Doesn't
    // break INV-C but feeds garbage into lengthBucket and into the
    // raw secret value handed to the caller.
    let cleaned = "";
    for (const ch of data) {
      const code = ch.charCodeAt(0);
      if (code < 0x20 || code === 0x7f) continue;
      cleaned += ch;
    }
    if (!cleaned) return;
    this.buffer += cleaned;
  }

  invalidate(): void { /* no-op */ }

  /**
   * INV-C: explicit teardown called by the wizard on finish().
   * Overwriting with NUL bytes first nudges the V8 GC to drop the
   * old string content sooner.
   */
  wipe(): void {
    this.buffer = "\0".repeat(this.buffer.length);
    this.buffer = "";
  }
}

// ── PaddedBox: pure-render left padding ─────────────────────────────

/**
 * Prepends `paddingLeft` spaces to every line a child renders.
 * Does NOT participate in input routing.
 */
class PaddedBox implements PiTuiComponent {
  constructor(private child: PiTuiComponent, private paddingLeft: number) {}
  render(width: number): string[] {
    const innerWidth = Math.max(1, width - this.paddingLeft);
    const lines = this.child.render(innerWidth);
    const pad = " ".repeat(this.paddingLeft);
    return lines.map((l) => pad + l);
  }
  invalidate(): void {
    this.child.invalidate?.();
  }
}

// ── Wizard: builds dialog + routes input across questions ───────────

interface QuestionEntry {
  q: PromptUserQuestion;
  component: PiTuiComponent;
}

function isOptionList(c: PiTuiComponent): c is OptionList {
  return c instanceof OptionList;
}
function isMaskedInput(c: PiTuiComponent): c is MaskedInput {
  return c instanceof MaskedInput;
}

/** Returns {values, rawSecret?} without finalizing. */
function collectFrom(
  entry: QuestionEntry,
): { values: string[]; rawSecret?: string } {
  const c = entry.component;
  if (isOptionList(c)) {
    return { values: c.collect() };
  }
  if (isMaskedInput(c)) {
    const raw = c.getValue();
    return {
      values: [`[REDACTED_SECRET:${entry.q.id}]`],
      rawSecret: raw,
    };
  }
  // pi-tui Input (type:text)
  const input = c as PiTuiInput;
  const value = input.getValue();
  return { values: value ? [value] : [] };
}

function componentCursorAtStart(c: PiTuiComponent): boolean {
  if (isOptionList(c)) return c.cursorAtStart();
  if (isMaskedInput(c)) return true;
  // pi-tui Input
  return ((c as PiTuiInput).cursor ?? 0) === 0;
}

function componentCursorAtEnd(c: PiTuiComponent): boolean {
  if (isOptionList(c)) return c.cursorAtEnd();
  if (isMaskedInput(c)) return true;
  const input = c as PiTuiInput;
  return (input.cursor ?? 0) === (input.value ?? "").length;
}

export function buildPromptDialog(args: BuildDialogArgs): PiTuiContainer {
  const { params, variant, tui, theme, pitui, onDone } = args;
  const root = new pitui.Container();

  const accentColor =
    variant === "question" ? "accent" :
    variant === "vault_release" ? "warning" :
    "warning";
  const paint = (s: string) => theme.fg(accentColor, s);

  // Build ALL question components up-front so navigating back to a
  // previous question preserves its state.
  const entries: QuestionEntry[] = params.questions.map((q) => {
    if (q.type === "single" || q.type === "multi") {
      const options = q.options ?? [];
      const OTHER_VALUE = "__pu_other__";
      const items: OptionListItem[] = options.map((opt) => ({
        value: opt.label,
        label: opt.recommended ? `${opt.label} (Recommended)` : opt.label,
        isOther: false,
      }));
      items.push({
        value: OTHER_VALUE,
        label: "Other (specify)",
        isOther: true,
      });
      const list = new OptionList(
        items,
        q.type,
        {
          accent: (s) => theme.fg(accentColor, s),
          muted: (s) => theme.fg("muted", s),
          dim: (s) => theme.fg("text", s),
        },
        pitui,
      );
      return { q, component: list };
    }
    if (q.type === "text") {
      const input = pitui ? new pitui.Input() : ({} as PiTuiInput);
      input.focused = true;
      return { q, component: input };
    }
    // secret
    const masked = new MaskedInput();
    masked.focused = true;
    return { q, component: masked };
  });

  let currentIdx = 0;

  const titlePrefix =
    variant === "question" ? "Question" :
    variant === "vault_release" ? "Vault Release" :
    "Vault Bash Output";

  /** Wipe all masked secret buffers on the way out (INV-C). */
  const wipeAllSecrets = (): void => {
    for (const e of entries) {
      if (isMaskedInput(e.component)) e.component.wipe();
    }
  };

  const finishWithSubmit = (): void => {
    const answers: Record<string, string[]> = {};
    const rawSecrets: Record<string, string> = {};
    for (const e of entries) {
      const c = collectFrom(e);
      answers[e.q.id] = c.values;
      if (c.rawSecret !== undefined) rawSecrets[e.q.id] = c.rawSecret;
    }
    wipeAllSecrets();
    onDone({ outcome: "submit", answers, rawSecrets });
  };

  const finishWithCancel = (): void => {
    wipeAllSecrets();
    onDone({ outcome: "cancel", answers: {}, rawSecrets: {} });
  };

  const rebuildLayout = (): void => {
    root.clear();
    root.addChild(new pitui.DynamicBorder(paint));
    root.addChild(
      new pitui.Text(theme.fg(accentColor, theme.bold(titlePrefix)), 1, 0),
    );
    root.addChild(new pitui.Spacer(1));
    root.addChild(new pitui.Text(theme.fg("muted", params.reason), 1, 0));
    root.addChild(new pitui.Spacer(1));
    const entry = entries[currentIdx];
    const q = entry.q;
    const progress = entries.length > 1
      ? ` (${currentIdx + 1}/${entries.length})`
      : "";
    root.addChild(
      new pitui.Text(theme.bold(`${q.header}${progress}`), 1, 0),
    );
    root.addChild(new pitui.Text(q.question, 1, 0));
    root.addChild(new pitui.Spacer(1));
    root.addChild(new PaddedBox(entry.component, 1));
    root.addChild(new pitui.Spacer(1));
    // Hint changes per type + wizard position.
    const enterHint = currentIdx < entries.length - 1
      ? "enter next"
      : "enter submit";
    const arrowHint = entries.length > 1
      ? " • ← → switch question"
      : "";
    const typeHint =
      q.type === "single" || q.type === "multi"
        ? `↑↓ navigate${q.type === "multi" ? " • space toggle" : ""}`
        : q.type === "text"
          ? "type to fill"
          : "type to fill (masked)";
    root.addChild(
      new pitui.Text(
        theme.fg("dim", `${typeHint} • ${enterHint}${arrowHint} • esc cancel`),
        1,
        0,
      ),
    );
    root.addChild(new pitui.DynamicBorder(paint));
  };

  // ── Wizard input router ───────────────────────────────────────────
  (root as PiTuiContainer & { handleInput?: (data: string) => void }).handleInput = (
    data: string,
  ) => {
    const active = entries[currentIdx].component;

    // Esc → cancel whole dialog.
    if (data === "\x1b") {
      finishWithCancel();
      return;
    }
    // Enter → advance or submit.
    if (data === "\r" || data === "\n") {
      // R7.3 + opus P1.5 fix: validate before advancing.
      // Rules:
      //   - single mode + collect()==[]  (highlight on Other empty)  → no-op
      //   - multi mode + collect()==[]   (nothing toggled, empty Other) → ALLOW (multi can be 0..N)
      //   - text mode + empty value     → no-op (same UX as single+Other+empty)
      //   - secret mode + empty buffer  → no-op (don't submit a placeholder for an empty secret)
      const entry = entries[currentIdx];
      const q = entry.q;
      if (isOptionList(active)) {
        const c = (active as OptionList).collect();
        if (c.length === 0 && q.type === "single") {
          return; // user must pick something or type into Other
        }
      } else if (isMaskedInput(active)) {
        if ((active as MaskedInput).getValue().length === 0) {
          return; // empty secret — user must type or press Esc
        }
      } else {
        // pi-tui Input (type:text)
        const text = (active as PiTuiInput).getValue();
        if (!text.trim()) return; // empty / whitespace-only text — no-op
      }
      if (currentIdx === entries.length - 1) {
        finishWithSubmit();
      } else {
        currentIdx += 1;
        rebuildLayout();
      }
      tui.requestRender();
      return;
    }
    // ← →: switch question when cursor is at start/end.
    if (data === "\x1b[D" || data === "\x1bOD") {
      if (currentIdx > 0 && componentCursorAtStart(active)) {
        currentIdx -= 1;
        rebuildLayout();
        tui.requestRender();
        return;
      }
      // Otherwise forward to active component (Input cursor move).
      active.handleInput?.(data);
      tui.requestRender();
      return;
    }
    if (data === "\x1b[C" || data === "\x1bOC") {
      if (currentIdx < entries.length - 1 && componentCursorAtEnd(active)) {
        currentIdx += 1;
        rebuildLayout();
        tui.requestRender();
        return;
      }
      active.handleInput?.(data);
      tui.requestRender();
      return;
    }
    // Everything else: forward to active component.
    active.handleInput?.(data);
    tui.requestRender();
  };

  rebuildLayout();
  return root;
}

export function makeBuildDialog(pitui: PiTuiBag): (
  args: {
    params: PromptUserParams;
    variant: "question" | "vault_release" | "bash_output_release";
    onDone: (result: RawDialogResult | null) => void;
    tui: unknown;
    theme: unknown;
    keybindings: unknown;
  },
) => unknown {
  return (a) =>
    buildPromptDialog({
      params: a.params,
      variant: a.variant,
      tui: a.tui as TuiRuntime,
      theme: a.theme as ThemeBag,
      pitui,
      onDone: a.onDone,
    });
}
