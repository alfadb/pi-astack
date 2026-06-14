#!/usr/bin/env node
/**
 * ADR 0036 P2: 多 model 投票金标集 + recall@gold 评估(跨过 derives_from 循环自证)。
 *
 * build: 每 query 取 stage0 宽候选(top poolLimit), 3 个跨厂商强 model 各自标注
 *        "真正相关"的 slug, ≥2 票 = gold。金标基于 model 读 query+entry 内容判断,
 *        不靠 sediment 建立的 derives_from/related(去正偏)。缓存 goldset.json。
 * eval:  用 gold 评估 two-stage(stage1Skip) vs three-stage 的 recall@gold + 候选池
 *        coverage@gold。recall@gold = 最终 hits ∩ gold / gold。
 *
 * FORCE_BUILD=1 强制重建金标。默认有 goldset.json 则跳过 build 直接 eval。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const ABRAIN = path.join(os.homedir(), ".abrain");
const MODELS_JSON = path.join(os.homedir(), ".pi", "agent", "models.json");
const GOLDSET_PATH = path.join(__dirname, "goldset.json");

const llm = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
const { llmSearchEntriesWithVerdict, selectStage0Pool, callSearchModel } = llm;
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));

const realRegistry = ModelRegistry.create(AuthStorage.create(), MODELS_JSON);
const EMBED_KEY = process.env.SUB2API_API_KEY_EMBEDDING;
const EMBED_BASE = (() => { try { return JSON.parse(fs.readFileSync(MODELS_JSON, "utf8")).providers?.embedding?.baseUrl; } catch { return undefined; } })();
const registry = {
  find: (p, id) => (p === "embedding" ? { __embed: true, provider: p, id, baseUrl: EMBED_BASE } : realRegistry.find(p, id)),
  getApiKeyAndHeaders: async (m) => (m && m.__embed ? { ok: true, apiKey: EMBED_KEY } : realRegistry.getApiKeyAndHeaders(m)),
};
if (!EMBED_KEY) { console.log("SKIP — no SUB2API_API_KEY_EMBEDDING"); process.exit(0); }

const baseSettings = resolveSettings();
function walkMd(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walkMd(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pgRoot = path.join(ABRAIN, "projects", "pi-global");
for (const f of walkMd(pgRoot)) { const e = await parseEntry(f, { scope: "project", root: pgRoot, label: "pi-global" }, pgRoot); if (e && e.status === "active") corpus.push(e); }
const kdir = path.join(ABRAIN, "knowledge");
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }
const bySlug = new Map(corpus.map((e) => [e.slug, e]));

const queries = (process.env.GOLD_QUERIES ? process.env.GOLD_QUERIES.split("|") : [
  "stage1 候选检索改成 embedding 向量",
  "scope filter 必须在 topN 之前执行",
  "git singleflight lock index race condition",
  "sediment 去重 search 走全库 full_body 成本",
  "向量索引是否应该 git 跟踪",
  "T0 盲审 跨厂商 多模型协议",
]);

// 3 跨厂商可达标注员(脚本 registry): deepseek + openai + moonshot
const ANNOTATORS = ["deepseek/deepseek-v4-pro", "openai/gpt-5.5", "kimi-coding/kimi-k2-thinking"];
const VOTE_THRESHOLD = 2;
const POOL_LIMIT = 60;

function annotatePrompt(query, entries) {
  const blocks = entries.map((e) => `### [[${e.slug}]] ${e.title}\n${(e.compiledTruth || e.summary || "").slice(0, 1200)}`).join("\n\n");
  return [
    "你是记忆检索相关性标注员。给定 query 和候选记忆条目, 输出所有**真正相关**的 slug。",
    "相关 = 该条目内容能帮助回答/决策这个 query。宁可多选边界相关的, 但不要选完全无关的。",
    'Output JSON only: {"relevant": ["slug1", "slug2", ...]}. 只用候选里出现的 slug。',
    "", `Query: ${query}`, "", "候选条目:", blocks,
  ].join("\n");
}

function unwrapJson(raw) {
  const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  for (const t of [m?.[1]?.trim(), raw.trim()]) { if (!t) continue; try { return JSON.parse(t); } catch {} }
  const s = raw.indexOf("{"), e = raw.lastIndexOf("}");
  if (s >= 0 && e > s) { try { return JSON.parse(raw.slice(s, e + 1)); } catch {} }
  return null;
}

async function buildGold() {
  const gold = {};
  for (const q of queries) {
    const pool = await selectStage0Pool(q, corpus, { ...baseSettings, search: { ...baseSettings.search, stage0Enabled: true, stage0PoolLimit: POOL_LIMIT, stage0MaxCandidates: POOL_LIMIT } }, registry, {});
    const cand = (pool?.candidateEntries ?? []).slice(0, POOL_LIMIT);
    const votes = new Map();
    let annOk = 0;
    for (const model of ANNOTATORS) {
      try {
        const res = await callSearchModel(model, annotatePrompt(q, cand), registry, undefined, 120000, "off");
        const parsed = unwrapJson(res.rawText);
        const rel = Array.isArray(parsed?.relevant) ? parsed.relevant : [];
        const valid = rel.filter((s) => bySlug.has(s));
        for (const s of new Set(valid)) votes.set(s, (votes.get(s) ?? 0) + 1);
        annOk++;
        console.log(`    ${model}: ${valid.length} relevant`);
      } catch (e) { console.log(`    ${model}: SKIP (${String(e.message).slice(0, 60)})`); }
    }
    const goldSlugs = [...votes.entries()].filter(([, v]) => v >= Math.min(VOTE_THRESHOLD, annOk)).map(([s]) => s);
    gold[q] = { gold: goldSlugs, poolSize: cand.length, annotators: annOk };
    console.log(`  Q: ${q}\n    → gold(≥${VOTE_THRESHOLD}/${annOk} 票)=${goldSlugs.length}: [${goldSlugs.slice(0, 6).join(", ")}]\n`);
  }
  fs.writeFileSync(GOLDSET_PATH, JSON.stringify(gold, null, 2));
  console.log(`金标已存 ${GOLDSET_PATH}\n`);
  return gold;
}

async function evalAgainstGold(gold) {
  const ORACLE_MODEL = process.env.ORACLE_MODEL || "deepseek/deepseek-v4-pro";
  const mk = (skip) => ({ ...baseSettings, search: { ...baseSettings.search, stage0Enabled: true, stage1Model: ORACLE_MODEL, stage2Model: ORACLE_MODEL, stage1Skip: skip } });
  const recall = (hits, g) => (g.length === 0 ? null : hits.filter((s) => g.includes(s)).length / g.length);
  const rThree = [], rTwo = [], cov0 = [];
  for (const q of queries) {
    const g = gold[q]?.gold ?? [];
    if (g.length === 0) { console.log(`  Q: ${q} — gold 空, 跳过`); continue; }
    const three = await llmSearchEntriesWithVerdict(corpus, { query: q }, mk(false), registry);
    const two = await llmSearchEntriesWithVerdict(corpus, { query: q }, mk(true), registry);
    const pool = await selectStage0Pool(q, corpus, mk(true), registry, {});
    const poolSlugs = new Set((pool?.candidateEntries ?? []).map((e) => e.slug));
    const r3 = recall(three.hits.map((h) => h.slug), g), r2 = recall(two.hits.map((h) => h.slug), g);
    const c0 = g.filter((s) => poolSlugs.has(s)).length / g.length;
    rThree.push(r3); rTwo.push(r2); cov0.push(c0);
    console.log(`  Q: ${q} | gold=${g.length}`);
    console.log(`    stage0 coverage@gold=${(c0 * 100).toFixed(0)}%  three-stage recall@gold=${(r3 * 100).toFixed(0)}%  two-stage recall@gold=${(r2 * 100).toFixed(0)}%`);
  }
  const avg = (xs) => xs.filter((x) => x != null).reduce((a, b) => a + b, 0) / Math.max(1, xs.filter((x) => x != null).length);
  console.log(`\n平均: stage0 coverage@gold=${(avg(cov0) * 100).toFixed(1)}%  three-stage recall@gold=${(avg(rThree) * 100).toFixed(1)}%  two-stage recall@gold=${(avg(rTwo) * 100).toFixed(1)}%`);
  console.log(`判定: two-stage recall@gold ≈ three-stage → 删 stage1 不丢真 recall(独立金标, 非循环自证)。`);
}

let gold;
if (fs.existsSync(GOLDSET_PATH) && process.env.FORCE_BUILD !== "1") {
  gold = JSON.parse(fs.readFileSync(GOLDSET_PATH, "utf8"));
  console.log(`复用金标 ${GOLDSET_PATH}(FORCE_BUILD=1 重建)\n`);
} else {
  console.log(`=== build 金标(${ANNOTATORS.length} model 投票, ${queries.length} query)===`);
  gold = await buildGold();
}
console.log(`=== eval recall@gold ===`);
await evalAgainstGold(gold);
