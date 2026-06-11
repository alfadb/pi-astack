#!/usr/bin/env node
/**
 * PR-4/P0.3 live dossier — Tier-1 Jaccard adjudication prompt validation.
 *
 * Calls the DeepSeek API directly (OpenAI-compatible, same wiring as
 * smoke-classifier-prompt.mjs) with buildTier1AdjudicationPrompt against
 * 3 fixtures spanning the closed decision space:
 *   1. near-verbatim restatement            → expected update
 *   2. same topic, adds an exception clause → expected merge (body keeps both)
 *   3. Jaccard false-merge (pnpm workspace vs pnpm — the P0.3 motivating
 *      hazard class)                        → expected create OR a merge
 *      whose body preserves BOTH constraints. The R2' contract this lane
 *      exists for is NO CONTENT LOSS (the old gate consumed the directive
 *      wholesale); create-vs-merge on a refinement pair is adjudicator
 *      taste, so the dossier pins the invariant, not the taste.
 *
 * Usage: DEEPSEEK_BASE_URL=https://sub2api.alfadb.cn node scripts/smoke-tier1-adjudicator-prompt.mjs
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const API_KEY = process.env.DEEPSEEK_API_KEY;
const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MODEL = "deepseek-chat"; // v4-flash alias — matches curatorModel default tier

if (!API_KEY) {
  console.error("❌ DEEPSEEK_API_KEY not set");
  process.exit(1);
}

const { buildTier1AdjudicationPrompt, parseTier1Adjudication } = await jiti.import(
  `${repoRoot}/extensions/sediment/tier1-adjudicator.ts`,
);

const FIXTURES = [
  {
    label: "restatement -> update",
    expected: ["update"],
    input: {
      draftTitle: "git.alfadb.cn 仓库用 glab 管理",
      draftBody: "git.alfadb.cn 上托管的所有仓库必须使用 glab CLI 工具进行管理操作。",
      existingSlug: "glab-rule",
      existingTitle: "glab 管理规则",
      existingBody: "所有托管在 git.alfadb.cn 的仓库必须使用 glab CLI 工具进行管理操作。",
    },
  },
  {
    label: "adds exception clause -> merge",
    expected: ["merge"],
    mustKeep: ["glab", "原生"],
    input: {
      draftTitle: "glab 管理但 git 原生操作除外",
      draftBody: "git.alfadb.cn 的仓库用 glab 管理，但 commit、push、pull、clone 这些 git 原生操作允许直接用原生 git。",
      existingSlug: "glab-rule",
      existingTitle: "glab 管理规则",
      existingBody: "所有托管在 git.alfadb.cn 的仓库必须使用 glab CLI 工具进行管理操作。",
    },
  },
  {
    label: "jaccard false-merge (pnpm workspace vs pnpm) -> create OR both-preserving merge",
    expected: ["create", "merge"],
    // Enforced only when decision=merge: the merged body must keep BOTH the
    // general pnpm requirement and the workspace/monorepo constraint.
    mustKeep: ["pnpm workspace", "pnpm 来管理依赖"],
    input: {
      draftTitle: "monorepo 用 pnpm workspace 管理",
      draftBody: "新的 monorepo 项目必须用 pnpm workspace 来管理多包结构和依赖提升。",
      existingSlug: "pnpm-rule",
      existingTitle: "包管理器用 pnpm",
      existingBody: "新的 Node.js 项目必须用 pnpm 来管理依赖。",
    },
  },
];

async function call(prompt) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1500,
      stream: false,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

let failures = 0;
console.log(`tier1 adjudicator prompt dossier — model=${MODEL} base=${BASE_URL}`);
for (const f of FIXTURES) {
  const raw = await call(buildTier1AdjudicationPrompt(f.input));
  const parsed = parseTier1Adjudication(raw);
  const ok = parsed && f.expected.includes(parsed.decision)
    // mustKeep pins the no-content-loss invariant on merge outputs only
    // (create keeps both rules by construction — nothing to check).
    && (!f.mustKeep || parsed.decision !== "merge" || f.mustKeep.every((k) => (parsed.mergedBody ?? "").includes(k)));
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${f.label}`);
  console.log(`        decision=${parsed?.decision ?? "PARSE_FAIL"} reason=${(parsed?.reason ?? raw.slice(0, 120)).slice(0, 160)}`);
  if (parsed?.mergedBody) console.log(`        merged_body=${parsed.mergedBody.slice(0, 200)}`);
}
console.log(failures === 0 ? `PASS — ${FIXTURES.length}/3 fixtures expected-aligned.` : `FAIL — ${failures}/3 fixtures off-expectation.`);
process.exit(failures === 0 ? 0 : 1);
