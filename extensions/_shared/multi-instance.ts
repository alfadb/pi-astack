import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { getDeviceId } from "./causal-anchor";
import { atomicWriteText } from "./sync-file-lock";
import { formatLocalIsoTimestamp, normalizeProjectRoot, piAstackRoot } from "./runtime";
import { wrapVolatile } from "./volatile-suffix";

export const MULTI_INSTANCE_SCHEMA_VERSION = 1;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
export const DEFAULT_STALE_AFTER_MS = 45_000;
const MAX_MANIFEST_PATHS = 80;
const MAX_RECENT_RISKS = 12;
const RECENT_WRITE_WINDOW_MS = 10 * 60_000;

export type InstanceStatus = "active" | "idle" | "stale" | "suspended" | "exiting";
export type ResourceClass = "git" | "session" | "pi-astack" | "internal";

export interface FileFingerprint {
  kind: "missing" | "file" | "directory" | "other";
  mtimeMs?: number;
  size?: number;
  sha1?: string;
}

export interface ResourceLeaseMirror {
  resource: string;
  class: ResourceClass;
  token?: string;
  acquired_at?: string;
  renewed_at?: string;
}

export interface MultiInstanceManifest {
  schema_version: 1;
  instance_id: string;
  pid: number;
  ppid?: number;
  device_id?: string;
  hostname: string;
  project_root: string;
  session_id?: string;
  session_file?: string;
  session_epoch: number;
  started_at: string;
  updated_at: string;
  heartbeat_at: string;
  heartbeat_seq: number;
  heartbeat_interval_ms: number;
  stale_after_ms: number;
  status: InstanceStatus;
  activity?: string;
  current_tool?: string;
  target_paths: string[];
  observed_files: string[];
  recent_writes?: string[];
  held_locks?: ResourceLeaseMirror[];
  subtasks?: Array<Record<string, unknown>>;
}

export interface AssessedInstance {
  manifest: MultiInstanceManifest;
  liveness: InstanceStatus;
  heartbeat_age_ms: number | null;
  pid_alive?: boolean;
  stale_reason?: string;
}

export interface PeerScan {
  projectRoot: string;
  selfInstanceId: string;
  instances: AssessedInstance[];
  peers: AssessedInstance[];
  counts: Record<InstanceStatus, number> & { peers: number; risk: number };
  readError?: string;
}

export interface GuardRisk {
  ts: string;
  action: "warn" | "block";
  kind: string;
  tool: string;
  path?: string;
  reason: string;
  peer_instance_ids?: string[];
}

export interface GuardVerdict {
  action: "allow" | "warn" | "block";
  toolName: string;
  writeKind?: WriteKind;
  targetPaths: string[];
  risks: GuardRisk[];
  dangerousGit?: DangerousGitVerdict;
}

export interface SessionStartInput {
  projectRoot: string;
  sessionId?: string;
  sessionFile?: string;
  model?: string;
  isSubAgent?: boolean;
}

export type WriteKind = "edit" | "whole_write" | "delete" | "move" | "bash_write" | "dangerous_git";

type ToolIntent =
  | { intent: "observe"; paths: string[]; activity?: string }
  | { intent: "write"; writeKind: WriteKind; paths: string[]; activity?: string; dangerousGit?: DangerousGitVerdict }
  | { intent: "other"; activity?: string };

export interface DangerousGitVerdict {
  dangerous: boolean;
  verb?: string;
  reason?: string;
}

interface MultiInstanceState {
  instanceId: string;
  processStartedAt: string;
  hostname: string;
  deviceId?: string;
  sessionEpoch: number;
  sessionKey?: string;
  projectRoot?: string;
  manifestPath?: string;
  sessionId?: string;
  sessionFile?: string;
  model?: string;
  heartbeatSeq: number;
  status: InstanceStatus;
  activity?: string;
  currentTool?: string;
  targetPaths: Set<string>;
  observedFiles: Map<string, FileFingerprint>;
  ownWrites: Map<string, FileFingerprint>;
  recentWrites: Map<string, number>;
  guardRisks: GuardRisk[];
  heldLocks: ResourceLeaseMirror[];
  timer?: ReturnType<typeof setInterval>;
  heartbeatIntervalMs: number;
  staleAfterMs: number;
  registered: boolean;
}

interface ResourceLeaseRecord {
  schema_version: 1;
  owner_instance_id: string;
  token: string;
  resource: string;
  class: ResourceClass;
  pid: number;
  hostname: string;
  device_id?: string;
  project_root: string;
  acquired_at: string;
  renewed_at: string;
  expires_at: string;
}

const STATE_KEY = Symbol.for("pi-astack/multi-instance/state/v1");

function newInstanceId(): string {
  return `pi-${crypto.randomUUID()}`;
}

