/**
 * abrain — vault-backed bash injection helpers (P0c.read).
 *
 * Keeps plaintext out of bash tool-call argv by writing a short-lived 0600
 * env file and rewriting the command to source it. Tool-result output is
 * withheld by default by index.ts; when the user explicitly releases it,
 * literal redaction is applied via redactVaultBashContent().
 *
 * Scope routing (ADR 0014 P1 step 3):
 *
 *   $VAULT_<key>   → active project first, fall back to global
 *   $GVAULT_<key>  → global only
 *   $PVAULT_<key>  → active project only (block if no active project)
 *
 * Active project is the ADR 0014 §5.4 boot-time snapshot — bash `cd`
 * during a session does NOT change which vault gets injected.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { validateKey, type VaultScope } from "./vault-writer";
import { releaseSecret, redactWithReleasedSecrets, type ReleaseSecretResult } from "./vault-reader";

/**
 * Stable enum values for vault bash output authorization (deciding
 * whether the output of a vault-secret-bearing bash command should be
 * sent back to the LLM). Same architectural role as
 * `VAULT_RELEASE_AUTH_CHOICES` in abrain/index.ts (ADR 0022 Batch B
 * (f.arch), 2026-05-20): these strings are the STABLE ENUM — used by
 * audit grep, grant Set membership, and `applyChoice` equality
 * comparison. Display labels come from `vaultBashOutputDisplayLabel`
 * below (currently identity; (f.copy) follow-up adds localization).
 */
export const VAULT_BASH_OUTPUT_AUTH_CHOICES = ["No", "Yes once", "Session"] as const;
export type VaultBashOutputChoice = typeof VAULT_BASH_OUTPUT_AUTH_CHOICES[number];

/**
 * Display label mapper for vault bash output choices.
 *
 * Identity today (same rationale as `vaultReleaseDisplayLabel` in
 * abrain/index.ts). Audit + grant comparison must NEVER use the
 * display label.
 *
 * ## Contract (post-audit 2026-05-20)
 *
 * Any non-identity implementation MUST be: total over
 * `VaultBashOutputChoice`, never-throwing, with distinct outputs per
 * enum value. See `vaultReleaseDisplayLabel` JSDoc in
 * `abrain/index.ts` for the full contract — same rules apply to this
 * mapper.
 */
export function vaultBashOutputDisplayLabel(choice: string): string {
  return choice;
}

export type VaultVarPrefix = "VAULT_" | "GVAULT_" | "PVAULT_";

export interface VaultBashRunRecord {
  releases: ReleaseSecretResult[];
  envFile: string;
  grantKey: string;
  /** Original LLM-emitted bash command, BEFORE we wrapped it with the vault env
   * source line. Surfaced to the user at output-release authorization time so
   * they can see what ran. Not persisted; cleared with the record. */
  originalCommand?: string;
  /** $VAULT_<name> -> scope:key resolution captured at inject time, in matching
   * positional order with `releases`. Used by the audit log only. */
  variables?: Array<{ varName: string; scopeKey: string }>;
}

export interface VaultBashEnvVar {
  varName: string;
  value: string;
}

export interface VaultBashKeyMatch {
  scope: VaultScope;
  key: string;
}

export interface VaultBashPrepareDeps {
  /**
   * Resolve a `$VAULT_*` / `$GVAULT_*` / `$PVAULT_*` reference into the actual
   * vault scope + key, or return null/undefined if nothing matches. Implementations
   * decide the priority between project and global.
   */
  keyForVar(varName: string, prefix: VaultVarPrefix): VaultBashKeyMatch | undefined | null;
  /** Release plaintext for a previously-resolved scope+key match. */
  releaseKey(match: VaultBashKeyMatch): Promise<ReleaseSecretResult>;
  /** Persist injected env vars to a short-lived 0600 file. */
  writeEnvFile(vars: VaultBashEnvVar[]): string;
  /** Returned to the LLM (as `block.reason`) when `$PVAULT_*` is referenced but no active project exists. */
  pvaultBlockReason?: string;
}

export type VaultBashPrepareResult =
  | { kind: "none" }
  | { kind: "block"; reason: string }
  | { kind: "prepared"; command: string; record: VaultBashRunRecord };

export function scopeLabel(scope: VaultScope): string {
  return scope === "global" ? "global" : `project:${scope.project}`;
}

export function authKey(scope: VaultScope, key: string): string {
  return `${scopeLabel(scope)}:${key}`;
}

export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface WindowsVaultBashProfileInput {
  platform?: NodeJS.Platform;
  shellPath?: string;
  env?: Record<string, string | undefined>;
  uname?: string;
}

export type WindowsVaultBashProfile =
  | { ok: true; kind: "git-bash" | "msys2" | "non-windows" }
  | { ok: false; kind: "wsl" | "cygwin" | "unknown"; reason: string };

