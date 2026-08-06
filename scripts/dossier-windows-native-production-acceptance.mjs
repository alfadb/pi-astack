#!/usr/bin/env node
/**
 * Windows native production acceptance dossier (P4 external evidence).
 *
 * Architecture: controller / closed workers
 * - Controller NEVER dlopen/require()'s any .node (live or temp).
 * - Each case is an independent child with bounded JSON stdout + hard temp cleanup.
 * - Workers assert PI_ASTACK_ENABLE_TEST_HOOKS is undefined; no __TEST / override /
 *   deps injection / ALS. Production zero-arg APIs only.
 * - Does not write ~/.abrain (before/after guard). Output is a single JSON object
 *   on stdout; never writes into the repo.
 *
 * Two distinct conclusions (never conflate):
 * 1) extension_windows_adaptation — local, mechanically verifiable Windows extension
 *    gates: artifact lineage + provenance/native package_rx + retained + DACL +
 *    stable + edge (+ structural same-fd rehash / threat-model documentation).
 *    Pass here means extension-scope adaptation evidence only.
 * 2) overall production accepted (`accepted` + top-level `status`) — requires
 *    daemon DCC live coverage, live matrix roots, Linux zero-regression, second-
 *    account DACL tamper, and Node>=22.19 + Windows Server external evidence.
 *    Those external/daemon items are closed blocking residuals and are DEFERRED
 *    until after daemon redesign. This dossier intentionally has NO env/manifest
 *    switch that can flip overall accepted:true. Overall remains accepted:false
 *    / status partial whenever deferred residuals are present.
 *
 * Mechanical gates for extension_windows_adaptation:
 * - runtime win32-x64
 * - git worktree clean (no arbitrary source drift / dirty tree)
 * - pin + package artifacts tracked and present in HEAD (content-bound)
 * - auditable artifact lineage:
 *     source_commit (pin) is an ancestor of HEAD;
 *     there exists artifact commit A on HEAD's history whose tree for the three
 *     package outputs matches the live pin/manifest/binary content;
 *     source_commit..A is exactly the three package outputs;
 *     A..HEAD may only contain docs/evidence commits (docs/** paths);
 *     arbitrary source-closure drift after artifact ⇒ fail.
 * - production package_rx three-point (dir/binary/manifest) via zero-arg load
 *
 * Threat model (user-confirmed; not a global "TOCTOU must be atomic" blocker):
 * same TokenUser + admin malice out of loader contract; other principals fail-closed;
 * hash/pin/package_rx = provenance + corruption detection; no small bootstrap.
 *
 * Cross-host first-matrix external evidence ingestion/schema/slot validators are
 * NOT implemented in this round (unreliable; redesign after daemon refactor).
 *
 * --self-test: dirty-tree static + lineage unit negatives + real temp git DAG +
 *   deferred-matrix / overall-never-green assertions + worker env probe only.
 *   No matrix schema fixtures, no pseudo command evidence, no external hosts.
 *   Must NOT emit accepted:true and must not claim production acceptance.
 *
 * exit 0 = dossier execution completed (JSON emitted) or self-test passed.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const packageDir = path.join(repoRoot, "native", "windows", "win32-x64");
const binaryPath = path.join(packageDir, "pi-astack-windows-native.node");
const manifestPath = path.join(packageDir, "manifest.json");
const pinPath = path.join(repoRoot, "extensions", "_shared", "windows-native-addon-pin.ts");

/** Production root resolution: ABRAIN_ROOT if set, else ~/.abrain. Never leak raw path. */
function resolveLiveAbrainRoot() {
  const raw = process.env.ABRAIN_ROOT;
  if (typeof raw === "string" && raw.length > 0) {
    const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
    return { root: path.resolve(expanded), root_source: "ABRAIN_ROOT" };
  }
  return { root: path.resolve(os.homedir(), ".abrain"), root_source: "home_default" };
}
const liveAbrainResolved = resolveLiveAbrainRoot();
const liveAbrain = liveAbrainResolved.root;
const liveAbrainRootSource = liveAbrainResolved.root_source;

const DOSSIER_VERSION = "windows-native-production-acceptance/v1";
const WORKER_MODES = new Set([
  "self-test-probe",
  "provenance-load",
  "retained-lock",
  "dacl",
  "stable-view",
  "edge",
  "dcc",
]);

const CLOSED_DACL_DENY_RE =
  /WINDOWS_NATIVE_ADDON_(DACL_INVALID|ACCESS_DENIED|ANCESTOR_REPARSE|REPARSE|NOT_FILE|NOT_DIRECTORY|IDENTITY_CHANGED|FAILED)/;
const CLOSED_DACL_MISMATCH_RE =
  /WINDOWS_NATIVE_ADDON_(DACL_INVALID|ACCESS_DENIED|NOT_FILE|NOT_DIRECTORY|IDENTITY_CHANGED|FAILED|INVALID_PATH)/;
/** Reader closed reason union (runtime ok:false / selection + Windows map). */
const CLOSED_STABLE_LOUD_REASONS = new Set([
  // selection / top-level
  "ephemeral_session",
  "selected_valid",
  // latest / root
  "latest_missing",
  "latest_invalid",
  "latest_tampered",
  "latest_not_regular",
  "latest_not_symlink",
  "foreign_root",
  "unsafe_path",
  // bundle / artifact
  "partial_or_foreign",
  "bundle_missing",
  "artifact_missing",
  "artifact_invalid",
  "artifact_tampered",
  "artifact_hash_mismatch",
  // windows / envelope
  "windows_native_unavailable",
  "selection_time_invalid",
  "oversize",
  "statement_oversize",
  "payload_oversize",
  // identity / provenance (reader fail codes)
  "manifest_invalid",
  "manifest_identity",
  "manifest_hash_mismatch",
  "view_invalid",
  "view_identity",
  "view_provenance",
  "view_item_hash",
  "view_md_mismatch",
  "source_provenance",
  "projection_provenance",
  "decision_provenance",
  "compiler_identity",
  "compiler_profile",
  "stable_contract",
  "source_closure",
  "item_limit",
  "scope_invalid",
  "diagnostics",
  "source_conservation",
  "parity",
  "read_failed",
]);

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Fail-closed worker error: never process.exit here — top-level catch emits + cleans. */
class WorkerFail extends Error {
  constructor(code, message) {
    super(String(message || code));
    this.name = "WorkerFail";
    this.code = String(code || "WORKER_FAIL");
  }
}

function dieWorker(code, message) {
  throw new WorkerFail(code, message);
}

function assertHooksAbsent() {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== undefined) {
    dieWorker("TEST_HOOKS_PRESENT", "PI_ASTACK_ENABLE_TEST_HOOKS must be undefined in production workers");
  }
}

function loadJiti(rel) {
  const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
  return jiti(path.join(repoRoot, rel));
}

