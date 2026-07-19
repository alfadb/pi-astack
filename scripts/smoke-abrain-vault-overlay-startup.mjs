#!/usr/bin/env node
/**
 * Smoke test: abrain vault PromptDialog overlay startup wiring.
 *
 * Regression covered:
 *   Current pi-coding-agent builds expose their root entry as ESM-only.
 *   Loading it with CommonJS require() during abrain activate() used to
 *   fail, causing vaultDialogBuilderInitFailed=true and the startup
 *   warning:
 *
 *     vault: PromptDialog overlay failed to load ... ui.select fallback
 *
 * The vault overlay only needs pi-tui plus a simple DynamicBorder. This
 * smoke drives the real activate() path through jiti, asserts that the
 * overlay builder initializes without setting startup telemetry, and locks
 * the TUI canonical-startup scheduler's non-blocking/error behavior.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vault-overlay-startup-"));
process.env.ABRAIN_ROOT = path.join(tmpRoot, "abrain");
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
process.env.PI_ABRAIN_NO_AUTOSYNC = "1";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const indexModule = await jiti.import(path.join(repoRoot, "extensions/abrain/index.ts"));
const canonicalModule = await jiti.import(path.join(repoRoot, "extensions/_shared/canonical-git-runtime.ts"));
const activate = indexModule.default ?? indexModule;

if (!canonicalModule.canonicalStartupRunsInBackground("tui") || !canonicalModule.canonicalStartupRunsInBackground("rpc")) {
  throw new Error("interactive canonical startup policy must include TUI and RPC");
}
if (canonicalModule.canonicalStartupRunsInBackground("json") || canonicalModule.canonicalStartupRunsInBackground("print")) {
  throw new Error("JSON and print canonical startup must remain awaited");
}

const handlers = new Map();
const registeredTools = [];
const registeredCommands = [];

activate({
  on(name, handler) {
    handlers.set(name, handler);
  },
  registerTool(tool) {
    registeredTools.push(tool.name);
  },
  registerCommand(name) {
    registeredCommands.push(name);
  },
});

const telemetry = indexModule.__peekVaultDialogBuilderTelemetryForTests();
if (telemetry.failed || telemetry.sent) {
  throw new Error(
    `vault overlay builder should initialize cleanly; telemetry=${JSON.stringify(telemetry)}`,
  );
}

if (!registeredTools.includes("vault_release")) {
  throw new Error(`vault_release tool was not registered: ${registeredTools.join(", ")}`);
}
if (!registeredTools.includes("prompt_user")) {
  throw new Error(`prompt_user tool was not registered: ${registeredTools.join(", ")}`);
}
if (typeof handlers.get("session_start") !== "function") {
  throw new Error("session_start handler was not registered");
}

console.log("abrain vault overlay startup: ok");
console.log(`  tools=${registeredTools.filter((name) => name === "vault_release" || name === "prompt_user").join(",")}`);
console.log(`  telemetry=${JSON.stringify(telemetry)}`);
console.log(`  commands=${registeredCommands.length}`);