export function classifyWindowsVaultBashProfile(input: WindowsVaultBashProfileInput = {}): WindowsVaultBashProfile {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return { ok: true, kind: "non-windows" };

  const env = input.env ?? process.env;
  const shellPath = (input.shellPath ?? "").replace(/\\/g, "/").toLowerCase();
  const uname = (input.uname ?? "").toLowerCase();
  const msystem = (env.MSYSTEM ?? "").toLowerCase();

  if (env.WSL_DISTRO_NAME || env.WSL_INTEROP || shellPath.includes("/windows/system32/bash.exe") || shellPath.includes("/microsoft/windowsapps/bash.exe")) {
    return {
      ok: false,
      kind: "wsl",
      reason: "vault bash injection on Windows requires Git Bash/MSYS2; WSL bash.exe is a separate Linux filesystem. Launch pi inside WSL, or set shellPath to Git Bash (C:\\Program Files\\Git\\bin\\bash.exe).",
    };
  }

  if (uname.startsWith("cygwin") || shellPath.includes("/cygwin")) {
    return {
      ok: false,
      kind: "cygwin",
      reason: "vault bash injection on Windows supports Git Bash/MSYS2 only; Cygwin bash is not supported. Set shellPath to Git Bash (C:\\Program Files\\Git\\bin\\bash.exe).",
    };
  }

  if (shellPath.includes("/git/bin/bash.exe") || shellPath.includes("/git/usr/bin/bash.exe") || uname.startsWith("mingw")) {
    return { ok: true, kind: "git-bash" };
  }

  const msys2Path =
    shellPath.includes("/msys64/usr/bin/bash.exe") ||
    shellPath.includes("/msys32/usr/bin/bash.exe") ||
    shellPath.includes("/mingw64/bin/bash.exe") ||
    shellPath.includes("/mingw32/bin/bash.exe");
  if (msystem || uname.startsWith("msys") || msys2Path) {
    return { ok: true, kind: "msys2" };
  }

  return {
    ok: false,
    kind: "unknown",
    reason: "vault bash injection on Windows requires Git Bash/MSYS2. Set shellPath to Git Bash (C:\\Program Files\\Git\\bin\\bash.exe); PowerShell/cmd are launchers only, not command runtimes.",
  };
}

export function vaultVarPrefix(varName: string): VaultVarPrefix | null {
  if (varName.startsWith("GVAULT_")) return "GVAULT_";
  if (varName.startsWith("PVAULT_")) return "PVAULT_";
  if (varName.startsWith("VAULT_")) return "VAULT_";
  return null;
}

export function vaultVarRefs(command: string): string[] {
  const refs = new Set<string>();
  const re = /\$(?:\{((?:GVAULT|PVAULT|VAULT)_[A-Za-z0-9_]+)\}|((?:GVAULT|PVAULT|VAULT)_[A-Za-z0-9_]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command))) refs.add(match[1] || match[2]);
  return [...refs];
}

export function keyCandidatesFromVaultVar(varName: string): string[] {
  const suffix = varName.replace(/^(?:GVAULT|PVAULT|VAULT)_/, "");
  return Array.from(new Set([
    suffix,
    suffix.replace(/_/g, "-"),
    suffix.toLowerCase(),
    suffix.toLowerCase().replace(/_/g, "-"),
  ].filter(Boolean)));
}

function existingVaultKey(abrainHome: string, scope: VaultScope, varName: string): string | undefined {
  for (const key of keyCandidatesFromVaultVar(varName)) {
    try { validateKey(key); } catch { continue; }
    if (fs.existsSync(vaultEncryptedPath(abrainHome, scope, key))) return key;
  }
  return undefined;
}

function vaultEncryptedPath(abrainHome: string, scope: VaultScope, key: string): string {
  if (scope === "global") return path.join(abrainHome, "vault", `${key}.md.age`);
  return path.join(abrainHome, "projects", scope.project, "vault", `${key}.md.age`);
}

/** Legacy: only walks the global vault. Kept for callers that explicitly want global. */
export function existingGlobalVaultKey(abrainHome: string, varName: string): string | undefined {
  return existingVaultKey(abrainHome, "global", varName);
}

export function writeVaultEnvFile(stateDir: string, vars: VaultBashEnvVar[]): string {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, `vault-env-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sh`);
  const body = vars.map(({ varName, value }) => `export ${varName}=${shellSingleQuote(value)}`).join("\n") + "\n";
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return file;
}

