/**
 * persistent-input-history extension for pi-astack.
 *
 * Persists the editor's ↑/↓ prompt history across pi restarts, per-cwd.
 * Pi's default behavior is in-memory only (capped 100) and on startup
 * rebuilds history from `buildSessionContext()`, which drops everything
 * before the last compaction's `firstKeptEntryId` — so cold-starts
 * begin empty and long sessions can only walk back to the latest
 * compaction window. This extension fixes both by:
 *
 *   1. installing a `CustomEditor` subclass on every `session_start`
 *      (covers startup, reload, new, resume, fork)
 *   2. preloading the in-memory buffer from disk on construction
 *   3. silently absorbing pi's `renderInitialMessages` "populateHistory"
 *      pass via an `expectedReplay` matcher, so the current session's
 *      messages are NOT re-appended to disk on every restart
 *   4. appending every new submitted prompt to a per-cwd JSONL file
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
 * Default `enabled: true` — unlike compaction-tuner this is a pure
 * data-persistence extension with no LLM-loop side effects, so it
 * starts working the moment pi-astack is installed.
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
 *
 * Composition: calls `setEditorComponent` unconditionally. If you
 * install another custom-editor extension (e.g. modal-editor), whichever
 * loads LAST wins — they cannot coexist with the current wiring.
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
import { dirname, join } from "node:path";
import {
  DEFAULT_PERSISTENT_INPUT_HISTORY_SETTINGS,
  expandHome,
  resolvePersistentInputHistorySettings,
  type PersistentInputHistorySettings,
} from "./settings";

// ──────────────────────────────────────────────────────────────────────
// Resolved settings (loaded once at module load)
// ──────────────────────────────────────────────────────────────────────

// Resolve once at module load. pi-astack convention: settings changes
// require a /reload or pi restart, matching how compaction-tuner /
// memory / etc. work.
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
 *
 * An earlier encoding (`--home-worker-foo--`) collided on cases like
 * `/foo-bar` vs `/foo/bar`. Anything created under that scheme is
 * migrated lazily by `tryMigrateLegacyHistory()`.
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
 * degrade gracefully (no preload, no replay matching) instead of
 * crashing the factory.
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
 * Override addToHistory() so every submitted prompt is persisted, and
 * preload the in-memory history from disk on construction.
 *
 * We deliberately do NOT delegate to super.addToHistory(). The base
 * impl caps the buffer at 100 and would silently drop our preloaded
 * entries as new submissions arrive. Re-implementing it here lets us:
 *   - keep "skip consecutive duplicate" semantics
 *   - raise the cap to MAX_ENTRIES
 *   - persist after the in-memory update
 *   - silently absorb the populateHistory replay pass
 */
class PersistentHistoryEditor extends CustomEditor {
  private readonly historyFile: string;

  /**
   * Snapshot of the disk history (chronological, dedup'd) at
   * construction time. After session_start, pi's renderInitialMessages
   * will fire addToHistory() once per visible user message in
   * chronological order. Those messages are typically the tail of our
   * disk history (because last session persisted them). We use this
   * array as a matcher: any incoming text that lines up against the
   * next expected replay entry is treated as a replay (silently
   * absorbed, no unshift, no disk append). The first mismatch ends
   * replay matching for the lifetime of this editor.
   *
   * Cleared via setImmediate (NOT process.nextTick) so the matcher
   * survives renderInitialMessages — see invalidation handler below
   * for the timing rationale.
   */
  private expectedReplay: string[] = [];
  private replayCursor = 0;

  /** Tracks whether we've already given up on persisting (e.g. EROFS). */
  private persistDisabled = false;

  /** True if pi-tui's internal `history` field is gone (upstream change). */
  private readonly internalUnavailable: boolean;

  /**
   * Optional listener called after a successful real append (not
   * during replay absorption). Extension wires this to setStatus so
   * the footer counter stays in sync without polling.
   */
  public onPersist?: (count: number) => void;

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

