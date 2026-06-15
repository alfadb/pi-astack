#!/usr/bin/env node
/**
 * ADR 0035 P3 smoke: 验证 stage0 hybrid 候选检索把 stage1 候选面从**全库**缩小到
 * 有界候选池(~stage0MaxCandidates),这是 P3 降本的核心(O(库) → O(N))。
 *
 * 用 jiti 加载真实 llm-search.ts::selectStage0Pool + 真实全库 active corpus
 * (parseEntry 遍历)+ 真实索引(.state/memory/embeddings.json, 2350 向量)+ 真实
 * query embed(stub modelRegistry 注入 sub2api key/baseUrl)。
 *
 * 需要 ~/.pi/secrets.json 的 embedding key(无则 SKIP)。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import { secret } from "./_secrets.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

const KEY = secret("embedding");
if (!KEY) { console.log("smoke-stage0-candidate-pool: SKIP (no embedding key in ~/.pi/secrets.json)"); process.exit(0); }

const { selectStage0Pool } = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));

const mj = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
const BASE_URL = mj.providers.embedding.baseUrl;
const ABRAIN = path.join(os.homedir(), ".abrain");

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

// 真实全库 active corpus(parseEntry, 与生产 content-hash 一致)
const corpus = [];
for (const pid of fs.readdirSync(path.join(ABRAIN, "projects"))) {
  const root = path.join(ABRAIN, "projects", pid);
  if (!fs.statSync(root).isDirectory()) continue;
  const store = { scope: "project", root, label: pid };
  for (const f of walkMd(root)) { const e = await parseEntry(f, store, root); if (e && e.status === "active") corpus.push(e); }
}
const kdir = path.join(ABRAIN, "knowledge");
if (fs.existsSync(kdir)) {
  const store = { scope: "world", root: kdir, label: "knowledge" };
  for (const f of walkMd(kdir)) { const e = await parseEntry(f, store, kdir); if (e && e.status === "active") corpus.push(e); }
}

const settings = resolveSettings();
// stub modelRegistry: resolveEmbeddingProviderConfig 只用 find()+getApiKeyAndHeaders()
const modelRegistry = {
  find: () => ({ baseUrl: BASE_URL }),
  getApiKeyAndHeaders: async () => ({ ok: true, apiKey: KEY }),
};

console.log(`smoke-stage0-candidate-pool (HTTP=live)\n`);
let failed = 0;
const check = (name, cond) => { console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}`); if (!cond) failed++; };

const pool = await selectStage0Pool("git 子模块提交顺序与 embedding 向量检索 stage1", corpus, settings, modelRegistry, {});

check(`corpus 全库 active = ${corpus.length} (应 >1000, 即"full 2215+")`, corpus.length > 1000);
check(`selectStage0Pool 非 null(provider 已配)`, pool !== null);
if (pool) {
  check(`候选池 ${pool.candidateEntries.length} ≤ maxCandidates ${settings.search.stage0MaxCandidates}(硬上限)`, pool.candidateEntries.length <= settings.search.stage0MaxCandidates);
  check(`候选池 << 全库(缩小成立): ${pool.candidateEntries.length} < ${corpus.length}`, pool.candidateEntries.length < corpus.length);
  check(`dense 召回 > 0 且 mode=hybrid(query embed 成功): dense=${pool.denseCount} mode=${pool.mode}`, pool.denseCount > 0 && pool.mode === "hybrid");
  check(`候选池缩小比 ≥ 5×: ${(corpus.length / Math.max(1, pool.candidateEntries.length)).toFixed(1)}×`, corpus.length / Math.max(1, pool.candidateEntries.length) >= 5);
  console.log(`\n  stage1 候选面: 全库 ${corpus.length} → stage0 ${pool.candidateEntries.length} 条`);
  console.log(`  (dense ${pool.denseCount} / sparse ${pool.sparseCount} / stale ${pool.staleCount}, query-embed ${pool.embedMs}ms)`);
}

console.log(`\n${failed === 0 ? "all checks passed" : failed + " failed"}`);
process.exit(failed ? 1 : 0);
