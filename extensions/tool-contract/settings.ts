import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { asBoolean } from "../memory/settings";

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

export const FORCE_DISABLED: boolean = (() => {
  const raw = process.env.PI_ASTACK_DISABLE_TOOL_CONTRACT;
  if (typeof raw !== "string") return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
})();

export interface ToolContractSettings {
  enabled: boolean;
  disableForSubAgent: boolean;
  checkMismatch: boolean;
}

export const DEFAULT_TOOL_CONTRACT_SETTINGS: ToolContractSettings = {
  enabled: false,
  disableForSubAgent: true,
  checkMismatch: true,
};

// Hot-reload by design: this reads the user settings file at hook time so
// toggles can be changed without rebuilding/restarting the extension package.
function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fsSync.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
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

export function resolveToolContractSettings(): ToolContractSettings {
  const raw = loadPiStackSettings();
  const block = (raw.toolContract ?? {}) as Record<string, unknown>;
  const def = DEFAULT_TOOL_CONTRACT_SETTINGS;
  return {
    enabled: asBoolean(block.enabled, def.enabled),
    disableForSubAgent: asBoolean(block.disableForSubAgent, def.disableForSubAgent),
    checkMismatch: asBoolean(block.checkMismatch, def.checkMismatch),
  };
}
