/**
 * abrain — vault writer library (P0c.write).
 *
 * Implements brain-redesign-spec.md §6.4.0 transactional write +
 * §6.4.0.1 P0c.write implementation invariants.
 *
 * Critical security property (inv1): this module DOES NOT touch the
 * master key plaintext. All encryption uses ~/.abrain/.vault-pubkey
 * (the age public key, plaintext on disk by design). Only read paths
 * (P0c.read, future) need to unlock the master key.
 *
 * Public API:
 *   - writeSecret(opts): atomic transactional write of a secret
 *   - listSecrets(scope, abrainHome): metadata-only listing
 *   - forgetSecret(scope, key, abrainHome): rm encrypted file + audit
 *   - reconcile(abrainHome): scan vault dirs, append missing audit rows
 *
 * Public via index.ts /secret command, or directly by smoke / future
 * automation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";

// ── types ───────────────────────────────────────────────────────

/** "global" = ~/.abrain/vault/  ;  project-id = ~/.abrain/projects/<id>/vault/ */
export type VaultScope = "global" | { project: string };

export interface WriteSecretOptions {
  abrainHome: string;
  scope: VaultScope;
  /** key name (slug-safe; no '/', '..', leading '.') */
  key: string;
  /** the plaintext value to encrypt — caller is responsible for upstream sanitization */
  value: string | Buffer;
  /** optional human-readable description (NOT encrypted; written into _meta) */
  description?: string;
}

export interface ListSecretsResult {
  scope: VaultScope;
  /** key name */
  key: string;
  /** path of the encrypted file (presence = secret exists) */
  encryptedPath: string;
  /** parsed timeline first row's `created` ts (ISO) if available */
  created?: string;
  /** parsed description (from _meta) if available */
  description?: string;
  /** has the key been forgotten (encrypted file gone but _meta retained)? */
  forgotten: boolean;
  /** ISO ts of the most recent `forgotten` row in _meta timeline (v1.4.4 dogfood) */
  forgottenAt?: string;
}

// ── path resolution ─────────────────────────────────────────────

const VAULT_PUBKEY = ".vault-pubkey";
const VAULT_EVENTS = path.join(".state", "vault-events.jsonl");
const VAULT_LOCK = ".lock";

/** Returns the vault directory for a scope (does not create it). */
export function vaultDirForScope(abrainHome: string, scope: VaultScope): string {
  if (scope === "global") return path.join(abrainHome, "vault");
  return path.join(abrainHome, "projects", scope.project, "vault");
}

/** Validate that key is safe to use as a filename (no traversal / hidden). */
export function validateKey(key: string): void {
  if (!key) throw new Error("key cannot be empty");
  if (key.length > 128) throw new Error(`key too long (${key.length} > 128)`);
  if (key.startsWith(".")) throw new Error(`key cannot start with '.': ${key}`);
  if (key.includes("/") || key.includes("\\")) throw new Error(`key cannot contain path separators: ${key}`);
  if (key.includes("..")) throw new Error(`key cannot contain '..': ${key}`);
  if (!/^[a-zA-Z0-9_.-]+$/.test(key)) throw new Error(`key must match [a-zA-Z0-9_.-]+: ${key}`);
}

// ── vault dir lock (atomic file-creation, zero deps, no subprocess) ────────────
//
// EARLIER P0c.write attempts spawned `flock(1)` subprocess holding a sentinel
// shell loop. SIGTERM on the flock parent left orphaned grandchild `sh -c
// 'while sleep'` processes (zsh + sleep 86400) leaking on every acquire. The
// dogfood smoke run leaked ~50 zombie processes before being killed.
//
// New design: pure-node atomic file creation. No subprocess, no signal chain.
//   1. open(lockPath, 'wx') — O_CREAT|O_EXCL atomic, fails EEXIST if held
//   2. on EEXIST, check stale: read holder pid + ts, see if process alive,
//      see if lock older than max-lock-age. If stale: rm + retry.
//   3. else: poll-retry with backoff up to timeout.
//   4. release: unlink the lock file.
//
// Crash safety: holder dying abruptly (kill -9 / OOM / power loss) is detected
// next acquire via process.kill(pid, 0) (signal 0 is a probe, throws ESRCH
// if no such pid). Corrupt lock file with no parseable pid is reclaimed after
// MAX_LOCK_AGE_MS via mtime fallback.
//
// Limitations vs flock(2):
//   - not atomic across NFS — but ~/.abrain is local
//   - poll-based with 50–150ms jitter; fine for low-frequency vault writes
//   - same-host pid reuse window: pathological recovery delay up to MAX_LOCK_AGE_MS

