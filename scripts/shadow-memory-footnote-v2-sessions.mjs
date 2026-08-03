#!/usr/bin/env node
/** Read-only v1/v2 memory-footnote parser comparison over real Pi sessions. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sessionsRoot = path.resolve(process.argv[2] || path.join(process.env.HOME || "", ".pi/agent/sessions"));
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const collector = jiti(path.join(repoRoot, "extensions/sediment/outcome-collector.ts"));
const { sanitizeForMemory } = jiti(path.join(repoRoot, "extensions/sediment/sanitizer.ts"));

function filesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(file));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(file);
  }
  return out;
}
function inventoryHash(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    const stat = fs.statSync(file);
    hash.update(`${file}\0${stat.size}\0${stat.mtimeMs}\n`);
  }
  return hash.digest("hex");
}
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => part && typeof part === "object" && part.type === "text" && typeof part.text === "string" ? part.text : "").join("");
}
function validSlug(slug) {
  return !!slug && slug.length >= 3 && !/[\s<>|\\/:'"`,()\[\]{}]/.test(slug) && !slug.startsWith("-") && !slug.endsWith("-");
}
function auditText(text) {
  const result = sanitizeForMemory(text);
  return result.ok ? (result.text ?? text) : `[redacted: ${result.error || "sanitize_failed"}]`;
}
function legacyParse(text) {
  const entries = [];
  const dropped = [];
  const fence = /```memory-footnote\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(text)) !== null) {
    const body = match[1].trim();
    const entry = {};
    let key = "";
    let value = "";
    for (const line of body.split("\n")) {
      const kv = line.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (kv) {
        if (key) entry[key] = value.trim();
        key = kv[1];
        value = kv[2];
      } else if (key) value += `\n${line}`;
    }
    if (key) entry[key] = value.trim();
    const rawSlug = (entry.entry ?? entry.slug ?? "").trim();
    const slug = collector.sanitizeSlug(rawSlug);
    const used = (entry.used ?? "").toLowerCase().trim();
    if (!slug) { dropped.push("empty_slug"); continue; }
    if (!validSlug(slug)) { dropped.push("invalid_slug"); continue; }
    if (!["decisive", "confirmatory", "retrieved-unused"].includes(used)) { dropped.push("invalid_used"); continue; }
    entries.push({
      entry_slug: slug,
      used,
      counterfactual: auditText(entry.counterfactual ?? ""),
      ...((entry.decision_brief_id ?? entry.decisionBriefId ?? "").trim() ? { decision_brief_id: (entry.decision_brief_id ?? entry.decisionBriefId).trim() } : {}),
    });
  }
  return { entries, dropped };
}
function stableHash(input) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
function eventId(entry) {
  const suffix = `${entry.used}:${stableHash(entry.counterfactual.slice(0, 1024))}`;
  return entry.decision_brief_id
    ? `footnote:${entry.entry_slug}:${entry.decision_brief_id}:${suffix}`
    : `footnote:${entry.entry_slug}:${suffix}`;
}
function fenceShapes(text) {
  const out = [];
  const fence = /```memory-footnote\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = fence.exec(text)) !== null) {
    const body = match[1] ?? "";
    out.push({ targets: (body.match(/^(?:entry|slug):\s*/gm) ?? []).length, separators: (body.match(/^\s*---\s*$/gm) ?? []).length });
  }
  return out;
}

if (!fs.existsSync(sessionsRoot) || !fs.statSync(sessionsRoot).isDirectory()) throw new Error(`sessions directory not found: ${sessionsRoot}`);
const sessionFiles = filesUnder(sessionsRoot).sort();
const sourceInventoryBefore = inventoryHash(sessionFiles);
const stats = {
  schema_version: "memory-footnote-v2-session-shadow/v1",
  mode: "read_only",
  sessions_root: sessionsRoot,
  files_scanned: 0,
  source_inventory_before: sourceInventoryBefore,
  source_inventory_after: "",
  source_inventory_unchanged: false,
  jsonl_lines_scanned: 0,
  assistant_messages_scanned: 0,
  messages_with_footnotes: 0,
  fences_scanned: 0,
  strict_legacy_messages: 0,
  strict_legacy_valid_records: 0,
  strict_parse_exact_matches: 0,
  strict_event_id_stable_records: 0,
  strict_parse_drift_messages: 0,
  multi_record_candidate_messages: 0,
  multi_record_candidate_fences: 0,
  legacy_valid_records_in_candidates: 0,
  v2_valid_records_in_candidates: 0,
  additional_valid_records_recovered: 0,
  candidate_drops_legacy: 0,
  candidate_drops_v2: 0,
  recovery_examples: [],
};

for (const file of sessionFiles) {
  stats.files_scanned++;
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line.trim()) continue;
    stats.jsonl_lines_scanned++;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.type !== "message" || row?.message?.role !== "assistant") continue;
    stats.assistant_messages_scanned++;
    const text = textOf(row.message.content);
    if (!text.includes("```memory-footnote")) continue;
    const shapes = fenceShapes(text);
    if (!shapes.length) continue;
    stats.messages_with_footnotes++;
    stats.fences_scanned += shapes.length;
    const legacy = legacyParse(text);
    const v2 = collector.parseMemoryFootnote(text);
    const strict = shapes.every((shape) => shape.targets <= 1 && shape.separators === 0);
    if (strict) {
      stats.strict_legacy_messages++;
      stats.strict_legacy_valid_records += legacy.entries.length;
      const parseEqual = JSON.stringify(v2.entries) === JSON.stringify(legacy.entries)
        && JSON.stringify(v2.dropped.map((item) => item.reason)) === JSON.stringify(legacy.dropped);
      if (parseEqual) stats.strict_parse_exact_matches++;
      else stats.strict_parse_drift_messages++;
      const oldIds = legacy.entries.map(eventId);
      const newIds = v2.entries.map(eventId);
      for (let i = 0; i < oldIds.length; i++) if (oldIds[i] === newIds[i]) stats.strict_event_id_stable_records++;
      continue;
    }
    stats.multi_record_candidate_messages++;
    stats.multi_record_candidate_fences += shapes.filter((shape) => shape.targets > 1 || shape.separators > 0).length;
    stats.legacy_valid_records_in_candidates += legacy.entries.length;
    stats.v2_valid_records_in_candidates += v2.entries.length;
    stats.additional_valid_records_recovered += Math.max(0, v2.entries.length - legacy.entries.length);
    stats.candidate_drops_legacy += legacy.dropped.length;
    stats.candidate_drops_v2 += v2.dropped.length;
    if (v2.entries.length > legacy.entries.length && stats.recovery_examples.length < 8) {
      stats.recovery_examples.push({
        file: path.relative(sessionsRoot, file),
        line: index + 1,
        fences: shapes.length,
        legacy_valid: legacy.entries.length,
        v2_valid: v2.entries.length,
        recovered: v2.entries.length - legacy.entries.length,
      });
    }
  }
}

stats.source_inventory_after = inventoryHash(sessionFiles);
stats.source_inventory_unchanged = stats.source_inventory_after === stats.source_inventory_before;
console.log(JSON.stringify(stats, null, 2));
if (!stats.source_inventory_unchanged || stats.strict_parse_drift_messages !== 0 || stats.strict_event_id_stable_records !== stats.strict_legacy_valid_records) process.exitCode = 1;
