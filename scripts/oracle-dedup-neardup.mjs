#!/usr/bin/env node
/**
 * ADR 0036 P5b + P4 条件1 验证: sediment dedup 的 **false-merge 面**。
 *
 * dedup 是 memory_search 最脆弱路径(false-merge → corpus corruption, 比漏召严重)。
 * 评价 = 近重检测: 候选生成把"应合并的近重对"surface 进 top-K(recall), 同时不把
 * "相似但 distinct 的硬负对"surface(intrusion = false-merge 面)。
 *
 * 复用 oracle-multivector-eval 的 scratch 索引(/tmp/pi-mv-eval-idx/{single,multi}.json),
 * active corpus = dedup dense 候选面(非 active 不在 dense 索引, 只走 sparse)。
 *
 * MODE=seed_dump  : single-dense 近邻挖 cosine band 相似对 → 写 PAIRS_OUT 供 3×T0 标注。
 * MODE=eval       : 读 VOTES(逗号分隔多 model)→ 多数票 gold → 量四种聚合的
 *                   distinct-intrusion@K / merge-recall@K:
 *                     single-maxsim | multi-maxsim | multi-chunk0 | multi-mean
 *                   判定 P4 条件1(multi 是否抬高 intrusion → 需 dedup 分离)。
 *
 * 需要 scratch 索引(先跑 oracle-multivector-eval.mjs 建)。eval 模式不需 embedding key。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);
const ABRAIN = path.join(os.homedir(), ".abrain");
const { parseEntry } = await jiti.import(path.join(repoRoot, "extensions/memory/parser.ts"));
const { VectorIndex } = await jiti.import(path.join(repoRoot, "extensions/memory/embedding.ts"));

const DIR = "/tmp/pi-mv-eval-idx";
const SINGLE = path.join(DIR, "single.json");
const MULTI = path.join(DIR, "multi.json");
if (!fs.existsSync(SINGLE) || !fs.existsSync(MULTI)) {
  console.log("SKIP — scratch 索引不存在, 先跑 oracle-multivector-eval.mjs 建 /tmp/pi-mv-eval-idx/"); process.exit(0);
}

// active corpus(与 dense 索引一致)
function walk(d) { const o = []; if (!fs.existsSync(d)) return o; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) o.push(...walk(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pg = path.join(ABRAIN, "projects", "pi-global");
for (const f of walk(pg)) { const e = await parseEntry(f, { scope: "project", root: pg, label: "pi-global" }, pg); if (e && e.status === "active") corpus.push(e); }
const kd = path.join(ABRAIN, "knowledge");
for (const f of walk(kd)) { const e = await parseEntry(f, { scope: "world", root: kd, label: "knowledge" }, kd); if (e && e.status === "active") corpus.push(e); }
const bySlug = new Map(corpus.map((e) => [e.slug, e]));
const allowSlugs = new Set(corpus.map((e) => e.slug));

// 原始 vecs(算 chunk0 / mean)
const rawMulti = JSON.parse(fs.readFileSync(MULTI, "utf8")).entries; // {slug:{vecs,scheme,...}}
const rawSingle = JSON.parse(fs.readFileSync(SINGLE, "utf8")).entries;
const idxSingle = new VectorIndex(SINGLE, "doubao-embedding-vision", 2048).load();

const norm = (v) => { let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1; return v.map((x) => x / n); };
const dot = (a, b) => { let d = 0; const L = Math.min(a.length, b.length); for (let i = 0; i < L; i++) d += a[i] * b[i]; return d; };
const meanVec = (vecs) => { const L = vecs[0].length; const m = new Array(L).fill(0); for (const v of vecs) for (let i = 0; i < L; i++) m[i] += v[i]; for (let i = 0; i < L; i++) m[i] /= vecs.length; return m; };

if (process.env.MODE === "seed_dump") {
  const LO = Number(process.env.BAND_LO || 0.55), HI = Number(process.env.BAND_HI || 0.93);
  const pairKey = (a, b) => [a, b].sort().join("\u0001");
  const seen = new Map(); // pairKey → {a,b,cos}
  for (const e of corpus) {
    const rec = rawSingle[e.slug]; if (!rec) continue;
    const qv = rec.vecs[0];
    const hits = idxSingle.topN(qv, 5, { exclude: new Set([e.slug]), allowSlugs });
    for (const h of hits) {
      if (h.score < LO || h.score > HI) continue;
      const k = pairKey(e.slug, h.slug);
      const prev = seen.get(k);
      if (!prev || h.score > prev.cos) seen.set(k, { a: e.slug, b: h.slug, cos: h.score });
    }
  }
  // 分层抽样: 高 [0.8,0.93] / 中 [0.67,0.8) / 低 [0.55,0.67)
  const all = [...seen.values()].sort((x, y) => y.cos - x.cos);
  const band = (c) => (c >= 0.8 ? "hi" : c >= 0.67 ? "mid" : "lo");
  const want = { hi: Number(process.env.N_HI || 22), mid: Number(process.env.N_MID || 22), lo: Number(process.env.N_LO || 16) };
  const got = { hi: 0, mid: 0, lo: 0 };
  const picks = [];
  for (const p of all) { const b = band(p.cos); if (got[b] < want[b]) { picks.push(p); got[b]++; } }
  const exc = (e, n) => `${e.title}\n${e.summary}\n${(e.compiledTruth || "").slice(0, n)}`.slice(0, n + 200);
  const out = picks.map((p, i) => ({
    id: i + 1, cos: Number(p.cos.toFixed(4)), a_slug: p.a, b_slug: p.b,
    A: exc(bySlug.get(p.a), 700), B: exc(bySlug.get(p.b), 700),
  }));
  fs.writeFileSync(process.env.PAIRS_OUT || path.join(DIR, "neardup-pairs.json"), JSON.stringify(out, null, 2));
  console.log(`corpus=${corpus.length} | 候选相似对=${seen.size} | 抽样=${out.length} (hi=${got.hi} mid=${got.mid} lo=${got.lo}) → ${process.env.PAIRS_OUT || path.join(DIR, "neardup-pairs.json")}`);
  process.exit(0);
}

if (process.env.MODE === "delta_probe") {
  // P4 条件1 真正的风险探针: multi-maxsim 是否把 single 不在 top-K 的 entry **新拉进**
  // dedup 邻居集(共享 boilerplate/尾段 chunk → 高 max-sim)。这才是多向量引入的
  // false-merge 注入面。递合率高+新邻居多为 distinct → 需 dedup 分离。
  const K = Number(process.env.K || 5);
  const allSlugs = corpus.map((e) => e.slug).filter((s) => rawMulti[s] && rawSingle[s]);
  // 预归一化(一次), 避免 O(n²) 重复 normalize
  const nSingle = new Map(allSlugs.map((s) => [s, [Float32Array.from(norm(rawSingle[s].vecs[0]))]]));
  const nMulti = new Map(allSlugs.map((s) => [s, rawMulti[s].vecs.map((v) => Float32Array.from(norm(v)))]));
  const fdot = (a, b) => { let d = 0; const L = Math.min(a.length, b.length); for (let i = 0; i < L; i++) d += a[i] * b[i]; return d; };
  const meanF = (vs) => { const L = vs[0].length; const m = new Float64Array(L); for (const v of vs) for (let i = 0; i < L; i++) m[i] += v[i]; return Float32Array.from(norm(Array.from(m))); };
  const nChunk0 = new Map(allSlugs.map((s) => [s, [nMulti.get(s)[0]]]));        // multi chunk0 只取首段
  const nMean = new Map(allSlugs.map((s) => [s, [meanF(nMulti.get(s))]]));        // multi 各 chunk 均值
  const mapOf = (mode) => mode === "single" ? nSingle : mode === "chunk0" ? nChunk0 : mode === "mean" ? nMean : nMulti;
  const topkSet = (slug, mode) => {
    const tmap = mapOf(mode);
    const qset = tmap.get(slug);
    const sims = [];
    for (const t of allSlugs) {
      if (t === slug) continue;
      const tv = tmap.get(t);
      let best = -Infinity;
      for (const q of qset) for (const v of tv) { const s = fdot(q, v); if (s > best) best = s; }
      sims.push({ slug: t, score: best });
    }
    sims.sort((a, b) => b.score - a.score);
    return sims.slice(0, K);
  };
  // chunk0 / mean 相对 single 的新增邻居计数(验证 dedup 分离聚合是否恢复 single 行为)
  if (process.env.RESTORE_CHECK) {
    let dC0 = 0, dMean = 0, dMax = 0;
    const sample = allSlugs.slice(0, Number(process.env.SAMPLE || 600));
    for (const slug of sample) {
      const sSet = new Set(topkSet(slug, "single").map((h) => h.slug));
      dMax += topkSet(slug, "multi").filter((h) => !sSet.has(h.slug)).length;
      dC0 += topkSet(slug, "chunk0").filter((h) => !sSet.has(h.slug)).length;
      dMean += topkSet(slug, "mean").filter((h) => !sSet.has(h.slug)).length;
    }
    console.log(`RESTORE_CHECK(n=${sample.length}, K=${K}): 相对 single top-${K} 的新增邻居总数`);
    console.log(`  multi-maxsim: ${dMax}  |  multi-chunk0: ${dC0}  |  multi-mean: ${dMean}`);
    console.log(`  判据: chunk0 新增≈0 → dedup 用 chunk0 聚合 = 恢复转产前单向量 dedup 行为, false-merge 面不变。`);
    process.exit(0);
  }
  let totalNew = 0, entriesWithNew = 0, longEntriesWithNew = 0;
  const newPairs = [];
  const basisLen = (e) => `${e.title}\n${e.summary}\n${e.compiledTruth}\n${(e.timeline||[]).join("\n")}`.length;
  const SAMPLE = process.env.SAMPLE ? Number(process.env.SAMPLE) : allSlugs.length;
  const probeSlugs = allSlugs.slice(0, SAMPLE);
  for (const slug of probeSlugs) {
    const sSet = new Set(topkSet(slug, "single").map((h) => h.slug));
    const mHits = topkSet(slug, "multi");
    const news = mHits.filter((h) => !sSet.has(h.slug));
    if (news.length) { entriesWithNew++; if (basisLen(bySlug.get(slug)) > 3500) longEntriesWithNew++; }
    totalNew += news.length;
    for (const h of news) newPairs.push({ a: slug, b: h.slug, score: Number(h.score.toFixed(4)), aLong: basisLen(bySlug.get(slug)) > 3500 });
  }
  console.log(`delta-probe(K=${K}, n=${probeSlugs.length} entries): multi-maxsim 相对 single top-${K} 的**新增邻居**`);
  console.log(`  总新增邻居对: ${totalNew} | 有新增的 entry: ${entriesWithNew}/${probeSlugs.length} (${(entriesWithNew/probeSlugs.length*100).toFixed(1)}%)`);
  console.log(`  其中 query entry 是长 entry(>3500): ${longEntriesWithNew}`);
  const top = newPairs.sort((a, b) => b.score - a.score).slice(0, 25);
  console.log(`  高分新增邻居 top-${top.length}(score | aLong | a ~ b):`);
  for (const p of top) console.log(`    ${p.score} ${p.aLong?"L":" "} | ${p.a.slice(0,34)} ~ ${p.b.slice(0,34)}`);
  if (process.env.DELTA_OUT) {
    const exc = (e, n) => `${e.title}\n${e.summary}\n${(e.compiledTruth || "").slice(0, n)}`.slice(0, n + 200);
    const dump = top.map((p, i) => ({ id: i + 1, score: p.score, a_slug: p.a, b_slug: p.b, A: exc(bySlug.get(p.a), 700), B: exc(bySlug.get(p.b), 700) }));
    fs.writeFileSync(process.env.DELTA_OUT, JSON.stringify(dump, null, 2));
    console.log(`  → dump ${dump.length} 新增邻居对 → ${process.env.DELTA_OUT}(供标注: 这些是 multi 独有的候选, distinct 占比 = false-merge 注入率)`);
  }
  process.exit(0);
}

if (process.env.MODE === "eval") {
  const pairs = JSON.parse(fs.readFileSync(process.env.PAIRS || path.join(DIR, "neardup-pairs.json"), "utf8"));
  // VOTES = 逗号分隔多 model 投票文件; 每个 [{id, verdict:"merge"|"distinct"}]
  const voteFiles = (process.env.VOTES || "").split(",").map((s) => s.trim()).filter(Boolean);
  const votesByModel = voteFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
  const goldOf = (id) => {
    let m = 0, d = 0;
    for (const vm of votesByModel) { const v = vm.find((x) => Number(x.id) === Number(id)); if (!v) continue; if (/merge/i.test(v.verdict)) m++; else if (/distinct/i.test(v.verdict)) d++; }
    if (m === 0 && d === 0) return null;
    return m > d ? "merge" : d > m ? "distinct" : "tie";
  };

  // 四种聚合的 query 向量(以 A 为 query, 查 B 排名)
  const vecsFor = (slug, mode) => {
    const r = rawMulti[slug]; if (!r) return null;
    if (mode === "single-maxsim") return [rawSingle[slug]?.vecs?.[0]].filter(Boolean);
    if (mode === "multi-maxsim") return r.vecs;
    if (mode === "multi-chunk0") return [r.vecs[0]];
    if (mode === "multi-mean") return [meanVec(r.vecs)];
    return null;
  };
  // 预归一: 每 entry 每 mode 的向量集
  const indexVecs = {}; // mode → [{slug, vs:normed[]}]
  for (const mode of ["single-maxsim", "multi-maxsim", "multi-chunk0", "multi-mean"]) {
    indexVecs[mode] = corpus.map((e) => ({ slug: e.slug, vs: (vecsFor(e.slug, mode) || []).map(norm) })).filter((x) => x.vs.length);
  }
  // A 为 query(取 A 的聚合向量集, 与库做 max-sim), 求 B 的排名
  const rankOfB = (aSlug, bSlug, mode) => {
    const qset = (vecsFor(aSlug, mode) || []).map(norm); if (!qset.length) return Infinity;
    const sims = [];
    for (const rec of indexVecs[mode]) {
      if (rec.slug === aSlug) continue;
      let best = -Infinity;
      for (const qv of qset) for (const v of rec.vs) { const s = dot(qv, v); if (s > best) best = s; }
      sims.push({ slug: rec.slug, score: best });
    }
    sims.sort((x, y) => y.score - x.score);
    const r = sims.findIndex((s) => s.slug === bSlug);
    return r < 0 ? Infinity : r + 1;
  };

  const MODES = ["single-maxsim", "multi-maxsim", "multi-chunk0", "multi-mean"];
  const stat = {};
  for (const m of MODES) stat[m] = { mergeRecall5: 0, mergeRecall10: 0, mergeN: 0, distIntrude5: 0, distIntrude10: 0, distN: 0 };
  let merge = 0, distinct = 0, tie = 0, nogold = 0;
  const rows = [];
  for (const p of pairs) {
    const g = goldOf(p.id);
    if (!g) { nogold++; continue; }
    if (g === "tie") { tie++; continue; }
    if (g === "merge") merge++; else distinct++;
    const rr = {};
    for (const m of MODES) {
      // 取 A→B 与 B→A 的最优排名(dedup 是对称近重)
      const r = Math.min(rankOfB(p.a_slug, p.b_slug, m), rankOfB(p.b_slug, p.a_slug, m));
      rr[m] = r;
      const s = stat[m];
      if (g === "merge") { s.mergeN++; if (r <= 5) s.mergeRecall5++; if (r <= 10) s.mergeRecall10++; }
      else { s.distN++; if (r <= 5) s.distIntrude5++; if (r <= 10) s.distIntrude10++; }
    }
    rows.push(`  #${String(p.id).padStart(2)} ${g.padEnd(8)} cos=${p.cos} | s=${rr["single-maxsim"]===Infinity?">N":rr["single-maxsim"]} mMax=${rr["multi-maxsim"]===Infinity?">N":rr["multi-maxsim"]} mC0=${rr["multi-chunk0"]===Infinity?">N":rr["multi-chunk0"]} mMean=${rr["multi-mean"]===Infinity?">N":rr["multi-mean"]} | ${p.a_slug.slice(0,28)} ~ ${p.b_slug.slice(0,28)}`);
  }
  console.log(`gold: merge=${merge} distinct=${distinct} tie=${tie} nogold=${nogold} (votes from ${votesByModel.length} models)\n`);
  console.log(rows.join("\n"));
  const pct = (x, n) => n ? `${(x / n * 100).toFixed(0)}%` : "-";
  console.log(`\n${"mode".padEnd(15)} | merge-recall@5  @10 (n=${merge}) | distinct-INTRUSION@5  @10 (n=${distinct}, 越低越好=false-merge 面)`);
  for (const m of MODES) {
    const s = stat[m];
    console.log(`${m.padEnd(15)} |   ${pct(s.mergeRecall5,s.mergeN).padStart(4)}        ${pct(s.mergeRecall10,s.mergeN).padStart(4)}        |   ${pct(s.distIntrude5,s.distN).padStart(4)}              ${pct(s.distIntrude10,s.distN).padStart(4)}`);
  }
  console.log(`\n判定 P4 条件1: multi-maxsim distinct-intrusion@5 > single-maxsim → max-sim 抬高 false-merge 面 → 需 dedup 分离;`);
  console.log(`             chunk0/mean intrusion@5 回到 ≤ single 且 merge-recall 不退 → 该聚合可作 dedup 专用通道。`);
  console.log(`判定 P5b: single-maxsim(dense-only 候选)intrusion@5 低 → 候选面已干净, 移除 stage1/stage2 rerank 不引新 false-merge 面。`);
  process.exit(0);
}

console.log("用法: MODE=seed_dump 或 MODE=eval (见文件头)");
process.exit(1);
