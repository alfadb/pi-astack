#!/usr/bin/env node
/**
 * smoke-multi-instance — multi-main-pi awareness and advisory risk surface.
 *
 * Covers:
 *   - process-stable instance_id and foreground session_epoch semantics
 *   - manifest write + scan
 *   - heartbeat stale vs PID-alive suspended classification
 *   - sub-agent session start does not register a peer manifest
 *   - sub-agent before_agent_start volatile block without foreground registration
 *   - sub-agent tool_call advisory risk surface and tool_result observation recording
 *   - file fingerprint stale-context advisory risk
 *   - high-risk whole-file write advisory risk
 *   - peer activity advisory path for edit
 *   - dangerous git command detection without blocking
 *   - volatile runtime block text contract
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-multi-instance-"));
process.env.ABRAIN_ROOT = path.join(tmpRoot, "abrain");

const jiti = createJiti(import.meta.url);
const mod = await jiti.import(path.join(repoRoot, "extensions/_shared/multi-instance.ts"));
const piInternals = await jiti.import(path.join(repoRoot, "extensions/_shared/pi-internals.ts"));
const extensionModule = await jiti.import(path.join(repoRoot, "extensions/multi-instance/index.ts"));
const activateMultiInstanceExtension = extensionModule.default ?? extensionModule;

const failures = [];
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures.push({ name, detail });
    console.log(`  FAIL  ${name}${detail ? `\n        ${detail}` : ""}`);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writePeerManifest(root, patch) {
  const dir = mod.instancesDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    schema_version: 1,
    instance_id: "pi-peer-0001",
    pid: process.pid,
    hostname: os.hostname(),
    project_root: root,
    session_id: "peer-session",
    session_epoch: 1,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    heartbeat_at: new Date().toISOString(),
    heartbeat_seq: 1,
    heartbeat_interval_ms: 15_000,
    stale_after_ms: 45_000,
    status: "active",
    target_paths: [],
    observed_files: [],
    recent_writes: [],
    held_locks: [],
    ...patch,
  };
  const file = mod.manifestPathForInstance(root, manifest.instance_id);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
  return { file, manifest };
}

function createMultiInstanceHarness() {
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      const list = handlers.get(name) ?? [];
      list.push(handler);
      handlers.set(name, list);
    },
    registerCommand() {
      // Commands are not needed in smoke harness.
    },
  };
  activateMultiInstanceExtension(pi);
  return {
    handler(name) {
      const list = handlers.get(name) ?? [];
      if (list.length !== 1) throw new Error(`expected one handler for ${name}, got ${list.length}`);
      return list[0];
    },
  };
}

function subAgentCtx(root) {
  const sessionManager = {};
  piInternals.markSessionAsSubAgent(sessionManager);
  const notifications = [];
  const statuses = [];
  return {
    ctx: {
      cwd: root,
      sessionManager,
      ui: {
        notify(message, type) {
          notifications.push({ message, type });
        },
        setStatus(key, value) {
          statuses.push({ key, value });
        },
      },
    },
    notifications,
    statuses,
  };
}

console.log("smoke: multi-instance awareness");

console.log("\n[1] instance identity and session epoch");
{
  mod.resetMultiInstanceStateForTests();
  const root = path.join(tmpRoot, "epoch");
  fs.mkdirSync(root, { recursive: true });
  const id1 = mod.getInstanceId();
  const a = mod.startForegroundSession({ projectRoot: root, sessionId: "s1", sessionFile: "s1.json" });
  const timer1 = mod.getMultiInstanceState().timer;
  const b = mod.startForegroundSession({ projectRoot: root, sessionId: "s1", sessionFile: "s1.json" });
  const timer2 = mod.getMultiInstanceState().timer;
  const c = mod.startForegroundSession({ projectRoot: root, sessionId: "s2", sessionFile: "s2.json" });
  const id2 = mod.getInstanceId();
  check("instance_id is stable within process", id1 === id2, `${id1} !== ${id2}`);
  check("first foreground session registers", a.registered === true);
  check("same /reload-like session does not bump epoch", b.sessionEpoch === a.sessionEpoch, `${a.sessionEpoch} -> ${b.sessionEpoch}`);
  check("/new or /resume foreground session bumps epoch", c.sessionEpoch === a.sessionEpoch + 1, `${a.sessionEpoch} -> ${c.sessionEpoch}`);
  check("heartbeat timer is not duplicated", timer1 && timer1 === timer2);
  mod.resetMultiInstanceStateForTests();
}

console.log("\n[2] manifest write and scan");
{
  const root = path.join(tmpRoot, "manifest");
  fs.mkdirSync(root, { recursive: true });
  mod.startForegroundSession({ projectRoot: root, sessionId: "main-session", sessionFile: "main.json" });
  const selfFile = mod.manifestPathForInstance(root, mod.getInstanceId());
  check("self manifest exists", fs.existsSync(selfFile), selfFile);
  const self = readJson(selfFile);
  check("manifest carries required identity fields", self.schema_version === 1 && self.instance_id === mod.getInstanceId() && self.pid === process.pid && self.session_epoch === 1);
  writePeerManifest(root, { target_paths: ["src/a.ts"] });
  const scan = mod.scanInstanceManifests(root);
  check("scan includes self + peer", scan.instances.length === 2, `instances=${scan.instances.length}`);
  check("scan derives one peer", scan.peers.length === 1, `peers=${scan.peers.length}`);
  check("peer active count is derived", scan.counts.active === 1, JSON.stringify(scan.counts));
  mod.resetMultiInstanceStateForTests();
}

console.log("\n[3] heartbeat preserves active manifest state");
{
  mod.resetMultiInstanceStateForTests();
  const root = path.join(tmpRoot, "heartbeat-active");
  fs.mkdirSync(root, { recursive: true });
  const state = mod.getMultiInstanceState();
  state.heartbeatIntervalMs = 20;
  state.staleAfterMs = 1_000;
  mod.startForegroundSession({ projectRoot: root, sessionId: "heartbeat-active" });
  const selfFile = mod.manifestPathForInstance(root, mod.getInstanceId());
  mod.setInstanceActivity("writing with edit", "edit", [path.join(root, "active.txt")]);
  const before = readJson(selfFile);
  await sleep(80);
  const after = readJson(selfFile);
  check("heartbeat advanced after active tool state", after.heartbeat_seq > before.heartbeat_seq, `${before.heartbeat_seq} -> ${after.heartbeat_seq}`);
  check("heartbeat keeps active status", after.status === "active", after.status);
  check("heartbeat keeps current tool", after.current_tool === "edit", String(after.current_tool));
  check("heartbeat keeps target paths", Array.isArray(after.target_paths) && after.target_paths.includes("active.txt"), JSON.stringify(after.target_paths));
  mod.resetMultiInstanceStateForTests();
}

console.log("\n[4] stale and suspended liveness");
{
  const root = path.join(tmpRoot, "liveness");
  const old = new Date(Date.now() - 60_000).toISOString();
  const base = writePeerManifest(root, { heartbeat_at: old, updated_at: old }).manifest;
  const suspended = mod.assessManifestLiveness(base, { nowMs: Date.now(), staleAfterMs: 45_000, currentHostname: os.hostname() });
  check("PID alive + stale heartbeat => suspended", suspended.liveness === "suspended", suspended.liveness);
  const stale = mod.assessManifestLiveness({ ...base, pid: 99999999 }, { nowMs: Date.now(), staleAfterMs: 45_000, currentHostname: os.hostname() });
  check("PID dead + stale heartbeat => stale", stale.liveness === "stale", stale.liveness);
}

console.log("\n[5] sub-agent does not register peer");
{
  mod.resetMultiInstanceStateForTests();
  const root = path.join(tmpRoot, "subagent");
  fs.mkdirSync(root, { recursive: true });
  const r = mod.startForegroundSession({ projectRoot: root, sessionId: "sub", isSubAgent: true });
  const selfFile = mod.manifestPathForInstance(root, mod.getInstanceId());
  check("sub-agent start returns registered=false", r.registered === false);
  check("sub-agent start writes no manifest", !fs.existsSync(selfFile), selfFile);
}

console.log("\n[6] sub-agent extension advisory path");
{
  mod.resetMultiInstanceStateForTests();
  const root = path.join(tmpRoot, "subagent-extension");
  fs.mkdirSync(root, { recursive: true });
  writePeerManifest(root, { instance_id: "pi-peer-subagent", current_tool: "edit", target_paths: ["peer-risk.txt"] });
  const harness = createMultiInstanceHarness();
  const { ctx, notifications } = subAgentCtx(root);
  const beforeEpoch = mod.getMultiInstanceState().sessionEpoch;
  const before = await harness.handler("before_agent_start")({ systemPrompt: "base prompt\n" }, ctx);
  const selfFile = mod.manifestPathForInstance(root, mod.getInstanceId());
  check("sub-agent before_agent_start does not bump session epoch", mod.getMultiInstanceState().sessionEpoch === beforeEpoch, `${beforeEpoch} -> ${mod.getMultiInstanceState().sessionEpoch}`);
  check("sub-agent before_agent_start does not register self", mod.getMultiInstanceState().registered === false);
  check("sub-agent before_agent_start writes no manifest", !fs.existsSync(selfFile), selfFile);
  check("sub-agent before_agent_start emits volatile block with peer risk", typeof before?.systemPrompt === "string" && before.systemPrompt.includes("multi-instance runtime guard") && before.systemPrompt.includes("volatile-suffix"));

  fs.writeFileSync(path.join(root, "whole.txt"), "existing\n", "utf-8");
  const whole = harness.handler("tool_call")({ toolName: "write", toolCallId: "whole", input: { path: "whole.txt", content: "replace\n" } }, ctx);
  check("sub-agent whole-file write to unobserved existing file warns and continues", whole === undefined && notifications.some((n) => n.message.includes("unobserved_high_risk_write")), JSON.stringify(whole));
  const git = harness.handler("tool_call")({ toolName: "bash", toolCallId: "git", input: { command: "git reset --hard HEAD" } }, ctx);
  check("sub-agent dangerous git command warns and continues", git === undefined && notifications.some((n) => n.message.includes("dangerous_git")), JSON.stringify(git));

  const observedFile = path.join(root, "observed.txt");
  fs.writeFileSync(observedFile, "one\n", "utf-8");
  const readCall = harness.handler("tool_call")({ toolName: "read", toolCallId: "read-observed", input: { path: "observed.txt" } }, ctx);
  check("sub-agent read tool_call is allowed", readCall === undefined, JSON.stringify(readCall));
  await harness.handler("tool_result")({ toolName: "read", toolCallId: "read-observed", input: { path: "observed.txt" }, isError: false }, ctx);
  fs.writeFileSync(observedFile, "two\n", "utf-8");
  const stale = harness.handler("tool_call")({ toolName: "edit", toolCallId: "edit-observed", input: { path: "observed.txt", edits: [{ oldText: "two", newText: "three" }] } }, ctx);
  check("sub-agent edit warns after observed file changed externally and continues", stale === undefined && notifications.some((n) => n.message.includes("stale_context")), JSON.stringify(stale));
  check("sub-agent advisory path still writes no manifest", !fs.existsSync(selfFile), selfFile);
  mod.resetMultiInstanceStateForTests();
}

console.log("\n[7] file fingerprint stale-context advisory risk");
{
  mod.resetMultiInstanceStateForTests();
  const root = path.join(tmpRoot, "guard");
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "one\n", "utf-8");
  mod.startForegroundSession({ projectRoot: root, sessionId: "guard" });
  mod.recordObservedPath(root, "a.txt", root);
  fs.writeFileSync(file, "two\n", "utf-8");
  const verdict = mod.evaluateToolGuard("edit", { path: "a.txt", edits: [{ oldText: "two", newText: "three" }] }, root, root, []);
  check("edit warns when target fingerprint changed after observation", verdict.action === "warn", verdict.action);
  check("stale-context risk is recorded", verdict.risks.some((r) => r.kind === "stale_context"));
  mod.recordOwnWrite(root, "a.txt", root);
  const afterOwn = mod.evaluateToolGuard("edit", { path: "a.txt", edits: [{ oldText: "two", newText: "three" }] }, root, root, []);
  check("own known write refreshes observed fingerprint", afterOwn.action === "allow", afterOwn.action);
}

console.log("\n[8] high-risk write and peer activity advisory risk");
{
  mod.resetMultiInstanceStateForTests();
  const root = path.join(tmpRoot, "risk");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "whole.txt"), "existing\n", "utf-8");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "other-session.txt"), "landed\n", "utf-8");
  fs.mkdirSync(path.join(root, "move-dir"), { recursive: true });
  fs.writeFileSync(path.join(root, "move-dir", "other-session.txt"), "landed\n", "utf-8");
  mod.startForegroundSession({ projectRoot: root, sessionId: "risk" });
  const whole = mod.evaluateToolGuard("write", { path: "whole.txt", content: "replace\n" }, root, root, []);
  check("whole-file write to unobserved existing file warns", whole.action === "warn", whole.action);
  const bashRmDir = mod.evaluateToolGuard("bash", { command: "rm -rf src" }, root, root, []);
  check("bash rm -rf to unobserved existing directory warns", bashRmDir.action === "warn", bashRmDir.action);
  check("bash rm -rf directory records unobserved high-risk write", bashRmDir.risks.some((r) => r.kind === "unobserved_high_risk_write" && r.path === "src"));
  const deleteDir = mod.evaluateToolGuard("delete", { path: "src" }, root, root, []);
  check("delete to unobserved existing directory warns", deleteDir.action === "warn", deleteDir.action);
  const moveDir = mod.evaluateToolGuard("move", { source: "move-dir", destination: "moved-dir" }, root, root, []);
  check("move from unobserved existing directory warns", moveDir.action === "warn", moveDir.action);
  const peerInfo = writePeerManifest(root, { instance_id: "pi-peer-edit", target_paths: ["peer.txt"], observed_files: ["peer.txt"] });
  fs.writeFileSync(path.join(root, "peer.txt"), "x\n", "utf-8");
  mod.recordObservedPath(root, "peer.txt", root);
  const peerScan = mod.scanInstanceManifests(root);
  const edit = mod.evaluateToolGuard("edit", { path: "peer.txt", edits: [{ oldText: "x", newText: "y" }] }, root, root, peerScan.peers);
  check("edit with peer activity warns rather than hard-locking", edit.action === "warn", edit.action);
  check("peer activity risk references peer", edit.risks.some((r) => r.kind === "peer_activity" && r.peer_instance_ids?.includes(peerInfo.manifest.instance_id)));
  const batch = mod.evaluateToolGuard("edit", { path: "peer.txt", edits: [{ oldText: "x", newText: "y" }, { oldText: "a", newText: "b" }] }, root, root, []);
  check("batch edit enters explicit warning path", batch.action === "warn" && batch.risks.some((r) => r.kind === "batch_edit"), batch.action);
}

console.log("\n[9] dangerous git command detection");
{
  const d1 = mod.detectDangerousGitCommand("git reset --hard HEAD~1");
  const d2 = mod.detectDangerousGitCommand("git -C repo restore --source=HEAD -- file.ts");
  const safe = mod.detectDangerousGitCommand("git status --short");
  check("git reset --hard detected", d1.dangerous === true && d1.verb === "reset", JSON.stringify(d1));
  check("git restore detected through -C", d2.dangerous === true && d2.verb === "restore", JSON.stringify(d2));
  check("git status is not dangerous", safe.dangerous === false, JSON.stringify(safe));
  const root = path.join(tmpRoot, "git-risk");
  fs.mkdirSync(root, { recursive: true });
  mod.resetMultiInstanceStateForTests();
  mod.startForegroundSession({ projectRoot: root, sessionId: "git-risk" });
  const verdict = mod.evaluateToolGuard("bash", { command: "git checkout -- ." }, root, root, []);
  check("dangerous git bash command warns without blocking", verdict.action === "warn" && verdict.risks.some((r) => r.kind === "dangerous_git"), verdict.action);
}

console.log("\n[10] peers notify severity");
{
  mod.resetMultiInstanceStateForTests();
  const root = path.join(tmpRoot, "notify");
  fs.mkdirSync(root, { recursive: true });
  mod.startForegroundSession({ projectRoot: root, sessionId: "notify" });
  check("no peers notify is info", mod.buildPeersNotifyType(mod.scanInstanceManifests(root), []) === "info");
  writePeerManifest(root, { instance_id: "pi-peer-active", status: "active", current_tool: "bash" });
  check("active peer without risk notify is info", mod.buildPeersNotifyType(mod.scanInstanceManifests(root), []) === "info");
  writePeerManifest(root, { instance_id: "pi-peer-lock", held_locks: [{ resource: "git:index", class: "git" }] });
  check("peer held lock notify is warning", mod.buildPeersNotifyType(mod.scanInstanceManifests(root), []) === "warning");
  const old = new Date(Date.now() - 60_000).toISOString();
  writePeerManifest(root, { instance_id: "pi-peer-suspended", heartbeat_at: old, updated_at: old });
  check("suspended peer notify is warning", mod.buildPeersNotifyType(mod.scanInstanceManifests(root), []) === "warning");
  writePeerManifest(root, { instance_id: "pi-peer-stale", pid: 99999999, heartbeat_at: old, updated_at: old });
  check("stale peer notify is warning", mod.buildPeersNotifyType(mod.scanInstanceManifests(root), []) === "warning");
  const activeOnly = mod.scanInstanceManifests(root, { selfInstanceId: mod.getInstanceId() });
  activeOnly.peers = activeOnly.peers.filter((peer) => peer.manifest.instance_id === "pi-peer-active");
  activeOnly.counts = { active: 1, idle: 0, stale: 0, suspended: 0, exiting: 0, peers: 1, risk: 0 };
  check("recent guard risk notify is warning", mod.buildPeersNotifyType(activeOnly, [{ ts: new Date().toISOString(), action: "warn", kind: "peer_activity", tool: "edit", path: "x.ts", reason: "peer activity" }]) === "warning");
}

console.log("\n[11] volatile runtime block text");
{
  mod.resetMultiInstanceStateForTests();
  const root = path.join(tmpRoot, "volatile");
  fs.mkdirSync(root, { recursive: true });
  mod.startForegroundSession({ projectRoot: root, sessionId: "volatile" });
  const quiet = mod.buildVolatileRuntimeBlock(mod.scanInstanceManifests(root), []);
  check("no peers/risks => no volatile block", quiet === undefined, String(quiet));
  writePeerManifest(root, { instance_id: "pi-peer-block", current_tool: "edit", target_paths: ["x.ts"] });
  const scan = mod.scanInstanceManifests(root);
  const block = mod.buildVolatileRuntimeBlock(scan, [{ ts: new Date().toISOString(), action: "warn", kind: "stale_context", tool: "write", path: "x.ts", reason: "file changed" }]);
  check("volatile block is emitted with peer/risk", typeof block === "string" && block.includes("multi-instance runtime guard"));
  check("volatile block states primary safety goal", block.includes("avoid overwriting, deleting, or rolling back modifications already written to disk by another pi session"));
  check("volatile block says it is not instruction override", block.includes("not an override of user instructions"));
  check("volatile block has bounded markers", block.includes("<!-- pi-astack/multi-instance: volatile peer guard snapshot -->") && block.includes("<!-- /pi-astack/multi-instance -->"));
}

mod.resetMultiInstanceStateForTests();
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  // Best effort.
}

console.log(`\nfailures: ${failures.length}`);
if (failures.length) process.exit(1);
console.log("PASS — multi-instance smoke passed.");
process.exit(0);
