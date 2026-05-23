#!/usr/bin/env node
/**
 * ADR 0025 P1 smoke — classifier prompt prototype validation.
 *
 * Calls the DeepSeek API directly (OpenAI-compatible) with the
 * active-correction-classifier-v1 prompt against 20 conversation fixtures.
 *
 * Usage: node scripts/smoke-classifier-prompt.mjs
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// ── Config ────────────────────────────────────────────────────────────

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = "deepseek-chat";  // deepseek-v4-flash alias

if (!API_KEY) {
  console.error("❌ DEEPSEEK_API_KEY not set");
  process.exit(1);
}

// ── Helpers ────────────────────────────────────────────────────────────

function loadPrompt() {
  const promptPath = path.join(repoRoot, "extensions", "sediment", "prompts", "active-correction-classifier-v1.md");
  if (!fs.existsSync(promptPath)) {
    console.error(`❌ Prompt file not found: ${promptPath}`);
    process.exit(1);
  }
  return fs.readFileSync(promptPath, "utf-8");
}

async function callDeepSeek(systemPrompt, windowText, label) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Transcript window:\n<<<PI_SEDIMENT_WINDOW\n${windowText}\nPI_SEDIMENT_WINDOW>>>` },
    ],
    temperature: 0.3,
    max_tokens: 2000,
    stream: false,
  };

  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${errText.substring(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

function parseClassifierOutput(raw) {
  const jsonMatch = raw.match(/```json\s*([\s\S]*?)```/) || raw.match(/(\{[\s\S]*\})/);
  if (!jsonMatch) return { raw, parsed: null, parse_error: "no JSON found in output" };
  try {
    return { raw, parsed: JSON.parse(jsonMatch[1]), parse_error: null };
  } catch (e) {
    return { raw, parsed: null, parse_error: e.message };
  }
}

// ── Fixtures ───────────────────────────────────────────────────────────

function buildFixtures() {
  return [
    // ── OBVIOUS (5) ──────────────────────────────────────────────
    {
      id: "obvious-1-durable-shift", category: "obvious",
      turns: [
        { role: "user", content: "帮我搭一个 React 项目的 CI pipeline" },
        { role: "assistant", content: "好的。我先看看你的项目结构... 你之前用 GitHub Actions 还是 GitLab CI？" },
        { role: "user", content: "用 GitHub Actions 就行。以后这个项目都用 GitHub Actions，不用 GitLab CI 了" },
      ],
      expected: "durable preference shift: GitHub Actions over GitLab CI, scoped to this project",
    },
    {
      id: "obvious-2-forget", category: "obvious",
      turns: [
        { role: "user", content: "帮我改一下那个数据库连接的配置" },
        { role: "assistant", content: "好的。我看到你之前有一条关于 PostgreSQL 连接池大小的偏好..." },
        { role: "user", content: "不对，忘掉那条。我们现在用的连接池配置已经变了" },
      ],
      expected: "supersede instruction: forget the PostgreSQL connection pool entry",
    },
    {
      id: "obvious-3-no-marker-shift", category: "obvious",
      turns: [
        { role: "user", content: "这个项目的包管理怎么配？" },
        { role: "assistant", content: "我看看... 你的 package.json 里有 yarn.lock，建议用 yarn" },
        { role: "user", content: "不对，我换了，现在用 pnpm" },
      ],
      expected: "durable shift without '以后' marker: switched to pnpm",
    },
    {
      id: "obvious-4-contradiction", category: "obvious",
      turns: [
        { role: "user", content: "怎么你每次都推荐用 Express？" },
        { role: "assistant", content: "因为你之前的项目都用 Express..." },
        { role: "user", content: "你怎么记成 Express 了？我现在都用 Fastify" },
      ],
      expected: "contradiction surfacing: past recording wrong (Express instead of Fastify)",
    },
    {
      id: "obvious-5-no-more", category: "obvious",
      turns: [
        { role: "user", content: "帮我把这些依赖升级一下" },
        { role: "assistant", content: "npm-check-updates 跑完了，要一起升级 react-router 到 v7 吗？" },
        { role: "user", content: "不用，以后不要再用 react-router 了。这个项目切到 TanStack Router" },
      ],
      expected: "durable + supersession: no more react-router, switch to TanStack Router",
    },
    // ── AMBIGUOUS (10) ───────────────────────────────────────────
    {
      id: "ambiguous-1-scoped-durable", category: "ambiguous",
      turns: [
        { role: "user", content: "这个项目用 TypeScript 严格模式" },
        { role: "assistant", content: "好的，tsconfig 里 strict: true。" },
        { role: "user", content: "对，这个项目用 strict。不过平时我个人的小项目不用 strict，太麻烦了" },
      ],
      expected: "scoped durable — this project strict, personal projects not",
    },
    {
      id: "ambiguous-2-now-prefer", category: "ambiguous",
      turns: [
        { role: "user", content: "你觉得 prisma 和 drizzle 哪个好？" },
        { role: "assistant", content: "各有优劣。Prisma 迁移工具更强，Drizzle 更轻量。你之前用过 Prisma。" },
        { role: "user", content: "嗯，现在我更倾向 Drizzle 了。type-safe 而且 bundle 小" },
      ],
      expected: "preference update: now prefers Drizzle. Could be durable or exploration",
    },
    {
      id: "ambiguous-3-try-this-time", category: "ambiguous",
      turns: [
        { role: "user", content: "这个 API 用什么做 rate limiting？" },
        { role: "assistant", content: "可以用 express-rate-limit，或者用 Redis 做分布式限流" },
        { role: "user", content: "这次试试 Redis 方案吧，之前没用过" },
      ],
      expected: "explicitly task-local — '这次试试' should NOT be durable",
    },
    {
      id: "ambiguous-4-broken-switch", category: "ambiguous",
      turns: [
        { role: "user", content: "CI 又挂了" },
        { role: "assistant", content: "看起来是 node 版本的问题，GitHub Actions 默认还是 node 18" },
        { role: "user", content: "那切到 node 20 先跑通。GitHub Actions 真麻烦，下次项目用 GitLab CI 算了" },
      ],
      expected: "debug + casual complaint — '下次用 GitLab CI' could be frustration",
    },
    {
      id: "ambiguous-5-reluctant-accept", category: "ambiguous",
      turns: [
        { role: "user", content: "这个要不要加 ORM？" },
        { role: "assistant", content: "建议加。项目规模会增长，手写 SQL 后期维护成本高" },
        { role: "user", content: "也行吧。你推荐哪个？" },
      ],
      expected: "reluctant acceptance — '也行吧' is NOT a correction",
    },
    {
      id: "ambiguous-6-casual-complaint", category: "ambiguous",
      turns: [
        { role: "user", content: "帮我把这个组件重构一下" },
        { role: "assistant", content: "好的，我先看看当前的结构。这里用了 class component..." },
        { role: "user", content: "哎 class component 真难维护。不过先不管了，把这个功能做完" },
      ],
      expected: "casual complaint — explicitly defers action, NOT a correction",
    },
    {
      id: "ambiguous-7-multi-project-scope", category: "ambiguous",
      turns: [
        { role: "user", content: "这个项目的 eslint 规则太松了，加上 strict 模式" },
        { role: "assistant", content: "好的，加了。其他的项目也要改吗？" },
        { role: "user", content: "这个先改。其他的以后再说" },
      ],
      expected: "task-local — user defers '其他的以后再说'",
    },
    {
      id: "ambiguous-8-natural-upgrade", category: "ambiguous",
      turns: [
        { role: "user", content: "升级一下依赖吧" },
        { role: "assistant", content: "React 19 可用了，要一起升吗？" },
        { role: "user", content: "升" },
      ],
      expected: "acceptance of suggestion, not active preference declaration",
    },
    {
      id: "ambiguous-9-casual-mention", category: "ambiguous",
      turns: [
        { role: "user", content: "这个项目的测试覆盖率太低了" },
        { role: "assistant", content: "确实，只有 45%。要加测试吗？" },
        { role: "user", content: "嗯。以后新功能都要求 80% 覆盖率" },
      ],
      expected: "could be durable ('以后新功能都要求 80%') but context is complaint",
    },
    {
      id: "ambiguous-10-debug-vs-durable", category: "ambiguous",
      turns: [
        { role: "user", content: "这个性能问题怎么回事？" },
        { role: "assistant", content: "看起来是数据库查询 N+1 的问题。用 ORM 的 lazy loading 导致的" },
        { role: "user", content: "又是 ORM 的问题。以后涉及数据库的项目都用 raw SQL 算了" },
      ],
      expected: "frustration-driven — sounds durable but in debug context",
    },
    // ── NEGATIVE (5) ──────────────────────────────────────────────
    {
      id: "negative-1-task-instruction", category: "negative",
      turns: [
        { role: "user", content: "写一个用户注册的 API" },
        { role: "assistant", content: "好的，我用 Express router 来写" },
        { role: "user", content: "用 Fastify。这个项目底层就是 Fastify" },
      ],
      expected: "task instruction, not preference declaration",
    },
    {
      id: "negative-2-acceptance", category: "negative",
      turns: [
        { role: "user", content: "这个要不要加类型检查？" },
        { role: "assistant", content: "建议加，能避免很多运行时错误" },
        { role: "user", content: "好，加吧" },
      ],
      expected: "acceptance of suggestion, not preference",
    },
    {
      id: "negative-3-delegation", category: "negative",
      turns: [
        { role: "user", content: "你觉得用 React Router 还是 TanStack Router？" },
        { role: "assistant", content: "React Router 社区更大，TanStack Router 类型安全更好" },
        { role: "user", content: "你看着办吧" },
      ],
      expected: "delegation — explicitly declines to express preference",
    },
    {
      id: "negative-4-normal-conversation", category: "negative",
      turns: [
        { role: "user", content: "帮我解释一下这个函数的逻辑" },
        { role: "assistant", content: "这段代码做了三件事：1. 验证输入 2. 查询数据库 3. 格式化输出。用的是 PostgreSQL" },
        { role: "user", content: "好的，继续" },
      ],
      expected: "normal conversation, no correction",
    },
    {
      id: "negative-5-implicit-accept", category: "negative",
      turns: [
        { role: "user", content: "修复这个 lint 错误" },
        { role: "assistant", content: "改成 const 了，因为变量没有被重新赋值" },
        { role: "user", content: "好" },
      ],
      expected: "implicit acceptance, not correction",
    },
  ];
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  console.log(`🔬 ADR 0025 P1 classifier smoke test`);
  console.log(`   Model: ${MODEL} (via DeepSeek API)\n`);

  const prompt = loadPrompt();
  const fixtures = buildFixtures();
  const results = [];
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const windowText = f.turns.map(t => `[${t.role}]: ${t.content}`).join("\n\n");
    const label = `[${i + 1}/${fixtures.length}] ${f.id} (${f.category})`;

    try {
      process.stdout.write(`${label} ... `);
      const raw = await callDeepSeek(prompt, windowText, label);
      const output = parseClassifierOutput(raw);
      output.id = f.id;
      output.category = f.category;
      output.expected = f.expected;

      const p = output.parsed;
      const t = p?.typing ?? "parse error";
      const c = p?.confidence ?? "?";

      // Review buckets (not pass/fail — ADR 0024 §5.5: smoke is a
      // prompt-development dossier, not a release gate).
      let bucket = "needs-human-review";
      if (f.category === "negative" && p?.signal_found === false) {
        bucket = "expected-aligned";
      } else if (f.category === "obvious" && p?.signal_found === true && p?.typing === "durable") {
        bucket = "expected-aligned";
      } else if (f.category === "ambiguous") {
        bucket = "needs-human-review"; // ambiguous fixtures always need human read
      } else if (p?.signal_found === true && f.category === "negative") {
        bucket = "surprising-signal";
      } else if (p?.signal_found === false && f.category === "obvious") {
        bucket = "surprising-null";
      } else if (!p) {
        bucket = "parse-or-infra-issue";
      }
      output.review_bucket = bucket;

      const icon = bucket === "expected-aligned" ? "✓" : bucket === "surprising-signal" ? "⚡" : bucket === "surprising-null" ? "∅" : "📋";
      console.log(`${icon} [${bucket}] typing=${t}, conf=${c}`);
      results.push(output);
    } catch (e) {
      console.log(`❌ ${e.message}`);
      results.push({ id: f.id, category: f.category, error: e.message, review_bucket: "parse-or-infra-issue" });
    }

    // Rate limiting — DeepSeek free tier is 20 RPM
    if (i < fixtures.length - 1) await new Promise(r => setTimeout(r, 3000));
  }

  // ── Output ─────────────────────────────────────────────────────────
  const outPath = path.join(repoRoot, "smoke-classifier-results.json");
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`\n📄 Full reasoning traces: ${outPath}`);
  console.log(`   ${results.length} fixtures run.`);

  // Review bucket summary (informational only — NOT a gate. ADR 0024 §5.5).
  const byBucket = {};
  for (const r of results) {
    const b = r.review_bucket ?? "parse-or-infra-issue";
    byBucket[b] = (byBucket[b] || 0) + 1;
  }
  for (const [b, n] of Object.entries(byBucket)) {
    const label = b === "expected-aligned" ? "expected-aligned" :
                  b === "surprising-signal" ? "surprising-signal (author: review)" :
                  b === "surprising-null" ? "surprising-null (author: review)" :
                  b === "needs-human-review" ? "needs-human-review (ambiguous)" :
                  b;
    console.log(`   ${n} ${label}`);
  }
  console.log(`\n📖 Author should read reasoning_trace for surprising-signal and surprising-null buckets.`);
  console.log(`   This is a prompt-development dossier, not a release gate (ADR 0024 §4.2).`);
}

main().catch(e => { console.error(e); process.exit(1); });
