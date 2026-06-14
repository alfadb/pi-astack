#!/usr/bin/env node
/**
 * ADR 0036 P2: 跨厂商投票金标集 + recall@gold 评估(跨过 derives_from 循环自证)。
 *
 * 标注**不在脚本里调 model**(脚本路线已证伪: sub2api SPA-200 陷阱 + 各 provider
 * auth 差异 → 裸 fetch / callSearchModel 标注 0 票)。正确路径 = 主会话
 * dispatch_parallel 派跨厂商 T0 标注。本脚本只做三件确定性的事:
 *
 *   MODE=material  : 每 query 取 stage0 宽候选池(POOL_LIMIT), 导出 batch 材料
 *                    (slug+title+body 截断)供 dispatch_parallel 标注。不调 LLM。
 *   MODE=aggregate : 读 .goldset/votes-*.json(每文件 = 一个标注 model 的
 *                    {query_id: [slug...]}), ≥min(2,N) 票 = gold, 写 goldset.json。
 *   MODE=eval      : 读 goldset.json, 跑 two-stage(stage1Skip) vs three-stage 的
 *                    recall@gold + stage0 coverage@gold(候选窗口 = candidateLimit)。
 *
 * 金标基于 model 读 query+entry 内容投票, 不靠 sediment 建立的 derives_from/related
 * (去系统正偏); 候选池(POOL_LIMIT=80)宽于 two-stage 候选窗口(candidateLimit=50),
 * 避免“金标候选池 == 被评估池”的循环。
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
const GOLD_DIR = path.join(__dirname, ".goldset");
const GOLDSET_PATH = path.join(__dirname, "goldset.json");
const QUERIES_PATH = path.join(__dirname, "goldset-queries.json");

const MODE = process.env.MODE || "eval";
const POOL_LIMIT = Number(process.env.POOL_LIMIT || 80); // 金标候选池宽度(> two-stage candidateLimit=50)
const BODY_CHARS = Number(process.env.BODY_CHARS || 380); // 每候选 compiledTruth 截断(控单 query 文件 <50KB read 上限)
const BATCHES = Number(process.env.BATCHES || 2);         // dispatch 批次(控单 sub-agent 读取量)
const VOTE_MIN = 2;

const QUERIES = JSON.parse(fs.readFileSync(QUERIES_PATH, "utf8"));

const llm = await jiti.import(path.join(repoRoot, "extensions/memory/llm-search.ts"));
const { llmSearchEntriesWithVerdict, selectStage0Pool } = llm;
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { resolveSettings } = await jiti.import(path.join(repoRoot, "extensions/memory/settings.ts"));

const realRegistry = ModelRegistry.create(AuthStorage.create(), MODELS_JSON);
const EMBED_KEY = process.env.SUB2API_API_KEY_EMBEDDING;
const EMBED_BASE = (() => { try { return JSON.parse(fs.readFileSync(MODELS_JSON, "utf8")).providers?.embedding?.baseUrl; } catch { return undefined; } })();
const registry = {
  find: (p, id) => (p === "embedding" ? { __embed: true, provider: p, id, baseUrl: EMBED_BASE } : realRegistry.find(p, id)),
  getApiKeyAndHeaders: async (m) => (m && m.__embed ? { ok: true, apiKey: EMBED_KEY } : realRegistry.getApiKeyAndHeaders(m)),
};

const baseSettings = resolveSettings();
function walkMd(dir) { const o = []; if (!fs.existsSync(dir)) return o; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) o.push(...walkMd(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pgRoot = path.join(ABRAIN, "projects", "pi-global");
for (const f of walkMd(pgRoot)) { const e = await parseEntry(f, { scope: "project", root: pgRoot, label: "pi-global" }, pgRoot); if (e && e.status === "active") corpus.push(e); }
const kdir = path.join(ABRAIN, "knowledge");
for (const f of walkMd(kdir)) { const e = await parseEntry(f, { scope: "world", root: kdir, label: "knowledge" }, kdir); if (e && e.status === "active") corpus.push(e); }
const bySlug = new Map(corpus.map((e) => [e.slug, e]));

// ─────────────────────────── MODE=material ───────────────────────────
async function buildMaterial() {
  if (!EMBED_KEY) { console.log("FATAL — no SUB2API_API_KEY_EMBEDDING(material 需 embedding 建池)"); process.exit(1); }
  fs.mkdirSync(GOLD_DIR, { recursive: true });
  const poolSettings = { ...baseSettings, search: { ...baseSettings.search, stage0Enabled: true, stage0PoolLimit: POOL_LIMIT, stage0MaxCandidates: POOL_LIMIT } };
  // 每 query 一个 compact 文件(单文件 <50KB, sub-agent 一次 read 读全, 不撞 read 截断)。
  for (const { id, query } of QUERIES) {
    const pool = await selectStage0Pool(query, corpus, poolSettings, registry, {});
    const cand = (pool?.candidateEntries ?? []).slice(0, POOL_LIMIT);
    const candidates = cand.map((e) => ({
      slug: e.slug,
      title: e.title.replace(/\s+/g, " ").trim(),
      body: (e.compiledTruth || e.summary || "").replace(/\s+/g, " ").trim().slice(0, BODY_CHARS),
    }));
    const file = path.join(GOLD_DIR, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id, query, candidates })); // compact 单行
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`  ${id}: pool=${candidates.length} mode=${pool?.mode} dense=${pool?.denseCount} → ${kb}KB`);
  }
  // batch 分组(只是 dispatch 分配清单, 控单 sub-agent 读取量; 不写大文件)
  const per = Math.ceil(QUERIES.length / BATCHES);
  const assign = [];
  for (let b = 0; b < BATCHES; b++) {
    const ids = QUERIES.slice(b * per, (b + 1) * per).map((q) => q.id);
    if (ids.length) assign.push({ batch: b + 1, ids });
  }
  fs.writeFileSync(path.join(GOLD_DIR, "batches.json"), JSON.stringify({ poolLimit: POOL_LIMIT, batches: assign }, null, 2));
  console.log(`\n材料已导出 ${GOLD_DIR}/q*.json(每 query 一个 compact 文件)。batch 分配:`);
  for (const a of assign) console.log(`  batch-${a.batch}: ${a.ids.join(", ")}`);
  console.log(`下一步: 主会话 dispatch_parallel 派跨厂商 T0, 每个 model 读其 batch 的 q*.json 输出 {id:[slug...]},`);
  console.log(`写回 ${GOLD_DIR}/votes-<model>.json, 再 MODE=aggregate。`);
}

// ─────────────────────────── MODE=aggregate ──────────────────────────
function aggregateVotes() {
  if (!fs.existsSync(GOLD_DIR)) { console.log(`FATAL — ${GOLD_DIR} 不存在`); process.exit(1); }
  const voteFiles = fs.readdirSync(GOLD_DIR).filter((f) => f.startsWith("votes-") && f.endsWith(".json"));
  if (voteFiles.length === 0) { console.log("FATAL — 无 votes-*.json"); process.exit(1); }
  console.log(`聚合 ${voteFiles.length} 个标注: ${voteFiles.join(", ")}\n`);
  // votes[id] = Map(slug → count)
  const votes = new Map(QUERIES.map((q) => [q.id, new Map()]));
  const annByQuery = new Map(QUERIES.map((q) => [q.id, 0]));
  for (const vf of voteFiles) {
    const data = JSON.parse(fs.readFileSync(path.join(GOLD_DIR, vf), "utf8"));
    for (const { id } of QUERIES) {
      const raw = data[id];
      if (!Array.isArray(raw)) continue; // 该标注没覆盖此 query
      annByQuery.set(id, annByQuery.get(id) + 1);
      const m = votes.get(id);
      // 仅计入真实存在的 slug(防 model 幻觉 slug)
      for (const s of new Set(raw)) if (bySlug.has(s)) m.set(s, (m.get(s) ?? 0) + 1);
    }
  }
  const gold = {};
  for (const { id, query } of QUERIES) {
    const m = votes.get(id);
    const ann = annByQuery.get(id);
    const thr = Math.min(VOTE_MIN, Math.max(1, ann));
    const goldSlugs = [...m.entries()].filter(([, c]) => c >= thr).sort((a, b) => b[1] - a[1]).map(([s]) => s);
    const voteObj = Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
    gold[query] = { gold: goldSlugs, annotators: ann, threshold: thr, votes: voteObj };
    console.log(`  ${id} (${query.slice(0, 36)}…) ann=${ann} thr=${thr} → gold=${goldSlugs.length}: [${goldSlugs.slice(0, 5).join(", ")}]`);
  }
  fs.writeFileSync(GOLDSET_PATH, JSON.stringify(gold, null, 2));
  console.log(`\n金标已写 ${GOLDSET_PATH}`);
}

// ───────────────────────────── MODE=eval ─────────────────────────────
async function evalAgainstGold() {
  if (!EMBED_KEY) { console.log("FATAL — no SUB2API_API_KEY_EMBEDDING(eval 需 embedding)"); process.exit(1); }
  if (!fs.existsSync(GOLDSET_PATH)) { console.log(`FATAL — ${GOLDSET_PATH} 不存在(先 material → dispatch → aggregate)`); process.exit(1); }
  const gold = JSON.parse(fs.readFileSync(GOLDSET_PATH, "utf8"));
  // ADR 0036 §9.1 条件 5(opus): 默认用**生产型号**(resolveSettings: stage1=v4-flash,
  // stage2=M3)表征真正被 flip 的管道; 且 v4-flash/M3 都不是 4-voter gold 标注员
  // (annotator 是 v4-PRO, M3 被排除) → 同时兑现条件 4a held-out oracle。
  // ORACLE_MODEL 覆写两阶段(向后兼容 v4-pro 同模型跑); STAGE1_MODEL/STAGE2_MODEL 分别覆写。
  const s1Model = process.env.STAGE1_MODEL || process.env.ORACLE_MODEL || baseSettings.search.stage1Model;
  const s2Model = process.env.STAGE2_MODEL || process.env.ORACLE_MODEL || baseSettings.search.stage2Model;
  const mk = (skip) => ({ ...baseSettings, search: { ...baseSettings.search, stage0Enabled: true, stage1Model: s1Model, stage2Model: s2Model, stage1Skip: skip } });
  // candidateLimit = max(stage2Limit, stage1Limit) = two-stage 实际看到的 stage0 候选窗口
  const candidateLimit = Math.max(baseSettings.search.stage2Limit, baseSettings.search.stage1Limit);
  const recall = (hits, g) => (g.length === 0 ? null : hits.filter((s) => g.includes(s)).length / g.length);
  const rThree = [], rTwo = [], covWin = [];
  console.log(`eval | stage1=${s1Model} stage2=${s2Model} | corpus=${corpus.length} | candidateLimit(two-stage 窗口)=${candidateLimit}\n`);
  for (const { query } of QUERIES) {
    const g = gold[query]?.gold ?? [];
    if (g.length === 0) { console.log(`  Q: ${query.slice(0, 40)}… — gold 空, 跳过`); continue; }
    const three = await llmSearchEntriesWithVerdict(corpus, { query }, mk(false), registry);
    const two = await llmSearchEntriesWithVerdict(corpus, { query }, mk(true), registry);
    // 用生产 poolLimit(300)取 stage0 池, 截到 candidateLimit = two-stage 真实候选窗口
    const pool = await selectStage0Pool(query, corpus, mk(true), registry, {});
    const win = new Set((pool?.candidateEntries ?? []).slice(0, candidateLimit).map((e) => e.slug));
    const r3 = recall(three.hits.map((h) => h.slug), g), r2 = recall(two.hits.map((h) => h.slug), g);
    const cw = g.filter((s) => win.has(s)).length / g.length;
    rThree.push(r3); rTwo.push(r2); covWin.push(cw);
    console.log(`  Q: ${query.slice(0, 40)}… | gold=${g.length}`);
    console.log(`    stage0 coverage@gold(窗口 top-${candidateLimit})=${(cw * 100).toFixed(0)}%  three=${(r3 * 100).toFixed(0)}%  two=${(r2 * 100).toFixed(0)}%`);
  }
  const avg = (xs) => { const v = xs.filter((x) => x != null); return v.reduce((a, b) => a + b, 0) / Math.max(1, v.length); };
  console.log(`\n平均(n=${rThree.length}): coverage@gold(窗口)=${(avg(covWin) * 100).toFixed(1)}%  three-stage recall@gold=${(avg(rThree) * 100).toFixed(1)}%  two-stage recall@gold=${(avg(rTwo) * 100).toFixed(1)}%`);
  console.log(`判定: two-stage recall@gold ≈ three-stage → 删 stage1 不丢真 recall(独立跨厂商金标, 非 derives_from 循环)。`);
}

if (MODE === "material") { console.log(`=== MODE=material(POOL_LIMIT=${POOL_LIMIT}, ${QUERIES.length} query, ${BATCHES} batch)===`); await buildMaterial(); }
else if (MODE === "aggregate") { console.log(`=== MODE=aggregate ===`); aggregateVotes(); }
else { console.log(`=== MODE=eval ===`); await evalAgainstGold(); }