function hardRm(root) {
  if (!root) return;
  try {
    if (fs.existsSync(root)) {
      spawnSync("icacls.exe", [root, "/reset", "/T", "/C", "/Q"], { windowsHide: true, encoding: "utf8" });
      const user = os.userInfo().username;
      spawnSync("icacls.exe", [root, "/grant", `${user}:(OI)(CI)F`, "/T", "/C", "/Q"], {
        windowsHide: true,
        encoding: "utf8",
      });
    }
  } catch {
    // ACL reset best-effort before delete
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (e) {
    throw new Error(`hardRm failed: ${e?.message || e}`);
  }
  if (fs.existsSync(root)) throw new Error("hardRm residual");
}

function tempRoot(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-win-prod-${label}-`));
  if (root === liveAbrain || root.startsWith(liveAbrain + path.sep)) {
    throw new Error(`temp under live ~/.abrain: ${root}`);
  }
  return root;
}

/** Live ~/.abrain guard: bounded recursive aggregate over dossier-relevant trees only.
 *  Output is count+sha256 only (no path/content leak). Includes hidden entries.
 *  Over entry/byte caps → invalid (accepted must stay false). */
const ABRAIN_GUARD_RELATIVE_ROOTS = [
  ".state/sediment/proposition-policy-stable-view",
  ".state/sediment/proposition-policy-stable-view-recovery",
  ".state/sediment/edge-protocol-shadow",
  ".state/sediment/canonical-convergence",
  ".state/sediment/local-executor-authority",
];
const ABRAIN_GUARD_MAX_ENTRIES = 4096;
const ABRAIN_GUARD_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const ABRAIN_GUARD_SMALL_FILE_BYTES = 64 * 1024;

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(Number(pid))) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
}

function snapshotAbrainGuard() {
  const h = createHash("sha256");
  let count = 0;
  let totalBytes = 0;
  let valid = true;
  let invalid_reason = null;

  const pushLine = (line) => {
    h.update(line);
    h.update("\n");
  };

  // Stable root list (relative) always contributes to preimage even if absent.
  for (const rel of ABRAIN_GUARD_RELATIVE_ROOTS) {
    pushLine(`root|${rel}`);
  }

  if (!fs.existsSync(liveAbrain)) {
    return { count: 0, sha256: h.digest("hex"), valid: true, invalid_reason: null };
  }

  /** @type {{ rel: string, type: string, size: number, mtimeNs: string, contentHash: string }[]} */
  const entries = [];

  const walk = (abs, relPosix) => {
    if (!valid) return;
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (entries.length >= ABRAIN_GUARD_MAX_ENTRIES) {
      valid = false;
      invalid_reason = "max_entries_exceeded";
      return;
    }
    const type = st.isSymbolicLink()
      ? "symlink"
      : st.isDirectory()
        ? "dir"
        : st.isFile()
          ? "file"
          : "other";
    const size = Number(st.size) || 0;
    totalBytes += type === "file" ? size : 0;
    if (totalBytes > ABRAIN_GUARD_MAX_TOTAL_BYTES) {
      valid = false;
      invalid_reason = "max_total_bytes_exceeded";
      return;
    }
    let contentHash = "-";
    if (type === "file" && size <= ABRAIN_GUARD_SMALL_FILE_BYTES) {
      try {
        contentHash = sha256(fs.readFileSync(abs));
      } catch {
        contentHash = "unreadable";
      }
    } else if (type === "file") {
      contentHash = "oversize";
    }
    const mtimeNs = (typeof st.mtimeNs === "bigint")
      ? st.mtimeNs.toString()
      : String(Math.trunc(Number(st.mtimeMs || 0) * 1e6));
    entries.push({
      rel: relPosix,
      type,
      size,
      mtimeNs,
      contentHash,
    });
    if (type === "dir") {
      let names;
      try {
        // Include hidden; do NOT filter dotfiles.
        names = fs.readdirSync(abs);
      } catch {
        return;
      }
      names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const name of names) {
        if (!valid) return;
        const childRel = relPosix ? `${relPosix}/${name}` : name;
        walk(path.join(abs, name), childRel);
      }
    }
  };

  for (const rel of ABRAIN_GUARD_RELATIVE_ROOTS) {
    if (!valid) break;
    const abs = path.join(liveAbrain, ...rel.split("/"));
    if (!fs.existsSync(abs)) {
      pushLine(`absent|${rel}`);
      continue;
    }
    walk(abs, rel);
  }

  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const e of entries) {
    pushLine(`${e.rel}|${e.type}|${e.size}|${e.mtimeNs}|${e.contentHash}`);
  }
  count = entries.length;
  return {
    count,
    sha256: h.digest("hex"),
    valid,
    invalid_reason,
  };
}

function git(args, { allowFail = false } = {}) {
  const r = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (!allowFail && r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return {
    status: r.status,
    stdout: String(r.stdout || "").trim(),
    stderr: String(r.stderr || "").trim(),
  };
}

function detectFsType(probePath) {
  try {
    const drive = path.parse(path.resolve(probePath)).root.replace(/\\/g, "");
    if (!drive) return null;
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-Command", `(Get-Volume -DriveLetter '${drive[0]}').FileSystemType`],
      { encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    const t = String(r.stdout || "").trim();
    return t || null;
  } catch {
    return null;
  }
}

function readPinFromDisk() {
  const text = fs.readFileSync(pinPath, "utf8");
  const m = text.match(/WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256:\s*string\s*\|\s*null\s*=\s*(null|"([0-9a-f]{64})")/);
  const s = text.match(/WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT:\s*string\s*\|\s*null\s*=\s*(null|"([0-9a-f]{40})")/);
  return {
    manifest_sha256: m?.[2] || null,
    source_commit: s?.[2] || null,
    lf: !text.includes("\r"),
  };
}

function trackedInHead(relPosix) {
  const r = git(["ls-tree", "-r", "--name-only", "HEAD", "--", relPosix], { allowFail: true });
  if (r.status !== 0) return false;
  return r.stdout.split(/\r?\n/).filter(Boolean).includes(relPosix);
}

function worktreeClean() {
  const r = git(["status", "--porcelain"], { allowFail: true });
  return r.status === 0 && r.stdout.length === 0;
}

const PACKAGE_OUTPUT_PATHS = Object.freeze([
  "extensions/_shared/windows-native-addon-pin.ts",
  "native/windows/win32-x64/manifest.json",
  "native/windows/win32-x64/pi-astack-windows-native.node",
]);

/** Paths allowed on artifact_commit..HEAD (docs/evidence only). */
function isDocsOrEvidencePath(relPosix) {
  const n = String(relPosix || "").replace(/\\/g, "/");
  return n === "docs" || n.startsWith("docs/");
}

function isPackageOutputPath(relPosix) {
  const n = String(relPosix || "").replace(/\\/g, "/");
  return PACKAGE_OUTPUT_PATHS.includes(n);
}

/** Blob sha1 for a path at a commit (git hash-object equivalent via ls-tree). */
function blobShaAt(commit, relPosix) {
  const r = git(["ls-tree", commit, "--", relPosix], { allowFail: true });
  if (r.status !== 0 || !r.stdout) return null;
  // <mode> <type> <sha>\t<name>
  const m = r.stdout.trim().match(/^\d+\s+blob\s+([0-9a-f]{40})\t/);
  return m ? m[1] : null;
}

function blobShaOfFile(absPath) {
  if (!fs.existsSync(absPath)) return null;
  const r = git(["hash-object", absPath], { allowFail: true });
  return r.status === 0 && /^[0-9a-f]{40}$/.test(r.stdout) ? r.stdout : null;
}

/**
 * Find the newest commit reachable from HEAD at which the three package outputs
 * match the live on-disk/pin content (content-bound artifact commit).
 */
function findArtifactCommit(head, liveBlobShas) {
  // Walk commits that touched any package output; pick newest whose three blobs match live.
  const log = git(
    ["log", "--format=%H", head, "--", ...PACKAGE_OUTPUT_PATHS],
    { allowFail: true },
  );
  if (log.status !== 0) return null;
  const commits = log.stdout.split(/\r?\n/).filter(Boolean);
  for (const c of commits) {
    let ok = true;
    for (const rel of PACKAGE_OUTPUT_PATHS) {
      const at = blobShaAt(c, rel);
      if (!at || at !== liveBlobShas[rel]) {
        ok = false;
        break;
      }
    }
    if (ok) return c;
  }
  return null;
}

/** Pure helpers for lineage classification / self-test (no git required). */
function classifyLineagePath(relPosix) {
  if (isPackageOutputPath(relPosix)) return "package_output";
  if (isDocsOrEvidencePath(relPosix)) return "docs_or_evidence";
  return "source_or_other";
}

function evaluateRangeAgainstAllowlist(names, allowPred) {
  const normalized = names.map((n) => n.replace(/\\/g, "/")).filter(Boolean);
  const foreign = normalized.filter((n) => !allowPred(n));
  return { normalized, foreign, ok: foreign.length === 0 };
}

/** Commits strictly after `from` up to and including `to` (git rev-list from..to). */
function listCommitsExclusive(from, to, gitFn = git) {
  const r = gitFn(["rev-list", "--reverse", `${from}..${to}`], { allowFail: true });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).filter(Boolean);
}

/** Paths changed by a single commit (first parent for merges; rejects merge hiding). */
function pathsChangedByCommit(commit, gitFn = git) {
  // --root handles orphan; -m -1 uses first-parent for merges so merge-introduced paths are visible.
  const r = gitFn(
    ["diff-tree", "--no-commit-id", "--name-only", "-r", "-m", "--root", commit],
    { allowFail: true },
  );
  if (r.status !== 0) return null;
  // For merges, -m emits one block per parent; take unique paths across parents.
  const names = r.stdout
    .split(/\r?\n/)
    .map((n) => n.replace(/\\/g, "/").trim())
    .filter(Boolean);
  return [...new Set(names)];
}

/**
 * Per-commit lineage evaluation (NOT endpoint-only diff).
 * Rejects change-then-rollback and merge-hidden non-allowlisted paths.
 *
 * @param {object} args
 * @param {string} args.sourceCommit
 * @param {string} args.artifactCommit
 * @param {string} args.head
 * @param {(args: string[], opts?: object) => {status:number, stdout:string}} [args.gitFn]
 */
function evaluatePerCommitLineage({
  sourceCommit,
  artifactCommit,
  head,
  gitFn = git,
}) {
  const residuals = [];
  const detail = {
    source_is_ancestor_of_artifact: false,
    artifact_is_ancestor_of_head: false,
    source_to_artifact_commits: [],
    artifact_to_head_commits: [],
    source_to_artifact_ok: false,
    artifact_to_head_ok: false,
  };

  const ancArt = gitFn(
    ["merge-base", "--is-ancestor", sourceCommit, artifactCommit],
    { allowFail: true },
  );
  detail.source_is_ancestor_of_artifact = ancArt.status === 0 && sourceCommit !== artifactCommit;
  if (!detail.source_is_ancestor_of_artifact) {
    residuals.push("source_commit_not_ancestor_of_artifact");
  }

  const ancHead = gitFn(
    ["merge-base", "--is-ancestor", artifactCommit, head],
    { allowFail: true },
  );
  detail.artifact_is_ancestor_of_head = ancHead.status === 0;
  if (!detail.artifact_is_ancestor_of_head) {
    residuals.push("artifact_commit_not_ancestor_of_HEAD");
  }

  if (!detail.source_is_ancestor_of_artifact || !detail.artifact_is_ancestor_of_head) {
    return { ok: false, residuals, detail };
  }

  const artCommits = listCommitsExclusive(sourceCommit, artifactCommit, gitFn);
  if (!artCommits) {
    residuals.push("source_to_artifact_rev_list_failed");
    return { ok: false, residuals, detail };
  }
  detail.source_to_artifact_commits = artCommits;
  // Strict: exactly one commit (the artifact), introducing exactly the three package outputs.
  if (artCommits.length !== 1 || artCommits[0] !== artifactCommit) {
    residuals.push("source_to_artifact_not_exactly_one_artifact_commit");
  } else {
    const paths = pathsChangedByCommit(artifactCommit, gitFn);
    if (!paths) {
      residuals.push("artifact_commit_paths_unreadable");
    } else {
      const evalPaths = evaluateRangeAgainstAllowlist(paths, isPackageOutputPath);
      const exact =
        evalPaths.ok
        && evalPaths.normalized.length === PACKAGE_OUTPUT_PATHS.length
        && PACKAGE_OUTPUT_PATHS.every((n) => evalPaths.normalized.includes(n));
      detail.source_to_artifact_ok = exact;
      if (!exact) residuals.push("source_commit_to_artifact_not_only_package_outputs");
    }
  }

  const postCommits = listCommitsExclusive(artifactCommit, head, gitFn);
  if (!postCommits) {
    residuals.push("artifact_to_head_rev_list_failed");
    return { ok: false, residuals, detail };
  }
  detail.artifact_to_head_commits = postCommits;
  let postOk = true;
  for (const c of postCommits) {
    const paths = pathsChangedByCommit(c, gitFn);
    if (!paths) {
      residuals.push("post_artifact_commit_paths_unreadable");
      postOk = false;
      break;
    }
    const evalPaths = evaluateRangeAgainstAllowlist(paths, isDocsOrEvidencePath);
    if (!evalPaths.ok) {
      residuals.push("post_artifact_non_docs_drift");
      // Distinguish rollback/merge-hidden cases when endpoint-only would look clean.
      residuals.push(`post_artifact_commit_non_docs:${c.slice(0, 12)}`);
      postOk = false;
      break;
    }
  }
  detail.artifact_to_head_ok = postOk && !residuals.includes("post_artifact_non_docs_drift");

  const ok =
    detail.source_to_artifact_ok
    && detail.artifact_to_head_ok
    && residuals.length === 0;
  return { ok, residuals: [...new Set(residuals)], detail };
}

/**
 * Self-test: build a temporary real git DAG covering order, source-change-then-rollback,
 * and merge/non-docs rejection. Does not touch the live repo.
 */
function runLineageGitDagSelfTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-lineage-dag-"));
  const results = {
    order_ok: false,
    rollback_rejected: false,
    merge_non_docs_rejected: false,
  };
  const gitTmp = (args, opts = {}) => {
    const r = spawnSync("git", ["-C", tmp, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
    const stdout = String(r.stdout || "").trim();
    if (!opts.allowFail && r.status !== 0) {
      throw new Error(`git -C tmp ${args.join(" ")} failed: ${r.stderr || stdout}`);
    }
    return { status: r.status ?? 1, stdout };
  };
  try {
    gitTmp(["init", "-b", "main"]);
    gitTmp(["config", "user.email", "lineage-selftest@example.invalid"]);
    gitTmp(["config", "user.name", "lineage-selftest"]);
    // Isolate from global hooks / gpg.
    gitTmp(["config", "commit.gpgsign", "false"]);

    const write = (rel, body) => {
      const abs = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body, "utf8");
    };

    // source commit: base tree with placeholders for package paths + source.
    write("extensions/_shared/windows-native-addon.ts", "source-v1\n");
    write("extensions/_shared/windows-native-addon-pin.ts", "pin-null\n");
    write("native/windows/win32-x64/manifest.json", "{}\n");
    write("native/windows/win32-x64/pi-astack-windows-native.node", "bin-v0\n");
    write("docs/plans/plan.md", "plan\n");
    gitTmp(["add", "."]);
    gitTmp(["commit", "-m", "source"]);
    const source = gitTmp(["rev-parse", "HEAD"]).stdout;

    // artifact commit: exactly three package outputs.
    write("extensions/_shared/windows-native-addon-pin.ts", "pin-live\n");
    write("native/windows/win32-x64/manifest.json", '{"ok":true}\n');
    write("native/windows/win32-x64/pi-astack-windows-native.node", "bin-v1\n");
    gitTmp(["add", "."]);
    gitTmp(["commit", "-m", "artifact"]);
    const artifact = gitTmp(["rev-parse", "HEAD"]).stdout;

    // docs-only after artifact.
    write("docs/plans/plan.md", "plan-updated\n");
    write("docs/evidence/note.md", "evidence\n");
    gitTmp(["add", "."]);
    gitTmp(["commit", "-m", "docs"]);
    const headDocs = gitTmp(["rev-parse", "HEAD"]).stdout;

    const order = evaluatePerCommitLineage({
      sourceCommit: source,
      artifactCommit: artifact,
      head: headDocs,
      gitFn: gitTmp,
    });
    results.order_ok = order.ok === true;

    // Rollback trap: source change then revert — endpoint may look clean, per-commit must reject.
    write("extensions/_shared/windows-native-addon.ts", "source-v2-bad\n");
    gitTmp(["add", "."]);
    gitTmp(["commit", "-m", "bad-source"]);
    write("extensions/_shared/windows-native-addon.ts", "source-v1\n");
    gitTmp(["add", "."]);
    gitTmp(["commit", "-m", "rollback-source"]);
    const headRollback = gitTmp(["rev-parse", "HEAD"]).stdout;
    // Endpoint-only name-only source..HEAD may be empty for the source file, but per-commit sees it.
    const rollback = evaluatePerCommitLineage({
      sourceCommit: source,
      artifactCommit: artifact,
      head: headRollback,
      gitFn: gitTmp,
    });
    results.rollback_rejected =
      rollback.ok === false
      && rollback.residuals.some((r) => r === "post_artifact_non_docs_drift" || r.startsWith("post_artifact_commit_non_docs:"));

    // Reset to docs head and create a merge that introduces non-docs via side branch.
    gitTmp(["reset", "--hard", headDocs]);
    gitTmp(["checkout", "-b", "side"]);
    write("scripts/evil.mjs", "evil\n");
    gitTmp(["add", "."]);
    gitTmp(["commit", "-m", "side-non-docs"]);
    gitTmp(["checkout", "main"]);
    // Merge side into main (no-ff so merge commit exists).
    gitTmp(["merge", "--no-ff", "-m", "merge-side", "side"], { allowFail: true });
    const headMerge = gitTmp(["rev-parse", "HEAD"]).stdout;
    const mergeEval = evaluatePerCommitLineage({
      sourceCommit: source,
      artifactCommit: artifact,
      head: headMerge,
      gitFn: gitTmp,
    });
    results.merge_non_docs_rejected =
      mergeEval.ok === false
      && mergeEval.residuals.some((r) => r === "post_artifact_non_docs_drift" || r.startsWith("post_artifact_commit_non_docs:"));

    return {
      pass: results.order_ok && results.rollback_rejected && results.merge_non_docs_rejected,
      results,
    };
  } catch (error) {
    return {
      pass: false,
      results,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

function evaluateProvenanceGates() {
  const gates = {
    platform_win32_x64: process.platform === "win32" && process.arch === "x64",
    git_clean: worktreeClean(),
    pin_tracked: trackedInHead("extensions/_shared/windows-native-addon-pin.ts"),
    manifest_tracked: trackedInHead("native/windows/win32-x64/manifest.json"),
    binary_tracked: trackedInHead("native/windows/win32-x64/pi-astack-windows-native.node"),
    artifacts_on_disk: fs.existsSync(binaryPath) && fs.existsSync(manifestPath),
    pin_live: false,
    // Legacy names retained as derived views for older readers; lineage is authoritative.
    source_commit_is_head_parent: false,
    range_only_package_outputs: false,
    // New lineage gates (per-commit; not endpoint-only):
    source_commit_is_ancestor: false,
    source_commit_is_ancestor_of_artifact: false,
    artifact_commit_is_ancestor_of_head: false,
    artifact_commit_found: false,
    artifact_range_only_package_outputs: false,
    post_artifact_docs_only: false,
    live_blobs_match_artifact: false,
    package_rx: false,
  };
  const residuals = [];
  const pin = readPinFromDisk();
  gates.pin_live = Boolean(pin.manifest_sha256 && pin.source_commit);
  if (!gates.platform_win32_x64) residuals.push("runtime_not_win32_x64");
  if (!gates.git_clean) residuals.push("git_worktree_dirty");
  if (!gates.pin_tracked) residuals.push("pin_not_in_HEAD");
  if (!gates.manifest_tracked) residuals.push("manifest_not_in_HEAD");
  if (!gates.binary_tracked) residuals.push("binary_not_in_HEAD");
  if (!gates.artifacts_on_disk) residuals.push("artifacts_missing_on_disk");
  if (!gates.pin_live) residuals.push("production_pin_null");

  let head = null;
  let parent = null;
  let artifact_commit = null;
  try {
    head = git(["rev-parse", "HEAD"]).stdout;
    parent = git(["rev-parse", "HEAD^"], { allowFail: true }).stdout || null;
  } catch {
    residuals.push("git_rev_parse_failed");
  }

  let lineage_detail = null;
  if (gates.pin_live && pin.source_commit && head) {
    // source_commit must be a strict ancestor of HEAD (or equal only if rejected below).
    const anc = git(
      ["merge-base", "--is-ancestor", pin.source_commit, head],
      { allowFail: true },
    );
    gates.source_commit_is_ancestor = anc.status === 0;
    if (!gates.source_commit_is_ancestor) {
      residuals.push("source_commit_not_ancestor_of_HEAD");
    }
    if (pin.source_commit === head) {
      // Artifact must be a distinct commit after source; source===HEAD means no package commit yet.
      residuals.push("source_commit_equals_HEAD_rejected");
      gates.source_commit_is_ancestor = false;
    }

    // Content-bound live blob shas (provenance still binds artifact/source content).
    const liveBlobShas = {
      "extensions/_shared/windows-native-addon-pin.ts": blobShaOfFile(pinPath),
      "native/windows/win32-x64/manifest.json": blobShaOfFile(manifestPath),
      "native/windows/win32-x64/pi-astack-windows-native.node": blobShaOfFile(binaryPath),
    };
    if (Object.values(liveBlobShas).some((s) => !s)) {
      residuals.push("live_package_blob_hash_failed");
    } else if (gates.source_commit_is_ancestor) {
      artifact_commit = findArtifactCommit(head, liveBlobShas);
      gates.artifact_commit_found = Boolean(artifact_commit);
      if (!artifact_commit) {
        residuals.push("artifact_commit_not_found_for_live_blobs");
      } else {
        // Live blobs match artifact commit by construction of findArtifactCommit.
        gates.live_blobs_match_artifact = true;

        // Per-commit lineage (rejects rollback / merge-hidden non-docs; not endpoint-only).
        const lineage = evaluatePerCommitLineage({
          sourceCommit: pin.source_commit,
          artifactCommit: artifact_commit,
          head,
        });
        lineage_detail = lineage.detail;
        gates.source_commit_is_ancestor_of_artifact = lineage.detail.source_is_ancestor_of_artifact;
        gates.artifact_commit_is_ancestor_of_head = lineage.detail.artifact_is_ancestor_of_head;
        gates.artifact_range_only_package_outputs = lineage.detail.source_to_artifact_ok;
        gates.post_artifact_docs_only = lineage.detail.artifact_to_head_ok;
        for (const r of lineage.residuals) residuals.push(r);

        // Derived legacy view: true only when artifact is exactly HEAD and source is HEAD^.
        gates.source_commit_is_head_parent = Boolean(parent && pin.source_commit === parent && artifact_commit === head);
        gates.range_only_package_outputs =
          gates.artifact_range_only_package_outputs && artifact_commit === head;
      }
    }
  }

  // package_rx only verifiable via child (controller never dlopens).
  return {
    gates,
    residuals,
    pin,
    head,
    parent,
    artifact_commit,
    lineage: {
      package_output_paths: [...PACKAGE_OUTPUT_PATHS],
      post_artifact_allow: "docs/** only (per-commit)",
      source_commit: pin.source_commit,
      artifact_commit,
      per_commit: lineage_detail,
    },
  };
}


function cleanEnv(base = process.env) {
  const e = { ...base };
  delete e.PI_ASTACK_ENABLE_TEST_HOOKS;
  return e;
}

function writeReadyAtomic(readyFile, payload) {
  const dir = path.dirname(readyFile);
  const tmp = path.join(dir, `.${path.basename(readyFile)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(tmp, readyFile);
}

function waitForFile(filePath, timeoutMs = 45000) {
  const start = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - start > timeoutMs) return false;
    sleep(20);
  }
  return true;
}

