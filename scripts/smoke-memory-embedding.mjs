#!/usr/bin/env node
/**
 * Smoke: ADR 0035 P1 — memory/embedding.ts stage0 向量召回基建。
 *
 * 验证(真实 doubao-embedding-vision @ sub2api endpoint + 本地余弦):
 *   1. embedTexts: batch≤10 分块,返回正确维度向量
 *   2. VectorIndex upsert + topN: self-retrieval(title→自身)区分度
 *   3. buildCorpusEmbeddings 增量: 二次跑全部 content-hash 跳过(embedded=0)
 *   4. content-hash 失效: 改 body 只重算该条(embedded=1)
 *   5. prune: 移除的 slug 被丢弃
 *   6. 版本戳: 换 model 名 load → 空索引(强制重建,禁跨模型混用)
 *
 * 需要 pi-astack-settings.json → memory.embedding 的 baseUrl/apiKey。
 * 缺配置时 SKIP HTTP 用例,仍跑纯本地用例(2/5/6 的索引逻辑)。
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

let passed = 0;
const failures = [];
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ── transpile + CJS load with dependency stubs ───────────────────────────
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
  Module._load = function patched(request, parent, ...rest) {
    if (stubMap.has(request)) return stubMap.get(request);
    return origLoad.call(this, request, parent, ...rest);
  };
  try {
    m._compile(code, fakePath);
  } finally {
    Module._load = origLoad;
  }
  return m.exports;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-emb-"));
const runtimeStub = {
  abrainStateDir: (home) => path.join(home, ".state"),
  resolveUserGlobalAbrainHome: () => tmpDir,
  acquireFileLock: async () => ({ release: async () => {} }),
};
const llmAuditStub = {
  appendLlmAudit: async () => {},
  controlledLlmAuditError: () => ({ category: "test" }),
  controlledLlmAuditUsage: () => undefined,
};
const embTsPath = path.join(repoRoot, "extensions", "memory", "embedding.ts");
const mod = loadCJS(transpile(embTsPath), embTsPath, new Map([
  ["../_shared/runtime", runtimeStub],
  ["../_shared/llm-audit", llmAuditStub],
]));
const { embedTexts, VectorIndex, buildCorpusEmbeddings, contentHashOf, embeddingInputOf, vectorIndexPath, selectStage0, scopeTagOf, staleOrMissingSlugs, reconcileEmbeddings, renameSlugInVectorIndexFile } = mod;

// ── config from pi-astack-settings.json → memory.embedding ───────────────────────
const embedding = embeddingConfig();
const HAVE_HTTP = Boolean(embedding.apiKey && embedding.baseUrl);
const cfg = {
  baseUrl: embedding.baseUrl || "https://sub2api.alfadb.cn/v1",
  apiKey: embedding.apiKey || "",
  model: embedding.model || "doubao-embedding-vision",
  dim: embedding.dim,
  batchSize: embedding.batchSize,
  tpmLimit: embedding.tpmLimit,
  timeoutMs: embedding.timeoutMs,
  maxRetries: embedding.maxRetries,
  multiVector: false,
  multiVectorMaxChunks: 4,
};

// ── fixture: 12 中英混合 fake entries(不同主题,可测区分度) ────────────────
function E(slug, title, body, scope = "project", pid = "pa") {
  const id = scope === "world" ? `world:${slug}` : `project:${pid}:${slug}`;
  return {
    slug, id, scope, status: "active", title, summary: "", compiledTruth: body,
    timeline: [], relatedSlugs: [], frontmatter: scope === "world" ? {} : { project_id: pid },
  };
}
const entries = [
  E("emb-cost", "stage1 full-body 全库海选成本回归", "stage1 把全库 entry 全文喂 flash,成本 O(库×频率),单日 ¥50。"),
  E("emb-recall", "embedding 向量召回 related-recall 实测", "doubao top-100 related-recall 98%,可替代 full-body stage1 候选面。"),
  E("git-push", "提交推送子模块顺序", "含 submodule 的仓库 push 前先 fetch,子模块先于父仓库提交。", "project", "pb"),
  E("vault-secret", "vault fail-closed 不引入明文 fallback", "secret 释放走 vault_release,bash 用 $VAULT_ 注入,绝不明文进 context。"),
  E("tmux-pane", "tmux 主 pane 绝不关闭", "所有 split/new-window 后必须 select-pane 切回主 pane。"),
  E("model-t0", "T0 选型不看价格只看能力", "T0 cross-vendor blind review,价格永不纳入考量,可用性是前提。"),
  E("doc-adr", "ADR 只记决策不是 changelog", "ADR 记决策/取舍/后果/supersede;实施进度写 roadmap,不进 ADR 正文。", "world"),
  E("freshness", "sediment 写入要立即可召回", "新建/更新 entry 下次 search 立即可召回,不能 result cache。"),
  E("zero-dep", "pi-astack 零 npm 运行时依赖", "不引入 faiss/chroma 等 native 库,纯 JS + provider HTTP API。"),
  E("cjk-embed", "中英混合语料词法检索失效", "连续中文成单 token,跨语言同义改写无法靠词法召回,需语义向量。"),
  E("self-evolve", "第二大脑自我演化不外部压库", "知识库由 sediment 自主 update/merge/split/archive,不靠归档降本。", "world"),
  E("safety-net", "安全网双触发防静默掉召", "verdict=none + 候选池不足信号 + best-rank 探针,provider 熔断禁回退全库。"),
];

const idxPath = path.join(tmpDir, "embeddings-test.json");

console.log(`\nsmoke-memory-embedding (HTTP=${HAVE_HTTP ? "live" : "SKIP — no key"})\n`);

await check("1. embedTexts 返回正确维度向量 [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const vecs = await embedTexts(["第一条 test", "second english", "第三条 中英 mix"], cfg);
  assert(vecs.length === 3, `expected 3 vectors, got ${vecs.length}`);
  assert(vecs.every((v) => Array.isArray(v) && v.length === 2048), `dim should be 2048`);
});

await check("2. embedTexts batch>10 自动分块 [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const texts = Array.from({ length: 23 }, (_, i) => `item ${i} 测试分块`);
  const vecs = await embedTexts(texts, cfg);
  assert(vecs.length === 23, `expected 23 vectors (3 sub-batches), got ${vecs.length}`);
});

await check("3. buildCorpusEmbeddings 首次全 embed [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const r = await buildCorpusEmbeddings(entries, cfg, idxPath, { maxChars: 3500 });
  assert(r.total === 12 && r.embedded === 12 && r.skipped === 0, `first build: ${JSON.stringify(r)}`);
  assert(fs.existsSync(idxPath), "index file not written");
});

await check("4. VectorIndex topN self-retrieval ≥ 10/12 [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const idx = new VectorIndex(idxPath, cfg.model, cfg.dim).load();
  assert(idx.size() === 12, `index size ${idx.size()}`);
  let hit = 0;
  for (const e of entries) {
    const [qv] = await embedTexts([e.title], cfg);
    const top = idx.topN(qv, 3);
    if (top.some((t) => t.slug === e.slug)) hit++;
  }
  assert(hit >= 10, `self-retrieval top-3 hit ${hit}/12 (expected ≥10)`);
});

await check("5. content-hash 增量: 二次跑全跳过 [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const r = await buildCorpusEmbeddings(entries, cfg, idxPath, { maxChars: 3500 });
  assert(r.embedded === 0 && r.skipped === 12, `rerun should skip all: ${JSON.stringify(r)}`);
});

await check("6. content-hash 失效: 改 body 只重算该条 [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const mutated = entries.map((e) => (e.slug === "git-push" ? { ...e, compiledTruth: e.compiledTruth + " 新增内容触发 re-embed" } : e));
  const r = await buildCorpusEmbeddings(mutated, cfg, idxPath, { maxChars: 3500 });
  assert(r.embedded === 1 && r.skipped === 11, `only mutated re-embed: ${JSON.stringify(r)}`);
});

await check("7. prune: 移除的 slug 被丢弃 [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const fewer = entries.filter((e) => e.slug !== "safety-net");
  const r = await buildCorpusEmbeddings(fewer, cfg, idxPath, { maxChars: 3500 });
  assert(r.pruned === 1 && r.total === 11, `prune: ${JSON.stringify(r)}`);
  const idx = new VectorIndex(idxPath, cfg.model, cfg.dim).load();
  assert(idx.size() === 11, `after prune size ${idx.size()}`);
});

await check("8. 版本戳: 换 model 名 load → 空索引(强制重建)", async () => {
  // 纯本地,不需 HTTP — 但需要索引文件存在(HTTP 用例已建);否则构造一个
  if (!fs.existsSync(idxPath)) {
    const idx0 = new VectorIndex(idxPath, cfg.model, cfg.dim);
    idx0.upsert("x", "h", [[1, 2, 3]], "world", "s");
    idx0.save();
  }
  const wrong = new VectorIndex(idxPath, "different-embedding-model", cfg.dim).load();
  assert(wrong.size() === 0, `model mismatch must discard, got size ${wrong.size()}`);
  const wrongDim = new VectorIndex(idxPath, cfg.model, 999).load();
  assert(wrongDim.size() === 0, `dim mismatch must discard, got size ${wrongDim.size()}`);
});

await check("9. content-hash 稳定性(纯本地)", async () => {
  const e = E("h", "标题 title", "正文 body content");
  const h1 = contentHashOf(e);
  const h2 = contentHashOf({ ...e, status: "archived", confidence: 9 }); // metadata-only
  assert(h1 === h2, "metadata-only change must NOT change content-hash (else 无谓 re-embed)");
  const h3 = contentHashOf({ ...e, compiledTruth: "改了正文" });
  assert(h1 !== h3, "body change must change content-hash");
});

await check("10. embeddingInputOf 截断到 maxChars(纯本地)", async () => {
  const e = E("long", "t", "x".repeat(9000));
  assert(embeddingInputOf(e, 3500).length === 3500, "should cap at maxChars");
});

await check("11. scope-tag(storeRoot 优先) + setScope 刷新(纯本地)", async () => {
  assert(scopeTagOf(E("a", "t", "b", "world")) === "world", "world tag");
  assert(scopeTagOf(E("a", "t", "b", "project", "kihh")) === "project:kihh", "project tag from project_id fallback");
  // storeRoot(物理位置)优先于 frontmatter/id——修复实测的 8/2352 异常 scope
  const withRoot = { ...E("a", "t", "b", "project", "wrong-pid"), storeRoot: "/home/u/.abrain/projects/pi-global", id: "project:bad:a" };
  assert(scopeTagOf(withRoot) === "project:pi-global", `storeRoot 应优先, got ${scopeTagOf(withRoot)}`);
  // 物理在 knowledge/ 但 frontmatter.scope=project(数据不一致)→ 按物理位置归 world
  const inKnowledge = { ...E("k", "t", "b", "project", ""), storeRoot: "/home/u/.abrain/knowledge", id: "project:k" };
  assert(scopeTagOf(inKnowledge) === "world", `knowledge/ 物理位置应归 world, got ${scopeTagOf(inKnowledge)}`);
  // setScope 刷新已索引 entry 的 scope(不动 vec), 不存在则 no-op
  const idx = new VectorIndex(path.join(tmpDir, "scope-test.json"), cfg.model, cfg.dim);
  idx.upsert("s1", "h1", [[1, 2, 3]], "project:old", "s");
  idx.setScope("s1", "project:new");
  idx.setScope("ghost", "project:x"); // no-op, 不报错
  assert(idx.topN([1, 2, 3], 5, { scopes: new Set(["project:new"]) }).some((t) => t.slug === "s1"), "setScope 后按新 scope 可召回");
  assert(!idx.topN([1, 2, 3], 5, { scopes: new Set(["project:old"]) }).some((t) => t.slug === "s1"), "旧 scope 不再匹配");
});

await check("12. VectorIndex.renameSlug: A3 rename 保留向量且不覆盖冲突(纯本地)", async () => {
  const p = path.join(tmpDir, "rename-slug-test.json");
  const idx = new VectorIndex(p, cfg.model, cfg.dim);
  idx.upsert("old", "h-old", [[1, 0, 0]], "project:p", "s");
  idx.upsert("occupied", "h-occupied", [[0, 1, 0]], "project:p", "s");
  assert(JSON.stringify(idx.renameSlug("old", "new", "project:q")) === JSON.stringify({ ok: false, reason: "scope_mismatch" }), "scope mismatch should not move vector");
  assert(idx.topN([1, 0, 0], 5, { allowSlugs: new Set(["old"]) }).some((r) => r.slug === "old"), "old should remain after scope mismatch");
  assert(JSON.stringify(idx.renameSlug("old", "occupied", "project:p")) === JSON.stringify({ ok: false, reason: "new_exists" }), "new_exists should not overwrite occupied vector");
  const ok = idx.renameSlug("old", "new", "project:p");
  assert(ok.ok === true, `rename should succeed, got ${JSON.stringify(ok)}`);
  assert(!idx.topN([1, 0, 0], 5, { allowSlugs: new Set(["old"]) }).some((r) => r.slug === "old"), "old key should be gone after rename");
  assert(idx.topN([1, 0, 0], 5, { allowSlugs: new Set(["new"]) }).some((r) => r.slug === "new"), "new key should retrieve moved vector");
  idx.save();
  const loaded = new VectorIndex(p, cfg.model, cfg.dim).load();
  assert(loaded.topN([1, 0, 0], 5, { allowSlugs: new Set(["new"]) }).some((r) => r.slug === "new"), "save/load should preserve renamed vector");
  assert(JSON.stringify(loaded.renameSlug("missing", "x", "project:p")) === JSON.stringify({ ok: false, reason: "missing_old" }), "missing old should report missing_old");

  const filePath = path.join(tmpDir, "rename-slug-file-test.json");
  const fileIdx = new VectorIndex(filePath, cfg.model, cfg.dim);
  fileIdx.upsert("file-old", "h", [[0, 0, 1]], "project:p", "s");
  fileIdx.save();
  assert(renameSlugInVectorIndexFile("file-old", "file-new", "project:p", filePath).ok === true, "file helper should rename and save");
  const fileLoaded = new VectorIndex(filePath, cfg.model, cfg.dim).load();
  assert(fileLoaded.topN([0, 0, 1], 5, { allowSlugs: new Set(["file-new"]) }).some((r) => r.slug === "file-new"), "file helper should persist renamed vector");
  assert(JSON.stringify(renameSlugInVectorIndexFile("file-new", "x", "project:q", filePath)) === JSON.stringify({ ok: false, reason: "scope_mismatch" }), "file helper should preserve scope guard");
});

await check("13. scope-filter-before-topN: 只召回 in-scope [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  // 索引为 check 7 后状态(11 条): git-push=project:pb, doc-adr/self-evolve=world, 其余 project:pa
  const idx = new VectorIndex(idxPath, cfg.model, cfg.dim).load();
  const [qv] = await embedTexts(["提交推送 git 子模块"], cfg);
  const paOnly = idx.topN(qv, 20, { scopes: new Set(["project:pa"]) });
  assert(paOnly.length > 0, "pa scope should return results");
  assert(!paOnly.some((r) => r.slug === "git-push"), "project:pb 条目不得出现在 project:pa scope");
  assert(!paOnly.some((r) => r.slug === "doc-adr" || r.slug === "self-evolve"), "world 条目不得出现在仅 pa scope");
  const paWorld = idx.topN(qv, 20, { scopes: new Set(["project:pa", "world"]) });
  assert(paWorld.some((r) => r.slug === "doc-adr" || r.slug === "self-evolve"), "含 world scope 时 world 条目应可召回");
  assert(!paWorld.some((r) => r.slug === "git-push"), "project:pb 在 {pa,world} 下仍排除");
});

await check("13. bounded freshness fallback: 不全库 union [HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const idx = new VectorIndex(idxPath, cfg.model, cfg.dim).load();
  const [qv] = await embedTexts(["测试 query"], cfg);
  const fresh = ["ghost1", "ghost2", "ghost3", "ghost4"]; // 4 个未索引/陈旧
  const r = selectStage0(idx, qv, { topN: 5, freshFallbackSlugs: fresh, maxFallback: 2 });
  assert(r.coverage.missing === 4, `report 4 fresh, got ${r.coverage.missing}`);
  assert(r.fallback.length === 2, `fallback 必须有界到 maxFallback=2, got ${r.fallback.length}`);
  assert(r.fallback.every((s) => s.startsWith("ghost")), "fallback 应是 fresh slug");
  assert(r.candidates.length <= 5, "candidates 受 topN 限");
});

await check("14. P2 reconcile embed-on-write + staleOrMissing 检测(方向 B)[HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const p = path.join(tmpDir, "p2.json");
  const A = E("p2-a", "标题A", "内容A 关于 git 提交流程");
  const B = E("p2-b", "标题B", "内容B 关于 embedding 向量检索");
  const r = await reconcileEmbeddings([A, B], cfg, p);
  assert(r.embedded === 2, `reconcile 初次 embed 2, got ${r.embedded}`);
  const idx = new VectorIndex(p, cfg.model, cfg.dim).load();
  const C = E("p2-c", "标题C", "内容C 全新条目");
  assert(JSON.stringify(staleOrMissingSlugs(idx, [A, B, C])) === '["p2-c"]', "只 C 未索引");
  const A2 = E("p2-a", "标题A", "内容A 彻底改写过了");
  const stale = staleOrMissingSlugs(idx, [A2, B]);
  assert(stale.includes("p2-a") && !stale.includes("p2-b"), "改写 A 陈旧, B 不变");
  const r2 = await reconcileEmbeddings([A2, B], cfg, p);
  assert(r2.embedded === 1 && r2.skipped === 1, `只 A2 重 embed, got embedded=${r2.embedded} skipped=${r2.skipped}`);
});

await check("15. P2 scope-aware prune: reconcile 不删其他 scope 向量(bug1)[HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const p = path.join(tmpDir, "p2-scope.json");
  const a1 = E("s-a1", "t", "内容1", "project", "pa");
  const a2 = E("s-a2", "t", "内容2", "project", "pa");
  const b1 = E("s-b1", "t", "内容3", "project", "pb");
  await reconcileEmbeddings([a1, a2, b1], cfg, p);
  assert(new VectorIndex(p, cfg.model, cfg.dim).load().size() === 3, "初始 3 向量");
  // reconcile 只传 pa scope(a1 删, 剩 a2): 只 prune pa 内 a1, 保留 pb 的 b1
  await reconcileEmbeddings([a2], cfg, p);
  const slugs = Object.keys(JSON.parse(fs.readFileSync(p, "utf8")).entries).sort();
  assert(JSON.stringify(slugs) === '["s-a2","s-b1"]', `prune pa 的 a1 但保留 pb 的 b1, got ${JSON.stringify(slugs)}`);
});

await check("16. P2 search union: 未索引 entry 经 freshFallback 进候选(方向 B)[HTTP]", async () => {
  if (!HAVE_HTTP) return;
  const p = path.join(tmpDir, "p2-union.json");
  const A = E("u-a", "标题A", "内容A git 子模块提交顺序");
  await reconcileEmbeddings([A], cfg, p);
  const idx = new VectorIndex(p, cfg.model, cfg.dim).load();
  const B = E("u-b", "标题B", "内容B 全新刚写入还没 embed");
  const fresh = staleOrMissingSlugs(idx, [A, B]);
  assert(JSON.stringify(fresh) === '["u-b"]', `只 u-b 未索引, got ${JSON.stringify(fresh)}`);
  const [qv] = await embedTexts(["全新内容"], cfg);
  const s0 = selectStage0(idx, qv, { topN: 5, freshFallbackSlugs: fresh, maxFallback: 5 });
  assert(s0.fallback.includes("u-b"), "未索引 u-b 应经 fallback union 进候选(下次 search 立即可召回)");
});

// cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
