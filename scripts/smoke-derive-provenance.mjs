#!/usr/bin/env node
/**
 * C 门(deterministic, 免 LLM): source_ref provenance liveness 检测器。
 * 真实库当前全是 source_ingested(预期), 只命中 1 个 verdict, 所以用临时 ADR
 * fixtures 覆盖全部 7 个 verdict + parseSourceRef + flagged 集合。
 */
import { createJiti } from "jiti";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url);
const { parseSourceRef, checkProvenanceLiveness, FLAGGED_VERDICTS } = await jiti.import(
  path.join(__dirname, "..", "extensions/memory/provenance-liveness.ts"),
);

let fails = 0;
const ok = (c, m) => { console.log(`${c ? "PASS" : "FAIL"}: ${m}`); if (!c) fails++; };

// ── parseSourceRef ──
{
  const p = parseSourceRef('"docs/adr/0016-x.md#新的操作模型@627de33"');
  ok(p && p.adrPath === "docs/adr/0016-x.md" && p.heading === "新的操作模型" && p.sha === "627de33", "parse: 带引号 path#heading@sha");
  const p2 = parseSourceRef("docs/adr/0032-y.md### 3. auto-continue@abc");
  ok(p2 && p2.adrPath === "docs/adr/0032-y.md" && p2.heading === "3. auto-continue" && p2.sha === "abc", "parse: ### 多级 heading 去前缀 #");
  ok(parseSourceRef("no-at-here") === null, "parse: 无 @ → null");
  ok(parseSourceRef("nofile-no-md#h@s") === null, "parse: 无 .md → null");
  ok(parseSourceRef("docs/adr/0001-x.mdx#h@s") === null, "parse: .mdx 不误判(非 .md#)→ null");
}

// ── 临时 docsRoot + ADR fixtures ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "prov-"));
const adrDir = path.join(tmp, "docs/adr");
fs.mkdirSync(adrDir, { recursive: true });
const writeAdr = (name, status, body) =>
  fs.writeFileSync(path.join(adrDir, name), `---\ndoc_type: adr\nstatus: ${status}\n---\n\n# ${name}\n\n${body}\n`);
writeAdr("0001-live.md", "accepted", "## 决策\n\n内容");
writeAdr("0002-archived.md", "archived", "## 机制\n\n已搬走");
writeAdr("0003-ingested-accepted.md", "accepted", "## 机制（已分解入 abrain，逐条 slug）\n\n`slug-a` · `slug-b`");
writeAdr("0004-superseded.md", "superseded", "## 决策\n\n被取代");
writeAdr("0005-superseded-ingested.md", "superseded", "## 机制（逐条 slug）\n\n被取代且 ingest");
writeAdr("0006-proposed.md", "proposed", "## 决策\n\n草案");
writeAdr("0007-drifted.md", "accepted", "## 改名后的标题\n\n原标题没了");
// marker 只在正文 prose(引用别的 ADR 被 ingest), 不在 heading → 不应判为 ingested
writeAdr("0008-prose-mention.md", "accepted", "## 决策\n\n依赖 ADR 0015(已 ingest 入 abrain)。\n\n## 真在的标题\n\nx");

const E = (slug, sourceRef) => ({ slug, sourceRef });
const entries = [
  E("e-live", "docs/adr/0001-live.md#决策@s"),
  E("e-archived", "docs/adr/0002-archived.md#机制@s"),
  E("e-ingested-accepted", "docs/adr/0003-ingested-accepted.md#新的操作模型@s"), // heading 没了但 ingested → 预期
  E("e-superseded", "docs/adr/0004-superseded.md#决策@s"),
  E("e-superseded-ingested", "docs/adr/0005-superseded-ingested.md#原标题@s"), // superseded 优先于 ingested
  E("e-proposed", "docs/adr/0006-proposed.md#决策@s"),
  E("e-drifted", "docs/adr/0007-drifted.md#原始标题@s"), // live ADR 但 heading 没了 → 真 drift
  E("e-file-missing", "docs/adr/9999-gone.md#x@s"),
  E("e-unparseable", "this is not a ref"),
  E("e-prose-live", "docs/adr/0008-prose-mention.md#决策@s"), // marker 仅在 prose → 非 ingested, heading 在 → live
  E("e-prose-drift", "docs/adr/0008-prose-mention.md#原标题没了@s"), // 非 ingested + heading 没了 → 真 drift
  E("e-escape", "docs/adr/../../../etc/passwd.md#x@s"), // 路径逃逸 → file_missing
  E("e-no-ref", undefined), // 跳过
];
const r = checkProvenanceLiveness(entries, { docsRoot: tmp });
const v = (slug) => r.findings.find((f) => f.slug === slug)?.verdict;

ok(r.withSourceRef === 12, `withSourceRef=12 (13 条, 1 条无 source_ref 跳过) got ${r.withSourceRef}`);
ok(v("e-live") === "live", "live: accepted + heading 在");
ok(v("e-archived") === "source_ingested", "archived → source_ingested");
ok(v("e-ingested-accepted") === "source_ingested", "accepted+ingest marker + heading 没了 → source_ingested(预期, 非 drift)");
ok(v("e-superseded") === "source_superseded", "superseded → flag");
ok(v("e-superseded-ingested") === "source_superseded", "superseded 优先于 ingested");
ok(v("e-proposed") === "source_proposed", "proposed → provisional");
ok(v("e-drifted") === "heading_missing", "live ADR + heading 没了 → 真 drift");
ok(v("e-file-missing") === "file_missing", "文件不存在 → file_missing");
ok(v("e-unparseable") === "unparseable", "畸形 ref → unparseable");
ok(v("e-prose-live") === "live", "ingest marker 仅在 prose(非 heading)→ 非 ingested, heading 在 → live");
ok(v("e-prose-drift") === "heading_missing", "prose-only marker 不掩盖真 drift → heading_missing");
ok(v("e-escape") === "file_missing", "路径逃逸 docsRoot → file_missing(含 containment guard)");
ok(!r.findings.find((f) => f.slug === "e-no-ref"), "无 source_ref 条目被跳过");

const flagged = r.findings.filter((f) => FLAGGED_VERDICTS.has(f.verdict)).map((f) => f.slug).sort();
ok(JSON.stringify(flagged) === JSON.stringify(["e-drifted", "e-escape", "e-file-missing", "e-prose-drift", "e-superseded", "e-superseded-ingested", "e-unparseable"]),
   `flagged 集合正确 got ${JSON.stringify(flagged)}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? "\n✅ ALL PASS — provenance liveness: 7 verdict + parse + 精确优先级 + flagged 集合" : `\n❌ ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