function waitChildExit(child, timeoutMs = 45000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code: code == null ? null : code, signal: signal || null });
    };
    // Already exited before listener attached (BUSY children often exit before parent waits).
    if (child.exitCode != null || child.signalCode != null) {
      done(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", (code, signal) => done(code, signal));
    child.once("error", () => done(null, "error"));
    const t0 = Date.now();
    const tick = () => {
      if (settled) return;
      if (child.exitCode != null || child.signalCode != null) {
        done(child.exitCode, child.signalCode);
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        // Only kill if still alive — avoid misreporting natural exits as kills.
        try {
          if (child.pid && isPidAlive(child.pid)) killTree(child.pid);
        } catch { /* ignore */ }
        done(null, "timeout");
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

function killTree(pid) {
  if (!pid) return { status: 1, stdout: "", stderr: "no-pid" };
  if (!isPidAlive(pid)) return { status: 0, stdout: "", stderr: "already_exited" };
  return spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], {
    encoding: "utf8",
    windowsHide: true,
  });
}

/** Assert natural child exit: code===0 and signal null. Timeout/non-zero → bounded die. */
function assertChildExitOk(exit, label, extras = {}) {
  if (exit.signal === "timeout") {
    dieWorker("CHILD_EXIT_TIMEOUT", JSON.stringify(boundEvidence({
      label,
      code: exit.code,
      signal: exit.signal,
      ...extras,
    }, 800)));
  }
  if (exit.code !== 0 || exit.signal != null) {
    dieWorker("CHILD_EXIT_NONZERO", JSON.stringify(boundEvidence({
      label,
      code: exit.code,
      signal: exit.signal,
      ...extras,
    }, 800)));
  }
}

function attachBoundedStderr(child, max = 1500) {
  const box = { text: "" };
  if (child.stderr && typeof child.stderr.on === "function") {
    child.stderr.on("data", (chunk) => {
      if (box.text.length >= max) return;
      box.text += String(chunk).slice(0, max - box.text.length);
    });
  }
  return box;
}

function errCode(e) {
  return e?.code || null;
}

function errMsg(e) {
  return String(e?.message || e || "");
}

function noSidLeak(text) {
  const s = String(text || "");
  // Refuse raw SID / well-known S-1- strings and win32= numeric dumps in evidence.
  if (/S-1-\d+(-\d+)*/.test(s)) return false;
  if (/win32=\d+/i.test(s)) return false;
  return true;
}

function assertNoSidLeak(label, value) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  if (!noSidLeak(s)) dieWorker("SID_LEAK", `${label}: refused raw SID/win32 dump`);
}

/** Sanitize failure messages for worker/controller emit — never raw SID / win32=n / full icacls. */
function sanitizeFailureMessage(msg) {
  let s = String(msg || "");
  s = s.replace(/S-1-\d+(-\d+)*/g, "[sid]");
  s = s.replace(/win32=\d+/gi, "win32=[n]");
  // Collapse full icacls dumps (Successfully processed / multi-line ACE listings).
  if (/Successfully processed|processed file:|ICACLS/i.test(s) || (s.includes(":(F)") && s.includes("\\"))) {
    s = s
      .replace(/Successfully processed[\s\S]*/gi, "[icacls_output_redacted]")
      .replace(/(?:[A-Za-z0-9_.-]+\\)+[A-Za-z0-9_.-]+(?::\([^)]*\))+/g, "[acl_entry]");
  }
  if (s.length > 4000) s = s.slice(0, 4000);
  return s;
}

