#!/usr/bin/env node
/**
 * C 样本验证(read-only): 对真实 abrain 库里所有带 source_ref 的条目跑
 * provenance liveness 检测, 打印分布 + 被 flag 的条目。不写任何东西。
 *
 * Run: node scripts/derive-provenance.mjs   (ABRAIN_ROOT 可覆盖)
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { checkProvenanceLiveness, formatProvenanceReport } = await jiti.import(
  path.join(__dirname, "..", "extensions/memory/provenance-liveness.ts"),
);

const abrainRoot = process.env.ABRAIN_ROOT || path.join(os.homedir(), ".abrain");
const docsRoot = path.resolve(__dirname, ".."); // pi-astack repo root (docs/adr/ lives here)

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === ".git" || e.name === ".state") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.name.endsWith(".md")) yield p;
  }
}
function extractSourceRef(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return undefined;
  const sr = fm[1].match(/^source_ref:\s*(.+)$/m);
  return sr ? sr[1].trim() : undefined;
}

const inputs = [];
for (const f of walk(abrainRoot)) {
  const sourceRef = extractSourceRef(fs.readFileSync(f, "utf-8"));
  if (sourceRef) inputs.push({ slug: path.basename(f, ".md"), sourceRef });
}

const report = checkProvenanceLiveness(inputs, { docsRoot });
console.log(formatProvenanceReport(report));
console.log(`\n(scanned ${abrainRoot}; docsRoot=${docsRoot})`);
