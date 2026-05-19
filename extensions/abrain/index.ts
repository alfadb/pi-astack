/**
 * abrain extension for pi-astack — alfadb digital twin / personal brain.
 *
 * Implements ADR 0014 (abrain-as-personal-brain). This file is the
 * extension entry point.
 *
 * Sub-pi enforcement (ADR 0014 invariant #6, vault-bootstrap §5 layer (b)):
 * the FIRST thing activate() does is check PI_ABRAIN_DISABLED. If set
 * to "1", we skip all registration — the sub-pi has no /vault command,
 * no abrain tools, nothing. This is the second of three enforcement
 * layers (the first is dispatch's spawn env override at
 * extensions/dispatch/index.ts; the third is the offline smoke
 * `smoke:vault-subpi-isolation`).
 *
 * Current scope (P0a-P0c + B4.5 shipped as of 2026-05-14):
 *   - extension skeleton + activate() guard
 *   - platform backend detection (backend-detect.ts, pure logic)
 *   - `/vault status` slash command (read-only display)
 *   - `/vault init [--backend=X]` non-interactive bootstrap (P0b)
 *   - master key generation + portable identity encryption (bootstrap.ts, keychain.ts)
 *   - vaultWriter library + atomic lock + per-key _meta (vault-writer.ts, P0c.write)
 *   - vaultReader: unlock master + decrypt per-key secrets (vault-reader.ts, P0c.read)
 *   - vault_release LLM tool + $VAULT_* bash injection (P0c.read)
 *   - `/secret set/list/forget` command with active-project routing (P0c.write)
 *   - reconcile() crash recovery wired into activate() (2026-05-11)
 *   - 7-zone brain layout bootstrap (brain-layout.ts, 2026-05-11)
 *   - `/abrain bind/status` strict project binding (ADR 0017, 2026-05-12)
 *
 * Remaining:
 *   - Lane G /about-me command + ABOUT-ME extractor (P3-P5)
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectBackend, formatStatus, type BackendInfo, type DetectDeps, type InitializedState } from "./backend-detect";
import {
  createInstallTmpDir, generateMasterKey, cleanupInstallDir, execCapture,
} from "./bootstrap";
import {
  encryptMasterKey, writeBackendFile, writePubkeyFile, readBackendFile,
  type EncryptableBackend, type ExecFn,
} from "./keychain";
import {
  writeSecret, listSecrets, forgetSecret, readVaultEntryMeta, validateKey,
  appendVaultReadAudit, reconcile,
  type VaultEventOp, type VaultScope,
} from "./vault-writer";
import { releaseSecret, vaultFilePath, type ReleaseSecretResult } from "./vault-reader";
import {
  ensureAbrainStateGitignored,
  ensureBrainLayout,
} from "./brain-layout";
import {
  fetchAndFF, pushAsync, sync as gitSync, getStatus as getGitSyncStatus,
  formatSyncStatus, type AbrainSyncStatus,
} from "./git-sync";
import {
  authKey,
  prepareBootVaultBashCommand,
  redactVaultBashContent,
  scopeLabel,
  VAULT_BASH_OUTPUT_AUTH_CHOICES,
  withheldVaultBashContent,
  type VaultBashRunRecord,
} from "./vault-bash";
import {
  bindAbrainProject,
  listAbrainProjects,
  resolveActiveProject,
  validateAbrainProjectId,
  type ResolveActiveProjectResult,
} from "../_shared/runtime";
import { extractUserMessageText, localizePrompt, recordUserMessage } from "./i18n";
// ADR 0022 P2: prompt_user LLM tool surface. Types only at top level;
// runtime symbols are `require()`d inside `activate()` so any consumer
// that loads abrain/index.ts purely for its EXPORTS (smoke fixtures,
// type-introspection tools) does NOT pull in the prompt_user subtree.
import type {
  PromptUserHandlerDeps,
} from "./prompt-user/handler";
import type { PromptAuditSink, PromptDialogDeps } from "./prompt-user/service";
import type { PiTuiBag } from "./prompt-user/ui/PromptDialog";
// ADR 0022 P3b: vault authorization via PromptDialog overlay.
import {
  askVaultAuthorizationViaDialog,
} from "./vault-authorize";

// ── ~/.abrain layout constants (single source — referenced from spec §3) ──
// Priority: ABRAIN_ROOT env var > default ~/.abrain (aligned with memory/parser.ts)

const ABRAIN_HOME = process.env.ABRAIN_ROOT
  ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
  : path.join(os.homedir(), ".abrain");
const STATE_DIR = path.join(ABRAIN_HOME, ".state");
const VAULT_DISABLED_FLAG = path.join(STATE_DIR, "vault-disabled");

// ── Sub-pi enforce constants ────────────────────────────────────────────

const PI_ABRAIN_DISABLED = "PI_ABRAIN_DISABLED";

// ── Runtime helpers (the dependencies detectBackend needs) ──────────────

function realCommandExists(cmd: string): boolean {
  // `command -v` is shell built-in; use `which` via execFile. POSIX `which`
  // returns 0 with the path on stdout when found, non-zero otherwise.
  // execFileSync throws on non-zero — wrap in try/catch.
  try {
    execFileSync("which", [cmd], { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

function realFileExists(p: string): boolean {
  try {
    fs.statSync(p); // follows symlinks; ok for our use cases
    return true;
  } catch {
    return false;
  }
}

/**
 * Look up the first GPG secret key id by parsing
 * `gpg --list-secret-keys --with-colons`. Returns null if no secret keys
 * or gpg fails. Used by detectBackend's Tier 1 gpg-file path.
 *
 * Output format ref: gpg(1) --with-colons. We grab the `sec:` line and
 * field 5 (long key id, e.g. ABCD1234EF567890).
 */