export function getMultiInstanceState(): MultiInstanceState {
  const g = globalThis as Record<symbol, unknown>;
  let state = g[STATE_KEY] as MultiInstanceState | undefined;
  if (!state) {
    state = {
      instanceId: newInstanceId(),
      processStartedAt: formatLocalIsoTimestamp(),
      hostname: os.hostname(),
      deviceId: getDeviceId(),
      sessionEpoch: 0,
      heartbeatSeq: 0,
      status: "idle",
      targetPaths: new Set(),
      observedFiles: new Map(),
      ownWrites: new Map(),
      recentWrites: new Map(),
      guardRisks: [],
      heldLocks: [],
      heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
      staleAfterMs: DEFAULT_STALE_AFTER_MS,
      registered: false,
    };
    g[STATE_KEY] = state;
  }
  return state;
}

export function resetMultiInstanceStateForTests(): void {
  const g = globalThis as Record<symbol, unknown>;
  const state = g[STATE_KEY] as MultiInstanceState | undefined;
  if (state?.timer) clearInterval(state.timer);
  delete g[STATE_KEY];
}

export function getInstanceId(): string {
  return getMultiInstanceState().instanceId;
}

export function resolveMultiInstanceProjectRoot(cwd: string): string {
  try {
    return normalizeProjectRoot(cwd, { abrainHome: "", execFileSync }).projectRoot;
  } catch {
    return path.resolve(cwd || process.cwd());
  }
}

export function instancesDir(projectRoot: string): string {
  return path.join(piAstackRoot(projectRoot), "instances");
}

export function manifestPathForInstance(projectRoot: string, instanceId: string): string {
  return path.join(instancesDir(projectRoot), `${safeFileId(instanceId)}.json`);
}

function safeFileId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 160) || "unknown";
}

function nowIso(): string {
  return formatLocalIsoTimestamp();
}

function ensureHeartbeatTimer(state: MultiInstanceState): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    try {
      if (!state.projectRoot || !state.manifestPath) return;
      state.heartbeatSeq += 1;
      writeCurrentManifest();
    } catch {
      // Presence is observability; heartbeat IO must fail-degrade.
    }
  }, state.heartbeatIntervalMs);
  if (typeof (state.timer as unknown as { unref?: () => void }).unref === "function") {
    (state.timer as unknown as { unref: () => void }).unref();
  }
}

function stopHeartbeatTimer(state: MultiInstanceState): void {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = undefined;
}

function sessionKeyOf(input: SessionStartInput): string {
  return [path.resolve(input.projectRoot), input.sessionId ?? "", input.sessionFile ?? ""].join("\0");
}

export function startForegroundSession(input: SessionStartInput): { registered: boolean; instanceId: string; sessionEpoch: number } {
  const state = getMultiInstanceState();
  if (input.isSubAgent) {
    return { registered: false, instanceId: state.instanceId, sessionEpoch: state.sessionEpoch };
  }

  const projectRoot = path.resolve(input.projectRoot || process.cwd());
  const nextPath = manifestPathForInstance(projectRoot, state.instanceId);
  if (state.projectRoot && state.projectRoot !== projectRoot) {
    unlinkCurrentManifest("project_switch");
  }

  const nextKey = sessionKeyOf({ ...input, projectRoot });
  if (state.sessionKey !== nextKey) {
    state.sessionEpoch += 1;
    state.sessionKey = nextKey;
    state.targetPaths.clear();
    state.observedFiles.clear();
    state.ownWrites.clear();
    state.recentWrites.clear();
    state.guardRisks = [];
    state.activity = undefined;
    state.currentTool = undefined;
  }

  state.projectRoot = projectRoot;
  state.manifestPath = nextPath;
  state.sessionId = input.sessionId;
  state.sessionFile = input.sessionFile;
  state.model = input.model;
  state.status = "idle";
  state.registered = true;
  state.heartbeatSeq += 1;
  ensureHeartbeatTimer(state);
  writeCurrentManifest("idle");
  return { registered: true, instanceId: state.instanceId, sessionEpoch: state.sessionEpoch };
}

export function stopForegroundSession(reason: string = "session_shutdown"): void {
  const state = getMultiInstanceState();
  if (!state.projectRoot || !state.manifestPath) {
    stopHeartbeatTimer(state);
    return;
  }
  state.activity = reason;
  unlinkCurrentManifest(reason);
  stopHeartbeatTimer(state);
  state.projectRoot = undefined;
  state.manifestPath = undefined;
  state.sessionId = undefined;
  state.sessionFile = undefined;
  state.sessionKey = undefined;
  state.targetPaths.clear();
  state.currentTool = undefined;
  state.status = "idle";
  state.registered = false;
}

function unlinkCurrentManifest(reason: string): void {
  const state = getMultiInstanceState();
  if (!state.manifestPath) return;
  try {
    state.status = "exiting";
    state.activity = reason;
    state.heartbeatSeq += 1;
    writeCurrentManifest("exiting");
  } catch {
    // Best effort.
  }
  try {
    fs.unlinkSync(state.manifestPath);
  } catch {
    // Crash/stale cleanup handles leftovers.
  }
}

