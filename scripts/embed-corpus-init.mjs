#!/usr/bin/env node
/**
 * ADR 0035 P1: 全库初始 embed。
 *
 * 用**真实 parseEntry**(经 ts-require-hook 加载真实 parser.ts + 依赖)读所有
 * project + knowledge 的 active entries —— content-hash 与生产 loadEntries 一致,
 * 故本次预热对生产有效(P2 sediment 写入不会因 hash mismatch 全部 re-embed)。
 * 然后 buildCorpusEmbeddings 写生产索引 ~/.abrain/.state/memory/embeddings.json
 * (全局单文件 + per-entry scope tag, ADR 0035 §7 P1 决策)。
 *
 * 需要 ~/.pi/secrets.json 的 embedding key。幂等:content-hash 增量,重跑只 embed 变化的。
 */
import fs from "node:fs";
import { embeddingConfig } from "./_embedding-config.mjs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");
const Module = require("node:module");

// ── ts-aware require: transpile .ts on require + resolve bare relative → .ts ──
require.extensions[".ts"] = (module, filename) => {
  const src = fs.readFileSync(filename, "utf8");
  const out = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
    fileName: filename,
  }).outputText;
  module._compile(out, filename);
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  try {
    return origResolve.call(this, request, parent, ...rest);
  } catch (e) {
    if (parent && (request.startsWith("./") || request.startsWith("../"))) {
      const cand = path.resolve(path.dirname(parent.filename), request) + ".ts";
      if (fs.existsSync(cand)) return cand;
    }
    throw e;
  }
};

const extDir = path.join(repoRoot, "extensions");
const parser = require(path.join(extDir, "memory", "parser.ts"));
const emb = require(path.join(extDir, "memory", "embedding.ts"));
const settingsMod = require(path.join(extDir, "memory", "settings.ts"));
const runtime = require(path.join(extDir, "_shared", "runtime.ts"));

const ABRAIN = process.env.ABRAIN_ROOT
  ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
  : path.join(os.homedir(), ".abrain");

function walkMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkMd(p));
    else if (e.name.endsWith(".md") && !e.name.startsWith("_")) out.push(p);
  }
  return out;
}

console.log(`abrain home: ${ABRAIN}`);
const entries = [];
const projectsDir = path.join(ABRAIN, "projects");
for (const pid of fs.readdirSync(projectsDir)) {
  const root = path.join(projectsDir, pid);
  if (!fs.statSync(root).isDirectory()) continue;
  const store = { scope: "project", root, label: pid };
  for (const f of walkMd(root)) {
    const e = await parser.parseEntry(f, store, root);
    if (e) entries.push(e);
  }
}
const knowledgeDir = path.join(ABRAIN, "knowledge");
if (fs.existsSync(knowledgeDir)) {
  const store = { scope: "world", root: knowledgeDir, label: "knowledge" };
  for (const f of walkMd(knowledgeDir)) {
    const e = await parser.parseEntry(f, store, knowledgeDir);
    if (e) entries.push(e);
  }
}

const active = entries.filter((e) => e.status === "active");
const scopeCount = {};
for (const e of active) scopeCount[emb.scopeTagOf(e)] = (scopeCount[emb.scopeTagOf(e)] || 0) + 1;
console.log(`parsed ${entries.length} entries, ${active.length} active across ${Object.keys(scopeCount).length} scopes`);

const embedding = embeddingConfig();
const key = embedding.apiKey;
if (!key || !embedding.baseUrl) { console.error("memory.embedding baseUrl/apiKey not configured"); process.exit(1); }
const baseUrl = embedding.baseUrl;
// ADR 0036 P4: 多向量从生产 settings 读(env MULTI_VECTOR 可覆写)。设 multiVector=true
// + 跨 init 会把全库重嵌为多向量(长 entry 出多 sub-vector); flag off 与现状一致。
const embS = settingsMod.resolveSettings().embedding;
const multiVector = process.env.MULTI_VECTOR != null ? process.env.MULTI_VECTOR === "1" : embS.multiVector;
const multiVectorMaxChunks = Number(process.env.MULTI_VECTOR_MAX_CHUNKS || embS.multiVectorMaxChunks);
const cfg = { baseUrl, apiKey: key, model: embS.model || embedding.model, dim: embS.dim, batchSize: embS.batchSize, tpmLimit: embS.tpmLimit, timeoutMs: embS.timeoutMs, maxRetries: embS.maxRetries, multiVector, multiVectorMaxChunks };
console.log(`multiVector=${multiVector} maxChunks=${multiVectorMaxChunks}`);

// ADR 0036 P4 条件2(原子 swap): OUT_PATH 可写 shadow 路径(不碰生产索引), 建好 validate 后原子 mv。
const idxPath = process.env.OUT_PATH || emb.vectorIndexPath();
console.log(`index → ${idxPath}`);
// 并发安全: 写生产索引时取与在线 session reconcile 同一把全局锁(indexLockPath),
// 避免与 search-time / sediment 触发的 reconcile 互相覆盖(last-writer-wins 丢更新)
// 或在全量 prune 时删掉并发 session 刚写入的向量。OUT_PATH shadow 路径不碰生产, 免锁。
// 持锁期间 init 进程持续存活, 受 acquireFileLock 的 pid-liveness 保护不会被误抓(staleMs)。
const lock = process.env.OUT_PATH
  ? null
  : await runtime.acquireFileLock(emb.indexLockPath(), { timeoutMs: 60_000, staleMs: 60_000, retryMs: 200, label: "embedding-index" });
const t0 = Date.now();
let r;
try {
  r = await emb.buildCorpusEmbeddings(active, cfg, idxPath, {
    maxChars: 3500,
    onProgress: (done, todo) => { if (done % 200 < 10 || done === todo) console.log(`  embedded ${done}/${todo} (${((Date.now() - t0) / 1000).toFixed(0)}s)`); },
  });
} finally {
  if (lock) await lock.release();
}
console.log(`\ndone in ${((Date.now() - t0) / 1000).toFixed(0)}s:`, JSON.stringify(r));
const idxData = JSON.parse(fs.readFileSync(idxPath, "utf8"));
const indexedEntries = Object.keys(idxData.entries).length;
if (!process.env.OUT_PATH) {
  fs.mkdirSync(path.dirname(emb.indexMetaPath()), { recursive: true });
  fs.writeFileSync(emb.indexMetaPath(), `${JSON.stringify({
    updatedAt: new Date().toISOString(),
    activeEntries: r.total,
    indexedEntries,
    coverageRatio: r.total > 0 ? indexedEntries / r.total : 1,
    embeddedThisRun: r.embedded,
    skippedThisRun: r.skipped,
    prunedThisRun: r.pruned,
    embedded: r.embedded,
    skipped: r.skipped,
    pruned: r.pruned,
    scheme: emb.embedSchemeTag(multiVector),
    multiVectorMaxChunks,
  })}\n`, "utf8");
}
const byScope = {};
for (const rec of Object.values(idxData.entries)) byScope[rec.scope] = (byScope[rec.scope] || 0) + 1;
console.log(`index: ${indexedEntries} vectors, dim ${idxData.dim}, model ${idxData.model}`);
console.log(`scope 分布:`, JSON.stringify(byScope, null, 0));
