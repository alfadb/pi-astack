/**
 * memory/embedding.ts — ADR 0035 P1: stage0 向量召回基建。
 *
 * pi 无 vector embedding API,故 extension 自己 HTTP 调 OpenAI 兼容
 * `/embeddings` endpoint。本模块提供三件套:
 *   - embedTexts: batch≤10 + TPM 限流 + 重试的 embedding client
 *   - VectorIndex: abrain `.state/memory/` 持久化的向量索引,content-hash
 *     keyed 失效 + embedding-model 版本戳(盲审修订:换 model 强制重建,
 *     metadata-only 更新不 re-embed),纯 JS 余弦 topN
 *   - buildCorpusEmbeddings: 全库 active entries 增量 embed(只算变化的)
 *
 * 零 npm 运行时依赖:仅用 node 内置(fetch / crypto / fs)。
 *
 * 不变量(ADR 0035 §4):
 *   - 索引一致性:vector keyed by content-hash(compiledTruth+timeline+title
 *     +summary);hash 不变则跳过;model/dim 变则整库重建。
 *   - 非 result cache:缓存 entry 向量,非 query→slug 结果。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { abrainStateDir, acquireFileLock, resolveUserGlobalAbrainHome } from "../_shared/runtime";
import type { MemoryEntry } from "./types";
import type { EmbeddingSettings } from "./settings";

// ── runtime config (resolved from modelRegistry + settings) ──────────────
export interface EmbeddingProviderConfig {
  baseUrl: string;                       // e.g. https://sub2api.alfadb.cn/v1
  apiKey: string;
  headers?: Record<string, string>;
  model: string;                         // doubao-embedding-vision
  dim: number;                           // 2048
  batchSize: number;                     // doubao hard cap = 10
  tpmLimit: number;                      // 600000 tokens/min (方舟 Coding Plan)
  timeoutMs: number;
  maxRetries: number;
  multiVector: boolean;                  // ADR 0036 P4: 多向量解 3500 截断(默认 off)
  multiVectorMaxChunks: number;          // 每 entry 最多 sub-vector 数(成本上限)
  multiVectorTitlePrefix?: boolean;      // ADR 0036 P4 条件4: 首段外 chunk 是否前缀 title(默认 true; ablation 用)
}

interface ModelRegistryLike {
  find(provider: string, modelId: string): unknown;
  getApiKeyAndHeaders(model: unknown): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Rough token estimate for TPM throttling (CJK-heavy → ~1 token / 2-3 chars;
 *  use /2 as a conservative upper bound so we under-shoot the 600K cap). */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}

/** Content basis for hashing + embedding input. compiledTruth + timeline are
 *  the semantic payload (ADR 0035); title + summary add retrieval signal.
 *  metadata (status/confidence) intentionally excluded so metadata-only
 *  updates do NOT invalidate the vector (盲审修订). */
function contentBasis(e: MemoryEntry): string {
  return `${e.title}\n${e.summary}\n${e.compiledTruth}\n${(e.timeline || []).join("\n")}`;
}

export function contentHashOf(e: MemoryEntry): string {
  return crypto.createHash("sha256").update(contentBasis(e), "utf8").digest("hex").slice(0, 16);
}

/** Scheme tag for the freshness key: "s"=single-vector, "m"=multi-vector.
 *  Folding it into isFresh lets toggling multiVector re-embed on next
 *  reconcile/rebuild WITHOUT changing contentHashOf, so flag-off stays a
 *  no-op (migrated v1 records default scheme "s" → fresh under single). */
export function embedSchemeTag(multiVector: boolean): "s" | "m" {
  return multiVector ? "m" : "s";
}

export function embeddingInputOf(e: MemoryEntry, maxChars: number): string {
  return contentBasis(e).slice(0, maxChars);
}

