import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean, asNumber } from "../memory/settings";

// memory/settings.ts keeps asString un-exported; replicate the
// helper here rather than coupling further to a private export.
function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

/**
 * Hard escape hatch for users whose pi version drifts off the tested
 * range (or who simply don't want the extension active). Read once at
 * module load to match the rest of the extension's settings model.
 *
 * Truthy values: "1", "true", "yes", "on" (case-insensitive). Any other
 * value, including unset, leaves the extension under normal `enabled`
 * gating from pi-astack-settings.json.
 *
 * Rationale: when pi-tui or pi-coding-agent ship a breaking change to
 * Editor internals, this lets the user disable persistence in one
 * shell line (`export PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY=1`)
 * without editing JSON or pulling a new pi-astack commit. Env wins
 * over settings.
 */
export const FORCE_DISABLED: boolean = (() => {
  const raw = process.env.PI_ASTACK_DISABLE_PERSISTENT_INPUT_HISTORY;
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

/**
 * Persistent input history settings.
 *
 * Unlike compaction-tuner (which has destructive side effects and
 * defaults to enabled:false), this extension only persists data and
 * has zero impact on the LLM loop. It defaults to `enabled: true`
 * so the moment a user installs pi-astack the up/down history starts
 * surviving restarts. Opt out explicitly via settings if undesired.
 */
export interface PersistentInputHistorySettings {
  enabled: boolean;
  /** Where per-cwd history files live. Tilde-expanded if it starts with ~. */
  historyDir: string;
  /** Hard cap on in-memory history length. */
  maxEntries: number;
  /**
   * Skip persisting any single entry whose UTF-8 byte length exceeds
   * this. Defends against expanded-paste blobs blowing up the JSONL.
   * Keeping each line under PIPE_BUF (~4 KB on Linux) also makes
   * concurrent appends from multiple pi instances safe.
   */
  maxEntryBytes: number;
  /**
   * When the on-disk history file exceeds this size, only the tail
   * window of this many bytes is read on preload. Keeps TUI startup
   * snappy on installations that accumulate huge files over time.
   */
  maxPreloadReadBytes: number;
}

export const DEFAULT_PERSISTENT_INPUT_HISTORY_SETTINGS: PersistentInputHistorySettings = {
  enabled: true,
  historyDir: "~/.pi/agent/input-history",
  maxEntries: 5000,
  maxEntryBytes: 8 * 1024,
  maxPreloadReadBytes: 5 * 1024 * 1024,
};

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    // Missing file is expected; only log when the file exists but is
    // malformed (parse error). statSync is cheap enough.
    try {
      if (fsSync.existsSync(PI_STACK_SETTINGS_PATH)) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(
          `pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`,
        );
      }
    } catch {
      // ignore
    }
    return {};
  }
}

/** Expand a leading ~ in a path to the user's home directory. */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export function resolvePersistentInputHistorySettings(): PersistentInputHistorySettings {
  const raw = loadPiStackSettings();
  const block = (raw.persistentInputHistory ?? {}) as Record<string, unknown>;
  const def = DEFAULT_PERSISTENT_INPUT_HISTORY_SETTINGS;
  return {
    enabled: asBoolean(block.enabled, def.enabled),
    historyDir: asString(block.historyDir, def.historyDir),
    maxEntries: Math.max(1, asNumber(block.maxEntries, def.maxEntries)),
    maxEntryBytes: Math.max(64, asNumber(block.maxEntryBytes, def.maxEntryBytes)),
    maxPreloadReadBytes: Math.max(
      4096,
      asNumber(block.maxPreloadReadBytes, def.maxPreloadReadBytes),
    ),
  };
}
