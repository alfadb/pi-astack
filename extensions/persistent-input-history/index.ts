/**
 * persistent-input-history extension for pi-astack (v4 — event-driven).
 *
 * Persists the editor's ↑/↓ prompt history across pi restarts, per-cwd.
 *
 * Architecture (v4):
 *   - Disk writes happen exclusively in the `input` event handler — never
 *     from addToHistory, never from renderInitialMessages replay. This
 *     eliminates the fragile expectedReplay matcher and its setImmediate
 *     timing dependency that caused the P0 double-feed bug.
 *   - addToHistory() override performs MRU deduplication: if the text
 *     already exists anywhere in the history, it is moved to the front
 *     rather than duplicated. This naturally absorbs renderInitialMessages
 *     replay without any special matcher logic.
 *   - preloadFromDisk() seeds the base Editor's history array from disk
 *     at construction time (consecutive-dedup, reverse, cap).
 *
 * Configuration lives in `~/.pi/agent/pi-astack-settings.json`:
 *
 *   "persistentInputHistory": {
 *     "enabled": true,
 *     "historyDir": "~/.pi/agent/input-history",
 *     "maxEntries": 5000,
 *     "maxEntryBytes": 8192,
 *     "maxPreloadReadBytes": 5242880
 *   }
 *
 * Runtime data:
 *   - per-cwd JSONL: `<historyDir>/<sha1(cwd)[0..8]>--<slug>.jsonl`
 *   - privacy notice marker: `<historyDir>/.notified`
 *
 * Privacy: every submitted prompt — INCLUDING expanded paste content —
 * lands on disk in plain text (mode 0600 best-effort). Anything
 * sensitive you do not want persisted should not be submitted as a
 * prompt. Use `/history-compact` to dedupe or delete the directory
 * to purge.
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  DEFAULT_PERSISTENT_INPUT_HISTORY_SETTINGS,
  expandHome,
  FORCE_DISABLED,
  resolvePersistentInputHistorySettings,
  type PersistentInputHistorySettings,
} from "./settings";

// ──────────────────────────────────────────────────────────────────────
// pi SDK capability + version probe (defense against internal API drift)
//
// Two load-bearing assumptions this extension makes that are NOT in
// any pi SDK contract:
//
//   (1) `CustomEditor extends Editor` (pi-tui), and `Editor.prototype
//       .addToHistory(text: string): void` is a public, override-able
//       method.  ← Stable across all pi 0.7x; checked at module load.
//   (2) `Editor.history` is a plain JS instance array (TS-private but
//       runtime-readable via cast).  ← Could become `#history` /
//       WeakMap / renamed at any release.  Checked at FIRST ctor.
//
// v4 eliminates assumption (3) (the renderInitialMessages synchronous
// timing contract) by moving disk writes to the `input` event handler.
//
// If (1) breaks → integer regression: editor factory throw → user has
// no input box.  We therefore probe (1) at module load and refuse to
// install `setEditorComponent` if it's gone, surfacing one `error`
// notify so the user knows.
//
// If (2) breaks → preload silently no-op; the user would still get
// persistence of new prompts but lose ↑/↓ cross-restart recall.
// Surfaced as one `warning` notify per session.
// ──────────────────────────────────────────────────────────────────────

interface Capability {
  /** `CustomEditor.prototype.addToHistory` is a function (assumption 1). */
  hasAddToHistory: boolean;
}

const CAPABILITY: Capability = (() => {
  try {
    const proto = (CustomEditor as unknown as { prototype?: unknown }).prototype as
      | { addToHistory?: unknown }
      | undefined;
    const hasAddToHistory =
      !!proto && typeof proto.addToHistory === "function";
    return { hasAddToHistory };
  } catch {
    return { hasAddToHistory: false };
  }
})();