/** ADR 0036 P4 多向量: 把 contentBasis 切成 ≤maxChunks 个 maxChars 段, 每段一个
 *  sub-vector, 解 3500 截断盲区(尾部 timeline/正文也进入 dense)。短 entry
 *  (≤maxChars)仅 1 段 = 单向量, flag-off/短文零额外成本。首段之外每段前缀 title
 *  做主题锚定(尾段脱离标题会嵌到泛化点, 锚回主题提升对话题 query 的 max-sim)。 */
export function embeddingInputsOf(
  e: MemoryEntry,
  maxChars: number,
  opts: { multiVector: boolean; maxChunks: number; titlePrefix?: boolean },
): string[] {
  const basis = contentBasis(e);
  if (!opts.multiVector || basis.length <= maxChars) return [basis.slice(0, maxChars)];
  // ADR 0036 P4 条件4(title-prefix ablation): titlePrefix=false 关闭首段外 chunk 的 title 前缀。
  const title = (opts.titlePrefix === false ? "" : (e.title || "")).replace(/\s+/g, " ").trim();
  const prefix = title ? `${title}\n` : "";
  const maxChunks = Math.max(1, opts.maxChunks);
  const chunks: string[] = [];
  for (let pos = 0; pos < basis.length && chunks.length < maxChunks; pos += maxChars) {
    const seg = basis.slice(pos, pos + maxChars);
    chunks.push(chunks.length === 0 ? seg : `${prefix}${seg}`.slice(0, maxChars));
  }
  return chunks;
}

// ── TPM throttle: rolling 1-minute token window ──────────────────────────
class TpmThrottle {
  private windowStart = Date.now();
  private tokensInWindow = 0;
  constructor(private readonly tpmLimit: number) {}
  async charge(tokens: number): Promise<void> {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.tokensInWindow = 0;
    }
    if (this.tokensInWindow + tokens > this.tpmLimit) {
      const waitMs = 60_000 - (now - this.windowStart) + 50;
      if (waitMs > 0) await sleep(waitMs);
      this.windowStart = Date.now();
      this.tokensInWindow = 0;
    }
    this.tokensInWindow += tokens;
  }
}

// ── low-level batch HTTP ─────────────────────────────────────────────────
async function embedBatch(chunk: string[], cfg: EmbeddingProviderConfig, attempt = 0): Promise<number[][]> {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}/embeddings`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        ...(cfg.headers || {}),
      },
      body: JSON.stringify({ model: cfg.model, input: chunk }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`embedding HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { data?: Array<{ index?: number; embedding: number[] }> };
    if (!Array.isArray(data.data) || data.data.length !== chunk.length) {
      throw new Error(`embedding bad response: expected ${chunk.length} vectors, got ${data.data?.length}`);
    }
    return data.data
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((d) => d.embedding);
  } catch (e) {
    if (attempt < cfg.maxRetries) {
      await sleep(1000 * (attempt + 1));
      return embedBatch(chunk, cfg, attempt + 1);
    }
    throw e;
  }
}

/** Embed arbitrary-length text list. Internally chunks by cfg.batchSize
 *  (doubao hard cap 10) + TPM throttles. onBatch fires after each batch
 *  for incremental persistence. */
export async function embedTexts(
  texts: string[],
  cfg: EmbeddingProviderConfig,
  onBatch?: (startIdx: number, vectors: number[][]) => void,
): Promise<number[][]> {
  const out: number[][] = [];
  const throttle = new TpmThrottle(cfg.tpmLimit);
  const size = Math.max(1, Math.min(10, cfg.batchSize));
  for (let i = 0; i < texts.length; i += size) {
    const chunk = texts.slice(i, i + size);
    await throttle.charge(chunk.reduce((a, t) => a + estimateTokens(t), 0));
    const vecs = await embedBatch(chunk, cfg);
    for (const v of vecs) out.push(v);
    onBatch?.(i, vecs);
  }
  return out;
}

// ── persistent vector index ──────────────────────────────────────────────
interface IndexFile {
  version: number;
  model: string;
  dim: number;
  // ADR 0036 P4: vecs = 1..maxChunks 个 sub-vector(多向量); scheme = "s"|"m"
  // (freshness key, toggle 时 re-embed)。v1({vec})由 load() migrate-on-read。
  entries: Record<string, { hash: string; vecs: number[][]; scope: string; scheme: string }>;
}

