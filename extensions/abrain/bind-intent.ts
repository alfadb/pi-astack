/**
 * Durable create-only bind intent outbox for abrain project registration.
 *
 * Lives in abrain's own .state namespace (NOT sediment publication-outbox).
 * Tracked abrain files (projects/<id>/_project.json, .gitignore) are never
 * written as unowned dirty worktree state by the foreground /abrain bind
 * path; they are applied under the existing canonical barrier/receipt/drain
 * authority once startup is ready or an explicit sync trigger runs.
 */

import * as crypto from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  durableAtomicCreateFile,
  durableAtomicWriteFile,
} from "../_shared/durable-write";
import { canonicalizeJcs, normalizeJcsValueOmittingUndefined } from "../_shared/jcs";
import {
  abrainProjectLocalMapPath,
  abrainProjectManifestPath,
  abrainProjectRegistryPath,
  computeAbrainStateGitignoreNext,
  emptyAbrainLocalProjectMap,
  parseAbrainLocalProjectMap,
  parseAbrainProjectManifest,
  parseAbrainProjectRegistry,
  readOptionalRegularFileNoFollowSync,
  validateAbrainProjectId,
  withFileLock,
  type AbrainLocalProjectMap,
  type AbrainProjectRegistry,
} from "../_shared/runtime";
import {
  createProducedArtifactReceipt,
  getCanonicalGitRuntime,
  type ProducedArtifact,
} from "../_shared/canonical-git-runtime";
import { withCanonicalMutationBarrier } from "../_shared/canonical-mutation-barrier";

export const ABRAIN_BIND_INTENT_SCHEMA = "abrain-bind-intent/v1" as const;

export interface AbrainBindIntent {
  schema: typeof ABRAIN_BIND_INTENT_SCHEMA;
  itemId: string;
  projectId: string;
  projectRoot: string;
  normalizedPath: string;
  registryRelativePath: string;
  registryBytes: string;
  registryCreated: boolean;
  gitignoreRelativePath: string;
  gitignoreBytes: string | null;
  gitignoreUpdated: boolean;
  message: string;
}

export type AbrainBindIntentWriteStatus = "created" | "identical" | "collision";

function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

export function abrainBindIntentRoot(abrainHome: string): string {
  return path.join(path.resolve(abrainHome), ".state", "abrain", "bind-intent");
}

export function abrainBindIntentPendingDir(abrainHome: string): string {
  return path.join(abrainBindIntentRoot(abrainHome), "pending");
}

export function abrainBindIntentDoneDir(abrainHome: string): string {
  return path.join(abrainBindIntentRoot(abrainHome), "done");
}

export function abrainBindIntentFailedDir(abrainHome: string): string {
  return path.join(abrainBindIntentRoot(abrainHome), "failed");
}

export function abrainBindIntentPendingPath(abrainHome: string, itemId: string): string {
  if (!/^[0-9a-f]{64}$/.test(itemId)) throw new Error(`invalid bind intent itemId: ${itemId}`);
  return path.join(abrainBindIntentPendingDir(abrainHome), `${itemId}.json`);
}

export function computeAbrainBindIntentItemId(input: Omit<AbrainBindIntent, "schema" | "itemId">): string {
  const identity = {
    schema: ABRAIN_BIND_INTENT_SCHEMA,
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    normalizedPath: input.normalizedPath,
    registryRelativePath: input.registryRelativePath,
    registryBytes: input.registryBytes,
    registryCreated: input.registryCreated,
    gitignoreRelativePath: input.gitignoreRelativePath,
    gitignoreBytes: input.gitignoreBytes,
    gitignoreUpdated: input.gitignoreUpdated,
    message: input.message,
  };
  return sha256Hex(canonicalizeJcs(normalizeJcsValueOmittingUndefined(identity)));
}

export function buildAbrainBindIntent(input: Omit<AbrainBindIntent, "schema" | "itemId">): AbrainBindIntent {
  validateAbrainProjectId(input.projectId);
  const itemId = computeAbrainBindIntentItemId(input);
  return {
    schema: ABRAIN_BIND_INTENT_SCHEMA,
    itemId,
    ...input,
  };
}