/**
 * pi-coding-agent semver as reported by its package.json. Best-effort:
 * if resolution fails (alternative load layout, ESM-only package, etc.)
 * we return `"unknown"` and `PI_VERSION_OK` stays true (don't punish
 * exotic setups; only warn when we can prove the version is outside
 * the tested range).
 */
const PI_VERSION: string = (() => {
  try {
    const req = createRequire(__filename);
    const pkg = req("@earendil-works/pi-coding-agent/package.json") as {
      version?: unknown;
    };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
})();

/**
 * Whether the running pi-coding-agent version falls in the range this
 * extension has been tested against. Boundaries:
 *
 *   - Lower: 0.75.x  — first version where this extension's
 *            populateHistory + setImmediate sequencing was validated.
 *   - Upper: < 1.0.0 — pi-mono is still pre-1.0; any 1.x.x bump is
 *            explicitly a signal to re-validate.
 *
 * Anything outside (including `"unknown"` which means resolution
 * failed) returns true to avoid false alarms — we only fire a warning
 * when we can prove drift.
 */
const PI_VERSION_OK: boolean = (() => {
  if (PI_VERSION === "unknown") return true;
  const m = /^(\d+)\.(\d+)\./.exec(PI_VERSION);
  if (!m) return true;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major !== 0) return false;          // 1.x.x+ → re-validate
  if (minor < 75) return false;           // < 0.75 untested
  return true;
})();

// ──────────────────────────────────────────────────────────────────────
// Resolved settings (loaded once at module load)
// ──────────────────────────────────────────────────────────────────────

const SETTINGS: PersistentInputHistorySettings = (() => {
  try {
    return resolvePersistentInputHistorySettings();
  } catch {
    return DEFAULT_PERSISTENT_INPUT_HISTORY_SETTINGS;
  }
})();

const HISTORY_DIR = expandHome(SETTINGS.historyDir);
const PRIVACY_NOTICE_MARKER = join(HISTORY_DIR, ".notified");
const MAX_ENTRIES = SETTINGS.maxEntries;
const MAX_ENTRY_BYTES = SETTINGS.maxEntryBytes;
const MAX_PRELOAD_READ_BYTES = SETTINGS.maxPreloadReadBytes;

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

/**
 * Stable, collision-free filename for a cwd: 8 hex chars of sha1(cwd)
 * for uniqueness + a human-readable slug for grep-ability.
 */
function encodeCwd(cwd: string): string {
  const hash = createHash("sha1").update(cwd).digest("hex").slice(0, 8);
  const slug = cwd
    .replace(/^[/\\]+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-40);
  return `${hash}--${slug || "root"}`;
}

function historyFileFor(cwd: string): string {
  return join(HISTORY_DIR, `${encodeCwd(cwd)}.jsonl`);
}

/** Old encoding scheme; we migrate from this on first run after upgrade. */
function legacyHistoryFileFor(cwd: string): string {
  const name = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(HISTORY_DIR, `${name}.jsonl`);
}

function tryMigrateLegacyHistory(newFile: string, cwd: string): void {
  if (existsSync(newFile)) return;
  const legacy = legacyHistoryFileFor(cwd);
  if (!existsSync(legacy)) return;
  try {
    mkdirSync(dirname(newFile), { recursive: true });
    renameSync(legacy, newFile);
    tightenPermissions(newFile);
  } catch {
    // best-effort
  }
}

interface HistoryRecord {
  ts: number;
  text: string;
}

/**
 * Safely access the base Editor's internal `history` array.
 *
 * pi-tui currently exposes `history = []` as a plain JS class field
 * (declared private only at the TS level), so reading it via cast
 * works at runtime. If upstream ever switches to a `#history` private
 * field, a renamed field, or a WeakMap, this returns null and we
 * degrade gracefully (no preload) instead of crashing the factory.
 */
function getInternalHistory(editor: unknown): string[] | null {
  const value = (editor as { history?: unknown }).history;
  return Array.isArray(value) ? (value as string[]) : null;
}

