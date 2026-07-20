#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const history = jiti(path.join(root, "extensions/_shared/recovery-history-classifier.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-recovery-batch-"));
let passed = 0;
const failures = [];

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}\n        ${error?.stack ?? error}`);
  }
}

async function expectCode(code, fn) {
  try {
    await fn();
  } catch (error) {
    assert(error?.code === code, `expected ${code}, got ${error?.code}: ${error?.message}`);
    return;
  }
  throw new Error(`expected ${code}`);
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  }).trim();
}

function pidIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

try {
  const repo = path.join(tmp, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  const objectRoot = path.join(repo, "objects");
  fs.mkdirSync(objectRoot);
  const expectedByPath = new Map();
  for (let index = 0; index < 4000; index += 1) {
    const relative = `objects/blob-${String(index).padStart(4, "0")}.txt`;
    const bytes = Buffer.from(`blob-${index}\n${"x".repeat(index % 97)}\n`);
    fs.writeFileSync(path.join(repo, relative), bytes);
    expectedByPath.set(relative, bytes);
  }
  git(repo, "add", "objects");
  execFileSync("git", ["-C", repo, "commit", "-qm", "4000 blob fixture"], {
    env: {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });

  const rawTree = execFileSync("git", ["-C", repo, "ls-tree", "-r", "-z", "HEAD", "--", "objects"], { encoding: "buffer" });
  const rows = rawTree.toString("utf8").split("\0").filter(Boolean).map((row) => {
    const [meta, relative] = row.split("\t");
    const [mode, type, oid] = meta.split(/\s+/);
    return { mode, type, oid, relative };
  });
  assert(rows.length === 4000, `fixture has ${rows.length} blobs`);

  await check("4000 L2-scale blobs use one cat-file process and preserve bytes", async () => {
    history._resetRecoveryHistoryBatchStatsForTests();
    const blobs = await history._readGitBlobsBatchForTests(repo, rows.map((row) => row.oid));
    assert(blobs.size === 4000, `batch returned ${blobs.size} unique blobs`);
    for (const row of rows) {
      assert(row.mode === "100644" && row.type === "blob", `unexpected fixture tree type for ${row.relative}`);
      assert(blobs.get(row.oid)?.equals(expectedByPath.get(row.relative)), `byte mismatch for ${row.relative}`);
    }
    const stats = history._recoveryHistoryBatchStatsForTests();
    assert(stats.catFileBatchSpawns === 1, `snapshot spawn count=${stats.catFileBatchSpawns}, expected 1`);

    const prepared = rows.map((row) => ({
      path: row.relative,
      op: "put",
      mode: row.mode,
      blobOid: row.oid,
      bytesSha256: createHash("sha256").update(expectedByPath.get(row.relative)).digest("hex"),
    }));
    const diff = new Map(rows.map((row) => [row.relative, {
      oldMode: "000000",
      newMode: row.mode,
      oldOid: "0".repeat(row.oid.length),
      newOid: row.oid,
      status: "A",
    }]));
    history._resetRecoveryHistoryBatchStatsForTests();
    await history._validatePreparedEntriesForTests(repo, prepared, diff);
    const preparedStats = history._recoveryHistoryBatchStatsForTests();
    assert(preparedStats.catFileBatchSpawns === 1, `prepared cohort spawn count=${preparedStats.catFileBatchSpawns}, expected 1`);

    history._resetRecoveryHistoryBatchStatsForTests();
    const cached = await history._readGitBlobBatchesThroughCacheForTests(repo, [
      rows.map((row) => row.oid),
      rows.slice().reverse().map((row) => row.oid),
    ]);
    assert(cached[0].size === rows.length && cached[1].size === rows.length, "classification OID cache omitted blobs");
    const cacheStats = history._recoveryHistoryBatchStatsForTests();
    assert(cacheStats.catFileBatchSpawns === 1, `identical second OID batch respawned git: ${cacheStats.catFileBatchSpawns}`);
  });

  await check("missing object fails closed", async () => {
    await expectCode("RECOVERY_GIT_BATCH_MISSING", () => history._readGitBlobsBatchForTests(repo, ["f".repeat(40)]));
  });

  await check("non-blob object fails closed", async () => {
    const commit = git(repo, "rev-parse", "HEAD");
    await expectCode("RECOVERY_GIT_BATCH_TYPE_MISMATCH", () => history._readGitBlobsBatchForTests(repo, [commit]));
  });

  await check("truncated body and malformed delimiter fail closed", async () => {
    const row = rows[123];
    const bytes = expectedByPath.get(row.relative);
    const protocol = Buffer.concat([Buffer.from(`${row.oid} blob ${bytes.length}\n`), bytes, Buffer.from("\n")]);
    await expectCode("RECOVERY_GIT_BATCH_SHORT_READ", () => Promise.resolve(history._parseGitCatFileBatchForTests([row.oid], [protocol.subarray(0, -2)])));
    const badDelimiter = Buffer.from(protocol);
    badDelimiter[badDelimiter.length - 1] = 0x21;
    await expectCode("RECOVERY_GIT_BATCH_DELIMITER_INVALID", () => Promise.resolve(history._parseGitCatFileBatchForTests([row.oid], [badDelimiter])));
  });

  await check("declared blob and total output bounds fail closed", async () => {
    const row = rows[3999];
    const bytes = expectedByPath.get(row.relative);
    const protocol = Buffer.concat([Buffer.from(`${row.oid} blob ${bytes.length}\n`), bytes, Buffer.from("\n")]);
    await expectCode("RECOVERY_GIT_BATCH_BLOB_LIMIT", () => Promise.resolve(history._parseGitCatFileBatchForTests([row.oid], [protocol], { maxBlobBytes: bytes.length - 1 })));
    await expectCode("RECOVERY_GIT_BATCH_OUTPUT_LIMIT", () => Promise.resolve(history._parseGitCatFileBatchForTests([row.oid], [protocol], { maxOutputBytes: protocol.length - 1 })));
  });

  await check("abort is honored before spawn", async () => {
    const controller = new AbortController();
    controller.abort();
    history._resetRecoveryHistoryBatchStatsForTests();
    await expectCode("RECOVERY_GIT_BATCH_ABORTED", () => history._readGitBlobsBatchForTests(repo, [rows[0].oid], { signal: controller.signal }));
    assert(history._recoveryHistoryBatchStatsForTests().catFileBatchSpawns === 0, "aborted read spawned git");
  });

  await check("hung cat-file process is killed and reaped by timeout", async () => {
    const bin = path.join(tmp, "slow-bin");
    fs.mkdirSync(bin);
    const slowGit = path.join(bin, "git");
    const slowGitPidPath = path.join(tmp, "slow-git.pid");
    fs.writeFileSync(slowGit, `#!/bin/sh\necho $$ > "${slowGitPidPath}"\nexec sleep 5\n`);
    fs.chmodSync(slowGit, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath ?? ""}`;
    try {
      await expectCode("RECOVERY_GIT_BATCH_TIMEOUT", () => history._readGitBlobsBatchForTests(repo, [rows[0].oid], { timeoutMs: 50 }));
      if (process.platform !== "win32") {
        assert(fs.existsSync(slowGitPidPath), "timeout fixture did not launch its process");
        const slowGitPid = Number(fs.readFileSync(slowGitPidPath, "utf8").trim());
        for (let attempt = 0; attempt < 50 && pidIsAlive(slowGitPid); attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert(!pidIsAlive(slowGitPid), `timeout left cat-file pid ${slowGitPid} alive`);
      }
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  // ── Ring-buffer property tests ─────────────────────────────────────────
  // Header / body / delimiter cut points, random cuts, multi-record, grow+compact.
  function encodeRecord(oid, bytes) {
    return Buffer.concat([Buffer.from(`${oid} blob ${bytes.length}\n`), bytes, Buffer.from("\n")]);
  }

  await check("parser ring buffer: every header/body/delimiter cut point", async () => {
    const sample = rows.slice(0, 3);
    const payloads = sample.map((row) => expectedByPath.get(row.relative));
    const stream = Buffer.concat(sample.map((row, i) => encodeRecord(row.oid, payloads[i])));
    for (let cut = 0; cut <= stream.length; cut += 1) {
      const left = stream.subarray(0, cut);
      const right = stream.subarray(cut);
      const parsed = history._parseGitCatFileBatchForTests(
        sample.map((row) => row.oid),
        [left, right].filter((chunk) => chunk.length > 0),
      );
      assert(parsed.size === sample.length, `cut=${cut} size=${parsed.size}`);
      for (let i = 0; i < sample.length; i += 1) {
        assert(parsed.get(sample[i].oid)?.equals(payloads[i]), `cut=${cut} oid=${sample[i].oid} byte mismatch`);
      }
    }
  });

  await check("parser ring buffer: random multi-chunk cuts over multi-record stream", async () => {
    const sample = rows.slice(10, 25);
    const payloads = sample.map((row) => expectedByPath.get(row.relative));
    const stream = Buffer.concat(sample.map((row, i) => encodeRecord(row.oid, payloads[i])));
    // Deterministic pseudo-random cuts for reproducibility.
    let seed = 0xC0FFEE;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    for (let trial = 0; trial < 40; trial += 1) {
      const cuts = new Set([0, stream.length]);
      const cutCount = 3 + (rand() % 12);
      for (let i = 0; i < cutCount; i += 1) cuts.add(rand() % (stream.length + 1));
      const ordered = [...cuts].sort((a, b) => a - b);
      const chunks = [];
      for (let i = 0; i < ordered.length - 1; i += 1) {
        const chunk = stream.subarray(ordered[i], ordered[i + 1]);
        if (chunk.length) chunks.push(chunk);
      }
      const parsed = history._parseGitCatFileBatchForTests(sample.map((row) => row.oid), chunks);
      assert(parsed.size === sample.length, `trial=${trial} size=${parsed.size}`);
      for (let i = 0; i < sample.length; i += 1) {
        assert(parsed.get(sample[i].oid)?.equals(payloads[i]), `trial=${trial} oid mismatch`);
      }
    }
  });

  await check("parser ring buffer: grow + compact under tiny progressive chunks", async () => {
    const sample = rows.slice(100, 108);
    const payloads = sample.map((row) => expectedByPath.get(row.relative));
    const stream = Buffer.concat(sample.map((row, i) => encodeRecord(row.oid, payloads[i])));
    // Feed 1-byte chunks to force ensureCapacity growth and compactIfNeeded.
    const chunks = [];
    for (let i = 0; i < stream.length; i += 1) chunks.push(stream.subarray(i, i + 1));
    const parsed = history._parseGitCatFileBatchForTests(sample.map((row) => row.oid), chunks);
    assert(parsed.size === sample.length, `1-byte feed size=${parsed.size}`);
    for (let i = 0; i < sample.length; i += 1) {
      assert(parsed.get(sample[i].oid)?.equals(payloads[i]), `1-byte feed oid=${sample[i].oid}`);
    }
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed}/${passed + failures.length} checks passed`);
if (failures.length) process.exitCode = 1;