export function setInstanceActivity(activity: string | undefined, currentTool?: string, targetPaths: string[] = []): void {
  const state = getMultiInstanceState();
  state.status = currentTool ? "active" : "idle";
  state.activity = activity;
  state.currentTool = currentTool;
  state.targetPaths = new Set(targetPaths.map((p) => displayPath(state.projectRoot, p)).filter(Boolean));
  state.heartbeatSeq += 1;
  writeCurrentManifest(state.status);
}

export function writeCurrentManifest(status?: InstanceStatus): void {
  const state = getMultiInstanceState();
  if (!state.projectRoot || !state.manifestPath) return;
  const ts = nowIso();
  const manifest: MultiInstanceManifest = {
    schema_version: MULTI_INSTANCE_SCHEMA_VERSION,
    instance_id: state.instanceId,
    pid: process.pid,
    ...(typeof process.ppid === "number" ? { ppid: process.ppid } : {}),
    ...(state.deviceId ? { device_id: state.deviceId } : {}),
    hostname: state.hostname,
    project_root: state.projectRoot,
    ...(state.sessionId ? { session_id: state.sessionId } : {}),
    ...(state.sessionFile ? { session_file: state.sessionFile } : {}),
    session_epoch: state.sessionEpoch,
    started_at: state.processStartedAt,
    updated_at: ts,
    heartbeat_at: ts,
    heartbeat_seq: state.heartbeatSeq,
    heartbeat_interval_ms: state.heartbeatIntervalMs,
    stale_after_ms: state.staleAfterMs,
    status: status ?? state.status,
    ...(state.activity ? { activity: state.activity } : {}),
    ...(state.currentTool ? { current_tool: state.currentTool } : {}),
    target_paths: capList([...state.targetPaths], MAX_MANIFEST_PATHS),
    observed_files: capList([...state.observedFiles.keys()].map((p) => displayPath(state.projectRoot, p)), MAX_MANIFEST_PATHS),
    recent_writes: capList(recentWritePaths(state), MAX_MANIFEST_PATHS),
    held_locks: state.heldLocks.slice(0, 20),
  };
  try {
    atomicWriteText(state.manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  } catch {
    // Presence IO failure must not break the agent loop.
  }
}

function capList<T>(values: T[], limit: number): T[] {
  return values.filter((v) => v !== undefined && v !== null).slice(-limit);
}

function recentWritePaths(state: MultiInstanceState): string[] {
  const cutoff = Date.now() - RECENT_WRITE_WINDOW_MS;
  const out: string[] = [];
  for (const [abs, ts] of state.recentWrites.entries()) {
    if (ts < cutoff) {
      state.recentWrites.delete(abs);
      continue;
    }
    out.push(displayPath(state.projectRoot, abs));
  }
  return out;
}

export function parseManifest(raw: string): MultiInstanceManifest | null {
  try {
    const p = JSON.parse(raw) as Partial<MultiInstanceManifest>;
    if (!p || p.schema_version !== MULTI_INSTANCE_SCHEMA_VERSION) return null;
    if (typeof p.instance_id !== "string" || typeof p.pid !== "number" || typeof p.hostname !== "string") return null;
    if (typeof p.project_root !== "string" || typeof p.heartbeat_at !== "string" || typeof p.heartbeat_seq !== "number") return null;
    const status = isInstanceStatus(p.status) ? p.status : "idle";
    return {
      schema_version: MULTI_INSTANCE_SCHEMA_VERSION,
      instance_id: p.instance_id,
      pid: p.pid,
      ...(typeof p.ppid === "number" ? { ppid: p.ppid } : {}),
      ...(typeof p.device_id === "string" ? { device_id: p.device_id } : {}),
      hostname: p.hostname,
      project_root: path.resolve(p.project_root),
      ...(typeof p.session_id === "string" ? { session_id: p.session_id } : {}),
      ...(typeof p.session_file === "string" ? { session_file: p.session_file } : {}),
      session_epoch: typeof p.session_epoch === "number" ? p.session_epoch : 0,
      started_at: typeof p.started_at === "string" ? p.started_at : p.heartbeat_at,
      updated_at: typeof p.updated_at === "string" ? p.updated_at : p.heartbeat_at,
      heartbeat_at: p.heartbeat_at,
      heartbeat_seq: p.heartbeat_seq,
      heartbeat_interval_ms: typeof p.heartbeat_interval_ms === "number" ? p.heartbeat_interval_ms : DEFAULT_HEARTBEAT_INTERVAL_MS,
      stale_after_ms: typeof p.stale_after_ms === "number" ? p.stale_after_ms : DEFAULT_STALE_AFTER_MS,
      status,
      ...(typeof p.activity === "string" ? { activity: p.activity } : {}),
      ...(typeof p.current_tool === "string" ? { current_tool: p.current_tool } : {}),
      target_paths: Array.isArray(p.target_paths) ? p.target_paths.filter((x): x is string => typeof x === "string") : [],
      observed_files: Array.isArray(p.observed_files) ? p.observed_files.filter((x): x is string => typeof x === "string") : [],
      recent_writes: Array.isArray(p.recent_writes) ? p.recent_writes.filter((x): x is string => typeof x === "string") : [],
      held_locks: Array.isArray(p.held_locks) ? p.held_locks.filter((x): x is ResourceLeaseMirror => !!x && typeof x === "object") : [],
      ...(Array.isArray(p.subtasks) ? { subtasks: p.subtasks.filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x)) } : {}),
    };
  } catch {
    return null;
  }
}