export async function prepareVaultBashCommand(command: string, deps: VaultBashPrepareDeps): Promise<VaultBashPrepareResult> {
  const refs = vaultVarRefs(command);
  if (refs.length === 0) return { kind: "none" };

  const releases: ReleaseSecretResult[] = [];
  const envVars: VaultBashEnvVar[] = [];
  for (const varName of refs) {
    const prefix = vaultVarPrefix(varName);
    if (!prefix) return { kind: "block", reason: `unrecognized vault variable: $${varName}` };
    const match = deps.keyForVar(varName, prefix);
    if (!match) {
      if (prefix === "PVAULT_" && deps.pvaultBlockReason) return { kind: "block", reason: deps.pvaultBlockReason };
      const where = prefix === "GVAULT_" ? "global vault"
        : prefix === "PVAULT_" ? "active project's vault"
        : "active project or global vault";
      return { kind: "block", reason: `vault key for $${varName} not found in ${where}` };
    }
    try {
      const release = await deps.releaseKey(match);
      releases.push(release);
      envVars.push({ varName, value: release.value });
    } catch (err: any) {
      return { kind: "block", reason: `vault injection failed for $${varName}: ${err?.message ?? String(err)}` };
    }
  }

  const envFile = deps.writeEnvFile(envVars);
  const quoted = shellSingleQuote(envFile);
  const variables = envVars.map((v, i) => ({
    varName: v.varName,
    scopeKey: authKey(releases[i]!.scope, releases[i]!.key),
  }));
  return {
    kind: "prepared",
    command: `__pi_vault_env=${quoted}; trap 'rm -f "$__pi_vault_env"' EXIT; . "$__pi_vault_env"; ${command}`,
    record: {
      releases,
      envFile,
      grantKey: releases.map((r) => authKey(r.scope, r.key)).sort().join(","),
      variables,
    },
  };
}

export interface PrepareBootVaultBashOptions {
  abrainHome: string;
  stateDir: string;
  /** Active project id from the ADR 0014 §5.4 boot-time snapshot, or null if unbound. */
  activeProjectId: string | null;
  /** Resolved pi bash executable. On win32 it must be Git Bash or MSYS2, never WSL/Cygwin. */
  shellPath?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  uname?: string;
}

export function buildBootVaultBashDeps(opts: PrepareBootVaultBashOptions): VaultBashPrepareDeps {
  const projectId = opts.activeProjectId;
  return {
    keyForVar(varName, prefix) {
      if (prefix === "GVAULT_") {
        const key = existingVaultKey(opts.abrainHome, "global", varName);
        return key ? { scope: "global", key } : undefined;
      }
      if (prefix === "PVAULT_") {
        if (!projectId) return undefined; // pvaultBlockReason kicks in
        const key = existingVaultKey(opts.abrainHome, { project: projectId }, varName);
        return key ? { scope: { project: projectId }, key } : undefined;
      }
      // $VAULT_ — active project first, fall back to global.
      if (projectId) {
        const projKey = existingVaultKey(opts.abrainHome, { project: projectId }, varName);
        if (projKey) return { scope: { project: projectId }, key: projKey };
      }
      const globalKey = existingVaultKey(opts.abrainHome, "global", varName);
      return globalKey ? { scope: "global", key: globalKey } : undefined;
    },
    releaseKey: (match) => releaseSecret({ abrainHome: opts.abrainHome, scope: match.scope, key: match.key }),
    writeEnvFile: (vars) => writeVaultEnvFile(opts.stateDir, vars),
    pvaultBlockReason: projectId
      ? undefined
      : "$PVAULT_* requires a strict active project binding. Run /abrain bind (or use $GVAULT_* for global secrets).",
  };
}

export async function prepareBootVaultBashCommand(command: string, opts: PrepareBootVaultBashOptions): Promise<VaultBashPrepareResult> {
  if (vaultVarRefs(command).length > 0) {
    const profile = classifyWindowsVaultBashProfile({ platform: opts.platform, shellPath: opts.shellPath, env: opts.env, uname: opts.uname });
    if (!profile.ok) return { kind: "block", reason: profile.reason };
  }
  return prepareVaultBashCommand(command, buildBootVaultBashDeps(opts));
}

/** Legacy: global-only convenience for callers/tests that don't have project context. */
export async function prepareGlobalVaultBashCommand(command: string, opts: { abrainHome: string; stateDir: string }): Promise<VaultBashPrepareResult> {
  return prepareBootVaultBashCommand(command, { ...opts, activeProjectId: null });
}

export function redactVaultBashContent(content: unknown, releases: ReleaseSecretResult[]): unknown {
  if (!Array.isArray(content)) return content;
  return content.map((part) => {
    if (!part || typeof part !== "object") return part;
    const obj = part as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") {
      return { ...obj, text: redactWithReleasedSecrets(obj.text, releases) };
    }
    return part;
  });
}

export function withheldVaultBashContent(record: { releases: ReleaseSecretResult[] }) {
  const keys = record.releases.map((r) => `${scopeLabel(r.scope)}:${r.key}`).join(", ");
  return [{ type: "text", text: `(vault-protected bash output withheld from LLM context; keys: ${keys}. Ask the user to release this command's output if needed.)` }];
}