/** Scope tag for filter-before-topN. world → "world"; project → "project:<id>".
 *  ADR 0035 §7: scope filter MUST be before topN(扫描时跳过 out-of-scope),
 *  禁 after-topN(正确条目被无关 scope 挤出 top-N 则损 recall)。 */
export function scopeTagOf(e: MemoryEntry): string {
  // 物理位置是 scope 真相,覆盖 frontmatter.scope/id 的不一致:
  //   knowledge/ 目录 → world(跨项目共享);projects/<id>/ → project:<id>。
  // 实测 knowledge/ 下 8 条 frontmatter.scope=project(project_id 空)的不一致
  // entry,按物理位置归 world;project entry 的 id/project_id 缺失时也回退
  // storeRoot 目录名(实测 8/2352 落到 slug 片段)。
  const base = e.storeRoot ? path.basename(e.storeRoot) : "";
  if (base === "knowledge") return "world";
  if (e.scope === "world") return "world";
  const pid =
    base ||
    (typeof e.frontmatter?.project_id === "string" && e.frontmatter.project_id) ||
    e.id?.split(":")[1] ||
    "unknown";
  return `project:${pid}`;
}

function atomicWriteJson(file: string, data: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
  fs.renameSync(tmp, file);
}

export class VectorIndex {
  private data: IndexFile;
  private normCache: Map<string, { vs: Float32Array[]; scope: string }> | null = null;

  constructor(
    public readonly path: string,
    public readonly model: string,
    public readonly dim: number,
  ) {
    this.data = { version: 2, model, dim, entries: {} };
  }

  /** Load from disk. Model/dim mismatch → discard (force rebuild): this is
   *  the embedding-model version-stamp invariant — never mix vectors across
   *  models (盲审修订). Missing/corrupt → empty index. */
  load(): this {
    try {
      const raw = JSON.parse(fs.readFileSync(this.path, "utf8")) as { model?: string; dim?: number; entries?: Record<string, { hash: string; vec?: number[]; vecs?: number[][]; scope: string; scheme?: string }> };
      if (raw && raw.model === this.model && raw.dim === this.dim && raw.entries) {
        // migrate-on-read: v1 {vec} → v2 {vecs:[vec], scheme:"s"}; 单向量视为
        // scheme "s" → flag-off 下与当前单向量 scheme 一致, 零 re-embed(no-op)。
        const entries: IndexFile["entries"] = {};
        for (const [slug, rec] of Object.entries(raw.entries)) {
          const vecs = Array.isArray(rec.vecs) ? rec.vecs : (Array.isArray(rec.vec) ? [rec.vec] : []);
          if (vecs.length === 0) continue; // drop malformed
          entries[slug] = { hash: rec.hash, vecs, scope: rec.scope, scheme: rec.scheme ?? "s" };
        }
        this.data = { version: 2, model: this.model, dim: this.dim, entries };
      }
    } catch {
      /* missing or corrupt → keep empty */
    }
    this.normCache = null;
    return this;
  }

  /** Fresh iff content-hash matches AND (scheme unspecified OR matches). The
   *  scheme guard makes a single↔multi toggle re-embed without touching
   *  contentHashOf (ADR 0036 P4). */
  isFresh(slug: string, hash: string, scheme?: string): boolean {
    const rec = this.data.entries[slug];
    if (!rec || rec.hash !== hash) return false;
    return scheme === undefined || rec.scheme === scheme;
  }

  upsert(slug: string, hash: string, vecs: number[][], scope: string, scheme: string): void {
    this.data.entries[slug] = { hash, vecs, scope, scheme };
    this.normCache = null;
  }

  /** Refresh scope tag without touching the vector. scope = position metadata
   *  (project dir), independent of content-hash — must update on project
   *  rename/move even when content unchanged. No-op if slug not indexed. */
  setScope(slug: string, scope: string): void {
    const rec = this.data.entries[slug];
    if (rec && rec.scope !== scope) {
      rec.scope = scope;
      this.normCache = null;
    }
  }

