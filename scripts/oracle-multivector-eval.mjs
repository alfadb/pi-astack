#!/usr/bin/env node
/**
 * ADR 0036 P4 验证: 多向量解 3500 截断。
 *
 * 在真实 corpus 上建两套**可复用** scratch 索引(single vs multi, 固定 tmp 路径,
 * content-hash 增量 → 二次跑零重嵌)。三种探针:
 *
 *   默认           : 尾段自检索(verbatim tail / deep-tail-end)+ 短 entry 回归。
 *                    自检索竞争弱(query 极特异), 是盲区的下界探针。
 *   DUMP_TAILS=f   : 把 N 个长 entry 的尾部(chars >maxChars)写到 f, 供 dispatch
 *                    LLM 生成"只能从尾部回答的 distinctive paraphrase query"。
 *   QUERY_FILE=f   : 读 [{slug, query}] 在两套索引上比对 target entry 排名(全库
 *                    1152 竞争 + 语义 paraphrase → 盲区的真实探针)。
 *
 * 需要 ~/.pi/secrets.json 的 embedding key。不碰生产索引。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import { embeddingConfig } from "./_embedding-config.mjs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const ABRAIN = path.join(os.homedir(), ".abrain");
const emb = await jiti.import(path.join(repoRoot, "extensions/memory/embedding.ts"));
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { buildCorpusEmbeddings, VectorIndex, embedTexts } = emb;

const EMBEDDING = embeddingConfig();
if (!EMBEDDING.apiKey || !EMBEDDING.baseUrl) { console.log("SKIP — memory.embedding baseUrl/apiKey not configured"); process.exit(0); }
const baseUrl = EMBEDDING.baseUrl;

const MAXCHARS = Number(process.env.MAXCHARS || 3500);
const MAXCHUNKS = Number(process.env.MAXCHUNKS || 4);
const TOPN = 50;
const cfgBase = { baseUrl, apiKey: EMBEDDING.apiKey, model: EMBEDDING.model || "doubao-embedding-vision", dim: EMBEDDING.dim, batchSize: EMBEDDING.batchSize, tpmLimit: EMBEDDING.tpmLimit, timeoutMs: EMBEDDING.timeoutMs, maxRetries: EMBEDDING.maxRetries };
const cfgSingle = { ...cfgBase, multiVector: false, multiVectorMaxChunks: 1 };
const cfgMulti = { ...cfgBase, multiVector: true, multiVectorMaxChunks: MAXCHUNKS };

function walk(d) { const o = []; if (!fs.existsSync(d)) return o; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) o.push(...walk(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pg = path.join(ABRAIN, "projects", "pi-global");
for (const f of walk(pg)) { const e = await parseEntry(f, { scope: "project", root: pg, label: "pi-global" }, pg); if (e && e.status === "active") corpus.push(e); }
const kd = path.join(ABRAIN, "knowledge");
for (const f of walk(kd)) { const e = await parseEntry(f, { scope: "world", root: kd, label: "knowledge" }, kd); if (e && e.status === "active") corpus.push(e); }
const basisOf = (e) => `${e.title}\n${e.summary}\n${e.compiledTruth}\n${(e.timeline || []).join("\n")}`;
const bySlug = new Map(corpus.map((e) => [e.slug, e]));
const allowSlugs = new Set(corpus.map((e) => e.slug));
console.log(`corpus=${corpus.length} | maxChars=${MAXCHARS} maxChunks=${MAXCHUNKS}`);

// 固定可复用 scratch 目录(content-hash 增量 → 二次零重嵌)
const dir = path.join(os.tmpdir(), "pi-mv-eval-idx");
fs.mkdirSync(dir, { recursive: true });
const idxSinglePath = path.join(dir, "single.json");
const idxMultiPath = path.join(dir, "multi.json");
console.log("building/refreshing single-vector index…");
console.log("  ", JSON.stringify(await buildCorpusEmbeddings(corpus, cfgSingle, idxSinglePath, { maxChars: MAXCHARS, skipPrune: true })));
console.log("building/refreshing multi-vector index…");
console.log("  ", JSON.stringify(await buildCorpusEmbeddings(corpus, cfgMulti, idxMultiPath, { maxChars: MAXCHARS, skipPrune: true })));
const idxSingle = new VectorIndex(idxSinglePath, cfgBase.model, cfgBase.dim).load();
const idxMulti = new VectorIndex(idxMultiPath, cfgBase.model, cfgBase.dim).load();

const rankOf = (idx, qv, slug) => { const hits = idx.topN(qv, TOPN, { allowSlugs }); const r = hits.findIndex((h) => h.slug === slug); return r < 0 ? Infinity : r + 1; };
const longs = corpus.filter((e) => basisOf(e).length > MAXCHARS * 1.2);

// ── DUMP_TAILS: 导出长 entry 尾部供 LLM 生成 query ──
if (process.env.DUMP_TAILS) {
  const N = Number(process.env.SAMPLE || 20);
  const picks = longs.slice().sort((a, b) => basisOf(b).length - basisOf(a).length).slice(0, N); // 最长的优先(尾部最多)
  const tailChars = Number(process.env.TAIL_CHARS || 2500);
  const out = picks.map((e) => ({ slug: e.slug, title: e.title, tail: basisOf(e).slice(MAXCHARS, MAXCHARS * 3).slice(0, tailChars) }));
  fs.writeFileSync(process.env.DUMP_TAILS, JSON.stringify(out, null, 2));
  console.log(`dumped ${out.length} long-entry tails → ${process.env.DUMP_TAILS}`);
  process.exit(0);
}

// ── QUERY_FILE: 外部 LLM 生成的 distinctive paraphrase query ──
if (process.env.QUERY_FILE) {
  // QUERY_FILE 可逗号分隔多文件(多 model 各生成一份, 合并评)
  const qs = process.env.QUERY_FILE.split(",").flatMap((f) => JSON.parse(fs.readFileSync(f.trim(), "utf8"))).filter((q) => bySlug.has(q.slug) && q.query);
  const qvs = await embedTexts(qs.map((q) => q.query), cfgBase);
  const stat = { single: { r1: 0, r10: 0, r50: 0, mrr: 0 }, multi: { r1: 0, r10: 0, r50: 0, mrr: 0 } };
  const rows = [];
  for (let i = 0; i < qs.length; i++) {
    const rsg = rankOf(idxSingle, qvs[i], qs[i].slug), rmg = rankOf(idxMulti, qvs[i], qs[i].slug);
    for (const [k, r] of [["single", rsg], ["multi", rmg]]) { if (r <= 1) stat[k].r1++; if (r <= 10) stat[k].r10++; if (r <= 50) stat[k].r50++; stat[k].mrr += r === Infinity ? 0 : 1 / r; }
    rows.push(`  ${qs[i].slug.slice(0, 44).padEnd(44)} single=#${rsg === Infinity ? ">50" : rsg}  multi=#${rmg === Infinity ? ">50" : rmg}  | ${qs[i].query.slice(0, 54)}`);
  }
  const n = qs.length, pct = (x) => `${(x / n * 100).toFixed(0)}%`;
  console.log(`\nLLM distinctive-tail paraphrase query(n=${n}, 全库竞争):`);
  console.log(rows.join("\n"));
  console.log(`\n  recall@1   single=${pct(stat.single.r1)}  multi=${pct(stat.multi.r1)}`);
  console.log(`  recall@10  single=${pct(stat.single.r10)}  multi=${pct(stat.multi.r10)}`);
  console.log(`  recall@50  single=${pct(stat.single.r50)}  multi=${pct(stat.multi.r50)}`);
  console.log(`  MRR        single=${(stat.single.mrr / n).toFixed(3)}  multi=${(stat.multi.mrr / n).toFixed(3)}`);
  console.log(`\n判定: multi recall@10/@50 > single → 多向量解了 paraphrase 尾部 query 的盲区。`);
  process.exit(0);
}

// ── GOLD_FILE: 位移探针(opus 评审条件 1) —— 用 P6 真实 gold query(含短 entry gold)
//    量 max-sim 会不会把真短-entry 答案从 top-50 挤出(长 entry max-of-4 随机支配序偏差)。
if (process.env.GOLD_FILE) {
  const gold = JSON.parse(fs.readFileSync(process.env.GOLD_FILE, "utf8"));
  const queries = Object.keys(gold).filter((q) => (gold[q]?.gold ?? []).length > 0);
  const qvs = await embedTexts(queries, cfgBase);
  const isShort = (slug) => { const e = bySlug.get(slug); return e ? basisOf(e).length <= MAXCHARS : true; };
  const acc = { short: { s: 0, m: 0, n: 0 }, long: { s: 0, m: 0, n: 0 }, all: { s: 0, m: 0, n: 0 } };
  let evicted = 0, rescued = 0;
  for (let i = 0; i < queries.length; i++) {
    const g = gold[queries[i]].gold.filter((s) => allowSlugs.has(s));
    const sHits = new Set(idxSingle.topN(qvs[i], TOPN, { allowSlugs }).map((h) => h.slug));
    const mHits = new Set(idxMulti.topN(qvs[i], TOPN, { allowSlugs }).map((h) => h.slug));
    for (const slug of g) {
      const bucket = isShort(slug) ? acc.short : acc.long;
      const inS = sHits.has(slug), inM = mHits.has(slug);
      bucket.n++; acc.all.n++;
      if (inS) { bucket.s++; acc.all.s++; }
      if (inM) { bucket.m++; acc.all.m++; }
      if (inS && !inM) { evicted++; if (isShort(slug)) console.log(`  EVICTED(short) ${slug.slice(0,50)} ← ${queries[i].slice(0,30)}`); }
      if (!inS && inM) rescued++;
    }
  }
  const r = (x, n) => n ? `${(x / n * 100).toFixed(0)}%` : "-";
  console.log(`\n位移探针(P6 gold, ${queries.length} query, recall@${TOPN}):`);
  console.log(`  短 gold entry(n=${acc.short.n}): single=${r(acc.short.s, acc.short.n)}  multi=${r(acc.short.m, acc.short.n)}  ${acc.short.m >= acc.short.s ? "✓ 无挤出" : "⚠ multi 低于 single = 挤出损害"}`);
  console.log(`  长 gold entry(n=${acc.long.n}): single=${r(acc.long.s, acc.long.n)}  multi=${r(acc.long.m, acc.long.n)}`);
  console.log(`  全部 gold(n=${acc.all.n}): single=${r(acc.all.s, acc.all.n)}  multi=${r(acc.all.m, acc.all.n)}`);
  console.log(`  gold 被 multi 挤出 top-50: ${evicted}; 被 multi 拉回: ${rescued}`);
  console.log(`\n判据: 短 gold recall@50 multi ≥ single → max-sim 无 crowding 挤出损害(opus 条件 1)。`);
  process.exit(0);
}

// ── 默认: 尾段自检索(verbatim + deep-end)+ 短 entry 回归 ──
const mData = JSON.parse(fs.readFileSync(idxMultiPath, "utf8"));
let subVecs = 0, multiEntries = 0;
for (const rec of Object.values(mData.entries)) { subVecs += rec.vecs.length; if (rec.vecs.length > 1) multiEntries++; }
console.log(`multi index: ${Object.keys(mData.entries).length} entries, ${subVecs} sub-vectors, ${multiEntries} 个 >1 chunk\n`);

async function probe(label, queries, slugs) {
  const qvs = await embedTexts(queries, cfgBase);
  const stat = { single: { r1: 0, r10: 0, r50: 0, mrr: 0 }, multi: { r1: 0, r10: 0, r50: 0, mrr: 0 } };
  for (let i = 0; i < slugs.length; i++) {
    const rsg = rankOf(idxSingle, qvs[i], slugs[i]), rmg = rankOf(idxMulti, qvs[i], slugs[i]);
    for (const [k, r] of [["single", rsg], ["multi", rmg]]) { if (r <= 1) stat[k].r1++; if (r <= 10) stat[k].r10++; if (r <= 50) stat[k].r50++; stat[k].mrr += r === Infinity ? 0 : 1 / r; }
  }
  const n = slugs.length, pct = (x) => `${(x / n * 100).toFixed(0)}%`;
  console.log(`${label}(n=${n}): recall@1 s=${pct(stat.single.r1)}/m=${pct(stat.multi.r1)}  @10 s=${pct(stat.single.r10)}/m=${pct(stat.multi.r10)}  @50 s=${pct(stat.single.r50)}/m=${pct(stat.multi.r50)}  MRR s=${(stat.single.mrr / n).toFixed(3)}/m=${(stat.multi.mrr / n).toFixed(3)}`);
}
await probe("verbatim 整尾段[3500:7000]", longs.map((e) => basisOf(e).slice(MAXCHARS, MAXCHARS * 2)), longs.map((e) => e.slug));
const deepLongs = corpus.filter((e) => basisOf(e).length > MAXCHARS * 1.5);
await probe("deep-tail-end 末800字", deepLongs.map((e) => basisOf(e).slice(-800)), deepLongs.map((e) => e.slug));
const shorts = corpus.filter((e) => basisOf(e).length <= MAXCHARS).slice(0, 40);
await probe("短 entry 回归 head[:400]", shorts.map((e) => basisOf(e).slice(0, 400)), shorts.map((e) => e.slug));
console.log(`\n自检索竞争弱 → 是盲区下界; 真实探针见 DUMP_TAILS → LLM gen → QUERY_FILE。`);
