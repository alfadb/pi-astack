#!/usr/bin/env node
/**
 * Smoke: ADR 0027 PR-B+ R1 P1-9 — multi-view skip-cache for Pass 1
 * unsynthesizable dead-loop.
 *
 * Verifies:
 *   - `fingerprintCandidate()` is stable across calls with same input
 *   - Different op / different slug / different compiledTruth → different fp
 *   - `writeSkipCacheEntry()` appends to JSONL
 *   - `lookupSkipCache(fp)` returns hit when entry is within TTL
 *   - `lookupSkipCache(fp)` returns miss when entry is older than TTL
 *   - `lookupSkipCache` returns the MOST RECENT entry on multiple hits
 *   - `pruneExpiredSkipCache()` removes expired entries, keeps fresh
 *   - Corrupt cache file: lookups don't throw, return miss
 *   - Cache file missing: lookups return miss without error
 *
 * Why this smoke matters: this is the cost-saving mechanism for the
 * R1-flagged Pass 1 schema dead-loop ($0.10-0.50/wk wasted on update/
 * merge/supersede/delete candidates re-entering multi-view). The cache
 * MUST be reliable or the dead-loop returns.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: srcPath,
  }).outputText;
}

function loadCJS(code, fakePath, stubMap) {
  const Module = require("node:module").Module;
  const m = new Module(fakePath);
  m.filename = fakePath;
  m.paths = Module._nodeModulePaths(path.dirname(fakePath));
  const origLoad = Module._load;
  if (stubMap) {
    Module._load = function patched(request, parent, ...rest) {
      if (stubMap.has(request)) return stubMap.get(request);
      return origLoad.call(this, request, parent, ...rest);
    };
  }
  try {
    m._compile(code, fakePath);
  } finally {
    if (stubMap) Module._load = origLoad;
  }
  return m.exports;
}

// ── Setup with isolated cache dir ──────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv-skip-cache-"));
const cacheDir = path.join(tmpDir, "global-sediment");
fs.mkdirSync(cacheDir, { recursive: true });

const runtimeStub = {
  ensureUserGlobalSidecarMigrated: () => {},
  userGlobalSedimentDir: () => cacheDir,
};

const cacheSrc = path.join(repoRoot, "extensions/sediment/multi-view-skip-cache.ts");
const cacheCjs = transpile(cacheSrc);
const cachePath = path.join(tmpDir, "skip-cache.cjs");
fs.writeFileSync(cachePath, cacheCjs);
const cache = loadCJS(
  cacheCjs,
  cachePath,
  new Map([
    ["../_shared/runtime", runtimeStub],
    ["./curator", {}],
    ["./writer", {}],
  ]),
);

const {
  fingerprintCandidate,
  lookupSkipCache,
  writeSkipCacheEntry,
  pruneExpiredSkipCache,
  _readSkipCacheForTests,
  _clearSkipCacheForTests,
  SKIP_CACHE_DEFAULT_TTL_MS,
} = cache;

console.log("multi-view skip-cache (ADR 0027 PR-B+ R1 P1-9)");

// ── Fingerprint tests ──────────────────────────────────────────

check("fingerprint stable across calls with same input", () => {
  const draft = { compiledTruth: "User prefers pnpm", title: "t", kind: "preference" };
  const decision = { op: "update", slug: "prefer-pnpm", patch: { confidence: 9 } };
  const fp1 = fingerprintCandidate(decision, draft);
  const fp2 = fingerprintCandidate(decision, draft);
  if (fp1 !== fp2) throw new Error(`unstable: ${fp1} vs ${fp2}`);
  if (typeof fp1 !== "string" || fp1.length !== 64) {
    throw new Error(`unexpected fp shape: ${fp1}`);
  }
});

check("different op → different fingerprint", () => {
  const draft = { compiledTruth: "same content", title: "t", kind: "preference" };
  const fpA = fingerprintCandidate({ op: "update", slug: "x", patch: {} }, draft);
  const fpB = fingerprintCandidate({ op: "delete", slug: "x", mode: "hard", reason: "r" }, draft);
  if (fpA === fpB) throw new Error("different ops should produce different fps");
});

check("different slug → different fingerprint", () => {
  const draft = { compiledTruth: "same", title: "t", kind: "preference" };
  const fpA = fingerprintCandidate({ op: "update", slug: "x", patch: {} }, draft);
  const fpB = fingerprintCandidate({ op: "update", slug: "y", patch: {} }, draft);
  if (fpA === fpB) throw new Error("different slugs should produce different fps");
});

check("different compiledTruth → different fingerprint", () => {
  const draftA = { compiledTruth: "User prefers pnpm", title: "t", kind: "preference" };
  const draftB = { compiledTruth: "User prefers yarn", title: "t", kind: "preference" };
  const decision = { op: "update", slug: "x", patch: {} };
  if (fingerprintCandidate(decision, draftA) === fingerprintCandidate(decision, draftB)) {
    throw new Error("different compiledTruth should produce different fps");
  }
});

check("whitespace-normalized compiledTruth → same fingerprint", () => {
  const draftA = { compiledTruth: "User\n\nprefers   pnpm", title: "t", kind: "preference" };
  const draftB = { compiledTruth: "  User prefers pnpm  ", title: "t", kind: "preference" };
  const decision = { op: "update", slug: "x", patch: {} };
  const fpA = fingerprintCandidate(decision, draftA);
  const fpB = fingerprintCandidate(decision, draftB);
  if (fpA !== fpB) {
    throw new Error(`whitespace normalization broken: ${fpA} vs ${fpB}`);
  }
});

check("merge op fingerprint depends on sorted sources (commutative)", () => {
  const draft = { compiledTruth: "same", title: "t", kind: "preference" };
  const fpA = fingerprintCandidate(
    { op: "merge", target: "main", sources: ["a", "b"], compiledTruth: "x" },
    draft,
  );
  const fpB = fingerprintCandidate(
    { op: "merge", target: "main", sources: ["b", "a"], compiledTruth: "x" },
    draft,
  );
  if (fpA !== fpB) {
    throw new Error("merge sources should be order-invariant");
  }
});

// ── Cache write/read tests ─────────────────────────────────────

check("missing cache file → lookup returns miss without throwing", () => {
  _clearSkipCacheForTests();
  const result = lookupSkipCache("any-fp");
  if (result.hit) throw new Error("expected miss for empty cache");
});

check("write then lookup → hit", () => {
  _clearSkipCacheForTests();
  writeSkipCacheEntry({
    fingerprint: "deadbeef",
    ts: new Date().toISOString(),
    pass1_op: "skip",
    proposer_op: "update",
    proposer_slug: "prefer-pnpm",
  });
  const result = lookupSkipCache("deadbeef");
  if (!result.hit) throw new Error("expected hit");
  if (result.entry.pass1_op !== "skip") throw new Error("entry data wrong");
});

check("expired entry → miss", () => {
  _clearSkipCacheForTests();
  const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(); // 30 days ago
  writeSkipCacheEntry({
    fingerprint: "old-fp",
    ts: oldTs,
    pass1_op: "skip",
    proposer_op: "update",
  });
  const result = lookupSkipCache("old-fp");
  if (result.hit) throw new Error(`expected miss for 30-day-old entry, got hit: ${JSON.stringify(result)}`);
});

check("custom TTL", () => {
  _clearSkipCacheForTests();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  writeSkipCacheEntry({
    fingerprint: "fresh-fp",
    ts: oneHourAgo,
    pass1_op: "skip",
    proposer_op: "update",
  });
  // 30-min TTL: 1-hour-old entry should miss
  const result30min = lookupSkipCache("fresh-fp", { ttlMs: 30 * 60 * 1000 });
  if (result30min.hit) throw new Error("30-min TTL: should miss");
  // 2-hour TTL: 1-hour-old entry should hit
  const result2h = lookupSkipCache("fresh-fp", { ttlMs: 2 * 60 * 60 * 1000 });
  if (!result2h.hit) throw new Error("2h TTL: should hit");
});

check("multiple entries: most recent matching wins", () => {
  _clearSkipCacheForTests();
  writeSkipCacheEntry({
    fingerprint: "same-fp",
    ts: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    pass1_op: "skip",
    proposer_op: "update",
    pass1_reasoning_snippet: "older entry",
  });
  writeSkipCacheEntry({
    fingerprint: "same-fp",
    ts: new Date(Date.now() - 60 * 1000).toISOString(),
    pass1_op: "skip",
    proposer_op: "update",
    pass1_reasoning_snippet: "newer entry",
  });
  const result = lookupSkipCache("same-fp");
  if (!result.hit) throw new Error("expected hit");
  if (result.entry.pass1_reasoning_snippet !== "newer entry") {
    throw new Error(`expected newer entry, got: ${result.entry.pass1_reasoning_snippet}`);
  }
});

check("corrupt cache line → skipped, valid lines still read", () => {
  _clearSkipCacheForTests();
  // Write one corrupt then one valid line manually
  const file = path.join(cacheDir, "multi-view-skip-cache.jsonl");
  fs.writeFileSync(file, "not-json{}{}\n" + JSON.stringify({
    fingerprint: "valid-after-corrupt",
    ts: new Date().toISOString(),
    pass1_op: "skip",
    proposer_op: "update",
  }) + "\n");
  const result = lookupSkipCache("valid-after-corrupt");
  if (!result.hit) throw new Error("should hit valid line despite corrupt line");
});

check("pruneExpiredSkipCache removes old, keeps fresh", () => {
  _clearSkipCacheForTests();
  const oldTs = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const newTs = new Date().toISOString();
  writeSkipCacheEntry({ fingerprint: "old1", ts: oldTs, pass1_op: "skip", proposer_op: "u" });
  writeSkipCacheEntry({ fingerprint: "old2", ts: oldTs, pass1_op: "skip", proposer_op: "u" });
  writeSkipCacheEntry({ fingerprint: "new1", ts: newTs, pass1_op: "skip", proposer_op: "u" });
  const result = pruneExpiredSkipCache();
  if (result.removed !== 2) throw new Error(`expected 2 removed, got ${result.removed}`);
  if (result.kept !== 1) throw new Error(`expected 1 kept, got ${result.kept}`);
  // Verify on disk
  const rows = _readSkipCacheForTests();
  if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`);
  if (rows[0].fingerprint !== "new1") throw new Error("wrong row kept");
});

// ── Summary ────────────────────────────────────────────────────

console.log();
if (failures.length === 0) {
  console.log(`✅ multi-view skip-cache: all checks passed`);
  process.exit(0);
} else {
  console.error(`❌ multi-view skip-cache: ${failures.length} failure(s)`);
  for (const { name, err } of failures) {
    console.error(`  - ${name}: ${err.stack || err.message}`);
  }
  process.exit(1);
}