export async function writeAbrainBindIntent(
  abrainHome: string,
  intent: AbrainBindIntent,
): Promise<{ status: AbrainBindIntentWriteStatus; itemId: string; filePath: string; intent: AbrainBindIntent }> {
  if (intent.schema !== ABRAIN_BIND_INTENT_SCHEMA) {
    throw new Error(`unsupported bind intent schema: ${String((intent as { schema?: unknown }).schema)}`);
  }
  const expected = computeAbrainBindIntentItemId(intent);
  if (intent.itemId !== expected) {
    throw new Error(`bind intent itemId mismatch: ${intent.itemId} !== ${expected}`);
  }
  // done lookup: inspect-only chain (no create); never bare readFile through symlink ancestors.
  const doneBucket = await resolveBindIntentBucketDir(abrainHome, "done", { create: false });
  if (doneBucket) {
    const donePath = path.join(doneBucket.dir, `${intent.itemId}.json`);
    try {
      const rawDone = await readStrictBindIntentJsonFile(donePath);
      const done = parseValidBindIntentRecord(rawDone, intent.itemId, { allowNote: false });
      if (done && canonicalizeJcs(done) === canonicalizeJcs(intent)) {
        return { status: "identical", itemId: intent.itemId, filePath: donePath, intent: done };
      }
      return { status: "collision", itemId: intent.itemId, filePath: donePath, intent };
    } catch (err) {
      if (!(err instanceof Error) || err.message !== "bind_intent_file_missing") {
        // Present-but-unreadable / invalid / identity race: preserve create-only collision.
        return { status: "collision", itemId: intent.itemId, filePath: donePath, intent };
      }
    }
  }
  // failed lookup: any named entry (incl. symlink leaf) is a hard collision; no follow.
  const failedBucket = await resolveBindIntentBucketDir(abrainHome, "failed", { create: false });
  if (failedBucket) {
    const failedPath = path.join(failedBucket.dir, `${intent.itemId}.json`);
    try {
      await fs.lstat(failedPath);
      return { status: "collision", itemId: intent.itemId, filePath: failedPath, intent };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("bind_intent_file_unreadable");
      }
    }
  }
  // pending create: ensure plain chain from ABRAIN root (no symlink follow).
  const pendingBucket = await resolveBindIntentBucketDir(abrainHome, "pending", { create: true });
  if (!pendingBucket) throw new Error("bind_intent_path_invalid");
  const filePath = path.join(pendingBucket.dir, `${intent.itemId}.json`);
  const raw = `${JSON.stringify(intent)}\n`;
  const createStatus = await durableAtomicCreateFile(filePath, raw, { mode: 0o600 });
  if (createStatus !== "collision") return { status: createStatus, itemId: intent.itemId, filePath, intent };
  try {
    const existingRaw = await readStrictBindIntentJsonFile(filePath);
    const existing = parseValidBindIntentRecord(existingRaw, intent.itemId, { allowNote: false });
    if (existing && canonicalizeJcs(existing) === canonicalizeJcs(intent)) {
      return { status: "identical", itemId: intent.itemId, filePath, intent: existing };
    }
  } catch {
    // hard collision
  }
  return { status: "collision", itemId: intent.itemId, filePath, intent };
}

/** Aggregate-only bind-intent inventory. Never leaks itemId/path/detail. */
export interface AbrainBindIntentInventory {
  readonly pending: number;
  readonly failed: number;
  readonly invalid: number;
}

const BIND_INTENT_ITEM_ID_RE = /^[0-9a-f]{64}$/;
const MAX_BIND_INTENT_BYTES = 256 * 1024;
const BIND_INTENT_REQUIRED_KEYS = [
  "schema",
  "itemId",
  "projectId",
  "projectRoot",
  "normalizedPath",
  "registryRelativePath",
  "registryBytes",
  "registryCreated",
  "gitignoreRelativePath",
  "gitignoreBytes",
  "gitignoreUpdated",
  "message",
] as const;
const BIND_INTENT_STRING_KEYS = [
  "itemId",
  "projectId",
  "projectRoot",
  "normalizedPath",
  "registryRelativePath",
  "registryBytes",
  "gitignoreRelativePath",
  "message",
] as const;

function sameFileIdentity(left: fsSync.BigIntStats, right: fsSync.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Strict JSON bind-intent record validation.
 * - exact required keys + exact JSON types (no String()/===true coercion)
 * - pending: note forbidden; failed: optional string note only
 * - unknown keys (incl. `__proto__`) rejected via own-key enumeration, not `in`
 */
function parseValidBindIntentRecord(
  raw: unknown,
  expectedItemId: string,
  options: { allowNote: boolean },
): AbrainBindIntent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value);
  const allowed = new Set<string>(BIND_INTENT_REQUIRED_KEYS);
  if (options.allowNote) allowed.add("note");
  for (const key of keys) {
    if (!allowed.has(key)) return null;
  }
  for (const key of BIND_INTENT_REQUIRED_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
  }
  if (value.schema !== ABRAIN_BIND_INTENT_SCHEMA) return null;
  for (const key of BIND_INTENT_STRING_KEYS) {
    if (typeof value[key] !== "string") return null;
  }
  if (typeof value.itemId !== "string" || value.itemId !== expectedItemId) return null;
  if (!BIND_INTENT_ITEM_ID_RE.test(value.itemId)) return null;
  if (typeof value.registryCreated !== "boolean") return null;
  if (typeof value.gitignoreUpdated !== "boolean") return null;
  if (!(value.gitignoreBytes === null || typeof value.gitignoreBytes === "string")) return null;
  if (Object.prototype.hasOwnProperty.call(value, "note")) {
    if (!options.allowNote || typeof value.note !== "string") return null;
  }
  const intentFields: AbrainBindIntent = {
    schema: ABRAIN_BIND_INTENT_SCHEMA,
    itemId: value.itemId as string,
    projectId: value.projectId as string,
    projectRoot: value.projectRoot as string,
    normalizedPath: value.normalizedPath as string,
    registryRelativePath: value.registryRelativePath as string,
    registryBytes: value.registryBytes as string,
    registryCreated: value.registryCreated as boolean,
    gitignoreRelativePath: value.gitignoreRelativePath as string,
    gitignoreBytes: value.gitignoreBytes as string | null,
    gitignoreUpdated: value.gitignoreUpdated as boolean,
    message: value.message as string,
  };
  try {
    validateAbrainProjectId(intentFields.projectId);
  } catch {
    return null;
  }
  if (computeAbrainBindIntentItemId(intentFields) !== intentFields.itemId) return null;
  return intentFields;
}

