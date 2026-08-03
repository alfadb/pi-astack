#!/usr/bin/env node
/** memory-footnote v2 protocol and collector compatibility smoke. */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const collector = jiti(path.join(repoRoot, "extensions/sediment/outcome-collector.ts"));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (error) {
    console.error(`  FAIL  ${name}\n        ${error?.stack || error}`);
    process.exitCode = 1;
  }
}
function assert(condition, message) { if (!condition) throw new Error(message); }
const assistant = (content) => [{ type: "message", message: { role: "assistant", content } }];

check("prompt carries v2 marker and one trailing fence record contract", () => {
  const source = fs.readFileSync(path.join(repoRoot, "extensions/memory/index.ts"), "utf8");
  assert(source.includes('MEMORY_FOOTNOTE_PROTOCOL_VERSION = "memory-footnote-v2"'), "v2 marker missing");
  assert(source.includes("附加且只") && source.includes("独立一行 \\`---\\`") && source.includes("closing fence 后不要再写正文"), "single trailing fence contract missing");
});

check("legacy single record and multiple fences remain valid", () => {
  const text = "```memory-footnote\nentry: legacy-alpha\nused: decisive\ncounterfactual: changed\n```\n\n```memory-footnote\nslug: legacy-beta\nused: confirmatory\ncounterfactual: same decision\n```";
  const parsed = collector.parseMemoryFootnote(text);
  assert(parsed.dropped.length === 0, JSON.stringify(parsed));
  assert(parsed.entries.map((row) => row.entry_slug).join(",") === "legacy-alpha,legacy-beta", JSON.stringify(parsed));
});

check("unchanged valid legacy record retains event id", () => {
  const record = "entry: stable-memory\nused: decisive\ndecision_brief_id: stable-brief\ncounterfactual: would choose differently";
  const legacy = collector.collectOutcomes(assistant(`\`\`\`memory-footnote\n${record}\n\`\`\``), "event-id-stability");
  const v2 = collector.collectOutcomes(assistant(`reply\n\n\`\`\`memory-footnote\n${record}\n\`\`\``), "event-id-stability");
  assert(legacy.rows.length === 1 && v2.rows.length === 1, `unexpected rows: ${JSON.stringify({ legacy, v2 })}`);
  assert(legacy.rows[0].event_id === v2.rows[0].event_id, `event id drift: ${JSON.stringify({ legacy: legacy.rows[0], v2: v2.rows[0] })}`);
});

check("one fence recovers separators and repeated entry/slug fields", () => {
  const text = "```memory-footnote\nentry: alpha-memory\nused: decisive\ncounterfactual: changed\n---\nslug: beta-memory\nused: confirmatory\ncounterfactual: same\nentry: gamma-memory\nused: retrieved-unused\ncounterfactual: irrelevant\nslug: alpha-memory\nused: confirmatory\ncounterfactual: same\n```";
  const parsed = collector.parseMemoryFootnote(text);
  assert(parsed.dropped.length === 0, JSON.stringify(parsed));
  assert(parsed.entries.map((row) => row.entry_slug).join(",") === "alpha-memory,beta-memory,gamma-memory,alpha-memory", JSON.stringify(parsed));
});

check("invalid sibling drops independently", () => {
  const text = "```memory-footnote\nentry: valid-before\nused: decisive\ncounterfactual: changed\n---\nentry: <slug>\nused: confirmatory\ncounterfactual: placeholder\n---\nentry: valid-after\nused: wrong-value\ncounterfactual: invalid taxonomy\n---\nentry: final-valid\nused: retrieved-unused\ncounterfactual: irrelevant\n```";
  const parsed = collector.parseMemoryFootnote(text);
  assert(parsed.entries.map((row) => row.entry_slug).join(",") === "valid-before,final-valid", JSON.stringify(parsed));
  assert(parsed.dropped.map((row) => row.reason).join(",") === "invalid_slug,invalid_used", JSON.stringify(parsed));
});

check("CRLF v2 multi-record parses without drop", () => {
  const text = [
    "```memory-footnote",
    "entry: crlf-alpha",
    "used: decisive",
    "counterfactual: changed",
    "---",
    "slug: crlf-beta",
    "used: confirmatory",
    "counterfactual: same",
    "```",
  ].join("\r\n");
  const parsed = collector.parseMemoryFootnote(text);
  assert(parsed.dropped.length === 0, JSON.stringify(parsed));
  assert(
    parsed.entries.map((row) => row.entry_slug).join(",") === "crlf-alpha,crlf-beta",
    JSON.stringify(parsed),
  );
  assert(
    parsed.entries.map((row) => row.used).join(",") === "decisive,confirmatory",
    JSON.stringify(parsed),
  );
});

if (process.exitCode) {
  console.error(`\nFAILED: ${passed}/6 checks passed`);
} else {
  console.log(`\nPASS: ${passed}/6 checks passed`);
}