    // renderInitialMessages runs synchronously after init() resumes
    // from `await rebindCurrentSession()`. We need expectedReplay to
    // stay populated through that entire pass and only invalidate
    // afterwards. setImmediate fires in the event-loop check phase,
    // which is strictly later than microtasks, so by the time it runs
    // renderInitialMessages is done. process.nextTick would be too
    // early — nextTick drains BEFORE microtasks resume init() from
    // the await, i.e. before renderInitialMessages runs.
    setImmediate(() => {
      this.expectedReplay = [];
      this.replayCursor = 0;
    });
  }

  /**
   * Seed the base Editor's `history` array from disk (newest at [0]),
   * and build the expectedReplay matcher.
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

    // expectedReplay is chronological (oldest first), bounded so that
    // a pathologically large file doesn't make linear matching slow.
    // 1000 entries comfortably covers any single session's worth of
    // user messages even with no compaction.
    this.expectedReplay = dedup.slice(-1000);
    this.replayCursor = 0;
  }

  override addToHistory(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Drop oversized entries entirely (expanded pastes, etc.). Not
    // added to in-memory history either — scrolling ↑ to a 1 MB blob
    // would be unusable. The user still sees the prompt in chat; only
    // ↑/↓ replay is affected.
    if (Buffer.byteLength(trimmed, "utf8") > MAX_ENTRY_BYTES) return;

    const internal = getInternalHistory(this);
    if (!internal) {
      // Internal field unreachable. Attempt to delegate to super so
      // basic ↑/↓ within this session still works, then persist.
      try {
        super.addToHistory(trimmed);
      } catch {
        // give up on in-memory, but still try to persist
      }
      this.maybePersist(trimmed);
      return;
    }

    // Skip consecutive duplicates (same as base behavior).
    if (internal.length > 0 && internal[0] === trimmed) return;

    // Replay-matching phase: silently absorb messages that pi is
    // replaying from buildSessionContext, since they are already in
    // disk + in-memory thanks to preloadFromDisk.
    //
    // Subtlety: disk-side history collapses consecutive duplicates,
    // but session-side keeps them (e.g. model-fallback's auto-injected
    // "continue" can sit right next to a user's manual "continue";
    // `/clear` + follow-up creates similar dup pairs). We must allow
    // replay messages to RE-absorb against the just-absorbed entry
    // without advancing the cursor — otherwise the session stream
    // goes out of sync with expectedReplay and every entry after the
    // first dup pair gets re-appended to disk.
    if (this.expectedReplay.length > 0) {
      // Allow re-absorbing the just-absorbed entry as a consecutive
      // duplicate. Cursor doesn't move.
      if (
        this.replayCursor > 0 &&
        this.expectedReplay[this.replayCursor - 1] === trimmed
      ) {
        return; // absorbed (session-side consecutive dup)
      }
      const idx = this.expectedReplay.indexOf(trimmed, this.replayCursor);
      if (idx >= 0) {
        this.replayCursor = idx + 1;
        return; // absorbed; no unshift, no disk append
      }
      // First non-matching submission ends replay mode for good.
      this.expectedReplay = [];
      this.replayCursor = 0;
    }

    internal.unshift(trimmed);
    if (internal.length > MAX_ENTRIES) internal.length = MAX_ENTRIES;

    this.maybePersist(trimmed);
  }

  private maybePersist(text: string): void {
    if (this.persistDisabled) return;
    const created = !existsSync(this.historyFile);
    const ok = appendDiskHistory(this.historyFile, text);
    if (!ok) {
      this.persistDisabled = true;
      return;
    }
    if (created) tightenPermissions(this.historyFile);

    // Notify listener so the footer status refreshes live.
    if (this.onPersist) {
      const internal = getInternalHistory(this);
      const count = internal?.length ?? 0;
      try {
        this.onPersist(count);
      } catch {
        // listener errors must never break editing
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Extension entry point
// ──────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  if (!SETTINGS.enabled) return;

  pi.on("session_start", (_event, ctx) => {
    // Capture cwd at session_start so each session's editor binds
    // to the right history file.
    const cwd = ctx.cwd;

    // Ensure dir + migrate legacy file BEFORE the factory runs so
    // PersistentHistoryEditor's preload sees the migrated file.
    try {
      ensureHistoryDir();
      tryMigrateLegacyHistory(historyFileFor(cwd), cwd);
    } catch {
      // non-fatal
    }

    // Hold a reference to the editor we install so we can read its
    // in-memory history length (post-preload + post-populateHistory)
    // when updating the footer status.
    let editorRef: PersistentHistoryEditor | null = null;

    // Wrap factory in try/catch: if construction throws, pi's
    // setCustomEditorComponent has ALREADY cleared the editor
    // container, so a throw here leaves the user with no input
    // box. Fall back to the default CustomEditor instead.
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      try {
        const ed = new PersistentHistoryEditor(tui, theme, kb, cwd);
        // Live-refresh footer on every successful real append.
        ed.onPersist = (count) => {
          try {
            ctx.ui.setStatus("input-history", `↑${count}`);
          } catch {
            // non-fatal
          }
        };
        editorRef = ed;
        return ed;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.ui.notify(`persistent-input-history disabled: ${msg}`, "error");
        return new CustomEditor(tui, theme, kb);
      }
    });

    // Surface install status in the footer. Done in setImmediate so
    // the count reflects what's actually in the editor's in-memory
    // history AFTER renderInitialMessages has run — not the disk
    // state at the moment session_start fires (which may pre-date
    // the first install's populateHistory pass and falsely show 0).
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

    // One-time privacy notice. Touch a marker file so we only nag
    // the user once per machine, not once per session.
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
      // positions. This handles the "double-feed every restart" bug
      // that earlier versions of this extension had.
      const lastIndex = new Map<string, number>();
      for (let i = 0; i < all.length; i++) lastIndex.set(all[i]!.text, i);
      const kept = new Set<number>(lastIndex.values());
      const compacted: HistoryRecord[] = [];
      for (let i = 0; i < all.length; i++) {
        if (kept.has(i)) compacted.push(all[i]!);
      }

      // Also drop oversize entries that may have slipped in before
      // MAX_ENTRY_BYTES was enforced.
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
      if (!existsSync(file)) {
        ctx.ui.notify(
          `No history yet for ${ctx.cwd} (would be: ${file})`,
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
        `${file}\n${count} entries, ${(size / 1024).toFixed(1)} KB`,
        "info",
      );
    },
  });
}
