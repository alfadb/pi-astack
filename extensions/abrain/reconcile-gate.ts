import { spawn, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface Adr0039ReconcileGateDetails {
  abrainHome: string;
  repoRoot: string;
  script: string;
  command: string[];
  status: number | null;
  stdout: string;
  stderr: string;
  failLines: string[];
  l1Violations: string[];
  otherBlockers: string[];
  l1Override: boolean;
  l2Override: boolean;
  overrideLogPath?: string | null;
  checkedPathMode: "incremental_hint" | "full";
  pushedDerivedPaths: string[];
  dirtyDerivedPaths: string[];
  fast_path?: boolean;
  costNote: string;
}

export interface Adr0039ReconcileGateResult {
  ok: boolean;
  reason: "passed" | "overridden" | "blocked" | "runner_timeout" | "runner_error";
  details: Adr0039ReconcileGateDetails;
}

export interface Adr0039PrePushHookResult {
  ok: boolean;
  status: "installed" | "updated" | "already_installed" | "skipped_not_git" | "skipped_hooks_path" | "skipped_existing_hook" | "failed";
  hookPath?: string;
  warning?: string;
}

export const ADR0039_PRE_PUSH_HOOK_MARKER = "# pi-astack ADR0039 pre-push hook v1";

// Full reconcile cost grows with the event store. A too-short gate timeout
// fails closed and can permanently block push, so the asymmetric cost favors
// giving the authoritative byte/hash check a larger budget.
export const DEFAULT_RECONCILE_TIMEOUT_MS = 120_000;
const MAX_RECONCILE_OUTPUT_BYTES = 2 * 1024 * 1024;

function repoRootFromHere(): string {
  if (process.env.PI_ASTACK_REPO_ROOT) return path.resolve(process.env.PI_ASTACK_REPO_ROOT);
  return path.resolve(__dirname, "..", "..");
}

function expandHome(input: string): string {
  return String(input).replace(/^~(?=$|\/)/, os.homedir());
}

function normalizeRel(p: string): string {
  return p.split(path.sep).join("/").replace(/^\.\//, "");
}

function derivedOnly(paths: string[]): string[] {
  return Array.from(new Set(paths.map(normalizeRel).filter((p) => p === "l1" || p === "l2" || p.startsWith("l1/") || p.startsWith("l2/")))).sort();
}

function gitList(abrainHome: string, args: string[]): string[] {
  try {
    const stdout = execFileSync("git", ["-C", abrainHome, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 });
    return stdout.split("\n").map((line) => line.replace(/\r$/, "")).filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function pushedDerivedPaths(abrainHome: string): string[] {
  try {
    execFileSync("git", ["-C", abrainHome, "rev-parse", "--verify", "origin/main"], { stdio: "ignore", timeout: 3_000 });
  } catch {
    return [];
  }
  return derivedOnly(gitList(abrainHome, ["diff", "--name-only", "origin/main...HEAD", "--", "l1", "l2"]));
}

function dirtyDerivedPaths(abrainHome: string): string[] {
  const lines = gitList(abrainHome, ["status", "--porcelain", "--", "l1", "l2"]);
  return derivedOnly(lines.map((line) => line.slice(3).trim()).filter(Boolean));
}

function recordOverride(abrainHome: string, detail: Record<string, unknown>): string | null {
  try {
    const logPath = path.join(abrainHome, ".state", "sediment", "adr0039-l3", "prepush-overrides.jsonl");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const envFlags = [
      detail.l1_append_only_override ? "PI_SKIP_L1_APPEND_ONLY=1" : undefined,
      detail.l2_check_override ? "PI_SKIP_L2_CHECK=1" : undefined,
    ].filter(Boolean).join(" ") || "ADR0039 push gate override";
    fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), env: envFlags, ...detail })}\n`, "utf-8");
    return logPath;
  } catch {
    return null;
  }
}

function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  if (Buffer.byteLength(next, "utf-8") <= MAX_RECONCILE_OUTPUT_BYTES) return next;
  return next.slice(-MAX_RECONCILE_OUTPUT_BYTES);
}

function runReconcileRunner(args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<{ status: number | null; stdout: string; stderr: string; error?: Error; timedOut?: boolean }> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const child = spawn(process.execPath, args, { cwd: opts.cwd, env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: null, stdout, stderr, error });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const error = timedOut ? new Error(`ADR0039 reconcile runner timed out after ${opts.timeoutMs}ms`) : undefined;
      resolve({ status: timedOut ? null : status, stdout, stderr, error, timedOut });
    });
  });
}

export async function checkAdr0039ReconcileGate(opts: { abrainHome: string; repoRoot?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } | string): Promise<Adr0039ReconcileGateResult> {
  const input = typeof opts === "string" ? { abrainHome: opts } : opts;
  const abrainHome = path.resolve(expandHome(input.abrainHome));
  const repoRoot = path.resolve(input.repoRoot ?? repoRootFromHere());
  const script = path.join(repoRoot, "scripts", "smoke-adr0039-reconcile.mjs");
  const env = input.env ?? process.env;
  const timeoutMs = input.timeoutMs ?? DEFAULT_RECONCILE_TIMEOUT_MS;
  const pushed = pushedDerivedPaths(abrainHome);
  const dirty = dirtyDerivedPaths(abrainHome);
  const command = [script, "--abrain", abrainHome, "--push-gate-only"];
  const baseDetails = {
    abrainHome,
    repoRoot,
    script,
    command: [process.execPath, ...command],
    l1Override: env.PI_SKIP_L1_APPEND_ONLY === "1",
    l2Override: env.PI_SKIP_L2_CHECK === "1",
    checkedPathMode: pushed.length > 0 || dirty.length > 0 ? "incremental_hint" as const : "incremental_hint" as const,
    pushedDerivedPaths: pushed,
    dirtyDerivedPaths: dirty,
  };

  if (pushed.length === 0 && dirty.length === 0) {
    return {
      ok: true,
      reason: "passed",
      details: {
        ...baseDetails,
        status: 0,
        stdout: "",
        stderr: "",
        failLines: [],
        l1Violations: [],
        otherBlockers: [],
        fast_path: true,
        costNote: "Incremental ADR0039 push gate fast_path: no pushed or dirty l1/l2 paths relative to origin/main, so the full reconciler was not spawned.",
      },
    };
  }

  const result = await runReconcileRunner(command, { cwd: repoRoot, env, timeoutMs });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const failLines = stdout.split("\n").filter((line) => line.includes("  FAIL  "));
  const l1Violations = failLines.filter((line) => line.includes("l1_append_only_violated"));
  const otherBlockers = failLines.filter((line) => !line.includes("l1_append_only_violated"));
  const details: Adr0039ReconcileGateDetails = {
    ...baseDetails,
    status: result.status,
    stdout,
    stderr: result.error ? `${stderr}${stderr ? "\n" : ""}${result.error.message}` : stderr,
    failLines,
    l1Violations,
    otherBlockers,
    checkedPathMode: "full",
    fast_path: false,
    costNote: "The gate computes pending/dirty l1/l2 path hints, then runs the existing full ADR0039 push-gate reconciler as the authoritative byte/hash check.",
  };

  if (result.timedOut) return { ok: false, reason: "runner_timeout", details };
  if (result.error) return { ok: false, reason: "runner_error", details };
  if (result.status === 0) return { ok: true, reason: "passed", details };

  const needL1 = l1Violations.length > 0;
  const needOther = otherBlockers.length > 0;
  const okL1 = !needL1 || details.l1Override;
  const okOther = !needOther || details.l2Override;
  if ((needL1 || needOther) && okL1 && okOther) {
    details.overrideLogPath = recordOverride(abrainHome, {
      reconcile_exit: result.status,
      l1_append_only_override: needL1 && details.l1Override,
      l2_check_override: needOther && details.l2Override,
      l1_violations: l1Violations.length,
      other_blockers: otherBlockers.length,
      pushed_derived_paths: pushed,
      dirty_derived_paths: dirty,
    });
    return { ok: true, reason: "overridden", details };
  }

  return { ok: false, reason: "blocked", details };
}

function shSingleQuote(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) {
    return "'<path contains control characters; edit the hook manually>'";
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function hookBody(scriptPath: string, abrainHome: string): string {
  return [
    "#!/bin/sh",
    ADR0039_PRE_PUSH_HOOK_MARKER,
    "command -v node >/dev/null 2>&1 || exit 0",
    `SCRIPT=${shSingleQuote(scriptPath)}`,
    `ABRAIN_HOME=${shSingleQuote(abrainHome)}`,
    "if [ ! -f \"$SCRIPT\" ]; then",
    "  echo \"WARN - pi-astack ADR0039 pre-push hook script missing; allowing push (runtime pushAsync gate remains primary).\" >&2",
    "  exit 0",
    "fi",
    "exec node \"$SCRIPT\" --abrain \"$ABRAIN_HOME\"",
    "",
  ].join("\n");
}

function appendHookAudit(abrainHome: string, event: Record<string, unknown>): void {
  try {
    const stateDir = path.join(abrainHome, ".state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.appendFileSync(path.join(stateDir, "git-sync.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), op: "hook_install", ...event })}\n`, "utf-8");
  } catch {
    // best-effort only
  }
}