  /** Coverage of an active-slug set: indexed vs missing. Lets the search
   *  layer build a BOUNDED cold-start fallback (ADR 0035 §4) instead of an
   *  O(库) full-body union. */
  coverage(activeSlugs: string[]): { indexed: number; missing: string[] } {
    const missing: string[] = [];
    for (const s of activeSlugs) if (!this.data.entries[s]) missing.push(s);
    return { indexed: activeSlugs.length - missing.length, missing };
  }

  /** Drop vectors whose slug is no longer an active entry. When `scopes` is
   *  given, prune ONLY slugs whose scope is in that set — reconcile passes the
   *  current session's scopes so a project-scoped reconcile never deletes other
   *  projects' vectors (ADR 0035 §7 bug1) while still clearing the current
   *  scope's hard-deleted entries (bug4). Returns count. */
  prune(validSlugs: Set<string>, scopes?: Set<string>): number {
    let n = 0;
    for (const [slug, rec] of Object.entries(this.data.entries)) {
      if (validSlugs.has(slug)) continue;
      if (scopes && !scopes.has(rec.scope)) continue; // out-of-scope vector untouched
      delete this.data.entries[slug];
      n++;
    }
    if (n) this.normCache = null;
    return n;
  }

  /** ADR 0036 §10.6 auto-reconcile prune 信号: 数“scope 在本次范围内, 但 slug 不再是
   *  active entry”的索引向量(= archived/deleted 遗留的孤儿)。纯只读, prune() 的
   *  计数镜像 —— 驱动 search-time 双向 reconcile 触发判据的 PRUNE 方向。 */
  countOrphans(validSlugs: Set<string>, scopes: Set<string>): number {
    let n = 0;
    for (const [slug, rec] of Object.entries(this.data.entries)) {
      if (!scopes.has(rec.scope)) continue;
      if (!validSlugs.has(slug)) n++;
    }
    return n;
  }

  size(): number {
    return Object.keys(this.data.entries).length;
  }

  save(): void {
    atomicWriteJson(this.path, this.data);
  }

  private ensureNorm(): void {
    if (this.normCache) return;
    const cache = new Map<string, { vs: Float32Array[]; scope: string }>();
    for (const [slug, rec] of Object.entries(this.data.entries)) {
      const vs: Float32Array[] = [];
      for (const raw of rec.vecs) {
        const v = Float32Array.from(raw);
        let n = 0;
        for (let i = 0; i < v.length; i++) n += v[i] * v[i];
        n = Math.sqrt(n) || 1;
        for (let i = 0; i < v.length; i++) v[i] /= n;
        vs.push(v);
      }
      if (vs.length) cache.set(slug, { vs, scope: rec.scope });
    }
    this.normCache = cache;
  }