function realGpgFirstSecretKey(): string | null {
  try {
    const out = execFileSync("gpg", ["--list-secret-keys", "--with-colons"], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 2000, // gpg-agent slowness should not block pi start
    });
    for (const line of out.split("\n")) {
      if (line.startsWith("sec:")) {
        const fields = line.split(":");
        const keyId = fields[4]; // 5th field (1-indexed: keyid)
        if (keyId && keyId.length > 0) return keyId;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function buildRealDeps(): DetectDeps {
  return {
    commandExists: realCommandExists,
    fileExists: realFileExists,
    platform: process.platform,
    home: os.homedir(),
    env: {
      SECRETS_BACKEND: process.env.SECRETS_BACKEND,
      DISPLAY: process.env.DISPLAY,
      WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
    },
    gpgFirstSecretKey: realGpgFirstSecretKey,
  };
}

// ── Public API: pure status query (no side effects) ─────────────────────

export interface VaultStatus {
  /** sub-pi guard fired — abrain is fully disabled in this process */
  subPiDisabled: boolean;
  /** ~/.abrain/.state/vault-disabled flag is present (user opted out) */
  userDisabledFlag: boolean;
  /** detected backend info (always populated, even when disabled) */
  backend: BackendInfo;
}

export function getVaultStatus(deps: DetectDeps = buildRealDeps()): VaultStatus {
  return {
    subPiDisabled: process.env[PI_ABRAIN_DISABLED] === "1",
    userDisabledFlag: realFileExists(VAULT_DISABLED_FLAG),
    backend: detectBackend(deps),
  };
}

// ── Extension activation ────────────────────────────────────────────────

interface CommandRegistry {
  registerCommand?: (name: string, options: {
    description?: string;
    getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
    handler: (args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }) => Promise<void> | void;
  }) => void;
}

interface EventRegistry {
  on?: (event: string, handler: (event: any, ctx: { ui?: VaultReleaseUi; signal?: AbortSignal }) => Promise<unknown> | unknown) => void;
}

interface ToolRegistry {
  registerTool?: (tool: {
    name: string;
    label?: string;
    description?: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters?: unknown;
    execute: (toolCallId: string, params: Record<string, unknown>, signal: AbortSignal, onUpdate: unknown, ctx: { ui?: VaultReleaseUi }) => Promise<unknown> | unknown;
  }) => void;
}

interface VaultReleaseUi {
  notify?(message: string, type?: string): void;
  select?(title: string, items: string[], opts?: { timeout?: number; signal?: AbortSignal }): Promise<string | undefined>;
  confirm?(title: string, message: string, opts?: { timeout?: number; signal?: AbortSignal }): Promise<boolean>;
  // ADR 0022 P3b: ctx.ui.custom is the inline-overlay primitive pi exposes
  // to extensions. PromptDialog overlay rides on top of this; vault auth
  // delegates to it when present, with ui.select retained as fallback.
  custom?(
    factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown> | unknown;
}

export const VAULT_RELEASE_AUTH_CHOICES = ["No", "Deny + remember", "Yes once", "Session"] as const;

export type AutoCommitStatus = "committed" | "clean" | "not_git" | "failed";

export interface AutoCommitResult {
  repoRoot: string;
  paths: string[];
  status: AutoCommitStatus;
  commitSha?: string;
  detail?: string;
}

function gitErrorSummary(err: any): string {
  const stderr = typeof err?.stderr === "string" ? err.stderr : err?.stderr?.toString?.();
  const stdout = typeof err?.stdout === "string" ? err.stdout : err?.stdout?.toString?.();
  return (stderr || stdout || err?.message || String(err)).trim().slice(0, 500);
}

export function autoCommitPaths(repoRoot: string, relPaths: string[], message: string): AutoCommitResult {
  const root = path.resolve(repoRoot);
  const paths = relPaths.map((p) => p.replace(/\\/g, "/")).filter(Boolean);
  if (paths.length === 0) return { repoRoot: root, paths, status: "clean", detail: "no paths" };
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000 });
  } catch {
    return { repoRoot: root, paths, status: "not_git", detail: "not a git worktree" };
  }

  try {
    execFileSync("git", ["-C", root, "add", "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
    let hasStagedChanges = true;
    try {
      execFileSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
      hasStagedChanges = false;
    } catch {
      hasStagedChanges = true;
    }
    if (!hasStagedChanges) return { repoRoot: root, paths, status: "clean", detail: "no changes" };

    execFileSync("git", ["-C", root, "commit", "-m", message, "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 3000 }).trim();
    return { repoRoot: root, paths, status: "committed", commitSha: sha || undefined };
  } catch (err: any) {
    return { repoRoot: root, paths, status: "failed", detail: gitErrorSummary(err) };
  }
}

function formatAutoCommitResult(label: string, result: AutoCommitResult): string {
  const paths = result.paths.join(", ");
  if (result.status === "committed") return `- ${label}: committed ${result.commitSha?.slice(0, 12) ?? "(unknown sha)"} (${paths})`;
  if (result.status === "clean") return `- ${label}: clean (${paths})`;
  if (result.status === "not_git") return `- ${label}: skipped; not a git worktree (${result.repoRoot})`;
  return `- ${label}: failed (${paths}) — ${result.detail ?? "unknown error"}`;
}

function autoCommitNeedsWarning(result: AutoCommitResult): boolean {
  return result.status === "failed" || result.status === "not_git";
}

// ── /secret scope parsing (ADR 0014 P1 step 2) ──────────────────────────

export type SecretScopeArg = "default" | "global" | { project: string };

export interface ParsedSecretFlags {
  scope: SecretScopeArg;
  positional: string[];
  errors: string[];
  allProjects: boolean;
}

export function parseSecretScopeFlags(tokens: ReadonlyArray<string>): ParsedSecretFlags {
  let global = false;
  let projectId: string | undefined;
  let allProjects = false;
  const positional: string[] = [];
  const errors: string[] = [];
  for (const tok of tokens) {
    if (tok === "--global") { global = true; continue; }
    if (tok === "--all-projects") { allProjects = true; continue; }
    const proj = tok.match(/^--project=(.+)$/);
    if (proj) {
      const id = proj[1]!;
      try { validateAbrainProjectId(id); projectId = id; }
      catch (err: any) { errors.push(`invalid --project=<id>: ${err.message}`); }
      continue;
    }
    if (tok.startsWith("--")) { errors.push(`unknown flag: ${tok}`); continue; }
    positional.push(tok);
  }
  if (global && projectId) errors.push("--global and --project=<id> are mutually exclusive");
  if (allProjects && (global || projectId)) errors.push("--all-projects cannot combine with --global / --project=<id>");
  let scope: SecretScopeArg = "default";
  if (global) scope = "global";
  else if (projectId) scope = { project: projectId };
  return { scope, positional, errors, allProjects };
}

export type ResolveSecretScope =
  | { ok: true; scope: VaultScope }
  | { ok: false; reason: string };

export function resolveSecretScope(
  scopeArg: SecretScopeArg,
  activeProject: ResolveActiveProjectResult | null,
): ResolveSecretScope {
  if (scopeArg === "global") return { ok: true, scope: "global" };
  if (!activeProject || activeProject.activeProject === null) {
    const reason = activeProject?.reason ?? "manifest_missing";
    return { ok: false, reason: secretDefaultRejection(reason) };
  }
  if (typeof scopeArg === "object" && scopeArg && "project" in scopeArg) {
    // B4.5 strict mode: explicit --project may not bypass local binding
    // authorization. Only the boot-time bound project can be targeted by
    // project-scoped vault operations; use --global for global secrets.
    if (scopeArg.project !== activeProject.activeProject.projectId) {
      return { ok: false, reason: `project scope '${scopeArg.project}' is not the boot-time bound project '${activeProject.activeProject.projectId}'. Start pi in that project and run /abrain bind, or use --global.` };
    }
    return { ok: true, scope: { project: scopeArg.project } };
  }
  return { ok: true, scope: { project: activeProject.activeProject.projectId } };
}

export function secretDefaultRejection(reason: string): string {
  switch (reason) {
    case "manifest_missing":
      return "project is not bound to abrain: missing .abrain-project.json. Run `/abrain bind --project=<id>` or use --global.";
    case "manifest_invalid":
      return "project binding is invalid: .abrain-project.json is unreadable or has an invalid project_id. Fix it or use --global.";
    case "registry_missing":
      return "project binding is incomplete: abrain registry projects/<id>/_project.json is missing. Run `/abrain bind` or use --global.";
    case "registry_mismatch":
      return "project binding conflict: abrain registry does not match .abrain-project.json. Repair the binding or use --global.";
    case "path_unconfirmed":
      return "project binding is not confirmed on this local path. Run `/abrain bind` or use --global.";
    case "path_conflict":
      return "project binding conflict: this local path is already confirmed for another project. Repair local-map or use --global.";
    case "invalid_cwd":
      return "active project unresolved: cwd is invalid. Re-run from a valid project root or use --global.";
    default:
      return `no active project (reason=${reason}). Run /abrain bind or use --global.`;
  }
}

let bootActiveProject: ResolveActiveProjectResult | null = null;
let bootActiveProjectAt: number | null = null;

/**
 * Module-level guard so the startup auto-sync runs exactly once per pi
 * process even though we register the trigger on `session_start` (which
 * fires once per session, including session switches / fork / restart).
 *
 * 2026-05-17 Round 5 UX fix: startup sync moved from activate() top-level
 * (no ctx, raw console.error) to session_start (ctx.ui.notify available,
 * pi TUI styled output). This flag is the gate that prevents repeated
 * sync attempts on every new session within the same pi process.
 */
let startupAutoSyncDone = false;

function snapshotBootActiveProject(cwd = process.cwd()): ResolveActiveProjectResult {
  return resolveActiveProject(cwd, { abrainHome: ABRAIN_HOME });
}

export function getBootActiveProject(): ResolveActiveProjectResult | null {
  return bootActiveProject;
}

export function getBootActiveProjectSnapshotAt(): number | null {
  return bootActiveProjectAt;
}

export function __resetBootActiveProjectForTests(value: ResolveActiveProjectResult | null): void {
  bootActiveProject = value;
  bootActiveProjectAt = value ? Date.now() : null;
}


const releaseSessionGrants = new Set<string>();
const releaseRememberDenies = new Set<string>();
const bashOutputSessionGrants = new Set<string>();

// ── ADR 0022 P3b: PromptDialog factory cache ────────────────────────
// activate() lazy-requires the prompt-user subtree + pi-tui ONCE (in the
// prompt_user tool registration block) and stores the builder here.
// `authorizeVaultRelease` / `authorizeVaultBashOutput` read this to
// decide whether to use the PromptDialog overlay (primary path) or
// fall through to the legacy `ui.select` chain. `null` means the
// pi-tui surface failed to load on this process — fail-soft, the
// caller still has `ui.select`/`ui.confirm` fallbacks.
let cachedVaultDialogBuilder: PromptDialogDeps["buildDialog"] | null = null;

/** Test-only: reset the dialog builder cache (e.g. for smoke fixtures). */
export function __setVaultDialogBuilderForTests(
  fn: PromptDialogDeps["buildDialog"] | null,
): void {
  cachedVaultDialogBuilder = fn;
}

/** Test-only: reset all in-memory vault grant sets between smoke cases. */
export function __resetVaultGrantsForTests(): void {
  releaseSessionGrants.clear();
  releaseRememberDenies.clear();
  bashOutputSessionGrants.clear();
}

/** Test-only: read the current dialog builder (for INV-E identity asserts). */
export function __getVaultDialogBuilderForTests(): PromptDialogDeps["buildDialog"] | null {
  return cachedVaultDialogBuilder;
}
const vaultBashRuns = new Map<string, VaultBashRunRecord>();

function vaultReleaseChoiceReason(choice: string | undefined): string {
  if (!choice) return "cancelled";
  return choice.toLowerCase().replace(/\s*\+\s*/g, "_").replace(/\s+/g, "_");
}

function toolJson(payload: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

// Truncate text to N chars so the TUI title stays readable. We keep the head
// and the tail because vault-relevant info is often at both ends of a command.
function truncateForPrompt(value: string, max = 240): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  const head = Math.floor((max - 5) * 0.7);
  const tail = max - 5 - head;
  return `${oneLine.slice(0, head)} ... ${oneLine.slice(-tail)}`;
}

export function formatBashAuthorizationTitle(
  record: { releases: ReleaseSecretResult[]; originalCommand?: string },
  descriptions?: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [`Release bash output to the LLM?`];
  if (record.releases.length === 0) {
    lines.push(`vault keys used: <none>`);
  } else {
    lines.push(`vault keys used:`);
    for (const r of record.releases) {
      const label = authKey(r.scope, r.key);
      const desc = descriptions?.get(label);
      lines.push(`  ${label}${desc ? ` — ${truncateForPrompt(desc, 200)}` : ""}`);
    }
  }
  const cmd = record.originalCommand ? truncateForPrompt(record.originalCommand) : "<unknown command>";
  lines.push(`command: ${cmd}`);
  lines.push(`⚠ The output may still contain encoded forms of the secret (base64/hex/xxd/xor) that literal redaction cannot catch.`);
  return lines.join("\n");
}

export function formatReleaseAuthorizationTitle(
  scope: VaultScope,
  key: string,
  reason: string | undefined,
  description?: string,
): string {
  const lines: string[] = [`Release vault secret ${authKey(scope, key)} to the LLM?`];
  if (description) lines.push(`description: ${truncateForPrompt(description, 240)}`);
  lines.push(reason ? `LLM reason: ${truncateForPrompt(reason, 320)}` : `LLM reason: (none supplied)`);
  lines.push(`⚠ Plaintext will enter this model context. Redaction is best-effort and does not cover base64/hex/xxd/xor transformations.`);
  return lines.join("\n");
}

function scopeAuditLabel(scope: VaultScope): string {
  return scope === "global" ? "global" : `project:${scope.project}`;
}

function safeAuditAppend(ev: Parameters<typeof appendVaultReadAudit>[1]): void {
  // Audit failures must never break vault read paths — they're observability,
  // not enforcement. Swallow + best-effort log via stderr if anything throws.
  appendVaultReadAudit(ABRAIN_HOME, ev).catch((err) => {
    try { process.stderr.write(`abrain vault audit append failed: ${err?.message ?? err}\n`); } catch {}
  });
}

function auditReleaseDecision(op: VaultEventOp, scope: VaultScope, key: string, extras: { reason?: string } = {}): void {
  safeAuditAppend({
    ts: new Date().toISOString(),
    op,
    scope: scopeAuditLabel(scope),
    key,
    lane: "vault_release",
    ...(extras.reason ? { reason: extras.reason } : {}),
  });
}

function auditBashInject(record: VaultBashRunRecord): void {
  if (record.releases.length === 0) return;
  const firstScope = record.releases[0]!.scope;
  safeAuditAppend({
    ts: new Date().toISOString(),
    op: "bash_inject",
    scope: scopeAuditLabel(firstScope),
    lane: "bash_inject",
    keys: record.releases.map((r) => authKey(r.scope, r.key)),
    variables: record.variables,
    command_preview: record.originalCommand ? truncateForPrompt(record.originalCommand, 240) : undefined,
  });
}

function auditBashInjectBlock(originalCommand: string, reason: string): void {
  safeAuditAppend({
    ts: new Date().toISOString(),
    op: "bash_inject_block",
    scope: "global", // scope is unknown at block time; lane marks the row
    lane: "bash_inject",
    reason,
    command_preview: truncateForPrompt(originalCommand, 240),
  });
}

function auditBashOutput(op: "bash_output_release" | "bash_output_withhold", record: VaultBashRunRecord): void {
  if (record.releases.length === 0) return;
  const firstScope = record.releases[0]!.scope;
  safeAuditAppend({
    ts: new Date().toISOString(),
    op,
    scope: scopeAuditLabel(firstScope),
    lane: "bash_output",
    keys: record.releases.map((r) => authKey(r.scope, r.key)),
    command_preview: record.originalCommand ? truncateForPrompt(record.originalCommand, 240) : undefined,
  });
}

function collectReleaseDescriptions(releases: ReleaseSecretResult[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of releases) {
    try {
      const meta = readVaultEntryMeta(ABRAIN_HOME, r.scope, r.key);
      if (meta?.description) out.set(authKey(r.scope, r.key), meta.description);
    } catch { /* ignore unreadable meta */ }
  }
  return out;
}

function readReleaseDescription(scope: VaultScope, key: string): string | undefined {
  try { return readVaultEntryMeta(ABRAIN_HOME, scope, key)?.description; }
  catch { return undefined; }
}

async function authorizeVaultBashOutput(
  ui: VaultReleaseUi | undefined,
  record: VaultBashRunRecord,
  signal: AbortSignal | undefined,
  hostCtx: unknown,
): Promise<"release" | "withhold"> {
  if (bashOutputSessionGrants.has(record.grantKey)) return "release";
  if (!ui) return "withhold";
  const descriptions = collectReleaseDescriptions(record.releases);
  const englishTitle = formatBashAuthorizationTitle(record, descriptions);
  const title = await localizePrompt(englishTitle, hostCtx);
  // Also push the full context into the message stream so it survives any TUI
  // truncation of the select title.
  ui.notify?.(title, "warning");

  const keyList = record.releases.map((r) => `${scopeLabel(r.scope)}:${r.key}`).join(", ");
  const applyChoice = (choice: string | undefined): "release" | "withhold" => {
    if (choice === "Yes once") return "release";
    if (choice === "Session") {
      bashOutputSessionGrants.add(record.grantKey);
      return "release";
    }
    ui.notify?.(`Withheld bash output that used vault key(s): ${keyList}`, "warning");
    return "withhold";
  };

  // ADR 0022 P3b: prefer PromptDialog overlay when available; fall
  // through to ui.select on dialog_error / ui_unavailable. cancelled
  // is treated as deny (fail-closed) so an Esc / abort during overlay
  // is equivalent to choosing "No".
  if (typeof ui.custom === "function" && cachedVaultDialogBuilder) {
    const r = await askVaultAuthorizationViaDialog({
      ui,
      variant: "bash_output_release",
      reason: title,
      header: "Vault bash output",
      question: `Release this command's output to the LLM? (keys: ${keyList || "<none>"})`,
      choices: VAULT_BASH_OUTPUT_AUTH_CHOICES,
      signal,
      buildDialog: cachedVaultDialogBuilder,
    });
    if (r.ok) return applyChoice(r.choice);
    if (r.reason === "cancelled") {
      ui.notify?.(`Withheld bash output that used vault key(s): ${keyList}`, "warning");
      return "withhold";
    }
    // dialog_error / ui_unavailable — best effort notify and fall through.
    if (r.reason === "dialog_error") {
      ui.notify?.(`vault bash output: dialog error, falling back to select: ${r.detail ?? "(no detail)"}`, "warning");
    }
  }

  if (typeof ui.select === "function") {
    // Fail closed in non-interactive/API runners that may auto-return the first
    // select item: put the deny option first. Interactive users can still move to
    // an explicit release choice.
    //
    // R8 (post-T0 GPT-5.5 xhigh P1#1, 2026-05-18): try/catch envelope.
    // bash output has an OUTER tool_result envelope that already turns
    // throws into withhold, so this is defense-in-depth + parity with
    // authorizeVaultRelease which has NO outer envelope.
    try {
      const choice = await ui.select(title, [...VAULT_BASH_OUTPUT_AUTH_CHOICES], { signal });
      return applyChoice(choice);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      ui.notify?.(`Withheld bash output: ui.select failed: ${message.slice(0, 200)}`, "warning");
      return "withhold";
    }
  }
  ui.notify?.(`Withheld bash output that used vault key(s): ${keyList}`, "warning");
  return "withhold";
}

async function authorizeVaultRelease(
  ui: VaultReleaseUi | undefined,
  scope: VaultScope,
  key: string,
  reason: string | undefined,
  signal: AbortSignal | undefined,
  hostCtx: unknown,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const gate = authKey(scope, key);
  if (releaseRememberDenies.has(gate)) return { ok: false, reason: "denied_remembered" };
  if (releaseSessionGrants.has(gate)) return { ok: true };
  if (!ui) return { ok: false, reason: "ui_unavailable" };

  const description = readReleaseDescription(scope, key);
  const englishTitle = formatReleaseAuthorizationTitle(scope, key, reason, description);
  const title = await localizePrompt(englishTitle, hostCtx);
  // Mirror the full context into the message stream so the user always sees
  // what is about to be released, even if the TUI select clips long titles.
  ui.notify?.(title, "warning");

  const applyChoice = (choice: string | undefined): { ok: true } | { ok: false; reason: string } => {
    if (choice === "Yes once") return { ok: true };
    if (choice === "Session") {
      releaseSessionGrants.add(gate);
      return { ok: true };
    }
    if (choice === "Deny + remember") releaseRememberDenies.add(gate);
    return { ok: false, reason: vaultReleaseChoiceReason(choice) };
  };

  // ADR 0022 P3b: prefer PromptDialog overlay when ctx.ui.custom is
  // available AND the dialog builder loaded successfully in activate().
  // Fall through to ui.select on dialog_error / ui_unavailable. A
  // cancelled overlay is treated as deny-this-call (NOT deny+remember).
  if (typeof ui.custom === "function" && cachedVaultDialogBuilder) {
    const r = await askVaultAuthorizationViaDialog({
      ui,
      variant: "vault_release",
      reason: title,
      header: `Release ${authKey(scope, key)}?`,
      question: "Authorize plaintext release into LLM context?",
      choices: VAULT_RELEASE_AUTH_CHOICES,
      signal,
      buildDialog: cachedVaultDialogBuilder,
    });
    if (r.ok) return applyChoice(r.choice);
    if (r.reason === "cancelled") return { ok: false, reason: "cancelled" };
    // dialog_error / ui_unavailable — best effort notify and fall through.
    if (r.reason === "dialog_error") {
      ui.notify?.(`vault_release: dialog error, falling back to select: ${r.detail ?? "(no detail)"}`, "warning");
    }
  }

  // R8 (post-T0 GPT-5.5 xhigh P1#1, 2026-05-18): wrap ui.select /
  // ui.confirm in try/catch so a throw / reject from the UI primitive
  // becomes a fail-closed deny rather than escaping the tool executor.
  // Pre-fix the only catch was the OUTER `tool_result` handler for the
  // bash output path; the `vault_release` tool execute had no envelope,
  // so a UI throw would propagate as an unhandled rejection past the
  // ADR 0019 "authorization boundary failure MUST fail closed and
  // observable" contract.
  if (typeof ui.select === "function") {
    // Fail closed in non-interactive/API runners that may auto-return the first
    // select item: put deny choices before explicit release choices.
    try {
      const choice = await ui.select(title, [...VAULT_RELEASE_AUTH_CHOICES], { signal });
      return applyChoice(choice);
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      ui.notify?.(`vault_release denied: ui.select failed: ${message.slice(0, 200)}`, "warning");
      return { ok: false, reason: "ui_authorization_error" };
    }
  }

  if (typeof ui.confirm === "function") {
    try {
      const ok = await ui.confirm("Vault release authorization", title, { signal });
      return ok ? { ok: true } : { ok: false, reason: "denied" };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      ui.notify?.(`vault_release denied: ui.confirm failed: ${message.slice(0, 200)}`, "warning");
      return { ok: false, reason: "ui_authorization_error" };
    }
  }

  ui.notify?.("vault_release denied: no UI authorization method available", "warning");
  return { ok: false, reason: "ui_authorization_unavailable" };
}

// Export so smoke can invoke + INV-E identity asserts can run against
// the real function (not a copy). These are file-internal helpers; the
// LLM-facing surface remains the registered `vault_release` tool +
// bash output guard.
export {
  authorizeVaultRelease as __authorizeVaultReleaseForTests,
  authorizeVaultBashOutput as __authorizeVaultBashOutputForTests,
};

export default function activate(pi: ExtensionAPI): void {
  // ── Sub-pi enforce: vault-bootstrap.md §5 layer (b) ───────────────────
  // If PI_ABRAIN_DISABLED=1, register nothing. Sub-pi sees no /vault
  // command, no abrain tool, nothing — this is the runtime invariant
  // backing ADR 0014 invariant #6 layer 2. The dispatch extension
  // (extensions/dispatch/index.ts) sets this env var when spawning
  // sub-pi; the `smoke:vault-subpi-isolation` smoke verifies that.
  if (process.env[PI_ABRAIN_DISABLED] === "1") return;

  // Boot-time snapshot per ADR 0017: active project identity comes from
  // strict binding, not bash `cd`. Only /abrain bind may refresh it
  // explicitly; /abrain status is read-only and ordinary shell directory
  // changes do not switch project vault scope.
  bootActiveProject = snapshotBootActiveProject();
  bootActiveProjectAt = Date.now();

  // ── Crash recovery ────────────────────────────────────────────
  // reconcile scans vault dirs for encrypted files missing audit rows
  // (crash between atomic rename and vault-events append) and inserts
  // recovered_missing_audit entries. Safe no-op when vault not yet init'd.
  reconcile(ABRAIN_HOME)
    .then(({ recovered, scanned }) => {
      if (recovered > 0) {
        console.error(`[abrain] reconcile: recovered ${recovered} missing audit rows (${scanned} files scanned)`);
      }
    })
    .catch((err) => {
      console.error(`[abrain] reconcile failed:`, err);
    });

  // ── Startup git fetch + ff (ADR 0020) ────────────────────────
  // Fire-and-forget: pull any new commits from abrain remote so this pi
  // session starts with the freshest knowledge sediment from other devices.
  // Fast-forward only — divergence aborts silently (user runs /abrain sync
  // to see the runbook). Skipped when there's no git remote.
  // 2026-05-17 (ADR 0020 rev.): divergence now triggers `git merge`
  // (3-way, no LLM); only a textual conflict surfaces a runbook. When
  // auto-merge produces a local merge commit we also schedule a push
  // so the merge becomes visible to other devices (Round 3 MAJOR-D).
  //
  // 2026-05-17 (Round 5 UX fix): the startup sync USED TO emit `console.
  // error(...)` lines, which is the raw stderr path — ugly and
  // intercalated with pi's TUI rendering. Sediment uses `ctx.ui.notify`
  // (which the pi TUI styles per `type` and integrates with the chat
  // stream); abrain should too. But `activate(pi)` has no ctx — we get
  // ctx only inside an event handler. So we register a one-shot
  // `session_start` listener whose ctx.ui.notify we capture early and
  // pass into `runStartupAutoSync(notify)`. Headless/RPC mode (no ui)
  // falls back to console.error so the audit trail still surfaces.
  //
  // ORDERING (Round 4 gpt MAJOR-1): runStartupAutoSync is INVOKED at
  // session_start time, but session_start fires AFTER activate()
  // finishes, by which point `.state/` gitignore guard has already run
  // — so the dirty-tree preflight inside fetchAndFF still sees the
  // canonical "ignore .state/" rule on first run. The ordering
  // invariant is preserved.
  // Notify type signature is widened to `string` to match VaultReleaseUi
  // (the existing pi runtime contract for ctx.ui.notify on this codebase).
  // pi only renders "info" | "warning" | "error" specially; other strings
  // fall back to the default style, so the wider signature is safe at
  // both ends.
  const runStartupAutoSync = (notify?: (msg: string, type?: string) => void): void => {
    if (startupAutoSyncDone) return;
    startupAutoSyncDone = true;
    if (process.env.PI_ABRAIN_NO_AUTOSYNC === "1") return;

    // Capture-and-bind pattern (mirrors sediment writer.ts): bind notify
    // synchronously so any subsequent ctx-staleness during our async
    // work doesn't blow up the announce path. If notify is missing
    // (headless/RPC/print mode), fall back to console.error so the
    // audit trail still surfaces somewhere a user can find it.
    const announce = (msg: string, type: "info" | "warning" | "error" = "info"): void => {
      if (notify) {
        try { notify(msg, type); return; } catch { /* fall through to console */ }
      }
      console.error(`[abrain] ${msg}`);
    };

    fetchAndFF({ abrainHome: ABRAIN_HOME })
      .then((event) => {
        if (event.result === "ok" && event.merged && event.merged > 0) {
          announce(`abrain: auto-merged ${event.merged} commit(s) from origin/main; pushing merge…`, "info");
          // Fire-and-forget: pushAsync has its own audit + single-flight.
          // Round 4 gpt MINOR-1: always emit a terminal line so the
          // "pushing…" announcement is never left hanging — even for
          // noop (someone else already pushed the merge) or skipped
          // (origin removed between merge and push).
          pushAsync({ abrainHome: ABRAIN_HOME })
            .then((pushEv) => {
              if (pushEv.result === "ok") {
                announce(`abrain: auto-merge commit landed on origin/main`, "info");
              } else if (pushEv.result === "noop") {
                announce(`abrain: auto-merge already on origin/main`, "info");
              } else if (pushEv.result === "skipped") {
                announce(`abrain: push skipped (no origin remote)`, "info");
              } else {
                announce(`abrain: push of auto-merge ${pushEv.result} — ${pushEv.error || "unknown"} (next sediment commit will retry)`, "warning");
              }
            })
            .catch(() => { /* pushAsync never throws; defense in depth */ });
        } else if (event.result === "ok" && event.behind && event.behind > 0) {
          announce(`abrain: fast-forwarded ${event.behind} commit(s) from origin/main`, "info");
        } else if (event.result === "conflict") {
          const where = event.conflictPaths && event.conflictPaths.length > 0
            ? ` in ${event.conflictPaths.length} file(s): ${event.conflictPaths.slice(0, 3).join(", ")}${event.conflictPaths.length > 3 ? ", ..." : ""}`
            : "";
          announce(`abrain: merge conflict${where} — working tree restored. Run /abrain sync for runbook.`, "warning");
        } else if (event.result === "failed" || event.result === "timeout") {
          announce(`abrain: fetch ${event.result} — ${event.error || "unknown"} (auto-sync continues; use /abrain sync to retry)`, "warning");
        }
        // result === "ok" with no merged + no behind → nothing happened,
        // stay silent. result === "noop"/"skipped" also silent.
      })
      .catch((err) => {
        // git-sync ops should never throw, but belt-and-suspenders:
        announce(`abrain: fetch threw (should be caught internally) — ${err && (err as Error).message ? (err as Error).message : String(err)}`, "error");
      });
  };

  // ── 7-zone layout bootstrap ──────────────────────────────────
  // Ensure brain directory structure exists (idempotent). Vault zone
  // is created here so it's available before /vault init runs.
  try {
    const layout = ensureBrainLayout(ABRAIN_HOME);
    if (layout.created.length > 0) {
      console.error(`[abrain] brain layout: created ${layout.created.join(", ")}`);
    }
    for (const w of layout.warnings) {
      console.error(`[abrain] brain layout warning: ${w}`);
    }
  } catch (err: any) {
    console.error(`[abrain] brain layout failed:`, err);
  }

  // .state/ gitignore guard (P1-C audit fix 2026-05-16 round 3).
  // Ensure `.state/` is in abrain `.gitignore` BEFORE any writer can
  // produce orphan-rejects samples. Without this, an abrain repo that
  // existed before /abrain bind would carry sanitized user input
  // (title/body of route_rejected about-me samples) to the remote.
  // Idempotent: only writes when line missing. Best-effort: a write
  // failure logs but does not abort activation.
  try {
    const r = ensureAbrainStateGitignored(ABRAIN_HOME);
    if (r.updated) console.error(`[abrain] added .state/ to ${r.path}`);
  } catch (err: any) {
    console.error(`[abrain] .state/ gitignore guard failed (non-fatal):`, err);
  }

  // NOTE: startup git sync runs in the session_start event handler
  // below (not here at activate() time) so we can capture ctx.ui.notify
  // and surface results via pi's TUI instead of raw stderr. See the
  // comment block on runStartupAutoSync above for rationale.

  const registry = pi as unknown as CommandRegistry;
  const toolRegistry = pi as unknown as ToolRegistry;
  const eventRegistry = pi as unknown as EventRegistry;

  if (typeof eventRegistry.on === "function") {
    // Startup git sync trigger (Round 5 UX fix, 2026-05-17). We capture
    // ctx.ui.notify SYNCHRONOUSLY at handler entry (sediment's stale-ctx
    // pattern) and pass it into runStartupAutoSync's announce(). The
    // module-level startupAutoSyncDone flag ensures this runs exactly
    // once per pi process even though session_start fires on every new
    // session / fork / restart. Headless/RPC mode (no ctx.ui) falls back
    // to console.error inside announce(). Never throws to pi runtime.
    eventRegistry.on("session_start", async (_event, ctx) => {
      try {
        const notify = ctx?.ui?.notify?.bind(ctx.ui);
        runStartupAutoSync(notify);
      } catch (err) {
        // Defensive: never let our sync trigger break the session.
        console.error(`[abrain] session_start auto-sync trigger threw:`, err);
      }
    });

    // Track the user's current conversation language by sampling recent user
    // messages. Used by i18n.localizePrompt to translate vault authorization
    // prompts into the language the user is speaking.
    eventRegistry.on("message_start", async (event) => {
      const message = (event as { message?: unknown })?.message;
      const text = extractUserMessageText(message);
      if (text) recordUserMessage(text);
    });

    eventRegistry.on("tool_call", async (event, ctx) => {
      // ── Vault bash injection guard ───────────────────────────
      // Outer try/catch: if prepareBootVaultBashCommand throws for any
      // unexpected reason (malformed command, env-file write failure,
      // etc.), we MUST NOT silently pass the command through without
      // secret injection — that would leak cleartext into LLM context.
      try {
        if (event.toolName !== "bash") return;
        const command = String(event.input?.command ?? "");
        const activeProjectId = bootActiveProject?.activeProject?.projectId ?? null;
        const prepared = await prepareBootVaultBashCommand(command, { abrainHome: ABRAIN_HOME, stateDir: STATE_DIR, activeProjectId });
        if (prepared.kind === "none") return;
        if (prepared.kind === "block") {
          auditBashInjectBlock(command, prepared.reason);
          return { block: true, reason: prepared.reason };
        }
        event.input.command = prepared.command;
        // Stash the original (pre-wrap) command so the post-run authorization
        // prompt can show the user exactly what ran.
        prepared.record.originalCommand = command;
        vaultBashRuns.set(event.toolCallId, prepared.record);
        auditBashInject(prepared.record);
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[abrain] vault bash injection error (BLOCKING command — uninjected execution would leak secrets or run without vault env): ${message}`);
        // P2 fix (R6 audit): fail-closed — if vault injection fails for any
        // reason (env file write failure, decryption error, state corruption),
        // MUST block the command rather than executing it without injected
        // secrets. An uninjected command with $VAULT_* placeholders would:
        // (a) expand to host-environment variables if they exist, or
        // (b) run with literal $VAULT_* placeholders — both are dangerous.
        // The user can always re-run the command after fixing the vault issue.
        auditBashInjectBlock(String(event.input?.command ?? ""), `inject_error: ${message.slice(0, 200)}`);
        return { block: true, reason: `vault injection error: ${message.slice(0, 200)}` };
      }
    });

    eventRegistry.on("tool_result", async (event, ctx) => {
      // ── Vault bash output authorization guard ─────────────────
      // Outer try/catch: if authorizeVaultBashOutput or redaction
      // throws, we fail-CLOSED — withhold the bash output rather
      // than releasing raw vault-touched data to LLM context.
      // Audit row records the failure for forensic diagnosis.
      // (Changed from fail-open in R6 audit, 2026-05-14.)
      try {
        if (event.toolName !== "bash") return;
        const record = vaultBashRuns.get(event.toolCallId);
        if (!record) return;
        vaultBashRuns.delete(event.toolCallId);
        try { fs.rmSync(record.envFile, { force: true }); } catch {}

        const decision = await authorizeVaultBashOutput(ctx.ui, record, ctx.signal, ctx);
        if (decision !== "release") {
          auditBashOutput("bash_output_withhold", record);
          return {
            content: withheldVaultBashContent(record),
            details: { ...(event.details ?? {}), vault: { outputWithheld: true, keys: record.releases.map((r) => authKey(r.scope, r.key)) } },
          };
        }
        auditBashOutput("bash_output_release", record);
        return {
          content: redactVaultBashContent(event.content, record.releases),
          details: { ...(event.details ?? {}), vault: { outputReleased: true, redacted: true, keys: record.releases.map((r) => authKey(r.scope, r.key)) } },
        };
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.error(`[abrain] vault bash output authorization error (withholding output — authorization boundary failure): ${message}`);
        // Fail-closed: authorization/redaction failure MUST NOT release
        // raw vault-backed output into LLM context. The user can re-run
        // the command manually to get their output; a leaked secret is
        // irreversible. The vault operator can inspect vault-events.jsonl
        // to diagnose the authorization failure.
        try {
          const record = vaultBashRuns.get(event.toolCallId);
          if (record) {
            vaultBashRuns.delete(event.toolCallId);
            try { fs.rmSync(record.envFile, { force: true }); } catch {}
            auditBashOutput("bash_output_withhold", record);
          }
        } catch { /* best-effort */ }
        return {
          content: [{ type: "text", text: `[vault] bash output withheld — authorization/redaction error: ${message.slice(0, 300)}` }],
          details: { ...(event.details ?? {}), vault: { outputWithheld: true, reason: "authorization_error" } },
        };
      }
    });

    // P2 fix (R6 audit): session_shutdown cleanup for orphaned vault bash runs.
    // vaultBashRuns and env files are normally cleaned in tool_result, but
    // if the session ends without a matching tool_result (cancelled command,
    // pi crash, toolCallId mismatch), leftover plaintext records and env
    // files would persist across sessions. This handler drains any leftovers.
    eventRegistry.on("session_shutdown", async () => {
      try {
        for (const [, record] of vaultBashRuns) {
          try { fs.rmSync(record.envFile, { force: true }); } catch {}
        }
        vaultBashRuns.clear();
      } catch { /* best-effort */ }
      // ADR 0022 INV-B: drain any pending prompt_user dialogs so the
      // promises resolve with `cancelled` instead of leaking. This
      // also covers the case where the user hits Ctrl+C while a
      // PromptDialog overlay is open. Lazy require so this code path
      // is only realized when activate() has actually run.
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const promptManager = require("./prompt-user/manager") as {
          cancelAllPending: (reason?: string) => number;
        };
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const promptHandler = require("./prompt-user/handler") as {
          resetSoftCapCounter: () => void;
        };
        const cancelled = promptManager.cancelAllPending("cancelled");
        if (cancelled > 0) {
          safeAuditAppend({
            ts: new Date().toISOString(),
            op: "prompt_user_blocked",
            scope: "global",
            lane: "prompt_user",
            reason: "session_shutdown",
            keys: [String(cancelled)],
          });
        }
        promptHandler.resetSoftCapCounter();
      } catch { /* best-effort — prompt_user may not be wired yet */ }
    });
  }

  if (typeof toolRegistry.registerTool === "function") {
    toolRegistry.registerTool({
      name: "vault_release",
      label: "Release Vault Secret",
      description:
        "Request user-authorized release of a vault secret into the LLM context. " +
        "This is the P0c.read LLM-facing path: it prompts the user (Yes once / Session / No / Deny+remember) before decrypting. " +
        "Scope='global' targets the global vault; scope='project' targets the boot-time active project's vault (rejected when no active project is bound). Sub-pi processes register no vault tools.",
      promptSnippet: "vault_release(key, scope?: 'global'|'project', reason?: string)",
      promptGuidelines: [
        "Use vault_release only when plaintext is strictly necessary for the current task.",
        "Always provide a concise reason explaining why the secret must enter model context.",
        "Do not use vault_release for bash commands; $VAULT_<key> injection is the safer execution path.",
        "Project scope binds to the boot-time active project; to change it, restart pi (or run `/abrain bind --project=<id>` in the relevant project directory).",
      ],
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Vault key name to release, e.g. github-token." },
          scope: { type: "string", enum: ["global", "project"], description: "'global' = ~/.abrain/vault; 'project' = boot-time active project's vault. Defaults to 'global'." },
          reason: { type: "string", description: "Why plaintext must be released into the LLM context." },
        },
        required: ["key"],
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const key = String(params.key ?? "").trim();
        // Accept both flat (scope/reason at top level — preferred) and legacy
        // nested options.{scope,reason}. The flat form is the canonical schema;
        // the nested fallback covers callers that emit the older shape.
        const nested = (params.options && typeof params.options === "object") ? params.options as Record<string, unknown> : undefined;
        const scopeRaw = String((params.scope ?? nested?.scope ?? "global"));
        const reasonRaw = params.reason ?? nested?.reason;
        const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;

        let scope: VaultScope;
        if (scopeRaw === "global") {
          scope = "global";
        } else if (scopeRaw === "project") {
          const projectId = bootActiveProject?.activeProject?.projectId;
          if (!projectId) {
            const reasonCode = bootActiveProject?.reason ?? "manifest_missing";
            return toolJson({
              ok: false,
              error: `vault_release(scope='project') refused: ${secretDefaultRejection(reasonCode)}`,
            });
          }
          scope = { project: projectId };
        } else {
          return toolJson({ ok: false, error: `vault_release: unsupported scope='${scopeRaw}'. Use 'global' or 'project'.` });
        }

        try { validateKey(key); }
        catch (err: any) { return toolJson({ ok: false, error: `invalid vault key: ${err.message}` }); }

        // Pre-flight: avoid spending a user authorization prompt on a key that
        // does not exist. The encrypted file's mere existence is already
        // visible via `/secret list` metadata, so this check leaks no new
        // information but saves the user from approving phantom releases.
        try {
          if (!fs.existsSync(vaultFilePath(ABRAIN_HOME, scope, key))) {
            auditReleaseDecision("release_blocked", scope, key, { reason: "key_not_found" });
            return toolJson({
              ok: false,
              key,
              scope,
              error: `vault key not found or forgotten: ${scopeLabel(scope)}:${key}`,
              checkedBeforeAuthorization: true,
            });
          }
        } catch (err: any) {
          auditReleaseDecision("release_blocked", scope, key, { reason: "preflight_error" });
          return toolJson({ ok: false, key, scope, error: `vault key pre-flight failed: ${err?.message ?? String(err)}` });
        }

        const auth = await authorizeVaultRelease(ctx.ui, scope, key, reason, signal, ctx);
        if (!auth.ok) {
          auditReleaseDecision("release_denied", scope, key, { reason: auth.reason });
          return toolJson({ ok: false, key, scope, denied: true, reason: auth.reason });
        }

        try {
          const released = await releaseSecret({ abrainHome: ABRAIN_HOME, scope, key });
          auditReleaseDecision("release", scope, key);
          return toolJson({
            ok: true,
            key,
            scope,
            value: released.value,
            placeholder: released.placeholder,
            warning: "Plaintext is now in model context. Redaction is best-effort and does not cover encoded/transformed values.",
          });
        } catch (err: any) {
          auditReleaseDecision("release_blocked", scope, key, { reason: `release_error: ${err?.message ?? "unknown"}` });
          return toolJson({ ok: false, key, scope, error: err?.message ?? String(err) });
        }
      },
    });
  }

  // ── ADR 0022 P2: register prompt_user LLM tool ──────────────────
  if (typeof toolRegistry.registerTool === "function") {
    // Lazy require the prompt-user subtree + pi-tui. Doing this inside
    // activate() (rather than at top-level import) keeps headless
    // smoke fixtures that only need abrain EXPORTS from being forced
    // to satisfy the prompt-user / pi-tui resolution graph.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const promptHandlerModule = require("./prompt-user/handler") as {
      executePromptUserTool: typeof import("./prompt-user/handler").executePromptUserTool;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const promptManagerModule = require("./prompt-user/manager") as {
      getPendingPromptCount: () => number;
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const promptDialogModule = require("./prompt-user/ui/PromptDialog") as {
      makeBuildDialog: typeof import("./prompt-user/ui/PromptDialog").makeBuildDialog;
    };
    let pitui: PiTuiBag | undefined;
    try {
      // The pitui surface is intentionally narrow (see PromptDialog.ts
      // `PiTuiBag`). We rely on each named export being present;
      // missing names would surface as runtime errors on first prompt.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const tuiModule = require("@earendil-works/pi-tui");
      // DynamicBorder lives in pi-coding-agent, not pi-tui — pull from
      // the coding-agent re-export so PromptDialog sees a unified bag.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const codingAgent = require("@earendil-works/pi-coding-agent");
      pitui = {
        Container: tuiModule.Container,
        Text: tuiModule.Text,
        Input: tuiModule.Input,
        SelectList: tuiModule.SelectList,
        DynamicBorder: codingAgent.DynamicBorder,
        // R6.3 (2026-05-17): 加入 Spacer。PromptDialog 需要真正的空行间距 —
        // pi-tui Text 对 "" / "   " 走「不渲染」路径，以前用 Text("")
        // 当 spacer 一直是 0 行 (所以用户看到拥挤)。Spacer(1) 才是可靠间距。
        Spacer: tuiModule.Spacer,
      };
    } catch (err) {
      // pi-tui not available in this process — OK, prompt_user will
      // gracefully reject with ui-unavailable when called.
      void err;
    }

    // ADR 0022 P3b: cache the dialog builder so authorizeVaultRelease /
    // authorizeVaultBashOutput (top-level functions defined earlier in
    // this file) can use the same PromptDialog substrate. activate() is
    // synchronous; the cache is written here BEFORE the first
    // vault_release tool invocation can run (tool callbacks fire on
    // user actions which happen after activate returns).
    if (pitui) {
      cachedVaultDialogBuilder = promptDialogModule.makeBuildDialog(pitui);
    }

    // Audit sink: feeds prompt_user events into VAULT_EVENTS with
    // lane:"prompt_user". Vault tooling that grep on lane="vault_release"
    // (e.g. /abrain status) ignores these rows; new prompt_user smoke
    // greps on lane="prompt_user" instead.
    const promptAudit: PromptAuditSink = {
      recordAsk(ev) {
        safeAuditAppend({
          ts: ev.startedAt,
          op: "prompt_user_ask",
          scope: "global",
          lane: "prompt_user",
          // We reuse `keys[]` to carry the prompt id and question types;
          // VaultEvent.keys is typed `string[]` and intended for multi-key
          // events, but the field is loose enough that the audit
          // consumer (sediment evidence pre-pass, P3) can parse it.
          keys: [`id:${ev.id}`, `n:${ev.questionCount}`, ...ev.types.map((t) => `t:${t}`)],
          description: ev.reason.slice(0, 200),
        });
      },
      recordResult(ev) {
        safeAuditAppend({
          ts: new Date().toISOString(),
          op: "prompt_user_answer",
          scope: "global",
          lane: "prompt_user",
          keys: [
            `id:${ev.id}`,
            `outcome:${ev.outcome}`,
            `duration_ms:${ev.durationMs}`,
            ...ev.perQuestion.map((pq) =>
              `q:${pq.qid}=${pq.type}:${pq.lengthBucket ?? ""}`,
            ),
          ],
          // Description carries the human-readable summary (already
          // redacted; secret summaries are placeholders).
          description: ev.perQuestion
            .map((pq) => `${pq.qid}=${pq.summary}`)
            .join(" | ")
            .slice(0, 500),
        });
      },
    };

    const handlerDeps: PromptUserHandlerDeps = {
      dialog: {
        buildDialog: pitui
          ? promptDialogModule.makeBuildDialog(pitui)
          : () => {
              throw new Error("prompt_user: pi-tui not loaded in this process");
            },
      },
      audit: promptAudit,
      recordBlocked(ev) {
        safeAuditAppend({
          ts: new Date().toISOString(),
          op: "prompt_user_blocked",
          scope: "global",
          lane: "prompt_user",
          reason: ev.reason,
          description: ev.detail?.slice(0, 200),
        });
      },
    };

    toolRegistry.registerTool({
      name: "prompt_user",
      label: "Ask User a Structured Question",
      description:
        "Pause the turn and ask the user 1-4 structured questions (single / multi / text / secret). " +
        "Returns user-attested answers without ending the turn. " +
        "Use ONLY when you genuinely need a user decision that branching cannot determine " +
        "(framework choice, irreversible deploy confirmation, ambiguous spec clarification). " +
        "NOT a substitute for thinking out loud. Sub-pi processes register no prompt_user tool.",
      promptSnippet:
        "prompt_user({ reason, questions: [{ id, header, question, type, options? }], timeoutSec? })",
      promptGuidelines: [
        // R7.2 (2026-05-17): 以下 guideline 随 schema 简化同步。原
        // "header ≤ 12 cells / option labels 1-5 words" 被删除 —
        // validator R7.2 不再强制 (用户要求 LLM 自决长度)。
        "Issue a single prompt_user call with multiple questions[] rather than chaining calls. Concurrent prompts are rejected (INV-I).",
        "reason explains why you must pause (e.g. 'project framework choice affects scaffolding'), not a re-statement of the questions.",
        "Keep header / label / description-equivalent text short but length is up to you \u2014 the UI wraps automatically. CJK and ASCII both render correctly.",
        "option.label is the displayed text AND the canonical answer value. If you want to convey a tradeoff, write it directly in the label (e.g. 'TypeScript \u2014 \u5f3a\u7c7b\u578b\u5168\u6808'); the UI wraps long labels onto multiple lines.",
        "memory_search past preferences first (e.g. memory_search('user preference framework')) before asking.",
        "For irreversibility (deploy, rm -rf, push to main), prefer type:'single' with explicit Yes/No labels rather than free-form text.",
        "type:'secret' raw input never reaches you \u2014 you get [REDACTED_SECRET:<id>] placeholder. P0 LIMITATION (ADR 0022 \u00a7D6.4): there is no caller-side callback API yet, so the raw value is captured into a per-prompt internal Record that NO downstream code can read. Practical implication: do NOT use type:'secret' unless a specific extension has been written to consume it. For releasing stored vault secrets use vault_release instead. For generic user input that you yourself need to use, type:'text' is the right choice.",
        "Server-side 'Other (specify)' is ALWAYS appended to single/multi options \u2014 you cannot disable it. If the user picks Other and types free-form text T, the answer comes back as a string in answers[id]: for single \u2192 answers[id] = [T]; for multi \u2192 answers[id] contains the chosen preset labels PLUS T (length 0..N+1). There is no markup on Other text in the result \u2014 to distinguish it from a preset, check if the returned string matches any of your preset labels.",
      ],
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Why you must pause for user input. Concrete + irreversibility / ambiguity rationale.",
          },
          questions: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "snake_case identifier; unique within the call." },
                header: { type: "string", description: "Short section header. Any length; UI wraps automatically." },
                question: { type: "string", description: "Complete sentence shown above options. Any length; UI wraps automatically." },
                type: { type: "string", enum: ["single", "multi", "text", "secret"] },
                options: {
                  type: "array",
                  minItems: 2,
                  maxItems: 4,
                  description: "Required for single/multi; forbidden for text/secret. 'Other (specify)' is appended server-side.",
                  items: {
                    type: "object",
                    properties: {
                      // R7.2 合并 description→label。LLM 可以在 label 里直接
                      // 写「Name — tradeoff」格式，UI 多行 wrap。老调用仍传
                      // `description` 会被 validator silent-drop，不报错但
                      // 不会呈现。
                      label: { type: "string", description: "Displayed option text AND canonical answer value. Any length; wraps to multiple lines if long." },
                      recommended: { type: "boolean", description: "At most one option per question may be recommended; UI suffixes ' (Recommended)' to the label." },
                    },
                    required: ["label"],
                  },
                },
              },
              required: ["id", "header", "question", "type"],
            },
          },
          timeoutSec: {
            type: "number",
            description: "Clamped to [30, 1800]; default 600.",
          },
        },
        required: ["reason", "questions"],
      },
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        // The handler accepts a richer ctx than the abrain Vault one;
        // narrow with a cast. ui.custom is exposed by pi RPC + TUI.
        const promptCtx = ctx as unknown as {
          ui: {
            custom?: unknown;
            select?: unknown;
            input?: unknown;
            notify?: unknown;
          };
          signal?: AbortSignal;
          hasUI?: boolean;
        };
        const json = await promptHandlerModule.executePromptUserTool(
          params,
          signal,
          promptCtx as unknown as Parameters<typeof promptHandlerModule.executePromptUserTool>[2],
          handlerDeps,
        );
        // pi's agent-core (pi-agent-core/dist/agent-loop.js) expects
        // execute() to return a ToolResult { content, details }, not a
        // raw string. When the tool returns a string, pi spreads it
        // into the tool_execution_end event (`{...event.result}`),
        // which yields an object with numeric keys per character and
        // no `content` field — `render-utils.js getTextOutput()` then
        // crashes on `result.content.filter(...)` and the whole TUI
        // dies via uncaughtException. This is the same failure mode
        // that bit the memory extension on 2026-05-09 (see decision
        // memory-tools-must-return-toolresult-content). Wrap the
        // canonical JSON string (which handler.ts is contractually
        // required to produce — smoke tests parse it back) into the
        // ToolResult envelope. We also expose the parsed payload as
        // `details` so any future custom renderer can read it without
        // re-parsing; JSON.parse is guarded so a malformed handler
        // return (defense in depth — handler never throws and always
        // JSON.stringify's a known shape) can't crash the registry.
        let details: unknown;
        try { details = JSON.parse(json); } catch { details = { raw: json }; }
        return {
          content: [{ type: "text", text: json }],
          details,
        };
      },
    });

    // Expose pending count for compaction-tuner / smoke introspection.
    // We attach to globalThis (not the pi API) because compaction-tuner
    // is a separate extension and a runtime fetch keeps the coupling
    // explicit + breakable for tests.
    (globalThis as { __abrainPromptUserGetPending?: () => number }).__abrainPromptUserGetPending =
      () => promptManagerModule.getPendingPromptCount();
  }

  if (typeof registry.registerCommand !== "function") return;

  // /abrain command — project binding (ADR 0017 / B4.5) + git auto-sync (ADR 0020).
  registry.registerCommand("abrain", {
    description: "Abrain control: /abrain bind [--project=<id>] | /abrain status | /abrain sync",
    getArgumentCompletions(prefix: string) {
      const items = ["bind ", "bind --project=", "status", "sync"];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { cwd?: string; ui: { notify(message: string, type?: string): void } }): Promise<void> {
      try {
        await handleAbrain(args.trim(), ctx.ui, ctx.cwd);
      } catch (err: any) {
        ctx.ui.notify(`/abrain: ${err.message}`, "warning");
      }
    },
  });

  // /secret command — vault write/list/forget (P0c.write).
  // Read paths (release / bash injection) are P0c.read.
  registry.registerCommand("secret", {
    description: "Vault secrets: /secret set <key>=<value> [--global | --project=<id>] | /secret list [--global | --project=<id> | --all-projects] | /secret forget <key> [--global | --project=<id>]. Default scope is the boot-time active project.",
    getArgumentCompletions(prefix: string) {
      const items = [
        "set ",
        "set --global ",
        "set --project=",
        "list",
        "list --global",
        "list --all-projects",
        "list --project=",
        "forget ",
        "forget --global ",
        "forget --project=",
      ];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { ui: { notify(message: string, type?: string): void } }): Promise<void> {
      try {
        await handleSecret(args.trim(), ctx.ui);
      } catch (err: any) {
        ctx.ui.notify(`/secret: ${err.message}`, "warning");
      }
    },
  });

  registry.registerCommand("vault", {
    description: "Vault status / control: /vault status | /vault init [--backend=<name>]",
    getArgumentCompletions(prefix: string) {
      // Keep aligned with parseInitArgs() backend whitelist below.
      const items = [
        "status",
        "init",
        "init --backend=ssh-key",
        "init --backend=gpg-file",
        "init --backend=passphrase-only",
        "init --backend=macos",
        "init --backend=secret-service",
        "init --backend=pass",
      ];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx: { ui: { notify(message: string, type?: string): void } }): Promise<void> {
      const trimmed = args.trim();
      const sub = trimmed.split(/\s+/)[0] || "status";
      // Round 7 P1 (gpt-5.5 audit fix): outer try/catch barrier so any
      // async throw from handleInit (gpg-file errors, age write failures,
      // keychain access errors, fs permission errors) is presented as a
      // user-readable notify instead of leaking as unhandled rejection.
      try {
        switch (sub) {
          case "status":
            handleStatus(ctx.ui);
            return;
          case "init":
            await handleInit(trimmed.slice("init".length).trim(), ctx.ui);
            return;
          default:
            ctx.ui.notify(`/vault: unknown subcommand '${sub}'. Available: status, init`, "warning");
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/vault ${sub} failed: ${message}`, "error");
      }
    },
  });
}

// ── /vault init ─────────────────────────────────────────────────
//
// ADR 0019 non-interactive form: `/vault init` defaults to abrain-age-key.
// Explicit `--backend=<name>` opts into Tier 3 legacy backends with a
// stderr warning about cross-device implications. Full TUI onboarding
// wizard (vault-bootstrap §4) is P0d.

interface InitOptions {
  backend?: EncryptableBackend;
}

function parseInitArgs(args: string): InitOptions {
  const opts: InitOptions = {};
  for (const tok of args.split(/\s+/).filter(Boolean)) {
    const m = tok.match(/^--backend=(.+)$/);
    if (m) {
      const v = m[1] as EncryptableBackend;
      const valid: ReadonlySet<string> = new Set([
        "abrain-age-key",
        "ssh-key", "gpg-file", "passphrase-only",
        "macos", "secret-service", "pass",
      ]);
      if (!valid.has(v)) throw new Error(`invalid backend: ${v}`);
      opts.backend = v;
      continue;
    }
    // No `--force` flag: vault re-init is intentionally hard-blocked. To
    // switch backends, wait for `/vault migrate-backend` (P0d) or manually
    // move `~/.abrain/.vault-master.age` aside and rerun /vault init. A
    // historical `--force` no-op flag was accepted but never read; removed
    // in Round 5 audit (gpt-5.5 P2) to stop misleading the CLI surface.
    throw new Error(`unknown init flag: ${tok}`);
  }
  return opts;
}

async function handleInit(rawArgs: string, ui: { notify(message: string, type?: string): void }): Promise<void> {
  // Idempotent guard: if vault already initialized, refuse re-init.
  //
  // No `--force` escape hatch: actually wiping a live vault requires
  // migrating existing secrets and reseating the master key, which is the
  // `vault migrate-backend` flow (P0d, pending). Until that lands, the
  // user-facing instruction is to manually move `~/.abrain/.vault-master.age`
  // aside and rerun /vault init. The historical `--force` no-op flag was
  // removed in Round 5 audit (gpt-5.5 P2): it accepted but never honored,
  // so it gave a false promise to anyone who tried it.
  const existing = readBackendFile(ABRAIN_HOME);
  if (existing) {
    ui.notify(
      `vault already initialized (backend=${existing.backend}). To switch backends, wait for \`/vault migrate-backend\` (P0d) or manually move ~/.abrain/.vault-master.age and rerun.`,
      "warning",
    );
    return;
  }

  let opts: InitOptions;
  try {
    opts = parseInitArgs(rawArgs);
  } catch (err: any) {
    ui.notify(`/vault init: ${err.message}`, "warning");
    return;
  }

  // Resolve backend + identity
  let backend: EncryptableBackend;
  let identity: string | undefined;
  if (opts.backend) {
    backend = opts.backend;
    // ADR 0019: explicit Tier 3 legacy backends — warn about cross-device burden
    if (backend === "ssh-key") {
      ui.notify(
        `⚠ ssh-key backend reuses your system ssh key. Cross-device unlock requires you to copy that ssh secret key (~/.ssh/id_*) to every device, which usually conflicts with per-device default ssh keys. Prefer the default abrain-age-key backend unless you specifically need ssh-key reuse.`,
        "warning",
      );
    } else if (backend === "gpg-file") {
      ui.notify(
        `⚠ gpg-file backend reuses your system GPG identity. Cross-device unlock requires the same GPG private key on every device. Prefer the default abrain-age-key backend unless you specifically need GPG identity reuse.`,
        "warning",
      );
    } else if (backend === "passphrase-only") {
      ui.notify(
        `⚠ passphrase-only backend: init writes ~/.abrain/.vault-master.age but the reader path does NOT yet support tty pass-through (roadmap P0d). The next pi restart will fail to unlock. Prefer the default abrain-age-key backend.`,
        "warning",
      );
    }
    if (backend === "ssh-key") {
      // ssh-key is no longer auto-detected (ADR 0019); pick best guess from ~/.ssh/.
      const home = os.homedir();
      if (fs.existsSync(`${home}/.ssh/id_ed25519`) && fs.existsSync(`${home}/.ssh/id_ed25519.pub`)) {
        identity = `${home}/.ssh/id_ed25519`;
      } else if (fs.existsSync(`${home}/.ssh/id_rsa`) && fs.existsSync(`${home}/.ssh/id_rsa.pub`)) {
        identity = `${home}/.ssh/id_rsa`;
      } else {
        throw new Error("ssh-key backend requires ~/.ssh/id_ed25519 or ~/.ssh/id_rsa with matching .pub; neither found.");
      }
    } else if (backend === "gpg-file") {
      const probe = buildRealDeps();
      if (probe.commandExists("gpg") && probe.gpgFirstSecretKey) {
        identity = probe.gpgFirstSecretKey() ?? undefined;
      }
      if (!identity) throw new Error("gpg-file requested but no GPG secret key detected. install / import GPG identity first.");
    }
    // abrain-age-key: identity field stays undefined; path is fixed (~/.abrain/.vault-identity/master.age)
  } else {
    // ADR 0019: no --backend flag → default to abrain-age-key.
    // detectBackend returns abrain-age-key when age-keygen is available
    // (or already initialized); only surface a friendly error when even
    // that prerequisite is missing.
    const detected = detectBackend(buildRealDeps());
    if (detected.backend === "abrain-age-key") {
      backend = "abrain-age-key";
      // identity intentionally undefined; encryptMasterKey fills it at the canonical path
    } else {
      ui.notify(
        `/vault init: cannot auto-pick backend (detected '${detected.backend}'). ` +
        `Default abrain-age-key needs age-keygen on PATH. Install age (\`apt install age\` / \`brew install age\`) and retry, ` +
        `or pass --backend=<name> explicitly for a Tier 3 backend with the documented caveats.`,
        "warning",
      );
      return;
    }
  }

  await runInit(backend, identity, ui);
}

/**
 * Execute the §3 transactional flow. Used by handleInit but exported as a
 * pure function so smoke can drive it without TUI ceremony.
 */
export async function runInit(
  backend: EncryptableBackend,
  identity: string | undefined,
  ui: { notify(message: string, type?: string): void },
  exec: ExecFn = realExec,
  abrainHome: string = ABRAIN_HOME,
): Promise<{ publicKey: string; warnings: string[] }> {
  // (0) install tmp
  fs.mkdirSync(abrainHome, { recursive: true });
  const installTmp = createInstallTmpDir(abrainHome);
  let warnings: string[] = [];
  let publicKey = "";

  try {
    // (1) age-keygen
    ui.notify("generating age master keypair...", "info");
    const { secretKeyPath, publicKey: pub } = await generateMasterKey(installTmp);
    publicKey = pub;
    ui.notify(`master public key: ${pub}`, "info");

    // (2) backend.encrypt
    const vaultMasterEncryptedPath = path.join(abrainHome, ".vault-master.age");
    const isFileBackend = backend === "ssh-key" || backend === "gpg-file" || backend === "passphrase-only";

    // Defense: file-backend output must not pre-exist (avoid silent overwrite)
    if (isFileBackend && fs.existsSync(vaultMasterEncryptedPath)) {
      throw new Error(
        `${vaultMasterEncryptedPath} already exists. Refusing to overwrite. ` +
        `Run \`rm ${vaultMasterEncryptedPath}\` first if you really want to re-init.`,
      );
    }

    // ADR 0019: same defense for abrain-age-key identity secret
    if (backend === "abrain-age-key") {
      const identitySecretPath = path.join(abrainHome, ".vault-identity", "master.age");
      if (fs.existsSync(identitySecretPath)) {
        throw new Error(
          `${identitySecretPath} already exists. Refusing to overwrite. ` +
          `Run \`rm -rf ${path.join(abrainHome, ".vault-identity")}\` first if you really want to re-init.`,
        );
      }

      // ADR 0019 invariant 2 — defense in depth (self-review MAJOR-2 fix,
      // 2026-05-15): write the .gitignore guard BEFORE the identity secret
      // lands on disk, not after. Encrypting first then patching gitignore
      // leaves a (millisecond, but real) window where the secret exists on
      // disk without gitignore protection. Self-review judged the window's
      // practical risk near zero because init is a synchronous flow and the
      // user is not going to `git add` mid-init — but defense-in-depth costs
      // nothing and forecloses every "what if someone scripts init then
      // immediately git-adds" edge case.
      ensureAbrainGitignoreLines(abrainHome, [
        "# ADR 0019: abrain-age-key identity secret — never enter git",
        ".vault-identity/master.age",
        ".vault-identity/master.age.tmp.*",
      ]);
    }

    ui.notify(
      backend === "abrain-age-key"
        ? `installing abrain identity (backend=abrain-age-key, ADR 0019)...`
        : `encrypting master key via backend=${backend}...`,
      "info",
    );
    await encryptMasterKey(backend, {
      masterSecretPath: secretKeyPath,
      masterPublicKey: publicKey,
      identity,
      vaultMasterEncryptedPath,
      user: process.env.USER,
    }, exec);

    // ADR 0019 invariant 6 post-init assert (2026-05-15 audit fix). The
    // "abrain-age-key does NOT generate .vault-master.age" property is
    // currently held only by keychain.ts::encryptMasterKey case "abrain-
    // age-key" early-returning without writing the file. That contract
    // is invisible from this caller; a future refactor (e.g. unifying
    // backend cases into a shared helper) could silently leak a
    // double-encrypted master.age into the abrain repo, where it would
    // also be a confusing fallback path for vault-reader. Fail loudly
    // here instead of relying on case-by-case discipline.
    if (backend === "abrain-age-key" && fs.existsSync(vaultMasterEncryptedPath)) {
      // Best-effort cleanup so the regression doesn't poison subsequent
      // /vault init runs (which would then trip the file-backend pre-
      // existence guard above). Throw before writing pubkey/backend
      // marker files so /vault status still reports "uninitialized".
      try { fs.unlinkSync(vaultMasterEncryptedPath); } catch { /* best-effort */ }
      throw new Error(
        `ADR 0019 invariant violation: abrain-age-key init unexpectedly produced ${vaultMasterEncryptedPath}. ` +
        `This file is reserved for Tier 3 backends (ssh-key/gpg-file/passphrase-only). ` +
        `Likely cause: a regression in keychain.ts::encryptMasterKey. The orphan file has been removed.`,
      );
    }

    // (3) write .vault-pubkey + .vault-backend (atomic, both files).
    // For abrain-age-key, .vault-pubkey duplicates .vault-identity/master.age.pub
    // (ADR 0019 invariant 6) so existing vault-writer code stays unchanged.
    writePubkeyFile(abrainHome, publicKey);
    writeBackendFile(abrainHome, { backend, identity });
  } finally {
    // (4) cleanup ALWAYS — secret must not survive an error
    warnings = await cleanupInstallDir(installTmp);
  }

  for (const w of warnings) ui.notify(`vault init warning: ${w}`, "warning");
  ui.notify(`vault initialized (backend=${backend}). Run /vault status to verify.`, "info");
  return { publicKey, warnings };
}

// Real exec impl wrapping execCapture from bootstrap (re-exported for runInit default)
const realExec: ExecFn = async (cmd, args, opts) => {
  return execCapture(cmd, args, opts);
};

/**
 * Append the given lines to ~/.abrain/.gitignore if not already present.
 * Idempotent: each line is checked individually; only missing ones are
 * appended. Creates the file if absent.
 *
 * ADR 0019 invariant 2 enforcement: vault identity secret must never
 * enter git. Called from runInit BEFORE the identity secret is written
 * (defense in depth — see runInit's (2)-before-(3) ordering).
 *
 * Exported so smoke tests can validate the gitignore patch behavior
 * directly without spinning up the full runInit pipeline.
 */
export function ensureAbrainGitignoreLines(abrainHome: string, lines: string[]): void {
  const gi = path.join(abrainHome, ".gitignore");
  let existing = "";
  if (fs.existsSync(gi)) existing = fs.readFileSync(gi, "utf8");

  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const toAppend: string[] = [];
  for (const ln of lines) {
    if (!existingLines.has(ln.trim())) toAppend.push(ln);
  }
  if (toAppend.length === 0) return;

  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n\n" : "\n";
  const next = existing + sep + toAppend.join("\n") + "\n";
  // Atomic write via tmp + rename so a partial write never leaves a malformed gitignore.
  const tmp = `${gi}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, next, { mode: 0o644 });
  try {
    fs.renameSync(tmp, gi);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
}

// ── /secret command handler ─────────────────────────────────────
//
// ADR 0014 P1 step 2: default scope is the boot-time active project; users
// opt into global with --global, or into a specific project with
// --project=<id>. When no active project can be resolved, default-scope
// operations refuse with an actionable reason instead of guessing.

function scopeReadableLabel(scope: VaultScope): string {
  return scope === "global" ? "global" : `project:${scope.project}`;
}

function renderListing(scope: VaultScope): string {
  const items = listSecrets(ABRAIN_HOME, scope);
  const label = scopeReadableLabel(scope);
  if (items.length === 0) return `${label} vault — no secrets yet`;
  const lines: string[] = [`${label} vault — ${items.length} key(s):`];
  for (const item of items) {
    const status = item.forgotten ? "  [forgotten]" : "";
    const desc = item.description ? `  — ${item.description}` : "";
    let timeAnnotation = "";
    if (item.forgotten && item.forgottenAt) timeAnnotation = ` forgotten ${item.forgottenAt}`;
    else if (item.created) timeAnnotation = ` (since ${item.created})`;
    lines.push(`  ${item.key}${status}${timeAnnotation}${desc}`);
  }
  return lines.join("\n");
}

async function handleSecret(args: string, ui: { notify(message: string, type?: string): void }): Promise<void> {
  // Pre-flight: vault must be initialized
  const backend = readBackendFile(ABRAIN_HOME);
  if (!backend) {
    ui.notify("vault not initialized. run `/vault init` first.", "warning");
    return;
  }

  const tokens = args.split(/\s+/).filter(Boolean);
  const sub = tokens[0] || "";
  const rest = tokens.slice(1);
  const parsed = parseSecretScopeFlags(rest);
  if (parsed.errors.length > 0) {
    ui.notify(`/secret ${sub || "?"}: ${parsed.errors.join("; ")}`, "warning");
    return;
  }

  if (sub === "set") {
    if (parsed.allProjects) {
      ui.notify("/secret set: --all-projects is not a valid target for writes", "warning");
      return;
    }
    const resolved = resolveSecretScope(parsed.scope, bootActiveProject);
    if (!resolved.ok) {
      ui.notify(`/secret set: ${resolved.reason}`, "warning");
      return;
    }
    const valueSpec = parsed.positional.join(" ");
    const eqIdx = valueSpec.indexOf("=");
    if (eqIdx <= 0) {
      ui.notify("/secret set: expected `<key>=<value>` (use --global or --project=<id> for non-default scope)", "warning");
      return;
    }
    const key = valueSpec.slice(0, eqIdx).trim();
    let value: string | null = valueSpec.slice(eqIdx + 1);
    try { validateKey(key); }
    catch (err: any) {
      ui.notify(`/secret set: invalid key: ${err.message}`, "warning");
      value = null;
      return;
    }
    if (!value) {
      ui.notify("/secret set: value cannot be empty", "warning");
      return;
    }
    try {
      const result = await writeSecret({
        abrainHome: ABRAIN_HOME,
        scope: resolved.scope,
        key,
        value,
      });
      value = null;
      ui.notify(
        `/secret set: wrote ${scopeReadableLabel(resolved.scope)}:${key} → ${path.relative(ABRAIN_HOME, result.encryptedPath)}`,
        "info",
      );
    } catch (err: any) {
      value = null;
      ui.notify(`/secret set failed: ${err.message}`, "warning");
    }
    return;
  }

  if (sub === "list") {
    if (parsed.allProjects) {
      if (parsed.positional.length > 0) {
        ui.notify(`/secret list: unexpected positional arg(s): ${parsed.positional.join(" ")}`, "warning");
        return;
      }
      const sections: string[] = [renderListing("global")];
      const projectIds = listAbrainProjects(ABRAIN_HOME);
      if (projectIds.length === 0) {
        sections.push("(no project vaults under ~/.abrain/projects/)");
      } else {
        for (const projectId of projectIds) sections.push(renderListing({ project: projectId }));
      }
      ui.notify(sections.join("\n\n"), "info");
      return;
    }
    if (parsed.positional.length > 0) {
      ui.notify(`/secret list: unexpected positional arg(s): ${parsed.positional.join(" ")}`, "warning");
      return;
    }
    if (parsed.scope !== "default") {
      const resolved = resolveSecretScope(parsed.scope, bootActiveProject);
      if (!resolved.ok) { ui.notify(`/secret list: ${resolved.reason}`, "warning"); return; }
      ui.notify(renderListing(resolved.scope), "info");
      return;
    }
    // Default: list global PLUS active project (if any).
    const sections: string[] = [renderListing("global")];
    if (bootActiveProject && bootActiveProject.activeProject) {
      sections.push(renderListing({ project: bootActiveProject.activeProject.projectId }));
    } else if (bootActiveProject?.reason) {
      sections.push(`(no active project: ${secretDefaultRejection(bootActiveProject.reason)})`);
    }
    ui.notify(sections.join("\n\n"), "info");
    return;
  }

  if (sub === "forget") {
    if (parsed.allProjects) {
      ui.notify("/secret forget: --all-projects is not a valid target", "warning");
      return;
    }
    const resolved = resolveSecretScope(parsed.scope, bootActiveProject);
    if (!resolved.ok) {
      ui.notify(`/secret forget: ${resolved.reason}`, "warning");
      return;
    }
    const key = parsed.positional[0];
    if (!key) {
      ui.notify("/secret forget <key>: missing key", "warning");
      return;
    }
    if (parsed.positional.length > 1) {
      ui.notify(`/secret forget: unexpected extra args: ${parsed.positional.slice(1).join(" ")}`, "warning");
      return;
    }
    try { validateKey(key); }
    catch (err: any) {
      ui.notify(`/secret forget: invalid key: ${err.message}`, "warning");
      return;
    }
    try {
      const result = await forgetSecret(ABRAIN_HOME, resolved.scope, key);
      const label = scopeReadableLabel(resolved.scope);
      // Round 7 P0 (gpt-5.5): forget outcome is tri-state. "absent" is a
      // no-op; "removed" is success; "removal_failed" means the encrypted
      // file is still on disk and plaintext is still recoverable — must
      // NOT be reported as no-op.
      if (result.status === "removed") {
        ui.notify(`/secret forget: removed ${label}:${key}`, "info");
      } else if (result.status === "absent") {
        ui.notify(`/secret forget: ${label}:${key} was not present (no-op, audit row recorded)`, "info");
      } else {
        ui.notify(
          `/secret forget FAILED: ${label}:${key} encrypted file is still on disk; plaintext remains recoverable. Reason: ${result.error}. Audit row 'forget_failed' written.`,
          "warning",
        );
      }
    } catch (err: any) {
      ui.notify(`/secret forget failed: ${err.message}`, "warning");
    }
    return;
  }

  ui.notify(
    `/secret: unknown subcommand '${sub}'. available: set / list / forget. Default scope is the boot-time active project; pass --global or --project=<id> to override.`,
    "warning",
  );
}

function parseProjectFlag(tokens: string[]): { projectId?: string; errors: string[] } {
  const errors: string[] = [];
  let projectId: string | undefined;
  for (const tok of tokens) {
    const m = tok.match(/^--project=(.+)$/);
    if (m) {
      const id = m[1]!.trim();
      try { validateAbrainProjectId(id); projectId = id; }
      catch (err: any) { errors.push(`invalid --project=<id>: ${err.message}`); }
      continue;
    }
    if (tok.trim()) errors.push(`unknown argument: ${tok}`);
  }
  return { projectId, errors };
}

function formatBindingStatus(result: ResolveActiveProjectResult | null): string {
  if (!result) return "Project binding: unknown (resolver not initialized)";
  if (result.activeProject) {
    return [
      "Project binding: bound",
      `  project_id: ${result.activeProject.projectId}`,
      `  root: ${result.activeProject.projectRoot}`,
      `  manifest: ${result.activeProject.manifestPath}`,
      `  registry: ${result.activeProject.registryPath}`,
      `  local_map: ${result.activeProject.localMapPath}`,
      `  confirmed_path: ${result.activeProject.localPath.path}`,
      `  last_seen: ${result.activeProject.localPath.last_seen}`,
    ].join("\n");
  }
  const hint = result.reason === "manifest_missing"
    ? "/abrain bind --project=<id>"
    : "/abrain bind";
  return [
    `Project binding: ${result.reason}`,
    ...(result.projectId ? [`  project_id: ${result.projectId}`] : []),
    ...(result.projectRoot ? [`  root: ${result.projectRoot}`] : []),
    ...(result.manifestPath ? [`  manifest: ${result.manifestPath}`] : []),
    ...(result.registryPath ? [`  registry: ${result.registryPath}`] : []),
    ...(result.localMapPath ? [`  local_map: ${result.localMapPath}`] : []),
    ...(result.detail ? [`  detail: ${result.detail}`] : []),
    `  next: ${hint}`,
  ].join("\n");
}

async function handleAbrain(rawArgs: string, ui: { notify(message: string, type?: string): void }, cwd = process.cwd()): Promise<void> {
  const commandCwd = path.resolve(cwd || process.cwd());
  const tokens = rawArgs.split(/\s+/).filter(Boolean);
  const sub = tokens.shift() ?? "status";
  if (sub === "status") {
    // Binding status (ADR 0017) + git auto-sync status (ADR 0020) in one view.
    const current = snapshotBootActiveProject(commandCwd);
    const bindingMsg = formatBindingStatus(current);
    let syncStatus: AbrainSyncStatus | null = null;
    try {
      syncStatus = await getGitSyncStatus(ABRAIN_HOME);
    } catch (e: unknown) {
      // getStatus is best-effort; if it throws, we still show binding status.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[abrain] getGitSyncStatus failed:`, msg);
    }
    const syncMsg = syncStatus ? formatSyncStatus(syncStatus) : "";
    // 2026-05-17: warning is now triggered by last fetch hitting a textual
    // conflict — the only state that genuinely needs user attention after
    // the auto-merge revision of fetchAndFF. Mere ahead+behind both >0 is
    // transient pre-fetch state, not a problem.
    const needsAttention = syncStatus?.lastFetch?.result === "conflict";
    const fullMsg = syncMsg ? `${bindingMsg}\n\n${syncMsg}` : bindingMsg;
    ui.notify(fullMsg, needsAttention ? "warning" : (current.activeProject ? "info" : "warning"));
    return;
  }
  if (sub === "sync") {
    // Manual /abrain sync: fetch + ff-pull + push in one call (ADR 0020).
    ui.notify("abrain: syncing with origin/main...", "info");
    const result = await gitSync({ abrainHome: ABRAIN_HOME });
    ui.notify(result.summary, result.ok ? "info" : "warning");
    return;
  }
  if (sub === "bind") {
    const parsed = parseProjectFlag(tokens);
    if (parsed.errors.length > 0) {
      ui.notify(`/abrain bind: ${parsed.errors.join("; ")}`, "warning");
      return;
    }
    try {
      const result = await bindAbrainProject({
        abrainHome: ABRAIN_HOME,
        cwd: commandCwd,
        projectId: parsed.projectId,
      });
      const projectCommit = autoCommitPaths(
        result.projectRoot,
        [".abrain-project.json"],
        `chore: 绑定 abrain 项目 ${result.projectId}`,
      );
      const abrainCommit = autoCommitPaths(
        ABRAIN_HOME,
        [".gitignore", `projects/${result.projectId}/_project.json`],
        `project: 添加 ${result.projectId}`,
      );
      bootActiveProject = snapshotBootActiveProject(commandCwd);
      bootActiveProjectAt = Date.now();
      const commitWarning = autoCommitNeedsWarning(projectCommit) || autoCommitNeedsWarning(abrainCommit);
      ui.notify([
        `Bound current project to abrain project: ${result.projectId}`,
        "",
        "Wrote/updated:",
        `- ${result.manifestPath}${result.manifestCreated ? " (created)" : " (verified)"}`,
        `- ${result.registryPath}${result.registryCreated ? " (created)" : " (updated)"}`,
        `- ${result.localMapPath}${result.localPathAdded ? " (path added)" : " (path refreshed)"}`,
        `- ${result.abrainGitignorePath}${result.abrainGitignoreUpdated ? " (added .state/ ignore)" : " (verified .state/ ignore)"}`,
        "",
        "Auto-commits:",
        formatAutoCommitResult("project repo", projectCommit),
        formatAutoCommitResult("abrain repo", abrainCommit),
        ...(commitWarning ? ["", "Warning: auto-commit failed/skipped for at least one repo; fix it before `/memory migrate --go`."] : []),
      ].join("\n"), commitWarning ? "warning" : "info");
    } catch (err: any) {
      ui.notify(`/abrain bind failed: ${err.message}`, "warning");
    }
    return;
  }
  ui.notify(`/abrain: unknown subcommand '${sub}'. available: bind / status / sync`, "warning");
}