/**
 * Read disk history in chronological order (oldest first). Returns
 * [] on any IO error or empty file. Skips malformed JSON lines.
 *
 * For files larger than MAX_PRELOAD_READ_BYTES, only reads the tail
 * (and discards the first, likely-truncated line of that tail window).
 */
function readDiskHistory(file: string): string[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    const st = statSync(file);
    if (st.size <= MAX_PRELOAD_READ_BYTES) {
      raw = readFileSync(file, "utf8");
    } else {
      const fd = openSync(file, "r");
      try {
        const buf = Buffer.alloc(MAX_PRELOAD_READ_BYTES);
        readSync(fd, buf, 0, MAX_PRELOAD_READ_BYTES, st.size - MAX_PRELOAD_READ_BYTES);
        raw = buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
      const firstNl = raw.indexOf("\n");
      if (firstNl >= 0) raw = raw.slice(firstNl + 1);
    }
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as HistoryRecord;
      if (rec && typeof rec.text === "string" && rec.text.length > 0) {
        out.push(rec.text);
      }
    } catch {
      // Tolerate corrupt lines (partial writes, concurrent-append
      // interleaving). Lose one line, not the whole file.
    }
  }
  return out;
}

/** Read disk history WITH timestamps (used by /history-compact). */
function readDiskHistoryRecords(file: string): HistoryRecord[] {
  if (!existsSync(file)) return [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: HistoryRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line) as HistoryRecord;
      if (
        rec &&
        typeof rec.text === "string" &&
        rec.text.length > 0 &&
        typeof rec.ts === "number"
      ) {
        out.push(rec);
      }
    } catch {
      // tolerate
    }
  }
  return out;
}

/**
 * Append one entry. POSIX O_APPEND is atomic for writes < PIPE_BUF
 * (typically 4 KB on Linux). MAX_ENTRY_BYTES caps each entry so worst-
 * case writes stay near that boundary and concurrent pi instances
 * under the same cwd are safe.
 *
 * Best-effort: silently swallows errors; caller treats consistent
 * failure as a signal to stop trying.
 */
