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
  cleanupLegacyAdr0039PrePushHook,
  ensureAbrainStateGitignored,
  ensureBrainLayout,
} from "./brain-layout";
import activateRuleInjector, { setRuleInjectorSelfHealScheduler, type RuleInjectorSelfHealTrigger } from "./rule-injector";
import {
  pushAsync, sync as gitSync, getStatus as getGitSyncStatus,
  formatSyncStatus, type AbrainSyncStatus, type GitSyncEvent, type GitSyncNotifyType,
} from "./git-sync";
import {
  authKey,
  prepareBootVaultBashCommand,
  redactVaultBashContent,
  scopeLabel,
  VAULT_BASH_OUTPUT_AUTH_CHOICES,
  vaultBashOutputDisplayLabel,
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
import {
  withCanonicalMutationBarrier,
  withoutCanonicalMutationBarrierContext,
} from "../_shared/canonical-mutation-barrier";
import {
  canonicalGitRuntimeEnabled,
  createProducedArtifactReceipt,
  getCanonicalGitRuntime,
  getCanonicalStartupPromise,
  reportCanonicalStartupConsumer,
  scheduleCanonicalStartupConsumer,
  setCanonicalStartupReporter,
  type CanonicalStartupHostMode,
} from "../_shared/canonical-git-runtime";
import { isSubAgentSession } from "../_shared/pi-internals";
import { extractUserMessageText, localizePrompt, recordUserMessage } from "./i18n";
import type { SedimentSettings } from "../sediment/settings";
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
// `isVaultDialogInFlight` is the cross-extension query used by
// compaction-tuner (ADR 0022 §D11) to defer compaction while the user
// is answering a vault authorization overlay — same INV-K shape as
// prompt_user, but a separate substrate/hook.
import {
  askVaultAuthorizationViaDialog,
  isVaultDialogInFlight,
} from "./vault-authorize";

// ── ~/.abrain layout constants (single source — referenced from spec §3) ──
// Priority: ABRAIN_ROOT env var > default ~/.abrain (aligned with memory/parser.ts)

const ABRAIN_HOME = process.env.ABRAIN_ROOT
  ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
  : path.join(os.homedir(), ".abrain");
const STATE_DIR = path.join(ABRAIN_HOME, ".state");
const VAULT_DISABLED_FLAG = path.join(STATE_DIR, "vault-disabled");
const ABRAIN_STARTUP_CONSUMER = "abrain-runtime";
const ABRAIN_LOCAL_SAFETY_KEY = Symbol.for("pi-astack/abrain-local-safety/v1");
const ABRAIN_PROCESS_STATE_KEY = Symbol.for("pi-astack/abrain-process-state/v1");

interface AbrainProcessState {
  startupAutoSyncDone: boolean;
}

function abrainProcessState(): AbrainProcessState {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[ABRAIN_PROCESS_STATE_KEY] as AbrainProcessState | undefined;
  if (existing) return existing;
  const created: AbrainProcessState = { startupAutoSyncDone: false };
  global[ABRAIN_PROCESS_STATE_KEY] = created;
  return created;
}

export interface AbrainLocalSafetyStatus {
  status: "ready" | "blocked";
  abrainHome: string;
  gitignorePath?: string;
  layoutWarnings: readonly string[];
  blockedReason?: string;
}

function abrainLocalSafetyStates(): Map<string, AbrainLocalSafetyStatus> {
  const global = globalThis as Record<symbol, unknown>;
  const existing = global[ABRAIN_LOCAL_SAFETY_KEY];
  if (existing instanceof Map) return existing as Map<string, AbrainLocalSafetyStatus>;
  const created = new Map<string, AbrainLocalSafetyStatus>();
  global[ABRAIN_LOCAL_SAFETY_KEY] = created;
  return created;
}

/** Establish the small local safety envelope synchronously, before pi can
 * expose an interactive writer. Full canonical recovery remains separate. */
export function establishAbrainLocalSafetyPrerequisites(abrainHome = ABRAIN_HOME): AbrainLocalSafetyStatus {
  const resolved = path.resolve(abrainHome);
  try {
    const layout = ensureBrainLayout(resolved);
    const ignored = ensureAbrainStateGitignored(resolved);
    const ready: AbrainLocalSafetyStatus = Object.freeze({
      status: "ready",
      abrainHome: resolved,
      gitignorePath: ignored.path,
      layoutWarnings: Object.freeze(layout.warnings.slice()),
    });
    abrainLocalSafetyStates().set(resolved, ready);
    if (layout.created.length > 0) console.error(`[abrain] brain layout: created ${layout.created.join(", ")}`);
    for (const warning of layout.warnings) console.error(`[abrain] brain layout warning: ${warning}`);
    if (ignored.updated) console.error(`[abrain] added .state/ to ${ignored.path}`);
    return ready;
  } catch (error) {
    const blocked: AbrainLocalSafetyStatus = Object.freeze({
      status: "blocked",
      abrainHome: resolved,
      layoutWarnings: Object.freeze([]),
      blockedReason: error instanceof Error ? error.message : String(error),
    });
    abrainLocalSafetyStates().set(resolved, blocked);
    console.error(`[abrain] local startup safety blocked: ${blocked.blockedReason}`);
    return blocked;
  }
}

export function getAbrainLocalSafetyStatus(abrainHome = ABRAIN_HOME): AbrainLocalSafetyStatus {
  const resolved = path.resolve(abrainHome);
  return abrainLocalSafetyStates().get(resolved) ?? Object.freeze({
    status: "blocked" as const,
    abrainHome: resolved,
    layoutWarnings: Object.freeze([]),
    blockedReason: "local startup safety prerequisites have not run",
  });
}

function assertAbrainLocalWriteSafety(abrainHome = ABRAIN_HOME): void {
  const safety = getAbrainLocalSafetyStatus(abrainHome);
  if (safety.status !== "ready") {
    throw new Error(`abrain local write safety blocked: ${safety.blockedReason ?? "unknown"}`);
  }
}

async function awaitAbrainCanonicalWriteBarrier(abrainHome = ABRAIN_HOME): Promise<void> {
  assertAbrainLocalWriteSafety(abrainHome);
  if (!canonicalGitRuntimeEnabled()) return;
  const startup = await getCanonicalStartupPromise({ abrainHome });
  if (startup.startup !== "ready") {
    throw new Error(startup.blockedReason ?? "canonical startup barrier blocked");
  }
}

// ── Sub-pi enforce constants ────────────────────────────────────────────

const PI_ABRAIN_DISABLED = "PI_ABRAIN_DISABLED";
const PI_STACK_SETTINGS_PATH = path.join(os.homedir(), ".pi", "agent", "pi-astack-settings.json");
const DEFAULT_WINDOWS_VAULT_BASH_PATH = "C:\\Program Files\\Git\\bin\\bash.exe";

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

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(PI_STACK_SETTINGS_PATH, "utf8"));
  } catch (err) {
    if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") return {};
    const message = err instanceof Error ? err.message : String(err);
    console.error(`pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`);
    return {};
  }
}