// 5 minutes — stale-lock grace period. After this, a lock with no live
// owning process (pid probe via signal 0) is treated as abandoned and
// reclaimable. Long enough that a slow legit writer won't be evicted;
// short enough that crashes / killed processes don't strand the vault
// for hours. (Originally documented as "quiescence drain timeout" which
// was a leftover term from the 8-phase migration model that ADR 0014
// v7.1 retired.)
const MAX_LOCK_AGE_MS = 5 * 60 * 1000;

interface LockHandle {
  release(): void;
}

async function acquireLock(lockFile: string, timeoutMs = 30_000): Promise<LockHandle> {
  const start = Date.now();
  let attempts = 0;

  while (true) {
    attempts++;
    try {
      // O_CREAT | O_EXCL | O_WRONLY (mode 'wx') — atomic create-if-not-exists
      const fd = fs.openSync(lockFile, "wx", 0o600);
      try {
        fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return {
        release() {
          if (released) return;
          released = true;
          try { fs.unlinkSync(lockFile); } catch { /* may have been forcibly cleaned */ }
        },
      };
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      const stolen = tryReclaimStaleLock(lockFile);
      if (stolen) continue;

      if (Date.now() - start >= timeoutMs) {
        throw new Error(`vault lock acquire timeout (${timeoutMs}ms, ${attempts} attempts): ${lockFile}`);
      }
      const backoff = 50 + Math.floor(Math.random() * 100);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
}

/**
 * Returns true if lock was stale and we removed it (caller should retry).
 * Returns false otherwise. Never throws.
 */
function tryReclaimStaleLock(lockFile: string): boolean {
  let content: string;
  let stat: fs.Stats;
  try {
    content = fs.readFileSync(lockFile, "utf8");
    stat = fs.statSync(lockFile);
  } catch {
    return false; // race: someone cleaned up; we'll retry
  }

  const lines = content.split("\n");
  const pid = parseInt(lines[0]!, 10);
  const ts = parseInt(lines[1]!, 10);
  const ageMs = Date.now() - (Number.isFinite(ts) ? ts : 0);

  if (ageMs > MAX_LOCK_AGE_MS) {
    try { fs.unlinkSync(lockFile); return true; } catch { return false; }
  }

  if (Number.isFinite(pid) && pid > 0) {
    try {
      process.kill(pid, 0);
      return false; // pid alive: legit lock
    } catch (err: any) {
      if (err.code === "ESRCH") {
        try { fs.unlinkSync(lockFile); return true; } catch { return false; }
      }
      return false; // EPERM = alive but other user
    }
  }

  const fileAge = Date.now() - stat.mtimeMs;
  if (fileAge > MAX_LOCK_AGE_MS) {
    try { fs.unlinkSync(lockFile); return true; } catch { return false; }
  }
  return false;
}

// ── audit log (vault-events.jsonl) ──────────────────────────────

/**
 * Audit row operations recorded in `~/.abrain/.state/vault-events.jsonl`.
 *
 * Write path (already shipped):
 *   - `create` / `rotate` / `forget` / `recovered_missing_audit`
 *
 * Read path (ADR 0014 P0c.read audit closure):
 *   - `release`            — vault_release tool authorized + plaintext delivered
 *   - `release_denied`     — vault_release tool authorization denied
 *   - `release_blocked`    — vault_release tool rejected before authorization
 *                            (pre-flight: key missing/forgotten or bad input)
 *   - `bash_inject`        — $VAULT_* / $PVAULT_* / $GVAULT_* matched, env file written
 *   - `bash_inject_block`  — bash hook refused (missing key, $PVAULT_* without
 *                            active project, decrypt error, etc.)
 *   - `bash_output_release` — user authorized vault-backed bash stdout to LLM
 *   - `bash_output_withhold` — user denied / pre-existing withhold path
 *
 * Plaintext NEVER enters audit rows. Command previews are truncated and only
 * contain `$VAULT_*` variable refs (the bash hook rewrites the command before
 * execution, never the other way around).
 */
export type VaultEventOp =
  | "create"
  | "rotate"
  | "forget"
  | "forget_failed"
  | "recovered_missing_audit"
  | "release"
  | "release_denied"
  | "release_blocked"
  | "bash_inject"
  | "bash_inject_block"
  | "bash_output_release"
  | "bash_output_withhold"
  // ADR 0022: prompt_user lane shares the VAULT_EVENTS jsonl file but
  // uses `lane:"prompt_user"` so vault tooling can filter it out.
  // Two rows per prompt (ask + answer/result), one row for blocked
  // entries that never reach the dialog.
  | "prompt_user_ask"
  | "prompt_user_answer"
  | "prompt_user_blocked"
  // ADR 0022 housekeeping batch A (b) (2026-05-19): activate() probes
  // pi-tui at startup. If pi-tui fails to load OR makeBuildDialog
  // throws, we emit exactly ONE startup_telemetry row + ui.notify on
  // the first session_start that has ctx.ui.custom available so
  // operators can detect silent fallback to ui.select. lane is
  // "vault_substrate" so existing vault tooling filters (which select
  // on lane="vault_release" / "bash_inject" / "bash_output" / "prompt_user")
  // ignore it.
  | "startup_telemetry";

export interface VaultEvent {
  ts: string;
  op: VaultEventOp;
  scope: "global" | string; // "global" or "project:<id>"
  /** Per-key writes set this. Read-path events that span multiple keys (bash
   * inject / bash output release) leave this empty and use `keys` instead. */
  key?: string;
  /** Size of plaintext (NOT the secret itself) for cardinality. */
  size?: number;
  description?: string;
  /** Identifying info for recovery rows. */
  recovered_ts?: string;
  /** Read-path identifier of the originating lane. */
  lane?: string;
  /** Read-path: denial / block reason code. */
  reason?: string;
  /** Read-path: list of scope:key strings for events that span multiple keys. */
  keys?: string[];
  /** Read-path: $VAULT_<name> → scope:key mapping captured at injection time. */
  variables?: Array<{ varName: string; scopeKey: string }>;
  /** Read-path: truncated bash command preview — variable refs only, never plaintext. */
  command_preview?: string;
  /** `forget_failed` op carries the underlying errno chain (shred + unlink).
   *  Plaintext is NOT involved — this is the OS error string, not the
   *  secret. Round 7 P0 (gpt-5.5 audit fix). */
  error?: string;
  /** ADR 0022 housekeeping batch A (g) (2026-05-19, INV-D metadata):
   *  which UI substrate produced this read-path decision. Lets ops
   *  distinguish PromptDialog overlay outcomes from ui.select / ui.confirm
   *  fallback paths in the same vault-events.jsonl when reading a row
   *  with `reason:"cancelled"` or `op:"release"`. Pre-fix the row was
   *  ambiguous: a cancelled overlay and a cancelled ui.select looked
   *  identical. (DEEPSEEK xhigh P0 reclassified P2; A-batch synthesis
   *  2026-05-19 multi-LLM round.)
   *    - "overlay"  : PromptDialog overlay (default since ADR 0022 P3b)
   *    - "select"   : ui.select fallback (ui.custom unavailable / dialog_error)
   *    - "confirm"  : ui.confirm fallback (legacy binary y/n)
   *    - "cached"   : session grant short-circuit, no UI surfaced this call
   *    - "none"     : no UI method available, forced deny / withhold
   *  Free-form optional; consumers should treat unknown values as
   *  forward-compat unknown rather than error. */
  ui_path?: "overlay" | "select" | "confirm" | "cached" | "none";
}

/**
 * Public read-path entry point: append a single audit row. Use this from
 * vault_release / bash hook code in index.ts. Plaintext must NOT appear in
 * any field; the type purposely has no `value` slot.
 */
export async function appendVaultReadAudit(abrainHome: string, ev: VaultEvent): Promise<void> {
  return appendVaultEvent(abrainHome, ev);
}

async function appendVaultEvent(abrainHome: string, ev: VaultEvent): Promise<void> {
  const eventsPath = path.join(abrainHome, VAULT_EVENTS);
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true, mode: 0o700 });
  // ADR 0027 C6b: cross-layer causal anchor. Vault events fire from many
  // entry points (vault_release tool, /secret command, bash $VAULT_<key>
  // expansion). All run inside main-session ctx — anchor reflects the
  // user turn that triggered the vault op, which is exactly the right
  // grain for compliance/audit reconstruction.
  const enriched = {
    ...spreadAnchor(getCurrentAnchor()),
    ...ev,
  };
  const line = JSON.stringify(enriched) + "\n";
  // append + fsync
  const fd = fs.openSync(eventsPath, "a", 0o600);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ── _meta/<key>.md timeline ─────────────────────────────────────

function metaFilePath(vaultDir: string, key: string): string {
  return path.join(vaultDir, "_meta", `${key}.md`);
}

export interface VaultEntryMeta {
  description?: string;
  created?: string;
  forgottenAt?: string;
}

/**
 * Read a single key's _meta/<key>.md without decrypting the secret. Returns
 * null if the meta file is missing. Used by authorization prompts to surface
 * the human-readable description, and by callers that already know which key
 * they want (cheaper than walking the whole vault via listSecrets).
 */
export function readVaultEntryMeta(abrainHome: string, scope: VaultScope, key: string): VaultEntryMeta | null {
  validateKey(key);
  const vaultDir = vaultDirForScope(abrainHome, scope);
  const metaPath = metaFilePath(vaultDir, key);
  if (!fs.existsSync(metaPath)) return null;
  try {
    const content = fs.readFileSync(metaPath, "utf8");
    const description = content.match(/^description:\s*(.+)$/m)?.[1]?.trim();
    const created = content.match(/^created:\s*(.+)$/m)?.[1]?.trim();
    let forgottenAt: string | undefined;
    const forgottenLines = content.match(/^- (\S+)\s+\|\s+forgotten\b/gm);
    if (forgottenLines && forgottenLines.length > 0) {
      const m = forgottenLines[forgottenLines.length - 1]!.match(/^- (\S+)/);
      if (m) forgottenAt = m[1]!;
    }
    return { description, created, forgottenAt };
  } catch {
    return null;
  }
}

interface TimelineRow {
  ts: string;
  op: "created" | "rotated" | "forgotten";
  scope: string;
  size?: number;
  by?: string;
  description?: string;
}

function appendMetaTimeline(vaultDir: string, key: string, row: TimelineRow, header?: { description?: string; scope: string; created: string }): void {
  const f = metaFilePath(vaultDir, key);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });

  if (!fs.existsSync(f)) {
    if (!header) throw new Error(`_meta/${key}.md missing and no header provided`);
    const lines = [
      `# Vault key: ${key}`,
      ``,
      `scope: ${header.scope}`,
      `created: ${header.created}`,
    ];
    if (header.description) lines.push(`description: ${header.description}`);
    lines.push(``, `## Timeline`, ``);
    fs.writeFileSync(f, lines.join("\n") + "\n", { mode: 0o600 });
  }

  // build the timeline line
  const parts: string[] = [`- ${row.ts}`, `${row.op}`, `scope=${row.scope}`];
  if (row.size != null) parts.push(`size=${row.size}B`);
  if (row.by) parts.push(`by=${row.by}`);
  if (row.description) parts.push(`description="${row.description.replace(/"/g, "\\\"")}"`);
  const line = parts.join(" | ") + "\n";

  const fd = fs.openSync(f, "a", 0o600);
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// ── public API: writeSecret ─────────────────────────────────────

/**
 * Atomically write a secret to the vault, encrypting with the configured
 * vault public key. Implements §6.4.0 + §6.4.0.1 inv1-7.
 *
 * Returns the absolute path of the encrypted file written.
 */
export async function writeSecret(opts: WriteSecretOptions): Promise<{ encryptedPath: string }> {
  validateKey(opts.key);

  const pubkeyPath = path.join(opts.abrainHome, VAULT_PUBKEY);
  if (!fs.existsSync(pubkeyPath)) {
    throw new Error(`vault not initialized (no ${VAULT_PUBKEY}). run /vault init first.`);
  }
  const pubkey = fs.readFileSync(pubkeyPath, "utf8").trim();

  const vaultDir = vaultDirForScope(opts.abrainHome, opts.scope);
  fs.mkdirSync(vaultDir, { recursive: true, mode: 0o700 });

  const lockFile = path.join(vaultDir, VAULT_LOCK);
  const encryptedPath = path.join(vaultDir, `${opts.key}.md.age`);
  // Tmp filename includes pid + a random suffix so that two same-process
  // parallel writeSecret calls (serialized by flock) don't reuse the same
  // tmp path — the second call's chmod() would otherwise ENOENT after the
  // first call's atomic rename consumed the file. Caught by P0c.write smoke.
  const tmpPath = `${encryptedPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;

  let lock: LockHandle | null = null;
  let valueBuf: Buffer | null = Buffer.isBuffer(opts.value) ? opts.value : Buffer.from(opts.value, "utf8");

  try {
    lock = await acquireLock(lockFile);

    // (1) age -r <pubkey> with stdin=value, stdout to tmpPath fd
    await runAgeEncryptToFile(pubkey, valueBuf, tmpPath);
    fs.chmodSync(tmpPath, 0o600); // belt-and-suspenders before rename

    // (2) atomic rename (POSIX rename is atomic on same filesystem)
    fs.renameSync(tmpPath, encryptedPath);
    fs.chmodSync(encryptedPath, 0o600); // ensure final file is 0600 too

    // fsync the directory so the rename is durable
    const dirFd = fs.openSync(vaultDir, "r");
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }

    const sizeForAudit = valueBuf.length;
    const isRotate = fs.existsSync(metaFilePath(vaultDir, opts.key));
    const ts = new Date().toISOString();
    const scopeStr = opts.scope === "global" ? "global" : `project:${opts.scope.project}`;

    // (3) _meta/<key>.md append
    if (isRotate) {
      appendMetaTimeline(vaultDir, opts.key, {
        ts, op: "rotated", scope: scopeStr, size: sizeForAudit,
      });
    } else {
      appendMetaTimeline(vaultDir, opts.key, {
        ts, op: "created", scope: scopeStr, size: sizeForAudit, description: opts.description,
      }, {
        scope: scopeStr,
        created: ts,
        description: opts.description,
      });
    }

    // (4) vault-events.jsonl append
    await appendVaultEvent(opts.abrainHome, {
      ts,
      op: isRotate ? "rotate" : "create",
      scope: scopeStr,
      key: opts.key,
      size: sizeForAudit,
      description: opts.description,
    });

    return { encryptedPath };
  } finally {
    // clean up tmp if rename never happened
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    // best-effort zero-out value buffer (does not protect against GC copies
    // that may already exist in the V8 heap, but reduces residual exposure)
    if (valueBuf) valueBuf.fill(0);
    valueBuf = null;
    if (lock) lock.release();
  }
}

// Round 9 P1 (deepseek R9 P1-1 fix): all vault subprocesses (age,
// shred, decrypt, keygen) used to have NO timeout. If age blocks on a
// /dev/tty read (e.g. passphrase-only backend without TTY) or shred
// stalls on a slow disk, pi's main thread hangs forever in `await`.
// 30s is generous for age/shred on local fs, fail-loud beats infinite
// hang. SIGKILL is intentional: SIGTERM may not interrupt a stalled
// /dev/tty read.
const VAULT_SUBPROCESS_TIMEOUT_MS = 30_000;

/** Run `age -r <pubkey>` with input via stdin, writing envelope to outPath. */
function runAgeEncryptToFile(pubkey: string, input: Buffer, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // pubkey via -r argv is fine: it's a public key, NOT a secret.
    // outPath via -o argv is fine: filename, not content.
    // input (the secret value) via stdin pipe — never argv.
    const child = spawn("age", ["-r", pubkey, "-o", outPath], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, VAULT_SUBPROCESS_TIMEOUT_MS);
    child.stderr?.on("data", (b: Buffer) => (stderr += b.toString("utf8")));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`age -r timed out after ${VAULT_SUBPROCESS_TIMEOUT_MS}ms (no TTY? backend misconfigured?)`));
      else if (code === 0) resolve();
      else reject(new Error(`age -r failed: ${stderr.trim() || `exit ${code}`}`));
    });
    if (child.stdin) {
      child.stdin.end(input);
    }
  });
}

// ── public API: listSecrets ─────────────────────────────────────

/**
 * Returns metadata for all secrets in the given scope. Does NOT decrypt
 * any value (P0c.write is metadata-only listing).
 */
export function listSecrets(abrainHome: string, scope: VaultScope): ListSecretsResult[] {
  const vaultDir = vaultDirForScope(abrainHome, scope);
  if (!fs.existsSync(vaultDir)) return [];

  const metaDir = path.join(vaultDir, "_meta");
  if (!fs.existsSync(metaDir)) return [];

  const results: ListSecretsResult[] = [];
  for (const f of fs.readdirSync(metaDir)) {
    if (!f.endsWith(".md")) continue;
    const key = f.slice(0, -".md".length);
    try {
      validateKey(key);
    } catch { continue; /* skip malformed names */ }

    const metaPath = path.join(metaDir, f);
    const encryptedPath = path.join(vaultDir, `${key}.md.age`);

    let created: string | undefined;
    let description: string | undefined;
    let forgottenAt: string | undefined;
    try {
      const content = fs.readFileSync(metaPath, "utf8");
      const createdMatch = content.match(/^created:\s*(.+)$/m);
      if (createdMatch) created = createdMatch[1]!.trim();
      const descMatch = content.match(/^description:\s*(.+)$/m);
      if (descMatch) description = descMatch[1]!.trim();

      // Parse the most recent forgotten timeline row (v1.4.4 dogfood):
      // user expectation is `[forgotten] (since <forgotten ts>)`, not <created>.
      // Timeline row format: `- <ISO ts> | forgotten | scope=... | by=...`
      const forgottenLines = content.match(/^- (\S+)\s+\|\s+forgotten\b/gm);
      if (forgottenLines && forgottenLines.length > 0) {
        // last match = most recent forgotten ts (rows append-only chronologically)
        const lastLine = forgottenLines[forgottenLines.length - 1]!;
        const m = lastLine.match(/^- (\S+)/);
        if (m) forgottenAt = m[1]!;
      }
    } catch { /* read failure is non-fatal — return key with minimal metadata */ }

    results.push({
      scope,
      key,
      encryptedPath,
      created,
      description,
      forgotten: !fs.existsSync(encryptedPath),
      forgottenAt,
    });
  }
  return results;
}

// ── public API: forgetSecret ────────────────────────────────────

/**
 * Real-forget per spec §6.9: rm encrypted file (best-effort shred); append
 * 'forget' row to _meta/<key>.md timeline; append 'forget' row to vault-events.
 * The _meta file is RETAINED so audit history persists.
 */
/** Round 7 P0 (gpt-5.5 audit fix): forget outcome is tri-state.
 *  - `removed`: encrypted file deleted (shred or fallback unlink succeeded)
 *  - `absent`: no encrypted file existed to begin with (clean no-op)
 *  - `removal_failed`: encrypted file exists but both shred and unlink
 *    threw / failed (errno=EACCES, EBUSY, read-only fs, kernel lock). The
 *    plaintext is still recoverable by anyone with the recipient key.
 *  Previously this returned `{ removed: false }` indiscriminately for both
 *  "absent" and "removal_failed" — the handler then reported "was not
 *  present (no-op)", a serious security misreport. */
export type ForgetOutcome =
  | { status: "removed" }
  | { status: "absent" }
  | { status: "removal_failed"; error: string };

export async function forgetSecret(abrainHome: string, scope: VaultScope, key: string): Promise<ForgetOutcome> {
  validateKey(key);

  const vaultDir = vaultDirForScope(abrainHome, scope);
  const encryptedPath = path.join(vaultDir, `${key}.md.age`);
  const lockFile = path.join(vaultDir, VAULT_LOCK);

  let lock: LockHandle | null = null;
  try {
    lock = await acquireLock(lockFile);

    let outcome: ForgetOutcome;
    if (!fs.existsSync(encryptedPath)) {
      outcome = { status: "absent" };
    } else {
      // attempt shred; fall back to unlink. Capture root-cause errors.
      let shredErr: string | null = null;
      let unlinkErr: string | null = null;
      try {
        await new Promise<void>((res, rej) => {
          const c = spawn("shred", ["-u", encryptedPath], { stdio: "ignore" });
          // R9 P1: 30s timeout (above). shred on a huge file or slow
          // disk could theoretically take this long; if so it's better
          // to fall through to unlink than hang the user.
          let timedOut = false;
          const timer = setTimeout(() => {
            timedOut = true;
            try { c.kill("SIGKILL"); } catch { /* already exited */ }
          }, VAULT_SUBPROCESS_TIMEOUT_MS);
          c.on("error", (e) => { clearTimeout(timer); rej(e); });
          c.on("close", (code) => {
            clearTimeout(timer);
            if (timedOut) rej(new Error(`shred timed out after ${VAULT_SUBPROCESS_TIMEOUT_MS}ms—falling back to unlink`));
            else if (code === 0) res();
            else rej(new Error(`shred exit ${code}`));
          });
        });
      } catch (e: unknown) {
        shredErr = e instanceof Error ? e.message : String(e);
      }
      // Whether shred succeeded or not, double-check file is gone. If shred
      // succeeded the file is shredded+unlinked; if it failed we try plain
      // unlink as fallback.
      if (fs.existsSync(encryptedPath)) {
        try { fs.unlinkSync(encryptedPath); } catch (e: unknown) {
          unlinkErr = e instanceof Error ? e.message : String(e);
        }
      }
      if (fs.existsSync(encryptedPath)) {
        // Both attempts left the file in place — plaintext still recoverable.
        outcome = {
          status: "removal_failed",
          error: [shredErr && `shred: ${shredErr}`, unlinkErr && `unlink: ${unlinkErr}`]
            .filter(Boolean).join("; ") || "unknown removal failure",
        };
      } else {
        outcome = { status: "removed" };
      }
    }

    const ts = new Date().toISOString();
    const scopeStr = scope === "global" ? "global" : `project:${scope.project}`;

    // Only write "forgotten" timeline + "forget" audit when the encrypted
    // file is actually gone (status === "removed" or "absent"). On
    // removal_failed we write a distinct `forget_failed` audit row so the
    // attempt is captured but downstream tooling doesn't conflate it with
    // a successful forget.
    if (outcome.status === "removed" || outcome.status === "absent") {
      if (fs.existsSync(metaFilePath(vaultDir, key))) {
        appendMetaTimeline(vaultDir, key, {
          ts, op: "forgotten", scope: scopeStr, by: process.env.USER ?? "unknown",
        });
      }
      await appendVaultEvent(abrainHome, {
        ts, op: "forget", scope: scopeStr, key,
      });
    } else {
      // removal_failed: audit the attempt, do NOT mark forgotten.
      await appendVaultEvent(abrainHome, {
        ts, op: "forget_failed", scope: scopeStr, key, error: outcome.error,
      } as VaultEvent);
    }

    return outcome;
  } finally {
    if (lock) lock.release();
  }
}

// ── public API: reconcile ───────────────────────────────────────

/**
 * Crash recovery (§6.4.0 P0-A fix): scan all *.md.age files in vault dirs
 * vs the most recent vault-events.jsonl. If a file's mtime is newer than
 * any 'create'/'rotate' audit row for that key, append a
 * `recovered_missing_audit` row.
 *
 * Runs once at vaultWriter init (NOT in the hot write path).
 *
 * Returns count of recovered rows appended.
 */
export async function reconcile(abrainHome: string): Promise<{ recovered: number; scanned: number }> {
  const eventsPath = path.join(abrainHome, VAULT_EVENTS);

  // Build map: key+scope → latest "create"|"rotate" event ts
  const lastEvent: Map<string, string> = new Map(); // key = scope::keyname → ts
  if (fs.existsSync(eventsPath)) {
    const lines = fs.readFileSync(eventsPath, "utf8").split("\n");
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const ev = JSON.parse(ln) as VaultEvent;
        if (ev.op === "create" || ev.op === "rotate" || ev.op === "recovered_missing_audit") {
          const k = `${ev.scope}::${ev.key}`;
          const existing = lastEvent.get(k);
          if (!existing || existing < ev.ts) lastEvent.set(k, ev.ts);
        } else if (ev.op === "forget") {
          // forget removes the file, so we shouldn't recover an audit for
          // a key that's been forgotten. mark it as "post-forget" with
          // far-future ts so any actual file mtime won't trigger.
          const k = `${ev.scope}::${ev.key}`;
          lastEvent.set(k, "9999-12-31T23:59:59Z");
        }
      } catch { /* malformed line — skip */ }
    }
  }

  // Scan vault dirs (global + all project vaults that exist)
  const vaultDirs: Array<{ scope: VaultScope; dir: string }> = [];
  const globalDir = path.join(abrainHome, "vault");
  if (fs.existsSync(globalDir)) vaultDirs.push({ scope: "global", dir: globalDir });

  const projectsRoot = path.join(abrainHome, "projects");
  if (fs.existsSync(projectsRoot)) {
    for (const proj of fs.readdirSync(projectsRoot)) {
      const pvDir = path.join(projectsRoot, proj, "vault");
      if (fs.existsSync(pvDir)) vaultDirs.push({ scope: { project: proj }, dir: pvDir });
    }
  }

  let recovered = 0;
  let scanned = 0;
  for (const { scope, dir } of vaultDirs) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md.age")) continue;
      const key = f.slice(0, -".md.age".length);
      try { validateKey(key); } catch { continue; }
      scanned++;

      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      const fileTs = stat.mtime.toISOString();

      const scopeStr = scope === "global" ? "global" : `project:${scope.project}`;
      const k = `${scopeStr}::${key}`;
      const lastTs = lastEvent.get(k);

      // If no audit row exists OR file mtime is newer than last audit ts,
      // we're missing an audit row.
      if (!lastTs || fileTs > lastTs) {
        await appendVaultEvent(abrainHome, {
          ts: new Date().toISOString(),
          op: "recovered_missing_audit",
          scope: scopeStr,
          key,
          recovered_ts: fileTs,
        });
        recovered++;
      }
    }
  }

  return { recovered, scanned };
}