type BindIntentBucketName = "pending" | "done" | "failed";

/** Relative chain under ABRAIN root. System ancestors of the root may alias
 * (e.g. /tmp → /private/tmp); these internal segments must not. */
const BIND_INTENT_PREFIX_SEGMENTS = [".state", "abrain", "bind-intent"] as const;

interface ResolvedBindIntentBucket {
  readonly dir: string;
  readonly rootCanonical: string;
  readonly stat: fsSync.BigIntStats;
}

/** Plain non-symlink ABRAIN root. Ancestor aliases outside the leaf are ok. */
async function resolvePlainAbrainRootCanonical(abrainHome: string): Promise<{ resolved: string; canonical: string }> {
  const resolved = path.resolve(abrainHome);
  let before: fsSync.BigIntStats;
  try {
    before = await fs.lstat(resolved, { bigint: true });
  } catch {
    throw new Error("bind_intent_root_invalid");
  }
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error("bind_intent_root_invalid");
  }
  let canonical: string;
  try {
    canonical = await fs.realpath(resolved);
  } catch {
    throw new Error("bind_intent_root_invalid");
  }
  let realStat: fsSync.BigIntStats;
  try {
    realStat = await fs.lstat(canonical, { bigint: true });
  } catch {
    throw new Error("bind_intent_root_invalid");
  }
  // Leaf root is plain; realpath may differ only via system ancestor aliases.
  if (realStat.isSymbolicLink() || !realStat.isDirectory() || !sameFileIdentity(before, realStat)) {
    throw new Error("bind_intent_root_invalid");
  }
  return { resolved, canonical };
}

/**
 * Resolve `.state/abrain/bind-intent/<bucket>` from the canonical ABRAIN root.
 * Every existing relative component must be a plain directory whose realpath
 * equals join(rootCanonical, rel...). System ancestors of ABRAIN root may alias;
 * the internal relative chain must not escape via symlink/non-dir.
 *
 * - create=false (read/inspect): missing component → null (no mkdir)
 * - create=true (write/terminal): missing components mkdir'd one level at a time
 */
async function resolveBindIntentBucketDir(
  abrainHome: string,
  bucket: BindIntentBucketName,
  options: { create: boolean },
): Promise<ResolvedBindIntentBucket | null> {
  const { resolved: resolvedRoot, canonical: rootCanonical } = await resolvePlainAbrainRootCanonical(abrainHome);
  const segments = [...BIND_INTENT_PREFIX_SEGMENTS, bucket];
  let namedCursor = resolvedRoot;
  let expectedReal = rootCanonical;
  let lastStat: fsSync.BigIntStats | null = null;

  for (const segment of segments) {
    namedCursor = path.join(namedCursor, segment);
    expectedReal = path.join(expectedReal, segment);

    let st: fsSync.BigIntStats;
    try {
      st = await fs.lstat(namedCursor, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("bind_intent_path_unreadable");
      }
      if (!options.create) return null;
      try {
        await fs.mkdir(namedCursor, { mode: 0o700 });
      } catch (mkdirErr) {
        if ((mkdirErr as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new Error("bind_intent_path_unwritable");
        }
      }
      try {
        st = await fs.lstat(namedCursor, { bigint: true });
      } catch {
        throw new Error("bind_intent_path_invalid");
      }
    }

    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error("bind_intent_path_invalid");
    }

    let real: string;
    try {
      real = await fs.realpath(namedCursor);
    } catch {
      throw new Error("bind_intent_path_invalid");
    }
    if (real !== expectedReal) {
      throw new Error("bind_intent_path_invalid");
    }

    let realStat: fsSync.BigIntStats;
    try {
      realStat = await fs.lstat(real, { bigint: true });
    } catch {
      throw new Error("bind_intent_path_invalid");
    }
    if (realStat.isSymbolicLink() || !realStat.isDirectory() || !sameFileIdentity(st, realStat)) {
      throw new Error("bind_intent_path_invalid");
    }

    let after: fsSync.BigIntStats;
    try {
      after = await fs.lstat(namedCursor, { bigint: true });
    } catch {
      throw new Error("bind_intent_path_invalid");
    }
    if (after.isSymbolicLink() || !after.isDirectory() || !sameFileIdentity(st, after)) {
      throw new Error("bind_intent_path_invalid");
    }
    lastStat = after;
  }

  if (!lastStat) throw new Error("bind_intent_path_invalid");
  return { dir: namedCursor, rootCanonical, stat: lastStat };
}

