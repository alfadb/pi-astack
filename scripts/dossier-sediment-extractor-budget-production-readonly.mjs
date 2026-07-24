#!/usr/bin/env node
/**
 * Production read-only dry-run dossier for sediment extractor prompt bounds.
 *
 * Reads real sessions 019f8914... and 019f852d... / pending receipts, rebuilds
 * branch from Pi JSONL, runs the same production prompt builder WITHOUT any
 * LLM call, and records before/after char counts + live budget wouldAllow.
 *
 * Evidence is counts/hashes/IDs only — never prompt body or user content.
 *
 * Default: stdout. Explicit --output writes JSON evidence file.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });

function parseOutputPath(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) throw new Error("--output requires a path");
      return path.resolve(next);
    }
    if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (!value) throw new Error("--output requires a path");
      return path.resolve(value);
    }
  }
  return null;
}

const outputPath = parseOutputPath(process.argv.slice(2));
const abrainHome = process.env.ABRAIN_ROOT
  ? path.resolve(process.env.ABRAIN_ROOT.replace(/^~(?=$|[/])/, os.homedir()))
  : path.join(os.homedir(), ".abrain");

const TARGET_SESSIONS = [
  "019f8914-fded-7d80-bd88-93904f61c959",
  "019f852d-2e1d-7ee2-87e9-8ba44ed1f3bf",
];

const intake = await jiti.import(path.join(root, "extensions/sediment/intake.ts"));
const checkpoint = await jiti.import(path.join(root, "extensions/sediment/checkpoint.ts"));
const extractor = await jiti.import(path.join(root, "extensions/sediment/llm-extractor.ts"));
const settingsMod = await jiti.import(path.join(root, "extensions/sediment/settings.ts"));
const audit = await jiti.import(path.join(root, "extensions/_shared/llm-audit.ts"));

function sha256(value) {
  return createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function entryId(entry) {
  return entry && typeof entry === "object" && typeof entry.id === "string" ? entry.id : null;
}

const settings = settingsMod.resolveSedimentSettings();
const budget = audit.resolveLlmAuditBudgetSettings();
const pendingAll = await intake.listSedimentIntakePending(abrainHome);

const sessionReports = [];

for (const sessionId of TARGET_SESSIONS) {
  const pending = pendingAll.filter((p) => p.sessionId === sessionId);
  const sessionFiles = [...new Set(pending.map((p) => p.sessionFile))];
  // Also try known session paths if no pending.
  if (sessionFiles.length === 0) {
    const sessionsRoot = path.join(os.homedir(), ".pi", "agent", "sessions");
    if (fs.existsSync(sessionsRoot)) {
      for (const dirent of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const dir = path.join(sessionsRoot, dirent.name);
        for (const name of fs.readdirSync(dir)) {
          if (name.includes(sessionId) && name.endsWith(".jsonl")) {
            sessionFiles.push(path.join(dir, name));
          }
        }
      }
    }
  }

  for (const sessionFile of sessionFiles) {
    const pendingForFile = pending.filter((p) => path.resolve(p.sessionFile) === path.resolve(sessionFile));
    // Restore from the newest pending tip when available; else full session parse tip.
    let record = null;
    let restore = null;
    if (pendingForFile.length > 0) {
      // Prefer latest tip by sourceTimestampUtc.
      const latest = [...pendingForFile].sort((a, b) => a.sourceTimestampUtc.localeCompare(b.sourceTimestampUtc)).at(-1);
      record = await intake.readSedimentIntakeRecord(abrainHome, latest.windowId);
      if (record) restore = await intake.restoreSedimentIntakeBranch(record);
    }

    let branchEntries = restore?.ok ? restore.branchEntries : null;
    let restoreStatus = restore?.ok ? "ok" : (restore?.status ?? "no_pending_restore");
    if (!branchEntries) {
      // Fallback: parse whole session file via intake restore of a synthetic tip is hard;
      // count lines only.
      branchEntries = null;
    }

    const sessionStat = fs.existsSync(sessionFile) ? fs.statSync(sessionFile) : null;
    const base = {
      session_id: sessionId,
      session_file_hash: sha256(sessionFile),
      session_file_bytes: sessionStat?.size ?? null,
      pending_count: pendingForFile.length,
      pending_window_ids: pendingForFile.map((p) => p.windowId),
      restore_status: restoreStatus,
    };

    if (!branchEntries || !Array.isArray(branchEntries) || branchEntries.length === 0) {
      sessionReports.push({ ...base, dry_run: null, note: "branch_unavailable" });
      continue;
    }

    const fullBranchText = extractor.buildBranchTranscript(branchEntries);
    const fullBranchChars = fullBranchText.length;
    const fullBranchHash = sha256(fullBranchText);

    // Use empty checkpoint → oldest-first window as production drain does with backlogOrder oldest.
    // If a lastProcessed is unknown, empty checkpoint yields candidates=all then maxWindowChars slice.
    const cp = { lastProcessedEntryId: undefined };
    const win = checkpoint.buildRunWindow(branchEntries, cp, settings, { backlogOrder: "oldest" });
    const windowEntryIds = (win.entries || []).map(entryId).filter(Boolean);
    const windowTextHash = sha256(win.text || "");

    const plan = extractor.buildBoundedExtractorPromptPlan(win.text || "", {
      settings: {
        maxWindowChars: settings.maxWindowChars,
        extractorModel: settings.extractorModel,
      },
      windowEntryCount: win.includedEntries,
      fullBranchChars,
    });

    // Live audit budget wouldAllow for the AFTER prompt only (no LLM).
    const liveMaxPromptChars = budget.enabled ? budget.maxPromptChars : 0;
    const wouldAllowLiveBudget = !budget.enabled
      || liveMaxPromptChars <= 0
      || plan.promptChars <= liveMaxPromptChars;
    const wouldAllowEstimatedTokens = !budget.enabled
      || budget.maxPromptEstimatedTokens <= 0
      || Math.ceil(plan.promptChars / 4) <= budget.maxPromptEstimatedTokens;

    sessionReports.push({
      ...base,
      branch_entry_count: branchEntries.length,
      branch_tip_id: entryId(branchEntries[branchEntries.length - 1]),
      full_branch_chars: fullBranchChars,
      full_branch_sha256: fullBranchHash,
      window: {
        chars: win.chars,
        included_entries: win.includedEntries,
        candidate_entries: win.candidateEntries,
        entry_ids_sha256: sha256(windowEntryIds.join(",")),
        entry_id_count: windowEntryIds.length,
        text_sha256: windowTextHash,
        skip_reason: win.skipReason ?? null,
        first_entry_id: windowEntryIds[0] ?? null,
        last_entry_id: windowEntryIds[windowEntryIds.length - 1] ?? null,
      },
      dry_run: {
        source: plan.source,
        before_full_branch_chars: fullBranchChars,
        window_chars: plan.windowChars,
        after_serialized_prompt_chars: plan.promptChars,
        prompt_char_cap: plan.promptCharCap,
        system_context_chars: plan.systemContextChars,
        prompt_fingerprint: plan.promptFingerprint,
        live_budget: {
          enabled: budget.enabled,
          maxPromptChars: budget.maxPromptChars,
          maxPromptEstimatedTokens: budget.maxPromptEstimatedTokens,
        },
        wouldAllow_prompt_char_cap: plan.wouldAllow,
        wouldAllow_live_maxPromptChars: wouldAllowLiveBudget,
        wouldAllow_live_estimated_tokens: wouldAllowEstimatedTokens,
        wouldAllow: plan.wouldAllow && wouldAllowLiveBudget && wouldAllowEstimatedTokens,
        // Historical failure shape: full branch as prompt body exceeded 1M.
        legacy_full_branch_would_exceed:
          budget.enabled
          && budget.maxPromptChars > 0
          && fullBranchChars + plan.systemContextChars + 20_000 > budget.maxPromptChars,
      },
    });
  }
}

// Aggregate recent blocked budget rows for the two sessions (counts only).
const auditPath = path.join(os.homedir(), ".pi", ".pi-astack", "llm-audit", "audit.jsonl");
let blockedBudgetCount = 0;
let blockedBySession = {};
if (fs.existsSync(auditPath)) {
  const raw = fs.readFileSync(auditPath, "utf8");
  // Stream-ish: only scan last ~2MB for recent rows.
  const slice = raw.length > 2_000_000 ? raw.slice(raw.length - 2_000_000) : raw;
  for (const line of slice.split("\n")) {
    if (!line.includes("\"result\":\"blocked\"") || !line.includes("llm_extractor")) continue;
    try {
      const row = JSON.parse(line);
      if (row.row_type !== "budget" || row.result !== "blocked") continue;
      if (row.operation !== "llm_extractor") continue;
      blockedBudgetCount += 1;
      const sid = row.session_id || "unknown";
      if (!TARGET_SESSIONS.includes(sid) && sid !== "unknown") continue;
      blockedBySession[sid] = (blockedBySession[sid] || 0) + 1;
    } catch {
      // skip
    }
  }
}

const dossier = {
  schema: "sediment-extractor-budget-production-readonly/v1",
  generated_at: new Date().toISOString(),
  abrain_home_hash: sha256(abrainHome),
  target_sessions: TARGET_SESSIONS,
  settings: {
    maxWindowChars: settings.maxWindowChars,
    maxWindowEntries: settings.maxWindowEntries,
    extractorModel: settings.extractorModel ? sha256(settings.extractorModel) : null,
    extractor_prompt_bound_version: extractor.EXTRACTOR_PROMPT_BOUND_VERSION,
    fixed_overhead_allowance: extractor.EXTRACTOR_PROMPT_FIXED_OVERHEAD_ALLOWANCE,
  },
  live_budget: budget,
  pending_total: pendingAll.length,
  recent_blocked_llm_extractor_budget_rows_scanned_tail: blockedBudgetCount,
  recent_blocked_by_target_session: blockedBySession,
  sessions: sessionReports,
  assertions: {
    no_prompt_body: true,
    no_user_content: true,
    no_llm_call: true,
    no_pending_consumed: true,
  },
};

const text = `${JSON.stringify(dossier, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, text, "utf8");
  console.log(JSON.stringify({ wrote: outputPath, sessions: sessionReports.length, pending_total: pendingAll.length }));
} else {
  process.stdout.write(text);
}