function isInstanceStatus(value: unknown): value is InstanceStatus {
  return value === "active" || value === "idle" || value === "stale" || value === "suspended" || value === "exiting";
}

export function scanInstanceManifests(projectRoot: string, opts: { selfInstanceId?: string; nowMs?: number; staleAfterMs?: number } = {}): PeerScan {
  const root = path.resolve(projectRoot);
  const selfInstanceId = opts.selfInstanceId ?? getInstanceId();
  const instances: AssessedInstance[] = [];
  let readError: string | undefined;
  try {
    for (const ent of fs.readdirSync(instancesDir(root), { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith(".json")) continue;
      const file = path.join(instancesDir(root), ent.name);
      const manifest = parseManifest(fs.readFileSync(file, "utf-8"));
      if (!manifest) continue;
      instances.push(assessManifestLiveness(manifest, { nowMs: opts.nowMs, staleAfterMs: opts.staleAfterMs }));
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") readError = code ?? String(e);
  }
  instances.sort((a, b) => a.manifest.instance_id.localeCompare(b.manifest.instance_id));
  const peers = instances.filter((i) => i.manifest.instance_id !== selfInstanceId);
  const counts = {
    active: 0,
    idle: 0,
    stale: 0,
    suspended: 0,
    exiting: 0,
    peers: peers.length,
    risk: getMultiInstanceState().guardRisks.length,
  } as Record<InstanceStatus, number> & { peers: number; risk: number };
  for (const peer of peers) counts[peer.liveness] += 1;
  return { projectRoot: root, selfInstanceId, instances, peers, counts, ...(readError ? { readError } : {}) };
}

export function assessManifestLiveness(
  manifest: MultiInstanceManifest,
  opts: { nowMs?: number; staleAfterMs?: number; currentHostname?: string; currentDeviceId?: string } = {},
): AssessedInstance {
  const nowMs = opts.nowMs ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? manifest.stale_after_ms ?? DEFAULT_STALE_AFTER_MS;
  const heartbeatMs = Date.parse(manifest.heartbeat_at);
  const heartbeatAge = Number.isFinite(heartbeatMs) ? Math.max(0, nowMs - heartbeatMs) : null;
  const sameScope = sameDeviceOrHost(manifest, opts.currentHostname ?? os.hostname(), opts.currentDeviceId ?? getDeviceId());
  const pidAlive = sameScope ? pidAppearsAlive(manifest.pid) : undefined;

  if (manifest.status === "exiting") {
    return { manifest, liveness: "exiting", heartbeat_age_ms: heartbeatAge, ...(pidAlive !== undefined ? { pid_alive: pidAlive } : {}) };
  }
  if (heartbeatAge !== null && heartbeatAge <= staleAfterMs) {
    const status = manifest.status === "active" ? "active" : "idle";
    return { manifest, liveness: status, heartbeat_age_ms: heartbeatAge, ...(pidAlive !== undefined ? { pid_alive: pidAlive } : {}) };
  }
  if (pidAlive === true) {
    return { manifest, liveness: "suspended", heartbeat_age_ms: heartbeatAge, pid_alive: true, stale_reason: "heartbeat_stale_pid_alive" };
  }
  return { manifest, liveness: "stale", heartbeat_age_ms: heartbeatAge, ...(pidAlive !== undefined ? { pid_alive: pidAlive } : {}), stale_reason: pidAlive === false ? "pid_dead" : "heartbeat_stale" };
}

function sameDeviceOrHost(manifest: MultiInstanceManifest, hostname: string, deviceId?: string): boolean {
  if (manifest.device_id && deviceId && manifest.device_id === deviceId) return true;
  return !!manifest.hostname && manifest.hostname === hostname;
}

function pidAppearsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function fingerprintFile(file: string): FileFingerprint {
  try {
    const st = fs.statSync(file);
    if (st.isDirectory()) return { kind: "directory", mtimeMs: st.mtimeMs, size: st.size };
    if (!st.isFile()) return { kind: "other", mtimeMs: st.mtimeMs, size: st.size };
    const hash = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
    return { kind: "file", mtimeMs: st.mtimeMs, size: st.size, sha1: hash };
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "missing" };
    return { kind: "other" };
  }
}

export function sameFingerprint(a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean {
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "missing") return true;
  return a.mtimeMs === b.mtimeMs && a.size === b.size && a.sha1 === b.sha1;
}

export function recordObservedPath(projectRoot: string, rawPath: string, cwd: string = projectRoot): void {
  if (!rawPath) return;
  const abs = resolveTargetPath(rawPath, cwd);
  const state = getMultiInstanceState();
  state.observedFiles.set(abs, fingerprintFile(abs));
  if (!state.projectRoot) state.projectRoot = path.resolve(projectRoot);
  writeCurrentManifest(state.status);
}

export function recordOwnWrite(projectRoot: string, rawPath: string, cwd: string = projectRoot): void {
  if (!rawPath) return;
  const abs = resolveTargetPath(rawPath, cwd);
  const fp = fingerprintFile(abs);
  const state = getMultiInstanceState();
  state.ownWrites.set(abs, fp);
  state.observedFiles.set(abs, fp);
  state.recentWrites.set(abs, Date.now());
  if (!state.projectRoot) state.projectRoot = path.resolve(projectRoot);
  writeCurrentManifest(state.status);
}

export function evaluateToolGuard(
  toolName: string,
  input: unknown,
  projectRoot: string,
  cwd: string,
  peers: AssessedInstance[] = [],
): GuardVerdict {
  const intent = classifyToolIntent(toolName, input);
  if (intent.intent === "observe") {
    const targetPaths = intent.paths.map((p) => resolveTargetPath(p, cwd));
    setInstanceActivity(intent.activity ?? `observing with ${toolName}`, toolName, targetPaths);
    return { action: "allow", toolName, targetPaths, risks: [] };
  }
  if (intent.intent !== "write") {
    setInstanceActivity(intent.activity ?? `running ${toolName}`, toolName, []);
    return { action: "allow", toolName, targetPaths: [], risks: [] };
  }

  const state = getMultiInstanceState();
  const root = path.resolve(projectRoot);
  const targetPaths = unique(intent.paths.map((p) => resolveTargetPath(p, cwd)));
  setInstanceActivity(intent.activity ?? `writing with ${toolName}`, toolName, targetPaths);

  const risks: GuardRisk[] = [];
  const pushRisk = (action: "warn" | "block", kind: string, absPath: string | undefined, reason: string, peerIds?: string[]) => {
    risks.push({
      ts: nowIso(),
      action,
      kind,
      tool: toolName,
      ...(absPath ? { path: displayPath(root, absPath) } : {}),
      reason,
      ...(peerIds && peerIds.length ? { peer_instance_ids: peerIds } : {}),
    });
  };

  if (intent.dangerousGit?.dangerous) {
    pushRisk("block", "dangerous_git", undefined, intent.dangerousGit.reason ?? "dangerous git command");
  }
  const editComplexity = intent.writeKind === "edit" ? detectEditComplexityRisk(input) : undefined;
  if (editComplexity) {
    pushRisk("warn", editComplexity.kind, targetPaths[0], editComplexity.reason);
  }

  for (const abs of targetPaths) {
    const current = fingerprintFile(abs);
    const observed = state.observedFiles.get(abs);
    const own = state.ownWrites.get(abs);
    if (observed && !sameFingerprint(current, observed) && !sameFingerprint(current, own)) {
      pushRisk("block", "stale_context", abs, "file changed on disk after this instance observed it");
    }
    if (!observed && highRiskExistingTarget(intent.writeKind, current)) {
      const targetKind = current.kind === "file" ? "file" : "existing path";
      pushRisk("block", "unobserved_high_risk_write", abs, `high-risk write targets an ${targetKind} that this instance has not observed in the current session epoch`);
    }
    const peerIds = peersTouchingPath(peers, root, abs);
    if (peerIds.length > 0) {
      const action = intent.writeKind === "edit" ? "warn" : "block";
      pushRisk(action, "peer_activity", abs, "another pi instance recently targeted, observed, or wrote this path", peerIds);
    }
  }

  const action = risks.some((r) => r.action === "block") ? "block" : risks.some((r) => r.action === "warn") ? "warn" : "allow";
  if (risks.length) rememberGuardRisks(risks);
  return { action, toolName, writeKind: intent.writeKind, targetPaths, risks, ...(intent.dangerousGit ? { dangerousGit: intent.dangerousGit } : {}) };
}

function highRiskExistingTarget(kind: WriteKind, current: FileFingerprint): boolean {
  if (kind === "whole_write") return current.kind === "file";
  if (kind === "delete" || kind === "move" || kind === "dangerous_git" || kind === "bash_write") return current.kind !== "missing";
  return false;
}

function detectEditComplexityRisk(input: unknown): { kind: string; reason: string } | undefined {
  const obj = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const edits = Array.isArray(obj.edits) ? obj.edits : [];
  if (edits.length > 1) return { kind: "batch_edit", reason: `edit contains ${edits.length} replacement blocks; verify the current file state before continuing` };
  const large = edits.some((edit) => {
    if (!edit || typeof edit !== "object" || Array.isArray(edit)) return false;
    const oldText = (edit as Record<string, unknown>).oldText;
    const newText = (edit as Record<string, unknown>).newText;
    return (typeof oldText === "string" && oldText.length > 4_000) || (typeof newText === "string" && newText.length > 4_000);
  });
  if (large) return { kind: "large_edit", reason: "edit carries a large replacement block; re-read nearby context after it lands" };
  return undefined;
}

function rememberGuardRisks(risks: GuardRisk[]): void {
  const state = getMultiInstanceState();
  state.guardRisks = [...state.guardRisks, ...risks].slice(-MAX_RECENT_RISKS);
}

export function getRecentGuardRisks(): GuardRisk[] {
  return getMultiInstanceState().guardRisks.slice();
}

function peersTouchingPath(peers: AssessedInstance[], projectRoot: string, absPath: string): string[] {
  const rel = displayPath(projectRoot, absPath);
  const ids: string[] = [];
  for (const peer of peers) {
    if (peer.liveness === "stale" || peer.liveness === "exiting") continue;
    const m = peer.manifest;
    const paths = [...(m.target_paths ?? []), ...(m.observed_files ?? []), ...(m.recent_writes ?? [])];
    if (paths.some((p) => pathMatchesManifestPath(projectRoot, p, absPath, rel))) ids.push(m.instance_id);
  }
  return ids;
}

function pathMatchesManifestPath(projectRoot: string, manifestPath: string, absPath: string, rel: string): boolean {
  if (manifestPath === rel || manifestPath === absPath) return true;
  if (path.isAbsolute(manifestPath)) return path.resolve(manifestPath) === absPath;
  return path.resolve(projectRoot, manifestPath) === absPath;
}

export function classifyToolIntent(toolName: string, input: unknown): ToolIntent {
  const name = String(toolName || "").toLowerCase();
  const obj = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  if (name === "read" || name === "grep" || name === "find" || name === "ls") {
    return { intent: "observe", paths: pathValuesFromInput(obj), activity: name };
  }
  if (name === "edit") {
    return { intent: "write", writeKind: "edit", paths: pathValuesFromInput(obj), activity: "edit" };
  }
  if (name === "write") {
    return { intent: "write", writeKind: "whole_write", paths: pathValuesFromInput(obj), activity: "whole-file write" };
  }
  if (name === "rm" || name === "remove" || name === "delete") {
    return { intent: "write", writeKind: "delete", paths: pathValuesFromInput(obj), activity: name };
  }
  if (name === "mv" || name === "move" || name === "rename") {
    return { intent: "write", writeKind: "move", paths: pathValuesFromInput(obj), activity: name };
  }
  if (name === "bash") {
    const command = typeof obj.command === "string" ? obj.command : "";
    const dangerousGit = detectDangerousGitCommand(command);
    if (dangerousGit.dangerous) {
      return { intent: "write", writeKind: "dangerous_git", paths: extractBashWriteTargets(command), activity: `bash: git ${dangerousGit.verb}`, dangerousGit };
    }
    const paths = extractBashWriteTargets(command);
    if (paths.length > 0) return { intent: "write", writeKind: "bash_write", paths, activity: "bash write" };
    return { intent: "other", activity: "bash" };
  }
  return { intent: "other", activity: name || "tool" };
}

function pathValuesFromInput(input: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["path", "file", "target", "source", "destination", "from", "to"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) out.push(v.trim());
  }
  for (const key of ["paths", "files", "targets"]) {
    const v = input[key];
    if (Array.isArray(v)) {
      for (const item of v) if (typeof item === "string" && item.trim()) out.push(item.trim());
    }
  }
  return unique(out);
}

