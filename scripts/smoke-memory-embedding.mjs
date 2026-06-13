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
 * 需要 env SUB2API_API_KEY_EMBEDDING + ~/.pi/agent/models.json providers.embedding.baseUrl。
 * 缺 key 时 SKIP HTTP 用例,仍跑纯本地用例(2/5/6 的索引逻辑)。
 */

import fs from "node:fs";
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
};
const embTsPath = path.join(repoRoot, "extensions", "memory", "embedding.ts");
const mod = loadCJS(transpile(embTsPath), embTsPath, new Map([["../_shared/runtime", runtimeStub]]));
const { embedTexts, VectorIndex, buildCorpusEmbeddings, contentHashOf, embeddingInputOf, vectorIndexPath } = mod;

// ── config from env + models.json ────────────────────────────────────────
const key = process.env.SUB2API_API_KEY_EMBEDDING;
let baseUrl;
try {
  const mj = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
  baseUrl = mj.providers?.embedding?.baseUrl ?? mj.providers?.embedding?.baseURL;
} catch { /* ignore */ }
const HAVE_HTTP = Boolean(key && baseUrl);
const cfg = {
  baseUrl: baseUrl || "https://sub2api.alfadb.cn/v1",
  apiKey: key || "",
  model: "doubao-embedding-vision",
  dim: 2048,
  batchSize: 10,
  tpmLimit: 600_000,
  timeoutMs: 60_000,
  maxRetries: 3,
};

// ── fixture: 12 中英混合 fake entries(不同主题,可测区分度) ────────────────
function E(slug, title, body) {
  return { slug, status: "active", title, summary: "", compiledTruth: body, timeline: [], relatedSlugs: [] };
}
const entries = [
  E("emb-cost", "stage1 full-body 全库海选成本回归", "stage1 把全库 entry 全文喂 flash,成本 O(库×频率),单日 ¥50。"),
  E("emb-recall", "embedding 向量召回 related-recall 实测", "doubao top-100 related-recall 98%,可替代 full-body stage1 候选面。"),
  E("git-push", "提交推送子模块顺序", "含 submodule 的仓库 push 前先 fetch,子模块先于父仓库提交。"),
  E("vault-secret", "vault fail-closed 不引入明文 fallback", "secret 释放走 vault_release,bash 用 $VAULT_ 注入,绝不明文进 context。"),
  E("tmux-pane", "tmux 主 pane 绝不关闭", "所有 split/new-window 后必须 select-pane 切回主 pane。"),
  E("model-t0", "T0 选型不看价格只看能力", "T0 cross-vendor blind review,价格永不纳入考量,可用性是前提。"),
  E("doc-adr", "ADR 只记决策不是 changelog", "ADR 记决策/取舍/后果/supersede;实施进度写 roadmap,不进 ADR 正文。"),
  E("freshness", "sediment 写入要立即可召回", "新建/更新 entry 下次 search 立即可召回,不能 result cache。"),
  E("zero-dep", "pi-astack 零 npm 运行时依赖", "不引入 faiss/chroma 等 native 库,纯 JS + provider HTTP API。"),
  E("cjk-embed", "中英混合语料词法检索失效", "连续中文成单 token,跨语言同义改写无法靠词法召回,需语义向量。"),
  E("self-evolve", "第二大脑自我演化不外部压库", "知识库由 sediment 自主 update/merge/split/archive,不靠归档降本。"),
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
    idx0.upsert("x", "h", [1, 2, 3]);
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

// cleanup
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }

console.log(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