function appendDiskHistory(file: string, text: string): boolean {
  try {
    const rec: HistoryRecord = { ts: Date.now(), text };
    appendFileSync(file, `${JSON.stringify(rec)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewrite the entire history file from a chronological list of records.
 * Preserves original timestamps; used by /history-compact.
 */
function rewriteDiskHistory(file: string, records: HistoryRecord[]): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const lines = records.map((rec) => JSON.stringify(rec)).join("\n");
  writeFileSync(tmp, lines.length > 0 ? `${lines}\n` : "");
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}

function ensureHistoryDir(): void {
  if (!existsSync(HISTORY_DIR)) {
    mkdirSync(HISTORY_DIR, { recursive: true });
  }
}

/** Best-effort chmod 600 the history file on first creation. */
function tightenPermissions(file: string): void {
  try {
    chmodSync(file, 0o600);
  } catch {
    // best-effort
  }
}

// ──────────────────────────────────────────────────────────────────────
// Editor subclass
// ──────────────────────────────────────────────────────────────────────

/**
 * Override addToHistory() with MRU dedup and higher cap. Disk writes
 * happen in the `input` event handler, not here.
 *
 * MRU dedup: if the text already exists anywhere in the history, it is
 * removed from its old position and re-inserted at the front. This
 * naturally absorbs pi's renderInitialMessages populateHistory replay
 * without any special-case matcher — replayed entries are simply moved
 * to the front rather than duplicated.
 */
class PersistentHistoryEditor extends CustomEditor {
  private readonly historyFile: string;

  /**
   * Optional notifier injected by the session_start wiring. Used
   * exactly ONCE per editor instance, only when the TS-private
   * `Editor.history` field probe (assumption 2) returns null.
   */
  public degradedNotify?: (msg: string) => void;

  /** True if pi-tui's internal `history` field is gone (upstream change). */
  public readonly internalUnavailable: boolean;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    cwd: string,
  ) {
    super(tui, theme, keybindings);
    ensureHistoryDir();
    this.historyFile = historyFileFor(cwd);
    tryMigrateLegacyHistory(this.historyFile, cwd);
    this.internalUnavailable = getInternalHistory(this) === null;
    this.preloadFromDisk();

    // One-shot degraded notice. Deferred to microtask so the
    // notifier can be assigned by the factory between `new` and
    // the event-loop returning.
    if (this.internalUnavailable) {
      queueMicrotask(() => {
        try {
          this.degradedNotify?.(
            `persistent-input-history: pi-tui Editor.history field is unreachable ` +
              `(pi ${PI_VERSION}); preload + ↑/↓ cross-restart recall disabled this session. ` +
              `New prompts will still persist to disk. ` +
              `Set PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY=1 to silence this warning.`,
          );
        } catch {
          // notifier errors must never break editing
        }
      });
    }
  }

  /**
   * Seed the base Editor's `history` array from disk (newest at [0]).
   */
  private preloadFromDisk(): void {
    if (this.internalUnavailable) return;

    const chronological = readDiskHistory(this.historyFile);
    if (chronological.length === 0) return;

    // Collapse consecutive duplicates in chronological order.
    const dedup: string[] = [];
    for (const t of chronological) {
      if (dedup.length > 0 && dedup[dedup.length - 1] === t) continue;
      dedup.push(t);
    }

    // Buffer wants newest at [0]. Reverse and cap.
    const seeded = dedup.slice(-MAX_ENTRIES).reverse();

    const internal = getInternalHistory(this);
    if (!internal) return;
    internal.length = 0;
    for (const t of seeded) internal.push(t);
  }

  /**
   * MRU-dedup addToHistory. NO disk I/O — disk writes happen in
   * the `input` event handler exclusively.
   *
   * Behavior:
   *   - Drop empty / oversized entries.
   *   - If already at the front → skip (consecutive duplicate).
   *   - If found elsewhere → remove old occurrence, unshift to front.
   *   - Otherwise → unshift to front, cap at MAX_ENTRIES.
   *
   * This naturally absorbs renderInitialMessages replay: preloaded
   * entries are found at their old positions, moved to the front,
   * and by the end of the replay pass the order is preserved without
   * any duplication.
   */
  override addToHistory(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Drop oversized entries entirely.
    if (Buffer.byteLength(trimmed, "utf8") > MAX_ENTRY_BYTES) return;

    const internal = getInternalHistory(this);
    if (!internal) {
      // Internal field unreachable. Delegate to super for basic
      // session-local ↑/↓. Disk persistence is handled by the
      // `input` event handler independently.
      try {
        super.addToHistory(trimmed);
      } catch {
        // give up on in-memory
      }
      return;
    }

    // Skip consecutive duplicates (same as base behavior).
    if (internal.length > 0 && internal[0] === trimmed) return;

    // MRU dedup: remove any existing occurrence before unshifting.
    const existingIdx = internal.indexOf(trimmed);
    if (existingIdx >= 0) {
      internal.splice(existingIdx, 1);
    }

    internal.unshift(trimmed);
    if (internal.length > MAX_ENTRIES) internal.length = MAX_ENTRIES;
  }
}

// ──────────────────────────────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (FORCE_DISABLED) return;
  if (!SETTINGS.enabled) return;

  // Tracks per-cwd persistence health so we can stop trying after
  // a fatal error (e.g. EROFS, disk full).
  const persistDisabled = new Set<string>();

  // Per-cwd editor reference, populated by session_start, consumed
  // by the `input` handler for footer updates.
  const editorByCwd = new Map<string, PersistentHistoryEditor>();

  // ── Capability / version warning guards (one-shot per session) ──

  let capabilityWarned = false;
  const warnCapabilityOnce = (ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }) => {
    if (capabilityWarned) return;
    capabilityWarned = true;
    try {
      ctx.ui.notify(
        `persistent-input-history disabled: pi-tui Editor.addToHistory not found ` +
          `(pi ${PI_VERSION}). The extension's contract with pi-tui has changed; ` +
          `↑/↓ persistence is OFF this session. ` +
          `Set PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY=1 to silence this warning, ` +
          `or pin pi-astack to a commit predating the pi-tui change.`,
        "error",
      );
    } catch {
      // even notify errors must never crash session_start
    }
  };

  let versionWarned = false;
  const warnVersionOnce = (ctx: { ui: { notify: (m: string, t?: "info" | "warning" | "error") => void } }) => {
    if (versionWarned || PI_VERSION_OK) return;
    versionWarned = true;
    try {
      ctx.ui.notify(
        `persistent-input-history: pi-coding-agent ${PI_VERSION} is outside the tested ` +
          `range (0.75.x – 0.99.x). ↑/↓ persistence may behave unexpectedly. ` +
          `If broken, set PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY=1 and report a pi-astack issue.`,
        "warning",
      );
    } catch {
      // non-fatal
    }
  };

  // ── input event: the ONLY place disk writes happen ─────────────

  pi.on("input", (_event, ctx) => {
    // Only persist real user input — not RPC or extension-generated messages.
    if (_event.source !== "interactive") return;

    const trimmed = _event.text.trim();
    if (!trimmed) return;
    if (Buffer.byteLength(trimmed, "utf8") > MAX_ENTRY_BYTES) return;

    const cwd = ctx.cwd;
    const file = historyFileFor(cwd);

    if (persistDisabled.has(cwd)) return;

    tryMigrateLegacyHistory(file, cwd);

    const created = !existsSync(file);
    const ok = appendDiskHistory(file, trimmed);
    if (!ok) {
      persistDisabled.add(cwd);
      return;
    }
    if (created) tightenPermissions(file);

    // Update footer with current in-memory count.
    try {
      const editor = editorByCwd.get(cwd);
      const internal = editor ? getInternalHistory(editor) : null;
      const count = internal?.length ?? readDiskHistory(file).length;
      ctx.ui.setStatus("input-history", `↑${count}`);
    } catch {
      // non-fatal
    }
  });

  // ── session_start: install the editor ─────────────────────────

  pi.on("session_start", (_event, ctx) => {
    try {
      if (!CAPABILITY.hasAddToHistory) {
        warnCapabilityOnce(ctx);
        return;
      }
      warnVersionOnce(ctx);

      const cwd = ctx.cwd;

      try {
        ensureHistoryDir();
        tryMigrateLegacyHistory(historyFileFor(cwd), cwd);
      } catch {
        // non-fatal
      }

      let editorRef: PersistentHistoryEditor | null = null;

      ctx.ui.setEditorComponent((tui, theme, kb) => {
        try {
          const ed = new PersistentHistoryEditor(tui, theme, kb, cwd);
          // Wire degraded-notify channel.
          ed.degradedNotify = (msg: string) => {
            try {
              ctx.ui.notify(msg, "warning");
            } catch {
              // non-fatal
            }
          };
          editorRef = ed;
          editorByCwd.set(cwd, ed);
          return ed;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          ctx.ui.notify(
            `persistent-input-history disabled: ${msg}. ` +
              `Set PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY=1 to silence on next restart.`,
            "error",
          );
          return new CustomEditor(tui, theme, kb);
        }
      });

      // Surface install status in footer (after renderInitialMessages).
      setImmediate(() => {
        try {
          const internal = editorRef ? getInternalHistory(editorRef) : null;
          const count = internal
            ? internal.length
            : readDiskHistory(historyFileFor(cwd)).length;
          ctx.ui.setStatus("input-history", `↑${count}`);
        } catch {
          // non-fatal
        }
      });

      // One-time privacy notice.
      try {
        if (!existsSync(PRIVACY_NOTICE_MARKER)) {
          ctx.ui.notify(
            `Persistent input history enabled. Every prompt is stored in ` +
              `${HISTORY_DIR}/ (incl. expanded pastes). Use ` +
              `/history-compact to dedupe, or delete the dir to purge.`,
            "info",
          );
          writeFileSync(PRIVACY_NOTICE_MARKER, `${new Date().toISOString()}\n`);
          try {
            chmodSync(PRIVACY_NOTICE_MARKER, 0o600);
          } catch {
            // best-effort
          }
        }
      } catch {
        // non-fatal
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      try {
        ctx.ui.notify(
          `persistent-input-history: session_start failed (${msg}); ` +
            `falling back to pi's default editor. ` +
            `Set PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY=1 to silence on next restart.`,
          "error",
        );
      } catch {
        // last-resort
      }
    }
  });

  // ──────────────────────────────────────────────────────────────
  // Commands
  // ──────────────────────────────────────────────────────────────

  pi.registerCommand("history-compact", {
    description: "Deduplicate and rewrite the input history file for the current cwd",
    handler: async (_args, ctx) => {
      const file = historyFileFor(ctx.cwd);
      tryMigrateLegacyHistory(file, ctx.cwd);
      if (!existsSync(file)) {
        ctx.ui.notify("No history file yet for this cwd.", "info");
        return;
      }

      const all = readDiskHistoryRecords(file);
      if (all.length === 0) {
        ctx.ui.notify("History file is empty.", "info");
        return;
      }

      // Global MRU dedup: keep each unique text's last occurrence,
      // preserving overall chronological order of those last-seen
      // positions.
      const lastIndex = new Map<string, number>();
      for (let i = 0; i < all.length; i++) lastIndex.set(all[i]!.text, i);
      const kept = new Set<number>(lastIndex.values());
      const compacted: HistoryRecord[] = [];
      for (let i = 0; i < all.length; i++) {
        if (kept.has(i)) compacted.push(all[i]!);
      }

      // Drop oversize entries.
      const filtered = compacted.filter(
        (rec) => Buffer.byteLength(rec.text, "utf8") <= MAX_ENTRY_BYTES,
      );

      try {
        rewriteDiskHistory(file, filtered);
        ctx.ui.notify(
          `Compacted: ${all.length} → ${filtered.length} entries`,
          "info",
        );
        ctx.ui.setStatus("input-history", `↑${filtered.length}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`history-compact failed: ${msg}`, "error");
      }
    },
  });

  pi.registerCommand("history-status", {
    description: "Show the persistent input history file path and entry count",
    handler: async (_args, ctx) => {
      const file = historyFileFor(ctx.cwd);
      const sdkLine =
        `pi-coding-agent=${PI_VERSION} ` +
        `tested-range-ok=${PI_VERSION_OK} ` +
        `addToHistory=${CAPABILITY.hasAddToHistory} ` +
        `force-disabled=${FORCE_DISABLED}`;
      if (!existsSync(file)) {
        ctx.ui.notify(
          `No history yet for ${ctx.cwd} (would be: ${file})\n${sdkLine}`,
          "info",
        );
        return;
      }
      const count = readDiskHistory(file).length;
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // ignore
      }
      ctx.ui.notify(
        `${file}\n${count} entries, ${(size / 1024).toFixed(1)} KB\n${sdkLine}`,
        "info",
      );
    },
  });
}

// ──────────────────────────────────────────────────────────────────────
// Test-only exports (kept stable for scripts/smoke-persistent-input-history.mjs)
// ──────────────────────────────────────────────────────────────────────

export const __TEST = {
  CAPABILITY,
  PI_VERSION,
  PI_VERSION_OK,
  encodeCwd,
  historyFileFor,
  legacyHistoryFileFor,
  readDiskHistory,
  appendDiskHistory,
  PersistentHistoryEditor,
  getInternalHistory,
};
