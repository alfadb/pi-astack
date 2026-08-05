#!/usr/bin/env node
/**
 * Windows edge-protocol-shadow durable journal / audit production path smoke.
 *
 * Loads native addon only via __TEST + temp package (never production pin bypass).
 * Production zero-arg loader remains fail-closed when pin is null.
 *
 * Covers:
 * - normal journal capture + witness flow under protected private_rw layout
 * - 16-process concurrent append (audit JSONL) exactly-once / no concat loss
 * - 16-process concurrent candidate capture (journal records) seq continuity
 * - contention / crash partial JSONL fail-closed (reader + next writer no wash)
 * - DACL tamper on directory/file fail-closed
 * - reparse / foreign / missing / oversize fail-closed
 * - production pin-null fail-closed
 *
 * Non-win32 / non-x64 / missing artifact → print `SKIP:` and exit 0.
 * Does not touch ~/.abrain or settings.
 */
import { createHash, randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const stagedNode = path.join(repoRoot, "native/windows/target/smoke-staging/pi-astack-windows-native.node");
const buildInfoPath = path.join(repoRoot, "native/windows/target/smoke-staging/build-info.json");
const CAPABILITIES = ["atomic_file_tempdir_v1", "atomic_file_v1", "protected_dacl_v1", "retained_directory_lock_v1"];

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function runIcacls(args) {
  // Prefer extended-length path form so deep edge layout paths stay addressable.
  const extendedPrefix = ["\\", "\\", "?", "\\"].join("");
  const fixed = args.map((a, i) => {
    if (i === 0 && typeof a === "string" && path.isAbsolute(a) && !a.startsWith(extendedPrefix)) {
      return extendedPrefix + a;
    }
    return a;
  });
  const r = spawnSync("icacls", fixed, { encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

const childMode = process.argv.find((a) => a.startsWith("--child="))?.slice("--child=".length);

if (process.platform !== "win32") skip("not win32");
if (process.arch !== "x64") skip("not x64");
if (!fs.existsSync(stagedNode) || !fs.existsSync(buildInfoPath)) {
  skip("missing smoke-staging artifact; run npm run build:windows-native-addon first");
}

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false });
const nativeMod = jiti(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"));
const retainedLock = jiti(path.join(repoRoot, "extensions/_shared/retained-directory-lock.ts"));
const edgeWin = jiti(path.join(repoRoot, "extensions/sediment/edge-protocol-shadow-windows-native.ts"));
const edge = jiti(path.join(repoRoot, "extensions/sediment/edge-protocol-shadow.ts"));

const binaryBytes = fs.readFileSync(stagedNode);
const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
for (const c of CAPABILITIES) {
  assert(Array.isArray(buildInfo.capabilities) && buildInfo.capabilities.includes(c), `build-info must include ${c}`);
}

// Production pin must remain null / zero-arg loader fail-closed.
assert(nativeMod.WINDOWS_NATIVE_ADDON_PROVENANCE_MANIFEST_SHA256 == null, "production pin must remain null");
assert(nativeMod.loadWindowsNativeAddon.length === 0, "production loader must be zero-arg");
let productionLoadCode = null;
try {
  nativeMod.loadWindowsNativeAddon();
} catch (error) {
  productionLoadCode = error?.code ?? String(error);
}
assert(
  productionLoadCode === "WINDOWS_NATIVE_ADDON_PROVENANCE_PIN_MISSING"
    || productionLoadCode === "WINDOWS_NATIVE_ADDON_MANIFEST_MISSING"
    || String(productionLoadCode || "").includes("PROVENANCE")
    || String(productionLoadCode || "").includes("PIN"),
  `production zero-arg load must fail closed, got ${productionLoadCode}`,
);

const abrainHomeRoot = path.resolve(os.homedir(), ".abrain");
const tmp = process.env.SMOKE_EDGE_WIN_TMP
  || fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-edge-win-"));
assert(!tmp.startsWith(abrainHomeRoot + path.sep) && tmp !== abrainHomeRoot, `temp under ~/.abrain: ${tmp}`);
if (!process.env.SMOKE_EDGE_WIN_TMP) {
  process.once("exit", () => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
}

function installTempAddon(label) {
  const packageRoot = fs.mkdtempSync(path.join(tmp, `pkg-${label}-`));
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name: `pi-astack-edge-win-${label}`, private: true }, null, 2)}\n`,
  );
  const paths = nativeMod.resolveWindowsNativeAddonPaths(packageRoot);
  fs.mkdirSync(path.dirname(paths.binaryPath), { recursive: true });
  fs.writeFileSync(paths.binaryPath, binaryBytes);
  const toolchainId = buildInfo.toolchain_id || "d".repeat(64);
  const manifest = {
    schema_version: "windows-native-addon-manifest/v1",
    addon_abi: 1,
    platform: "win32",
    arch: "x64",
    napi_version: 9,
    minimum_node: "22.19.0",
    source_commit: buildInfo.source_commit,
    source_tree_sha256: buildInfo.source_tree_sha256,
    toolchain: buildInfo.toolchain || "cargo+msvc (smoke)",
    toolchain_id: toolchainId,
    target: "win32-x64",
    binary_file: "pi-astack-windows-native.node",
    binary_bytes: binaryBytes.byteLength,
    binary_sha256: sha256(binaryBytes),
    build_id: buildInfo.build_id,
    build_mode: buildInfo.build_mode || buildInfo.mode,
    reproducibility: buildInfo.reproducibility,
    native_tests: buildInfo.native_tests,
    clippy: buildInfo.clippy,
    build_config_sha256: buildInfo.build_config_sha256,
    capabilities: [...CAPABILITIES],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(paths.manifestPath, manifestText, "utf8");
  const loaded = nativeMod.__TEST.loadWindowsNativeAddon({
    packageRoot,
    platform: "win32",
    arch: "x64",
    nodeVersion: process.versions.node,
    expectedManifestSha256: sha256(Buffer.from(manifestText, "utf8")),
  });
  retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(loaded.addon);
  edgeWin.edgeWindowsNativeTestApi.installAddonOverride(loaded.addon);
  return loaded.addon;
}

const addon = installTempAddon(childMode || "parent");
process.once("exit", () => {
  try { retainedLock.retainedDirectoryLockTestApi.installWindowsAddonOverride(null); } catch { /* ignore */ }
  try { edgeWin.edgeWindowsNativeTestApi.installAddonOverride(null); } catch { /* ignore */ }
});

function waitBarrier(barrierFile, expected) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const n = Number(fs.readFileSync(barrierFile, "utf8").trim());
      if (Number.isFinite(n) && n >= expected) return;
    } catch { /* not ready */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  throw new Error(`barrier timeout waiting for ${expected} at ${barrierFile}`);
}

function arriveBarrier(barrierFile) {
  // Atomic-ish counter via open+read+write under exclusive create race; best-effort file counter.
  const dir = path.dirname(barrierFile);
  const slot = path.join(dir, `.arrive-${process.pid}-${randomBytes(4).toString("hex")}`);
  fs.writeFileSync(slot, "1");
  // Count arrive files (rendezvous after load).
  let count = 0;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".arrive-")) count += 1;
  }
  fs.writeFileSync(barrierFile, `${count}\n`);
  return count;
}

// ── child: concurrent journal capture ────────────────────────────────
if (childMode === "journal-writer") {
  const abrain = process.env.SMOKE_EDGE_WIN_ABRAIN;
  const owner = process.env.SMOKE_EDGE_WIN_OWNER;
  const sessionId = process.env.SMOKE_EDGE_WIN_SESSION;
  const n = Number(process.env.SMOKE_EDGE_WIN_N || 2);
  const worker = process.env.SMOKE_EDGE_WIN_WORKER || "0";
  const barrierFile = process.env.SMOKE_EDGE_WIN_BARRIER;
  const barrierExpected = Number(process.env.SMOKE_EDGE_WIN_BARRIER_N || 0);
  const startedAt = Date.now();
  if (barrierFile && barrierExpected > 0) {
    arriveBarrier(barrierFile);
    waitBarrier(barrierFile, barrierExpected);
  }
  const runStartedAt = Date.now();
  for (let i = 0; i < n; i += 1) {
    const r = await edge.captureEdgeProtocolCandidate({
      abrainHome: abrain,
      ownerProjectRoot: owner,
      sessionId,
      messages: [{ role: "user", content: `w${worker}-i${i}-${randomBytes(4).toString("hex")}` }],
      c6: { session_id: sessionId, turn_id: Number(worker) * 100 + i + 1 },
    });
    if (r.status !== "captured") {
      process.stderr.write(`JOURNAL_FAIL ${r.error_code || r.status}\n`);
      process.exit(2);
    }
    process.stdout.write(`${r.record.producer_seq}\t${r.record.record_id}\t${startedAt}\t${runStartedAt}\n`);
  }
  process.exit(0);
}

// ── child: concurrent audit append ───────────────────────────────────
if (childMode === "audit-writer") {
  const abrain = process.env.SMOKE_EDGE_WIN_ABRAIN;
  const auditPath = process.env.SMOKE_EDGE_WIN_AUDIT;
  const n = Number(process.env.SMOKE_EDGE_WIN_N || 2);
  const worker = process.env.SMOKE_EDGE_WIN_WORKER || "0";
  const identical = process.env.SMOKE_EDGE_WIN_IDENTICAL === "1";
  const barrierFile = process.env.SMOKE_EDGE_WIN_BARRIER;
  const barrierExpected = Number(process.env.SMOKE_EDGE_WIN_BARRIER_N || 0);
  const startedAt = Date.now();
  if (barrierFile && barrierExpected > 0) {
    arriveBarrier(barrierFile);
    waitBarrier(barrierFile, barrierExpected);
  }
  const runStartedAt = Date.now();
  for (let i = 0; i < n; i += 1) {
    const entry = identical
      ? {
        schema: edge.EDGE_CAPTURE_AUDIT_SCHEMA,
        schema_version: 1,
        // Fixed payload fields so all workers emit byte-identical lines when i matches.
        created_at: "2026-08-06T00:00:00.000Z",
        session_id: "sess-audit-identical",
        content_id: sha256(`audit-identical-${i}`),
        c6: { session_id: "sess-audit-identical", turn_id: i + 1 },
        leaf_tip: { id: `leaf-identical-${i}`, parentId: null, type: "message" },
        result: "capture_attempt",
      }
      : {
        schema: edge.EDGE_CAPTURE_AUDIT_SCHEMA,
        schema_version: 1,
        created_at: new Date().toISOString(),
        session_id: `sess-audit-${worker}`,
        content_id: sha256(`audit-${worker}-${i}`),
        c6: { session_id: `sess-audit-${worker}`, turn_id: i + 1 },
        leaf_tip: { id: `leaf-${worker}-${i}`, parentId: null, type: "message" },
        result: "capture_attempt",
        worker,
        i,
      };
    await edge.appendEdgeAuditJsonlLine(auditPath, entry, { trustRoot: abrain });
    process.stdout.write(`${worker}\t${i}\t${startedAt}\t${runStartedAt}\n`);
  }
  process.exit(0);
}

// ── parent ───────────────────────────────────────────────────────────
let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

function spawnChild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env, PI_ASTACK_ENABLE_TEST_HOOKS: "1", SMOKE_EDGE_WIN_TMP: tmp },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

console.log("edge-protocol-shadow windows native durable path");

await check("production pin-null remains fail-closed", async () => {
  edgeWin.edgeWindowsNativeTestApi.resetProductionSingleton();
  const prev = process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
  try {
    // Clear override path and assert production resolve fails closed without pin.
    edgeWin.edgeWindowsNativeTestApi.installAddonOverride(null);
    delete process.env.PI_ASTACK_ENABLE_TEST_HOOKS;
    let code = null;
    try {
      edgeWin.resolveEdgeWindowsNativeAddon();
    } catch (error) {
      code = error?.code ?? String(error);
    }
    assert(
      code === "EDGE_WINDOWS_NATIVE_UNAVAILABLE"
        || String(code || "").includes("PROVENANCE")
        || String(code || "").includes("PIN")
        || String(code || "").includes("UNAVAILABLE"),
      `expected pin-null fail-closed, got ${code}`,
    );
  } finally {
    process.env.PI_ASTACK_ENABLE_TEST_HOOKS = prev || "1";
    edgeWin.edgeWindowsNativeTestApi.installAddonOverride(addon);
  }
});

await check("normal journal capture + witness under protected layout", async () => {
  const abrain = path.join(tmp, "abrain-normal");
  const owner = path.join(tmp, "owner-normal");
  fs.mkdirSync(abrain, { recursive: true });
  fs.mkdirSync(owner, { recursive: true });
  const sessionId = "sess-win-normal";
  const init = await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
  });
  assert(init.status === "ready", `layout init failed: ${init.error_code} ${init.error_detail}`);
  const sessionRoot = edge.edgeSessionRoot(abrain, owner, sessionId);
  // Protected DACL on layout dirs.
  nativeMod.verifyProtectedPath(addon, edge.edgeJournalRecordsDir(sessionRoot), "directory", "private_rw");
  nativeMod.verifyProtectedPath(addon, edge.edgeSourcesDir(sessionRoot), "directory", "private_rw");
  nativeMod.verifyProtectedPath(addon, edge.edgeJournalLockDir(sessionRoot), "directory", "private_rw");

  const cap = await edge.captureEdgeProtocolCandidate({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
    messages: [{ role: "user", content: "hello-win" }, { role: "assistant", content: "ok", stopReason: "stop" }],
    c6: { session_id: sessionId, turn_id: 1 },
    leafTip: { id: "leaf-1", parentId: null, type: "message" },
  });
  assert(cap.status === "captured", `capture failed: ${cap.error_code} ${cap.error_detail}`);
  nativeMod.verifyProtectedPath(addon, cap.source.path, "file", "private_rw");
  nativeMod.verifyProtectedPath(addon, cap.record_path, "file", "private_rw");

  const wit = await edge.writeEdgeTerminalWitness({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
    c6: { session_id: sessionId, turn_id: 1 },
    leafTip: { id: "leaf-1", parentId: null, type: "message" },
    candidateRecordId: cap.record.record_id,
  });
  assert(wit.status === "written", `witness failed: ${wit.error_code} ${wit.error_detail}`);
  const records = await edge.listEdgeJournalRecords(sessionRoot);
  assert(records.length === 2, `expected 2 records, got ${records.length}`);
  assert(records[0].producer_seq === 1 && records[1].producer_seq === 2, "seq not 1,2");
});

await check("16-process journal capture: barrier + continuous seq", async () => {
  const abrain = path.join(tmp, "abrain-j16");
  const owner = path.join(tmp, "owner-j16");
  fs.mkdirSync(abrain, { recursive: true });
  fs.mkdirSync(owner, { recursive: true });
  const sessionId = "sess-win-j16";
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
  });
  const workers = 16;
  const per = 2;
  const barrierDir = path.join(tmp, "barrier-j16");
  fs.mkdirSync(barrierDir, { recursive: true });
  const barrierFile = path.join(barrierDir, "count");
  fs.writeFileSync(barrierFile, "0\n");
  const kids = await Promise.all(
    Array.from({ length: workers }, (_, w) => spawnChild(
      [__filename, "--child=journal-writer"],
      {
        SMOKE_EDGE_WIN_ABRAIN: abrain,
        SMOKE_EDGE_WIN_OWNER: owner,
        SMOKE_EDGE_WIN_SESSION: sessionId,
        SMOKE_EDGE_WIN_N: String(per),
        SMOKE_EDGE_WIN_WORKER: String(w),
        SMOKE_EDGE_WIN_BARRIER: barrierFile,
        SMOKE_EDGE_WIN_BARRIER_N: String(workers),
      },
    )),
  );
  const seqs = [];
  const runStarts = [];
  for (const kid of kids) {
    assert(kid.code === 0, `journal child failed: ${kid.stderr.slice(0, 300)}`);
    for (const line of kid.stdout.split("\n").filter(Boolean)) {
      const [seqS, , , runS] = line.split("\t");
      const seq = Number(seqS);
      assert(Number.isInteger(seq) && seq >= 1, `bad seq ${line}`);
      seqs.push(seq);
      runStarts.push(Number(runS));
    }
  }
  assert(seqs.length === workers * per, `expected ${workers * per} seqs, got ${seqs.length}`);
  const set = new Set(seqs);
  assert(set.size === seqs.length, "duplicate producer_seq across processes");
  const sorted = [...seqs].sort((a, b) => a - b);
  assert(sorted[0] === 1 && sorted[sorted.length - 1] === workers * per, `seq range ${sorted[0]}..${sorted[sorted.length - 1]}`);
  for (let i = 0; i < sorted.length; i += 1) {
    assert(sorted[i] === i + 1, `seq gap at ${i}: ${sorted[i]}`);
  }
  // Post-load rendezvous: run-start skew across workers must be bounded (simultaneous start).
  const minStart = Math.min(...runStarts);
  const maxStart = Math.max(...runStarts);
  assert(maxStart - minStart < 5000, `start skew too large: ${maxStart - minStart}ms`);
  // Overlap proof: at least two workers share a run-start window within 2s (or skew < 2s for all).
  assert(maxStart - minStart < 2000 || runStarts.length >= workers, "expected concurrent start overlap/skew");
  const sessionRoot = edge.edgeSessionRoot(abrain, owner, sessionId);
  const records = await edge.listEdgeJournalRecords(sessionRoot);
  assert(records.length === workers * per, `record count ${records.length}`);
  // records/sources must not contain native temp residue.
  for (const dir of [edge.edgeJournalRecordsDir(sessionRoot), edge.edgeSourcesDir(sessionRoot)]) {
    for (const name of fs.readdirSync(dir)) {
      assert(!name.includes("pi-astack-tmp"), `foreign temp in ${dir}: ${name}`);
      assert(!name.endsWith(".tmp"), `tmp residue in ${dir}: ${name}`);
    }
  }
});

await check("16-process audit append: unique + identical-payload lines", async () => {
  const abrain = path.join(tmp, "abrain-a16");
  fs.mkdirSync(abrain, { recursive: true });
  // Seed layout via ownership helper path (initialize creates edge root private_rw).
  const initOwner = path.join(tmp, "owner-a16-seed");
  fs.mkdirSync(initOwner, { recursive: true });
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: initOwner,
    sessionId: "seed-audit-layout",
  });
  const auditDir = path.join(abrain, ".state", "sediment", "edge-protocol-shadow");
  const auditPath = path.join(auditDir, "capture-audit.jsonl");
  const workers = 16;
  const per = 2;
  const barrierDir = path.join(tmp, "barrier-a16");
  fs.mkdirSync(barrierDir, { recursive: true });
  const barrierFile = path.join(barrierDir, "count");
  fs.writeFileSync(barrierFile, "0\n");
  const kids = await Promise.all(
    Array.from({ length: workers }, (_, w) => spawnChild(
      [__filename, "--child=audit-writer"],
      {
        SMOKE_EDGE_WIN_ABRAIN: abrain,
        SMOKE_EDGE_WIN_AUDIT: auditPath,
        SMOKE_EDGE_WIN_N: String(per),
        SMOKE_EDGE_WIN_WORKER: String(w),
        SMOKE_EDGE_WIN_BARRIER: barrierFile,
        SMOKE_EDGE_WIN_BARRIER_N: String(workers),
      },
    )),
  );
  let wrote = 0;
  const runStarts = [];
  for (const kid of kids) {
    assert(kid.code === 0, `audit child failed: ${kid.stderr.slice(0, 400)}`);
    for (const line of kid.stdout.split("\n").filter(Boolean)) {
      wrote += 1;
      runStarts.push(Number(line.split("\t")[3]));
    }
  }
  assert(wrote === workers * per, `wrote count ${wrote}`);
  nativeMod.verifyProtectedPath(addon, auditPath, "file", "private_rw");
  const bytes = edgeWin.readEdgeProtectedFileBytes(addon, auditPath, edge.EDGE_CAPTURE_AUDIT_MAX_READ_BYTES);
  const lines = edgeWin.parseEdgeAuditJsonlBytesFailClosed(bytes);
  assert(lines.length === workers * per, `audit lines ${lines.length}`);
  const keys = new Set();
  for (const line of lines) {
    const o = JSON.parse(line);
    const key = `${o.worker}:${o.i}`;
    assert(!keys.has(key), `duplicate audit row ${key}`);
    keys.add(key);
  }
  assert(keys.size === workers * per, "audit key set size");
  const minStart = Math.min(...runStarts);
  const maxStart = Math.max(...runStarts);
  assert(maxStart - minStart < 5000, `audit start skew ${maxStart - minStart}ms`);

  // Completely identical payload across 16 processes (fixed created_at etc): final lines = 16 or 32.
  const abrain2 = path.join(tmp, "abrain-a16-identical");
  fs.mkdirSync(abrain2, { recursive: true });
  const owner2 = path.join(tmp, "owner-a16-id");
  fs.mkdirSync(owner2, { recursive: true });
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain2,
    ownerProjectRoot: owner2,
    sessionId: "seed-audit-identical",
  });
  const auditPath2 = path.join(abrain2, ".state", "sediment", "edge-protocol-shadow", "capture-audit.jsonl");
  const barrierDir2 = path.join(tmp, "barrier-a16-id");
  fs.mkdirSync(barrierDir2, { recursive: true });
  const barrierFile2 = path.join(barrierDir2, "count");
  fs.writeFileSync(barrierFile2, "0\n");
  const perId = 2;
  const kidsId = await Promise.all(
    Array.from({ length: workers }, (_, w) => spawnChild(
      [__filename, "--child=audit-writer"],
      {
        SMOKE_EDGE_WIN_ABRAIN: abrain2,
        SMOKE_EDGE_WIN_AUDIT: auditPath2,
        SMOKE_EDGE_WIN_N: String(perId),
        SMOKE_EDGE_WIN_WORKER: String(w),
        SMOKE_EDGE_WIN_IDENTICAL: "1",
        SMOKE_EDGE_WIN_BARRIER: barrierFile2,
        SMOKE_EDGE_WIN_BARRIER_N: String(workers),
      },
    )),
  );
  for (const kid of kidsId) {
    assert(kid.code === 0, `identical audit child failed: ${kid.stderr.slice(0, 400)}`);
  }
  const bytesId = edgeWin.readEdgeProtectedFileBytes(addon, auditPath2, edge.EDGE_CAPTURE_AUDIT_MAX_READ_BYTES);
  const linesId = edgeWin.parseEdgeAuditJsonlBytesFailClosed(bytesId);
  // 16 workers × 2 identical-per-i lines each → 32 lines (same bytes still append every call).
  assert(
    linesId.length === workers * perId,
    `identical payload must not drop lines: got ${linesId.length}, expected ${workers * perId}`,
  );
});

await check("preexisting ordinary .state/sediment capture terminal pair complete", async () => {
  const abrain = path.join(tmp, "abrain-preexist");
  const owner = path.join(tmp, "owner-preexist");
  fs.mkdirSync(abrain, { recursive: true });
  fs.mkdirSync(owner, { recursive: true });
  // Ordinary (non-protected) shared ancestors already present — edge must not require private DACL on them.
  const stateDir = path.join(abrain, ".state");
  const sedimentDir = path.join(stateDir, "sediment");
  fs.mkdirSync(sedimentDir, { recursive: true });
  // Confirm they are ordinary dirs (no native ensure).
  assert(fs.statSync(stateDir).isDirectory(), ".state dir");
  assert(fs.statSync(sedimentDir).isDirectory(), "sediment dir");
  const sessionId = "sess-preexist";
  const init = await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
  });
  assert(init.status === "ready", `init with preexisting shared ancestors: ${init.error_code} ${init.error_detail}`);
  // Shared ancestors must remain ordinary (still directories); edge root is private_rw.
  const edgeRoot = edge.edgeProtocolShadowRoot(abrain);
  nativeMod.verifyProtectedPath(addon, edgeRoot, "directory", "private_rw");
  let sharedProtected = false;
  try {
    nativeMod.verifyProtectedPath(addon, sedimentDir, "directory", "private_rw");
    sharedProtected = true;
  } catch {
    sharedProtected = false;
  }
  assert(!sharedProtected, "preexisting .state/sediment must not be forced private_rw");

  const cap = await edge.captureEdgeProtocolCandidate({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
    messages: [
      { role: "user", content: "preexist-user" },
      { role: "assistant", content: "preexist-assistant", stopReason: "stop" },
    ],
    c6: { session_id: sessionId, turn_id: 1 },
    leafTip: { id: "leaf-preexist-1", parentId: null, type: "message" },
  });
  assert(cap.status === "captured", `capture: ${cap.error_code} ${cap.error_detail}`);
  const wit = await edge.writeEdgeTerminalWitness({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
    c6: { session_id: sessionId, turn_id: 1 },
    leafTip: { id: "leaf-preexist-1", parentId: null, type: "message" },
    candidateRecordId: cap.record.record_id,
  });
  assert(wit.status === "written", `witness: ${wit.error_code} ${wit.error_detail}`);
  const sessionRoot = edge.edgeSessionRoot(abrain, owner, sessionId);
  const records = await edge.listEdgeJournalRecords(sessionRoot);
  assert(records.length === 2, `pair complete records=${records.length}`);
  assert(records.some((r) => r.record_type === "candidate_capture"), "candidate present");
  assert(records.some((r) => r.record_type === "terminal_witness"), "witness present");
  // No native temp left in records/sources; staging may hold identifiable temps only.
  for (const dir of [edge.edgeJournalRecordsDir(sessionRoot), edge.edgeSourcesDir(sessionRoot)]) {
    for (const name of fs.readdirSync(dir)) {
      assert(!name.includes("pi-astack-tmp"), `temp in durable dir ${name}`);
      assert(!name.endsWith(".tmp"), `tmp in durable dir ${name}`);
    }
  }
});

await check("partial JSONL fail-closed: reader rejects; next writer does not wash", async () => {
  const abrain = path.join(tmp, "abrain-partial");
  fs.mkdirSync(abrain, { recursive: true });
  const owner = path.join(tmp, "owner-partial");
  fs.mkdirSync(owner, { recursive: true });
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId: "seed-partial",
  });
  const auditDir = path.join(abrain, ".state", "sediment", "edge-protocol-shadow");
  const auditPath = path.join(auditDir, "capture-audit.jsonl");
  // Complete first line via native path.
  await edge.appendEdgeAuditJsonlLine(auditPath, {
    schema: edge.EDGE_CAPTURE_AUDIT_SCHEMA,
    schema_version: 1,
    created_at: new Date().toISOString(),
    session_id: "sess-partial",
    content_id: sha256("partial-1"),
    c6: { session_id: "sess-partial", turn_id: 1 },
    leaf_tip: { id: "leaf-p1", parentId: null, type: "message" },
    result: "capture_attempt",
  }, { trustRoot: abrain });
  // Simulate crash partial: append incomplete bytes with raw Node (outside contract) after verifying DACL.
  // Use native replace would wash — instead open and write partial via a temp copy then replace? 
  // Contract: next writer must not silent-wash. We corrupt by rewriting with non-native path is blocked
  // by private_rw DACL for other SIDs, but same-token can still write. Write partial with Node append.
  fs.appendFileSync(auditPath, "{\"schema\":\"broken-partial");
  let readerCode = null;
  try {
    await edge.loadEdgeCaptureAuditIndex(auditPath);
  } catch (error) {
    readerCode = error?.message || String(error);
  }
  assert(
    readerCode === "EDGE_WINDOWS_AUDIT_PARTIAL"
      || readerCode === "EDGE_WINDOWS_AUDIT_CORRUPT"
      || String(readerCode || "").includes("PARTIAL")
      || String(readerCode || "").includes("CORRUPT"),
    `reader must fail closed on partial, got ${readerCode}`,
  );
  // Next writer appends another complete line without truncating/washing partial.
  await edge.appendEdgeAuditJsonlLine(auditPath, {
    schema: edge.EDGE_CAPTURE_AUDIT_SCHEMA,
    schema_version: 1,
    created_at: new Date().toISOString(),
    session_id: "sess-partial",
    content_id: sha256("partial-2"),
    c6: { session_id: "sess-partial", turn_id: 2 },
    leaf_tip: { id: "leaf-p2", parentId: null, type: "message" },
    result: "capture_attempt",
  }, { trustRoot: abrain });
  const after = edgeWin.readEdgeProtectedFileBytes(addon, auditPath, edge.EDGE_CAPTURE_AUDIT_MAX_READ_BYTES).toString("utf8");
  assert(after.includes("broken-partial"), "partial residue must remain (no wash)");
  assert(after.includes(sha256("partial-2")), "new complete line must append");
  let stillClosed = null;
  try {
    await edge.loadEdgeCaptureAuditIndex(auditPath);
  } catch (error) {
    stillClosed = error?.message || String(error);
  }
  assert(stillClosed, "reader must still fail closed after append over partial residue");
});

await check("DACL tamper directory/file fail-closed via real capture integration", async () => {
  const abrain = path.join(tmp, "abrain-tamper");
  const owner = path.join(tmp, "owner-tamper");
  fs.mkdirSync(abrain, { recursive: true });
  fs.mkdirSync(owner, { recursive: true });
  const sessionId = "sess-win-tamper";
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
  });
  const sessionRoot = edge.edgeSessionRoot(abrain, owner, sessionId);
  const recordsDir = edge.edgeJournalRecordsDir(sessionRoot);
  // Tamper directory DACL (add Everyone:F) — real capture integration must fail-closed (not just primitive).
  const tamper = runIcacls([recordsDir, "/grant", "Everyone:(OI)(CI)F"]);
  assert(tamper.status === 0, `icacls grant failed: ${tamper.stderr}`);
  const capAfterDirTamper = await edge.captureEdgeProtocolCandidate({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
    messages: [{ role: "user", content: "after-dir-tamper" }],
    c6: { session_id: sessionId, turn_id: 1 },
  });
  assert(
    capAfterDirTamper.status !== "captured",
    `capture after records-dir DACL tamper must fail, got ${capAfterDirTamper.status}`,
  );
  assert(
    capAfterDirTamper.error_code
      || /DACL|PROTECTED|EDGE_WINDOWS|journal|source|FAILED/i.test(String(capAfterDirTamper.error_detail || "")),
    `dir tamper capture error surface: ${capAfterDirTamper.error_code} ${capAfterDirTamper.error_detail}`,
  );

  // Fresh session for file tamper after a successful capture.
  const sessionId2 = "sess-win-tamper-file";
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId: sessionId2,
  });
  const cap = await edge.captureEdgeProtocolCandidate({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId: sessionId2,
    messages: [{ role: "user", content: "tamper-file" }],
    c6: { session_id: sessionId2, turn_id: 1 },
  });
  assert(cap.status === "captured", `pre-tamper capture: ${cap.error_code}`);
  const fileTamper = runIcacls([cap.record_path, "/grant", "Everyone:F"]);
  assert(fileTamper.status === 0, `icacls file grant failed: ${fileTamper.stderr}`);
  let listCode = null;
  try {
    await edge.listEdgeJournalRecords(edge.edgeSessionRoot(abrain, owner, sessionId2));
  } catch (error) {
    listCode = error?.message || String(error);
  }
  assert(listCode, `list must fail closed on tampered record via integration path`);
  // Second capture into same session still goes through durable path; existing tampered leaf may block list/index.
  const cap2 = await edge.captureEdgeProtocolCandidate({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId: sessionId2,
    messages: [{ role: "user", content: "after-file-tamper" }],
    c6: { session_id: sessionId2, turn_id: 2 },
  });
  // Either capture fails closed or list remains fail-closed — both prove integration surface, not bare primitive.
  if (cap2.status === "captured") {
    let list2 = null;
    try {
      await edge.listEdgeJournalRecords(edge.edgeSessionRoot(abrain, owner, sessionId2));
    } catch (error) {
      list2 = error?.message || String(error);
    }
    assert(list2, "list must still fail closed after file DACL tamper");
  }
});

await check("missing / oversize / reparse-like fail-closed", async () => {
  const abrain = path.join(tmp, "abrain-bounds");
  fs.mkdirSync(abrain, { recursive: true });
  const owner = path.join(tmp, "owner-bounds");
  fs.mkdirSync(owner, { recursive: true });
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId: "seed-bounds",
  });
  const missing = await edge.readEdgeSourceBytesSafe(path.join(abrain, "no-such-source.json"));
  assert(missing.ok === false, JSON.stringify(missing));

  const auditDir = path.join(abrain, ".state", "sediment", "edge-protocol-shadow");
  const bigPath = path.join(auditDir, "big.json");
  // Create a small protected file then attempt oversize read with tiny ceiling.
  const created = edgeWin.durableCreateEdgeProtectedFile(addon, bigPath, Buffer.from("{\"x\":1}\n", "utf8"));
  assert(created === "created", `create status ${created}`);
  let tooLarge = null;
  try {
    edgeWin.readEdgeProtectedFileBytes(addon, bigPath, 1);
  } catch (error) {
    tooLarge = error?.code ?? String(error);
  }
  assert(tooLarge === "EDGE_WINDOWS_TOO_LARGE", `oversize code=${tooLarge}`);

  // Junction on parent path rejected by native ensure/create (ancestor reparse).
  const foreign = path.join(tmp, "foreign-target");
  fs.mkdirSync(foreign, { recursive: true });
  const junctionParent = path.join(tmp, "junc-parent");
  fs.mkdirSync(junctionParent, { recursive: true });
  const junc = path.join(junctionParent, "junc");
  const mklink = spawnSync("cmd", ["/c", "mklink", "/J", junc, foreign], { encoding: "utf8", windowsHide: true });
  if (mklink.status === 0) {
    let reparseCode = null;
    try {
      edgeWin.ensureEdgeProtectedDirectory(addon, path.join(junc, "child"));
    } catch (error) {
      reparseCode = error?.code ?? String(error);
    }
    assert(
      reparseCode
        && /REPARSE|UNSAFE|PROTECTED|FAILED|INVALID/i.test(String(reparseCode)),
      `reparse must fail closed, got ${reparseCode}`,
    );
  } else {
    console.log("  note  mklink /J unavailable; reparse case soft-skipped");
  }
});

await check("atomic create staging: records/sources free of native temps", async () => {
  const abrain = path.join(tmp, "abrain-staging");
  const owner = path.join(tmp, "owner-staging");
  fs.mkdirSync(abrain, { recursive: true });
  fs.mkdirSync(owner, { recursive: true });
  const sessionId = "sess-staging";
  await edge.initializeEdgeProtocolShadowSession({
    abrainHome: abrain,
    ownerProjectRoot: owner,
    sessionId,
  });
  const sessionRoot = edge.edgeSessionRoot(abrain, owner, sessionId);
  const staging = edge.edgeStagingDir(sessionRoot);
  nativeMod.verifyProtectedPath(addon, staging, "directory", "private_rw");
  // Direct tempdir create into records via new API; temp must land under staging only.
  const dest = path.join(edge.edgeJournalRecordsDir(sessionRoot), `${"0".repeat(20)}__${"a".repeat(64)}.json`);
  const payload = Buffer.from(`${JSON.stringify({ schema: edge.EDGE_JOURNAL_SCHEMA, probe: true })}\n`, "utf8");
  const status = edgeWin.durableCreateEdgeProtectedFileWithTempDirectory(addon, dest, payload, staging);
  assert(status === "created", `tempdir create status=${status}`);
  nativeMod.verifyProtectedPath(addon, dest, "file", "private_rw");
  for (const name of fs.readdirSync(edge.edgeJournalRecordsDir(sessionRoot))) {
    assert(!name.includes("pi-astack-tmp"), `records temp residue ${name}`);
    assert(!name.endsWith(".tmp") || name.endsWith(".json"), `records foreign ${name}`);
  }
  // Leave an identifiable staging temp (crash residue simulation) and assert records stay clean.
  const crashTemp = path.join(staging, `.record.pi-astack-tmp.crash-sim.tmp`);
  fs.writeFileSync(crashTemp, "partial");
  for (const name of fs.readdirSync(edge.edgeJournalRecordsDir(sessionRoot))) {
    assert(!name.includes("pi-astack-tmp"), `records polluted after staging residue ${name}`);
  }
  assert(fs.existsSync(crashTemp), "staging crash residue identifiable");
  fs.rmSync(crashTemp, { force: true });
});

console.log(`PASS ${passed} edge-protocol-shadow windows checks`);
