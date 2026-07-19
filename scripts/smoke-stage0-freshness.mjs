#!/usr/bin/env node
/**
 * ADR 0035 P6 必改 2: freshness 不变量 smoke(4×T0 REVISE-B 共识)。
 *
 * 不变量(ADR §4): 新写/改写 entry 下次 search **立即可召回**, 即使候选面饱和。
 * 实现保证 = selectStage0Pool 给 stale/missing 一个保底 floor, 不可被 dense/sparse
 * 填满 maxCand 挤出。
 *
 * 测法(单元级, 不需 chat LLM, 只测候选选择逻辑):
 *   - corpus = pi-global + world(真, 已索引), > maxCand → 制造饱和
 *   - 注入 probe entry(slug 独特 → 不在向量索引 → staleOrMissing; updated=未来 →
 *     recency 第一; content 独特无意义 → sparse 不命中; 不在索引 → dense 不返回)
 *   - poolLimit=maxCand=300: dense topN(300) 恰填满 maxCand → 饱和
 *   - floor=0.1: probe 必在候选池(floor 保底) ✅
 *   - floor=0  : probe 被挤出(对照, 证明饱和确实挤 + floor 是必要修复) ✅
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import { embeddingConfig } from "./_embedding-config.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const ABRAIN = path.join(os.homedir(), ".abrain");
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");

const EMBEDDING = embeddingConfig();
if (!EMBEDDING.apiKey || !EMBEDDING.baseUrl) { console.log("SKIP — memory.embedding baseUrl/apiKey not configured"); process.exit(0); }

const { selectStage0Pool } = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));

const realRuntime = await ModelRuntime.create({ modelsPath: MODELS_JSON });
const realRegistry = new ModelRegistry(realRuntime);
const registry = {
  find: (p, id) => (p === "embedding" ? { __embed: true, provider: p, id, baseUrl: EMBEDDING.baseUrl } : realRegistry.find(p, id)),
  getApiKeyAndHeaders: async (m) => (m && m.__embed ? { ok: true, apiKey: EMBEDDING.apiKey } : realRegistry.getApiKeyAndHeaders(m)),
};

function walkMd(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walkMd(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }

const corpus = [];
const pgRoot = path.join(ABRAIN, "projects", "pi-global");
for (const f of walkMd(pgRoot)) { const e = await parseEntry(f, { scope: "project", root: pgRoot, label: "pi-global" }, pgRoot); if (e && e.status === "active") corpus.push(e); }
const kdir = path.join(ABRAIN, "knowledge");
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }

// probe: 模拟"刚写入、尚未索引"的新 entry — slug 独特(不在索引→stale),
// updated=未来(recency 第一), content 独特无意义(sparse 不命中)。
const probeSlug = "__freshness-probe-" + Date.now();
const probe = {
  ...corpus[0],
  slug: probeSlug,
  updated: "2099-12-31T23:59:59.000Z",
  title: "qzxvbnm freshness probe unique marker",
  summary: "qzxvbnm freshness probe unique marker not matching any real query",
  compiledTruth: "qzxvbnm freshness probe unique marker body content sentinel",
};
const corpusWithProbe = [...corpus, probe];

// 无意义 query: dense 仍返回 topN(向量最近邻, 制造饱和), sparse 命中 0(消除干扰)。
const query = "qzxvbnm zzztoken nonsense saturation probe";
const base = resolveSettings();
const mk = (floor) => ({ ...base, search: { ...base.search, stage0Enabled: true, stage0PoolLimit: 300, stage0MaxCandidates: 300, stage0StaleFloorRatio: floor } });

console.log(`smoke-stage0-freshness | corpus=${corpus.length}(+probe) maxCand=300 poolLimit=300\n`);

let failed = 0;
const check = (n, c) => { console.log(`  ${c ? "ok  " : "FAIL"}  ${n}`); if (!c) failed++; };

check(`corpus > maxCand (饱和前提): ${corpusWithProbe.length} > 300`, corpusWithProbe.length > 300);

const poolOn = await selectStage0Pool(query, corpusWithProbe, mk(0.1), registry, {});
const onSlugs = new Set((poolOn?.candidateEntries ?? []).map((e) => e.slug));
check(`floor=0.1: mode=hybrid(dense 工作, 非熔断): ${poolOn?.mode}`, poolOn?.mode === "hybrid");
check(`floor=0.1: 候选面饱和到 maxCand: pool=${poolOn?.candidateEntries.length}`, poolOn?.candidateEntries.length === 300);
check(`floor=0.1: probe 在候选池 (freshness 不变量成立) ✅`, onSlugs.has(probeSlug));

const poolOff = await selectStage0Pool(query, corpusWithProbe, mk(0), registry, {});
const offSlugs = new Set((poolOff?.candidateEntries ?? []).map((e) => e.slug));
check(`floor=0  : probe 被挤出 (对照: 饱和确实挤 + floor 是必要修复) ✅`, !offSlugs.has(probeSlug));

console.log(`\n  dense=${poolOn?.denseCount} sparse=${poolOn?.sparseCount} stale=${poolOn?.staleCount}`);
console.log(`${failed === 0 ? "\nfreshness 不变量 smoke PASS — stale floor 兑现「新写 entry 立即可召回」" : "\n" + failed + " FAILED"}`);
process.exit(failed ? 1 : 0);
