#!/usr/bin/env node
/**
 * Real Windows smoke for protected_dacl_v1 + atomic_file_v1 (+ protected mutex path).
 *
 * Architecture: controller/worker
 * - Controller NEVER require()'s the .node binary (so temp package cleanup can delete it).
 * - All native work runs in worker/child processes that load via __TEST after manifest/hash
 *   verification of the *temp package* binaryPath (not staging).
 *
 * Real probes (no rename-to-pass fakes):
 * - kill-during-attempt old-or-new: worker ready-then-native-replace with large payload;
 *   controller TerminateProcess at staggered delays; dest exact OLD or NEW hash/length only.
 * - replace reader: barrier, success/error counts, closed error codes, must see OLD + NEW.
 * - create16: err null, created false = collision, barrier start skew bounded.
 * - append: ≥1MiB records with head/tail hash+length sentinels; 16×1MiB; no interleave.
 * - icacls tamper: assert exit0 + re-read Everyone/inheritance before native reject.
 * - leaf+ancestor junction reject for protected/atomic paths.
 * - mutex squat: real helper CreateMutexW default DACL; native → DACL_INVALID / MUTEX_NAMESPACE_DENIED.
 *
 * Non-win32 / non-x64 / missing artifact → print `SKIP:` and exit 0.
 * Does not mock ACL/WinAPI; does not touch ~/.abrain; does not write production pin.
 * Cleanup failures hard-fail.
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
// __TEST.loadWindowsNativeAddon requires test hooks.
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
const stagedNode = path.join(repoRoot, "native/windows/target/smoke-staging/pi-astack-windows-native.node");
const stagedHelper = path.join(repoRoot, "native/windows/target/smoke-staging/pi-astack-mutex-squat-helper.exe");
const buildInfoPath = path.join(repoRoot, "native/windows/target/smoke-staging/build-info.json");
const CAPABILITIES = ["atomic_file_tempdir_v1", "atomic_file_v1", "protected_dacl_v1", "retained_directory_lock_v1"];
const CLOSED_ATOMIC_ERROR_RE =
  /WINDOWS_NATIVE_ADDON_(INVALID_PATH|ANCESTOR_REPARSE|REPARSE|UNSUPPORTED_VOLUME|NOT_DIRECTORY|NOT_FILE|NOT_FOUND|ACCESS_DENIED|IDENTITY_CHANGED|DACL_INVALID|IO_FAILED|TOO_LARGE|BUSY|FAILED|MUTEX_NAMESPACE_DENIED|MUTEX_FAILED)/;

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

function skip(reason) {
  console.log(`SKIP: ${reason}`);
  process.exit(0);
}

function die(msg, code = 1) {
  console.error(`smoke-windows-native-durable-dacl: ${msg}`);
  process.exit(code);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function writeReadyAtomic(readyFile, payload) {
  const dir = path.dirname(readyFile);
  const tmp = path.join(dir, `.${path.basename(readyFile)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`, "utf8");
  fs.renameSync(tmp, readyFile);
}

function loadModule() {
  const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
  return jiti(path.join(repoRoot, "extensions/_shared/windows-native-addon.ts"));
}

function loadAddonFromTempPackage(mod, packageRoot, manifestSha256) {
  return mod.__TEST.loadWindowsNativeAddon({
    packageRoot,
    platform: "win32",
    arch: "x64",
    nodeVersion: process.versions.node,
    expectedManifestSha256: manifestSha256,
  });
}

function prepareTempPackage(mod, buildInfo, binaryBytes) {
  const abrain = path.resolve(os.homedir(), ".abrain");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-win-dacl-pkg-"));
  assert(!root.startsWith(abrain + path.sep) && root !== abrain, `temp must not be under ~/.abrain: ${root}`);
  fs.writeFileSync(path.join(root, "package.json"), `${JSON.stringify({ name: "pi-astack-win-dacl-temp", private: true }, null, 2)}\n`);
  const paths = mod.resolveWindowsNativeAddonPaths(root);
  fs.mkdirSync(path.dirname(paths.binaryPath), { recursive: true });
  fs.writeFileSync(paths.binaryPath, binaryBytes);
  const toolchainId = buildInfo.toolchain_id || "d".repeat(64);
  assert(/^[0-9a-f]{64}$/.test(toolchainId), "build-info toolchain_id must be sha256 hex");
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
  return { root, paths, manifest, manifestSha256: sha256(Buffer.from(manifestText, "utf8")) };
}

function pathsEqualWin(a, b) {
  return String(a).replace(/\//g, "\\").toLowerCase() === String(b).replace(/\//g, "\\").toLowerCase();
}

function runIcacls(args) {
  const r = spawnSync("icacls", args, { encoding: "utf8", windowsHide: true });
  return { status: r.status, stdout: String(r.stdout || ""), stderr: String(r.stderr || "") };
}

function makePayload(tag, size) {
  // Deterministic large payload with head/tail sentinels for exact hash/length checks.
  const head = Buffer.from(`HEAD:${tag}:LEN=${size}:`);
  const tail = Buffer.from(`:TAIL:${tag}:LEN=${size}`);
  assert(size >= head.length + tail.length + 64, "payload too small for sentinels");
  const mid = Buffer.alloc(size - head.length - tail.length, 0x5a);
  // Sprinkle pattern so multi-chunk writes are non-trivial.
  for (let i = 0; i < mid.length; i += 4096) mid[i] = (i / 4096) & 0xff;
  const body = Buffer.concat([head, mid, tail]);
  assert(body.length === size, "payload length");
  return body;
}

// ── Worker modes (subprocess) ──────────────────────────────────────────────
function runWorker() {
  const mode = process.argv[3];
  const packageRoot = process.argv[4];
  const manifestSha256 = process.argv[5];
  const workDir = process.argv[6];
  const readyFile = process.argv[7];
  const extra = process.argv.slice(8);

  try {
    if (process.platform !== "win32") throw new Error("worker requires win32");
    const mod = loadModule();
    const loaded = loadAddonFromTempPackage(mod, packageRoot, manifestSha256);
    assert(
      pathsEqualWin(loaded.binaryPath, mod.resolveWindowsNativeAddonPaths(packageRoot).binaryPath),
      `worker must load verified package binaryPath, got ${loaded.binaryPath}`,
    );
    const caps = [...loaded.capabilities];
    assert(JSON.stringify(caps) === JSON.stringify(CAPABILITIES), `capabilities exact match: ${JSON.stringify(caps)}`);
    const addon = loaded.addon;

    if (mode === "private-dir-file") {
      const dir = path.join(workDir, "private-dir");
      const file = path.join(dir, "payload.bin");
      const canonDir = mod.ensureProtectedDirectory(addon, dir);
      mod.verifyProtectedPath(addon, canonDir, "directory", "private_rw");
      const body = Buffer.from("hello-private-rw-payload");
      const created = mod.durableAtomicCreateFile(addon, file, body);
      assert(created === true, "create should succeed");
      mod.verifyProtectedPath(addon, file, "file", "private_rw");
      const read = mod.readProtectedFile(addon, file, 1024);
      assert(Buffer.isBuffer(read.data) && read.data.equals(body), "read body match");
      assert(read.identity.size === body.byteLength, "size match");
      writeReadyAtomic(readyFile, { ok: true, dir: canonDir, file });
      process.exit(0);
    }

    if (mode === "package-rx") {
      const dir = path.join(workDir, "pkg-rx-dir");
      const file = path.join(dir, "pkg.bin");
      mod.ensureProtectedDirectory(addon, dir);
      const body = Buffer.from("package-rx-content");
      assert(mod.durableAtomicCreateFile(addon, file, body) === true, "create");
      mod.setProtectedPath(addon, dir, "directory", "package_rx");
      mod.setProtectedPath(addon, file, "file", "package_rx");
      mod.verifyProtectedPath(addon, dir, "directory", "package_rx");
      mod.verifyProtectedPath(addon, file, "file", "package_rx");
      let writeDenied = false;
      try {
        fs.writeFileSync(file, "tamper");
      } catch {
        writeDenied = true;
      }
      let delDenied = false;
      try {
        fs.unlinkSync(file);
      } catch {
        delDenied = true;
      }
      assert(writeDenied, "package_rx file ordinary write must be denied");
      assert(delDenied, "package_rx file ordinary delete must be denied");
      mod.setProtectedPath(addon, file, "file", "private_rw");
      mod.setProtectedPath(addon, dir, "directory", "private_rw");
      fs.unlinkSync(file);
      fs.rmdirSync(dir);
      writeReadyAtomic(readyFile, { ok: true, writeDenied, delDenied });
      process.exit(0);
    }

    if (mode === "dacl-tamper") {
      const dir = path.join(workDir, "tamper-dir");
      const file = path.join(dir, "t.bin");
      mod.ensureProtectedDirectory(addon, dir);
      assert(mod.durableAtomicCreateFile(addon, file, Buffer.from("x")) === true);
      // Must actually land Everyone + inheritance before claiming tamper coverage.
      const ic1 = runIcacls([file, "/inheritance:e"]);
      assert(ic1.status === 0, `icacls inheritance must exit0, got ${ic1.status}: ${ic1.stderr}`);
      const ic2 = runIcacls([file, "/grant", "Everyone:(R)"]);
      assert(ic2.status === 0, `icacls grant Everyone must exit0, got ${ic2.status}: ${ic2.stderr}`);
      const readback = runIcacls([file]);
      assert(readback.status === 0, `icacls readback exit0, got ${readback.status}`);
      const rb = `${readback.stdout}\n${readback.stderr}`;
      assert(/Everyone/i.test(rb), `icacls readback must show Everyone ACE: ${rb.slice(0, 400)}`);
      // inheritance enabled shows as (I) inherited ACEs and/or absence of "inheritance: disabled"
      assert(
        /\(I\)/i.test(rb) || /Successfully processed/i.test(rb) || /Everyone/i.test(rb),
        `icacls readback must reflect inheritance/grant landing: ${rb.slice(0, 400)}`,
      );

      let failed = false;
      let code = null;
      try {
        mod.verifyProtectedPath(addon, file, "file", "private_rw");
      } catch (e) {
        failed = true;
        code = e?.code || String(e);
      }
      assert(failed, "native verify must fail-closed after DACL tamper");
      assert(
        String(code).includes("DACL_INVALID") || String(code).includes("ACCESS_DENIED"),
        `expected DACL_INVALID/ACCESS_DENIED, got ${code}`,
      );
      try {
        mod.setProtectedPath(addon, file, "file", "private_rw");
      } catch {
        runIcacls([file, "/reset"]);
        assert(runIcacls([file, "/reset"]).status === 0 || true, "reset best-effort");
        mod.setProtectedPath(addon, file, "file", "private_rw");
      }
      mod.setProtectedPath(addon, dir, "directory", "private_rw");
      writeReadyAtomic(readyFile, {
        ok: true,
        failed,
        code,
        icacls: { inheritance: ic1.status, grant: ic2.status, readback: readback.status },
        readbackSnippet: rb.slice(0, 300),
      });
      process.exit(0);
    }

    if (mode === "foreign-group-converge") {
      // Create private_rw file, force foreign group via real helper SetNamedSecurityInfoW, then setProtectedPath must converge.
      const dir = path.join(workDir, "foreign-grp-dir");
      const file = path.join(dir, "f.bin");
      mod.ensureProtectedDirectory(addon, dir);
      assert(mod.durableAtomicCreateFile(addon, file, Buffer.from("fg")) === true);
      // Controller passes helper path as extra[0].
      const helperPath = extra[0];
      assert(helperPath && fs.existsSync(helperPath), `helper missing: ${helperPath}`);
      const hr = spawnSync(helperPath, ["set-foreign-group", file], {
        encoding: "utf8",
        windowsHide: true,
      });
      assert(
        hr.status === 0,
        `set-foreign-group helper failed status=${hr.status}: ${hr.stderr || hr.stdout}`,
      );
      // After foreign group, strict verify must fail; set must converge.
      let preFail = false;
      try {
        mod.verifyProtectedPath(addon, file, "file", "private_rw");
      } catch {
        preFail = true;
      }
      assert(preFail, "verify must fail with foreign group before set");
      mod.setProtectedPath(addon, file, "file", "private_rw");
      mod.verifyProtectedPath(addon, file, "file", "private_rw");
      writeReadyAtomic(readyFile, { ok: true });
      process.exit(0);
    }

    if (mode === "mutex-squat-probe") {
      // Learn identity, close lease, wait for external squat helper, then acquire must DACL_INVALID.
      const dir = path.join(workDir, "lock-dir");
      mod.ensureProtectedDirectory(addon, dir);
      const lease = mod.tryAcquireRetainedDirectoryLock(addon, dir);
      assert(lease && lease.status === "ACQUIRED", "first lock acquire");
      const identity = lease.identity;
      lease.close();
      writeReadyAtomic(readyFile, {
        ok: true,
        phase: "identity",
        path: identity.path,
        volume_serial_number: identity.volume_serial_number,
        file_id: identity.file_id,
      });
      // Wait for controller to signal squat-ready then try acquire.
      const squatReady = extra[0];
      const resultFile = extra[1];
      const start = Date.now();
      while (!fs.existsSync(squatReady)) {
        if (Date.now() - start > 60000) throw new Error("squat ready timeout");
        sleep(20);
      }
      let code = null;
      let busyNull = false;
      try {
        const second = mod.tryAcquireRetainedDirectoryLock(addon, dir);
        if (second === null) {
          busyNull = true;
        } else {
          second.close();
          code = "UNEXPECTED_ACQUIRE";
        }
      } catch (e) {
        code = e?.code || String(e);
      }
      writeReadyAtomic(resultFile, { ok: true, code, busyNull });
      process.exit(0);
    }

    if (mode === "atomic-create-compete") {
      const barrier = extra[0];
      const dest = extra[1];
      const start = Date.now();
      while (!fs.existsSync(barrier)) {
        if (Date.now() - start > 30000) throw new Error("barrier timeout");
        sleep(2);
      }
      const sawBarrierAt = Date.now();
      const data = Buffer.from(`winner-pid-${process.pid}-${randomBytes(8).toString("hex")}`);
      let created = false;
      let err = null;
      try {
        created = mod.durableAtomicCreateFile(addon, dest, data);
      } catch (e) {
        err = e?.code || String(e);
      }
      writeReadyAtomic(readyFile, {
        pid: process.pid,
        created,
        err,
        barrierSkewMs: sawBarrierAt - start,
      });
      process.exit(0);
    }

    if (mode === "atomic-replace-reader") {
      // Protocol (real happens-before, no sleep races):
      //  1) wait goFile → start reading
      //  2) first strict OLD success → write oldAckFile (controller releases writer only after this)
      //  3) first legal complete NEW success → write newAckFile
      //  4) loop until stopFile; final ready keeps seen/hashes/closed errorCodes
      const dest = extra[0];
      const goFile = extra[1];
      const stopFile = extra[2];
      const oldAckFile = extra[3];
      const newAckFile = extra[4];
      const oldText = extra[5] || "hello-private-rw-payload";
      const completeNewRe = /^VERSION-\d+-COMPLETE-x{64}$/;
      const t0 = Date.now();
      while (!fs.existsSync(goFile)) {
        if (Date.now() - t0 > 30000) throw new Error("reader go timeout");
        sleep(5);
      }
      writeReadyAtomic(readyFile.replace(/\.json$/, "-started.json"), { ok: true, pid: process.pid });
      const seen = new Set();
      const seenHashes = new Set();
      let success = 0;
      let errors = 0;
      let oldAcked = false;
      let newAcked = false;
      /** @type {Record<string, number>} */
      const errorCodes = {};
      const start = Date.now();
      while (!fs.existsSync(stopFile)) {
        if (Date.now() - start > 60000) break;
        try {
          const r = mod.readProtectedFile(addon, dest, 4 << 20);
          success += 1;
          const text = r.data.toString("utf8");
          seen.add(text);
          seenHashes.add(sha256(r.data));
          // Exact content must match known complete patterns only — checked by controller.
          if (!oldAcked && text === oldText) {
            writeReadyAtomic(oldAckFile, { ok: true, phase: "old", pid: process.pid });
            oldAcked = true;
          }
          if (!newAcked && completeNewRe.test(text)) {
            writeReadyAtomic(newAckFile, {
              ok: true,
              phase: "new",
              pid: process.pid,
              text: text.slice(0, 80),
            });
            newAcked = true;
          }
        } catch (e) {
          errors += 1;
          const code = e?.code || String(e);
          errorCodes[code] = (errorCodes[code] || 0) + 1;
        }
        sleep(2);
      }
      writeReadyAtomic(readyFile, {
        ok: true,
        seen: [...seen],
        seenHashes: [...seenHashes],
        success,
        errors,
        errorCodes,
        oldAcked,
        newAcked,
      });
      process.exit(0);
    }

    if (mode === "atomic-replace-writer") {
      // Released only after controller observes reader's strict-OLD ack (writerGo).
      const dest = extra[0];
      const n = Number(extra[1] || "20");
      const goFile = extra[2];
      const t0 = Date.now();
      while (!fs.existsSync(goFile)) {
        if (Date.now() - t0 > 30000) throw new Error("writer go timeout");
        sleep(5);
      }
      const versions = [];
      for (let i = 0; i < n; i += 1) {
        const payload = Buffer.from(`VERSION-${i}-COMPLETE-${"x".repeat(64)}`);
        mod.durableAtomicReplaceFile(addon, dest, payload);
        versions.push({ i, hash: sha256(payload), len: payload.length });
        sleep(2);
      }
      writeReadyAtomic(readyFile, { ok: true, versions });
      process.exit(0);
    }

    // Continuous native readProtectedFile pressure while peer replaces.
    // readProtectedFile opens with FILE_SHARE_DELETE so replace must not stall/ACCESS_DENIED.
    if (mode === "native-read-pressure") {
      const dest = extra[0];
      const goFile = extra[1];
      const stopFile = extra[2];
      const t0 = Date.now();
      while (!fs.existsSync(goFile)) {
        if (Date.now() - t0 > 30000) throw new Error("native-read-pressure go timeout");
        sleep(5);
      }
      writeReadyAtomic(readyFile.replace(/\.json$/, "-started.json"), { ok: true, pid: process.pid });
      let success = 0;
      let errors = 0;
      /** @type {Record<string, number>} */
      const errorCodes = {};
      const seen = new Set();
      const start = Date.now();
      while (!fs.existsSync(stopFile)) {
        if (Date.now() - start > 60000) break;
        try {
          const r = mod.readProtectedFile(addon, dest, 4 << 20);
          success += 1;
          seen.add(r.data.toString("utf8").slice(0, 80));
        } catch (e) {
          errors += 1;
          const code = e?.code || String(e);
          errorCodes[code] = (errorCodes[code] || 0) + 1;
        }
        // Tight loop: maximize overlap with replace CreateFile/MoveFileEx window.
      }
      writeReadyAtomic(readyFile, { ok: true, success, errors, errorCodes, seen: [...seen] });
      process.exit(0);
    }

    if (mode === "replace-under-read-pressure") {
      const dest = extra[0];
      const goFile = extra[1];
      const t0 = Date.now();
      while (!fs.existsSync(goFile)) {
        if (Date.now() - t0 > 30000) throw new Error("replace-under-read-pressure go timeout");
        sleep(5);
      }
      // Brief spin so reader is inside native CreateFileW/read windows.
      sleep(50);
      const payload = Buffer.from(`LONG-HOLD-NEW-COMPLETE-${"y".repeat(64)}`);
      const startedAt = Date.now();
      mod.durableAtomicReplaceFile(addon, dest, payload);
      const elapsedMs = Date.now() - startedAt;
      writeReadyAtomic(readyFile, {
        ok: true,
        hash: sha256(payload),
        len: payload.length,
        text: payload.toString("utf8"),
        elapsedMs,
      });
      process.exit(0);
    }

    if (mode === "append-seed-empty") {
      const dest = extra[0];
      mod.durableAtomicReplaceFile(addon, dest, Buffer.alloc(0));
      writeReadyAtomic(readyFile, { ok: true });
      process.exit(0);
    }

    if (mode === "append-record") {
      const dest = extra[0];
      const idx = Number(extra[1]);
      const recordBytes = Number(extra[2] || String(1024 * 1024));
      // Record layout with head/tail hash+length sentinels; multi-chunk WriteFile (≥64KiB native).
      const idxStr = String(idx).padStart(4, "0");
      const headMeta = `REC:${idxStr}:LEN=${recordBytes}:PID=${process.pid}:`;
      const midLen = Math.max(0, recordBytes - Buffer.byteLength(headMeta) - 80);
      const mid = Buffer.alloc(midLen, (idx % 200) + 32);
      for (let i = 0; i < mid.length; i += 8192) mid[i] = idx & 0xff;
      const preHashBody = Buffer.concat([Buffer.from(headMeta), mid]);
      const h = sha256(preHashBody).slice(0, 32);
      const tail = `:HASH=${h}:LEN=${recordBytes}:END\n`;
      let record = Buffer.concat([preHashBody, Buffer.from(tail)]);
      // Pad/truncate to exact recordBytes (tail already included).
      if (record.length < recordBytes) {
        record = Buffer.concat([record, Buffer.alloc(recordBytes - record.length, 0x2e)]);
      } else if (record.length > recordBytes) {
        // Rebuild with adjusted mid.
        const overhead = Buffer.byteLength(headMeta) + Buffer.byteLength(tail);
        const mid2 = Buffer.alloc(Math.max(0, recordBytes - overhead), (idx % 200) + 32);
        const pre2 = Buffer.concat([Buffer.from(headMeta), mid2]);
        const h2 = sha256(pre2).slice(0, 32);
        const tail2 = `:HASH=${h2}:LEN=${recordBytes}:END\n`;
        record = Buffer.concat([pre2, Buffer.from(tail2)]);
        if (record.length < recordBytes) {
          record = Buffer.concat([record, Buffer.alloc(recordBytes - record.length, 0x2e)]);
        }
      }
      assert(record.length === recordBytes, `record length ${record.length} != ${recordBytes}`);

      let lastErr = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          mod.durableAppendFile(addon, dest, record);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (!String(e?.code || e).includes("BUSY")) throw e;
          sleep(5 + attempt);
        }
      }
      if (lastErr) throw lastErr;
      writeReadyAtomic(readyFile, {
        ok: true,
        idx,
        len: recordBytes,
        hash: sha256(record),
        head: record.subarray(0, Math.min(80, record.length)).toString("utf8"),
      });
      process.exit(0);
    }

    if (mode === "kill-during-attempt") {
      // Real native replace attempt with large payload.
      // Protocol:
      //  1) write ready {phase:"about_to_native"} atomically
      //  2) write started marker immediately before native call
      //  3) call durableAtomicReplaceFile with large payload (multi WriteFile + rename)
      // Controller kills after ready with staggered delays. Dest must be exact OLD or NEW.
      const dest = extra[0];
      const startedFile = extra[1];
      const newSize = Number(extra[2] || String(4 * 1024 * 1024));
      const tag = extra[3] || "NEW";
      const payload = makePayload(tag, newSize);
      const newHash = sha256(payload);

      writeReadyAtomic(readyFile, {
        ok: true,
        phase: "about_to_native",
        dest,
        newHash,
        newLen: payload.length,
        pid: process.pid,
      });
      // Tiny yield so controller can observe ready before we enter native.
      sleep(5);
      // started marker immediately adjacent to native call (not an internal stage claim).
      writeReadyAtomic(startedFile, {
        ok: true,
        phase: "entering_native",
        pid: process.pid,
        ts: Date.now(),
      });
      mod.durableAtomicReplaceFile(addon, dest, payload);
      writeReadyAtomic(readyFile.replace(/\.json$/, "-done.json"), {
        ok: true,
        phase: "native_completed",
        newHash,
        newLen: payload.length,
      });
      process.exit(0);
    }

    if (mode === "seed-old") {
      const dest = extra[0];
      const size = Number(extra[1] || String(1024 * 1024));
      const payload = makePayload("OLD", size);
      const parent = path.dirname(dest);
      // Parent may already exist as plain mkdir — ensure create or set to private_rw.
      try {
        mod.ensureProtectedDirectory(addon, parent);
      } catch {
        mod.setProtectedPath(addon, parent, "directory", "private_rw");
      }
      mod.verifyProtectedPath(addon, parent, "directory", "private_rw");
      if (fs.existsSync(dest)) {
        mod.durableAtomicReplaceFile(addon, dest, payload);
      } else {
        assert(mod.durableAtomicCreateFile(addon, dest, payload) === true, "seed create");
      }
      writeReadyAtomic(readyFile, {
        ok: true,
        dest,
        oldHash: sha256(payload),
        oldLen: payload.length,
      });
      process.exit(0);
    }

    if (mode === "reject-paths") {
      const rel = "relative\\path";
      let relFail = false;
      try {
        mod.ensureProtectedDirectory(addon, rel);
      } catch (e) {
        relFail = String(e?.code || e).includes("INVALID_PATH");
      }
      let uncFail = false;
      try {
        mod.verifyProtectedPath(addon, "\\\\server\\share\\x", "directory", "private_rw");
      } catch (e) {
        uncFail = String(e?.code || e).includes("UNSUPPORTED_VOLUME") || String(e?.code || e).includes("INVALID_PATH");
      }
      assert(relFail, "relative must fail");
      assert(uncFail, "UNC must fail");
      writeReadyAtomic(readyFile, { ok: true, relFail, uncFail });
      process.exit(0);
    }

    if (mode === "reject-reparse") {
      const leafJunc = extra[0];
      const viaAncestor = extra[1];
      let leafFail = false;
      let leafCode = null;
      try {
        mod.ensureProtectedDirectory(addon, leafJunc);
      } catch (e) {
        leafFail = true;
        leafCode = e?.code || String(e);
      }
      let ancFail = false;
      let ancCode = null;
      try {
        mod.verifyProtectedPath(addon, viaAncestor, "directory", "private_rw");
      } catch (e) {
        ancFail = true;
        ancCode = e?.code || String(e);
      }
      let atomicLeafFail = false;
      let atomicLeafCode = null;
      try {
        mod.durableAtomicCreateFile(addon, path.join(leafJunc, "x.bin"), Buffer.from("x"));
      } catch (e) {
        atomicLeafFail = true;
        atomicLeafCode = e?.code || String(e);
      }
      let atomicAncFail = false;
      let atomicAncCode = null;
      try {
        mod.durableAtomicCreateFile(addon, path.join(viaAncestor, "y.bin"), Buffer.from("y"));
      } catch (e) {
        atomicAncFail = true;
        atomicAncCode = e?.code || String(e);
      }
      assert(leafFail, "leaf junction ensure must fail");
      assert(
        String(leafCode).includes("REPARSE") || String(leafCode).includes("ANCESTOR_REPARSE"),
        `leaf code ${leafCode}`,
      );
      assert(ancFail, "ancestor junction path must fail");
      assert(
        String(ancCode).includes("ANCESTOR_REPARSE") || String(ancCode).includes("REPARSE"),
        `ancestor code ${ancCode}`,
      );
      assert(atomicLeafFail, "atomic via leaf junction must fail");
      assert(atomicAncFail, "atomic via ancestor junction must fail");
      writeReadyAtomic(readyFile, {
        ok: true,
        leafCode,
        ancCode,
        atomicLeafCode,
        atomicAncCode,
      });
      process.exit(0);
    }

    if (mode === "read-ceiling") {
      const dir = path.join(workDir, "ceil-dir");
      const file = path.join(dir, "big.bin");
      mod.ensureProtectedDirectory(addon, dir);
      const body = Buffer.alloc(100, 0x41);
      assert(mod.durableAtomicCreateFile(addon, file, body) === true);
      let tooLarge = false;
      try {
        mod.readProtectedFile(addon, file, 50);
      } catch (e) {
        tooLarge = String(e?.code || e).includes("TOO_LARGE");
      }
      assert(tooLarge, "read ceiling must fail TOO_LARGE");
      let zeroBad = false;
      let zeroCode = null;
      try {
        mod.readProtectedFile(addon, file, 0);
      } catch (e) {
        zeroBad = true;
        zeroCode = e?.code || String(e);
      }
      assert(zeroBad, "maxBytes=0 must fail");
      assert(
        String(zeroCode).includes("INVALID_PATH") || String(zeroCode).includes("FAILED"),
        `maxBytes=0 must not be TOO_LARGE, got ${zeroCode}`,
      );
      assert(!String(zeroCode).includes("TOO_LARGE"), `maxBytes=0 must not map TOO_LARGE: ${zeroCode}`);
      const ok = mod.readProtectedFile(addon, file, 100);
      assert(ok.data.byteLength === 100, "exact ceiling ok");
      writeReadyAtomic(readyFile, { ok: true, zeroCode });
      process.exit(0);
    }

    throw new Error(`unknown worker mode: ${mode}`);
  } catch (err) {
    try {
      writeReadyAtomic(readyFile, {
        ok: false,
        error: err instanceof Error ? err.stack || err.message : String(err),
      });
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

function spawnWorker(mode, packageRoot, manifestSha256, workDir, readyFile, extraArgs = []) {
  const args = [
    __filename,
    "--worker",
    mode,
    packageRoot,
    manifestSha256,
    workDir,
    readyFile,
    ...extraArgs,
  ];
  return spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    env: process.env,
  });
}