export function detectDangerousGitCommand(command: string): DangerousGitVerdict {
  const tokens = tokenizeShellLite(command);
  const dangerous = new Set(["checkout", "restore", "reset", "clean", "rebase", "merge", "switch"]);
  for (let i = 0; i < tokens.length; i++) {
    if (!isGitToken(tokens[i])) continue;
    let j = i + 1;
    while (j < tokens.length) {
      const t = tokens[j];
      if (t === "-C" || t === "-c" || t === "--git-dir" || t === "--work-tree") {
        j += 2;
        continue;
      }
      if (t.startsWith("--git-dir=") || t.startsWith("--work-tree=")) {
        j += 1;
        continue;
      }
      if (t.startsWith("-")) {
        j += 1;
        continue;
      }
      break;
    }
    const verb = tokens[j];
    if (verb && dangerous.has(verb)) {
      return { dangerous: true, verb, reason: `git ${verb} can change the worktree or index and may roll back another pi session's landed changes` };
    }
  }
  return { dangerous: false };
}

function isGitToken(token: string | undefined): boolean {
  if (!token) return false;
  return token === "git" || token.endsWith("/git");
}

function tokenizeShellLite(command: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(command)) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(token.replace(/^['"]|['"]$/g, ""));
  }
  return tokens;
}

export function extractBashWriteTargets(command: string): string[] {
  const tokens = tokenizeShellLite(command);
  const out: string[] = [];
  const writeCommands = new Set(["rm", "mv", "cp"]);
  for (let i = 0; i < tokens.length; i++) {
    const cmd = path.basename(tokens[i]);
    if (!writeCommands.has(cmd)) continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith("-")) j++;
    for (; j < tokens.length; j++) {
      const t = tokens[j];
      if (isShellSeparator(t)) break;
      if (!t.startsWith("-")) out.push(t);
    }
  }
  const redirectRe = /(?:^|\s)(?:>|>>|2>|&>)\s*([^\s;&|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = redirectRe.exec(command)) !== null) {
    if (m[1]) out.push(m[1].replace(/^['"]|['"]$/g, ""));
  }
  return unique(out.filter((p) => p && p !== "/dev/null"));
}

function isShellSeparator(token: string): boolean {
  return token === ";" || token === "&&" || token === "||" || token === "|";
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function resolveTargetPath(rawPath: string, cwd: string): string {
  const expanded = rawPath.startsWith("~") ? path.join(os.homedir(), rawPath.slice(1)) : rawPath;
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd || process.cwd(), expanded));
}

function displayPath(projectRoot: string | undefined, absPath: string): string {
  const abs = path.resolve(absPath);
  if (!projectRoot) return abs;
  const rel = path.relative(path.resolve(projectRoot), abs);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : abs;
}

export function buildGuardBlockReason(verdict: GuardVerdict): string {
  const lines = [
    "pi-astack multi-instance guard blocked this tool call to avoid overwriting, deleting, or rolling back changes already landed by another session or by disk state newer than this session's observation.",
  ];
  for (const risk of verdict.risks.slice(0, 6)) {
    lines.push(`- ${risk.kind}${risk.path ? ` ${risk.path}` : ""}: ${risk.reason}${risk.peer_instance_ids?.length ? ` (peer ${risk.peer_instance_ids.map(shortId).join(",")})` : ""}`);
  }
  lines.push("Read the current file/worktree state first, narrow the change, or ask the user for explicit override before retrying.");
  return lines.join("\n");
}

export function buildFooterText(scan: PeerScan, risks: GuardRisk[] = getRecentGuardRisks()): string {
  const peerBits = scan.counts.peers === 0
    ? "peers 0"
    : `peers ${scan.counts.peers} a${scan.counts.active}/i${scan.counts.idle}/s${scan.counts.suspended}/x${scan.counts.stale}`;
  const riskCount = risks.filter((r) => r.action === "block" || r.action === "warn").length;
  return riskCount > 0 ? `${peerBits} risk ${riskCount}` : peerBits;
}

export function buildPeersNotifyType(scan: PeerScan, risks: GuardRisk[] = getRecentGuardRisks()): "info" | "warning" {
  if (scan.readError) return "warning";
  if (risks.length > 0) return "warning";
  if (scan.peers.some((peer) => peer.liveness === "stale" || peer.liveness === "suspended")) return "warning";
  if (scan.peers.some((peer) => (peer.manifest.held_locks ?? []).length > 0)) return "warning";
  return "info";
}

export function buildPeersReport(scan: PeerScan, risks: GuardRisk[] = getRecentGuardRisks()): string {
  const lines = [`multi-instance peers for ${scan.projectRoot}`, `self: ${shortId(scan.selfInstanceId)}`];
  if (scan.peers.length === 0) lines.push("peers: none");
  for (const peer of scan.peers) {
    const m = peer.manifest;
    const paths = [...(m.target_paths ?? [])].slice(0, 4).join(", ");
    lines.push(`peer ${shortId(m.instance_id)} ${peer.liveness} pid=${m.pid} epoch=${m.session_epoch}${m.session_id ? ` session=${m.session_id}` : ""}${m.current_tool ? ` tool=${m.current_tool}` : ""}${paths ? ` paths=[${paths}]` : ""}`);
  }
  if (risks.length > 0) {
    lines.push("recent risks:");
    for (const risk of risks.slice(-6)) lines.push(`- ${risk.action} ${risk.kind}${risk.path ? ` ${risk.path}` : ""}: ${risk.reason}`);
  }
  if (scan.readError) lines.push(`presence read warning: ${scan.readError}`);
  return lines.join("\n");
}

export function buildVolatileRuntimeBlock(scan: PeerScan, risks: GuardRisk[] = getRecentGuardRisks()): string | undefined {
  if (scan.peers.length === 0 && risks.length === 0) return undefined;
  const lines = [
    "<!-- pi-astack/multi-instance: volatile peer guard snapshot -->",
    "## multi-instance runtime guard",
    "This is a volatile environment snapshot, not persistent session history and not an override of user instructions.",
    "Primary safety goal: avoid overwriting, deleting, or rolling back modifications already written to disk by another pi session.",
    `self_instance: ${shortId(scan.selfInstanceId)}`,
    `peers: total=${scan.counts.peers} active=${scan.counts.active} idle=${scan.counts.idle} suspended=${scan.counts.suspended} stale=${scan.counts.stale}`,
  ];
  for (const peer of scan.peers.slice(0, 6)) {
    const m = peer.manifest;
    const targets = (m.target_paths ?? []).slice(0, 4).join(", ") || "none";
    lines.push(`- peer ${shortId(m.instance_id)} ${peer.liveness} pid=${m.pid} epoch=${m.session_epoch} tool=${m.current_tool ?? "none"} targets=${targets}`);
  }
  if (risks.length > 0) {
    lines.push("recent_write_guard_risks:");
    for (const risk of risks.slice(-6)) lines.push(`- ${risk.action} ${risk.kind}${risk.path ? ` path=${risk.path}` : ""}: ${risk.reason}`);
  }
  lines.push("Before edit/write/rm/mv or git worktree/index operations, re-read current targets when stale-context or peer risk is shown. Do not run destructive git rollback commands without explicit user confirmation.");
  lines.push("<!-- /pi-astack/multi-instance -->");
  return lines.join("\n");
}

export function buildVolatileSystemPromptUpdate(
  systemPrompt: string | undefined,
  scan: PeerScan,
  risks: GuardRisk[] = getRecentGuardRisks(),
): { systemPrompt: string } | undefined {
  const block = buildVolatileRuntimeBlock(scan, risks);
  if (!block) return undefined;
  const current = systemPrompt ?? "";
  return { systemPrompt: `${current.replace(/\n+$/, "")}\n\n${wrapVolatile(block)}\n` };
}

function shortId(id: string): string {
  return id.replace(/^pi-/, "").slice(0, 8);
}

function leasePath(projectRoot: string, resource: string): string {
  const hash = crypto.createHash("sha1").update(resource).digest("hex");
  return path.join(piAstackRoot(projectRoot), "leases", `${hash}.json`);
}

export function tryAcquireResourceLease(projectRoot: string, resource: string, cls: ResourceClass, ttlMs: number = 60_000): ResourceLeaseRecord | null {
  const state = getMultiInstanceState();
  const file = leasePath(projectRoot, `${cls}:${resource}`);
  const now = Date.now();
  const record: ResourceLeaseRecord = {
    schema_version: 1,
    owner_instance_id: state.instanceId,
    token: crypto.randomUUID(),
    resource,
    class: cls,
    pid: process.pid,
    hostname: state.hostname,
    ...(state.deviceId ? { device_id: state.deviceId } : {}),
    project_root: path.resolve(projectRoot),
    acquired_at: formatLocalIsoTimestamp(new Date(now)),
    renewed_at: formatLocalIsoTimestamp(new Date(now)),
    expires_at: formatLocalIsoTimestamp(new Date(now + ttlMs)),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { encoding: "utf-8", flag: "wx", mode: 0o600 });
    state.heldLocks.push({ resource, class: cls, token: record.token, acquired_at: record.acquired_at, renewed_at: record.renewed_at });
    writeCurrentManifest(state.status);
    return record;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
  }
  try {
    const existing = JSON.parse(fs.readFileSync(file, "utf-8")) as ResourceLeaseRecord;
    const expired = Date.parse(existing.expires_at) < now;
    const sameScope = (existing.device_id && state.deviceId && existing.device_id === state.deviceId) || existing.hostname === state.hostname;
    if (!expired) return null;
    if (sameScope && pidAppearsAlive(existing.pid)) return null;
    fs.unlinkSync(file);
    return tryAcquireResourceLease(projectRoot, resource, cls, ttlMs);
  } catch {
    return null;
  }
}

export function releaseResourceLease(projectRoot: string, lease: ResourceLeaseRecord | null | undefined): void {
  if (!lease) return;
  const file = leasePath(projectRoot, `${lease.class}:${lease.resource}`);
  try {
    const current = JSON.parse(fs.readFileSync(file, "utf-8")) as ResourceLeaseRecord;
    if (current.token !== lease.token || current.owner_instance_id !== lease.owner_instance_id) return;
    fs.unlinkSync(file);
  } catch {
    // Best effort.
  }
  const state = getMultiInstanceState();
  state.heldLocks = state.heldLocks.filter((l) => l.token !== lease.token);
  writeCurrentManifest(state.status);
}

export const __TEST = {
  tokenizeShellLite,
  peersTouchingPath,
  displayPath,
};