async function readStrictBindIntentJsonFile(filePath: string): Promise<unknown> {
  let namedBefore: fsSync.BigIntStats;
  try {
    namedBefore = await fs.lstat(filePath, { bigint: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("bind_intent_file_missing");
    throw new Error("bind_intent_file_unreadable");
  }
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile()) {
    throw new Error("bind_intent_file_invalid");
  }
  if (namedBefore.size > BigInt(MAX_BIND_INTENT_BYTES)) {
    throw new Error("bind_intent_file_too_large");
  }
  const noFollow = fsSync.constants.O_NOFOLLOW ?? 0;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, fsSync.constants.O_RDONLY | noFollow);
  } catch {
    throw new Error("bind_intent_file_unreadable");
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFileIdentity(opened, namedBefore)) {
      throw new Error("bind_intent_file_identity_mismatch");
    }
    if (opened.size > BigInt(MAX_BIND_INTENT_BYTES)) {
      throw new Error("bind_intent_file_too_large");
    }
    const buf = Buffer.alloc(Number(opened.size));
    const read = await handle.read(buf, 0, buf.length, 0);
    if (read.bytesRead !== buf.length) throw new Error("bind_intent_file_unreadable");
    const afterFd = await handle.stat({ bigint: true });
    if (!sameFileIdentity(afterFd, opened)
      || afterFd.size !== opened.size
      || afterFd.mtimeNs !== opened.mtimeNs
      || afterFd.ctimeNs !== opened.ctimeNs) {
      throw new Error("bind_intent_file_identity_mismatch");
    }
    let namedAfter: fsSync.BigIntStats;
    try {
      namedAfter = await fs.lstat(filePath, { bigint: true });
    } catch {
      throw new Error("bind_intent_file_identity_mismatch");
    }
    if (namedAfter.isSymbolicLink()
      || !namedAfter.isFile()
      || !sameFileIdentity(namedAfter, opened)
      || namedAfter.size !== opened.size) {
      throw new Error("bind_intent_file_identity_mismatch");
    }
    return JSON.parse(buf.toString("utf-8"));
  } finally {
    await handle.close().catch(() => {});
  }
}

interface LoadedBindIntentBucket {
  readonly valid: AbrainBindIntent[];
  readonly invalid: number;
}

/**
 * Strict cohort loader for one bind-intent bucket (pending or failed).
 * Missing chain → empty. Symlink / non-dir / realpath escape on any relative
 * component → throw (fail closed). Per-file structural/parse failures count as
 * invalid (never delete/requeue).
 *
 * Prechecked bucket that disappears before readdir is identity mismatch (not empty).
 */
async function loadStrictBindIntentBucket(
  abrainHome: string,
  bucket: "pending" | "failed",
  options: { allowNote: boolean },
): Promise<LoadedBindIntentBucket> {
  const resolved = await resolveBindIntentBucketDir(abrainHome, bucket, { create: false });
  if (resolved === null) return { valid: [], invalid: 0 };
  const dir = resolved.dir;
  const bucketBefore = resolved.stat;

  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    // Bucket was present at precheck; concurrent delete is identity mismatch — never empty success.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("bind_intent_bucket_identity_mismatch");
    }
    throw new Error("bind_intent_bucket_unreadable");
  }

  // Bucket identity must remain stable across the read cohort.
  const bucketAfterList = await resolveBindIntentBucketDir(abrainHome, bucket, { create: false });
  if (bucketAfterList === null || !sameFileIdentity(bucketBefore, bucketAfterList.stat)) {
    throw new Error("bind_intent_bucket_identity_mismatch");
  }

  const valid: AbrainBindIntent[] = [];
  let invalid = 0;
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) {
      invalid += 1;
      continue;
    }
    const itemId = name.slice(0, -".json".length);
    if (!BIND_INTENT_ITEM_ID_RE.test(itemId)) {
      invalid += 1;
      continue;
    }
    try {
      const raw = await readStrictBindIntentJsonFile(path.join(dir, name));
      const parsed = parseValidBindIntentRecord(raw, itemId, options);
      if (parsed) valid.push(parsed);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }

  const bucketFinal = await resolveBindIntentBucketDir(abrainHome, bucket, { create: false });
  if (bucketFinal === null || !sameFileIdentity(bucketBefore, bucketFinal.stat)) {
    throw new Error("bind_intent_bucket_identity_mismatch");
  }
  return { valid, invalid };
}

/** Compatible list: returns valid pending rows only; never throws on per-row invalid. */
export async function listAbrainBindIntentPending(abrainHome: string): Promise<AbrainBindIntent[]> {
  const loaded = await loadStrictBindIntentBucket(abrainHome, "pending", {
    allowNote: false,
  });
  return loaded.valid;
}

/**
 * Read-only aggregate inventory over pending + failed bind-intent records.
 * Corrupt / non-regular / symlink / schema-digest mismatches count as invalid
 * (unlike listPending which only returns valid rows). Never deletes or requeues.
 * Bucket structural faults fail closed (throw closed reason, no exact path).
 */