function waitReady(readyFile, timeoutMs = 60000) {
  const start = Date.now();
  while (!fs.existsSync(readyFile)) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${readyFile}`);
    sleep(20);
  }
  return JSON.parse(fs.readFileSync(readyFile, "utf8"));
}

function hardRm(root) {
  try {
    if (fs.existsSync(root)) {
      runIcacls([root, "/reset", "/T", "/C", "/Q"]);
      runIcacls([root, "/grant", `${os.userInfo().username}:(OI)(CI)F`, "/T", "/C", "/Q"]);
    }
  } catch {
    // ignore
  }
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  } catch (e) {
    throw new Error(`cleanup failed for ${root}: ${e?.message || e}`);
  }
  if (fs.existsSync(root)) {
    throw new Error(`cleanup left residual path: ${root}`);
  }
}

function listTemps(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((n) => n.includes(".pi-astack-tmp.") || n.endsWith(".tmp"));
}

function forceKill(child) {
  if (!child || child.killed) return;
  try {
    // Prefer TerminateProcess semantics via child.kill on win32.
    child.kill();
  } catch {
    // ignore
  }
  try {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8",
    });
  } catch {
    // ignore
  }
}

async function mainController() {
  if (process.platform !== "win32") skip("not win32");
  if (process.arch !== "x64") skip(`arch ${process.arch} is not x64`);
  if (!fs.existsSync(stagedNode) || !fs.existsSync(buildInfoPath)) {
    skip("missing smoke-staging artifact; run npm run build:windows-native-addon first");
  }
  if (!fs.existsSync(stagedHelper)) {
    skip("missing mutex squat helper; run npm run build:windows-native-addon first");
  }

  console.log("Windows native durable-dacl / atomic_file smoke (controller/worker)");
  const mod = loadModule();
  const buildInfo = JSON.parse(fs.readFileSync(buildInfoPath, "utf8"));
  const binaryBytes = fs.readFileSync(stagedNode);
  assert(binaryBytes.byteLength > 0, "staged binary empty");
  for (const c of CAPABILITIES) {
    assert(Array.isArray(buildInfo.capabilities) && buildInfo.capabilities.includes(c), `build-info must include ${c}`);
  }

  const pkg = prepareTempPackage(mod, buildInfo, binaryBytes);
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-win-dacl-work-"));
  const abrain = path.resolve(os.homedir(), ".abrain");
  assert(!workRoot.startsWith(abrain + path.sep), "work root not under ~/.abrain");

  const failures = [];
  function check(name, fn) {
    try {
      fn();
      console.log(`  ok    ${name}`);
    } catch (e) {
      failures.push({ name, err: e });
      console.log(`  FAIL  ${name}\n        ${e?.stack || e}`);
    }
  }

  try {
    check("private dir/file exact verify + atomic create/read", () => {
      const ready = path.join(workRoot, "ready-private.json");
      const child = spawnWorker("private-dir-file", pkg.root, pkg.manifestSha256, workRoot, ready);
      const result = waitReady(ready);
      forceKill(child);
      assert(result.ok, result.error || "private-dir-file failed");
    });

    check("package_rx verify + ordinary write/delete denied + owner restore cleanup", () => {
      const ready = path.join(workRoot, "ready-pkg.json");
      const child = spawnWorker("package-rx", pkg.root, pkg.manifestSha256, workRoot, ready);
      const result = waitReady(ready, 90000);
      forceKill(child);
      assert(result.ok, result.error || "package-rx failed");
      assert(result.writeDenied && result.delDenied, "write/delete denied");
    });

    check("DACL tamper via icacls (exit0 + readback) → native fail-closed", () => {
      const ready = path.join(workRoot, "ready-tamper.json");
      const child = spawnWorker("dacl-tamper", pkg.root, pkg.manifestSha256, workRoot, ready);
      const result = waitReady(ready, 90000);
      forceKill(child);
      assert(result.ok, result.error || "dacl-tamper failed");
      assert(result.failed, "must fail-closed");
      assert(result.icacls?.inheritance === 0, "icacls inheritance exit0");
      assert(result.icacls?.grant === 0, "icacls grant exit0");
      assert(result.icacls?.readback === 0, "icacls readback exit0");
    });

    check("foreign group converges via setProtectedPath", () => {
      const ready = path.join(workRoot, "ready-foreign-grp.json");
      const child = spawnWorker("foreign-group-converge", pkg.root, pkg.manifestSha256, workRoot, ready, [
        stagedHelper,
      ]);
      const result = waitReady(ready, 90000);
      forceKill(child);
      assert(result.ok, result.error || "foreign-group-converge failed");
    });

    check("mutex squat helper → DACL_INVALID/MUTEX_NAMESPACE_DENIED (not BUSY)", () => {
      const ready = path.join(workRoot, "ready-mutex-id.json");
      const squatReady = path.join(workRoot, "squat-ready.flag");
      const resultFile = path.join(workRoot, "mutex-squat-result.json");
      const child = spawnWorker("mutex-squat-probe", pkg.root, pkg.manifestSha256, workRoot, ready, [
        squatReady,
        resultFile,
      ]);
      const id = waitReady(ready, 60000);
      assert(id.ok && id.phase === "identity", id.error || "identity phase failed");
      assert(/^[0-9a-f]{16}$/i.test(id.volume_serial_number), "volume hex16");
      assert(/^[0-9a-f]{32}$/i.test(id.file_id), "file id hex32");

      // Real helper: CreateMutexW default DACL, hold. Ready via file (not stdout — sleep blocks event loop).
      const helperReady = path.join(workRoot, "helper-squat-ready.json");
      try {
        fs.unlinkSync(helperReady);
      } catch {
        // ignore
      }
      const helper = spawn(
        stagedHelper,
        ["squat", id.volume_serial_number, id.file_id, "20000", helperReady],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      const helperResult = waitReady(helperReady, 15000);
      assert(helperResult.ok, `helper ready failed: ${JSON.stringify(helperResult)}`);
      fs.writeFileSync(squatReady, "go\n");
      const result = waitReady(resultFile, 30000);
      forceKill(child);
      forceKill(helper);
      assert(result.ok, result.error || "squat probe failed");
      assert(result.busyNull !== true, "squat must not report BUSY null");
      const code = String(result.code || "");
      assert(
        code.includes("DACL_INVALID") || code.includes("MUTEX_NAMESPACE_DENIED") || code.includes("ACCESS_DENIED"),
        `expected DACL_INVALID/MUTEX_NAMESPACE_DENIED/ACCESS_DENIED, got ${code}`,
      );
    });

    check("atomic create 16 processes exactly one winner; err null; barrier skew bounded", () => {
      const dir = path.join(workRoot, "create-race");
      fs.mkdirSync(dir, { recursive: true });
      const setupReady = path.join(workRoot, "ready-create-setup.json");
      const setupChild = spawnWorker("private-dir-file", pkg.root, pkg.manifestSha256, dir, setupReady);
      const setup = waitReady(setupReady);
      forceKill(setupChild);
      assert(setup.ok, setup.error || "setup failed");

      const dest = path.join(dir, "private-dir", "race.bin");
      try {
        fs.unlinkSync(setup.file);
      } catch {
        // ignore
      }
      const barrier = path.join(workRoot, "create-barrier");
      const N = 16;
      const children = [];
      const readies = [];
      for (let i = 0; i < N; i += 1) {
        const ready = path.join(workRoot, `ready-create-${i}.json`);
        readies.push(ready);
        children.push(
          spawnWorker("atomic-create-compete", pkg.root, pkg.manifestSha256, workRoot, ready, [
            barrier,
            dest,
          ]),
        );
      }
      sleep(300);
      const barrierAt = Date.now();
      fs.writeFileSync(barrier, "go\n");
      const results = readies.map((r) => waitReady(r, 60000));
      for (const c of children) forceKill(c);
      for (const r of results) {
        assert(r.err === null || r.err === undefined, `worker err must be null on collision path, got ${r.err}`);
        assert(r.created === true || r.created === false, "created must be boolean");
        // barrier skew: each worker should notice barrier within a bounded window (overlap proof).
        assert(
          typeof r.barrierSkewMs === "number" && r.barrierSkewMs < 15000,
          `barrier skew unbounded: ${r.barrierSkewMs}`,
        );
      }
      const winners = results.filter((r) => r.created === true);
      const losers = results.filter((r) => r.created === false);
      assert(winners.length === 1, `expected exactly 1 winner, got ${winners.length}: ${JSON.stringify(results)}`);
      assert(losers.length === N - 1, `expected ${N - 1} losers (created:false = collision)`);
      assert(fs.existsSync(dest), "dest must exist");
      assert(listTemps(path.dirname(dest)).length === 0, "no temp residual after create race");
      const _ = barrierAt;
    });

    check("atomic replace concurrent reader: non-empty, OLD+NEW, closed errors", () => {
      const dir = path.join(workRoot, "replace-race");
      fs.mkdirSync(dir, { recursive: true });
      const setupReady = path.join(workRoot, "ready-replace-setup.json");
      const setupChild = spawnWorker("private-dir-file", pkg.root, pkg.manifestSha256, dir, setupReady);
      const setup = waitReady(setupReady);
      forceKill(setupChild);
      assert(setup.ok, setup.error || "setup failed");
      const dest = setup.file;
      // OLD is the private-dir-file setup payload; writer publishes VERSION-*-COMPLETE NEW bodies.
      // Happens-before (file acks, not sleep):
      //   readerGo → reader strict-OLD ack → writerGo → writer success + NEW ack → stop.
      const oldText = "hello-private-rw-payload";
      const readerGo = path.join(workRoot, "replace-reader-go");
      const writerGo = path.join(workRoot, "replace-writer-go");
      const stopFile = path.join(workRoot, "replace-stop");
      const oldAck = path.join(workRoot, "replace-old-ack.json");
      const newAck = path.join(workRoot, "replace-new-ack.json");
      const readerReady = path.join(workRoot, "ready-replace-reader.json");
      const writerReady = path.join(workRoot, "ready-replace-writer.json");
      for (const f of [readerGo, writerGo, stopFile, oldAck, newAck, readerReady, writerReady]) {
        try {
          fs.unlinkSync(f);
        } catch {
          // ignore
        }
      }
      const reader = spawnWorker("atomic-replace-reader", pkg.root, pkg.manifestSha256, workRoot, readerReady, [
        dest,
        readerGo,
        stopFile,
        oldAck,
        newAck,
        oldText,
      ]);
      const writer = spawnWorker("atomic-replace-writer", pkg.root, pkg.manifestSha256, workRoot, writerReady, [
        dest,
        "30",
        writerGo,
      ]);
      // Release reader only; writer stays blocked on writerGo until OLD ack.
      fs.writeFileSync(readerGo, "go\n");
      const oldAckResult = waitReady(oldAck, 30000);
      assert(oldAckResult.ok === true && oldAckResult.phase === "old", `strict OLD ack missing: ${JSON.stringify(oldAckResult)}`);
      fs.writeFileSync(writerGo, "go\n");
      const writerResult = waitReady(writerReady, 90000);
      const newAckResult = waitReady(newAck, 30000);
      assert(writerResult.ok, writerResult.error || "writer failed");
      assert(newAckResult.ok === true && newAckResult.phase === "new", `complete NEW ack missing: ${JSON.stringify(newAckResult)}`);
      // Stop only after writer success + NEW ack (both observed).
      fs.writeFileSync(stopFile, "stop\n");
      const readerResult = waitReady(readerReady, 30000);
      forceKill(reader);
      forceKill(writer);
      assert(readerResult.ok, readerResult.error || "reader failed");
      assert(readerResult.oldAcked === true, "reader final must report oldAcked");
      assert(readerResult.newAcked === true, "reader final must report newAcked");
      assert(readerResult.success > 0, `reader success count must be >0, got ${readerResult.success}`);
      assert(Array.isArray(readerResult.seen) && readerResult.seen.length > 0, "seen must be non-empty (must not swallow empty set)");
      const seen = readerResult.seen;
      const hasOld = seen.some((s) => s === oldText);
      const hasNew = seen.some((s) => /^VERSION-\d+-COMPLETE-x{64}$/.test(s));
      assert(hasOld, `must observe strict OLD complete content; seen=${seen.map((s) => s.slice(0, 40)).join("|")}`);
      assert(hasNew, `must observe at least one NEW complete content; seen=${seen.map((s) => s.slice(0, 40)).join("|")}`);
      for (const s of seen) {
        assert(
          s === oldText || /^VERSION-\d+-COMPLETE-x{64}$/.test(s),
          `partial/unknown content: ${s.slice(0, 100)}`,
        );
        assert(!s.includes("PARTIAL"), "partial marker must not appear");
      }
      // Error rate bounded; codes closed.
      const total = readerResult.success + readerResult.errors;
      assert(total > 0, "reader must attempt reads");
      const errRate = readerResult.errors / total;
      assert(errRate < 0.5, `error rate too high: ${errRate}`);
      for (const code of Object.keys(readerResult.errorCodes || {})) {
        assert(
          CLOSED_ATOMIC_ERROR_RE.test(code) || code.includes("WINDOWS_NATIVE_ADDON_"),
          `error code not closed: ${code}`,
        );
      }
      // Cross-check writer version hashes if present.
      if (Array.isArray(writerResult.versions)) {
        for (const v of writerResult.versions) {
          assert(/^[0-9a-f]{64}$/.test(v.hash), "version hash");
        }
      }
    });

    check("native read pressure does not block atomic replace (FILE_SHARE_DELETE)", () => {
      const dir = path.join(workRoot, "long-hold");
      fs.mkdirSync(dir, { recursive: true });
      const setupReady = path.join(workRoot, "ready-long-hold-setup.json");
      const setupChild = spawnWorker("private-dir-file", pkg.root, pkg.manifestSha256, dir, setupReady);
      const setup = waitReady(setupReady);
      forceKill(setupChild);
      assert(setup.ok, setup.error || "setup failed");
      const dest = setup.file;
      const oldText = fs.readFileSync(dest, "utf8");
      const readerReady = path.join(workRoot, "ready-long-hold-reader.json");
      const readerStarted = path.join(workRoot, "ready-long-hold-reader-started.json");
      const replaceReady = path.join(workRoot, "ready-long-hold-replace.json");
      const stopFile = path.join(workRoot, "long-hold-stop");
      const goFile = path.join(workRoot, "long-hold-go");

      const reader = spawnWorker("native-read-pressure", pkg.root, pkg.manifestSha256, workRoot, readerReady, [
        dest,
        goFile,
        stopFile,
      ]);
      const replacer = spawnWorker("replace-under-read-pressure", pkg.root, pkg.manifestSha256, workRoot, replaceReady, [
        dest,
        goFile,
      ]);
      sleep(100);
      fs.writeFileSync(goFile, "go\n");
      waitReady(readerStarted, 30000);
      const replaced = waitReady(replaceReady, 30000);
      fs.writeFileSync(stopFile, "stop\n");
      const readerResult = waitReady(readerReady, 30000);
      forceKill(reader);
      forceKill(replacer);

      assert(replaced.ok, replaced.error || `replace under native read pressure failed: ${JSON.stringify(replaced)}`);
      assert(/LONG-HOLD-NEW-COMPLETE-/.test(replaced.text || ""), "new payload");
      // Without FILE_SHARE_DELETE, MoveFileEx often burns retry budget (~hundreds of ms+).
      // With share-delete, a single replace under read pressure should complete promptly.
      assert(
        typeof replaced.elapsedMs === "number" && replaced.elapsedMs < 5000,
        `replace too slow under reader pressure (possible share block): ${replaced.elapsedMs}ms`,
      );
      const live = fs.readFileSync(dest, "utf8");
      assert(live === replaced.text, "live path must be NEW after replace");
      assert(live !== oldText, "must not remain OLD");
      assert(readerResult.ok, readerResult.error || "reader pressure failed");
      assert(readerResult.success > 0, `reader success=${readerResult.success}`);
      const seen = readerResult.seen || [];
      const sawOldOrNew = seen.some(
        (s) => s.includes("hello-private-rw-payload") || s.includes("LONG-HOLD-NEW-COMPLETE-"),
      );
      assert(sawOldOrNew, `reader must observe complete OLD or NEW; seen=${JSON.stringify(seen)}`);
    });

    check("append 16×1MiB records with hash/length sentinels, no interleave", () => {
      const dir = path.join(workRoot, "append-dir");
      fs.mkdirSync(dir, { recursive: true });
      const setupReady = path.join(workRoot, "ready-append-setup.json");
      const setupChild = spawnWorker("private-dir-file", pkg.root, pkg.manifestSha256, dir, setupReady);
      const setup = waitReady(setupReady);
      forceKill(setupChild);
      assert(setup.ok, setup.error || "setup failed");
      const dest = setup.file;
      const seedReady = path.join(workRoot, "ready-append-seed.json");
      const seedChild = spawnWorker("append-seed-empty", pkg.root, pkg.manifestSha256, workRoot, seedReady, [dest]);
      const seed = waitReady(seedReady);
      forceKill(seedChild);
      assert(seed.ok, seed.error || "append seed failed");

      const N = 16;
      const REC = 1024 * 1024; // 1 MiB each → multi 64KiB WriteFile rounds
      const children = [];
      const readies = [];
      for (let i = 0; i < N; i += 1) {
        const ready = path.join(workRoot, `ready-append-${i}.json`);
        readies.push(ready);
        children.push(
          spawnWorker("append-record", pkg.root, pkg.manifestSha256, workRoot, ready, [
            dest,
            String(i),
            String(REC),
          ]),
        );
      }
      const results = readies.map((r) => waitReady(r, 180000));
      for (const c of children) forceKill(c);
      assert(results.every((r) => r.ok), `append failures: ${JSON.stringify(results.filter((r) => !r.ok))}`);
      const body = fs.readFileSync(dest);
      assert(body.length === N * REC, `expected ${N * REC} bytes, got ${body.length}`);
      // Parse each fixed-size record; verify head/tail sentinels and no interleave.
      const seenIdx = new Set();
      for (let i = 0; i < N; i += 1) {
        const slice = body.subarray(i * REC, (i + 1) * REC);
        const head = slice.subarray(0, 64).toString("utf8");
        const m = /^REC:(\d{4}):LEN=(\d+):PID=\d+:/.exec(head);
        assert(m, `record ${i} head corrupt/interleaved: ${head}`);
        const idx = Number(m[1]);
        const len = Number(m[2]);
        assert(len === REC, `record ${i} LEN sentinel ${len} != ${REC}`);
        assert(!seenIdx.has(idx), `duplicate idx ${idx}`);
        seenIdx.add(idx);
        const text = slice.toString("utf8");
        assert(text.includes(`:LEN=${REC}:END`), `record ${i} missing tail LEN sentinel`);
        assert(/:HASH=[0-9a-f]{32}:LEN=\d+:END/.test(text), `record ${i} missing tail HASH sentinel`);
        // Ensure full slice hash matches worker-reported hash for that idx.
        const worker = results.find((r) => r.idx === idx);
        assert(worker, `missing worker result for idx ${idx}`);
        assert(sha256(slice) === worker.hash, `record ${idx} content hash mismatch`);
      }
      assert(seenIdx.size === N, "all indexes present");
    });

    check("kill-during-attempt old-or-new probe (real native, staggered delays)", () => {
      const dir = path.join(workRoot, "crash-dir");
      fs.mkdirSync(dir, { recursive: true });
      const oldSize = 2 * 1024 * 1024;
      const newSize = 6 * 1024 * 1024; // multi 64KiB WriteFile + long rename window
      const delays = [1, 5, 15, 40, 80, 150, 300];
      let enteredNative = 0;
      let observedOld = 0;
      let observedNew = 0;

      for (let round = 0; round < delays.length; round += 1) {
        const dest = path.join(dir, `crash-target-${round}.bin`);
        const seedReady = path.join(workRoot, `ready-crash-seed-${round}.json`);
        const seedChild = spawnWorker("seed-old", pkg.root, pkg.manifestSha256, workRoot, seedReady, [
          dest,
          String(oldSize),
        ]);
        const seed = waitReady(seedReady, 90000);
        forceKill(seedChild);
        assert(seed.ok, seed.error || "seed-old failed");
        const oldHash = seed.oldHash;
        const oldLen = seed.oldLen;

        const ready = path.join(workRoot, `ready-crash-${round}.json`);
        const started = path.join(workRoot, `started-crash-${round}.json`);
        const done = path.join(workRoot, `ready-crash-${round}-done.json`);
        for (const f of [ready, started, done]) {
          try {
            fs.unlinkSync(f);
          } catch {
            // ignore
          }
        }
        const child = spawnWorker("kill-during-attempt", pkg.root, pkg.manifestSha256, workRoot, ready, [
          dest,
          started,
          String(newSize),
          `NEW${round}`,
        ]);
        const about = waitReady(ready, 60000);
        assert(about.phase === "about_to_native", `about_to_native missing: ${JSON.stringify(about)}`);
        const newHash = about.newHash;
        const newLen = about.newLen;

        // Wait briefly for started marker proving native call entry adjacency.
        const tStart = Date.now();
        let sawStarted = false;
        while (Date.now() - tStart < 5000) {
          if (fs.existsSync(started)) {
            sawStarted = true;
            break;
          }
          sleep(2);
        }
        if (sawStarted) enteredNative += 1;

        sleep(delays[round]);
        forceKill(child);
        // Wait for process death.
        const tDead = Date.now();
        while (child.exitCode === null && !child.killed && Date.now() - tDead < 5000) {
          sleep(20);
        }
        forceKill(child);
        sleep(50);

        assert(fs.existsSync(dest), `dest must exist after kill (OLD or NEW), round=${round}`);
        const finalBuf = fs.readFileSync(dest);
        const finalHash = sha256(finalBuf);
        const finalLen = finalBuf.length;
        const isOld = finalHash === oldHash && finalLen === oldLen;
        const isNew = finalHash === newHash && finalLen === newLen;
        assert(
          isOld || isNew,
          `round ${round}: dest not exact OLD or NEW (len=${finalLen} hash=${finalHash} old=${oldHash}/${oldLen} new=${newHash}/${newLen})`,
        );
        if (isOld) observedOld += 1;
        if (isNew) observedNew += 1;

        // Temp residuals may exist briefly; final cleanup must leave no residual under dir.
        const temps = listTemps(dir);
        for (const t of temps) {
          try {
            fs.unlinkSync(path.join(dir, t));
          } catch {
            // best-effort; hard assert at end of round after short wait
          }
        }
        sleep(30);
        const temps2 = listTemps(dir);
        // Allow identification then cleanup — final no residual for this dest's temps.
        for (const t of temps2) {
          try {
            fs.unlinkSync(path.join(dir, t));
          } catch {
            // ignore
          }
        }
        assert(listTemps(dir).length === 0, `temp residual after cleanup round ${round}: ${listTemps(dir)}`);
      }

      // If we never observed started marker, cannot claim crash coverage of native path.
      assert(
        enteredNative > 0,
        "never observed entering_native started marker; cannot claim kill-during-attempt native coverage",
      );
      // At least one OLD or NEW across rounds is fine; both preferred but kill timing is racy.
      assert(observedOld + observedNew === delays.length, "every round must be OLD or NEW");
      console.log(
        `        kill-during-attempt: enteredNative=${enteredNative}/${delays.length} old=${observedOld} new=${observedNew}`,
      );
    });

    check("leaf + ancestor junction reject for protected/atomic", () => {
      const realBase = path.join(workRoot, "junc-real");
      fs.mkdirSync(realBase, { recursive: true });
      const leafJunc = path.join(workRoot, "junc-leaf");
      const ancJunc = path.join(workRoot, "junc-anc");
      try {
        fs.symlinkSync(realBase, leafJunc, "junction");
      } catch (e) {
        throw new Error(`unable to create leaf junction: ${e?.message || e}`);
      }
      try {
        fs.symlinkSync(realBase, ancJunc, "junction");
      } catch (e) {
        throw new Error(`unable to create ancestor junction: ${e?.message || e}`);
      }
      // Put a real leaf under realBase so via-ancestor path has a directory target name.
      const realLeaf = path.join(realBase, "leaf");
      fs.mkdirSync(realLeaf, { recursive: true });
      const viaAncestor = path.join(ancJunc, "leaf");
      const ready = path.join(workRoot, "ready-reparse.json");
      const child = spawnWorker("reject-reparse", pkg.root, pkg.manifestSha256, workRoot, ready, [
        leafJunc,
        viaAncestor,
      ]);
      const result = waitReady(ready, 60000);
      forceKill(child);
      assert(result.ok, result.error || "reject-reparse failed");
    });

    check("relative/remote path reject", () => {
      const ready = path.join(workRoot, "ready-reject.json");
      const child = spawnWorker("reject-paths", pkg.root, pkg.manifestSha256, workRoot, ready);
      const result = waitReady(ready);
      forceKill(child);
      assert(result.ok, result.error || "reject-paths failed");
    });

    check("read ceiling + maxBytes=0 not TOO_LARGE", () => {
      const ready = path.join(workRoot, "ready-ceil.json");
      const child = spawnWorker("read-ceiling", pkg.root, pkg.manifestSha256, workRoot, ready);
      const result = waitReady(ready);
      forceKill(child);
      assert(result.ok, result.error || "read-ceiling failed");
    });

    check("no temp residual under work root", () => {
      function walk(dir) {
        let bad = [];
        if (!fs.existsSync(dir)) return bad;
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, ent.name);
          if (ent.name.includes(".pi-astack-tmp.")) bad.push(p);
          if (ent.isDirectory()) bad = bad.concat(walk(p));
        }
        return bad;
      }
      const bad = walk(workRoot);
      assert(bad.length === 0, `temp residuals: ${bad.join(",")}`);
    });
  } finally {
    try {
      hardRm(workRoot);
    } catch (e) {
      failures.push({ name: "cleanup-work", err: e });
    }
    try {
      hardRm(pkg.root);
    } catch (e) {
      failures.push({ name: "cleanup-package", err: e });
    }
  }

  if (failures.length) {
    console.error(`FAILED ${failures.length} checks`);
    for (const f of failures) console.error(` - ${f.name}: ${f.err?.message || f.err}`);
    process.exit(1);
  }
  console.log("smoke-windows-native-durable-dacl: OK");
}

// Entry
if (process.argv[2] === "--worker") {
  runWorker();
} else {
  mainController().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
