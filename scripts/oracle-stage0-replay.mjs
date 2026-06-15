#!/usr/bin/env node
/**
 * ADR 0035 P4: stage0 端到端 oracle 离线 replay(修订 8: 离线, 非 inline 双跑)。
 *
 * 对一组 query, 各跑两路 memory search 并对照:
 *   baseline = full-body stage1(stage0Enabled=false, 喂全 corpus)  ← ground-truth 近似
 *   stage0   = embedding 候选(stage0Enabled=true)
 * 核心指标(ADR §7 转产硬门):
 *   coverage = baseline 选中的 entry 有多少落在 stage0 候选池里(池是否漏召)
 *   parity   = stage0 最终 hits 与 baseline hits 的重合(Jaccard)
 * coverage 高(≥95%)即 stage0 不丢 full-body 会选的条目 → 召回 parity。
 *
 * 用真实 ModelRegistry(AuthStorage.create + models.json)跑真实 LLM。
 * 需要 stage1/stage2 model 的 auth 已配。离线工具, 不在交互路。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeOracleRegistry } from "./_oracle-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

const llm = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));
const { selectStage0Pool } = llm;
const { llmSearchEntriesWithVerdict } = llm.__oracleKernel; // ADR 0037: 经 __oracleKernel 拿私有 wrapper

const ABRAIN = path.join(os.homedir(), ".abrain");
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");

// 混合 registry: chat(stage1/2)用真实 ModelRegistry; embedding model 由
// model-curator 动态注册(脚本 registry 不含), 故 embedding 走 sub2api stub
// (同 smoke-stage0-pool) —— 否则 query embed 失败会熔断成 sparse_fallback,
// 测不到真实 dense hybrid。
// 模型无关 registry: 从 models.json 解析 baseUrl+apiKey(!command 从 secrets.json), 任何已配 key 的 provider 都能跑(见 _oracle-registry.mjs)
const { registry, embedKey: EMBED_KEY } = makeOracleRegistry(MODELS_JSON);
if (!EMBED_KEY) { console.log("oracle: SKIP — no embedding key in ~/.pi/secrets.json(dense 会熔断)"); process.exit(0); }

const baseSettings = resolveSettings();
if (!baseSettings.search.stage1Model || !baseSettings.search.stage2Model) {
  console.log("oracle: SKIP — search.stage1Model/stage2Model 未配置"); process.exit(0);
}
if (!baseSettings.embedding.provider || !baseSettings.embedding.model) {
  console.log("oracle: SKIP — embedding 未配置"); process.exit(0);
}

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

// oracle corpus: pi-global project + world(knowledge)。生产 search 即 project+world。
const corpus = [];
const pgRoot = path.join(ABRAIN, "projects", "pi-global");
for (const f of walkMd(pgRoot)) { const e = await parseEntry(f, { scope: "project", root: pgRoot, label: "pi-global" }, pgRoot); if (e && e.status === "active") corpus.push(e); }
const kdir = path.join(ABRAIN, "knowledge");
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }

const queries = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      // 中文 技术/概念/markdown
      "stage1 候选检索改成 embedding 向量",
      "T0 模型选型不看价格只看能力",
      "sediment 写入路径 content-hash 增量",
      "向量索引是否应该 git 跟踪",
      "scope filter 必须在 topN 之前执行",
      "第二大脑自我演化不靠外部压库降本",
      "prompt_user 超时后怎么裁决方向",
      "doubao embedding 召回验证实验语料",
      "全局索引 prune 跨 project 数据丢失",
      "reconcile 在 agent_end 后台增量 embed",
      "熔断 provider 宕机 sparse 兜底禁全库",
      // 英文 / code(函数名/符号/标识符)
      "buildLlmIndexText full body candidate surface",
      "selectStage0Pool hybrid dense sparse fusion",
      "ModelRegistry getApiKeyAndHeaders auth resolution",
      "vault release scope project global secret",
      "git singleflight lock index race condition",
      "content-hash keyed invalidation embedding model version stamp",
      // config / 设置 / 概念
      "models.json provider baseUrl embedding endpoint",
      "ADR 0035 sublinear retrieval architecture decision",
      "memory search two stage rerank verdict none",
      "dispatch parallel T0 cross-vendor blind review",
    ];

// stage1Model(minimax/MiniMax-M3)由 model-curator 动态注册, 脚本 registry 不含;
// oracle override 成 registry built-in 可用的 model(同一 model 跑两路, coverage/
// parity 对照不依赖具体 model)。
const ORACLE_MODEL = process.env.ORACLE_MODEL || "deepseek/deepseek-v4-flash";
const withModel = (s, stage0) => ({ ...s, search: { ...s.search, stage0Enabled: stage0, stage1Model: ORACLE_MODEL, stage2Model: ORACLE_MODEL } });
const offSettings = withModel(baseSettings, false);
const onSettings = withModel(baseSettings, true);
console.log(`oracle model(override): ${ORACLE_MODEL}`);

const jaccard = (a, b) => {
  const A = new Set(a), B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const uni = new Set([...a, ...b]).size;
  return uni === 0 ? 1 : inter / uni;
};

// 分批(避免单次 bash 超时): ORACLE_OFFSET / ORACLE_LIMIT 切子集
const _off = Number(process.env.ORACLE_OFFSET || 0);
const _lim = Number(process.env.ORACLE_LIMIT || queries.length);
const runQueries = queries.slice(_off, _off + _lim);
console.log(`oracle-stage0-replay (HTTP=live) | corpus=${corpus.length} (pi-global+world) | queries=${runQueries.length}/${queries.length} (offset ${_off})\n`);
const cov = [], par = [];
for (const q of runQueries) {
  const baseline = await llmSearchEntriesWithVerdict(corpus, { query: q }, offSettings, registry);
  const stage0 = await llmSearchEntriesWithVerdict(corpus, { query: q }, onSettings, registry);
  const pool = await selectStage0Pool(q, corpus, onSettings, registry, {});
  const baseSlugs = baseline.hits.map((h) => h.slug);
  const poolSet = new Set((pool?.candidateEntries ?? []).map((e) => e.slug));
  const covered = baseSlugs.length === 0 ? 1 : baseSlugs.filter((s) => poolSet.has(s)).length / baseSlugs.length;
  const parity = jaccard(baseSlugs, stage0.hits.map((h) => h.slug));
  cov.push(covered); par.push(parity);
  console.log(`Q: ${q}`);
  console.log(`  baseline(full-body) verdict=${baseline.relevance_verdict} hits=${baseSlugs.length} [${baseSlugs.slice(0, 6).join(", ")}]`);
  console.log(`  stage0              verdict=${stage0.relevance_verdict} hits=${stage0.hits.length} pool=${pool?.candidateEntries.length}(dense ${pool?.denseCount}/sparse ${pool?.sparseCount}) surface=${stage0.stage1CandidateSurface}`);
  console.log(`  → coverage(baseline⊆pool)=${(covered * 100).toFixed(0)}%  parity(jaccard)=${(parity * 100).toFixed(0)}%\n`);
}
const avg = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(`平均 coverage=${(avg(cov) * 100).toFixed(1)}%  平均 parity=${(avg(par) * 100).toFixed(1)}%`);
console.log(`转产硬门(ADR §7): coverage ≥95% 方可考虑 P5 切换。`);