export async function inspectAbrainBindIntentInventory(
  abrainHome: string,
): Promise<AbrainBindIntentInventory> {
  const pending = await loadStrictBindIntentBucket(abrainHome, "pending", {
    allowNote: false,
  });
  const failed = await loadStrictBindIntentBucket(abrainHome, "failed", {
    allowNote: true,
  });
  return Object.freeze({
    pending: pending.valid.length,
    failed: failed.valid.length,
    invalid: pending.invalid + failed.invalid,
  });
}

/**
 * Move a pending intent to done/failed under the same plain-directory chain
 * constraints as write/inspect. Exported for smoke coverage of terminal fail-closed.
 * done records are not part of DCC active inventory; write/lookup remain strict.
 */
export async function markBindIntentTerminal(
  abrainHome: string,
  intent: AbrainBindIntent,
  terminal: "done" | "failed",
  note?: string,
): Promise<void> {
  const terminalBucket = await resolveBindIntentBucketDir(abrainHome, terminal, { create: true });
  if (!terminalBucket) throw new Error("bind_intent_path_invalid");
  const terminalPath = path.join(terminalBucket.dir, `${intent.itemId}.json`);
  const payload = note ? { ...intent, note } : intent;
  await durableAtomicWriteFile(terminalPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  // Pending cleanup is best-effort and must not follow a symlink escape chain.
  try {
    const pendingBucket = await resolveBindIntentBucketDir(abrainHome, "pending", { create: false });
    if (pendingBucket) {
      await fs.rm(path.join(pendingBucket.dir, `${intent.itemId}.json`), { force: true }).catch(() => {});
    }
  } catch {
    // Invalid pending chain: terminal write already succeeded; leave pending for diagnosis.
  }
}

export interface PlannedAbrainBind {
  projectId: string;
  projectRoot: string;
  normalizedPath: string;
  manifestPath: string;
  registryPath: string;
  localMapPath: string;
  abrainGitignorePath: string;
  manifestCreated: boolean;
  registryCreated: boolean;
  localPathPresent: boolean;
  localPathNeedsAdd: boolean;
  abrainGitignoreUpdated: boolean;
  /** True when abrain tracked bytes need create/update under canonical authority. */
  needsTrackedAbrainWrite: boolean;
  /** True when only machine-local local-map must change (or is already confirmed). */
  localMapOnly: boolean;
  registryToWrite: AbrainProjectRegistry;
  registryBytes: string;
  gitignoreToWrite: string | null;
  manifestToWrite: { schema_version: 1; project_id: string } | null;
}

export async function planAbrainBind(opts: {
  abrainHome: string;
  cwd: string;
  projectId?: string;
  now?: string;
  existsSync?: (file: string) => boolean;
  readFileSync?: (file: string, encoding: BufferEncoding) => string;
  execFileSync?: import("../_shared/runtime").ResolveActiveProjectOptions["execFileSync"];
}): Promise<PlannedAbrainBind> {
  // Lazy import keeps plan pure-ish for callers that already loaded runtime.
  const runtime = await import("../_shared/runtime");
  const now = opts.now ?? runtime.formatLocalIsoTimestamp();
  const exists = opts.existsSync ?? (await import("node:fs")).existsSync;
  const read = opts.readFileSync ?? (await import("node:fs")).readFileSync;
  const rootInfo = runtime.normalizeProjectRoot(opts.cwd, {
    abrainHome: opts.abrainHome,
    execFileSync: opts.execFileSync,
  });
  const projectRoot = rootInfo.projectRoot;
  const manifestPath = abrainProjectManifestPath(projectRoot);
  let projectId = opts.projectId?.trim();
  let manifestCreated = false;
  let manifestToWrite: PlannedAbrainBind["manifestToWrite"] = null;
  if (projectId) validateAbrainProjectId(projectId);
  if (exists(manifestPath)) {
    const manifest = parseAbrainProjectManifest(read(manifestPath, "utf-8"));
    if (projectId && manifest.project_id !== projectId) {
      throw new Error(`manifest_conflict: .abrain-project.json already declares project_id=${manifest.project_id}; refusing to bind to ${projectId}`);
    }
    projectId = manifest.project_id;
  } else {
    if (!projectId) throw new Error("manifest_missing: run /abrain bind --project=<id> to create .abrain-project.json");
    manifestToWrite = { schema_version: 1, project_id: projectId };
    manifestCreated = true;
  }

  const registryPath = abrainProjectRegistryPath(opts.abrainHome, projectId!);
  let registryCreated = false;
  let registryToWrite: AbrainProjectRegistry;
  if (exists(registryPath)) {
    const registry = parseAbrainProjectRegistry(read(registryPath, "utf-8"));
    if (registry.project_id !== projectId) {
      throw new Error(`registry_mismatch: ${registryPath} declares project_id=${registry.project_id}; expected ${projectId}`);
    }
    // Fast path / rebind must not rewrite registry bytes. Keep existing content.
    registryToWrite = registry;
  } else {
    registryToWrite = { schema_version: 1, project_id: projectId!, created_at: now, updated_at: now };
    registryCreated = true;
  }
  const registryBytes = `${JSON.stringify(registryToWrite, null, 2)}\n`;

  const abrainGitignorePath = path.join(path.resolve(opts.abrainHome), ".gitignore");
  const gitignoreRaw = readOptionalRegularFileNoFollowSync(abrainGitignorePath) ?? "";
  const gitignoreToWrite = computeAbrainStateGitignoreNext(gitignoreRaw);
  const abrainGitignoreUpdated = gitignoreToWrite !== null;

  const localMapPath = abrainProjectLocalMapPath(opts.abrainHome);
  let localMap = emptyAbrainLocalProjectMap();
  if (exists(localMapPath)) localMap = parseAbrainLocalProjectMap(read(localMapPath, "utf-8"));
  const normalizedPath = path.resolve(projectRoot);
  for (const [otherProjectId, info] of Object.entries(localMap.projects)) {
    if (otherProjectId === projectId) continue;
    if (info.paths.some((p) => path.resolve(p.path) === normalizedPath)) {
      throw new Error(`path_conflict: ${normalizedPath} is already confirmed for project ${otherProjectId}`);
    }
  }
  const entry = localMap.projects[projectId!] ?? { paths: [] };
  const existingPath = entry.paths.find((p) => path.resolve(p.path) === normalizedPath);
  const localPathPresent = !!existingPath;
  const localPathNeedsAdd = !existingPath;
  const needsTrackedAbrainWrite = registryCreated || abrainGitignoreUpdated;
  // Same-project new checkout: portable manifest + tracked registry already
  // agree; only machine-local path authorization is missing/stale.
  const localMapOnly = !needsTrackedAbrainWrite && !manifestCreated;

  return {
    projectId: projectId!,
    projectRoot,
    normalizedPath,
    manifestPath,
    registryPath,
    localMapPath,
    abrainGitignorePath,
    manifestCreated,
    registryCreated,
    localPathPresent,
    localPathNeedsAdd,
    abrainGitignoreUpdated,
    needsTrackedAbrainWrite,
    localMapOnly,
    registryToWrite,
    registryBytes,
    gitignoreToWrite,
    manifestToWrite,
  };
}

/** Confirm/refresh the machine-local path only. Never mutates abrain tracked files. */
export async function applyLocalMapOnlyBind(opts: {
  abrainHome: string;
  projectId: string;
  projectRoot: string;
  now?: string;
}): Promise<{ localPathAdded: boolean; localMapPath: string }> {
  const runtime = await import("../_shared/runtime");
  const now = opts.now ?? runtime.formatLocalIsoTimestamp();
  const lockPath = path.join(path.resolve(opts.abrainHome), ".state", "projects", "local-map.lock");
  return withFileLock(lockPath, { timeoutMs: 5000, staleMs: 30_000, retryMs: 50, label: "local_map" }, async () => {
    const localMapPath = abrainProjectLocalMapPath(opts.abrainHome);
    let localMap: AbrainLocalProjectMap = emptyAbrainLocalProjectMap();
    try {
      localMap = parseAbrainLocalProjectMap(await fs.readFile(localMapPath, "utf-8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    const normalizedPath = path.resolve(opts.projectRoot);
    for (const [otherProjectId, info] of Object.entries(localMap.projects)) {
      if (otherProjectId === opts.projectId) continue;
      if (info.paths.some((p) => path.resolve(p.path) === normalizedPath)) {
        throw new Error(`path_conflict: ${normalizedPath} is already confirmed for project ${otherProjectId}`);
      }
    }
    const entry = localMap.projects[opts.projectId] ?? { paths: [] };
    const existingPath = entry.paths.find((p) => path.resolve(p.path) === normalizedPath);
    let localPathAdded = false;
    if (existingPath) {
      existingPath.last_seen = now;
    } else {
      entry.paths.push({ path: normalizedPath, first_seen: now, last_seen: now, confirmed_at: now });
      localPathAdded = true;
    }
    localMap.projects[opts.projectId] = entry;
    await durableAtomicWriteFile(localMapPath, `${JSON.stringify(localMap, null, 2)}\n`, { mode: 0o600 });
    return { localPathAdded, localMapPath };
  });
}

export function intentFromPlan(plan: PlannedAbrainBind): AbrainBindIntent {
  return buildAbrainBindIntent({
    projectId: plan.projectId,
    projectRoot: plan.projectRoot,
    normalizedPath: plan.normalizedPath,
    registryRelativePath: `projects/${plan.projectId}/_project.json`,
    registryBytes: plan.registryBytes,
    registryCreated: plan.registryCreated,
    gitignoreRelativePath: ".gitignore",
    gitignoreBytes: plan.gitignoreToWrite,
    gitignoreUpdated: plan.abrainGitignoreUpdated,
    message: `project: add ${plan.projectId}`,
  });
}

async function writeExactFile(filePath: string, bytes: string): Promise<"written" | "identical"> {
  try {
    const existing = await fs.readFile(filePath, "utf-8");
    if (existing === bytes) return "identical";
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await durableAtomicWriteFile(filePath, bytes, { mode: 0o644 });
  return "written";
}

export type ApplyBindIntentResult =
  | { status: "done"; commitSha?: string; localPathAdded: boolean }
  | { status: "pending"; detail: string }
  | { status: "failed"; detail: string };

export class AbrainBindIntentError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "AbrainBindIntentError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

/** Strict create-only tracked path contract for bind intents. */
export function assertAbrainBindIntentTrackedPaths(intent: AbrainBindIntent): void {
  validateAbrainProjectId(intent.projectId);
  const expectedRegistry = `projects/${intent.projectId}/_project.json`;
  if (intent.registryRelativePath !== expectedRegistry) {
    throw new AbrainBindIntentError(
      "BIND_INTENT_PATH_INVALID",
      `registryRelativePath must equal ${expectedRegistry}`,
      { registryRelativePath: intent.registryRelativePath, expectedRegistry, projectId: intent.projectId },
    );
  }
  if (intent.gitignoreRelativePath !== ".gitignore") {
    throw new AbrainBindIntentError(
      "BIND_INTENT_PATH_INVALID",
      "gitignoreRelativePath must equal .gitignore",
      { gitignoreRelativePath: intent.gitignoreRelativePath },
    );
  }
}

/**
 * Apply one pending bind intent under the existing canonical barrier + receipt
 * + exact-cohort drain authority.
 *
 * Rollback of tracked worktree bytes is allowed ONLY in the pre-publish
 * window (CAS has not published the candidate). Once drain reports
 * localCommit === "published" (even when status is blocked) or a durable
 * success status, tracked registry/.gitignore bytes must be retained for
 * v3 recovery / index convergence. Post-drain local-map or terminal
 * bookkeeping failures also never roll back published tracked bytes.
 */
export async function applyAbrainBindIntent(opts: {
  abrainHome: string;
  intent: AbrainBindIntent;
  now?: string;
}): Promise<ApplyBindIntentResult> {
  assertAbrainBindIntentTrackedPaths(opts.intent);

  const abrainHome = path.resolve(opts.abrainHome);
  const runtime = await getCanonicalGitRuntime({ abrainHome });
  const startup = await runtime.awaitStartup();
  if (startup.startup !== "ready") {
    return { status: "pending", detail: startup.blockedReason ?? `startup=${startup.startup}` };
  }

  const registryAbs = path.join(abrainHome, ...opts.intent.registryRelativePath.split("/"));
  const gitignoreAbs = path.join(abrainHome, opts.intent.gitignoreRelativePath);
  const previous: Array<{ path: string; bytes: string | null }> = [];
  /** Tracks whether CAS/local drain has crossed the irreversible publication boundary. */
  let publicationBoundary: "pre_publish" | "published" | "durable" = "pre_publish";

  const capture = async (filePath: string) => {
    try {
      previous.push({ path: filePath, bytes: await fs.readFile(filePath, "utf-8") });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") previous.push({ path: filePath, bytes: null });
      else throw err;
    }
  };

  const rollbackTrackedBytes = async () => {
    for (const entry of previous.reverse()) {
      if (entry.bytes === null) {
        await fs.rm(entry.path, { force: true }).catch(() => {});
      } else {
        await durableAtomicWriteFile(entry.path, entry.bytes, { mode: 0o644 }).catch(() => {});
      }
    }
  };

  /** Rollback only before publication; published/durable tracked bytes stay. */
  const rollbackIfPrePublish = async () => {
    if (publicationBoundary !== "pre_publish") return;
    await rollbackTrackedBytes();
  };

  try {
    return await withCanonicalMutationBarrier(abrainHome, async () => {
      const relPaths: string[] = [];
      if (opts.intent.registryCreated) {
        await capture(registryAbs);
        const existing = previous[previous.length - 1]?.bytes;
        if (existing !== null && existing !== undefined && existing !== opts.intent.registryBytes) {
          // Foreign registry content: keep pending/failed diagnostically.
          const detail = `registry bytes differ from bind intent at ${opts.intent.registryRelativePath}`;
          await markBindIntentTerminal(abrainHome, opts.intent, "failed", detail);
          return { status: "failed" as const, detail };
        }
        if (existing === null || existing === undefined) {
          await writeExactFile(registryAbs, opts.intent.registryBytes);
        } else if (existing === opts.intent.registryBytes) {
          // Crash recovery: intent bytes already on disk, still need ownership drain.
        } else {
          await writeExactFile(registryAbs, opts.intent.registryBytes);
        }
        relPaths.push(opts.intent.registryRelativePath);
      } else if (!(await fs.stat(registryAbs).then(() => true).catch(() => false))) {
        // Registry should already exist for non-create intents; recreate from intent if lost.
        await capture(registryAbs);
        await writeExactFile(registryAbs, opts.intent.registryBytes);
        relPaths.push(opts.intent.registryRelativePath);
      }
      if (opts.intent.gitignoreUpdated && opts.intent.gitignoreBytes !== null) {
        await capture(gitignoreAbs);
        const existing = previous.find((p) => p.path === gitignoreAbs)?.bytes;
        if (existing !== null && existing !== undefined) {
          // Only allow append-style .state/ ensure; refuse foreign drift.
          const next = computeAbrainStateGitignoreNext(existing);
          if (next !== opts.intent.gitignoreBytes && existing !== opts.intent.gitignoreBytes) {
            await rollbackIfPrePublish();
            const detail = "gitignore differs from bind intent and is not a pure .state/ ensure";
            await markBindIntentTerminal(abrainHome, opts.intent, "failed", detail);
            return { status: "failed" as const, detail };
          }
        }
        await writeExactFile(gitignoreAbs, opts.intent.gitignoreBytes);
        relPaths.push(opts.intent.gitignoreRelativePath);
      }

      if (relPaths.length === 0) {
        const local = await applyLocalMapOnlyBind({
          abrainHome,
          projectId: opts.intent.projectId,
          projectRoot: opts.intent.projectRoot,
          now: opts.now,
        });
        await markBindIntentTerminal(abrainHome, opts.intent, "done");
        return { status: "done" as const, localPathAdded: local.localPathAdded };
      }

      const receipts: ProducedArtifact[] = [];
      for (const rel of relPaths) {
        receipts.push(await createProducedArtifactReceipt({
          abrainHome,
          filePath: path.join(abrainHome, ...rel.split("/")),
          sourceIds: [`abrain-bind:${opts.intent.itemId}:${rel}`],
        }));
      }
      const drained = await runtime.requestDrain(receipts, opts.intent.message);

      // Publication boundary: CAS may have advanced HEAD even when status is blocked.
      // Never restore/delete tracked worktree bytes after this point, and never
      // mark the intent done while index convergence is still open.
      if (drained.localCommit === "published") {
        publicationBoundary = "published";
        return {
          status: "pending" as const,
          detail: drained.reason ?? "published_pending_index_convergence",
        };
      }

      if (drained.status === "blocked" || drained.status === "disabled") {
        await rollbackIfPrePublish();
        return { status: "pending", detail: drained.reason ?? drained.status };
      }
      if (!["index_converged", "empty", "metadata_deferred", "consumed"].includes(drained.status)) {
        await rollbackIfPrePublish();
        return { status: "pending", detail: drained.reason ?? drained.status };
      }

      // Durable drain success: subsequent local-map / terminal bookkeeping must
      // not roll back already-published tracked registry/.gitignore bytes.
      publicationBoundary = "durable";
      try {
        const local = await applyLocalMapOnlyBind({
          abrainHome,
          projectId: opts.intent.projectId,
          projectRoot: opts.intent.projectRoot,
          now: opts.now,
        });
        await markBindIntentTerminal(abrainHome, opts.intent, "done");
        return {
          status: "done" as const,
          commitSha: drained.commit,
          localPathAdded: local.localPathAdded,
        };
      } catch (bookkeepingError) {
        const detail = bookkeepingError instanceof Error ? bookkeepingError.message : String(bookkeepingError);
        return {
          status: "pending" as const,
          detail: `post_drain_bookkeeping: ${detail}`,
        };
      }
    });
  } catch (error) {
    await rollbackIfPrePublish();
    const detail = error instanceof Error ? error.message : String(error);
    // Keep pending for retryable failures; hard identity collisions go failed.
    // Never mark failed solely because of a post-publication throw path.
    if (publicationBoundary === "pre_publish" && /collision|mismatch|differ/i.test(detail)) {
      await markBindIntentTerminal(abrainHome, opts.intent, "failed", detail).catch(() => {});
      return { status: "failed", detail };
    }
    return { status: "pending", detail };
  }
}

export async function applyAllPendingAbrainBindIntents(abrainHome: string): Promise<{
  applied: number;
  pending: number;
  failed: number;
  details: string[];
}> {
  // Same strict loader/cohort as inventory. Invalid pending must fail closed
  // (never silent-skip via the historical loose readFile path).
  const loaded = await loadStrictBindIntentBucket(abrainHome, "pending", {
    allowNote: false,
  });
  if (loaded.invalid > 0) {
    throw new Error("bind_intent_pending_invalid");
  }
  let applied = 0;
  let stillPending = 0;
  let failed = 0;
  const details: string[] = [];
  for (const intent of loaded.valid) {
    const result = await applyAbrainBindIntent({ abrainHome, intent });
    if (result.status === "done") {
      applied += 1;
      details.push(`${intent.projectId}: done${result.commitSha ? ` @${result.commitSha.slice(0, 12)}` : ""}`);
    } else if (result.status === "failed") {
      failed += 1;
      details.push(`${intent.projectId}: failed — ${result.detail}`);
    } else {
      stillPending += 1;
      details.push(`${intent.projectId}: pending — ${result.detail}`);
    }
  }
  return { applied, pending: stillPending, failed, details };
}