function handleStatus(ui: { notify(message: string, type?: string): void }): void {
  const status = getVaultStatus();
  if (status.subPiDisabled) {
    // Should never happen — we returned early in activate(). Belt-and-suspenders.
    ui.notify("🔒 vault: disabled (PI_ABRAIN_DISABLED=1, sub-pi context)", "info");
    return;
  }

  // v1.4.2: prefer .vault-backend (init record) over detection. Detection
  // is only used when vault is not yet initialized. See vault-bootstrap §4.1.
  const initialized = readInitializedState(ABRAIN_HOME);
  ui.notify(formatStatus(status.backend, status.userDisabledFlag, initialized), "info");
}

/**
 * Read everything formatStatus needs to render the 'initialized' state.
 * Returns null if .vault-backend doesn't exist (= vault not yet initialized).
 * Best-effort on optional bits (.vault-pubkey, .vault-master.age) — a
 * missing optional doesn't make the state unreadable.
 */
function readInitializedState(abrainHome: string): InitializedState | null {
  const backendInfo = readBackendFile(abrainHome);
  if (!backendInfo) return null;

  const result: InitializedState = {
    backend: backendInfo.backend,
    identity: backendInfo.identity,
    vaultMasterPresent: false,
  };

  // .vault-pubkey is best-effort
  try {
    const pkPath = path.join(abrainHome, ".vault-pubkey");
    if (fs.existsSync(pkPath)) {
      result.publicKey = fs.readFileSync(pkPath, "utf8").trim();
    }
  } catch { /* ignore */ }

  // .vault-master.age existence + mode (Tier 3 file backends only)
  try {
    const mkPath = path.join(abrainHome, ".vault-master.age");
    if (fs.existsSync(mkPath)) {
      result.vaultMasterPresent = true;
      result.vaultMasterMode = fs.statSync(mkPath).mode;
    }
  } catch { /* ignore */ }

  // .vault-identity/master.age existence + mode (ADR 0019, abrain-age-key)
  try {
    const idPath = path.join(abrainHome, ".vault-identity", "master.age");
    if (fs.existsSync(idPath)) {
      result.identitySecretPresent = true;
      result.identitySecretMode = fs.statSync(idPath).mode;
    } else {
      result.identitySecretPresent = false;
    }
  } catch { /* ignore */ }

  return result;
}
