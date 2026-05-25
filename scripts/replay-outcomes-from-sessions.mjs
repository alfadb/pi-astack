#!/usr/bin/env node
/**
 * replay-outcomes-from-sessions.mjs — 一次性补救脚本
 *
 * 用途:
 *   commit 55933dc (2026-05-24 11:31 北京) 重构 user-global sidecar 路径时
 *   漏掉了 `import * as os from "node:os"`,导致 outcome-collector /
 *   curator-metrics / extractor-metrics 三个 logger 全部被 silent try/catch
 *   吞掉。在 commit 33db9f4 (2026-05-24 13:08 北京) 修复之前,
 *   outcome-ledger.jsonl 0 行新写入。
 *
 *   bug 1 fix 之后,如果 pi 进程没重启,仍然加载 BUGGY 版本,继续吞。
 *   本脚本独立于 pi runtime 跑,从 session jsonl 重算 missing outcomes
 *   append 到 outcome-ledger.jsonl,补救 9+ 小时数据 gap。
 *
 * 重建依据:
 *   collectOutcomes(branch, sessionId) 是纯函数,只读 session jsonl 里的
 *   `type: message` events。session jsonl 永久保存在
 *   ~/.pi/agent/sessions/<cwd-slug>/<ts>_<session-id>.jsonl。
 *
 * 设计:
 *   1. 扫 session 目录里所有 .jsonl
 *   2. 对每个 session,跑 collectOutcomes(整个 branch)
 *   3. 跟现有 outcome-ledger.jsonl 的 event_id-aware key 去重
 *   4. 只 append 没出现过的 outcome row
 *   5. --dry-run 模式只打印不写
 *
 * 这个脚本内嵌了 collectOutcomes 的完整逻辑(从 outcome-collector.ts 复制)
 * 因为脚本是 .mjs 不能直接 import .ts。如果 outcome-collector.ts 改了,
 * 这里也要同步更新。但本脚本是一次性补救工具,跑完即弃,不需要长期维护。
 *
 * Usage:
 *   node scripts/replay-outcomes-from-sessions.mjs [--dry-run] [--since=<iso>]
 *                                                  [--session-dir=<path>]
 *                                                  [--ledger=<path>]
 *
 * 默认值跟当前用户(单用户 alfadb 仓)对齐:
 *   --session-dir=~/.pi/agent/sessions/--home-worker-.pi--
 *   --ledger=~/.abrain/.state/sediment/outcome-ledger.jsonl
 *   --since= 不限制 (扫整个 session,靠去重避免重复)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── CLI args ──────────────────────────────────────────────────
function parseArgs() {
  const args = { dryRun: false, since: null, sessionDir: null, ledger: null };
  for (const a of process.argv.slice(2)) {
    if (a === "--dry-run") args.dryRun = true;
    else if (a.startsWith("--since=")) args.since = a.slice(8);
    else if (a.startsWith("--session-dir=")) args.sessionDir = a.slice(14);
    else if (a.startsWith("--ledger=")) args.ledger = a.slice(9);
    else if (a === "-h" || a === "--help") {
      console.log("Usage: node replay-outcomes-from-sessions.mjs [--dry-run] [--since=<iso>] [--session-dir=<path>] [--ledger=<path>]");
      process.exit(0);
    } else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

const ARGS = parseArgs();
const SESSION_DIR = ARGS.sessionDir || path.join(os.homedir(), ".pi/agent/sessions/--home-worker-.pi--");
const LEDGER_PATH = ARGS.ledger || path.join(os.homedir(), ".abrain/.state/sediment/outcome-ledger.jsonl");

// ── inline copy of collectOutcomes logic ──────────────────────
// (mirrors extensions/sediment/outcome-collector.ts as of 33db9f4)

function isValidSlug(s) {
  if (!s || s.length < 3) return false;
  if (/[\s<>|\\/:'"`,()\[\]{}]/.test(s)) return false;
  if (s.startsWith("-") || s.endsWith("-")) return false;
  return true;
}

function sanitizeSlug(raw) {
  let slug = raw.replace(/^project:[^:]+:/, "");
  slug = slug.replace(/^(world|workflow):/, "");
  slug = slug.replace(/:/g, "-");
  return slug.trim();
}

function extractText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && p.type === "text" ? (p.text ?? "") : ""))
    .join("");
}

function firstString(obj, keys) {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function stableHash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function toolResultEventId(msg, eventIndex, decisionBriefId) {
  const explicit = firstString(msg, ["toolCallId", "tool_call_id", "toolResultId", "tool_result_id", "id", "messageId", "message_id"]);
  if (explicit) return `tool:${explicit}`;
  if (decisionBriefId) return `decision:${decisionBriefId}`;
  const toolName = typeof msg.toolName === "string" ? msg.toolName : "unknown";
  const contentHash = stableHash(extractText(msg.content).slice(0, 4096));
  // Without a runtime toolCallId, prefer a content-derived fallback over
  // positional identity. It may undercount two identical tool results in one
  // session, but it will not overcount after branch index drift.
  void eventIndex;
  return `tool:${toolName}:${contentHash}`;
}

function footnoteOutcomeEventId(entry, eventIndex) {
  const counterfactualHash = stableHash((entry.counterfactual ?? "").slice(0, 1024));
  if (entry.decision_brief_id) return `footnote:${entry.entry_slug}:${entry.decision_brief_id}:${entry.used}:${counterfactualHash}`;
  void eventIndex;
  return `footnote:${entry.entry_slug}:${entry.used}:${counterfactualHash}`;
}

function outcomeLedgerDedupKey(row) {
  if (row.event_id) return `${row.session_id}|${row.entry_slug}|${row.source}|${row.event_id}`;
  const brief = row.decision_brief_id ? `|${row.decision_brief_id}` : "";
  if (row.source === "tool-result") return `${row.session_id}|${row.entry_slug}|tool-result${brief}`;
  return `${row.session_id}|${row.entry_slug}|memory-footnote|${row.used ?? ""}|${stableHash(row.counterfactual ?? "")}${brief}`;
}

function parseMemoryFootnote(text) {
  const entries = [];
  const dropped = [];
  const fenceRegex = /```memory-footnote\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const body = match[1].trim();
    const blockPreview = body.slice(0, 200);
    const entry = {};
    let currentKey = "";
    let currentValue = "";
    for (const line of body.split("\n")) {
      const kvMatch = line.match(/^(\w[\w_-]*):\s*(.*)$/);
      if (kvMatch) {
        if (currentKey) entry[currentKey] = currentValue.trim();
        currentKey = kvMatch[1];
        currentValue = kvMatch[2];
      } else if (currentKey) {
        currentValue += "\n" + line;
      }
    }
    if (currentKey) entry[currentKey] = currentValue.trim();
    const rawSlug = (entry.entry ?? entry.slug ?? "").trim();
    const slug = sanitizeSlug(rawSlug);
    const usedRaw = (entry.used ?? "").toLowerCase().trim();
    if (!slug) { dropped.push({ reason: "empty_slug", raw_slug: rawSlug, raw_used: usedRaw, raw_block_preview: blockPreview }); continue; }
    if (!isValidSlug(slug)) { dropped.push({ reason: "invalid_slug", raw_slug: slug, raw_used: usedRaw, raw_block_preview: blockPreview }); continue; }
    if (!["decisive", "confirmatory", "retrieved-unused"].includes(usedRaw)) {
      dropped.push({ reason: "invalid_used", raw_slug: slug, raw_used: usedRaw, raw_block_preview: blockPreview }); continue;
    }
    const decisionBriefId = (entry.decision_brief_id ?? entry.decisionBriefId ?? "").trim();
    entries.push({
      entry_slug: slug,
      used: usedRaw,
      counterfactual: entry.counterfactual ?? "",
      ...(decisionBriefId ? { decision_brief_id: decisionBriefId } : {}),
    });
  }
  return { entries, dropped };
}

function collectOutcomes(branch, sessionId, ts) {
  const rows = [];
  const dropped = [];
  const seen = new Map();
  let messageIndex = 0;
  for (const entry of branch) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.type !== "message" || !entry.message) continue;
    const eventIndex = messageIndex++;
    const msg = entry.message;
    const role = msg.role ?? "";
    const text = extractText(msg.content);
    if (role === "toolResult") {
      const toolName = msg.toolName ?? "";
      if (!["memory_search", "memory_get", "memory_decide"].includes(toolName)) continue;
      let results = [];
      let decisionBriefId;
      const absorbParsedToolResult = (parsed) => {
        if (Array.isArray(parsed)) { results.push(...parsed); return; }
        if (!parsed || typeof parsed !== "object") return;
        if (typeof parsed.decisionBriefId === "string") decisionBriefId = parsed.decisionBriefId;
        if (typeof parsed.decision_brief_id === "string") decisionBriefId = parsed.decision_brief_id;
        if (Array.isArray(parsed.cards)) results.push(...parsed.cards);
        if (Array.isArray(parsed.results)) results.push(...parsed.results);
        if (Array.isArray(parsed.entrySlugs)) results.push(...parsed.entrySlugs.map((slug) => ({ slug })));
        if (Array.isArray(parsed.entry_slugs)) results.push(...parsed.entry_slugs.map((slug) => ({ slug })));
        // Backward compatibility with older memory_decide payloads that
        // exposed `_meta.results`; current payloads only need entrySlugs.
        if (parsed._meta && typeof parsed._meta === "object") absorbParsedToolResult(parsed._meta);
        if (typeof parsed.slug === "string") results.push({ slug: parsed.slug });
      };
      try {
        if (typeof msg.content === "string") {
          absorbParsedToolResult(JSON.parse(msg.content));
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (block.type !== "text" || typeof block.text !== "string") continue;
            try { absorbParsedToolResult(JSON.parse(block.text)); } catch {}
          }
        }
      } catch {}
      const toolEventId = toolResultEventId(msg, eventIndex, decisionBriefId);
      const slugsInThisToolResult = new Set();
      for (const item of results) {
        const slug = item && typeof item === "object" ? String(item.slug ?? item.id ?? "") : "";
        if (!slug) continue;
        const bareSlug = sanitizeSlug(slug);
        if (!isValidSlug(bareSlug)) continue;
        if (slugsInThisToolResult.has(bareSlug)) continue;
        slugsInThisToolResult.add(bareSlug);
        const key = `${bareSlug}|tool-result|${toolEventId}`;
        const existing = seen.get(key);
        if (existing) existing.retrieval_count++;
        else {
          const row = {
            ts,
            session_id: sessionId,
            entry_slug: bareSlug,
            source: "tool-result",
            event_id: toolEventId,
            retrieval_count: 1,
            ...(decisionBriefId && toolName === "memory_decide" ? { decision_brief_id: decisionBriefId } : {}),
          };
          seen.set(key, row);
          rows.push(row);
        }
      }
    }
    if (role === "assistant") {
      const { entries: footnotes, dropped: fd } = parseMemoryFootnote(text);
      dropped.push(...fd);
      for (const fn of footnotes) {
        const footnoteEventId = footnoteOutcomeEventId(fn, eventIndex);
        const key = `${fn.entry_slug}|memory-footnote|${footnoteEventId}`;
        if (seen.has(key)) continue;
        const row = {
          ts,
          session_id: sessionId,
          entry_slug: fn.entry_slug,
          source: "memory-footnote",
          event_id: footnoteEventId,
          used: fn.used,
          counterfactual: fn.counterfactual,
          retrieval_count: 1,
          ...(fn.decision_brief_id ? { decision_brief_id: fn.decision_brief_id } : {}),
        };
        seen.set(key, row);
        rows.push(row);
      }
    }
  }
  return { rows, dropped };
}

// ── Load existing ledger and build dedupe key set ─────────────
function loadLedgerKeys(ledgerPath) {
  const keys = new Set();
  if (!fs.existsSync(ledgerPath)) return keys;
  const lines = fs.readFileSync(ledgerPath, "utf-8").trim().split("\n").filter(Boolean);
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === "object" && typeof row.session_id === "string" && typeof row.entry_slug === "string" && typeof row.source === "string") {
        keys.add(outcomeLedgerDedupKey(row));
      }
    } catch {
      // skip malformed
    }
  }
  return keys;
}

// ── Process sessions ──────────────────────────────────────────
function processSessions() {
  if (!fs.existsSync(SESSION_DIR)) {
    console.error(`session dir not found: ${SESSION_DIR}`);
    process.exit(1);
  }
  const existingKeys = loadLedgerKeys(LEDGER_PATH);
  console.log(`existing ledger: ${LEDGER_PATH}`);
  console.log(`existing unique keys: ${existingKeys.size}`);

  const sinceTs = ARGS.since;
  if (sinceTs) console.log(`only replay sessions with events at/after: ${sinceTs}`);

  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith(".jsonl")).sort();
  console.log(`scanning ${files.length} session files in ${SESSION_DIR}\n`);

  const newRows = [];
  const statsByFile = [];
  const allDropped = [];

  for (const fname of files) {
    const fp = path.join(SESSION_DIR, fname);
    const lines = fs.readFileSync(fp, "utf-8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) continue;
    let sessionId = null;
    let latestTs = null;
    const branch = [];
    for (const line of lines) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "session" && ev.id) sessionId = ev.id;
      if (ev.type === "message") branch.push(ev);
      if (ev.timestamp && (!latestTs || ev.timestamp > latestTs)) latestTs = ev.timestamp;
    }
    if (!sessionId) {
      // try to extract from filename: <ts>_<uuid>.jsonl
      const m = fname.match(/_([^_.]+)\.jsonl$/);
      if (m) sessionId = m[1];
    }
    if (!sessionId) {
      console.log(`SKIP ${fname}: no session_id`);
      continue;
    }
    // since filter: skip sessions entirely before cutoff
    if (sinceTs && latestTs && latestTs < sinceTs) continue;
    // collectOutcomes uses one ts for the whole batch — for replay,
    // we use the session's last event timestamp as a stable surrogate
    // for "when this outcome was observed". This is NOT identical to
    // what live agent_end writes (live uses Date.now()), but is the
    // best signal available for the historical replay.
    const replayTs = latestTs || new Date().toISOString();
    const { rows, dropped } = collectOutcomes(branch, sessionId, replayTs);
    const sessionNewRows = rows.filter((r) => !existingKeys.has(outcomeLedgerDedupKey(r)));
    if (sessionNewRows.length > 0 || dropped.length > 0) {
      statsByFile.push({
        fname: fname.slice(0, 60),
        sessionId: sessionId.slice(0, 12),
        totalMsgEvents: branch.length,
        outcomeRows: rows.length,
        newRows: sessionNewRows.length,
        dupRows: rows.length - sessionNewRows.length,
        dropped: dropped.length,
      });
    }
    for (const r of sessionNewRows) {
      // mark as replay so aggregator can downweight if needed
      newRows.push({ ...r, project_root: "/home/worker/.pi", _replay: true, _replay_source: fname });
      existingKeys.add(outcomeLedgerDedupKey(r));
    }
    allDropped.push(...dropped.map((d) => ({ ...d, _source_file: fname, _source_session: sessionId })));
  }

  // ── Report ────────────────────────────────────────────────
  console.log("Per-session breakdown (only sessions with new/dropped rows):\n");
  console.log("  filename".padEnd(64) + " sid".padEnd(14) + " msgs".padStart(7) + " rows".padStart(6) + " new".padStart(5) + " dup".padStart(5) + " drop".padStart(6));
  console.log("  " + "-".repeat(110));
  for (const s of statsByFile) {
    console.log(
      "  " + s.fname.padEnd(62) +
      " " + s.sessionId.padEnd(13) +
      " " + String(s.totalMsgEvents).padStart(6) +
      " " + String(s.outcomeRows).padStart(5) +
      " " + String(s.newRows).padStart(4) +
      " " + String(s.dupRows).padStart(4) +
      " " + String(s.dropped).padStart(5)
    );
  }
  console.log("\nTOTAL:");
  console.log(`  sessions scanned: ${files.length}`);
  console.log(`  sessions with new outcomes: ${statsByFile.filter((s) => s.newRows > 0).length}`);
  console.log(`  new ledger rows to append: ${newRows.length}`);
  console.log(`  dropped footnotes (would write to audit): ${allDropped.length}`);

  // breakdown by source
  const bySource = {};
  for (const r of newRows) bySource[r.source] = (bySource[r.source] || 0) + 1;
  console.log(`  new rows by source:`, bySource);

  // ── Write ────────────────────────────────────────────────
  if (newRows.length === 0) {
    console.log("\nNo new rows to write. Done.");
    return;
  }

  if (ARGS.dryRun) {
    console.log("\n[DRY-RUN] would append " + newRows.length + " rows to " + LEDGER_PATH);
    console.log("[DRY-RUN] sample row:");
    console.log("  " + JSON.stringify(newRows[0]).slice(0, 200));
    return;
  }

  // Backup ledger first
  if (fs.existsSync(LEDGER_PATH)) {
    const backupPath = LEDGER_PATH + ".pre-replay." + Date.now() + ".bak";
    fs.copyFileSync(LEDGER_PATH, backupPath);
    console.log(`\nbackup: ${backupPath}`);
  }
  const lines = newRows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(LEDGER_PATH, lines, "utf-8");
  console.log(`appended ${newRows.length} rows to ${LEDGER_PATH}`);
  console.log(`new ledger size: ${fs.statSync(LEDGER_PATH).size} bytes`);

  // ── Optionally write dropped footnotes to audit ─────────
  // For replay, we just print them — running pi process will write
  // them next agent_end if footnotes are still in the session.
  if (allDropped.length > 0) {
    console.log(`\n${allDropped.length} dropped footnotes (NOT written to audit — replay only):`);
    for (const d of allDropped.slice(0, 5)) {
      console.log(`  reason=${d.reason} slug='${d.raw_slug?.slice(0, 40)}' used='${d.raw_used}' from ${d._source_file?.slice(0, 40)}`);
    }
    if (allDropped.length > 5) console.log(`  ... and ${allDropped.length - 5} more`);
  }
}

processSessions();