export function ensureAdr0039PrePushHook(abrainHomeInput: string, opts: { repoRoot?: string } = {}): Adr0039PrePushHookResult {
  const abrainHome = path.resolve(expandHome(abrainHomeInput));
  const gitDir = path.join(abrainHome, ".git");
  if (!fs.existsSync(gitDir)) return { ok: true, status: "skipped_not_git" };

  try {
    const hooksPath = execFileSync("git", ["-C", abrainHome, "config", "--get", "core.hooksPath"], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 3_000 }).trim();
    if (hooksPath) {
      const warning = `core.hooksPath is set (${hooksPath}); not installing ADR0039 pre-push hook into .git/hooks`;
      appendHookAudit(abrainHome, { result: "skipped_hooks_path", reason: "pre_push_hook_skipped_hooks_path", details: { hooksPath } });
      return { ok: false, status: "skipped_hooks_path", warning };
    }
  } catch {
    // no hooksPath configured
  }

  const repoRoot = path.resolve(opts.repoRoot ?? repoRootFromHere());
  const scriptPath = path.join(repoRoot, "scripts", "pre-push-adr0039-reconcile.mjs");
  const hookPath = path.join(gitDir, "hooks", "pre-push");
  const desired = hookBody(scriptPath, abrainHome);
  try {
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf-8") : null;
    if (existing !== null && !existing.includes(ADR0039_PRE_PUSH_HOOK_MARKER)) {
      const warning = `existing non-pi pre-push hook preserved at ${hookPath}`;
      appendHookAudit(abrainHome, { result: "skipped_existing_hook", reason: "pre_push_hook_not_overwritten", details: { hookPath } });
      return { ok: false, status: "skipped_existing_hook", hookPath, warning };
    }
    if (existing === desired) return { ok: true, status: "already_installed", hookPath };
    fs.writeFileSync(hookPath, desired, { encoding: "utf-8", mode: 0o755 });
    try { fs.chmodSync(hookPath, 0o755); } catch { /* chmod best-effort on non-POSIX */ }
    appendHookAudit(abrainHome, { result: existing ? "updated" : "installed", reason: existing ? "pre_push_hook_updated" : "pre_push_hook_installed", details: { hookPath } });
    return { ok: true, status: existing ? "updated" : "installed", hookPath };
  } catch (err) {
    const warning = err instanceof Error ? err.message : String(err);
    appendHookAudit(abrainHome, { result: "failed", reason: "pre_push_hook_install_failed", error: warning });
    return { ok: false, status: "failed", hookPath, warning };
  }
}