function resolveWindowsVaultBashPath(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const root = loadPiStackSettings();
  const abrain = root.abrain && typeof root.abrain === "object"
    ? root.abrain as Record<string, unknown>
    : {};
  const configured = abrain.windowsVaultBashPath;
  return typeof configured === "string" && configured.trim()
    ? configured.trim()
    : DEFAULT_WINDOWS_VAULT_BASH_PATH;
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
  on?: (
    event: string,
    handler: (event: any, ctx: { cwd?: string; mode?: CanonicalStartupHostMode; ui?: VaultReleaseUi; signal?: AbortSignal; modelRegistry?: unknown; sessionManager?: unknown }) => Promise<unknown> | unknown,
  ) => void;
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

/**
 * Stable enum values for vault release authorization. These strings
 * are simultaneously:
 *
 *   (1) the choices passed into `askVaultAuthorizationViaDialog` /
 *       `ui.select` / `ui.confirm` fallback,
 *   (2) the values compared against in `authorizeVaultRelease.applyChoice`,
 *   (3) the strings written into the `vault_release` audit lane,
 *   (4) the strings tested against `releaseSessionGrants` /
 *       `releaseRememberDenies` Set membership.
 *
 * ADR 0022 Batch B (f.arch), 2026-05-20: explicitly typed as STABLE
 * ENUM. Display labels for users go through `vaultReleaseDisplayLabel`
 * below (currently identity; (f.copy) housekeeping will fill in real
 * localized labels once translation copy is decided). audit and grant
 * comparison must NEVER use the display label.
 */
export const VAULT_RELEASE_AUTH_CHOICES = ["No", "Deny + remember", "Yes once", "Session"] as const;
export type VaultReleaseChoice = typeof VAULT_RELEASE_AUTH_CHOICES[number];

/**
 * Display label mapper for vault release choices.
 *
 * Identity today: the enum values happen to be English UI text that
 * users see directly. (f.copy) follow-up will replace this with a
 * locale-aware mapper once translation copy is approved. The split
 * exists in the architecture today so the audit-vs-display invariant
 * can be locked down by smoke before any locale-specific copy lands.
 *
 * Callers MUST treat `VAULT_RELEASE_AUTH_CHOICES` strings as opaque
 * enum tags (compare-by-equality, audit-grep-friendly) and use this
 * function for any user-facing surface.
 *
 * ## Contract for future (f.copy) implementations
 *
 * Post-audit 2026-05-20 (DEEPSEEK P2-2/P2-3 + OPUS P2-3 documentation):
 * any non-identity implementation MUST satisfy:
 *
 *   1. **Total function over VaultReleaseChoice**: must return a
 *      non-empty string for EVERY enum value (compile-time enforce
 *      with `switch (choice as VaultReleaseChoice) { case ...:
 *      ... default: const _e: never = choice; throw new Error(...) }`).
 *      A missing case yielding `undefined` would render "undefined
 *      (Recommended)" — not a security bug (the returned answer is
 *      still the enum), but a UX disaster.
 *
 *   2. **Never throws**: PromptDialog's `rebuildLayout` does not wrap
 *      `labelFor` in try/catch (intentional today because identity
 *      cannot throw). A throwing labelFor would crash the dialog —
 *      same caveat as #1. When (f.copy) lands a real mapper, that PR
 *      must also add the rebuildLayout-side guard (or guarantee
 *      total-with-fallback inside the mapper).
 *
 *   3. **Distinct outputs (no collision)**: two different enum values
 *      must NOT map to the same display string. A collision would not
 *      affect security (audit + grant comparison are enum-keyed) but
 *      would leave the user unable to distinguish two visually-identical
 *      options. The translation-copy review must spot-check pairwise.
 *
 *   4. **Pure ASCII not required**: emoji / CJK / RTL are all fine.
 *      The rendering layer (OptionList + pi-tui Text) handles CJK
 *      wrap via cellWidth (`PromptDialog.ts::cellWidth`).
 *
 *   5. **(Recommended) suffix stays English** (until a separate
 *      f.copy pass also localizes it): PromptDialog appends
 *      ' (Recommended)' to the labelFor output verbatim. If (f.copy)
 *      wants to localize the suffix too, it must extend `BuildDialogArgs`
 *      with a `recommendedSuffixLabel?: string` parameter. Documented
 *      here so the f.copy PR scope is explicit.
 */
export function vaultReleaseDisplayLabel(choice: string): string {
  // f.copy: replace identity with a switch over VaultReleaseChoice
  // when localized copy lands. See contract clauses in JSDoc above.
  // Until then, returning `choice` unchanged preserves current
  // behavior exactly.
  return choice;
}

export type AutoCommitStatus = "committed" | "queued" | "clean" | "not_git" | "failed";

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

function gitReadOptions(timeout: number): {
  encoding: "utf8";
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
  timeout: number;
} {
  return {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  };
}

export async function autoCommitPaths(repoRoot: string, relPaths: string[], message: string): Promise<AutoCommitResult> {
  const root = path.resolve(repoRoot);
  const paths = relPaths.map((p) => p.replace(/\\/g, "/")).filter(Boolean);
  if (paths.length === 0) return { repoRoot: root, paths, status: "clean", detail: "no paths" };
  try {
    execFileSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], gitReadOptions(3_000));
  } catch {
    return { repoRoot: root, paths, status: "not_git", detail: "not a git worktree" };
  }
  return withCanonicalMutationBarrier(root, async () => autoCommitPathsUnlocked(root, paths, message));
}

