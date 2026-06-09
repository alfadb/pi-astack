/**
 * abrain — vault bootstrap orchestration (P0b).
 *
 * Implements the §3 master key generation flow from
 * docs/migration/vault-bootstrap.md, following the §3.1 implementation
 * invariants:
 *
 *   inv1: transactional order (mktemp → keygen → encrypt → backend/pubkey
 *         files → cleanup); cleanup always runs in finally
 *   inv2: secrets never via argv (stdin pipe or file path only);
 *         exception: macOS `security` has no stdin mode (known trade-off)
 *   inv3: install tmp dir is STRICTLY ~/.abrain/.state/install/...,
 *         never /tmp (tmpfs / NFS make shred a no-op)
 *   inv4: cleanup runs in finally — error path also shreds
 *   inv5: keychain vs file backend distinction is explicit (vault-bootstrap §5
 *         table); we don't write .vault-master.age for keychain backends
 *   inv6: ssh-key path is the e2e-tested one; others are mock-only until
 *         real-host smoke is added
 *
 * P0b scope: generateMasterKey + cleanupInstallDir + createInstallTmpDir.
 * Keychain dispatch lives in keychain.ts; orchestration that ties it all
 * together for `/vault init` lives in index.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawn, type SpawnOptions } from "node:child_process";

// ── types ───────────────────────────────────────────────────────

export interface KeyGenResult {
  /** absolute path of the generated secret key file (caller MUST shred) */
  secretKeyPath: string;
  /** age public key string (e.g. "age1xxx...") — safe to retain in memory */
  publicKey: string;
}

// ── helpers ─────────────────────────────────────────────────────

/**
 * Spawn a process and capture stdout + stderr as buffers. No shell.
 *
 * Resolves with { stdout, stderr, code } on exit. Rejects on spawn error.
 * Does NOT reject on non-zero exit — caller decides how to handle.
 */
// Round 9 P1 (deepseek R9 P1-1 fix): execCapture is the injected exec
// behind keychain.ts — it runs age / gpg / security / secret-tool /
// pass during /vault init. Any of these can hang indefinitely:
//   - gpg without GPG_TTY set prompts for passphrase (blocks)
//   - age -p (passphrase backend) reads /dev/tty (blocks without TTY)
//   - secret-tool waits for unlocked D-Bus secret service
//   - macOS `security add-generic-password` prompts on first use
// 60s timeout: longer than vault-writer/reader (30s) because keychain
// bootstrap is interactive-first-use and some backends need real time
// for cryptographic generation (age-keygen / gpg --gen-key).
const BOOTSTRAP_SUBPROCESS_TIMEOUT_MS = 60_000;

