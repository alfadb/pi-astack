/**
 * ADR 0031 Phase 0 — 读侧用量埋点 deterministic 单测(免 LLM)。
 * 测 usage-telemetry: profile gate(只 user-facing 记) + shouldRecordUsage 三道门 +
 * mergeUsage 计数/时间戳独立 + recordUsage 真实 IO(sandbox 到 tmp ABRAIN_ROOT):
 * flag off 不写 / 无 projectRoot 不写 / flag on 写且计数正确 / slug 去重 / 空串过滤。
 */
import { createJiti } from "jiti";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// sandbox: ABRAIN_ROOT 重定向到 tmp → usageMetricsPath 落 tmp/.state/memory/,
// 绝不触碰生产 ~/.abrain。必须在 import telemetry 前设(函数 call-time 读 env)。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-usage-telemetry-"));
process.env.ABRAIN_ROOT = tmp;

const jiti = createJiti(import.meta.url);
const { isUsageRecordingProfile, shouldRecordUsage, mergeUsage, recordUsage, usageMetricsPath } =
  await jiti.import(path.join(__dirname, "..", "extensions/memory/usage-telemetry.ts"));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}: ${msg}`); if (!cond) fails++; };

// ── profile gate: 只「用户面」检索记 retrieval-hit ────────────────
ok(isUsageRecordingProfile("toolSearch") === true, "toolSearch → 记 retrieval-hit");
ok(isUsageRecordingProfile("pathAInject") === true, "pathAInject → 记");
ok(isUsageRecordingProfile("decideSearch") === true, "decideSearch → 记");
ok(isUsageRecordingProfile("sedimentDedup") === false, "sedimentDedup(写侧 curator)→ 不记");
ok(isUsageRecordingProfile("correctionSearch") === false, "correctionSearch(写侧)→ 不记");

// ── shouldRecordUsage 纯门: 三条全真才写 ─────────────────────────
ok(shouldRecordUsage({ enabled: true, hasProjectRoot: true, slugCount: 2 }) === true, "三条全真 → 写");
ok(shouldRecordUsage({ enabled: false, hasProjectRoot: true, slugCount: 2 }) === false, "flag off → 不写");
ok(shouldRecordUsage({ enabled: true, hasProjectRoot: false, slugCount: 2 }) === false, "无 projectRoot → 不写");
ok(shouldRecordUsage({ enabled: true, hasProjectRoot: true, slugCount: 0 }) === false, "空 slug → 不写");

// ── mergeUsage 纯合并: retrieval/cited 独立计数 + 时间戳 ─────────
{
  const s = {};
  mergeUsage(s, ["a", "b"], "retrieval_hit", "2026-01-01T00:00:00Z");
  ok(s.a.retrieval_hit_count === 1 && s.b.retrieval_hit_count === 1, "retrieval_hit: 两 slug 各 +1");
  ok(s.a.last_retrieval_hit_at === "2026-01-01T00:00:00Z", "retrieval_hit: 写时间戳");
  ok(s.a.cited_count === undefined, "retrieval_hit 不碰 cited_count");
  mergeUsage(s, ["a"], "retrieval_hit", "2026-01-02T00:00:00Z");
  ok(s.a.retrieval_hit_count === 2 && s.a.last_retrieval_hit_at === "2026-01-02T00:00:00Z", "再命中 → 累加 + 刷新时间戳");
  mergeUsage(s, ["a"], "cited", "2026-01-03T00:00:00Z");
  ok(s.a.cited_count === 1 && s.a.retrieval_hit_count === 2, "cited 独立计数, 不动 retrieval_hit");
}

// ── recordUsage 真实 IO(sandbox)───────────────────────────────
const file = usageMetricsPath();
ok(file.startsWith(tmp), "sandbox: usage-metrics.json 落在 ABRAIN_ROOT 下(不碰生产)");
const settingsOn = { forgetting: { instrumentation: true } };
const settingsOff = { forgetting: { instrumentation: false } };
const PR = "/some/project";

recordUsage(["x"], "retrieval_hit", settingsOff, PR);
ok(!fs.existsSync(file), "flag off → 不写文件");

recordUsage(["x"], "retrieval_hit", settingsOn, undefined);
ok(!fs.existsSync(file), "无 projectRoot(oracle/scratch)→ 不写文件");

recordUsage(["x", "y"], "retrieval_hit", settingsOn, PR);
recordUsage(["x"], "cited", settingsOn, PR);
recordUsage(["x"], "retrieval_hit", settingsOn, PR);
const store = JSON.parse(fs.readFileSync(file, "utf-8"));
ok(store.x.retrieval_hit_count === 2, "x retrieval_hit_count=2(两次 retrieval)");
ok(store.x.cited_count === 1, "x cited_count=1");
ok(store.y.retrieval_hit_count === 1 && store.y.cited_count === undefined, "y 只 retrieval, 无 cited");
ok(typeof store.x.last_retrieval_hit_at === "string" && typeof store.x.last_cited_at === "string", "x 两个时间戳都落盘");

recordUsage(["z", "z", "z"], "cited", settingsOn, PR);
const store2 = JSON.parse(fs.readFileSync(file, "utf-8"));
ok(store2.z.cited_count === 1, "同一 call 内重复 slug 去重 → 只 +1");

recordUsage(["", "w"], "retrieval_hit", settingsOn, PR);
const store3 = JSON.parse(fs.readFileSync(file, "utf-8"));
ok(store3[""] === undefined && store3.w.retrieval_hit_count === 1, "空串 slug 被过滤, w 正常记");

// cleanup
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }

console.log(fails === 0
  ? "\n✅ ALL PASS — ADR 0031 Phase 0 读侧埋点: profile gate + 三门 + 独立计数 + IO 守卫"
  : `\n❌ ${fails} FAILED`);
process.exit(fails === 0 ? 0 : 1);