  /** Cosine top-N with scope-filter-BEFORE-topN (ADR 0035 §7). When
   *  opts.scopes is set, out-of-scope vectors are skipped DURING the scan
   *  (not after ranking) so in-scope recall is never diluted. Pure JS
   *  linear scan (fine to ~5万 entries). */
  topN(
    queryVec: number[],
    n: number,
    opts?: { scopes?: Set<string>; exclude?: Set<string>; allowSlugs?: Set<string>; agg?: "maxsim" | "chunk0" },
  ): Array<{ slug: string; score: number }> {
    this.ensureNorm();
    const q = Float32Array.from(queryVec);
    let qn = 0;
    for (let i = 0; i < q.length; i++) qn += q[i] * q[i];
    qn = Math.sqrt(qn) || 1;
    for (let i = 0; i < q.length; i++) q[i] /= qn;
    const sims: Array<{ slug: string; score: number }> = [];
    for (const [slug, rec] of this.normCache!) {
      if (opts?.exclude?.has(slug)) continue;
      // ADR 0035 P3 (修订 2): allowSlugs(corpus 已 scope+filter 正确全集)before-topN
      // ——比 scopeTagOf 反推更精确,且索引无 status/kind 时这是唯一正确的 filter 前置。
      if (opts?.allowSlugs && !opts.allowSlugs.has(slug)) continue;
      if (opts?.scopes && !opts.scopes.has(rec.scope)) continue; // before-topN
      // ADR 0036 P4 多向量: entry 分数 = 各 sub-vector 与 query 的最大余弦
      // (late-interaction max-sim)。短 entry 仅 1 个 sub-vector, 等同单向量。
      // ADR 0036 P4 条件1(dedup 分离): agg="chunk0" 只用首段(head)向量 —— dedup 路径
      // 专用, 避免 max-sim 让共享 boilerplate/尾段 chunk 的 distinct entry 浮上为近重候选
      // (false-merge 注入, 实测 235→62 新增邻居 -74%)。multiVector off 时仅 1 chunk, 与
      // maxsim 等价(no-op)。
      const vlist = opts?.agg === "chunk0" ? rec.vs.slice(0, 1) : rec.vs;
      let best = -Infinity;
      for (const v of vlist) {
        let d = 0;
        const L = Math.min(v.length, q.length);
        for (let i = 0; i < L; i++) d += v[i] * q[i];
        if (d > best) best = d;
      }
      sims.push({ slug, score: best });
    }
    sims.sort((a, b) => b.score - a.score);
    return sims.slice(0, n);
  }
}

export function vectorIndexPath(): string {
  return path.join(abrainStateDir(resolveUserGlobalAbrainHome()), "memory", "embeddings.json");
}

export interface Stage0Result {
  candidates: Array<{ slug: string; score: number }>;
  fallback: string[]; // bounded fresh/missing slugs (no fresh vector → blind-union)
  coverage: { ranked: number; missing: number };
}

/** Search-time freshness diff (ADR 0035 §4 方向 B): the slugs among `entries`
 *  that are MISSING from the index OR whose content-hash no longer matches
 *  (vector stale after an edit). These must be bounded-unioned into the
 *  candidate pool, else a freshly written/edited entry ranks by its OLD vector
 *  (or not at all) and silently drops out of top-N — the coverage()-only bug
 *  (ADR 0035 §7 bug3). `entries` should already be scope-filtered by the
 *  caller. Zero persisted manifest: diffed in-memory on every search against
 *  the entries loadEntries already holds. */
export function staleOrMissingSlugs(index: VectorIndex, entries: MemoryEntry[], scheme?: string): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!index.isFresh(e.slug, contentHashOf(e), scheme)) out.push(e.slug);
  }
  return out;
}

/** Stage0 候选选择:scope-filtered topN + 有界 freshness fallback(ADR 0035 §4
 *  方向 B)。`freshFallbackSlugs`(由 staleOrMissingSlugs 算出,含未索引 + 向量
 *  陈旧两类,已 scope-filtered)取有界子集(≤maxFallback)供调用方 union 进
 *  候选——**绝不全库 union**(冷启动/故障窗口禁回退 O(库) full-body)。 */
export function selectStage0(
  index: VectorIndex,
  queryVec: number[],
  opts: { topN: number; scopes?: Set<string>; allowSlugs?: Set<string>; freshFallbackSlugs?: string[]; maxFallback?: number },
): Stage0Result {
  const candidates = index.topN(queryVec, opts.topN, { scopes: opts.scopes, allowSlugs: opts.allowSlugs });
  let fallback: string[] = [];
  const missing = opts.freshFallbackSlugs?.length ?? 0;
  if (missing) {
    const cap = Math.max(0, opts.maxFallback ?? 0);
    fallback = opts.freshFallbackSlugs!.slice(0, cap); // BOUNDED — never the whole vault
  }
  return { candidates, fallback, coverage: { ranked: candidates.length, missing } };
}