function autoCommitPathsUnlocked(root: string, paths: string[], message: string): AutoCommitResult {
  try {
    execFileSync("git", ["-C", root, "add", "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 });
    let hasStagedChanges = true;
    try {
      execFileSync("git", ["-C", root, "diff", "--cached", "--quiet", "--", ...paths], gitReadOptions(5_000));
      hasStagedChanges = false;
    } catch {
      hasStagedChanges = true;
    }
    if (!hasStagedChanges) return { repoRoot: root, paths, status: "clean", detail: "no changes" };

    execFileSync("git", ["-C", root, "commit", "-m", message, "--", ...paths], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], gitReadOptions(3_000)).trim();
    return { repoRoot: root, paths, status: "committed", commitSha: sha || undefined };
  } catch (err: any) {
    return { repoRoot: root, paths, status: "failed", detail: gitErrorSummary(err) };
  }
}

export async function canonicalAutoCommitAbrainPaths(repoRoot: string, relPaths: string[], message: string): Promise<AutoCommitResult> {
  const root = path.resolve(repoRoot);
  const paths = Array.from(new Set(relPaths.map((item) => item.replace(/\\/g, "/")).filter(Boolean))).sort();
  const receipts = [];
  for (const rel of paths) {
    receipts.push(await createProducedArtifactReceipt({
      abrainHome: root,
      filePath: path.join(root, ...rel.split("/")),
      sourceIds: [`abrain-bind:${rel}`],
    }));
  }
  const runtime = await getCanonicalGitRuntime({ abrainHome: root });
  const startup = await runtime.awaitStartup();
  if (startup.startup !== "ready") return { repoRoot: root, paths, status: "queued", detail: startup.blockedReason ?? "startup barrier blocked" };
  const drained = await runtime.requestDrain(receipts, message);
  if (drained.status === "empty") return { repoRoot: root, paths, status: "clean", commitSha: drained.commit };
  if (drained.status === "metadata_deferred") return { repoRoot: root, paths, status: "clean", detail: drained.reason };
  if (drained.status !== "index_converged" || !drained.commit) return { repoRoot: root, paths, status: "queued", detail: drained.reason ?? drained.status };
  withoutCanonicalMutationBarrierContext(() => {
    void pushAsync({ abrainHome: root });
  });
  return { repoRoot: root, paths, status: "committed", commitSha: drained.commit };
}

function formatAutoCommitResult(label: string, result: AutoCommitResult): string {
  const paths = result.paths.join(", ");
  if (result.status === "committed") return `- ${label}: committed ${result.commitSha?.slice(0, 12) ?? "(unknown sha)"} (${paths})`;
  if (result.status === "queued") return `- ${label}: durable pending (${paths}) - ${result.detail ?? "canonical retry required"}`;
  if (result.status === "clean") return `- ${label}: clean (${paths})`;
  if (result.status === "not_git") return `- ${label}: skipped; not a git worktree (${result.repoRoot})`;
  return `- ${label}: failed (${paths}) — ${result.detail ?? "unknown error"}`;
}

function autoCommitNeedsWarning(result: AutoCommitResult): boolean {
  return result.status === "failed" || result.status === "not_git" || result.status === "queued";
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

interface StartupConstraintShadowRefreshDeps {
  abrainHome?: string;
  cwd?: string;
  activeProject?: ResolveActiveProjectResult | null;
  modelRegistry?: unknown;
  notify?: (msg: string, type?: GitSyncNotifyType) => void;
  resolveSettings?: () => SedimentSettings;
  schedule?: (trigger: {
    abrainHome: string;
    cwd: string;
    activeProjectId?: string;
    knownProjectIds?: string[];
    settings: SedimentSettings;
    modelRegistry?: unknown;
    reason: string;
    sourceEventId?: string;
    sourceEventIds?: readonly string[];
  }) => Promise<{ scheduled: boolean; reason: string }> | { scheduled: boolean; reason: string };
  listProjectIds?: (abrainHome: string) => string[];
}

function isUsableModelRegistry(value: unknown): boolean {
  return !!value
    && typeof value === "object"
    && typeof (value as { find?: unknown }).find === "function"
    && typeof (value as { getApiKeyAndHeaders?: unknown }).getApiKeyAndHeaders === "function";
}

function defaultResolveSedimentSettings(): SedimentSettings {
  // Loaded lazily so smoke fixtures and abrain-only consumers do not pull the
  // sediment compiler graph unless startup sync actually fetched new commits.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../sediment/settings") as { resolveSedimentSettings(): SedimentSettings };
  return mod.resolveSedimentSettings();
}

async function defaultScheduleConstraintShadowAutoRefresh(trigger: Parameters<NonNullable<StartupConstraintShadowRefreshDeps["schedule"]>>[0]): Promise<{ scheduled: boolean; reason: string }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require("../sediment/constraint-compiler/auto-refresh") as {
    scheduleConstraintShadowAutoRefresh(args: typeof trigger): Promise<{ scheduled: boolean; reason: string }>;
  };
  return mod.scheduleConstraintShadowAutoRefresh(trigger);
}

function notifyConstraintShadowRefreshSkip(
  notify: StartupConstraintShadowRefreshDeps["notify"],
  message: string,
  type: GitSyncNotifyType = "warning",
): void {
  if (notify) {
    try { notify(message, type); return; } catch { /* fall through */ }
  }
  console.error(`[abrain] ${message}`);
}

export async function maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(
  event: Pick<GitSyncEvent, "result" | "merged">,
  deps: StartupConstraintShadowRefreshDeps = {},
): Promise<{ scheduled: boolean; reason: string }> {
  const fetchedRemoteCommits = event.result === "ok" && (event.merged ?? 0) > 0;
  if (!fetchedRemoteCommits) return { scheduled: false, reason: "git_sync_no_fetched_updates" };

  const resolveSettings = deps.resolveSettings ?? defaultResolveSedimentSettings;
  let settings: SedimentSettings;
  try {
    settings = resolveSettings();
  } catch (err) {
    notifyConstraintShadowRefreshSkip(
      deps.notify,
      `abrain: constraint shadow refresh skipped after git sync - settings unavailable: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
    return { scheduled: false, reason: "settings_unavailable" };
  }

  const compiler = settings?.constraintShadowCompiler;
  if (!compiler?.enabled) return { scheduled: false, reason: "constraint_shadow_compiler_disabled" };
  if (!compiler?.autoRefresh?.enabled) return { scheduled: false, reason: "auto_refresh_disabled" };

  if (!isUsableModelRegistry(deps.modelRegistry)) {
    notifyConstraintShadowRefreshSkip(
      deps.notify,
      "abrain: constraint shadow refresh skipped after git sync - model registry unavailable",
      "warning",
    );
    return { scheduled: false, reason: "model_registry_unavailable" };
  }

  const abrainHome = deps.abrainHome ?? ABRAIN_HOME;
  const activeProjectId = deps.activeProject?.activeProject?.projectId;
  const listProjectIds = deps.listProjectIds ?? listAbrainProjects;
  const knownProjectIds = Array.from(new Set([
    ...(activeProjectId ? [activeProjectId] : []),
    ...listProjectIds(abrainHome),
  ])).sort();
  const schedule = deps.schedule ?? defaultScheduleConstraintShadowAutoRefresh;

  try {
    return await schedule({
      abrainHome,
      cwd: deps.cwd ?? process.cwd(),
      activeProjectId,
      knownProjectIds,
      settings,
      modelRegistry: deps.modelRegistry,
      reason: "git_sync_fetched",
      sourceEventId: undefined,
    });
  } catch (err) {
    notifyConstraintShadowRefreshSkip(
      deps.notify,
      `abrain: constraint shadow refresh scheduling failed after git sync - ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
    return { scheduled: false, reason: "schedule_failed" };
  }
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

// ADR 0022 housekeeping batch A (b) (2026-05-19): telemetry state. We
// track two flags so the first session_start can decide whether to emit
// a startup_telemetry audit row + ui.notify warning. Conditions are
// (i) the dialog builder failed to load AND (ii) ctx.ui.custom IS
// present — i.e. overlay is the expected UX but we will silently fall
// back to ui.select. If ui.custom is also missing this is a headless
// session, not a degradation, so we stay quiet.
let vaultDialogBuilderInitFailed = false;
let vaultDialogBuilderTelemetrySent = false;

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

/** Test-only: reset telemetry flags between fixtures (batch A (b)). */
export function __resetVaultDialogBuilderTelemetryForTests(): void {
  vaultDialogBuilderInitFailed = false;
  vaultDialogBuilderTelemetrySent = false;
}

/** Test-only: introspect telemetry flag state (batch A (b)). */
export function __peekVaultDialogBuilderTelemetryForTests(): {
  failed: boolean;
  sent: boolean;
} {
  return { failed: vaultDialogBuilderInitFailed, sent: vaultDialogBuilderTelemetrySent };
}

/** Test-only: force-flip the init-failed flag (smoke can simulate pi-tui
 *  load failure without actually breaking the require graph). */
export function __setVaultDialogBuilderInitFailedForTests(v: boolean): void {
  vaultDialogBuilderInitFailed = v;
}

// Module-typed alias for which UI substrate produced a vault decision.
// Mirror of VaultEvent.ui_path in vault-writer.ts; kept narrow so any
// drift between authorizeVault* return shape and the audit field surfaces
// at compile time.
type VaultUiPath = "overlay" | "select" | "confirm" | "cached" | "none";
const vaultBashRuns = new Map<string, VaultBashRunRecord>();

const LocalDynamicBorder: PiTuiBag["DynamicBorder"] = class {
  private readonly paint: (text: string) => string;

  constructor(paint: (text: string) => string = (text) => text) {
    this.paint = paint;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [this.paint("─".repeat(Math.max(1, width)))];
  }
};

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
  // Never create .state audit bytes unless the synchronous .gitignore safety
  // envelope was established. The triggering operation may still fail closed.
  const safety = getAbrainLocalSafetyStatus(ABRAIN_HOME);
  if (safety.status !== "ready") {
    try { process.stderr.write(`abrain vault audit skipped: ${safety.blockedReason ?? "local write safety unavailable"}\n`); } catch {}
    return;
  }
  // Audit failures must never break vault read paths — they're observability,
  // not enforcement. Swallow + best-effort log via stderr if anything throws.
  appendVaultReadAudit(ABRAIN_HOME, ev).catch((err) => {
    try { process.stderr.write(`abrain vault audit append failed: ${err?.message ?? err}\n`); } catch {}
  });
}

function auditReleaseDecision(
  op: VaultEventOp,
  scope: VaultScope,
  key: string,
  extras: { reason?: string; ui_path?: VaultUiPath } = {},
): void {
  safeAuditAppend({
    ts: new Date().toISOString(),
    op,
    scope: scopeAuditLabel(scope),
    key,
    lane: "vault_release",
    ...(extras.reason ? { reason: extras.reason } : {}),
    // ADR 0022 housekeeping batch A (g): omit when undefined so existing
    // jsonl rows stay byte-identical when caller doesn’t supply ui_path
    // (e.g. pre-authorize fast-fails like key_not_found).
    ...(extras.ui_path ? { ui_path: extras.ui_path } : {}),
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

function auditBashOutput(
  op: "bash_output_release" | "bash_output_withhold",
  record: VaultBashRunRecord,
  ui_path?: VaultUiPath,
): void {
  if (record.releases.length === 0) return;
  const firstScope = record.releases[0]!.scope;
  safeAuditAppend({
    ts: new Date().toISOString(),
    op,
    scope: scopeAuditLabel(firstScope),
    lane: "bash_output",
    keys: record.releases.map((r) => authKey(r.scope, r.key)),
    command_preview: record.originalCommand ? truncateForPrompt(record.originalCommand, 240) : undefined,
    // ADR 0022 housekeeping batch A (g): ui_path metadata. Omitted when
    // caller does not supply (e.g. the fail-closed outer try/catch in
    // tool_result handler that runs WITHOUT going through
    // authorizeVaultBashOutput — we genuinely don't know which UI path
    // would have been taken there).
    ...(ui_path ? { ui_path } : {}),
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

// ADR 0022 housekeeping batch A (g) (2026-05-19): return type carries
// ui_path so the caller can stamp the audit row with which substrate
// produced the decision. Pre-fix callers wrote audit rows with no way
// to distinguish PromptDialog overlay outcomes from ui.select fallback
// outcomes, making `reason:"cancelled"` ambiguous in postmortems.
type BashOutputAuthOutcome = {
  decision: "release" | "withhold";
  ui_path: VaultUiPath;
};

async function authorizeVaultBashOutput(
  ui: VaultReleaseUi | undefined,
  record: VaultBashRunRecord,
  signal: AbortSignal | undefined,
  hostCtx: unknown,
): Promise<BashOutputAuthOutcome> {
  if (bashOutputSessionGrants.has(record.grantKey)) return { decision: "release", ui_path: "cached" };
  if (!ui) return { decision: "withhold", ui_path: "none" };
  const descriptions = collectReleaseDescriptions(record.releases);
  const englishTitle = formatBashAuthorizationTitle(record, descriptions);
  const title = await localizePrompt(englishTitle, hostCtx);
  // Also push the full context into the message stream so it survives any TUI
  // truncation of the select title.
  ui.notify?.(title, "warning");

  const keyList = record.releases.map((r) => `${scopeLabel(r.scope)}:${r.key}`).join(", ");
  // ADR 0022 housekeeping batch A (g): ui_path is bound by the caller of
  // applyChoice (overlay vs select), not by the choice itself.
  const applyChoice = (
    choice: string | undefined,
    ui_path: VaultUiPath,
  ): BashOutputAuthOutcome => {
    if (choice === "Yes once") return { decision: "release", ui_path };
    if (choice === "Session") {
      bashOutputSessionGrants.add(record.grantKey);
      return { decision: "release", ui_path };
    }
    ui.notify?.(`Withheld bash output that used vault key(s): ${keyList}`, "warning");
    return { decision: "withhold", ui_path };
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
      // ADR 0022 Batch B (f.arch), 2026-05-20: identity today; (f.copy)
      // follow-up swaps in a locale-aware mapper. Audit always logs
      // the raw enum from `choices`, not the display label.
      labelFor: vaultBashOutputDisplayLabel,
      signal,
      buildDialog: cachedVaultDialogBuilder,
    });
    if (r.ok) return applyChoice(r.choice, "overlay");
    if (r.reason === "cancelled") {
      ui.notify?.(`Withheld bash output that used vault key(s): ${keyList}`, "warning");
      return { decision: "withhold", ui_path: "overlay" };
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
      return applyChoice(choice, "select");
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      ui.notify?.(`Withheld bash output: ui.select failed: ${message.slice(0, 200)}`, "warning");
      return { decision: "withhold", ui_path: "select" };
    }
  }
  ui.notify?.(`Withheld bash output that used vault key(s): ${keyList}`, "warning");
  return { decision: "withhold", ui_path: "none" };
}

// ADR 0022 housekeeping batch A (g) (2026-05-19): return type carries
// ui_path. Mirrors BashOutputAuthOutcome above.
type ReleaseAuthOutcome =
  | { ok: true; ui_path: VaultUiPath }
  | { ok: false; reason: string; ui_path: VaultUiPath };

async function authorizeVaultRelease(
  ui: VaultReleaseUi | undefined,
  scope: VaultScope,
  key: string,
  reason: string | undefined,
  signal: AbortSignal | undefined,
  hostCtx: unknown,
): Promise<ReleaseAuthOutcome> {
  const gate = authKey(scope, key);
  if (releaseRememberDenies.has(gate))
    return { ok: false, reason: "denied_remembered", ui_path: "cached" };
  if (releaseSessionGrants.has(gate)) return { ok: true, ui_path: "cached" };
  if (!ui) return { ok: false, reason: "ui_unavailable", ui_path: "none" };

  const description = readReleaseDescription(scope, key);
  const englishTitle = formatReleaseAuthorizationTitle(scope, key, reason, description);
  const title = await localizePrompt(englishTitle, hostCtx);
  // Mirror the full context into the message stream so the user always sees
  // what is about to be released, even if the TUI select clips long titles.
  ui.notify?.(title, "warning");

  // ADR 0022 housekeeping batch A (g): ui_path bound by caller (overlay vs
  // select vs confirm). applyChoice stays a pure choice-→-outcome mapping.
  const applyChoice = (
    choice: string | undefined,
    ui_path: VaultUiPath,
  ): ReleaseAuthOutcome => {
    if (choice === "Yes once") return { ok: true, ui_path };
    if (choice === "Session") {
      releaseSessionGrants.add(gate);
      return { ok: true, ui_path };
    }
    if (choice === "Deny + remember") releaseRememberDenies.add(gate);
    return { ok: false, reason: vaultReleaseChoiceReason(choice), ui_path };
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
      // ADR 0022 Batch B (f.arch), 2026-05-20: identity today; (f.copy)
      // follow-up swaps in a locale-aware mapper. Audit always logs
      // the raw enum from `choices`, not the display label.
      labelFor: vaultReleaseDisplayLabel,
      signal,
      buildDialog: cachedVaultDialogBuilder,
    });
    if (r.ok) return applyChoice(r.choice, "overlay");
    if (r.reason === "cancelled") return { ok: false, reason: "cancelled", ui_path: "overlay" };
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
      return applyChoice(choice, "select");
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      ui.notify?.(`vault_release denied: ui.select failed: ${message.slice(0, 200)}`, "warning");
      return { ok: false, reason: "ui_authorization_error", ui_path: "select" };
    }
  }

  if (typeof ui.confirm === "function") {
    try {
      const ok = await ui.confirm("Vault release authorization", title, { signal });
      return ok
        ? { ok: true, ui_path: "confirm" }
        : { ok: false, reason: "denied", ui_path: "confirm" };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      ui.notify?.(`vault_release denied: ui.confirm failed: ${message.slice(0, 200)}`, "warning");
      return { ok: false, reason: "ui_authorization_error", ui_path: "confirm" };
    }
  }

  ui.notify?.("vault_release denied: no UI authorization method available", "warning");
  return { ok: false, reason: "ui_authorization_unavailable", ui_path: "none" };
}

// ── ADR 0022 housekeeping batch A subgroup 2 post-audit refactor ──
// (2026-05-19, 3-way T0 reviewer unanimous consensus: OPUS-4-7 +
// GPT-5.5 + DEEPSEEK-V4-pro xhigh)
//
// Subgroup 1's P0 lived in the tool_result handler body where it
// compared an outcome object against the string "release" (always
// true — every vault bash output silently withheld). Subgroup 2's
// stage-index smoke as-written calls `authorizeVaultBashOutput`
// DIRECTLY via the helper, NOT through the listener — so the
// regression site was still uncovered. All three T0 reviewers (P0 of
// 912d5f0) independently flagged this. This refactor extracts the
// listener body into a module-level async function the smoke can
// invoke end-to-end via __handleVaultBashToolResultForTests after
// seeding a synthetic vaultBashRuns record with
// __seedVaultBashRunForTests. The runtime listener delegates to this
// function; behaviour is byte-identical.
async function processVaultBashToolResult(
  event: { toolName?: string; toolCallId?: string; content?: unknown; details?: Record<string, unknown>; input?: { command?: string } },
  ctx: { ui?: VaultReleaseUi; signal?: AbortSignal },
): Promise<{ content?: unknown; details?: unknown } | undefined> {
  // ── Vault bash output authorization guard ─────────────────
  // Outer try/catch: if authorizeVaultBashOutput or redaction
  // throws, we fail-CLOSED — withhold the bash output rather than
  // releasing raw vault-touched data to LLM context. Audit row
  // records the failure for forensic diagnosis. (Changed from
  // fail-open in R6 audit, 2026-05-14.)
  if (event.toolName !== "bash") return;
  // ADR 0022 batch C (2026-05-19): hoist `record` to outer scope so
  // the outer catch can audit it. The previous structure read+deleted
  // record INSIDE the try block, then re-fetched inside the catch —
  // but the delete had already run when authorizeVaultBashOutput threw,
  // so the catch's `.get()` returned undefined and the fallback audit
  // path was unreachable. DEEPSEEK third-audit P2-2 (initial vacuous-
  // true detection) + OPUS P1-5 (outcome hoist intent) both prompted
  // this restructure.
  const record = vaultBashRuns.get(event.toolCallId!);
  if (!record) return;
  vaultBashRuns.delete(event.toolCallId!);
  try { fs.rmSync(record.envFile, { force: true }); } catch {}
  try {

    // ADR 0022 housekeeping batch A subgroup 1 post-audit fix
    // (2026-05-19, OPUS-4-7 + DEEPSEEK-V4-pro xhigh consensus P0):
    // authorizeVaultBashOutput returns { decision, ui_path }. The
    // original `decision !== "release"` comparison was object-vs-string,
    // ALWAYS true — every vault bash output silently withheld, and
    // every `bash_output_release` audit row misclassified. Renamed
    // local to `outcome` so `.decision` visually forces destructure.
    const outcome = await authorizeVaultBashOutput(ctx.ui, record, ctx.signal, ctx);
    if (outcome.decision !== "release") {
      auditBashOutput("bash_output_withhold", record, outcome.ui_path);
      return {
        content: withheldVaultBashContent(record),
        details: { ...(event.details ?? {}), vault: { outputWithheld: true, keys: record.releases.map((r) => authKey(r.scope, r.key)) } },
      };
    }
    auditBashOutput("bash_output_release", record, outcome.ui_path);
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
    //
    // ADR 0022 housekeeping batch A (g): this withhold happened
    // BEFORE / OUTSIDE authorizeVaultBashOutput (the outer try threw
    // somewhere in redaction / authorize / record bookkeeping), so we
    // genuinely don't know which UI path would have been taken. Leave
    // ui_path unset rather than guessing — the absence of ui_path on
    // this row is itself a diagnostic signal ("never made it to UI").
    // ADR 0022 batch C (2026-05-19): DEEPSEEK third-audit P2-1 defense
    // in depth. Previously, if `record.releases` was corrupted (e.g.
    // outer try threw because releases was a non-array), the inner
    // `auditBashOutput` itself would re-throw on `.releases.map(...)`
    // and the outer `catch { /* best-effort */ }` would silently
    // swallow it. Result: NO audit row at all for the outer-envelope
    // fail-closed path. Operator forensic trail vanished exactly when
    // most needed. Now: try the structured audit; on failure write a
    // minimal fallback row via safeAuditAppend directly so the row
    // still exists in vault-events.jsonl, just with degraded keys/
    // description fidelity. The fallback row carries the op so it can
    // be grep'd, plus a `reason` describing the cascade.
    // ADR 0022 batch C (2026-05-19): record already hoisted to outer
    // scope, so we don't re-fetch (the delete inside the try ran
    // before the throw — .get() would return undefined here).
    try {
      auditBashOutput("bash_output_withhold", record);
    } catch (auditErr) {
      // Structured audit failed (record.releases corrupted or
      // similar). Write a minimal fallback row so the forensic
      // trail is preserved.
      // ADR 0022 batch C post-audit (2026-05-19, 3-way OPUS+GPT+DEEPSEEK
      // unanimous P1): be honest about scope. Hardcoding scope:"global"
      // misled audit grep (project-scoped bash output failures looked like
      // global ones). Try to recover a real scope from record.releases[0],
      // fall back to scope:"(unknown)" only when even that read throws.
      // Use `keys` (plural) to match the schema of healthy bash_output
      // rows (which set keys: record.releases.map(...)). The placeholder
      // "(unreadable)" sits inside the array so downstream consumers
      // grepping `jq 'select(.keys[] | startswith("global:"))'` don't
      // false-positive match this row.
      let derivedScope: string = "(unknown)";
      try {
        const first = Array.isArray((record as { releases?: unknown }).releases)
          ? ((record as { releases: ReleaseSecretResult[] }).releases[0] as ReleaseSecretResult | undefined)
          : undefined;
        if (first?.scope) {
          derivedScope = scopeAuditLabel(first.scope);
        }
      } catch { /* keep "(unknown)" */ }
      safeAuditAppend({
        ts: new Date().toISOString(),
        op: "bash_output_withhold",
        scope: derivedScope,
        lane: "bash_output",
        keys: ["(unreadable)"],
        reason: `outer_catch_audit_failed:${(auditErr as Error)?.message ?? "unknown"}`.slice(0, 200),
      });
    }
    return {
      content: [{ type: "text", text: `[vault] bash output withheld — authorization/redaction error: ${message.slice(0, 300)}` }],
      details: { ...(event.details ?? {}), vault: { outputWithheld: true, reason: "authorization_error" } },
    };
  }
}

// Export so smoke can invoke + INV-E identity asserts can run against
// the real function (not a copy). These are file-internal helpers; the
// LLM-facing surface remains the registered `vault_release` tool +
// bash output guard.
export {
  authorizeVaultRelease as __authorizeVaultReleaseForTests,
  authorizeVaultBashOutput as __authorizeVaultBashOutputForTests,
  processVaultBashToolResult as __handleVaultBashToolResultForTests,
};

// ADR 0022 batch C (2026-05-19): env gate for plaintext-bearing
// test-only mutators. GPT-5.5 P1#2 (third audit round): even though
// the LLM has no `require()` tool today, `__seedVaultBashRunForTests`
// + `__clearVaultBashRunsForTests` accept a plaintext-bearing
// VaultBashRunRecord and write into the live vaultBashRuns map. Any
// future co-loaded extension or debug shim that does `require("abrain")`
// would gain plaintext-write access via the *ForTests naming — the
// suffix is documentation, not a mechanism boundary. We gate on
// PI_ASTACK_ENABLE_TEST_HOOKS=1 so smoke fixtures explicitly opt in;
// production processes never set this env var, so the export becomes
// a noisy throw rather than a silent footgun. The gate is NOT applied
// to read-only test helpers (authorizeVaultRelease* / *DialogBuilder*
// telemetry peek) because those have no plaintext-injection capability.
function assertTestHooksEnabled(name: string): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new Error(
      `${name}() is a plaintext-bearing test-only mutator; set ` +
        "PI_ASTACK_ENABLE_TEST_HOOKS=1 in the smoke harness to enable. " +
        "This guard is defense-in-depth against a future co-loaded extension " +
        "calling the export by accident.",
    );
  }
}

/** Test-only: inject a synthetic vault bash run record so smoke can
 *  drive processVaultBashToolResult without going through the
 *  prepareBootVaultBashCommand tool_call path. Used by
 *  smoke:abrain-vault-grant-isolation (Batch A subgroup 2 post-audit). */
export function __seedVaultBashRunForTests(
  toolCallId: string,
  record: VaultBashRunRecord,
): void {
  assertTestHooksEnabled("__seedVaultBashRunForTests");
  vaultBashRuns.set(toolCallId, record);
}

/** Test-only: drain the vaultBashRuns map (for hermetic smoke fixtures). */
export function __clearVaultBashRunsForTests(): void {
  assertTestHooksEnabled("__clearVaultBashRunsForTests");
  vaultBashRuns.clear();
}

export default function activate(pi: ExtensionAPI): void {
  // ── Sub-pi enforce: vault-bootstrap.md §5 layer (b) ───────────────────
  // If PI_ABRAIN_DISABLED=1, register nothing. Sub-pi sees no /vault
  // command, no abrain tool, nothing — this is the runtime invariant
  // backing ADR 0014 invariant #6 layer 2. The dispatch extension
  // (extensions/dispatch/index.ts) sets this env var when spawning
  // sub-pi; the `smoke:vault-subpi-isolation` smoke verifies that.
  if (process.env[PI_ABRAIN_DISABLED] === "1") return;
  // Resolve once at activation. Invalid/missing/unreadable canonical settings
  // abort every abrain startup/bind/sync writer path instead of selecting legacy.
  const canonicalModeEnabled = canonicalGitRuntimeEnabled();
  // This is intentionally synchronous and bounded. Vault and audit writers
  // can become callable as soon as activate() returns, before Path A recovery.
  const localSafety = establishAbrainLocalSafetyPrerequisites(ABRAIN_HOME);

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
  if (localSafety.status === "ready") {
    reconcile(ABRAIN_HOME)
      .then(({ recovered, scanned }) => {
        if (recovered > 0) {
          console.error(`[abrain] reconcile: recovered ${recovered} missing audit rows (${scanned} files scanned)`);
        }
      })
      .catch((err) => {
        console.error(`[abrain] reconcile failed:`, err);
      });
  }

  // ── Startup device sync (ADR 0020) ──────────────────────────
  // Fire-and-forget device delivery runs fetch -> deterministic device join
  // -> exact-OID push. Content conflicts and delivery failures are user-visible
  // warnings, while network/auth failures never gate local canonical startup.
  //
  // Startup sync used to emit `console.
  // error(...)` lines, which is the raw stderr path — ugly and
  // intercalated with pi's TUI rendering. Sediment uses `ctx.ui.notify`
  // (which the pi TUI styles per `type` and integrates with the chat
  // stream); abrain should too. But `activate(pi)` has no ctx — we get
  // ctx only inside an event handler. The `session_start` listener refreshes
  // the process-global reporter and
  // process-stable modelRegistry/cwd snapshot. Detached completion resolves the
  // latest reporter after /new, /resume, or /reload, with stderr fallback.
  //
  // runStartupAutoSync is invoked at session_start after activate() finishes,
  // so the `.state/` gitignore guard has already run.
  const runStartupAutoSync = (args: {
    modelRegistry?: unknown;
    cwd?: string;
  } = {}): void => {
    const processState = abrainProcessState();
    if (processState.startupAutoSyncDone) return;
    processState.startupAutoSyncDone = true;
    if (process.env.PI_ABRAIN_NO_AUTOSYNC === "1") return;

    // Resolve the reporter at delivery time. A captured ctx.ui becomes stale
    // across /new, /resume, and /reload while this detached sync is running.
    const announce = (msg: string, type: GitSyncNotifyType = "info"): void => {
      reportCanonicalStartupConsumer({
        runtime: { abrainHome: ABRAIN_HOME },
        consumerId: ABRAIN_STARTUP_CONSUMER,
        message: msg,
        type,
      });
    };

    gitSync({ abrainHome: ABRAIN_HOME })
      .then(async (result) => {
        const fetchEvents = result.events.filter((event) => event.op === "fetch");
        const fetchEvent = fetchEvents.at(-1);
        const convergedFetch = fetchEvents.slice().reverse().find((event) => event.result === "ok" && (event.merged ?? 0) > 0);
        const refreshEvent = convergedFetch ?? fetchEvent;
        if (refreshEvent) {
          await maybeScheduleConstraintShadowAutoRefreshAfterStartupGitSync(refreshEvent, {
            abrainHome: ABRAIN_HOME,
            cwd: args.cwd,
            activeProject: bootActiveProject,
            modelRegistry: args.modelRegistry,
            notify: announce,
          });
        }

        if (convergedFetch) {
          announce(`abrain: converged ${convergedFetch.merged} commit(s) from the configured upstream`, "info");
        } else if (fetchEvent?.result === "conflict") {
          announce(`abrain: deterministic device join blocked by a real content conflict - ${fetchEvent.error || "typed conflict"}. Canonical mutation remains fail-closed.`, "warning");
        } else if (fetchEvent && fetchEvent.result !== "ok" && fetchEvent.result !== "noop" && fetchEvent.result !== "skipped") {
          announce(`abrain: device fetch/join ${fetchEvent.result} - ${fetchEvent.error || "unknown"}. Startup continues; convergence will retry later.`, "warning");
        }

        const pushEvent = result.events.filter((event) => event.op === "push").at(-1);
        if (pushEvent && pushEvent.result !== "ok" && pushEvent.result !== "noop" && pushEvent.result !== "skipped") {
          announce(`abrain: device push ${pushEvent.result} - ${pushEvent.error || "unknown"}. Local startup remains available; use /abrain sync to retry.`, "warning");
        }
      })
      .catch((err) => {
        announce(`abrain: device sync threw unexpectedly - ${err && (err as Error).message ? (err as Error).message : String(err)}`, "error");
      });
  };

  let runtimeInitializationDone = false;
  const initializeAbrainRuntimeAfterBarrier = (): void => {
    if (runtimeInitializationDone || getAbrainLocalSafetyStatus(ABRAIN_HOME).status !== "ready") return;
    runtimeInitializationDone = true;
    try {
      const cleanup = cleanupLegacyAdr0039PrePushHook(ABRAIN_HOME);
      if (cleanup.removed) console.error(`[abrain] removed exact pi-owned legacy ADR0039 pre-push hook`);
      else if (cleanup.warning) console.warn(`[abrain] ${cleanup.warning}`);
    } catch (err: any) {
      // Defense in depth: the helper is fail-soft, and this migration must
      // never become a canonical or local startup gate.
      console.warn(`[abrain] legacy ADR0039 hook cleanup failed (non-fatal): ${err?.message ?? err}`);
    }
  };
  if (!canonicalModeEnabled && localSafety.status === "ready") initializeAbrainRuntimeAfterBarrier();

  // NOTE: startup git sync runs in the session_start event handler
  // below (not here at activate() time) so we can capture ctx.ui.notify
  // and surface results via pi's TUI instead of raw stderr. See the
  // comment block on runStartupAutoSync above for rationale.

  // ADR 0023-R5: read-only rules injection. Loaded from abrain so it shares
  // the same PI_ABRAIN_DISABLED sub-pi boundary and strict project binding.
  // This registers /rule diagnostic pull commands but no rule write/veto UI.
  //
  // Compiled-view repair bridge: when the rule-injector detects a broken
  // compiled view, it calls the constraint shadow auto-refresh scheduler. The
  // modelRegistry is captured lazily from session_start (not available at
  // activation time).
  let capturedModelRegistry: unknown = undefined;
  let capturedCwd: string = process.cwd();
  let pendingSelfHealTrigger: RuleInjectorSelfHealTrigger | undefined;
  let selfHealTimer: ReturnType<typeof setTimeout> | undefined;
  let canonicalBarrierReady = !canonicalModeEnabled;
  const queueSelfHealFlush = (): void => {
    if (!canonicalBarrierReady || selfHealTimer) return;
    selfHealTimer = setTimeout(() => {
      selfHealTimer = undefined;
      const next = pendingSelfHealTrigger;
      if (!next) return;
      if (!isUsableModelRegistry(capturedModelRegistry)) return;
      pendingSelfHealTrigger = undefined;
      try {
        const settings = defaultResolveSedimentSettings();
        if (!settings.constraintShadowCompiler?.enabled || !settings.constraintShadowCompiler?.autoRefresh?.enabled) return;
        const abrainHome = next.abrainHome;
        const activeProjectId = next.activeProjectId;
        const knownProjectIds = Array.from(new Set([
          ...(activeProjectId ? [activeProjectId] : []),
          ...listAbrainProjects(abrainHome),
        ])).sort();
        defaultScheduleConstraintShadowAutoRefresh({
          abrainHome,
          cwd: next.cwd || capturedCwd,
          activeProjectId,
          knownProjectIds,
          settings,
          modelRegistry: capturedModelRegistry,
          reason: next.reason,
          sourceEventId: undefined,
        });
      } catch {
        // Compiled-view refresh is best-effort; startup and rule injection continue.
      }
    }, 0);
    (selfHealTimer as unknown as { unref?: () => void }).unref?.();
  };
  setRuleInjectorSelfHealScheduler((trigger: RuleInjectorSelfHealTrigger) => {
    pendingSelfHealTrigger = trigger;
    queueSelfHealFlush();
  });
  activateRuleInjector(pi);

  const registry = pi as unknown as CommandRegistry;
  const toolRegistry = pi as unknown as ToolRegistry;
  const eventRegistry = pi as unknown as EventRegistry;
  const vaultBashShellPath = resolveWindowsVaultBashPath();

  if (typeof eventRegistry.on === "function") {
    // Startup git sync trigger (Round 5 UX fix, 2026-05-17). We refresh
    // the current reporter plus process-stable modelRegistry/cwd at handler
    // entry. The process-global guard ensures this runs exactly once even
    // when /reload creates a new module instance and session_start fires for
    // every new session / fork / restart. Headless mode falls back
    // to console.error inside announce(). Never throws to pi runtime.
    eventRegistry.on("session_start", async (_event, ctx) => {
      try {
        if (isSubAgentSession(ctx as unknown as { sessionManager?: unknown })) return;
        // Capture only process-stable values. The shared reporter is replaced on
        // every /new, /resume, and /reload; no continuation closes over ctx.ui.
        if (ctx?.modelRegistry) capturedModelRegistry = ctx.modelRegistry;
        if (ctx?.cwd) capturedCwd = ctx.cwd;
        const notify = ctx?.ui?.notify?.bind(ctx.ui);
        const runtime = { abrainHome: ABRAIN_HOME };
        const currentSafety = getAbrainLocalSafetyStatus(ABRAIN_HOME);
        setCanonicalStartupReporter({ runtime, consumerId: ABRAIN_STARTUP_CONSUMER, reporter: notify });
        if (currentSafety.status !== "ready") {
          reportCanonicalStartupConsumer({
            runtime,
            consumerId: ABRAIN_STARTUP_CONSUMER,
            message: `abrain local startup safety blocked: ${currentSafety.blockedReason ?? "unknown"}`,
            type: "error",
          });
        }
        if (canonicalModeEnabled) {
          await scheduleCanonicalStartupConsumer({
            runtime,
            consumerId: ABRAIN_STARTUP_CONSUMER,
            mode: ctx?.mode,
            reporter: notify,
            blockedMessage: (startup) => `abrain canonical startup blocked: ${startup.blockedReason ?? "unknown"}`,
            errorMessage: (error) => `abrain canonical startup continuation threw: ${error instanceof Error ? error.message : String(error)}`,
            onReady: () => {
              if (getAbrainLocalSafetyStatus(ABRAIN_HOME).status !== "ready") return;
              canonicalBarrierReady = true;
              initializeAbrainRuntimeAfterBarrier();
              queueSelfHealFlush();
              // Device delivery remains advisory and follows full Path A proof.
              runStartupAutoSync({ modelRegistry: capturedModelRegistry, cwd: capturedCwd });
            },
          });
        } else if (currentSafety.status === "ready") {
          queueSelfHealFlush();
          runStartupAutoSync({ modelRegistry: capturedModelRegistry, cwd: capturedCwd });
        }
      } catch (err) {
        // Defensive: never let our sync trigger break the session.
        reportCanonicalStartupConsumer({
          runtime: { abrainHome: ABRAIN_HOME },
          consumerId: ABRAIN_STARTUP_CONSUMER,
          message: `abrain session_start trigger threw: ${err instanceof Error ? err.message : String(err)}`,
          type: "error",
        });
      }
      // ADR 0022 housekeeping batch A (b) (2026-05-19): vault dialog
      // builder telemetry. If activate() detected that pi-tui /
      // makeBuildDialog failed AND this session has a working ctx.ui.custom,
      // overlay was expected but vault auth will silently fall back to
      // ui.select. Emit ONE audit row + ui.notify warning so operators
      // can detect the degradation (otherwise it shows up only as a
      // subtle UX difference — line-based prompt vs. boxed overlay).
      //
      // Why session_start (not activate): activate() runs before any
      // ctx exists; we need ctx.ui to know whether ui.custom is
      // present. session_start is the first hook with ctx and runs
      // once per session. We guard with vaultDialogBuilderTelemetrySent
      // so refresh / fork / reactivate cycles don’t double-emit.
      try {
        const hasUiCustom = typeof (ctx as any)?.ui?.custom === "function";
        if (
          vaultDialogBuilderInitFailed &&
          hasUiCustom &&
          !vaultDialogBuilderTelemetrySent
        ) {
          vaultDialogBuilderTelemetrySent = true;
          safeAuditAppend({
            ts: new Date().toISOString(),
            op: "startup_telemetry",
            scope: "global",
            lane: "vault_substrate",
            reason: "dialog_builder_unavailable",
            ui_path: "select",
          });
          try {
            (ctx as any)?.ui?.notify?.(
              "vault: PromptDialog overlay failed to load (pi-tui missing or makeBuildDialog threw); " +
                "vault authorization will use ui.select fallback. See vault-events.jsonl op=startup_telemetry.",
              "warning",
            );
          } catch { /* notify is best-effort */ }
        }
      } catch (err) {
        // Telemetry failures must never break the session.
        try {
          process.stderr.write(
            `[abrain] vault dialog builder telemetry threw: ${(err as Error)?.message ?? err}\n`,
          );
        } catch {}
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
      // Sub-pi isolation (ADR 0014 §6 layer (b), v3 in-process): a
      // dispatch-spawned sub-agent must have ZERO vault reach. v2 enforced
      // this via PI_ABRAIN_DISABLED=1 in the spawn env; v3 runs in-process so
      // that env never flips. Self-gate here (same pattern as sediment /
      // model-fallback / rule-injector) so the parent's $VAULT_/$PVAULT_/
      // $GVAULT_ secrets are never injected into a sub-agent's bash. Behaviour
      // matches the old "abrain not registered" path: $VAULT_* stays an unset
      // shell var (expands empty). Guarded by smoke:vault-subpi-isolation.
      if (isSubAgentSession(ctx as unknown as { sessionManager?: unknown })) return;
      // ── Vault bash injection guard ───────────────────────────
      // Outer try/catch: if prepareBootVaultBashCommand throws for any
      // unexpected reason (malformed command, env-file write failure,
      // etc.), we MUST NOT silently pass the command through without
      // secret injection — that would leak cleartext into LLM context.
      try {
        if (event.toolName !== "bash") return;
        const command = String(event.input?.command ?? "");
        const activeProjectId = bootActiveProject?.activeProject?.projectId ?? null;
        const prepared = await prepareBootVaultBashCommand(command, {
          abrainHome: ABRAIN_HOME,
          stateDir: STATE_DIR,
          activeProjectId,
          shellPath: vaultBashShellPath,
          env: process.env,
        });
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

    // ADR 0022 housekeeping batch A subgroup 2 post-audit (2026-05-19,
    // 3-way T0 reviewer consensus): listener body extracted to
    // module-level `processVaultBashToolResult` so smoke can drive it
    // end-to-end via __handleVaultBashToolResultForTests. Runtime
    // behavior is byte-identical — listener now is a thin delegator.
    eventRegistry.on("tool_result", async (event, ctx) => {
      // Sub-pi isolation: mirror the tool_call guard so a sub-agent's bash
      // output never reaches abrain's vault authorization / redaction path.
      if (isSubAgentSession(ctx as unknown as { sessionManager?: unknown })) return;
      return processVaultBashToolResult(event as any, ctx as any);
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
        try { assertAbrainLocalWriteSafety(); }
        catch (error) {
          return toolJson({ ok: false, error: error instanceof Error ? error.message : String(error) });
        }
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
          // ADR 0022 housekeeping batch A (g): stamp the audit row with
          // the ui_path the deny came from. Lets ops distinguish a
          // cancelled overlay (Esc / abort) from a cancelled ui.select.
          auditReleaseDecision("release_denied", scope, key, { reason: auth.reason, ui_path: auth.ui_path });
          return toolJson({ ok: false, key, scope, denied: true, reason: auth.reason });
        }

        try {
          const released = await releaseSecret({ abrainHome: ABRAIN_HOME, scope, key });
          auditReleaseDecision("release", scope, key, { ui_path: auth.ui_path });
          return toolJson({
            ok: true,
            key,
            scope,
            value: released.value,
            placeholder: released.placeholder,
            warning: "Plaintext is now in model context. Redaction is best-effort and does not cover encoded/transformed values.",
          });
        } catch (err: any) {
          // release_error happens AFTER authorization, so the ui_path the
          // user took to grant is still meaningful for postmortems.
          auditReleaseDecision("release_blocked", scope, key, {
            reason: `release_error: ${err?.message ?? "unknown"}`,
            ui_path: auth.ui_path,
          });
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
      // DynamicBorder is supplied locally because pi-coding-agent's root
      // export is ESM-only in current builds while this lazy loader runs
      // through CommonJS `require()` after jiti transpilation.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const tuiModule = require("@earendil-works/pi-tui");
      pitui = {
        Container: tuiModule.Container,
        Text: tuiModule.Text,
        Input: tuiModule.Input,
        SelectList: tuiModule.SelectList,
        DynamicBorder: LocalDynamicBorder,
        // R6.3 (2026-05-17): 加入 Spacer。PromptDialog 需要真正的空行间距 —
        // pi-tui Text 对 "" / "   " 走「不渲染」路径，以前用 Text("")
        // 当 spacer 一直是 0 行 (所以用户看到拥挤)。Spacer(1) 才是可靠间距。
        Spacer: tuiModule.Spacer,
      };
    } catch (err) {
      // pi-tui not available in this process — OK, prompt_user will
      // gracefully reject with ui-unavailable when called.
      // ADR 0022 housekeeping batch A (b) (2026-05-19): record this
      // failure so the first session_start with a real ctx.ui.custom
      // can emit ONE startup_telemetry row + ui.notify warning. We
      // can't emit here because activate() doesn't see ctx.ui yet.
      vaultDialogBuilderInitFailed = true;
      void err;
    }

    // ADR 0022 P3b: cache the dialog builder so authorizeVaultRelease /
    // authorizeVaultBashOutput (top-level functions defined earlier in
    // this file) can use the same PromptDialog substrate. activate() is
    // synchronous; the cache is written here BEFORE the first
    // vault_release tool invocation can run (tool callbacks fire on
    // user actions which happen after activate returns).
    //
    // ADR 0022 housekeeping batch A (b) (2026-05-19): makeBuildDialog
    // can also throw (e.g. pitui surface present but a member is
    // undefined). Wrap so the failure is detected + telemetrized
    // instead of crashing extension activation.
    if (pitui) {
      try {
        cachedVaultDialogBuilder = promptDialogModule.makeBuildDialog(pitui);
        // ADR 0022 housekeeping batch A subgroup 1 post-audit fix
        // (2026-05-19, OPUS-4-7 xhigh P1-1): clear the flag on success
        // so an extension hot-reload / deactivate-reactivate cycle
        // where pi-tui was unavailable last time but is available now
        // does NOT emit a false telemetry row on the next session_start.
        // The flag is the source of truth for "is overlay broken right
        // now"; after a successful re-init, the truth is "no".
        vaultDialogBuilderInitFailed = false;
      } catch (err) {
        cachedVaultDialogBuilder = null;
        vaultDialogBuilderInitFailed = true;
        try {
          process.stderr.write(
            `[abrain] makeBuildDialog failed during activate(); vault auth will fall back to ui.select: ${(err as Error)?.message ?? err}\n`,
          );
        } catch {}
      }
    } else {
      // pitui never assigned — catch above also set the flag, but be
      // explicit so the invariant is local to this block.
      vaultDialogBuilderInitFailed = true;
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
        "prompt_user({ reason, questions: [{ id, header, question, type, options? }] })",
      promptGuidelines: [
        // R7.2 (2026-05-17): 以下 guideline 随 schema 简化同步。原
        // "header ≤ 12 cells / option labels 1-5 words" 被删除 —
        // validator R7.2 不再强制 (用户要求 LLM 自决长度)。
        "Issue a single prompt_user call with multiple questions[] rather than chaining calls. Concurrent prompts are rejected (INV-I). The call waits for the user until they answer or explicitly cancel; turn/session abort still terminates it.",
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
    //
    // ADR 0022 batch C (2026-05-19): publish via defineProperty with
    // configurable:false + writable:false, so a misbehaving extension
    // (or future LLM-accessible eval path) cannot silently rebind the
    // hook to a function that always returns 0 — which would silently
    // disable INV-K compaction defer and cause active prompt_user
    // dialogs to be torn down by compaction.
    //
    // Hot reload safety (3-way audit P1-3, 2026-05-19): two activate()
    // calls in the same process is rare but possible. The hook value
    // captures `promptManagerModule` by closure; Node's require cache
    // returns the SAME module instance on repeat require, so the
    // captured reference still sees the latest manager state. The
    // second defineProperty throws (non-configurable) and we ALLOW
    // that throw via the inspect-and-classify catch below: a benign
    // re-install collision is silenced; any other failure (e.g.
    // globalThis frozen, foreign hook squatted, descriptor mismatch)
    // is escalated via stderr so ops can find why INV-K defer is
    // silently inactive. Tests that NEED to mutate the hook MUST
    // use the test-only export in production-disabled smoke harness.
    try {
      Object.defineProperty(globalThis, "__abrainPromptUserGetPending", {
        value: () => promptManagerModule.getPendingPromptCount(),
        configurable: false,
        writable: false,
        enumerable: false,
      });
    } catch (err) {
      // Classify: benign hot-reload collision vs pathological install
      // failure. Benign = an existing non-configurable property already
      // exists with a callable value (we're the second activate()).
      // Pathological = no descriptor, or descriptor with non-function
      // value, or descriptor still configurable (someone is racing us).
      const existing = Object.getOwnPropertyDescriptor(
        globalThis,
        "__abrainPromptUserGetPending",
      );
      const benign =
        existing && existing.configurable === false && typeof existing.value === "function";
      if (!benign) {
        try {
          process.stderr.write(
            `[abrain] FAILED to install non-configurable __abrainPromptUserGetPending hook: ` +
              `${(err as Error)?.message ?? String(err)}\n` +
              "INV-K compaction defer may not be active. See ADR 0022 §D11 + batch C audit notes.\n",
          );
        } catch { /* stderr write failure is itself non-fatal */ }
      }
      // else: first-wins hot reload, intentional silence.
    }

    // ADR 0022 Batch B (D7), 2026-05-20: extend INV-K defer to the
    // vault authorization overlay. Symmetric to `__abrainPromptUserGetPending`
    // above — returns boolean (vault never queues, so binary flag, not a
    // count). compaction-tuner reads this via `vault-defer.ts` and skips
    // compaction while the user is staring at a vault overlay.
    //
    // Hardening rationale identical to prompt_user hook: defineProperty
    // with configurable:false + writable:false to block a misbehaving
    // extension (or future LLM-accessible eval path) from rebinding the
    // hook to a function that always returns false — which would silently
    // disable INV-K vault defer and let compaction tear down an active
    // authorization overlay.
    try {
      Object.defineProperty(globalThis, "__abrainVaultDialogInFlight", {
        value: () => isVaultDialogInFlight(),
        configurable: false,
        writable: false,
        enumerable: false,
      });
    } catch (err) {
      const existing = Object.getOwnPropertyDescriptor(
        globalThis,
        "__abrainVaultDialogInFlight",
      );
      const benign =
        existing && existing.configurable === false && typeof existing.value === "function";
      if (!benign) {
        try {
          process.stderr.write(
            `[abrain] FAILED to install non-configurable __abrainVaultDialogInFlight hook: ` +
              `${(err as Error)?.message ?? String(err)}\n` +
              "INV-K vault-dialog defer may not be active. See ADR 0022 §D11 + Batch B (D7) notes.\n",
          );
        } catch { /* stderr write failure is itself non-fatal */ }
      }
      // else: first-wins hot reload, intentional silence.
    }
  }

  if (typeof registry.registerCommand !== "function") return;

  // /abrain command — project binding (ADR 0017 / B4.5) + git auto-sync (ADR 0020)
  // + classifier audit diagnostic (ADR 0025 §4.5 P4, 2026-05-28).
  registry.registerCommand("abrain", {
    description: "Abrain control: /abrain bind [--project=<id>] | /abrain status | /abrain sync | /abrain audit classifier [--limit=N]. Rules diagnostics live under /rule list|explain|reload.",
    getArgumentCompletions(prefix: string) {
      const items = [
        "bind ",
        "bind --project=",
        "status",
        "sync",
        "audit classifier",
        "audit classifier --limit=",
      ];
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
            await awaitAbrainCanonicalWriteBarrier();
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
  assertAbrainLocalWriteSafety();
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
      await awaitAbrainCanonicalWriteBarrier();
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
      await awaitAbrainCanonicalWriteBarrier();
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
    // A failed or divergent configured-upstream update needs user attention.
    const lastFetchResult = syncStatus?.lastFetch?.result;
    const needsAttention = lastFetchResult !== undefined && !["ok", "noop", "skipped"].includes(lastFetchResult);
    const fullMsg = syncMsg ? `${bindingMsg}\n\n${syncMsg}` : bindingMsg;
    ui.notify(fullMsg, needsAttention ? "warning" : (current.activeProject ? "info" : "warning"));
    return;
  }
  if (sub === "sync") {
    // Manual sync mutates local Git state. In canonical mode it consumes the
    // same Path A startup promise as session_start and all canonical writers.
    await awaitAbrainCanonicalWriteBarrier();
    ui.notify("abrain: syncing with the configured upstream...", "info");
    const result = await gitSync({ abrainHome: ABRAIN_HOME });
    ui.notify(result.summary, result.ok ? "info" : "warning");
    return;
  }
  if (sub === "audit") {
    await handleAbrainAudit(tokens, ui, commandCwd);
    return;
  }
  if (sub === "bind") {
    const parsed = parseProjectFlag(tokens);
    if (parsed.errors.length > 0) {
      ui.notify(`/abrain bind: ${parsed.errors.join("; ")}`, "warning");
      return;
    }
    try {
      // Fail before bindAbrainProject mutates either repository when settings
      // are invalid. Only explicit valid enabled=false may use legacy commits.
      await awaitAbrainCanonicalWriteBarrier();
      const canonicalBindEnabled = canonicalGitRuntimeEnabled();
      const bindAndCommit = async () => {
        const result = await bindAbrainProject({
          abrainHome: ABRAIN_HOME,
          cwd: commandCwd,
          projectId: parsed.projectId,
        });
        // autoCommitPaths owns its own singleflight-before-barrier sequence.
        // Calling another same-repository singleflight wrapper here would queue
        // behind this operation when a bind targets the abrain worktree itself.
        const projectCommit = await autoCommitPaths(
          result.projectRoot,
          [".abrain-project.json"],
          `chore: 绑定 abrain 项目 ${result.projectId}`,
        );
        const abrainCommit = canonicalBindEnabled
          ? await canonicalAutoCommitAbrainPaths(
              ABRAIN_HOME,
              [".gitignore", `projects/${result.projectId}/_project.json`],
              `project: add ${result.projectId}`,
            )
          : await autoCommitPaths(
              ABRAIN_HOME,
              [".gitignore", `projects/${result.projectId}/_project.json`],
              `project: 添加 ${result.projectId}`,
            );
        return { result, projectCommit, abrainCommit };
      };
      const { result, projectCommit, abrainCommit } = await withCanonicalMutationBarrier(ABRAIN_HOME, bindAndCommit);
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
  ui.notify(`/abrain: unknown subcommand '${sub}'. available: bind / status / sync / audit classifier`, "warning");
}

/**
 * /abrain audit — high-mode operator diagnostic entry per ADR 0024 §4.3
 * (pull-based, not pushed). Currently supports the `classifier` sub-domain
 * (ADR 0025 §4.5 Phase 4 / P4): show the most recent N
 * correction_classifier audit rows with their reasoning-trace quality
 * signals, so the operator can spot drift in classifier reasoning before
 * the aggregator skeptical historian raises a trend advisory.
 *
 * Stays well inside ADR 0024 §2 INV-INVISIBILITY: this is a USER PULL,
 * not a system PUSH. Output is informational only — no [Y/N], no "please
 * review", no list of things-to-act-on.
 */
async function handleAbrainAudit(
  tokens: string[],
  ui: { notify(message: string, type?: string): void },
  commandCwd: string,
): Promise<void> {
  const sub = tokens.shift();
  if (sub !== "classifier") {
    ui.notify(`/abrain audit: unknown sub-domain '${sub ?? "(empty)"}'. available: classifier`, "warning");
    return;
  }
  let limit = 10;
  for (const tok of tokens) {
    const m = /^--limit=(\d+)$/.exec(tok);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n > 0) limit = Math.min(100, n);
    }
  }

  // Read user-global sediment audit.jsonl. Per ADR 0024 §4.3 the
  // diagnostic must read from where data actually lives (sidecar), not
  // from a pre-aggregated UI buffer.
  const auditPath = path.join(os.homedir(), ".abrain", ".state", "sediment", "audit.jsonl");
  if (!fs.existsSync(auditPath)) {
    ui.notify(`/abrain audit classifier: no audit.jsonl found at ${auditPath}. The sediment classifier has not run yet, or autoLlmWriteEnabled is false.`, "info");
    return;
  }
  const rawRows: Array<Record<string, unknown>> = [];
  try {
    const lines = fs.readFileSync(auditPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).operation === "correction_classifier") {
          rawRows.push(parsed as Record<string, unknown>);
        }
      } catch {
        // corrupt row—ignore
      }
    }
  } catch (e: any) {
    ui.notify(`/abrain audit classifier: failed to read ${auditPath}: ${e?.message ?? String(e)}`, "warning");
    return;
  }

  const recent = rawRows.slice(-limit);
  const lines: string[] = [
    `/abrain audit classifier — last ${recent.length} of ${rawRows.length} correction_classifier audit rows`,
    "",
  ];
  if (recent.length === 0) {
    lines.push("(no classifier rows recorded yet)");
  } else {
    for (const row of recent) {
      const ts = typeof row.ts === "string" ? row.ts : (typeof row.timestamp === "string" ? row.timestamp : "?");
      const signal = (row.signal && typeof row.signal === "object") ? row.signal as Record<string, unknown> : {};
      const signalFound = signal.signal_found !== false && (signal.typing || signal.user_quote);
      if (!signalFound) {
        lines.push(`${ts}  signal_found=false  reasoning="${truncate(String((signal.reasoning ?? "") || ""), 60)}"`);
        continue;
      }
      const typing = typeof signal.typing === "string" ? signal.typing : "?";
      const confidence = typeof signal.confidence === "number" ? signal.confidence : "?";
      const intent = typeof signal.correction_intent === "string" ? signal.correction_intent : "";
      const quote = typeof signal.user_quote === "string" ? truncate(signal.user_quote, 60) : "";
      const errorDir = typeof signal.most_likely_error === "string" ? truncate(signal.most_likely_error, 50) : "";
      lines.push(`${ts}  typing=${typing} conf=${confidence}  intent="${intent}"  quote="${quote}"`);
      if (errorDir) lines.push(`  most_likely_error="${errorDir}"`);
    }
  }

  // Health summary using the same heuristic the aggregator uses (call into
  // sediment/health.ts to avoid duplicating the parsing logic). Lazy-load
  // so abrain extension doesn't hard-depend on sediment if sediment was
  // ever removed independently.
  try {
    const healthMod = await import("../sediment/health");
    if (typeof healthMod.summarizeClassifierHealth === "function") {
      const health = healthMod.summarizeClassifierHealth(commandCwd, { windowSize: Math.max(50, limit) });
      lines.push("");
      lines.push(`Classifier health (window=${health.windowSize}, samples=${health.sampleSize}/${health.classifierRowCount}):`);
      lines.push(`  quote_rate=${health.quoteRate.toFixed(2)}  alternative_rate=${health.alternativeRate.toFixed(2)}  self_critique_rate=${health.concreteSelfCritiqueRate.toFixed(2)}  threshold=${health.threshold.toFixed(2)}`);
      if (health.trend) {
        lines.push(`  trend (last ${health.trend.half_window} vs prior ${health.trend.half_window}):`);
        lines.push(`    quote      delta=${health.trend.delta.quote >= 0 ? "+" : ""}${health.trend.delta.quote.toFixed(2)} (current=${health.trend.current.quote.toFixed(2)}, prior=${health.trend.prior.quote.toFixed(2)})`);
        lines.push(`    alternative delta=${health.trend.delta.alternative >= 0 ? "+" : ""}${health.trend.delta.alternative.toFixed(2)} (current=${health.trend.current.alternative.toFixed(2)}, prior=${health.trend.prior.alternative.toFixed(2)})`);
        lines.push(`    self_critique delta=${health.trend.delta.self_critique >= 0 ? "+" : ""}${health.trend.delta.self_critique.toFixed(2)} (current=${health.trend.current.self_critique.toFixed(2)}, prior=${health.trend.prior.self_critique.toFixed(2)})`);
        if (health.trend.significant_drop) {
          lines.push(`    significant_drop=TRUE — a dimension dropped ≥10pp`);
        }
      }
      if (health.advisories.length > 0) {
        lines.push("  advisories:");
        for (const a of health.advisories) lines.push(`    - ${a}`);
      }
    }
  } catch (e: any) {
    lines.push(`  (health summary unavailable: ${e?.message ?? String(e)})`);
  }

  ui.notify(lines.join("\n"), "info");
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s.replace(/\s+/g, " ").trim();
  return s.slice(0, n).replace(/\s+/g, " ").trim() + "…";
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
