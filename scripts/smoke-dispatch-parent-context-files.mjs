#!/usr/bin/env node
/**
 * Smoke: parent contextFiles snapshot inheritance for dispatch sub-agents.
 *
 * Covers:
 *   - capture from systemPromptOptions.contextFiles (not disk re-scan)
 *   - order + body preserved via agentsFilesOverride
 *   - noContextFiles:true + projectTrusted:false retained
 *   - parallel fan-out shares one immutable snapshot
 *   - empty array legal; missing rejects
 *   - sub-agent role clarification (AGENTS.md caller vs worker)
 *   - session/runtime isolation still independent loaders
 *   - audit fields expose digest/paths/bytes only (no bodies)
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import {
  createAgentSession,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dispatchPath = path.join(repoRoot, "extensions/dispatch/index.ts");
const parentCtxPath = path.join(repoRoot, "extensions/dispatch/parent-context-files.ts");
const workflowPath = path.join(repoRoot, "extensions/workflow/index.ts");
const dispatchSource = fs.readFileSync(dispatchPath, "utf8");
const parentCtxSource = fs.readFileSync(parentCtxPath, "utf8");
const workflowSource = fs.readFileSync(workflowPath, "utf8");

const jiti = createJiti(import.meta.url);
const dispatch = await jiti.import(dispatchPath);
const parentCtx = await jiti.import(parentCtxPath);
const causal = await jiti.import(path.join(repoRoot, "extensions/_shared/causal-anchor.ts"));

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error instanceof Error ? error.message : String(error)}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

console.log("dispatch parent contextFiles snapshot inheritance");

// ── Structural pins ─────────────────────────────────────────────

await check("source: capture from systemPromptOptions.contextFiles in before_agent_start", () => {
  assert(
    /pi\.on\(\s*"before_agent_start"[\s\S]{0,500}?isSubAgentSession[\s\S]{0,300}?captureParentContextFilesSnapshot[\s\S]{0,200}?systemPromptOptions\?\.contextFiles/.test(dispatchSource),
    "dispatch must capture parent contextFiles from event.systemPromptOptions in before_agent_start, gated for sub-agents",
  );
  assert(
    !/loadProjectContextFiles|readFileSync\([^)]*AGENTS/.test(
      dispatchSource.match(/export async function createSubAgentSessionResources[\s\S]*?\n}\n\n/)?.[0] ?? "",
    ),
    "createSubAgentSessionResources must not re-scan AGENTS.md from disk",
  );
});

await check("source: runInProcess rejects missing snapshot, accepts empty array", () => {
  assert(
    /context_files_snapshot_missing/.test(dispatchSource),
    "missing snapshot must use failureType context_files_snapshot_missing",
  );
  assert(
    /isParentContextFilesSnapshot\(parentContextFiles\)/.test(dispatchSource),
    "runInProcess must gate on isParentContextFilesSnapshot",
  );
  assert(
    /parent_context_files_snapshot_missing/.test(dispatchSource),
    "error message must name the missing-snapshot contract",
  );
});

await check("source: agentsFilesOverride injects snapshot under noContextFiles:true", () => {
  const block = dispatchSource.match(/export async function createSubAgentSessionResources[\s\S]*?await resourceLoader\.reload\(\);/)?.[0] ?? "";
  assert(/noContextFiles:\s*true/.test(block), "noContextFiles:true required");
  assert(/projectTrusted:\s*false/.test(block), "projectTrusted:false required");
  assert(/noExtensions:\s*false/.test(block), "noExtensions:false required");
  assert(/agentsFilesOverride/.test(block), "agentsFilesOverride required");
  assert(/parentContextFiles\.map/.test(block), "override must map the provided snapshot");
});

await check("source: dispatch_agent / dispatch_parallel / workflow thread snapshot", () => {
  assert(
    /const parentContextFiles = resolveParentContextFilesSnapshot\(parentAnchor\)/.test(dispatchSource),
    "dispatch tools must resolve the turn-scoped snapshot",
  );
  // parallel resolves once before fan-out
  assert(
    /Parent contextFiles snapshot is also resolved ONCE/.test(dispatchSource)
      || /every parallel\s+task receives the same immutable/.test(dispatchSource),
    "parallel fan-out must document single shared snapshot",
  );
  assert(
    /parentContextFiles,/.test(dispatchSource),
    "parentContextFiles must be passed into runInProcess call sites",
  );
  assert(
    /resolveParentContextFilesSnapshot/.test(workflowSource)
      && /parentContextFiles/.test(workflowSource),
    "workflow production runner must resolve and pass parentContextFiles",
  );
});

await check("source: role clarification extends boundary sentinel; AGENTS.md untouched", () => {
  assert(
    /bindSubAgentRoleClarification\(pi\)/.test(dispatchSource),
    "sentinel factory must bind role clarification",
  );
  assert(
    /子代理角色澄清/.test(dispatchSource)
      && /不得再次派发/.test(dispatchSource)
      && /调用方（主会话）/.test(dispatchSource),
    "role clarification must explain caller vs worker",
  );
  assert(
    /SUBAGENT_ROLE_CLARIFICATION_MARKER/.test(dispatchSource),
    "role clarification marker must be defined for idempotent inject",
  );
  const agentsMd = fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "AGENTS.md"), "utf8");
  assert(
    !/pi-astack\/dispatch: sub-agent role clarification/.test(agentsMd),
    "AGENTS.md must remain extension-agnostic (no dispatch role marker)",
  );
});

await check("source: audit records digest/paths/bytes only", () => {
  assert(/parentContextFilesAuditFields/.test(dispatchSource), "audit must use parentContextFilesAuditFields");
  assert(
    /parent_context_files_digest/.test(parentCtxSource)
      && /parent_context_files_paths/.test(parentCtxSource)
      && /parent_context_files_byte_counts/.test(parentCtxSource),
    "audit meta must expose digest/paths/byte counts",
  );
  assert(
    !/parent_context_files_content|files:\s*snapshot|content:\s*file\.content/.test(
      parentCtxSource.match(/export function parentContextFilesAuditFields[\s\S]*?\n}/)?.[0] ?? "",
    ),
    "audit fields must not include file bodies",
  );
  // Hard pin: parent-context-files module has no capacity/trim/summarize/model-swap logic
  assert(
    !/maxTokens|tokenBudget|summarize|truncateContext|swapModel/.test(parentCtxSource),
    "parent-context-files must not implement capacity/trim/summarize/model-swap",
  );
});

// ── Behavioral unit checks ──────────────────────────────────────

parentCtx._resetParentContextFilesForTests();
causal._resetCausalAnchorForTests();

await check("normalize: empty array is legal; non-array is missing", () => {
  const empty = parentCtx.normalizeParentContextFiles([]);
  assert(Array.isArray(empty) && empty.length === 0, "empty array normalizes to empty snapshot");
  assert(parentCtx.isParentContextFilesSnapshot(empty), "empty is a valid snapshot");
  assert(parentCtx.normalizeParentContextFiles(undefined) === undefined, "undefined → missing");
  assert(parentCtx.normalizeParentContextFiles(null) === undefined, "null → missing");
  assert(parentCtx.normalizeParentContextFiles("x") === undefined, "string → missing");
});

await check("isParentContextFilesSnapshot rejects malformed arrays (not Array.isArray-only)", () => {
  assert(parentCtx.isParentContextFilesSnapshot([]) === true, "empty array legal");
  assert(
    parentCtx.isParentContextFilesSnapshot([{ path: "/a.md", content: "ok" }]) === true,
    "well-formed entry legal",
  );
  // Frozen not required for the type guard.
  assert(
    parentCtx.isParentContextFilesSnapshot([{ path: "/a.md", content: "ok" }]) === true,
    "unfrozen well-formed still legal",
  );
  assert(parentCtx.isParentContextFilesSnapshot(undefined) === false, "undefined rejected");
  assert(parentCtx.isParentContextFilesSnapshot(null) === false, "null rejected");
  assert(parentCtx.isParentContextFilesSnapshot("x") === false, "string rejected");
  assert(
    parentCtx.isParentContextFilesSnapshot([{ path: "/a.md", content: "ok" }, "nope"]) === false,
    "string entry rejected",
  );
  assert(
    parentCtx.isParentContextFilesSnapshot([{ path: "/a.md", content: "ok" }, null]) === false,
    "null entry rejected",
  );
  assert(
    parentCtx.isParentContextFilesSnapshot([{ path: 1, content: "x" }]) === false,
    "non-string path rejected",
  );
  assert(
    parentCtx.isParentContextFilesSnapshot([{ path: "/a.md", content: 2 }]) === false,
    "non-string content rejected",
  );
  assert(
    parentCtx.isParentContextFilesSnapshot([{ path: "/a.md" }]) === false,
    "missing content rejected",
  );
  assert(
    parentCtx.isParentContextFilesSnapshot([["/a.md", "body"]]) === false,
    "array entry rejected",
  );
});

await check("normalize: preserves order and body", () => {
  const snap = parentCtx.normalizeParentContextFiles([
    { path: "/a/AGENTS.md", content: "first-body" },
    { path: "/b/AGENTS.md", content: "second-body" },
  ]);
  assert(snap.length === 2, "two files");
  assert(snap[0].path === "/a/AGENTS.md" && snap[0].content === "first-body", "first entry preserved");
  assert(snap[1].path === "/b/AGENTS.md" && snap[1].content === "second-body", "second entry preserved");
  assert(Object.isFrozen(snap) && Object.isFrozen(snap[0]), "snapshot is frozen/immutable");
});

await check("normalize: strict — bad entries fail closed (no skip/coercion)", () => {
  assert(
    parentCtx.normalizeParentContextFiles([{ path: "/a.md", content: "ok" }, "nope"]) === undefined,
    "non-object entry → missing",
  );
  assert(
    parentCtx.normalizeParentContextFiles([{ path: "/a.md", content: "ok" }, null]) === undefined,
    "null entry → missing",
  );
  assert(
    parentCtx.normalizeParentContextFiles([{ path: 1, content: "x" }]) === undefined,
    "non-string path → missing",
  );
  assert(
    parentCtx.normalizeParentContextFiles([{ path: "/a.md", content: 2 }]) === undefined,
    "non-string content → missing",
  );
  assert(
    parentCtx.normalizeParentContextFiles([{ path: "/a.md" }]) === undefined,
    "missing content → missing (no empty-string fill)",
  );
  assert(
    parentCtx.normalizeParentContextFiles([{ content: "x" }]) === undefined,
    "missing path → missing (no empty-string fill)",
  );
  assert(
    parentCtx.normalizeParentContextFiles([["/a.md", "body"]]) === undefined,
    "array entry → missing",
  );
  // Mixed good+bad still fails entirely — no partial silent drop.
  assert(
    parentCtx.normalizeParentContextFiles([
      { path: "/good.md", content: "keep" },
      { path: "/bad.md", content: null },
    ]) === undefined,
    "one bad entry invalidates whole snapshot",
  );
});

await check("capture/resolve by parent session/turn; parallel shares same ref", () => {
  parentCtx._resetParentContextFilesForTests();
  causal._setCurrentAnchorForTests("sess-ctx-1", 3);
  const anchor = { session_id: "sess-ctx-1", turn_id: 3 };
  const raw = [
    { path: "/virtual/one.md", content: "ONE" },
    { path: "/virtual/two.md", content: "TWO" },
  ];
  const captured = parentCtx.captureParentContextFilesSnapshot(anchor, raw);
  assert(captured && captured.length === 2, "capture returns snapshot");
  const a = parentCtx.resolveParentContextFilesSnapshot(anchor);
  const b = parentCtx.resolveParentContextFilesSnapshot({ session_id: "sess-ctx-1", turn_id: 3 });
  assert(a === captured && b === captured, "resolve returns same immutable reference");
  assert(
    parentCtx.resolveParentContextFilesSnapshot({ session_id: "sess-ctx-1", turn_id: 2 }) === undefined,
    "different turn must not resolve",
  );
  assert(
    parentCtx.resolveParentContextFilesSnapshot(undefined) === undefined,
    "missing anchor → missing snapshot",
  );
});

await check("turn_id: Number.isFinite integer >=0 for capture and resolve (NaN/Infinity/fraction)", () => {
  parentCtx._resetParentContextFilesForTests();
  const raw = [{ path: "/t.md", content: "T" }];
  assert(parentCtx.isValidParentContextTurnId(0) === true, "0 legal");
  assert(parentCtx.isValidParentContextTurnId(3) === true, "3 legal");
  assert(parentCtx.isValidParentContextTurnId(NaN) === false, "NaN rejected");
  assert(parentCtx.isValidParentContextTurnId(Infinity) === false, "Infinity rejected");
  assert(parentCtx.isValidParentContextTurnId(-Infinity) === false, "-Infinity rejected");
  assert(parentCtx.isValidParentContextTurnId(1.5) === false, "fraction rejected");
  assert(parentCtx.isValidParentContextTurnId(-1) === false, "negative rejected");
  assert(parentCtx.isValidParentContextTurnId("3") === false, "string rejected");

  assert(
    parentCtx.captureParentContextFilesSnapshot({ session_id: "s", turn_id: NaN }, raw) === undefined,
    "capture NaN no-op",
  );
  assert(
    parentCtx.captureParentContextFilesSnapshot({ session_id: "s", turn_id: Infinity }, raw) === undefined,
    "capture Infinity no-op",
  );
  assert(
    parentCtx.captureParentContextFilesSnapshot({ session_id: "s", turn_id: 1.5 }, raw) === undefined,
    "capture fraction no-op",
  );
  assert(parentCtx._parentContextFilesStoreSizeForTests() === 0, "invalid turn_id must not store");

  // Seed a valid record, then prove resolve rejects non-finite / non-integer ids.
  const ok = parentCtx.captureParentContextFilesSnapshot({ session_id: "s", turn_id: 1 }, raw);
  assert(ok && ok.length === 1, "valid capture works");
  assert(
    parentCtx.resolveParentContextFilesSnapshot({ session_id: "s", turn_id: NaN }) === undefined,
    "resolve NaN missing",
  );
  assert(
    parentCtx.resolveParentContextFilesSnapshot({ session_id: "s", turn_id: Infinity }) === undefined,
    "resolve Infinity missing",
  );
  assert(
    parentCtx.resolveParentContextFilesSnapshot({ session_id: "s", turn_id: 1.5 }) === undefined,
    "resolve fraction missing",
  );
  assert(
    parentCtx.resolveParentContextFilesSnapshot({ session_id: "s", turn_id: 1 })?.[0]?.content === "T",
    "resolve integer still works",
  );
});

await check("audit meta: digest/paths/bytes; no content", () => {
  const snap = parentCtx.freezeParentContextFilesSnapshot([
    { path: "/p/a.md", content: "alpha" },
    { path: "/p/b.md", content: "beta!" },
  ]);
  const meta = parentCtx.describeParentContextFilesSnapshot(snap);
  assert(typeof meta.digest === "string" && meta.digest.length === 64, "sha256 digest");
  assert(meta.paths[0] === "/p/a.md" && meta.paths[1] === "/p/b.md", "paths ordered");
  assert(meta.byteCounts[0] === Buffer.byteLength("alpha") && meta.byteCounts[1] === Buffer.byteLength("beta!"), "byte counts");
  assert(meta.totalBytes === meta.byteCounts[0] + meta.byteCounts[1], "totalBytes");
  const fields = parentCtx.parentContextFilesAuditFields(snap);
  assert(fields.parent_context_files_present === true, "present flag");
  assert(fields.parent_context_files_digest === meta.digest, "digest field");
  assert(!("content" in fields) && !JSON.stringify(fields).includes("alpha"), "no body in audit fields");
  const missingFields = parentCtx.parentContextFilesAuditFields(undefined);
  assert(missingFields.parent_context_files_present === false, "missing flagged");
});

await check("source: required parentContextFiles + executionContext + toolAllowlist shape", () => {
  assert(
    /parentContextFiles:\s*ParentContextFilesSnapshot/.test(dispatchSource),
    "SubAgentExecutionContext.parentContextFiles must be required",
  );
  assert(
    !/parentContextFiles\?:\s*ParentContextFilesSnapshot/.test(dispatchSource),
    "parentContextFiles must not remain optional on the execution context",
  );
  assert(
    /toolAllowlist:\s*string\s*\|\s*undefined/.test(dispatchSource),
    "toolAllowlist must be string | undefined so executionContext can be required",
  );
  assert(
    /executionContext:\s*SubAgentExecutionContext/.test(dispatchSource),
    "runInProcess last param must be required executionContext",
  );
  assert(
    /parentContextFiles:\s*ParentContextFilesSnapshot/.test(
      dispatchSource.match(/export type SubAgentSessionResourceOptions[\s\S]*?\n\};/)?.[0] ?? "",
    ),
    "createSubAgentSessionResources options.parentContextFiles must be required",
  );
});

await check("source: effectiveCwd threads projectRoot into resources/session/cwd", () => {
  assert(/const effectiveCwd = executionContext\?\.projectRoot \?\? process\.cwd\(\)/.test(dispatchSource), "effectiveCwd once");
  assert(/createSubAgentSessionResources\(\{\s*cwd:\s*effectiveCwd,\s*parentContextFiles,/.test(dispatchSource), "resources get effectiveCwd");
  assert(/SessionManager\.inMemory\(effectiveCwd\)/.test(dispatchSource), "SessionManager uses effectiveCwd");
  assert(/createAgentSession\(\{\s*cwd:\s*effectiveCwd,/.test(dispatchSource), "createAgentSession uses effectiveCwd");
});

await check("source: main session_shutdown clears snapshots; sub-agent does not", () => {
  assert(/clearParentContextFilesSnapshotsForSession/.test(dispatchSource), "cleanup API wired");
  assert(
    /pi\.on\(\s*"session_shutdown"[\s\S]{0,600}?isSubAgentSession[\s\S]{0,500}?clearParentContextFilesSnapshotsForSession/.test(dispatchSource),
    "session_shutdown must gate on isSubAgentSession before clearing",
  );
});

await check("runInProcess rejects missing parentContextFiles (no session created)", async () => {
  parentCtx._resetParentContextFilesForTests();
  const result = await dispatch.runInProcess(
    "openai/gpt-test",
    "off",
    "hello",
    new AbortController().signal,
    1000,
    { getAvailable: () => [], find: () => undefined },
    undefined,
    // intentionally omit parentContextFiles (JS/any runtime path)
    { projectRoot: process.cwd() },
  );
  assert(result.failureType === "context_files_snapshot_missing", `expected missing failure, got ${result.failureType}: ${result.error}`);
  assert(/parent_context_files_snapshot_missing/.test(result.error ?? ""), "error text");
});

await check("runInProcess rejects malformed parentContextFiles array (no provider)", async () => {
  parentCtx._resetParentContextFilesForTests();
  const result = await dispatch.runInProcess(
    "openai/gpt-test",
    "off",
    "hello",
    new AbortController().signal,
    1000,
    { getAvailable: () => [], find: () => undefined },
    undefined,
    {
      projectRoot: process.cwd(),
      // array shape but invalid entries — must not call provider
      parentContextFiles: [{ path: "/a.md", content: 123 }],
    },
  );
  assert(
    result.failureType === "context_files_snapshot_missing",
    `expected context_files_snapshot_missing, got ${result.failureType}: ${result.error}`,
  );
});

await check("createSubAgentSessionResources throws on malformed parentContextFiles", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ctx-bad-"));
  let threw = null;
  try {
    await dispatch.createSubAgentSessionResources({
      cwd: tempRoot,
      parentContextFiles: [{ path: "/a.md", content: 99 }],
    });
  } catch (err) {
    threw = err;
  }
  assert(threw instanceof Error, "must throw Error");
  assert(
    /parent_context_files_snapshot_invalid/.test(threw.message),
    `error must include parent_context_files_snapshot_invalid, got: ${threw.message}`,
  );

  let threwMissing = null;
  try {
    await dispatch.createSubAgentSessionResources({ cwd: tempRoot });
  } catch (err) {
    threwMissing = err;
  }
  assert(threwMissing instanceof Error, "missing snapshot must throw");
  assert(
    /parent_context_files_snapshot_invalid/.test(threwMissing.message),
    "missing must use parent_context_files_snapshot_invalid marker",
  );
});

await check("clearParentContextFilesSnapshotsForSession removes only that session", () => {
  parentCtx._resetParentContextFilesForTests();
  parentCtx.captureParentContextFilesSnapshot(
    { session_id: "sess-A", turn_id: 1 },
    [{ path: "/a.md", content: "A1" }],
  );
  parentCtx.captureParentContextFilesSnapshot(
    { session_id: "sess-A", turn_id: 2 },
    [{ path: "/a2.md", content: "A2" }],
  );
  parentCtx.captureParentContextFilesSnapshot(
    { session_id: "sess-B", turn_id: 1 },
    [{ path: "/b.md", content: "B1" }],
  );
  assert(parentCtx._parentContextFilesStoreSizeForTests() === 3, "three records before clear");
  const removed = parentCtx.clearParentContextFilesSnapshotsForSession("sess-A");
  assert(removed === 2, `expected 2 removed, got ${removed}`);
  assert(parentCtx._parentContextFilesStoreSizeForTests() === 1, "sess-B remains");
  assert(
    parentCtx.resolveParentContextFilesSnapshot({ session_id: "sess-A", turn_id: 1 }) === undefined,
    "sess-A turn 1 cleared",
  );
  assert(
    parentCtx.resolveParentContextFilesSnapshot({ session_id: "sess-B", turn_id: 1 })?.[0]?.content === "B1",
    "sess-B intact",
  );
  // empty / non-string sessionId is a no-op
  assert(parentCtx.clearParentContextFilesSnapshotsForSession("") === 0, "empty sessionId no-op");
  assert(parentCtx.clearParentContextFilesSnapshotsForSession(null) === 0, "null sessionId no-op");
});

await check("createSubAgentSessionResources injects ordered snapshot via agentsFilesOverride", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ctx-files-"));
  const snapshot = parentCtx.freezeParentContextFilesSnapshot([
    { path: path.join(tempRoot, "first.md"), content: "# First\nrule-A" },
    { path: path.join(tempRoot, "second.md"), content: "# Second\nrule-B" },
  ]);
  // Empty disk AGENTS so a disk re-scan would NOT produce these paths.
  const { resourceLoader } = await dispatch.createSubAgentSessionResources({
    cwd: tempRoot,
    parentContextFiles: snapshot,
  });
  const loaded = resourceLoader.getAgentsFiles().agentsFiles;
  assert(loaded.length === 2, `expected 2 injected files, got ${loaded.length}`);
  assert(loaded[0].path === snapshot[0].path && loaded[0].content === snapshot[0].content, "first file order+body");
  assert(loaded[1].path === snapshot[1].path && loaded[1].content === snapshot[1].content, "second file order+body");
});

await check("non-empty snapshot wins over disk AGENTS.md (resourceLoader sees only snapshot)", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ctx-disk-vs-snap-"));
  // Real on-disk AGENTS.md must NOT leak into the loader when a non-empty
  // parent snapshot is supplied (noContextFiles + agentsFilesOverride).
  fs.writeFileSync(
    path.join(tempRoot, "AGENTS.md"),
    "# disk-only-must-not-load\ndisk-secret-marker\n",
    "utf8",
  );
  const snapshot = parentCtx.freezeParentContextFilesSnapshot([
    { path: "/parent/virtual/AGENTS.md", content: "# from-parent-snapshot\nsnapshot-only-marker\n" },
  ]);
  const { resourceLoader } = await dispatch.createSubAgentSessionResources({
    cwd: tempRoot,
    parentContextFiles: snapshot,
  });
  const loaded = resourceLoader.getAgentsFiles().agentsFiles;
  assert(loaded.length === 1, `expected only snapshot file, got ${loaded.length}`);
  assert(loaded[0].path === snapshot[0].path, "path must be snapshot path, not disk");
  assert(loaded[0].content === snapshot[0].content, "body must be snapshot body");
  assert(!loaded[0].content.includes("disk-secret-marker"), "disk AGENTS.md body must not appear");
  assert(
    !loaded.some((f) => typeof f.content === "string" && f.content.includes("disk-secret-marker")),
    "no loaded file may contain disk-only marker",
  );
  assert(
    !loaded.some((f) => typeof f.path === "string" && f.path === path.join(tempRoot, "AGENTS.md")),
    "disk AGENTS.md path must not be in agentsFiles",
  );
});

await check("createSubAgentSessionResources empty snapshot injects zero files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ctx-empty-"));
  // Place a real AGENTS.md on disk — must NOT be loaded (noContextFiles + empty override).
  fs.writeFileSync(path.join(tempRoot, "AGENTS.md"), "# should-not-load\n", "utf8");
  const { resourceLoader } = await dispatch.createSubAgentSessionResources({
    cwd: tempRoot,
    parentContextFiles: parentCtx.freezeParentContextFilesSnapshot([]),
  });
  const loaded = resourceLoader.getAgentsFiles().agentsFiles;
  assert(loaded.length === 0, `empty snapshot must inject zero files, got ${loaded.length}`);
});

await check("independent loaders: two resources do not share loader/runtime", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ctx-iso-"));
  const snapA = parentCtx.freezeParentContextFilesSnapshot([{ path: "/a.md", content: "A" }]);
  const snapB = parentCtx.freezeParentContextFilesSnapshot([{ path: "/b.md", content: "B" }]);
  const resA = await dispatch.createSubAgentSessionResources({ cwd: tempRoot, parentContextFiles: snapA });
  const resB = await dispatch.createSubAgentSessionResources({ cwd: tempRoot, parentContextFiles: snapB });
  assert(resA.resourceLoader !== resB.resourceLoader, "loaders must be distinct");
  assert(resA.settingsManager !== resB.settingsManager, "settings managers must be distinct");
  assert(resA.resourceLoader.getAgentsFiles().agentsFiles[0].content === "A", "loader A snapshot");
  assert(resB.resourceLoader.getAgentsFiles().agentsFiles[0].content === "B", "loader B snapshot");
});

await check("role clarification is injected by sub-agent sentinel before_agent_start", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-role-"));
  const handlers = [];
  const fakePi = {
    on(event, handler) {
      handlers.push({ event, handler });
    },
  };
  dispatch.bindSubAgentRoleClarification(fakePi);
  const bas = handlers.filter((h) => h.event === "before_agent_start");
  assert(bas.length === 1, "one before_agent_start role handler");
  const out = bas[0].handler({ systemPrompt: "BASE" });
  assert(out && typeof out.systemPrompt === "string", "returns systemPrompt patch");
  assert(out.systemPrompt.includes("BASE"), "preserves prior prompt");
  assert(out.systemPrompt.includes("子代理角色澄清"), "includes role block");
  assert(out.systemPrompt.includes("不得再次派发"), "forbids re-dispatch");
  assert(out.systemPrompt.includes("调用方（主会话）"), "clarifies caller");
  // idempotent
  const out2 = bas[0].handler({ systemPrompt: out.systemPrompt });
  assert(out2 === undefined || out2.systemPrompt === undefined, "second inject is no-op");
  void tempRoot;
});

await check("capture excludes sub-agent path via isSubAgentSession gate (source + behavior)", () => {
  // Behavioral: capture only when anchor is main-session shaped; sub-agent
  // execute path uses resolve from parent anchor, never re-capture from
  // sub-agent systemPromptOptions.
  assert(
    /if \(isSubAgentSession\(ctx as \{ sessionManager\?: unknown \}\)\) return;[\s\S]{0,80}?captureParentContextFilesSnapshot/.test(dispatchSource),
    "capture handler must return early for sub-agent sessions",
  );
  assert(
    /ctx == null \|\| typeof ctx !== "object" \|\| Array\.isArray\(ctx\)/.test(dispatchSource)
      && /sessionManager == null \|\| typeof sessionManager !== "object"/.test(dispatchSource),
    "capture handler must fail closed when ctx missing/not object/no sessionManager",
  );
  assert(
    /fail closed/.test(dispatchSource)
      && /we still create the sub-agent session but/.test(dispatchSource) === false,
    "dispatch_agent comment must document fail-closed (not create-session-on-missing-anchor)",
  );
});

await check("capture handler behavior: bad ctx skips; legal main captures", () => {
  parentCtx._resetParentContextFilesForTests();
  causal._setCurrentAnchorForTests("sess-capture-ctx", 7);

  const registered = [];
  const fakePi = {
    on(event, handler) {
      registered.push({ event, handler });
    },
    registerTool() {},
  };
  dispatch.default(fakePi);
  // Handlers are compiled; identify by probing: only the capture path mutates the store.
  const basHandlers = registered.filter((h) => h.event === "before_agent_start");
  assert(basHandlers.length >= 1, "before_agent_start handlers registered");

  const event = {
    systemPromptOptions: {
      contextFiles: [{ path: "/from-parent.md", content: "PARENT-BODY" }],
    },
  };

  // Probe each handler with bad ctx first — store must stay empty.
  for (const h of basHandlers) {
    h.handler(event, undefined);
    h.handler(event, null);
    h.handler(event, "not-object");
    h.handler(event, []);
    h.handler(event, {});
    h.handler(event, { sessionManager: null });
    h.handler(event, { sessionManager: "string" });
  }
  assert(
    parentCtx._parentContextFilesStoreSizeForTests() === 0,
    "malformed/missing ctx must not capture",
  );

  // Re-pin anchor: other before_agent_start handlers (causal-anchor lifecycle)
  // may advance turn_id when probed with non-sub-agent shapes.
  causal._setCurrentAnchorForTests("sess-capture-ctx", 7);
  parentCtx._resetParentContextFilesForTests();

  // Legal main-session ctx (unmarked sessionManager object) must capture.
  const mainSm = { __main: true };
  for (const h of basHandlers) {
    h.handler(event, { sessionManager: mainSm });
  }
  const live = causal.getCurrentAnchor?.() ?? { session_id: "sess-capture-ctx", turn_id: 7 };
  const resolved = parentCtx.resolveParentContextFilesSnapshot(live)
    ?? parentCtx.resolveParentContextFilesSnapshot({
      session_id: "sess-capture-ctx",
      turn_id: 7,
    });
  assert(resolved && resolved.length === 1, "legal main ctx must capture");
  assert(resolved[0].content === "PARENT-BODY", "captured body from systemPromptOptions");
});

await check("capture handler: sub-agent sessionManager skips overwrite", async () => {
  parentCtx._resetParentContextFilesForTests();
  causal._setCurrentAnchorForTests("sess-sub-skip", 2);

  const registered = [];
  const fakePi = {
    on(event, handler) { registered.push({ event, handler }); },
    registerTool() {},
  };
  dispatch.default(fakePi);
  const basHandlers = registered.filter((h) => h.event === "before_agent_start");

  const mainEvent = {
    systemPromptOptions: {
      contextFiles: [{ path: "/main.md", content: "MAIN" }],
    },
  };
  const mainSm = { __role: "main" };
  for (const h of basHandlers) h.handler(mainEvent, { sessionManager: mainSm });
  const before = parentCtx.resolveParentContextFilesSnapshot({
    session_id: "sess-sub-skip",
    turn_id: 2,
  });
  assert(before?.[0]?.content === "MAIN", "main capture seed");

  const { markSessionAsSubAgent } = await jiti.import(
    path.join(repoRoot, "extensions/_shared/pi-internals.ts"),
  );
  const subSm = { __role: "sub" };
  markSessionAsSubAgent(subSm);
  const subEvent = {
    systemPromptOptions: {
      contextFiles: [{ path: "/sub.md", content: "SUB-SHOULD-NOT-CAPTURE" }],
    },
  };
  for (const h of basHandlers) h.handler(subEvent, { sessionManager: subSm });
  const after = parentCtx.resolveParentContextFilesSnapshot({
    session_id: "sess-sub-skip",
    turn_id: 2,
  });
  assert(after?.[0]?.content === "MAIN", "sub-agent must not overwrite parent snapshot");
  assert(after?.[0]?.path === "/main.md", "parent path preserved");
});

// Optional: createAgentSession with injected files actually surfaces them in
// getAgentsFiles (already covered above via resourceLoader). Soft session create
// without model/network:
await check("session-owned resources still construct with injected context files", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-ctx-session-"));
  const snapshot = parentCtx.freezeParentContextFilesSnapshot([
    { path: "/virtual/AGENTS.md", content: "# Guidelines\n- be precise" },
  ]);
  const { settingsManager, resourceLoader } = await dispatch.createSubAgentSessionResources({
    cwd: tempRoot,
    parentContextFiles: snapshot,
  });
  const sm = SessionManager.inMemory(tempRoot);
  // mark as sub-agent so boundary sentinel is happy if session_start fires
  const { markSessionAsSubAgent } = await jiti.import(path.join(repoRoot, "extensions/_shared/pi-internals.ts"));
  markSessionAsSubAgent(sm);
  const { session } = await createAgentSession({
    cwd: tempRoot,
    settingsManager,
    resourceLoader,
    sessionManager: sm,
  });
  try {
    const files = resourceLoader.getAgentsFiles().agentsFiles;
    assert(files.length === 1 && files[0].content.includes("be precise"), "session sees injected context");
  } finally {
    await dispatch.disposeSubAgentSession(session, sm);
  }
});

console.log();
if (failures.length === 0) {
  console.log(`✅ dispatch parent contextFiles: all ${passed} checks passed`);
  process.exit(0);
}
console.error(`❌ dispatch parent contextFiles: ${failures.length} failure(s) out of ${passed + failures.length}`);
for (const f of failures) {
  console.error(`  - ${f.name}: ${f.error instanceof Error ? f.error.message : f.error}`);
}
process.exit(1);