// ── provider config resolution (modelRegistry + settings + models.json) ──
function readModelsJsonBaseUrl(provider: string): string | undefined {
  try {
    const file = path.join(require("node:os").homedir(), ".pi", "agent", "models.json");
    const j = JSON.parse(fs.readFileSync(file, "utf8")) as {
      providers?: Record<string, { baseUrl?: string; baseURL?: string }>;
    };
    const p = j.providers?.[provider];
    return p?.baseUrl ?? p?.baseURL;
  } catch {
    return undefined;
  }
}

export async function resolveEmbeddingProviderConfig(
  modelRegistry: ModelRegistryLike,
  s: EmbeddingSettings,
): Promise<EmbeddingProviderConfig> {
  if (!s.provider || !s.model) {
    throw new Error("embedding provider/model not configured (pi-astack-settings.json → memory.embedding)");
  }
  const model = modelRegistry.find(s.provider, s.model);
  if (!model) throw new Error(`embedding model not found in registry: ${s.provider}/${s.model}`);
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(`embedding auth unavailable for ${s.provider}/${s.model}: ${auth.error || "missing api key"}`);
  }
  const mm = model as { baseUrl?: string; baseURL?: string };
  const baseUrl = mm.baseUrl ?? mm.baseURL ?? readModelsJsonBaseUrl(s.provider);
  if (!baseUrl) throw new Error(`embedding baseUrl unresolved for provider ${s.provider}`);
  return {
    baseUrl,
    apiKey: auth.apiKey,
    headers: auth.headers,
    model: s.model,
    dim: s.dim,
    batchSize: s.batchSize,
    tpmLimit: s.tpmLimit,
    timeoutMs: s.timeoutMs,
    maxRetries: s.maxRetries,
    multiVector: s.multiVector,
    multiVectorMaxChunks: s.multiVectorMaxChunks,
  };
}

// ── corpus build (incremental, content-hash gated) ───────────────────────
export interface CorpusBuildResult {
  total: number;     // active entries
  embedded: number;  // newly embedded (changed/missing)
  skipped: number;   // content-hash unchanged
  pruned: number;    // stale slugs dropped
}

export async function buildCorpusEmbeddings(
  entries: MemoryEntry[],
  cfg: EmbeddingProviderConfig,
  indexPath: string,
  opts?: { maxChars?: number; saveEvery?: number; onProgress?: (done: number, todo: number) => void; pruneScopes?: Set<string>; skipPrune?: boolean },
): Promise<CorpusBuildResult> {
  const maxChars = opts?.maxChars ?? 3500;
  const saveEvery = opts?.saveEvery ?? cfg.batchSize * 10;
  const idx = new VectorIndex(indexPath, cfg.model, cfg.dim).load();

  const active = entries.filter((e) => e.status === "active");
  const validSlugs = new Set(active.map((e) => e.slug));
  // reconcile(部分库)传 pruneScopes:只 prune 当前 scope 内的 stale slug,绝不
  // 删其他 project 向量(ADR 0035 §7 bug1);全库 init 不传 → prune 全部 stale。
  const pruned = opts?.skipPrune ? 0 : idx.prune(validSlugs, opts?.pruneScopes);
  // ADR 0035 §75(4): prune 落盘与 embed 成功解耦 —— prune 是纯本地操作, delete/archive
  // 的孤儿向量必须能清掉哪怕 embedding provider 宕机(否则整个 reconcile 报错
  // 被 swallow, prune 丢失, 孤儿泄漏到下次成功 embed)。仅有 prune 时存一次(原子写)。
  if (pruned > 0) idx.save();

  // content-hash + scheme gate: only embed changed/missing/scheme-flipped(ADR 0036 P4)
  const currentScheme = embedSchemeTag(cfg.multiVector);
  const hashes = new Map<string, string>();
  const todo = active.filter((e) => {
    const h = contentHashOf(e);
    hashes.set(e.slug, h);
    return !idx.isFresh(e.slug, h, currentScheme);
  });

  // ADR 0036 P4: 每 entry → 1..maxChunks 个 chunk, 扁平 embed 后按 owner 归并;
  // chunk 跨 batch 边界用 pending 累积, entry 全部 chunk 到齐才 upsert(增量持久化)。
  const chunkTexts: string[] = [];
  const chunkOwner: number[] = [];
  const chunkCount: number[] = [];
  for (let i = 0; i < todo.length; i++) {
    const ins = embeddingInputsOf(todo[i], maxChars, { multiVector: cfg.multiVector, maxChunks: cfg.multiVectorMaxChunks, titlePrefix: cfg.multiVectorTitlePrefix !== false });
    chunkCount.push(ins.length);
    for (const t of ins) { chunkTexts.push(t); chunkOwner.push(i); }
  }
  let embedded = 0;
  const pending = new Map<number, number[][]>();
  await embedTexts(chunkTexts, cfg, (startIdx, vectors) => {
    for (let j = 0; j < vectors.length; j++) {
      const owner = chunkOwner[startIdx + j];
      const arr = pending.get(owner) ?? [];
      arr.push(vectors[j]);
      pending.set(owner, arr);
      if (arr.length === chunkCount[owner]) {
        const e = todo[owner];
        idx.upsert(e.slug, hashes.get(e.slug)!, arr, scopeTagOf(e), currentScheme);
        pending.delete(owner);
        embedded++;
        if (embedded % saveEvery === 0) idx.save();
        opts?.onProgress?.(embedded, todo.length);
      }
    }
  });
  // refresh scope tags for ALL active (incl. content-hash-skipped): scope is
  // position metadata (project dir), independent of content-hash — must reflect
  // current location even when content unchanged (ADR 0035 §4).
  for (const e of active) idx.setScope(e.slug, scopeTagOf(e));
  idx.save();

  return { total: active.length, embedded, skipped: active.length - todo.length, pruned };
}

