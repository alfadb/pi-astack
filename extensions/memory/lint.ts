import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { MemorySettings } from "./settings";
import type { Jsonish } from "./types";
import {
  parseFrontmatter,
  scalarNumber,
  splitCompiledTruth,
  splitFrontmatter,
  listFilesWithRg,
  walkMarkdownFiles,
} from "./parser";
import { compareTimestamps, prettyPath, throwIfAborted } from "./utils";
import { parseDirectionImpact } from "./direction-impact";

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  rule: string;
  severity: LintSeverity;
  message: string;
  line?: number;
  file?: string;
}

export interface LintReport {
  target: string;
  filesChecked: number;
  errorCount: number;
  warningCount: number;
  issues: LintIssue[];
}

export const REQUIRED_FRONTMATTER_FIELDS = [
  "scope", "kind", "status", "confidence", "created", "schema_version", "title",
];

const CANONICAL_FRONTMATTER_STATUSES = new Set([
  "provisional", "active", "contested", "deprecated", "superseded", "archived",
]);
const LEGACY_FRONTMATTER_STATUS_FOLD: Record<string, string> = {
  deprecated: "superseded",
  "in-progress": "provisional",
  "superseded-in-part": "superseded",
};

function pushIssue(
  issues: LintIssue[],
  issue: Omit<LintIssue, "file">,
  file?: string,
) {
  issues.push({ ...issue, ...(file ? { file } : {}) });
}

function findTimelineHeadings(lines: string[]) {
  const timeline: number[] = [];
  const h2: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) h2.push(i);
    if (/^##\s+Timeline\s*$/.test(lines[i])) timeline.push(i);
  }
  return { timeline, h2 };
}

export function isEmptyFrontmatterValue(value: Jsonish | undefined): boolean {
  return value === undefined || value === null || value === "";
}

export function lintMarkdown(raw: string, file?: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  const { frontmatterText } = splitFrontmatter(normalized);
  const frontmatter = parseFrontmatter(frontmatterText);
  const missing = REQUIRED_FRONTMATTER_FIELDS
    .filter((field) => isEmptyFrontmatterValue(frontmatter[field]));
  if (missing.length > 0) {
    pushIssue(issues, {
      rule: "T7 frontmatter-required",
      severity: "error",
      message: `missing required frontmatter field(s): ${missing.join(", ")}`,
      line: 1,
    }, file);
  }

  const rawStatus = typeof frontmatter.status === "string" ? frontmatter.status.trim() : "";
  if (rawStatus) {
    const normalizedStatus = rawStatus.toLowerCase();
    if (!CANONICAL_FRONTMATTER_STATUSES.has(normalizedStatus)) {
      const folded = LEGACY_FRONTMATTER_STATUS_FOLD[normalizedStatus];
      pushIssue(issues, {
        rule: "T7 status-enum",
        severity: "warning",
        message: folded
          ? `frontmatter status '${rawStatus}' is non-canonical; read side folds it to '${folded}'`
          : `frontmatter status '${rawStatus}' is not a valid status; read side falls back to 'provisional'`,
        line: 1,
      }, file);
    }
  }

  const confidence = scalarNumber(frontmatter.confidence);
  if (frontmatter.confidence !== undefined && (confidence === undefined || confidence < 0 || confidence > 10)) {
    pushIssue(issues, {
      rule: "T7 frontmatter-required",
      severity: "error",
      message: "frontmatter confidence must be a number between 0 and 10",
      line: 1,
    }, file);
  }

  // D1 direction-impact (ADR 0034 §2.2): validate direction_impact rows. The
  // 红线 — narrows/weakens/conflicts must be escalated, never silently accepted
  // (escalation != "none") — surfaces here as a lint error so doctor catches a
  // 承重墙 violation in stored entries (acceptance ⑦).
  if (frontmatter.direction_impact !== undefined) {
    const { issues: diIssues } = parseDirectionImpact(frontmatter.direction_impact);
    for (const di of diIssues) {
      pushIssue(issues, {
        rule: "D1 direction-impact",
        severity: di.severity,
        message: `${di.message} [${di.raw}]`,
        line: 1,
      }, file);
    }
  }

  const { timeline, h2 } = findTimelineHeadings(lines);

  if (timeline.length === 0) {
    pushIssue(issues, {
      rule: "T1 timeline-heading-present",
      severity: "error",
      message: "missing required `## Timeline` heading",
    }, file);
  }
  if (timeline.length !== 1) {
    pushIssue(issues, {
      rule: "T2 timeline-heading-unique",
      severity: "error",
      message: `expected exactly one \`## Timeline\` heading, found ${timeline.length}`,
    }, file);
  }
  if (timeline.length >= 1) {
    const timelineLine = timeline[0];
    const lastH2 = h2[h2.length - 1];
    if (lastH2 !== timelineLine) {
      pushIssue(issues, {
        rule: "T1 timeline-heading-present",
        severity: "error",
        message: "`## Timeline` must be the last H2 in the file",
        line: timelineLine + 1,
      }, file);
    }

    const timelineLines = lines.slice(timelineLine + 1);
    const nonEmpty = timelineLines
      .map((line, idx) => ({ line, idx, trimmed: line.trim() }))
      .filter((item) => item.trimmed.length > 0);

    if (nonEmpty.length === 0) {
      pushIssue(issues, {
        rule: "T6 timeline-not-empty",
        severity: "warning",
        message: "timeline must contain at least one entry",
        line: timelineLine + 1,
      }, file);
    }

    const dates: Array<{ date: string; line: number }> = [];
    for (const item of nonEmpty) {
      const lineNo = timelineLine + 2 + item.idx;
      const trimmed = item.trimmed;

      if (/^#{1,6}\s+/.test(trimmed)) {
        pushIssue(issues, {
          rule: "T3 no-headings-in-timeline",
          severity: "error",
          message: "headings are not allowed inside Timeline",
          line: lineNo,
        }, file);
      }

      if (trimmed.includes("```")) {
        pushIssue(issues, {
          rule: "T8 no-code-fence-in-timeline",
          severity: "error",
          message: "code fences are not allowed inside Timeline",
          line: lineNo,
        }, file);
      }

      if (
        /^\|.*\|$/.test(trimmed) ||
        /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)
      ) {
        pushIssue(issues, {
          rule: "T9 no-table-in-timeline",
          severity: "error",
          message: "Markdown table syntax is not allowed inside Timeline",
          line: lineNo,
        }, file);
      }

      if (/^\s+[-*+]\s+/.test(item.line)) {
        pushIssue(issues, {
          rule: "T10 no-nested-list-in-timeline",
          severity: "warning",
          message: "nested list items are not allowed inside Timeline",
          line: lineNo,
        }, file);
      }

      const bullet = trimmed.match(/^-\s+(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2}))?)\s+\|\s+(.+)$/);
      if (!bullet) {
        pushIssue(issues, {
          rule: "T4 timeline-bullet-format",
          severity: "warning",
          message: "timeline entry should be `- <time> | ...` where <time> is YYYY-MM-DD or ISO datetime",
          line: lineNo,
        }, file);
      } else {
        dates.push({ date: bullet[1], line: lineNo });
      }
    }

    for (let i = 1; i < dates.length; i++) {
      // Round 7 P1 (sonnet audit fix): use compareTimestamps so cross-TZ
      // timeline appends don't trigger false-positive T5 warnings. A user
      // who travels UTC+8 → UTC-5 and appends a row will produce string
      // `"2026-05-12T15:30:00.000-05:00"` which lexicographically sorts
      // less than `"2026-05-12T23:00:00.000+08:00"` (the earlier row),
      // but is actually 5.5h newer in UTC.
      if (compareTimestamps(dates[i].date, dates[i - 1].date) < 0) {
        pushIssue(issues, {
          rule: "T5 timeline-chronological",
          severity: "warning",
          message: `timeline date ${dates[i].date} appears before previous date ${dates[i - 1].date}`,
          line: dates[i].line,
        }, file);
      }
    }
  }

  return issues;
}