// ── Closed workers ─────────────────────────────────────────────────────────
async function runWorkerMain() {
  const mode = process.argv[3];
  /** @type {string[]} */
  const temps = [];
  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];
  /** @type {(() => void)[]} */
  const restoreFns = [];

  const registerTemp = (root) => {
    temps.push(root);
    return root;
  };
  const registerChild = (child) => {
    children.push(child);
    return child;
  };
  /**
   * @param {{"strict"?: boolean}} [opts]
   * strict (success path): after clearing ALL temps, if any cleanup error → throw once.
   * non-strict (failure path): best-effort; returns bounded cleanup_errors (never swallow silently).
   * Never stop after first temp error — splice snapshot first, process every entry, then aggregate.
   * Only kill still-living children — natural exits are not re-killed/misreported.
   */
  const hardCleanup = (opts = {}) => {
    const strict = opts.strict !== false;
    /** @type {string[]} */
    const cleanup_errors = [];
    const kids = children.splice(0);
    for (const child of kids) {
      try {
        const exited = child.exitCode != null || child.signalCode != null;
        if (!exited && child.pid && isPidAlive(child.pid)) {
          killTree(child.pid);
        }
      } catch (e) {
        cleanup_errors.push(`kill:${sanitizeFailureMessage(e?.message || e).slice(0, 120)}`);
      }
    }
    const restores = restoreFns.splice(0).reverse();
    for (const fn of restores) {
      try {
        fn();
      } catch (e) {
        cleanup_errors.push(`restore:${sanitizeFailureMessage(e?.message || e).slice(0, 120)}`);
      }
    }
    // Snapshot then clear so a mid-loop throw cannot leave remaining temps untracked.
    const roots = temps.splice(0).reverse();
    for (const root of roots) {
      try {
        hardRm(root);
        if (fs.existsSync(root)) {
          cleanup_errors.push("temp_residual");
        }
      } catch (e) {
        cleanup_errors.push(`hardRm:${sanitizeFailureMessage(e?.message || e).slice(0, 160)}`);
      }
    }
    if (strict && cleanup_errors.length > 0) {
      throw new Error(`hardCleanup_strict:${cleanup_errors.join("; ").slice(0, 400)}`);
    }
    return cleanup_errors.slice(0, 16);
  };

  try {
    if (!WORKER_MODES.has(mode)) dieWorker("UNKNOWN_MODE", mode);
    if (process.platform !== "win32" || process.arch !== "x64") {
      dieWorker("PLATFORM", `${process.platform}/${process.arch}`);
    }
    assertHooksAbsent();

    if (mode === "self-test-probe") {
      const pin = readPinFromDisk();
      const src = fs.readFileSync(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"), "utf8");
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      const loadCall = codeOnly.indexOf("loadNativeModule(paths.binaryPath)");
      const rehashCall = codeOnly.indexOf("assertSameFdBinaryHash(");
      const afterIdCall = codeOnly.indexOf('assertBinaryIdentityUnchanged(io, fd, paths.binaryPath, preIdentity, "after-load")');
      const selfIdCall = codeOnly.indexOf("assertIdentityMatchesManifest(");
      const sameFdOrderOk =
        loadCall >= 0
        && rehashCall > loadCall
        && afterIdCall > rehashCall
        && selfIdCall > afterIdCall;
      emit({
        ok: true,
        mode,
        hooks_undefined: process.env.PI_ASTACK_ENABLE_TEST_HOOKS === undefined,
        pin_shape: pin.manifest_sha256 ? "live" : "null",
        structural: {
          production_arity_zero: /\bexport function loadWindowsNativeAddon\(\)/.test(src),
          no_download: !/\b(?:fetch|https?\.get|axios|got|curl|wget)\b/i.test(codeOnly),
          no_autocompile: !/\b(?:node-gyp|cmake-js|prebuild-install|node-pre-gyp)\b/i.test(codeOnly),
          same_fd_post_dlopen_rehash: sameFdOrderOk ? "pass" : "fail",
        },
      });
      return;
    }

    if (mode === "provenance-load") {
      const mod = loadJiti("extensions/_shared/windows-native-addon.ts");
      if (typeof mod.__TEST !== "undefined") {
        assertHooksAbsent();
      }
      const loaded = mod.loadWindowsNativeAddon();
      const pin = mod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256;
      const srcPin = mod.WINDOWS_NATIVE_ADDON_PROVENANCE_SOURCE_COMMIT;
      if (loaded.status !== "loaded") dieWorker("LOAD_STATUS", loaded.status);
      if (loaded.manifest.build_mode !== "production") dieWorker("BUILD_MODE", loaded.manifest.build_mode);
      if (loaded.identity.source_commit !== srcPin) dieWorker("SOURCE_PIN", "mismatch");
      const paths = mod.resolveWindowsNativeAddonPaths(mod.resolveWindowsNativeAddonPackageRoot());
      // package_rx three-point gate: directory + binary + manifest each must verify.
      const package_rx = { directory: "fail", binary: "fail", manifest: "fail" };
      try {
        loaded.addon.verifyProtectedPath(path.dirname(paths.binaryPath), "directory", "package_rx");
        package_rx.directory = "pass";
      } catch (e) {
        dieWorker("PACKAGE_RX_DIRECTORY", errCode(e) || errMsg(e));
      }
      try {
        loaded.addon.verifyProtectedPath(paths.binaryPath, "file", "package_rx");
        package_rx.binary = "pass";
      } catch (e) {
        dieWorker("PACKAGE_RX_BINARY", errCode(e) || errMsg(e));
      }
      try {
        loaded.addon.verifyProtectedPath(paths.manifestPath, "file", "package_rx");
        package_rx.manifest = "pass";
      } catch (e) {
        dieWorker("PACKAGE_RX_MANIFEST", errCode(e) || errMsg(e));
      }
      if (package_rx.directory !== "pass" || package_rx.binary !== "pass" || package_rx.manifest !== "pass") {
        dieWorker("PACKAGE_RX_INCOMPLETE", JSON.stringify(package_rx));
      }
      // Success: strict cleanup first (no temps here), then unique ok JSON.
      hardCleanup({ strict: true });
      emit({
        ok: true,
        mode,
        status: loaded.status,
        manifest_sha256: pin,
        binary_sha256: loaded.manifest.binary_sha256,
        binary_bytes: loaded.manifest.binary_bytes,
        build_id: loaded.identity.build_id,
        source_commit: loaded.identity.source_commit,
        source_tree_sha256: loaded.identity.source_tree_sha256,
        toolchain_id: loaded.identity.toolchain_id,
        toolchain: loaded.manifest.toolchain,
        build_mode: loaded.identity.build_mode,
        reproducibility: loaded.identity.reproducibility,
        native_tests: loaded.identity.native_tests,
        clippy: loaded.identity.clippy,
        build_config_sha256: loaded.identity.build_config_sha256,
        capabilities: [...loaded.capabilities],
        package_rx,
        // Successful production load path includes post-dlopen same-fd rehash (loader contract).
        same_fd_post_dlopen_rehash: "pass",
      });
      return;
    }

    if (mode === "retained-lock") {
      const work = registerTemp(tempRoot("lock"));
      const ad = loadJiti("extensions/_shared/retained-directory-lock.ts");
      const rounds = 3;
      const n = 16;
      const roundResults = [];

      for (let round = 0; round < rounds; round += 1) {
        const lockDir = path.join(work, `r${round}`);
        fs.mkdirSync(lockDir, { recursive: true });
        const loadedDir = path.join(work, `loaded-${round}`);
        fs.mkdirSync(loadedDir, { recursive: true });
        const barrier = path.join(work, `barrier-${round}`);
        const release = path.join(work, `release-${round}`);
        const kids = [];

        for (let i = 0; i < n; i += 1) {
          const ready = path.join(work, `ready-${round}-${i}.json`);
          const loaded = path.join(loadedDir, `${i}.json`);
          const script = `
            const { createRequire } = require("node:module");
            const fs = require("node:fs");
            const path = require("node:path");
            const { randomBytes } = require("node:crypto");
            if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== undefined) process.exit(9);
            function sleep(ms){ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms); }
            function writeReadyAtomic(file, payload){
              const dir = path.dirname(file);
              const tmp = path.join(dir, "."+path.basename(file)+"."+process.pid+"."+randomBytes(4).toString("hex")+".tmp");
              fs.writeFileSync(tmp, JSON.stringify(payload)+"\\n", "utf8");
              fs.renameSync(tmp, file);
            }
            const { createJiti } = createRequire(path.join(${JSON.stringify(repoRoot)}, "package.json"))("jiti");
            const jiti = createJiti(${JSON.stringify(repoRoot)}, { interopDefault: true, fsCache: false, moduleCache: false });
            // Phase 1: load module before barrier so all children are ready.
            const ad = jiti(path.join(${JSON.stringify(repoRoot)}, "extensions/_shared/retained-directory-lock.ts"));
            writeReadyAtomic(${JSON.stringify(loaded)}, { loaded: true, pid: process.pid });
            const barrier = ${JSON.stringify(barrier)};
            const release = ${JSON.stringify(release)};
            const lockDir = ${JSON.stringify(lockDir)};
            const ready = ${JSON.stringify(ready)};
            const start = Date.now();
            while (!fs.existsSync(barrier)) {
              if (Date.now() - start > 45000) { writeReadyAtomic(ready, {status:"TIMEOUT"}); process.exit(2); }
              sleep(5);
            }
            try {
              const lease = ad.acquireRetainedDirectoryLock(lockDir);
              if (lease && lease.status === "ACQUIRED") {
                let identityOk = false;
                let vol = null;
                let fid = null;
                try {
                  lease.assertIdentity();
                  vol = lease.identity && lease.identity.volume_serial_number;
                  fid = lease.identity && lease.identity.file_id;
                  identityOk = /^[0-9a-f]{16}$/.test(String(vol||"")) && /^[0-9a-f]{32}$/.test(String(fid||""));
                } catch (e) {
                  writeReadyAtomic(ready, {status:"ERROR", phase:"assertIdentity", code: e && e.code, message: String(e && e.message || e)});
                  try { lease.close(); } catch {}
                  process.exit(1);
                }
                if (!identityOk) {
                  writeReadyAtomic(ready, {status:"ERROR", phase:"identity_shape", vol: !!vol, fid: !!fid});
                  try { lease.close(); } catch {}
                  process.exit(1);
                }
                const zeroWhileHeld = fs.readdirSync(lockDir).length === 0;
                writeReadyAtomic(ready, {
                  status: "ACQUIRED",
                  pid: process.pid,
                  acquired_after_abandon: lease.acquired_after_abandon === true,
                  abandon_observed: typeof lease.acquired_after_abandon === "boolean",
                  volume_serial_number_hex16: true,
                  file_id_hex32: true,
                  zero_files_while_held: zeroWhileHeld,
                });
                const r0 = Date.now();
                while (!fs.existsSync(release)) {
                  if (Date.now() - r0 > 60000) { try { lease.close(); } catch {} process.exit(3); }
                  sleep(20);
                }
                lease.close();
                process.exit(0);
              }
              writeReadyAtomic(ready, {
                status: "BUSY",
                code: lease && lease.code || null,
                pid: process.pid,
              });
              process.exit(0);
            } catch (e) {
              const code = e && e.code;
              if (code === "RETAINED_DIRECTORY_LOCK_BUSY" || /BUSY/.test(String(code||e.message||""))) {
                writeReadyAtomic(ready, {status:"BUSY", code, pid: process.pid});
                process.exit(0);
              }
              writeReadyAtomic(ready, {status:"ERROR", code, message: String(e && e.message || e)});
              process.exit(1);
            }
          `;
          const child = registerChild(spawn(process.execPath, ["--input-type=commonjs", "-e", script], {
            cwd: repoRoot,
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
            env: cleanEnv(),
          }));
          const stderrBox = attachBoundedStderr(child);
          kids.push({ ready, loaded, child, stderrBox });
        }

        // Phase 1 complete: all children loaded module.
        const loadDeadline = Date.now() + 45000;
        for (const k of kids) {
          while (!fs.existsSync(k.loaded) && Date.now() < loadDeadline) sleep(10);
          if (!fs.existsSync(k.loaded)) dieWorker("CHILD_LOAD", `round ${round} child did not load`);
        }

        // Phase 2: barrier — all race acquire.
        fs.writeFileSync(barrier, "go\n");

        const results = [];
        for (const k of kids) {
          if (!waitForFile(k.ready, 45000)) {
            results.push({ status: "MISSING" });
          } else {
            results.push(JSON.parse(fs.readFileSync(k.ready, "utf8")));
          }
        }

        const acquired = results.filter((r) => r.status === "ACQUIRED");
        const busy = results.filter((r) => r.status === "BUSY");
        if (acquired.length !== 1 || busy.length !== n - 1) {
          dieWorker("BARRIER_COUNTS", JSON.stringify({
            round,
            acquired: acquired.length,
            busy: busy.length,
            statuses: results.map((r) => r.status),
          }));
        }
        const winner = acquired[0];
        if (winner.zero_files_while_held !== true) {
          dieWorker("LOCK_DIR_NOT_ZERO_WHILE_HELD", JSON.stringify(winner));
        }
        if (winner.volume_serial_number_hex16 !== true || winner.file_id_hex32 !== true) {
          dieWorker("IDENTITY_HEX", JSON.stringify(winner));
        }
        // Parent recheck: zero-file contract while winner still holds.
        if (fs.readdirSync(lockDir).length !== 0) {
          dieWorker("LOCK_DIR_NOT_ZERO", fs.readdirSync(lockDir).join(","));
        }

        // Phase 3: release winner; wait natural exits and assert code===0/signal null.
        fs.writeFileSync(release, "release\n");
        for (let ki = 0; ki < kids.length; ki += 1) {
          const k = kids[ki];
          const exit = await waitChildExit(k.child, 45000);
          assertChildExitOk(exit, `retained_round_${round}_child_${ki}`, {
            stderr: String(k.stderrBox?.text || "").slice(0, 400),
          });
        }
        // After all natural exits, lock dir still zero-file.
        if (fs.readdirSync(lockDir).length !== 0) {
          dieWorker("LOCK_DIR_NOT_ZERO_AFTER", fs.readdirSync(lockDir).join(","));
        }
        roundResults.push({
          round,
          acquired: 1,
          busy: n - 1,
          zero_files_while_held: true,
          zero_files_after: true,
          winner_identity_hex: true,
        });
      }

      // Crash release: holder ready → taskkill /T /F → confirm exit → bounded fresh acquire.
      const crashDir = path.join(work, "crash");
      fs.mkdirSync(crashDir, { recursive: true });
      const holdReady = path.join(work, "hold-ready.json");
      const holdScript = `
        const { createRequire } = require("node:module");
        const fs = require("node:fs");
        const path = require("node:path");
        const { randomBytes } = require("node:crypto");
        if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== undefined) process.exit(9);
        function writeReadyAtomic(file, payload){
          const dir = path.dirname(file);
          const tmp = path.join(dir, "."+path.basename(file)+"."+process.pid+"."+randomBytes(4).toString("hex")+".tmp");
          fs.writeFileSync(tmp, JSON.stringify(payload)+"\\n", "utf8");
          fs.renameSync(tmp, file);
        }
        const { createJiti } = createRequire(path.join(${JSON.stringify(repoRoot)}, "package.json"))("jiti");
        const jiti = createJiti(${JSON.stringify(repoRoot)}, { interopDefault: true, fsCache: false, moduleCache: false });
        const ad = jiti(path.join(${JSON.stringify(repoRoot)}, "extensions/_shared/retained-directory-lock.ts"));
        const lease = ad.acquireRetainedDirectoryLock(${JSON.stringify(crashDir)});
        if (!lease || lease.status !== "ACQUIRED") process.exit(2);
        writeReadyAtomic(${JSON.stringify(holdReady)}, {status:"ACQUIRED", pid: process.pid});
        setInterval(() => {}, 10000);
      `;
      const holder = registerChild(spawn(process.execPath, ["--input-type=commonjs", "-e", holdScript], {
        cwd: repoRoot,
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: cleanEnv(),
      }));
      const holderStderr = attachBoundedStderr(holder);
      if (!waitForFile(holdReady, 20000)) dieWorker("HOLDER_READY", "timeout");
      const held = JSON.parse(fs.readFileSync(holdReady, "utf8"));
      if (!held.pid) dieWorker("HOLDER_PID", JSON.stringify(held));
      const kill = killTree(held.pid);
      if (kill.status !== 0 && kill.stderr !== "already_exited") {
        dieWorker("TASKKILL", String(kill.stderr || kill.stdout).slice(0, 200));
      }
      // Confirm holder actually exited (bounded). taskkill is expected — not a natural exit.
      let holderExit = null;
      {
        const t0 = Date.now();
        let exited = false;
        while (Date.now() - t0 < 15000) {
          if (holder.exitCode != null || holder.signalCode != null) {
            exited = true;
            holderExit = { code: holder.exitCode, signal: holder.signalCode || null };
            break;
          }
          if (!isPidAlive(held.pid)) {
            exited = true;
            holderExit = await waitChildExit(holder, 2000);
            break;
          }
          sleep(50);
        }
        if (!exited) dieWorker("HOLDER_STILL_ALIVE", String(held.pid));
      }
      // Crash holder killed by taskkill is expected — mark separately; do NOT assert code===0.
      const crashHolderExit = {
        expected_taskkill: true,
        code: holderExit?.code ?? holder.exitCode,
        signal: holderExit?.signal ?? holder.signalCode ?? null,
        stderr: String(holderStderr.text || "").slice(0, 200),
      };

      // Bounded fresh acquire (retry window for abandon propagation).
      let fresh = null;
      const freshDeadline = Date.now() + 15000;
      let lastErr = null;
      while (Date.now() < freshDeadline) {
        try {
          const lease = ad.acquireRetainedDirectoryLock(crashDir);
          if (lease && lease.status === "ACQUIRED") {
            fresh = {
              status: "ACQUIRED",
              acquired_after_abandon: lease.acquired_after_abandon === true,
              abandon_flag_boolean: typeof lease.acquired_after_abandon === "boolean",
            };
            lease.close();
            break;
          }
          lastErr = `status=${lease && lease.status}`;
        } catch (e) {
          lastErr = errCode(e) || errMsg(e);
        }
        sleep(50);
      }
      if (!fresh || fresh.status !== "ACQUIRED") {
        dieWorker("FRESH_ACQUIRE", String(lastErr));
      }
      // abandon flag is observed boolean, not a gate.
      if (fresh.abandon_flag_boolean !== true) {
        dieWorker("ABANDON_FLAG_TYPE", JSON.stringify(fresh));
      }
      if (fs.readdirSync(crashDir).length !== 0) dieWorker("CRASH_DIR_NOT_ZERO", "files present");

      hardCleanup({ strict: true });
      emit({
        ok: true,
        mode,
        barrier_rounds: roundResults,
        crash_release: {
          acquired: true,
          acquired_after_abandon_observed: fresh.acquired_after_abandon,
          abandon_flag_boolean: true,
          zero_files: true,
          // Holder was force-killed by taskkill — non-zero/signal is expected, not a natural exit failure.
          holder_exit_expected_taskkill: crashHolderExit,
        },
        processes_per_round: n,
      });
      return;
    }

    if (mode === "dacl") {
      const work = registerTemp(tempRoot("dacl"));
      const mod = loadJiti("extensions/_shared/windows-native-addon.ts");
      const loaded = mod.loadWindowsNativeAddon();
      if (loaded.status !== "loaded") dieWorker("LOAD_STATUS", loaded.status);
      const addon = loaded.addon;
      const matrix = {};

      function closedDenyCode(code) {
        return typeof code === "string" && CLOSED_DACL_DENY_RE.test(code);
      }
      function closedMismatchCode(code) {
        return typeof code === "string" && CLOSED_DACL_MISMATCH_RE.test(code);
      }
      function expectDeny(label, fn) {
        let code = null;
        let threw = false;
        try {
          fn();
        } catch (e) {
          threw = true;
          // Evidence keeps closed code only — never raw message (may carry SID).
          code = errCode(e) || null;
        }
        if (!threw) dieWorker("DACL_UNEXPECTED_PASS", label);
        if (code == null) dieWorker("DACL_NULL_CODE", label);
        if (!closedDenyCode(code) && !closedMismatchCode(code)) {
          dieWorker("DACL_OPEN_CODE", `${label}:${code}`);
        }
        assertNoSidLeak(label, code);
        return code;
      }
      function expectPass(label, fn) {
        try {
          fn();
        } catch (e) {
          dieWorker("DACL_UNEXPECTED_DENY", `${label}:${errCode(e) || errMsg(e)}`);
        }
      }

      // 1) default inherited ordinary file → reject
      {
        const ordinary = path.join(work, "ordinary-default.txt");
        fs.writeFileSync(ordinary, "default-inherited-body\n", "utf8");
        const code = expectDeny("default_inherited_ordinary_file", () => {
          mod.verifyProtectedPath(addon, ordinary, "file", "private_rw");
        });
        matrix.default_inherited_ordinary_file = { result: "denied", code };
      }

      // 2) private_rw file pass
      {
        const file = path.join(work, "private.txt");
        fs.writeFileSync(file, "private-body\n", "utf8");
        mod.setProtectedPath(addon, file, "file", "private_rw");
        expectPass("private_rw_file", () => {
          mod.verifyProtectedPath(addon, file, "file", "private_rw");
        });
        matrix.private_rw_file = { result: "pass" };
      }

      // 3) protected dir pass
      {
        const dir = path.join(work, "private-dir");
        const canon = mod.ensureProtectedDirectory(addon, dir);
        expectPass("protected_dir", () => {
          mod.verifyProtectedPath(addon, canon, "directory", "private_rw");
        });
        matrix.protected_dir = { result: "pass" };
      }

      // 4) Everyone grant single factor + readback + exact closed code; restore
      {
        const file = path.join(work, "everyone-tamper.txt");
        fs.writeFileSync(file, "tamper-body\n", "utf8");
        mod.setProtectedPath(addon, file, "file", "private_rw");
        mod.verifyProtectedPath(addon, file, "file", "private_rw");
        const grant = spawnSync("icacls.exe", [file, "/grant", "Everyone:F"], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (grant.status !== 0) dieWorker("ICACLS_GRANT", grant.stderr || grant.stdout);
        if (grant.status == null) dieWorker("ICACLS_GRANT_NULL", "status null not pass");
        const readback = spawnSync("icacls.exe", [file], { encoding: "utf8", windowsHide: true });
        if (readback.status !== 0) dieWorker("ICACLS_READBACK", readback.stderr || readback.stdout);
        const rb = `${readback.stdout || ""}\n${readback.stderr || ""}`;
        if (!/Everyone/i.test(rb)) dieWorker("ACL_READBACK", "Everyone not visible");
        assertNoSidLeak("everyone_readback", rb.slice(0, 400));
        const code = expectDeny("everyone_grant", () => {
          mod.verifyProtectedPath(addon, file, "file", "private_rw");
        });
        // Restore
        mod.setProtectedPath(addon, file, "file", "private_rw");
        expectPass("everyone_restored", () => {
          mod.verifyProtectedPath(addon, file, "file", "private_rw");
        });
        matrix.everyone_grant = {
          result: "denied_then_restored",
          grant_status: grant.status,
          readback_everyone: true,
          code,
          restored: true,
        };
      }

      // 5) inheritance-only independent file + readback + deny
      {
        const file = path.join(work, "inherit-only.txt");
        fs.writeFileSync(file, "inherit-body\n", "utf8");
        mod.setProtectedPath(addon, file, "file", "private_rw");
        mod.verifyProtectedPath(addon, file, "file", "private_rw");
        const inh = spawnSync("icacls.exe", [file, "/inheritance:e"], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (inh.status !== 0) dieWorker("ICACLS_INHERIT", inh.stderr || inh.stdout);
        if (inh.status == null) dieWorker("ICACLS_INHERIT_NULL", "status null not pass");
        const readback = spawnSync("icacls.exe", [file], { encoding: "utf8", windowsHide: true });
        if (readback.status !== 0) dieWorker("ICACLS_INHERIT_READBACK", readback.stderr || readback.stdout);
        const rb = `${readback.stdout || ""}\n${readback.stderr || ""}`;
        // inheritance enabled typically shows (I) inherited ACEs and/or lacks "inheritance: disabled"
        const inheritVisible =
          /\(I\)/i.test(rb)
          || !/inheritance:\s*disabled/i.test(rb)
          || /Successfully processed/i.test(String(inh.stdout || ""));
        if (!inheritVisible) dieWorker("INHERIT_READBACK", rb.slice(0, 300));
        assertNoSidLeak("inherit_readback", rb.slice(0, 400));
        const code = expectDeny("inheritance_only", () => {
          mod.verifyProtectedPath(addon, file, "file", "private_rw");
        });
        matrix.inheritance_only = {
          result: "denied",
          inheritance_status: inh.status,
          readback_visible: true,
          code,
        };
      }

      // 6) system file/dir owner-mismatch read-only probe (cross-token residual).
      // Present targets must ALL be denied; cannot absent_skip everything and still claim denied.
      // At least one owner-mismatch probe must successfully refuse. Residual notes this is
      // NOT second-account active tamper evidence.
      {
        const systemTargets = [
          { path: path.join(process.env.SystemRoot || "C:\\Windows", "System32", "drivers", "etc", "hosts"), kind: "file" },
          { path: path.join(process.env.SystemRoot || "C:\\Windows", "System32"), kind: "directory" },
        ];
        const probes = [];
        for (const t of systemTargets) {
          if (!fs.existsSync(t.path)) {
            probes.push({ target: t.kind, result: "absent_skip" });
            continue;
          }
          let code = null;
          let threw = false;
          try {
            mod.verifyProtectedPath(addon, t.path, t.kind, "private_rw");
          } catch (e) {
            threw = true;
            // Code only — never raw message (cross-token residual may include SID text).
            code = errCode(e) || null;
          }
          if (!threw) dieWorker("SYSTEM_UNEXPECTED_PASS", t.kind);
          if (code == null) dieWorker("SYSTEM_NULL_CODE", t.kind);
          // Allow DACL_INVALID / ACCESS_DENIED / ANCESTOR_REPARSE as closed residual codes.
          const allowed =
            /WINDOWS_NATIVE_ADDON_(DACL_INVALID|ACCESS_DENIED|ANCESTOR_REPARSE)/.test(String(code));
          if (!allowed) dieWorker("SYSTEM_OPEN_CODE", `${t.kind}:${code}`);
          assertNoSidLeak(`system_${t.kind}`, code);
          probes.push({ target: t.kind, result: "denied", code });
        }
        const present = probes.filter((p) => p.result !== "absent_skip");
        const denied = present.filter((p) => p.result === "denied");
        if (present.length === 0) {
          dieWorker("SYSTEM_ALL_ABSENT", "no system owner-mismatch targets present");
        }
        if (denied.length !== present.length) {
          dieWorker("SYSTEM_NOT_ALL_DENIED", JSON.stringify(probes));
        }
        if (denied.length < 1) {
          dieWorker("SYSTEM_NO_SUCCESSFUL_DENY", JSON.stringify(probes));
        }
        matrix.system_owner_mismatch_probe = {
          result: "denied",
          present_targets: present.length,
          denied_targets: denied.length,
          probes,
          residual: "cross_token_owner_mismatch_read_only_probe_not_second_account_active_tamper",
        };
      }

      // 7) kind / profile mismatch
      {
        const file = path.join(work, "mismatch.txt");
        fs.writeFileSync(file, "mismatch\n", "utf8");
        mod.setProtectedPath(addon, file, "file", "private_rw");
        const kindCode = expectDeny("kind_mismatch", () => {
          mod.verifyProtectedPath(addon, file, "directory", "private_rw");
        });
        const profileCode = expectDeny("profile_mismatch", () => {
          mod.verifyProtectedPath(addon, file, "file", "package_rx");
        });
        const dir = path.join(work, "mismatch-dir");
        mod.ensureProtectedDirectory(addon, dir);
        const dirKindCode = expectDeny("dir_kind_mismatch", () => {
          mod.verifyProtectedPath(addon, dir, "file", "private_rw");
        });
        matrix.kind_profile_mismatch = {
          result: "denied",
          kind_code: kindCode,
          profile_code: profileCode,
          dir_kind_code: dirKindCode,
        };
      }

      hardCleanup({ strict: true });
      emit({
        ok: true,
        mode,
        matrix,
        threat_boundary: "single_TokenUser_only_cross_token_residual",
      });
      return;
    }

    if (mode === "stable-view") {
      const work = registerTemp(tempRoot("stable"));
      assertHooksAbsent();
      const abrain = path.join(work, "abrain");
      fs.mkdirSync(path.join(abrain, ".state", "sediment"), { recursive: true });

      // Point production root at temp abrain; restore on exit/cleanup.
      // environment_scope: temp fixture root — NOT live matrix.
      const prevAbrainRoot = process.env.ABRAIN_ROOT;
      process.env.ABRAIN_ROOT = abrain;
      restoreFns.push(() => {
        if (prevAbrainRoot === undefined) delete process.env.ABRAIN_ROOT;
        else process.env.ABRAIN_ROOT = prevAbrainRoot;
      });

      const publisher = loadJiti("extensions/_shared/proposition-policy-stable-view-publisher.ts");
      const reader = loadJiti("extensions/abrain/rule-injector/proposition-policy-stable-view-reader.ts");
      const stableWin = loadJiti("extensions/_shared/proposition-policy-stable-view-windows-native.ts");
      const injector = loadJiti("extensions/abrain/rule-injector/index.ts");
      const fixtureMod = await import(pathToFileURL(path.join(repoRoot, "scripts/_proposition-policy-stable-view-fixture.mjs")).href);
      await fixtureMod.preparePropositionPolicyStableViewFixture({ repoRoot, abrainHome: abrain });

      // Legacy / compiled / D3 fallback decoys (must never be injected).
      const writeFallbackDecoys = (home) => {
        fs.mkdirSync(path.join(home, "rules", "always"), { recursive: true });
        fs.writeFileSync(
          path.join(home, "rules", "always", "legacy.md"),
          "---\ntitle: Legacy\nstatus: active\n---\n# Legacy\n\nLEGACY_RUNTIME_MARKER\n",
          "utf8",
        );
        fs.mkdirSync(path.join(home, ".state", "sediment", "constraint-shadow", "latest"), { recursive: true });
        fs.writeFileSync(
          path.join(home, ".state", "sediment", "constraint-shadow", "latest", "compiled-view.md"),
          "COMPILED_RUNTIME_MARKER\n",
          "utf8",
        );
        fs.mkdirSync(
          path.join(home, ".state", "sediment", "proposition-lifecycle-freshness", "v2", "selections"),
          { recursive: true },
        );
        fs.writeFileSync(
          path.join(home, ".state", "sediment", "proposition-lifecycle-freshness", "v2", "selections", "current.json"),
          '{"D3_RUNTIME_MARKER":true}\n',
          "utf8",
        );
      };
      writeFallbackDecoys(abrain);

      const assertLatestByteExactAndDacl = (bundleHash, label) => {
        if (!fs.existsSync(latest)) dieWorker(`${label}_LATEST_MISSING`, "missing");
        const st = fs.lstatSync(latest);
        if (!st.isFile() || st.isSymbolicLink()) dieWorker(`${label}_LATEST_NOT_FILE`, "must be regular pointer");
        const raw = fs.readFileSync(latest);
        const expected = Buffer.from(`bundles/${bundleHash}\n`, "utf8");
        if (!raw.equals(expected)) {
          dieWorker(`${label}_LATEST_POINTER`, raw.toString("utf8").slice(0, 120));
        }
        stableWin.verifyStableViewProtectedFile(addon, latest, "private_rw");
      };

      // Production self-publication into temp ABRAIN_ROOT — no sandbox/addon override.
      const pub = await publisher.publishPropositionPolicyStableView({
        mode: "production",
        sourceAbrainHome: abrain,
        repoRoot,
      });
      if (!pub || (pub.status !== "created" && pub.status !== "identical")) {
        dieWorker("PUBLISH_STATUS", JSON.stringify(pub && { status: pub.status, code: pub.code }));
      }
      if (!pub.bundle_hash || !/^[0-9a-f]{64}$/.test(pub.bundle_hash)) {
        dieWorker("BUNDLE_HASH", String(pub.bundle_hash));
      }

      const latest = path.join(
        abrain,
        ...publisher.PROPOSITION_POLICY_STABLE_VIEW_PUBLICATION_ROOT_RELATIVE.split("/"),
        "latest",
      );
      const addon = stableWin.resolveStableViewWindowsNativeAddon();
      assertLatestByteExactAndDacl(pub.bundle_hash, "INITIAL");

      const sessionManager = {
        isPersisted: () => true,
        getSessionId: () => "win-prod-dossier",
        getSessionFile: () => path.join(work, "sess.jsonl"),
      };
      const settings = reader.resolvePropositionPolicyStableViewInjectionSettings({});
      const runtime = reader.readPropositionPolicyStableViewForRuntime({
        abrainHome: abrain,
        settings,
        sessionManager,
      });
      if (!runtime || runtime.ok !== true || runtime.reason !== "selected_valid") {
        dieWorker("READ_NOT_VALID", JSON.stringify({
          ok: runtime?.ok,
          reason: runtime?.reason,
          error: runtime?.error ? String(runtime.error).slice(0, 200) : null,
        }));
      }
      if (runtime.bundleHash !== pub.bundle_hash) {
        dieWorker("READ_HASH_MISMATCH", `${runtime.bundleHash}!=${pub.bundle_hash}`);
      }

      const injection = injector.composePropositionPolicyStableViewInjection("nonce-dossier", runtime);
      if (!injection || !String(injection).trim()) dieWorker("INJECTION_EMPTY", "managed injection empty");
      if (!injection.includes("source=proposition-policy-stable-view")) {
        dieWorker("INJECTION_FENCE", "missing stable-view fence");
      }
      if (
        injection.includes("source=constraint-shadow-compiled-view")
        || injection.includes("COMPILED_RUNTIME_MARKER")
        || injection.includes("LEGACY_RUNTIME_MARKER")
        || injection.includes("D3_RUNTIME_MARKER")
        || /\bD3\b/.test(injection)
      ) {
        dieWorker("INJECTION_FALLBACK", "compiled/D3/legacy fallback leaked");
      }

      // Loud-zero cases: missing / invalid / DACL tamper — closed reasons, no fallback.
      // Decoys remain present throughout; invalid/missing/tamper still ok:false.
      const loudCases = [];
      let currentBundleHash = pub.bundle_hash;

      const assertClosedLoud = (result, label) => {
        if (result?.ok !== false) {
          dieWorker(`${label}_NOT_LOUD`, JSON.stringify({ ok: result?.ok, reason: result?.reason }));
        }
        if (!CLOSED_STABLE_LOUD_REASONS.has(result.reason)) {
          dieWorker(`${label}_REASON_OPEN`, String(result.reason));
        }
        assertNoSidLeak(label, result.reason);
        // Decoys must never resurrect injection on failure path.
        if (result.viewMd || result.injection) {
          dieWorker(`${label}_FALLBACK_PAYLOAD`, "failure path must not carry view payload");
        }
      };

      const republishAndReverify = async (label) => {
        let again;
        try {
          again = await publisher.publishPropositionPolicyStableView({
            mode: "production",
            sourceAbrainHome: abrain,
            repoRoot,
          });
        } catch (e) {
          dieWorker(`REPUBLISH_${label}`, errCode(e) || errMsg(e));
        }
        if (!again || (again.status !== "created" && again.status !== "identical")) {
          dieWorker(`REPUBLISH_${label}`, JSON.stringify(again && again.status));
        }
        if (!again.bundle_hash || !/^[0-9a-f]{64}$/.test(again.bundle_hash)) {
          dieWorker(`REPUBLISH_${label}_HASH`, String(again.bundle_hash));
        }
        currentBundleHash = again.bundle_hash;
        assertLatestByteExactAndDacl(currentBundleHash, `REPUBLISH_${label}`);
        return again;
      };

      // missing latest
      {
        fs.unlinkSync(latest);
        const missing = reader.readPropositionPolicyStableViewForRuntime({
          abrainHome: abrain,
          settings,
          sessionManager: {
            isPersisted: () => true,
            getSessionId: () => "win-prod-dossier-missing",
            getSessionFile: () => path.join(work, "sess-missing.jsonl"),
          },
        });
        assertClosedLoud(missing, "MISSING");
        loudCases.push({ case: "missing", ok: false, reason: missing.reason });
        await republishAndReverify("AFTER_MISSING");
      }

      // invalid pointer (protected rewrite with bad content)
      {
        const nativeMod = loadJiti("extensions/_shared/windows-native-addon.ts");
        const loaded = nativeMod.loadWindowsNativeAddon();
        nativeMod.durableAtomicReplaceFile(
          loaded.addon,
          latest,
          Buffer.from("bundles/../escape\n", "utf8"),
        );
        const invalid = reader.readPropositionPolicyStableViewForRuntime({
          abrainHome: abrain,
          settings,
          sessionManager: {
            isPersisted: () => true,
            getSessionId: () => "win-prod-dossier-invalid",
            getSessionFile: () => path.join(work, "sess-invalid.jsonl"),
          },
        });
        assertClosedLoud(invalid, "INVALID");
        loudCases.push({ case: "invalid_pointer", ok: false, reason: invalid.reason });
        await republishAndReverify("AFTER_INVALID");
      }

      // DACL tamper on latest — prove ACL state actually changed via icacls readback + native deny.
      {
        const grant = spawnSync("icacls.exe", [latest, "/grant", "Everyone:F"], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (grant.status !== 0) {
          dieWorker("STABLE_ICACLS_TAMPER", sanitizeFailureMessage(grant.stderr || grant.stdout));
        }
        const readback = spawnSync("icacls.exe", [latest], {
          encoding: "utf8",
          windowsHide: true,
        });
        if (readback.status !== 0) {
          dieWorker("STABLE_TAMPER_READBACK", sanitizeFailureMessage(readback.stderr || readback.stdout));
        }
        const rb = `${readback.stdout || ""}\n${readback.stderr || ""}`;
        if (!/Everyone/i.test(rb)) dieWorker("STABLE_TAMPER_READBACK_EVERYONE", "Everyone not visible");
        // Do not emit full icacls output — only Everyone presence flag.
        {
          const nativeMod = loadJiti("extensions/_shared/windows-native-addon.ts");
          const loaded = nativeMod.loadWindowsNativeAddon();
          let code = null;
          let threw = false;
          try {
            nativeMod.verifyProtectedPath(loaded.addon, latest, "file", "private_rw");
          } catch (e) {
            threw = true;
            code = errCode(e) || null;
          }
          if (!threw) dieWorker("STABLE_TAMPER_NATIVE_STILL_PASS", "verify must deny after Everyone grant");
          if (code == null) dieWorker("STABLE_TAMPER_NATIVE_NULL_CODE", "null code");
          if (!CLOSED_DACL_DENY_RE.test(String(code)) && !CLOSED_DACL_MISMATCH_RE.test(String(code))) {
            dieWorker("STABLE_TAMPER_NATIVE_OPEN_CODE", String(code));
          }
          assertNoSidLeak("stable_tamper_native", code);
        }
        const tampered = reader.readPropositionPolicyStableViewForRuntime({
          abrainHome: abrain,
          settings,
          sessionManager: {
            isPersisted: () => true,
            getSessionId: () => "win-prod-dossier-tamper",
            getSessionFile: () => path.join(work, "sess-tamper.jsonl"),
          },
        });
        assertClosedLoud(tampered, "TAMPER");
        loudCases.push({
          case: "dacl_tamper",
          ok: false,
          reason: tampered.reason,
          icacls_readback_everyone: true,
          native_verify_denied: true,
        });
      }

      hardCleanup({ strict: true });
      emit({
        ok: true,
        mode,
        environment_scope: "temp_ABRAIN_ROOT_fixture_not_live_matrix",
        publication: "temp_ABRAIN_ROOT_production_self_publication",
        not_live_abrain: true,
        publish_status: pub.status,
        bundle_hash: currentBundleHash,
        latest_exact: true,
        latest_byte_exact_bundles_hash_lf: true,
        latest_dacl_private_rw: true,
        republish_byte_exact_and_dacl_reverify: true,
        reader: { ok: true, reason: "selected_valid" },
        managed_injection_nonempty: true,
        fallback_decoy_ignored: true,
        closed_reason_set_size: CLOSED_STABLE_LOUD_REASONS.size,
        loud_zero_cases: loudCases,
        no_override: true,
        no_sandbox: true,
        residual: [],
      });
      return;
    }

    if (mode === "edge") {
      const work = registerTemp(tempRoot("edge"));
      assertHooksAbsent();
      const edge = loadJiti("extensions/sediment/edge-protocol-shadow.ts");
      const abrain = path.join(work, "abrain");
      const owner = path.join(work, "owner");
      fs.mkdirSync(abrain, { recursive: true });
      fs.mkdirSync(owner, { recursive: true });
      // Ordinary shared ancestors (not protected) — production layout tolerates them.
      fs.mkdirSync(path.join(abrain, ".state", "sediment"), { recursive: true });

      const sessionId = "win-prod-edge";
      const init = await edge.initializeEdgeProtocolShadowSession({
        abrainHome: abrain,
        ownerProjectRoot: owner,
        sessionId,
      });
      if (!init || init.status !== "ready") {
        dieWorker("EDGE_INIT", JSON.stringify({ status: init?.status, code: init?.error_code }));
      }

      const messages = [
        { role: "user", content: "ping-dossier", timestamp: Date.now() },
        { role: "assistant", content: "pong-dossier", timestamp: Date.now() + 1, stopReason: "end" },
      ];
      const c6 = {
        session_id: sessionId,
        turn_id: 1,
        // Full C6 fields when available; normalizeC6 accepts required subset.
        device_id: "dossier-device",
        project_id: "dossier-project",
        agent_id: "dossier-agent",
        leaf_id: "leaf-pair-1",
      };
      const leafTip = { id: "leaf-pair-1", parentId: null, type: "message" };

      // captureEdgeProtocolTerminalPair is a production export — always present.
      // status must be exactly "complete". No candidate/witness fallback that masks failure.
      if (typeof edge.captureEdgeProtocolTerminalPair !== "function") {
        dieWorker("EDGE_PAIR_EXPORT_MISSING", "captureEdgeProtocolTerminalPair must be exported");
      }
      let pairStatus = null;
      let recordsCount = 0;
      const pair = await edge.captureEdgeProtocolTerminalPair({
        abrainHome: abrain,
        ownerProjectRoot: owner,
        sessionId,
        messages,
        c6,
        leafTip,
      });
      pairStatus = pair?.status || null;
      if (pairStatus !== "complete") {
        dieWorker("EDGE_PAIR_NOT_COMPLETE", JSON.stringify({
          status: pairStatus,
          error_code: pair?.error_code || null,
          error_detail: sanitizeFailureMessage(pair?.error_detail || "").slice(0, 200),
        }));
      }

      const sessionRoot = edge.edgeSessionRoot(abrain, owner, sessionId);
      const records = await edge.listEdgeJournalRecords(sessionRoot);
      recordsCount = records.length;
      if (recordsCount < 2) {
        dieWorker("EDGE_RECORDS", `expected pair records, got ${recordsCount}`);
      }
      const hasCandidate = records.some((r) => r.record_type === "candidate_capture");
      const hasWitness = records.some((r) => r.record_type === "terminal_witness");
      if (!hasCandidate || !hasWitness) {
        dieWorker("EDGE_PAIR_TYPES", JSON.stringify({
          types: records.map((r) => r.record_type),
        }));
      }

      // 16-process barrier on captureEdgeProtocolCandidate with unique turns.
      const n = 16;
      const coordSession = "win-prod-edge-coord";
      const coordInit = await edge.initializeEdgeProtocolShadowSession({
        abrainHome: abrain,
        ownerProjectRoot: owner,
        sessionId: coordSession,
      });
      if (coordInit.status !== "ready") dieWorker("EDGE_COORD_INIT", coordInit.error_code);
      const loadedDir = path.join(work, "edge-loaded");
      fs.mkdirSync(loadedDir, { recursive: true });
      const barrier = path.join(work, "edge-barrier");
      const kids = [];
      for (let i = 0; i < n; i += 1) {
        const ready = path.join(work, `edge-ready-${i}.json`);
        const loaded = path.join(loadedDir, `${i}.json`);
        const turnId = 1000 + i + 1;
        const script = `
          const { createRequire } = require("node:module");
          const fs = require("node:fs");
          const path = require("node:path");
          const { randomBytes } = require("node:crypto");
          if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== undefined) process.exit(9);
          function sleep(ms){ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms); }
          function writeReadyAtomic(file, payload){
            const dir = path.dirname(file);
            const tmp = path.join(dir, "."+path.basename(file)+"."+process.pid+"."+randomBytes(4).toString("hex")+".tmp");
            fs.writeFileSync(tmp, JSON.stringify(payload)+"\\n", "utf8");
            fs.renameSync(tmp, file);
          }
          const { createJiti } = createRequire(path.join(${JSON.stringify(repoRoot)}, "package.json"))("jiti");
          const jiti = createJiti(${JSON.stringify(repoRoot)}, { interopDefault: true, fsCache: false, moduleCache: false });
          const edge = jiti(path.join(${JSON.stringify(repoRoot)}, "extensions/sediment/edge-protocol-shadow.ts"));
          writeReadyAtomic(${JSON.stringify(loaded)}, { loaded: true, pid: process.pid });
          const barrier = ${JSON.stringify(barrier)};
          const start = Date.now();
          while (!fs.existsSync(barrier)) {
            if (Date.now() - start > 45000) process.exit(2);
            sleep(5);
          }
          (async () => {
            try {
              const r = await edge.captureEdgeProtocolCandidate({
                abrainHome: ${JSON.stringify(abrain)},
                ownerProjectRoot: ${JSON.stringify(owner)},
                sessionId: ${JSON.stringify(coordSession)},
                messages: [{ role: "user", content: "coord-${i}-" + randomBytes(4).toString("hex") }],
                c6: {
                  session_id: ${JSON.stringify(coordSession)},
                  turn_id: ${turnId},
                  device_id: "dossier-device",
                  project_id: "dossier-project",
                  agent_id: "dossier-agent",
                  leaf_id: "leaf-coord-${i}",
                },
                leafTip: { id: "leaf-coord-${i}", parentId: null, type: "message" },
              });
              writeReadyAtomic(${JSON.stringify(ready)}, {
                ok: r.status === "captured",
                status: r.status,
                producer_seq: r.record && r.record.producer_seq,
                record_id: r.record && r.record.record_id,
                error_code: r.error_code || null,
              });
              process.exit(r.status === "captured" ? 0 : 1);
            } catch (e) {
              writeReadyAtomic(${JSON.stringify(ready)}, {
                ok: false,
                code: e && e.code,
                message: String(e && e.message || e).slice(0, 200),
              });
              process.exit(1);
            }
          })();
        `;
        const child = registerChild(spawn(process.execPath, ["--input-type=commonjs", "-e", script], {
          cwd: repoRoot,
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
          env: cleanEnv(),
        }));
        const stderrBox = attachBoundedStderr(child);
        kids.push({ ready, loaded, child, stderrBox });
      }
      const loadDeadline = Date.now() + 45000;
      for (const k of kids) {
        while (!fs.existsSync(k.loaded) && Date.now() < loadDeadline) sleep(10);
        if (!fs.existsSync(k.loaded)) dieWorker("EDGE_CHILD_LOAD", "timeout");
      }
      fs.writeFileSync(barrier, "go\n");
      const coordResults = [];
      for (let ki = 0; ki < kids.length; ki += 1) {
        const k = kids[ki];
        if (!waitForFile(k.ready, 60000)) {
          coordResults.push({ ok: false, status: "MISSING" });
        } else {
          coordResults.push(JSON.parse(fs.readFileSync(k.ready, "utf8")));
        }
        const exit = await waitChildExit(k.child, 30000);
        // Captured children must exit 0 / signal null; non-zero carries bounded stderr.
        if (coordResults[ki]?.ok === true) {
          assertChildExitOk(exit, `edge_coord_child_${ki}`, {
            stderr: String(k.stderrBox?.text || "").slice(0, 400),
            status: coordResults[ki]?.status || null,
          });
        } else {
          // Failed capture path still must settle; surface diagnostics if timeout.
          if (exit.signal === "timeout") {
            dieWorker("EDGE_CHILD_EXIT_TIMEOUT", JSON.stringify(boundEvidence({
              i: ki,
              code: exit.code,
              stderr: String(k.stderrBox?.text || "").slice(0, 400),
              result: coordResults[ki],
            }, 800)));
          }
        }
      }
      const captured = coordResults.filter((r) => r.ok === true && r.status === "captured");
      if (captured.length !== n) {
        dieWorker("EDGE_COORD_CAPTURE", JSON.stringify({
          captured: captured.length,
          n,
          sample: coordResults.slice(0, 4),
        }));
      }
      const seqs = captured.map((r) => r.producer_seq).sort((a, b) => a - b);
      const unique = new Set(seqs);
      if (unique.size !== n) dieWorker("EDGE_SEQ_UNIQUE", JSON.stringify(seqs));
      // Continuous unique integers (not necessarily starting at 1 if prior records exist).
      for (let i = 1; i < seqs.length; i += 1) {
        if (seqs[i] !== seqs[i - 1] + 1) {
          dieWorker("EDGE_SEQ_CONTINUOUS", JSON.stringify(seqs));
        }
      }

      const coordRoot = edge.edgeSessionRoot(abrain, owner, coordSession);
      // M7: records/sources dirs MUST exist before asserting no native temp residuals.
      for (const [label, dir] of [
        ["records", edge.edgeJournalRecordsDir(coordRoot)],
        ["sources", edge.edgeSourcesDir(coordRoot)],
      ]) {
        if (!fs.existsSync(dir)) {
          dieWorker("EDGE_DIR_MISSING", `${label} dir must exist before no-temp assert`);
        }
        for (const name of fs.readdirSync(dir)) {
          if (name.includes("pi-astack-tmp") || name.endsWith(".tmp") || name.startsWith(".")) {
            dieWorker("EDGE_NATIVE_TEMP", name);
          }
        }
      }

      // Audit: correct signature appendEdgeAuditJsonlLine(auditPath, entry, {trustRoot})
      const auditPath = path.join(edge.edgeProtocolShadowRoot(abrain), "capture-audit.jsonl");
      const auditEntry = {
        schema: edge.EDGE_CAPTURE_AUDIT_SCHEMA,
        schema_version: 1,
        created_at: new Date().toISOString(),
        session_id: sessionId,
        content_id: sha256("dossier-audit-1"),
        c6: {
          session_id: sessionId,
          turn_id: 1,
          device_id: "dossier-device",
          project_id: "dossier-project",
          agent_id: "dossier-agent",
          leaf_id: "leaf-pair-1",
        },
        leaf_tip: leafTip,
        result: "capture_attempt",
      };
      await edge.appendEdgeAuditJsonlLine(auditPath, auditEntry, { trustRoot: abrain });

      // DACL tamper records dir → capture journal_failed, no autorepair.
      const tamperSession = "win-prod-edge-tamper";
      await edge.initializeEdgeProtocolShadowSession({
        abrainHome: abrain,
        ownerProjectRoot: owner,
        sessionId: tamperSession,
      });
      // Seed one successful capture so records dir exists with private_rw.
      const seed = await edge.captureEdgeProtocolCandidate({
        abrainHome: abrain,
        ownerProjectRoot: owner,
        sessionId: tamperSession,
        messages: [{ role: "user", content: "seed-before-tamper" }],
        c6: {
          session_id: tamperSession,
          turn_id: 1,
          device_id: "dossier-device",
          project_id: "dossier-project",
          agent_id: "dossier-agent",
          leaf_id: "leaf-tamper-seed",
        },
        leafTip: { id: "leaf-tamper-seed", parentId: null, type: "message" },
      });
      if (seed.status !== "captured") {
        dieWorker("EDGE_TAMPER_SEED", JSON.stringify({ status: seed.status, code: seed.error_code }));
      }
      const tamperRoot = edge.edgeSessionRoot(abrain, owner, tamperSession);
      const recordsDir = edge.edgeJournalRecordsDir(tamperRoot);
      if (!fs.existsSync(recordsDir)) dieWorker("EDGE_TAMPER_RECORDS_MISSING", "records dir must exist");
      const tamper = spawnSync("icacls.exe", [recordsDir, "/grant", "Everyone:(OI)(CI)F"], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (tamper.status !== 0) {
        dieWorker("EDGE_ICACLS_TAMPER", sanitizeFailureMessage(tamper.stderr || tamper.stdout));
      }
      // M9: icacls readback must show Everyone before asserting capture outcome.
      const tamperReadback = spawnSync("icacls.exe", [recordsDir], {
        encoding: "utf8",
        windowsHide: true,
      });
      if (tamperReadback.status !== 0) {
        dieWorker("EDGE_TAMPER_READBACK", sanitizeFailureMessage(tamperReadback.stderr || tamperReadback.stdout));
      }
      const tamperRb = `${tamperReadback.stdout || ""}\n${tamperReadback.stderr || ""}`;
      if (!/Everyone/i.test(tamperRb)) {
        dieWorker("EDGE_TAMPER_READBACK_EVERYONE", "Everyone not visible after grant");
      }
      const afterTamper = await edge.captureEdgeProtocolCandidate({
        abrainHome: abrain,
        ownerProjectRoot: owner,
        sessionId: tamperSession,
        messages: [{ role: "user", content: "after-records-dacl-tamper" }],
        c6: {
          session_id: tamperSession,
          turn_id: 2,
          device_id: "dossier-device",
          project_id: "dossier-project",
          agent_id: "dossier-agent",
          leaf_id: "leaf-tamper-2",
        },
        leafTip: { id: "leaf-tamper-2", parentId: null, type: "message" },
      });
      if (afterTamper.status === "captured") {
        dieWorker("EDGE_TAMPER_NOT_DENIED", afterTamper.status);
      }
      // M9: exactly journal_failed after recordsDir DACL tamper — source_failed is NOT accepted.
      const tamperStatus = afterTamper.status;
      if (tamperStatus !== "journal_failed") {
        dieWorker("EDGE_TAMPER_STATUS", JSON.stringify({
          status: tamperStatus,
          code: afterTamper.error_code || null,
          expected: "journal_failed",
        }));
      }

      // M8 Partial audit: byte-exact prefix/length/suffix append evidence — no truncate/whitewash.
      // Do NOT require that a legal line forms its own independent line after partial mid-stream bytes.
      let partialEvidence = null;
      {
        const nativeMod = loadJiti("extensions/_shared/windows-native-addon.ts");
        const loaded = nativeMod.loadWindowsNativeAddon();
        const beforeBuf = fs.readFileSync(auditPath);
        const beforeLen = beforeBuf.length;
        const partialBytes = Buffer.from('{"schema":"broken-partial');
        // Append incomplete JSON via native durableAppendFile (same private_rw contract).
        nativeMod.durableAppendFile(loaded.addon, auditPath, partialBytes);
        const afterPartialBuf = fs.readFileSync(auditPath);
        // prefix exact: original bytes preserved
        if (!afterPartialBuf.subarray(0, beforeLen).equals(beforeBuf)) {
          dieWorker("EDGE_PARTIAL_PREFIX", "prefix truncated or rewritten");
        }
        // length exact: before + partial
        if (afterPartialBuf.length !== beforeLen + partialBytes.length) {
          dieWorker("EDGE_PARTIAL_LENGTH", JSON.stringify({
            before: beforeLen,
            after: afterPartialBuf.length,
            partial: partialBytes.length,
          }));
        }
        // suffix exact: trailing bytes are the partial fragment
        if (!afterPartialBuf.subarray(beforeLen).equals(partialBytes)) {
          dieWorker("EDGE_PARTIAL_SUFFIX", "suffix is not exact partial append");
        }
        let loadCode = null;
        try {
          await edge.loadEdgeCaptureAuditIndex(auditPath);
        } catch (e) {
          loadCode = errMsg(e) || errCode(e) || "threw";
        }
        if (!loadCode) dieWorker("EDGE_PARTIAL_LOAD_PASS", "load must fail-closed on partial");

        const midBuf = Buffer.from(afterPartialBuf);
        const midLen = midBuf.length;
        // Valid append after partial — must not wash; prefix including broken fragment preserved.
        await edge.appendEdgeAuditJsonlLine(auditPath, {
          schema: edge.EDGE_CAPTURE_AUDIT_SCHEMA,
          schema_version: 1,
          created_at: new Date().toISOString(),
          session_id: sessionId,
          content_id: sha256("dossier-audit-after-partial"),
          c6: auditEntry.c6,
          leaf_tip: leafTip,
          result: "capture_attempt",
        }, { trustRoot: abrain });
        const afterValidBuf = fs.readFileSync(auditPath);
        if (!afterValidBuf.subarray(0, midLen).equals(midBuf)) {
          dieWorker("EDGE_PARTIAL_AFTER_PREFIX", "valid append whitewashed prior partial bytes");
        }
        if (afterValidBuf.length <= midLen) {
          dieWorker("EDGE_PARTIAL_AFTER_LENGTH", "valid append did not grow file");
        }
        // Suffix after mid is the new append (must be nonempty growth; no requirement that
        // the partial fragment becomes its own legal JSONL line).
        const grown = afterValidBuf.subarray(midLen);
        if (grown.length === 0) {
          dieWorker("EDGE_PARTIAL_AFTER_SUFFIX", "no suffix growth after valid append");
        }
        let stillClosed = null;
        try {
          await edge.loadEdgeCaptureAuditIndex(auditPath);
        } catch (e) {
          stillClosed = errMsg(e) || errCode(e) || "threw";
        }
        if (!stillClosed) dieWorker("EDGE_PARTIAL_WHITEWASH", "load must remain fail-closed");
        partialEvidence = {
          before_len: beforeLen,
          after_partial_len: afterPartialBuf.length,
          after_valid_len: afterValidBuf.length,
          prefix_exact: true,
          length_exact: true,
          suffix_exact: true,
          after_prefix_preserved: true,
          no_truncate: true,
          no_whitewash: true,
        };
      }

      hardCleanup({ strict: true });
      emit({
        ok: true,
        mode,
        environment_scope: "temp_fixture_not_live_matrix",
        init: "ready",
        pair: { status: pairStatus, records: recordsCount, candidate: true, witness: true },
        coordination: {
          n,
          captured: n,
          producer_seq_continuous_unique: true,
          records_sources_exist: true,
          records_sources_no_native_temp: true,
        },
        audit: {
          append_signature: "appendEdgeAuditJsonlLine(auditPath,entry,{trustRoot})",
          partial_fail_closed: true,
          no_whitewash: true,
          partial_byte_evidence: partialEvidence,
        },
        dacl_tamper_records_dir: {
          status: tamperStatus,
          error_code: afterTamper.error_code || null,
          icacls_readback_everyone: true,
          no_autorepair: true,
        },
        no_override: true,
        residual: [],
      });
      return;
    }

    if (mode === "dcc") {
      const work = registerTemp(tempRoot("dcc"));
      assertHooksAbsent();
      const control = loadJiti("extensions/sediment/canonical-control.ts");

      // Production zero-arg platform support must be true under live pin.
      const supported = control.isDccAttestationPlatformSupported("win32");
      if (supported !== true) {
        dieWorker("DCC_PLATFORM_SUPPORTED", `expected true, got ${supported}`);
      }

      // Temp empty abrain — no forged authority store.
      const abrain = path.join(work, "abrain");
      fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });

      // observe — production call only; no testHooks/windowsAddon/authorityObservation.
      // Exceptions are NOT coerced to unavailable: TypeError/unknown must fail the worker.
      // Only explicit closed status+reason_code returns may pass as not-ready observation.
      const CLOSED_OBSERVE_STATUSES = new Set(["unavailable", "legacy", "blocked"]);
      const CLOSED_OBSERVE_REASONS = new Set([
        "none",
        "not_authorized",
        "authority_unavailable",
        "authority_revoked",
        "authority_stale",
        "attestation_unavailable",
        "attestation_not_ready",
        "head_mismatch",
        "observation_unstable",
      ]);
      let observe;
      try {
        observe = await control.observeForegroundCanonicalConvergence(abrain);
      } catch (e) {
        // Do not force status unavailable after unknown throw — fail closed.
        dieWorker("DCC_OBSERVE_THREW", JSON.stringify({
          name: e?.name || null,
          code: errCode(e),
          message: sanitizeFailureMessage(errMsg(e)).slice(0, 200),
        }));
      }
      if (observe?.status === "ready") {
        dieWorker("DCC_OBSERVE_READY", JSON.stringify(observe));
      }
      if (!CLOSED_OBSERVE_STATUSES.has(observe?.status)) {
        dieWorker("DCC_OBSERVE_OPEN_STATUS", JSON.stringify({
          status: observe?.status || null,
          reason_code: observe?.reason_code || null,
        }));
      }
      if (!CLOSED_OBSERVE_REASONS.has(observe?.reason_code)) {
        dieWorker("DCC_OBSERVE_OPEN_REASON", JSON.stringify({
          status: observe?.status || null,
          reason_code: observe?.reason_code || null,
        }));
      }

      // read — empty store → unavailable / null without inventing authority.
      let readerCode = null;
      let att = null;
      try {
        att = control.readCanonicalConvergenceAttestation(abrain);
      } catch (e) {
        readerCode = errCode(e) || errMsg(e);
      }
      if (att && att.outcome === "ready") {
        dieWorker("DCC_READ_READY", "empty abrain must not be ready");
      }
      // Accept null (absent) or closed unavailable throw.
      const readClosed =
        att == null
        || readerCode === "attestation_unavailable"
        || /attestation_unavailable|unavailable/i.test(String(readerCode || ""));
      if (!readClosed) {
        dieWorker("DCC_READ_OPEN", JSON.stringify({ att: !!att, readerCode }));
      }

      // kick — resolveAbrainHome is required production config dependency (not a test seam);
      // no testHooks/windowsAddon/authorityObservation.
      const kick = await control.runSedimentWorkerCanonicalControl(
        JSON.stringify({
          schema: "pi-astack/sediment-worker-canonical-control/v1",
          request_id: sha256("dossier-dcc-kick"),
          operation: "kick",
          local_executor_epoch: "1",
          local_executor_holder_nonce: sha256("dossier-dcc-holder"),
        }),
        {
          resolveAbrainHome: () => abrain,
        },
      );
      if (kick?.status === "ready") {
        dieWorker("DCC_KICK_READY", JSON.stringify({ status: kick.status, reason: kick.reason_code }));
      }
      const kickClosed =
        kick?.status === "unavailable"
        || kick?.status === "blocked"
        || kick?.status === "rejected"
        || /unavailable|authority|not_authorized|attestation/i.test(String(kick?.reason_code || ""));
      if (!kickClosed) {
        dieWorker("DCC_KICK_OPEN", JSON.stringify({ status: kick?.status, reason: kick?.reason_code }));
      }

      hardCleanup({ strict: true });
      emit({
        ok: true,
        mode,
        environment_scope: "temp_empty_abrain_fixture_not_live_matrix",
        coverage: "not_covered",
        platform_supported: true,
        observe: {
          status: observe.status,
          reason_code: observe.reason_code || null,
          ready: false,
        },
        read: {
          attestation_present: att != null,
          reader_code: readerCode,
          ready: false,
        },
        kick: {
          status: kick?.status || null,
          reason_code: kick?.reason_code || null,
          ready: false,
        },
        residual: [
          "dcc_not_covered_requires_live_daemon_lock_plus_real_git_plus_settled_kick",
          "temp_empty_abrain_observe_read_kick_closed_unavailable_or_authority_absent",
          "no_forged_authority_store",
        ],
        note: "honest partial: platform physical layer present; six-condition ready not constructed; temp fixture is not live DCC matrix",
      });
      return;
    }

    dieWorker("UNREACHABLE", mode);
  } catch (err) {
    // Failure path: best-effort cleanup; surface bounded cleanup_errors (never swallow).
    // Single failure JSON only (no second emit on success path).
    let cleanup_errors = [];
    try {
      cleanup_errors = hardCleanup({ strict: false }) || [];
    } catch (ce) {
      cleanup_errors = [`cleanup_threw:${sanitizeFailureMessage(ce?.message || ce).slice(0, 160)}`];
    }
    const code = err instanceof WorkerFail
      ? err.code
      : (err?.code || "WORKER_ERROR");
    const message = err instanceof WorkerFail
      ? err.message
      : (err?.stack || err?.message || String(err));
    emit({
      ok: false,
      code: String(code),
      message: sanitizeFailureMessage(message),
      cleanup_errors: cleanup_errors.map((e) => sanitizeFailureMessage(e)).slice(0, 16),
    });
    process.exitCode = 1;
    return;
  }
}

// ── Controller ─────────────────────────────────────────────────────────────
/**
 * Async worker runner: spawn (not spawnSync), explicit pid, taskkill /T /F on timeout,
 * bounded stdout/stderr, no orphan descendants.
 */
function runWorker(mode, { timeoutMs = 180_000 } = {}) {
  if (!WORKER_MODES.has(mode)) throw new Error(`unknown worker mode ${mode}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, "--worker", mode], {
      cwd: repoRoot,
      windowsHide: true,
      env: cleanEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const workerPid = child.pid || null;
    let stdout = "";
    let stderr = "";
    const MAX_OUT = 512 * 1024;
    const MAX_ERR = 64 * 1024;
    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        if (stdout.length >= MAX_OUT) return;
        stdout += String(chunk).slice(0, MAX_OUT - stdout.length);
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        if (stderr.length >= MAX_ERR) return;
        stderr += String(chunk).slice(0, MAX_ERR - stderr.length);
      });
    }
    let settled = false;
    const finish = (status, signal, error_code = null) => {
      if (settled) return;
      settled = true;
      const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
      const jsons = [];
      for (const line of lines) {
        try {
          jsons.push(JSON.parse(line));
        } catch {
          // ignore non-json noise
        }
      }
      resolve({
        status,
        signal: signal || null,
        error_code,
        worker_pid: workerPid,
        stderr: sanitizeFailureMessage(stderr),
        stdout: stdout.slice(0, MAX_OUT),
        json: jsons[jsons.length - 1] || null,
        jsons,
      });
    };
    const timer = setTimeout(() => {
      try {
        if (workerPid && isPidAlive(workerPid)) killTree(workerPid);
      } catch { /* ignore */ }
      // Give taskkill a moment, then force-resolve.
      setTimeout(() => {
        finish(null, "timeout", "WORKER_TIMEOUT");
      }, 500);
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      finish(null, "error", sanitizeFailureMessage(err?.code || err?.message || "spawn_error"));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      // If we already timed out, ignore late exit.
      if (settled) return;
      finish(code == null ? null : code, signal || null, null);
    });
  });
}

function parseArgs(argv) {
  const out = { selfTest: false, worker: null };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === "--self-test") out.selfTest = true;
    else if (argv[i] === "--worker") {
      out.worker = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

function boundEvidence(obj, max = 4000) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= max) return obj;
    return { truncated: true, preview: s.slice(0, max) };
  } catch {
    return { unserializable: true };
  }
}

function abrainGuardPair(before, after) {
  const unchanged =
    before.valid === true
    && after.valid === true
    && before.count === after.count
    && before.sha256 === after.sha256;
  return {
    before: { count: before.count, sha256: before.sha256, valid: before.valid, invalid_reason: before.invalid_reason },
    after: { count: after.count, sha256: after.sha256, valid: after.valid, invalid_reason: after.invalid_reason },
    unchanged,
  };
}

/** Closed deferred residuals that keep overall production accepted:false.
 *  No env/manifest/ingestion path can clear these in this dossier revision.
 *  Redesign of cross-host evidence is deferred until after daemon refactor.
 */
const OVERALL_DEFERRED_BLOCKING_RESIDUALS = Object.freeze([
  "external_matrix_deferred_until_daemon_redesign",
  "daemon_dcc_live_not_covered",
  "live_matrix_stable_edge_not_covered",
  "linux_zero_regression_not_covered",
  "second_account_dacl_tamper_not_covered",
  "node_22_and_server_external_evidence_not_covered",
]);

/** Residual classification: known (documented open items) vs blocking (must clear for overall accepted). */
function classifyResiduals(list) {
  const KNOWN = new Set([
    // Practical threat-model documentation (NOT a global atomic-TOCTOU overall blocker).
    "threat_model_same_token_and_admin_out_of_contract",
    "threat_model_hash_pin_package_rx_provenance_and_corruption_detection",
    "dcc_not_covered_requires_live_daemon_lock_plus_real_git_plus_settled_kick",
    "temp_empty_abrain_observe_read_kick_closed_unavailable_or_authority_absent",
    "no_forged_authority_store",
    "self_test_only_not_production_acceptance",
    "source_commit_not_ancestor_of_HEAD",
    "source_commit_equals_HEAD_rejected",
    "source_commit_to_artifact_not_only_package_outputs",
    "artifact_commit_not_found_for_live_blobs",
    "post_artifact_non_docs_drift",
    "live_package_blob_hash_failed",
    "production_pin_null",
    "git_worktree_dirty",
    "git_worktree_dirty_after_workers",
    // Lineage per-commit residuals.
    "source_commit_not_ancestor_of_artifact",
    "artifact_commit_not_ancestor_of_HEAD",
    "source_to_artifact_not_exactly_one_artifact_commit",
    "source_to_artifact_rev_list_failed",
    "artifact_to_head_rev_list_failed",
    "artifact_commit_paths_unreadable",
    "post_artifact_commit_paths_unreadable",
    // Closed deferred overall gaps (honest partial; not local extension scope).
    ...OVERALL_DEFERRED_BLOCKING_RESIDUALS,
  ]);
  const BLOCKING = new Set([
    // Mechanical / integrity blockers.
    "dcc_not_covered_requires_live_daemon_lock_plus_real_git_plus_settled_kick",
    "temp_empty_abrain_observe_read_kick_closed_unavailable_or_authority_absent",
    "git_worktree_dirty",
    "git_worktree_dirty_after_workers",
    "live_abrain_mutated",
    "live_abrain_guard_invalid",
    "live_abrain_guard_invalid_or_changed",
    "provenance_load_failed",
    "package_rx_three_point_incomplete",
    "retained_lock_failed",
    "dacl_failed",
    "stable_view_failed",
    "edge_failed",
    "dcc_failed",
    "source_commit_not_ancestor_of_HEAD",
    "source_commit_equals_HEAD_rejected",
    "source_commit_to_artifact_not_only_package_outputs",
    "source_commit_not_ancestor_of_artifact",
    "artifact_commit_not_ancestor_of_HEAD",
    "source_to_artifact_not_exactly_one_artifact_commit",
    "artifact_commit_not_found_for_live_blobs",
    "post_artifact_non_docs_drift",
    "live_package_blob_hash_failed",
    // Deferred overall hard gaps — always block overall accepted in this revision.
    ...OVERALL_DEFERRED_BLOCKING_RESIDUALS,
  ]);
  const known = [];
  const blocking = [];
  for (const r of list) {
    const dynamicKnown = r.startsWith("post_artifact_commit_non_docs:");
    const dynamicBlocking = dynamicKnown;
    if (KNOWN.has(r) || BLOCKING.has(r) || dynamicKnown) known.push(r);
    if (BLOCKING.has(r) || dynamicBlocking) blocking.push(r);
    else if (!KNOWN.has(r) && !dynamicKnown) {
      // Unknown residuals are treated as blocking by default.
      known.push(r);
      blocking.push(r);
    }
  }
  return { known: [...new Set(known)], blocking: [...new Set(blocking)] };
}

/** Always-on deferred residuals for overall production acceptance. */
function pushOverallDeferredResiduals(residuals) {
  for (const r of OVERALL_DEFERRED_BLOCKING_RESIDUALS) residuals.push(r);
  return residuals;
}

/**
 * Local extension-scope conclusion. Pass ≠ production accepted.
 * Covers provenance/native package/retained/DACL/stable/edge mechanical gates.
 */
function evaluateExtensionWindowsAdaptation({
  gatesReady,
  sections,
  anyFail,
  abrain_guard,
  beforeAbrain,
  afterAbrain,
  gitCleanAfter,
  residual_class,
}) {
  const localSectionPass =
    sections.structural?.status === "pass"
    && sections.provenance?.status === "pass"
    && sections.retained_lock?.status === "pass"
    && sections.dacl?.status === "pass"
    && sections.stable_view?.status === "pass"
    && sections.edge?.status === "pass";
  // DCC is daemon-scoped; not required for extension_windows_adaptation pass.
  const localMechanicalBlockers = residual_class.blocking.filter(
    (r) => !OVERALL_DEFERRED_BLOCKING_RESIDUALS.includes(r)
      && r !== "dcc_not_covered_requires_live_daemon_lock_plus_real_git_plus_settled_kick"
      && r !== "temp_empty_abrain_observe_read_kick_closed_unavailable_or_authority_absent",
  );
  const pass =
    gatesReady
    && !anyFail
    && localSectionPass
    && abrain_guard.unchanged
    && beforeAbrain.valid === true
    && afterAbrain.valid === true
    && gitCleanAfter
    && localMechanicalBlockers.length === 0;
  return {
    status: !gatesReady ? "gates_failed" : anyFail ? "fail" : pass ? "pass" : "partial",
    pass,
    note: "extension_windows_adaptation pass is local mechanical evidence only; it is NOT overall production accepted",
  };
}

async function mainController() {
  const args = parseArgs(process.argv);
  const beforeAbrain = snapshotAbrainGuard();
  const runtime = {
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    os_type: os.type(),
    os_release: os.release(),
    fs_type: detectFsType(repoRoot),
  };

  if (args.selfTest) {
    const probe = await runWorker("self-test-probe", { timeoutMs: 60_000 });
    const afterAbrain = snapshotAbrainGuard();
    const abrain_guard = abrainGuardPair(beforeAbrain, afterAbrain);

    // Lineage unit negatives (pure path class) + real temp git DAG.
    const lineage_unit = {
      package_output_class: classifyLineagePath("extensions/_shared/windows-native-addon-pin.ts"),
      docs_class: classifyLineagePath("docs/plans/example.md"),
      source_class: classifyLineagePath("extensions/_shared/windows-native-addon.ts"),
      scripts_class: classifyLineagePath("scripts/dossier-windows-native-production-acceptance.mjs"),
      post_docs_only_ok: evaluateRangeAgainstAllowlist(
        ["docs/plans/a.md", "docs/completions/b.md"],
        isDocsOrEvidencePath,
      ).ok,
      post_source_drift_rejected: evaluateRangeAgainstAllowlist(
        ["docs/plans/a.md", "extensions/_shared/windows-native-addon.ts"],
        isDocsOrEvidencePath,
      ).ok === false,
      artifact_range_requires_exact_package_set:
        evaluateRangeAgainstAllowlist([...PACKAGE_OUTPUT_PATHS], isPackageOutputPath).ok
        && evaluateRangeAgainstAllowlist(
          [...PACKAGE_OUTPUT_PATHS, "extensions/_shared/windows-native-addon.ts"],
          isPackageOutputPath,
        ).ok === false,
    };
    const lineage_unit_pass =
      lineage_unit.package_output_class === "package_output"
      && lineage_unit.docs_class === "docs_or_evidence"
      && lineage_unit.source_class === "source_or_other"
      && lineage_unit.scripts_class === "source_or_other"
      && lineage_unit.post_docs_only_ok === true
      && lineage_unit.post_source_drift_rejected === true
      && lineage_unit.artifact_range_requires_exact_package_set === true;

    const lineage_dag = runLineageGitDagSelfTest();

    // Assert: external matrix deferred; overall never greens from local sections alone.
    // No matrix schema / pseudo command evidence fixtures in this revision.
    const deferredResiduals = [];
    pushOverallDeferredResiduals(deferredResiduals);
    const threatResiduals = [
      "threat_model_same_token_and_admin_out_of_contract",
      "threat_model_hash_pin_package_rx_provenance_and_corruption_detection",
    ];
    const residual = [
      "self_test_only_not_production_acceptance",
      ...threatResiduals,
      ...deferredResiduals,
    ];
    const residual_class = classifyResiduals(residual);
    const threat_not_blocking = threatResiduals.every((r) => !residual_class.blocking.includes(r));
    const deferred_all_blocking = OVERALL_DEFERRED_BLOCKING_RESIDUALS.every((r) =>
      residual_class.blocking.includes(r),
    );
    const deferred_present = OVERALL_DEFERRED_BLOCKING_RESIDUALS.every((r) => residual.includes(r));

    // Simulate local sections all-pass — overall must still be false/partial.
    const simulatedLocalPassSections = {
      structural: { status: "pass" },
      provenance: { status: "pass" },
      retained_lock: { status: "pass" },
      dacl: { status: "pass" },
      stable_view: { status: "pass" },
      edge: { status: "pass" },
      dcc: { status: "not_covered" },
    };
    const simulatedExtension = evaluateExtensionWindowsAdaptation({
      gatesReady: true,
      sections: simulatedLocalPassSections,
      anyFail: false,
      abrain_guard: { unchanged: true },
      beforeAbrain: { valid: true },
      afterAbrain: { valid: true },
      gitCleanAfter: true,
      residual_class,
    });
    const simulatedOverallAccepted =
      residual_class.blocking.length === 0
      && simulatedLocalPassSections.dcc.status === "pass";
    const overall_never_green_from_local =
      simulatedExtension.pass === true
      && simulatedOverallAccepted === false
      && deferred_all_blocking
      && deferred_present;

    // Static surface checks: this dossier source must not contain first-matrix ingestion.
    // Tokens are assembled so this self-test source does not embed the forbidden identifiers literally.
    const selfPath = path.join(repoRoot, "scripts", "dossier-windows-native-production-acceptance.mjs");
    const srcText = fs.readFileSync(selfPath, "utf8");
    const banned = [
      ["FIRST", "MATRIX", "SLOT", "IDS"].join("_"),
      ["load", "First", "Matrix", "Evidence"].join(""),
      ["evaluate", "First", "Matrix", "Evidence"].join(""),
      ["run", "First", "Matrix", "Evidence", "SelfTest"].join(""),
      ["validate", "Slot", "Dossier", "Schema"].join(""),
      ["validate", "First", "Matrix", "Index", "Schema"].join(""),
      ["windows", "native", "first", "matrix", "evidence"].join("-"),
      ["MATRIX", "COMMAND", "SPECS"].join("_"),
      "--" + "evidence",
    ];
    const no_matrix_ingestion_surface =
      !residual.some((r) => r.startsWith("first_matrix_"))
      && banned.every((token) => !srcText.includes(token));

    const body = {
      dossier_version: DOSSIER_VERSION,
      mode: "self-test",
      accepted: false,
      status: "self_test_only",
      runtime,
      root_source: liveAbrainRootSource,
      worker_probe: probe.json,
      worker_exit: {
        status: probe.status,
        signal: probe.signal,
        error_code: probe.error_code || null,
        worker_pid: probe.worker_pid || null,
      },
      structural: probe.json?.structural || null,
      lineage_unit,
      lineage_unit_pass,
      lineage_dag,
      external_matrix_deferred: deferred_present,
      deferred_residuals_blocking: deferred_all_blocking,
      overall_never_green_from_local,
      no_matrix_ingestion_surface,
      extension_windows_adaptation_simulated: simulatedExtension,
      threat_model_residuals_not_blocking: threat_not_blocking,
      residual,
      residual_class,
      abrain_guard,
      note: "self-test only; extension_windows_adaptation simulation pass is not production accepted; external matrix deferred; no first-matrix schema/command fixtures",
    };
    body.accepted = false;
    const selfTestPass =
      lineage_unit_pass
      && threat_not_blocking
      && lineage_dag.pass
      && deferred_present
      && deferred_all_blocking
      && overall_never_green_from_local
      && no_matrix_ingestion_surface
      && body.accepted === false;
    emit(body);
    process.exitCode = selfTestPass ? 0 : 1;
    return;
  }

  if (process.platform !== "win32" || process.arch !== "x64") {
    emit({
      dossier_version: DOSSIER_VERSION,
      accepted: false,
      status: "not_applicable",
      extension_windows_adaptation: { status: "not_applicable", pass: false },
      runtime,
      residual: ["runtime_not_win32_x64"],
    });
    process.exitCode = 0;
    return;
  }

  const gateEval = evaluateProvenanceGates();
  const sections = {};
  const residuals = [...gateEval.residuals];

  // Structural (controller, source only — no dlopen).
  {
    const src = fs.readFileSync(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"), "utf8");
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const loadCall = codeOnly.indexOf("loadNativeModule(paths.binaryPath)");
    const rehashCall = codeOnly.indexOf("assertSameFdBinaryHash(");
    const afterIdCall = codeOnly.indexOf('assertBinaryIdentityUnchanged(io, fd, paths.binaryPath, preIdentity, "after-load")');
    const selfIdCall = codeOnly.indexOf("assertIdentityMatchesManifest(");
    const sameFdOrderOk =
      loadCall >= 0
      && rehashCall > loadCall
      && afterIdCall > rehashCall
      && selfIdCall > afterIdCall;
    sections.structural = {
      status: "pass",
      production_arity_zero: /\bexport function loadWindowsNativeAddon\(\)/.test(src),
      no_runtime_download: !/\b(?:fetch|https?\.get|axios|got|curl|wget)\b/i.test(codeOnly),
      no_runtime_compile: !/\b(?:node-gyp|cmake-js|prebuild-install|node-pre-gyp)\b/i.test(codeOnly),
      controller_no_dlopen: true,
      same_fd_post_dlopen_rehash: sameFdOrderOk ? "pass" : "fail",
    };
    if (
      !sections.structural.production_arity_zero
      || !sections.structural.no_runtime_download
      || !sections.structural.no_runtime_compile
      || sections.structural.same_fd_post_dlopen_rehash !== "pass"
    ) {
      sections.structural.status = "fail";
      residuals.push("structural_loader_contract");
    }
  }

  const gatesReady =
    gateEval.gates.platform_win32_x64
    && gateEval.gates.git_clean
    && gateEval.gates.pin_tracked
    && gateEval.gates.manifest_tracked
    && gateEval.gates.binary_tracked
    && gateEval.gates.artifacts_on_disk
    && gateEval.gates.pin_live
    && gateEval.gates.source_commit_is_ancestor
    && gateEval.gates.source_commit_is_ancestor_of_artifact
    && gateEval.gates.artifact_commit_is_ancestor_of_head
    && gateEval.gates.artifact_commit_found
    && gateEval.gates.artifact_range_only_package_outputs
    && gateEval.gates.post_artifact_docs_only
    && gateEval.gates.live_blobs_match_artifact;

  // Practical threat-model evidence (known non-secret residuals; NOT overall atomic-TOCTOU blocker).
  residuals.push("threat_model_same_token_and_admin_out_of_contract");
  residuals.push("threat_model_hash_pin_package_rx_provenance_and_corruption_detection");

  // Closed deferred overall gaps — always present; no env/manifest switch clears them.
  pushOverallDeferredResiduals(residuals);

  if (!gatesReady) {
    const afterAbrain = snapshotAbrainGuard();
    const abrain_guard = abrainGuardPair(beforeAbrain, afterAbrain);
    if (!abrain_guard.unchanged || !beforeAbrain.valid || !afterAbrain.valid) {
      residuals.push("live_abrain_guard_invalid_or_changed");
    }
    const uniqueResiduals = [...new Set(residuals)];
    const residual_class = classifyResiduals(uniqueResiduals);
    const extension_windows_adaptation = evaluateExtensionWindowsAdaptation({
      gatesReady: false,
      sections,
      anyFail: sections.structural?.status === "fail",
      abrain_guard,
      beforeAbrain,
      afterAbrain,
      gitCleanAfter: worktreeClean(),
      residual_class,
    });
    emit({
      dossier_version: DOSSIER_VERSION,
      accepted: false,
      status: "partial",
      extension_windows_adaptation,
      runtime,
      root_source: liveAbrainRootSource,
      gates: gateEval.gates,
      pin: {
        manifest_sha256: gateEval.pin.manifest_sha256,
        source_commit: gateEval.pin.source_commit,
      },
      head: gateEval.head,
      head_parent: gateEval.parent,
      artifact_commit: gateEval.artifact_commit,
      lineage: gateEval.lineage,
      sections,
      residual: uniqueResiduals,
      residual_class,
      abrain_guard,
      note: "overall production accepted is false/partial while deferred residuals remain; extension_windows_adaptation is a separate local conclusion and is not production accepted; artifact lineage binds pin/manifest/binary content; docs/evidence commits after artifact are allowed; no first-matrix external evidence ingestion in this revision",
    });
    process.exitCode = 0;
    return;
  }

  const sectionFail = (r, label) => ({
    status: "fail",
    exit: r.status,
    signal: r.signal,
    error_code: r.error_code || null,
    worker_pid: r.worker_pid || null,
    stderr: String(r.stderr || "").slice(0, 500),
    evidence: boundEvidence(r.json),
    label,
  });

  // Provenance zero-arg load (child) + package_rx three-point gate.
  {
    const r = await runWorker("provenance-load");
    const prx = r.json?.package_rx;
    const threePoint =
      prx
      && prx.directory === "pass"
      && prx.binary === "pass"
      && prx.manifest === "pass";
    if (r.status === 0 && r.json?.ok && threePoint) {
      // Successful zero-arg load path includes post-dlopen same-fd rehash (loader contract).
      sections.provenance = {
        status: "pass",
        same_fd_post_dlopen_rehash: "pass",
        evidence: boundEvidence(r.json),
      };
      gateEval.gates.package_rx = true;
    } else {
      sections.provenance = sectionFail(r, "provenance-load");
      if (!threePoint && r.json?.ok) {
        sections.provenance.reason = "package_rx_three_point_incomplete";
        residuals.push("package_rx_three_point_incomplete");
      }
      residuals.push("provenance_load_failed");
      gateEval.gates.package_rx = false;
    }
  }

  // Retained lock production adapter.
  {
    const r = await runWorker("retained-lock", { timeoutMs: 240_000 });
    if (r.status === 0 && r.json?.ok) {
      sections.retained_lock = { status: "pass", evidence: boundEvidence(r.json) };
    } else {
      sections.retained_lock = sectionFail(r, "retained-lock");
      residuals.push("retained_lock_failed");
    }
  }

  // DACL production matrix.
  {
    const r = await runWorker("dacl");
    if (r.status === 0 && r.json?.ok) {
      sections.dacl = { status: "pass", evidence: boundEvidence(r.json) };
    } else {
      sections.dacl = sectionFail(r, "dacl");
      residuals.push("dacl_failed");
    }
  }

  // Stable-view: full pass only (temp ABRAIN_ROOT production self-publication; not live matrix).
  {
    const r = await runWorker("stable-view", { timeoutMs: 240_000 });
    if (r.status === 0 && r.json?.ok && Array.isArray(r.json.residual) && r.json.residual.length === 0) {
      sections.stable_view = {
        status: "pass",
        environment_scope: r.json.environment_scope || "temp_ABRAIN_ROOT_fixture_not_live_matrix",
        evidence: boundEvidence(r.json),
      };
    } else if (r.status === 0 && r.json?.ok) {
      sections.stable_view = {
        status: "fail",
        reason: "residual_not_allowed_for_pass",
        environment_scope: r.json.environment_scope || "temp_ABRAIN_ROOT_fixture_not_live_matrix",
        evidence: boundEvidence(r.json),
      };
      residuals.push("stable_view_residual");
      residuals.push(...(r.json.residual || []));
    } else {
      sections.stable_view = sectionFail(r, "stable-view");
      residuals.push("stable_view_failed");
    }
  }

  // Edge: full pass only (temp fixture; not live matrix).
  {
    const r = await runWorker("edge", { timeoutMs: 300_000 });
    if (r.status === 0 && r.json?.ok && Array.isArray(r.json.residual) && r.json.residual.length === 0) {
      sections.edge = {
        status: "pass",
        environment_scope: r.json.environment_scope || "temp_fixture_not_live_matrix",
        evidence: boundEvidence(r.json),
      };
    } else if (r.status === 0 && r.json?.ok) {
      sections.edge = {
        status: "fail",
        reason: "residual_not_allowed_for_pass",
        environment_scope: r.json.environment_scope || "temp_fixture_not_live_matrix",
        evidence: boundEvidence(r.json),
      };
      residuals.push("edge_residual");
      residuals.push(...(r.json.residual || []));
    } else {
      sections.edge = sectionFail(r, "edge");
      residuals.push("edge_failed");
    }
  }

  // DCC — honest not_covered → overall partial; accepted stays false.
  // Temp empty abrain is fixture, not live DCC matrix.
  {
    const r = await runWorker("dcc", { timeoutMs: 180_000 });
    if (r.status === 0 && r.json?.ok) {
      if (r.json.coverage === "not_covered") {
        sections.dcc = {
          status: "not_covered",
          environment_scope: r.json.environment_scope || "temp_empty_abrain_fixture_not_live_matrix",
          evidence: boundEvidence(r.json),
        };
        residuals.push(...(r.json.residual || ["dcc_not_covered"]));
      } else if (r.json.coverage === "covered") {
        sections.dcc = { status: "pass", evidence: boundEvidence(r.json) };
      } else {
        sections.dcc = {
          status: "fail",
          reason: "unknown_coverage",
          evidence: boundEvidence(r.json),
        };
        residuals.push("dcc_unknown_coverage");
      }
    } else {
      sections.dcc = sectionFail(r, "dcc");
      residuals.push("dcc_failed");
    }
  }


  // After all workers: git clean recheck.
  if (!worktreeClean()) {
    residuals.push("git_worktree_dirty_after_workers");
  }

  const afterAbrain = snapshotAbrainGuard();
  const abrain_guard = abrainGuardPair(beforeAbrain, afterAbrain);
  if (!beforeAbrain.valid || !afterAbrain.valid) {
    residuals.push("live_abrain_guard_invalid");
  }
  if (!abrain_guard.unchanged) residuals.push("live_abrain_mutated");

  const anyFail = Object.values(sections).some((s) => s.status === "fail");
  const uniqueResiduals = [...new Set(residuals)];
  // Re-assert deferred residuals cannot be dropped by workers/env.
  pushOverallDeferredResiduals(uniqueResiduals);
  const finalResiduals = [...new Set(uniqueResiduals)];
  const residual_class = classifyResiduals(finalResiduals);
  const gitCleanAfter = !finalResiduals.includes("git_worktree_dirty_after_workers");

  const extension_windows_adaptation = evaluateExtensionWindowsAdaptation({
    gatesReady: true,
    sections,
    anyFail,
    abrain_guard,
    beforeAbrain,
    afterAbrain,
    gitCleanAfter,
    residual_class,
  });

  // Overall production accepted: intentionally false while deferred residuals exist.
  // No env/manifest/ingestion switch. Extension pass must not imply overall accepted.
  const accepted = false;
  const status = anyFail && !extension_windows_adaptation.pass ? "failed" : "partial";

  emit({
    dossier_version: DOSSIER_VERSION,
    accepted,
    status,
    extension_windows_adaptation,
    runtime,
    root_source: liveAbrainRootSource,
    gates: gateEval.gates,
    pin: {
      manifest_sha256: gateEval.pin.manifest_sha256,
      source_commit: gateEval.pin.source_commit,
    },
    head: gateEval.head,
    head_parent: gateEval.parent,
    artifact_commit: gateEval.artifact_commit,
    lineage: gateEval.lineage,
    sections,
    residual: finalResiduals,
    residual_class,
    abrain_guard,
    git_clean_after_workers: gitCleanAfter,
    note: "exit 0 means dossier execution completed; accepted is overall production accepted and stays false while closed deferred residuals remain (daemon DCC/live matrix/Linux/second-account/Node22+Server); extension_windows_adaptation is a separate local conclusion and must not be called production accepted; threat-model residuals document same-token/admin out-of-contract; docs commits after artifact do not fail read-only revalidation; WIN-BINARY not auto-claimed; temp fixtures are not live matrix; no first-matrix external evidence ingestion in this revision",
  });
  process.exitCode = 0;
}

// Entry
if (process.argv[2] === "--worker") {
  Promise.resolve()
    .then(() => runWorkerMain())
    .catch((err) => {
      // Last-resort top-level catch (should already be handled inside runWorkerMain).
      emit({
        ok: false,
        code: err?.code || "WORKER_TOP",
        message: sanitizeFailureMessage(err?.stack || err?.message || err),
      });
      process.exitCode = 1;
    });
} else {
  mainController().catch((err) => {
    emit({
      dossier_version: DOSSIER_VERSION,
      accepted: false,
      status: "controller_error",
      error_code: err?.code || (err?.name === "TimeoutError" ? "timeout" : "controller_error"),
      error: sanitizeFailureMessage(err?.stack || err?.message || err),
    });
    process.exitCode = 0;
  });
}
