#!/usr/bin/env node
/**
 * Smoke test for ADR 0034 §2.1 decomposer glue (Phase 4 prep).
 *
 * Tests the deterministic half of the cognitive layer: prompt builder +
 * parseDecomposerResponse + decomposeAdr (injected llmCall). The live model call
 * is stubbed; planIngest re-validation is exercised end-to-end. No pi runtime.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  passed++;
}

function transpileDirs(outRoot, dirs) {
  const extRoot = path.join(repoRoot, "extensions");
  for (const dir of dirs) {
    const srcDir = path.join(extRoot, dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(srcDir, file), "utf-8");
      const out = ts.transpileModule(src, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      }).outputText;
      const outPath = path.join(outRoot, dir, file.replace(/\.ts$/, ".js"));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-decomp-"));
transpileDirs(tmp, ["_shared", "memory", "sediment"]);

const dec = require(path.join(tmp, "memory", "adr-decomposer.js"));
const ingest = require(path.join(tmp, "memory", "ingest-adr.js"));
const { ADR_DECOMPOSER_PROMPT, buildDecomposerPrompt, parseDecomposerResponse, decomposeAdr } = dec;
const { planIngest } = ingest;

const ADR = "docs/adr/0026-second-brain-decision-participation.md";
const SHA = "cafe123";

const validJson = JSON.stringify({
  processed: ["§2 Mechanism", "§3 Flow"],
  skipped: [{ heading: "§5 Invariants", reason: "direction-class, not mechanism" }],
  drafts: [
    { slug: "decision-participation-loop", title: "Decision participation loop", kind: "pattern", status: "active", confidence: 7, compiledTruth: "The brain participates at decision points via memory_decide, not passively.", sourceHeading: "§2 Mechanism", directionImpact: ["supports | requirements.md#REQ-003 | none"] },
    { slug: "decide-brief-token-cap", title: "Decide brief token cap", kind: "fact", compiledTruth: "The decision brief is capped at ~500 tokens to stay advisory, not directive.", sourceHeading: "§3 Flow" },
  ],
});

// ─── prompt builder ─────────────────────────────────────────────────────────
{
  assert(/One ADR is NOT one entry/.test(ADR_DECOMPOSER_PROMPT), "prompt: mandates decomposition");
  assert(/STRICT JSON/.test(ADR_DECOMPOSER_PROMPT), "prompt: demands JSON output");
  assert(/never silently accept/i.test(ADR_DECOMPOSER_PROMPT), "prompt: red-line escalation instruction");
  const p = buildDecomposerPrompt(ADR, "# ADR body\n\nmechanism prose");
  assert(p.includes(ADR) && p.includes("mechanism prose"), "prompt: embeds source path + content");
}

// ─── parse: valid (plain + fenced) ──────────────────────────────────────────
{
  const r = parseDecomposerResponse(validJson, ADR, SHA);
  assert(!r.error && r.source, "parse: valid JSON → source");
  assert(r.source.adrPath === ADR && r.source.sha === SHA, "parse: adrPath + sha carried");
  assert(r.source.decomposition.drafts.length === 2, "parse: 2 drafts");
  assert(r.source.decomposition.processed.length === 2, "parse: processed");
  assert(r.source.decomposition.skipped.length === 1 && r.source.decomposition.skipped[0].reason.length > 0, "parse: skipped + reason");
  assert(r.source.decomposition.drafts[0].directionImpact[0] === "supports | requirements.md#REQ-003 | none", "parse: directionImpact carried");
}
{
  const fenced = "Here you go:\n```json\n" + validJson + "\n```\nDone.";
  const r = parseDecomposerResponse(fenced, ADR, SHA);
  assert(!r.error && r.source && r.source.decomposition.drafts.length === 2, "parse: fenced JSON extracted");
}

// ─── parse: malformed → error (never throws) ────────────────────────────────
{
  assert(parseDecomposerResponse("no json here at all", ADR, SHA).error, "parse: no JSON → error");
  assert(parseDecomposerResponse("{ broken json", ADR, SHA).error, "parse: broken JSON → error");
  assert(parseDecomposerResponse(JSON.stringify({ processed: [] }), ADR, SHA).error, "parse: missing drafts → error");
  assert(parseDecomposerResponse(JSON.stringify({ drafts: [] }), ADR, SHA).error, "parse: 0 drafts → error");
  assert(parseDecomposerResponse(JSON.stringify([1, 2, 3]), ADR, SHA).error, "parse: array not object → error");
}

// ─── parse: partial drafts kept (issues surfaced by planIngest, not dropped) ─
{
  const partial = JSON.stringify({ drafts: [{ title: "no slug no kind", compiledTruth: "x".repeat(30), sourceHeading: "§2" }] });
  const r = parseDecomposerResponse(partial, ADR, SHA);
  assert(!r.error && r.source.decomposition.drafts.length === 1, "parse: partial draft kept");
  const m = planIngest([r.source]);
  assert(m.entries[0].issues.length > 0, "parse+plan: partial draft surfaces issues downstream (not silently dropped)");
}

// ─── decomposeAdr with injected llmCall ─────────────────────────────────────
{
  const r = await decomposeAdr(ADR, "# body", SHA, async (prompt) => {
    assert(prompt.includes("STRICT JSON"), "decomposeAdr: prompt passed to llmCall");
    return validJson;
  });
  assert(!r.error && r.source.decomposition.drafts.length === 2, "decomposeAdr: stub → source");
}
{
  const r = await decomposeAdr(ADR, "# body", SHA, async () => { throw new Error("model down"); });
  assert(r.error && /model down/.test(r.error), "decomposeAdr: llmCall throw → error (no crash)");
}

// ─── end-to-end: decompose → plan validates red-line ────────────────────────
{
  const redlineJson = JSON.stringify({
    processed: ["§2"], skipped: [],
    drafts: [{ slug: "bad", title: "Bad", kind: "decision", compiledTruth: "A compiled truth long enough to pass.", sourceHeading: "§2", directionImpact: ["weakens | direction.md#INV-AUTONOMY | none"] }],
  });
  const r = await decomposeAdr(ADR, "# body", SHA, async () => redlineJson);
  const m = planIngest([r.source]);
  assert(m.entries[0].issues.some((i) => /MUST be escalated/.test(i)), "e2e: red-line draft from LLM still caught by planIngest");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`smoke:adr-decomposer OK (${passed} assertions)`);