async function lintFile(file: string): Promise<LintIssue[]> {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return lintMarkdown(raw, file);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return [{
      file,
      rule: "read-error",
      severity: "error",
      message: `failed to read file: ${message}`,
    }];
  }
}

export async function markdownFilesForTarget(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  opts: { includeIgnored?: boolean } = {},
): Promise<string[]> {
  const abs = path.resolve(target);
  let stat: fsSync.Stats;
  try {
    stat = await fs.stat(abs);
  } catch {
    return [];
  }
  if (stat.isFile()) return abs.endsWith(".md") ? [abs] : [];
  if (!stat.isDirectory()) return [];
  const rgFiles = await listFilesWithRg(abs, signal, { includeIgnored: opts.includeIgnored });
  const files = rgFiles ?? await walkMarkdownFiles(abs, settings.maxEntries, signal);
  return files
    .filter((file) => file.endsWith(".md"))
    .filter((file) => path.basename(file) !== "_index.md")
    .slice(0, settings.maxEntries);
}

export async function lintTarget(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
): Promise<LintReport> {
  const absTarget = path.resolve(target);
  const files = await markdownFilesForTarget(absTarget, settings, signal);
  const issues: LintIssue[] = [];

  if (files.length === 0) {
    const exists = fsSync.existsSync(absTarget);
    issues.push({
      file: absTarget,
      rule: exists ? "no-markdown-files" : "target-not-found",
      severity: exists ? "warning" : "error",
      message: exists ? "target contains no markdown files to lint" : "lint target does not exist",
    });
  }

  for (const file of files) {
    throwIfAborted(signal);
    issues.push(...await lintFile(file));
  }
  const errorCount = issues.filter((issue) => issue.severity === "error").length;
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  return { target: absTarget, filesChecked: files.length, errorCount, warningCount, issues };
}

export function formatLintReport(report: LintReport, cwd: string, maxIssues = 12): string {
  const lines: string[] = [
    `Memory lint: ${report.errorCount} error(s), ${report.warningCount} warning(s), ${report.filesChecked} file(s) checked`,
  ];
  if (report.issues.length === 0) return `${lines[0]} — passed`;

  lines.push("");
  for (const issue of report.issues.slice(0, maxIssues)) {
    const loc = issue.file ? prettyPath(issue.file, cwd) : prettyPath(report.target, cwd);
    const line = issue.line ? `:${issue.line}` : "";
    lines.push(`- [${issue.severity}] ${loc}${line} ${issue.rule}: ${issue.message}`);
  }
  if (report.issues.length > maxIssues) {
    lines.push(`- ... ${report.issues.length - maxIssues} more issue(s) omitted`);
  }
  return lines.join("\n");
}