export function execCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { input?: Buffer | string; timeoutMs?: number } = {},
): Promise<{ stdout: Buffer; stderr: Buffer; code: number | null }> {
  return new Promise((resolve, reject) => {
    const { input, timeoutMs, ...spawnOpts } = opts;
    const stdio: SpawnOptions["stdio"] = input != null ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
    const child = spawn(cmd, args, { ...spawnOpts, stdio });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const limit = timeoutMs ?? BOOTSTRAP_SUBPROCESS_TIMEOUT_MS;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }, limit);
    child.stdout?.on("data", (b: Buffer) => stdout.push(b));
    child.stderr?.on("data", (b: Buffer) => stderr.push(b));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${limit}ms (no TTY for passphrase prompt? backend unavailable?)`));
        return;
      }
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), code });
    });
    if (input != null && child.stdin) {
      child.stdin.end(input);
    }
  });
}

// ── install tmp dir (inv3) ──────────────────────────────────────

/**
 * Create a per-init temp dir under ~/.abrain/.state/install/.
 * Strict invariant 3: never falls back to /tmp.
 *
 * Returns the absolute path of the new directory (mode 0700).
 * Throws if the parent dir cannot be created or is not under abrainHome.
 */
export function createInstallTmpDir(abrainHome: string): string {
  // Parent path: ~/.abrain/.state/install/
  const parent = path.join(abrainHome, ".state", "install");

  // SAFETY: parent must resolve under abrainHome (defense against caller
  // passing a relative or escape-laden home path)
  const resolvedHome = path.resolve(abrainHome);
  const resolvedParent = path.resolve(parent);
  if (!resolvedParent.startsWith(resolvedHome + path.sep)) {
    throw new Error(`install tmp parent escapes abrain home: ${resolvedParent}`);
  }

  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  // mkdtemp creates with random suffix; equivalent to `mktemp -d -p $parent init-XXXXXX`
  const dir = fs.mkdtempSync(path.join(parent, "init-"));
  // mkdtemp uses default mode (0700 on linux per node docs); enforce explicitly
  fs.chmodSync(dir, 0o700);
  return dir;
}

// ── master key generation (inv1, step 1) ────────────────────────

export function posixModeChecksEnabled(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

/**
 * Run `age-keygen -o <secretKeyPath>` and parse the public key from stderr.
 *
 * age-keygen output format (verified against age v1.3.1):
 *   - secret key written to the -o file (single line: AGE-SECRET-KEY-1...)
 *   - public key printed to stderr: "Public key: age1xxx..."
 *
 * The secret key file is left at secretKeyPath. Caller is responsible for
 * shredding it via cleanupInstallDir before returning from /vault init.
 */
export async function generateMasterKey(installTmpDir: string): Promise<KeyGenResult> {
  const secretKeyPath = path.join(installTmpDir, "master.age");

  // Defense: install dir must exist and be 0700 owned by us
  const stat = fs.statSync(installTmpDir);
  if (!stat.isDirectory()) throw new Error(`install dir not a directory: ${installTmpDir}`);
  // mode bits: only check that it's at most 0700 (not group/other readable)
  if (posixModeChecksEnabled() && (stat.mode & 0o077) !== 0) {
    throw new Error(`install dir mode too permissive: ${(stat.mode & 0o777).toString(8)}; expected 0700`);
  }

  const { stdout, stderr, code } = await execCapture("age-keygen", ["-o", secretKeyPath]);
  if (code !== 0) {
    throw new Error(`age-keygen exit ${code}: ${stderr.toString("utf8") || stdout.toString("utf8")}`);
  }

  // Parse public key from stderr. age v1.3.1 prints exactly:
  //   "Public key: age1xxxx...\n"
  const stderrText = stderr.toString("utf8");
  const m = stderrText.match(/Public key:\s+(\S+)/);
  if (!m) {
    throw new Error(`age-keygen stderr did not contain 'Public key:' line:\n${stderrText}`);
  }
  const publicKey = m[1]!;

  // Sanity check: secret file should exist and be non-empty
  const secStat = fs.statSync(secretKeyPath);
  if (!secStat.isFile() || secStat.size === 0) {
    throw new Error(`age-keygen did not write secret key to ${secretKeyPath}`);
  }

  // Tighten secret file mode (age-keygen sets 0600 already, belt-and-suspenders)
  fs.chmodSync(secretKeyPath, 0o600);

  return { secretKeyPath, publicKey };
}

// ── cleanup (inv4) ──────────────────────────────────────────────

/**
 * Best-effort destruction of the install tmp directory and its contents.
 *
 * Strategy (per file):
 *   1. Try `shred -u`. If shred succeeds, file is gone (with overwrite passes).
 *   2. If shred is missing or fails (e.g. tmpfs detected too late),
 *      fall back to manual overwrite-with-random + fsync + unlink.
 *   3. If even unlink fails, swallow — log warning at caller layer.
 *
 * Then rmdir. NEVER throws — cleanup is in finally of /vault init's main
 * flow and must not mask the original error.
 *
 * Returns a list of warning messages (paths that could not be fully shredded).
 */
export async function cleanupInstallDir(installTmpDir: string): Promise<string[]> {
  const warnings: string[] = [];

  if (!fs.existsSync(installTmpDir)) return warnings;

  let entries: string[];
  try {
    entries = fs.readdirSync(installTmpDir);
  } catch (err: any) {
    warnings.push(`readdir failed: ${err.message}`);
    return warnings;
  }

  for (const name of entries) {
    const full = path.join(installTmpDir, name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue; // already gone
    }
    if (stat.isDirectory()) {
      // not expected (install dir is flat) but handle defensively
      try { fs.rmSync(full, { recursive: true, force: true }); } catch (err: any) {
        warnings.push(`rm subdir ${full}: ${err.message}`);
      }
      continue;
    }

    // 1. try shred
    let shredded = false;
    try {
      const { code } = await execCapture("shred", ["-u", "-z", full]);
      shredded = code === 0;
    } catch {
      shredded = false;
    }

    if (shredded) continue;

    // 2. manual overwrite + unlink
    try {
      manualOverwriteAndUnlink(full, stat.size);
    } catch (err: any) {
      // 3. last resort: just unlink (no overwrite)
      try {
        fs.unlinkSync(full);
        warnings.push(`overwrite failed for ${full}, fell back to bare unlink (secret may be recoverable on disk): ${err.message}`);
      } catch (err2: any) {
        warnings.push(`could not delete ${full}: ${err2.message}`);
      }
    }
  }

  // remove the dir itself
  try {
    fs.rmdirSync(installTmpDir);
  } catch (err: any) {
    warnings.push(`rmdir ${installTmpDir}: ${err.message}`);
  }

  return warnings;
}

/**
 * Fallback secret destroyer when `shred` is unavailable or fails.
 * Overwrite with random bytes, fsync, then unlink. Synchronous on purpose
 * so we don't context-switch with secret bytes still in flight.
 */
function manualOverwriteAndUnlink(file: string, size: number): void {
  if (size === 0) {
    fs.unlinkSync(file);
    return;
  }
  const fd = fs.openSync(file, "r+");
  try {
    // Write in 64KB chunks
    const chunk = Buffer.alloc(Math.min(size, 65536));
    let written = 0;
    while (written < size) {
      crypto.randomFillSync(chunk);
      const remain = size - written;
      const n = Math.min(chunk.length, remain);
      fs.writeSync(fd, chunk, 0, n, written);
      written += n;
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(file);
}