export function indexLockPath(): string {
  return path.join(abrainStateDir(resolveUserGlobalAbrainHome()), "memory", ".embeddings.lock");
}

/** ADR 0036 §10.6: 索引可观测元数据(“我的索引多新/上次何时重建”)。不参与检测
 *  (检测走 content-hash + orphan set-diff); 纯运维查阅用。 */
export function indexMetaPath(): string {
  return path.join(abrainStateDir(resolveUserGlobalAbrainHome()), "memory", "index-meta.json");
}

function writeIndexMeta(cfg: EmbeddingProviderConfig, result: CorpusBuildResult): void {
  try {
    atomicWriteJson(indexMetaPath(), {
      updatedAt: new Date().toISOString(),
      activeEntries: result.total,
      embedded: result.embedded,
      skipped: result.skipped,
      pruned: result.pruned,
      scheme: embedSchemeTag(cfg.multiVector),
      multiVectorMaxChunks: cfg.multiVectorMaxChunks,
    });
  } catch { /* best-effort observability */ }
}

/** Reconcile vectors for the entries loaded this agent_end (ADR 0035 P2 方向 B).
 *  Scope-safe: prunes ONLY within the scopes present in `entries`(不删其他
 *  project 向量 = bug1) + serializes the index read-modify-write under a file
 *  lock(多 session/设备并发 = bug2)。content-hash gated 增量 embed;调用方
 *  必须 swallow 错误,使 provider 故障永不阻塞 sediment 写入。 */
export async function reconcileEmbeddings(
  entries: MemoryEntry[],
  cfg: EmbeddingProviderConfig,
  indexPath: string,
  opts?: { maxChars?: number; onProgress?: (done: number, todo: number) => void; lockTimeoutMs?: number },
): Promise<CorpusBuildResult> {
  const scopes = new Set(entries.filter((e) => e.status === "active").map(scopeTagOf));
  const lock = await acquireFileLock(indexLockPath(), {
    timeoutMs: opts?.lockTimeoutMs ?? 30_000,
    staleMs: 60_000,
    retryMs: 100,
    label: "embedding-index",
  });
  try {
    const result = await buildCorpusEmbeddings(entries, cfg, indexPath, {
      maxChars: opts?.maxChars,
      onProgress: opts?.onProgress,
      pruneScopes: scopes,
    });
    writeIndexMeta(cfg, result);
    return result;
  } finally {
    await lock.release();
  }
}
