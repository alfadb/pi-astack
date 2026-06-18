#!/usr/bin/env node
/**
 * ADR 0036 P4 条件4(低 stakes ablation): 首段外 chunk 前缀 title 是否净正向。
 * 担心: prefix 把尾段 sub-vector 拉回 title 主题区、稀释 distinctive-tail 信号。
 * 建 no-prefix multi 索引 vs with-prefix multi(现状)在 40 paraphrase-tail query 上比 recall。
 * 复用 scratch dir; 需 ~/.pi/secrets.json 的 embedding key。
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
const MAXCHARS = 3500, MAXCHUNKS = 4, TOPN = 50;
const cfgBase = { baseUrl, apiKey: EMBEDDING.apiKey, model: EMBEDDING.model || "doubao-embedding-vision", dim: EMBEDDING.dim, batchSize: EMBEDDING.batchSize, tpmLimit: EMBEDDING.tpmLimit, timeoutMs: EMBEDDING.timeoutMs, maxRetries: EMBEDDING.maxRetries };
const cfgMultiPre = { ...cfgBase, multiVector: true, multiVectorMaxChunks: MAXCHUNKS, multiVectorTitlePrefix: true };
const cfgMultiNo = { ...cfgBase, multiVector: true, multiVectorMaxChunks: MAXCHUNKS, multiVectorTitlePrefix: false };

function walk(d) { const o = []; if (!fs.existsSync(d)) return o; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) o.push(...walk(p)); else if (e.name.endsWith(".md") && !e.name.startsWith("_")) o.push(p); } return o; }
const corpus = [];
const pg = path.join(ABRAIN, "projects", "pi-global");
for (const f of walk(pg)) { const e = await parseEntry(f, { scope: "project", root: pg, label: "pi-global" }, pg); if (e && e.status === "active") corpus.push(e); }
const kd = path.join(ABRAIN, "knowledge");
for (const f of walk(kd)) { const e = await parseEntry(f, { scope: "world", root: kd, label: "knowledge" }, kd); if (e && e.status === "active") corpus.push(e); }
const bySlug = new Map(corpus.map((e) => [e.slug, e]));
const allowSlugs = new Set(corpus.map((e) => e.slug));

const dir = "/tmp/pi-mv-eval-idx";
const idxPre = path.join(dir, "multi.json");            // with-prefix(oracle-multivector-eval 已建)
const idxNo = path.join(dir, "multi-noprefix.json");
console.log("building with-prefix multi (reuse/refresh)…", JSON.stringify(await buildCorpusEmbeddings(corpus, cfgMultiPre, idxPre, { maxChars: MAXCHARS, skipPrune: true })));
console.log("building no-prefix multi…", JSON.stringify(await buildCorpusEmbeddings(corpus, cfgMultiNo, idxNo, { maxChars: MAXCHARS, skipPrune: true })));
const iPre = new VectorIndex(idxPre, cfgBase.model, cfgBase.dim).load();
const iNo = new VectorIndex(idxNo, cfgBase.model, cfgBase.dim).load();

const qs = ["scripts/.mv-q-gpt.json", "scripts/.mv-q-opus.json"].flatMap((f) => JSON.parse(fs.readFileSync(path.join(repoRoot, f), "utf8"))).filter((q) => bySlug.has(q.slug) && q.query);
const qvs = await embedTexts(qs.map((q) => q.query), cfgBase);
const rankOf = (idx, qv, slug) => { const h = idx.topN(qv, TOPN, { allowSlugs }); const r = h.findIndex((x) => x.slug === slug); return r < 0 ? Infinity : r + 1; };
const stat = { pre: { r1: 0, r10: 0, r50: 0, mrr: 0 }, no: { r1: 0, r10: 0, r50: 0, mrr: 0 } };
for (let i = 0; i < qs.length; i++) {
  const rp = rankOf(iPre, qvs[i], qs[i].slug), rn = rankOf(iNo, qvs[i], qs[i].slug);
  for (const [k, r] of [["pre", rp], ["no", rn]]) { if (r <= 1) stat[k].r1++; if (r <= 10) stat[k].r10++; if (r <= 50) stat[k].r50++; stat[k].mrr += r === Infinity ? 0 : 1 / r; }
}
const n = qs.length, pct = (x) => `${(x / n * 100).toFixed(0)}%`;
console.log(`\ntitle-prefix ablation (n=${n} paraphrase-tail query):`);
console.log(`${"".padEnd(14)} recall@1   recall@10  recall@50  MRR`);
console.log(`with-prefix    ${pct(stat.pre.r1).padStart(4)}       ${pct(stat.pre.r10).padStart(4)}       ${pct(stat.pre.r50).padStart(4)}       ${(stat.pre.mrr / n).toFixed(3)}`);
console.log(`no-prefix      ${pct(stat.no.r1).padStart(4)}       ${pct(stat.no.r10).padStart(4)}       ${pct(stat.no.r50).padStart(4)}       ${(stat.no.mrr / n).toFixed(3)}`);
console.log(`\n判据: with-prefix recall@10/MRR ≥ no-prefix → 前缀净正向(或无害), 保留现状默认 true。`);
