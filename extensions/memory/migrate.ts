import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { MemorySettings } from "./settings";
import {
  defaultConfidence,
  extractTitle,
  inferKindFromPath,
  parseFrontmatter,
  scalarNumber,
  scalarString,
  splitCompiledTruth,
  splitFrontmatter,
} from "./parser";
import { isEmptyFrontmatterValue, markdownFilesForTarget, REQUIRED_FRONTMATTER_FIELDS } from "./lint";
import { legacyPensieveSeedDryRunReason, legacyPensieveSeedFor } from "./legacy-seeds";
import { clamp, normalizeBareSlug, prettyPath, stableUnique, titleFromSlug, throwIfAborted } from "./utils";
import {
  abrainProjectDir,
  abrainProjectWorkflowsDir,
  abrainWorkflowsDir,
  formatLocalIsoTimestamp,
  memoryMigrationReportPath,
} from "../_shared/runtime";

export interface MigrationPlanItem {
  source_path: string;
  target_path: string;
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  reasons: string[];
  actions: string[];
}

export interface MigrationSkipItem {
  source_path: string;
  reason: string;
}

export interface MigrationPlanReport {
  target: string;
  filesScanned: number;
  migrateCount: number;
  skippedCount: number;
  items: MigrationPlanItem[];
  skipped: MigrationSkipItem[];
  dryRun: true;
  writeAvailable: false;
}

export interface MigrationReportWriteResult {
  report_path: string;
  migrateCount: number;
  skippedCount: number;
}

function addDaysIso(dateLike: string | undefined, days: number): string {
  const base = dateLike && /^\d{4}-\d{2}-\d{2}/.test(dateLike)
    ? new Date(`${dateLike.slice(0, 10)}T00:00:00Z`)
    : new Date();
  if (Number.isNaN(base.getTime())) return addDaysIso(undefined, days);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

function normalizeLegacyKind(kindOrType: string): string {
  const k = kindOrType.toLowerCase();
  if (k === "maxim") return "maxim";
  if (k === "decision") return "decision";
  if (k === "pattern") return "pattern";
  if (k === "anti-pattern" || k === "antipattern") return "anti-pattern";
  if (k === "preference") return "preference";
  if (k === "smell") return "smell";
  if (k === "knowledge") return "fact";
  if (k === "pipeline") return "pipeline";
  return k || "fact";
}

/** Round 7 P0-C (opus audit fix): pipelines used to be flagged `unsupported`
 *  here, which made `/memory migrate --dry-run` print them under "skipped".
 *  But `/memory migrate --go` (migrate-go.ts:550+) actually routes pipelines
 *  to `~/.abrain/workflows/<slug>.md` or `~/.abrain/projects/<id>/workflows/<slug>.md`.
 *  The dry-run was systematically lying about pipelines. Now pipelines are
 *  a first-class area; the destination is computed by `legacyTargetPath` to
 *  match --go's actual routing. */
function inferLegacyArea(relPath: string): { area: string; shortTerm: boolean; unsupported?: string } {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  const shortTerm = parts[0] === "short-term";
  const head = shortTerm ? parts[1] : parts[0];

  if (!head || head === "state.md") return { area: "", shortTerm, unsupported: "support file outside memory entry directories" };
  if (head === "pipelines") return { area: head, shortTerm };
  if (["maxims", "decisions", "knowledge", "staging", "archive"].includes(head)) {
    return { area: head, shortTerm };
  }
  return { area: head, shortTerm, unsupported: `unsupported memory directory: ${head}` };
}

export interface MigrationDryRunOptions {
  abrainHome?: string;
  /** Pre-resolved abrain projectId from ADR 0017 strict binding (/abrain bind);
   *  pass `undefined` only for legacy diagnostics that intentionally render
   *  `<unresolved>` markers in target_path. */
  projectId?: string;
  /** Defaults to inferring crossProject from frontmatter `cross_project: true`. */
  // 2026-05-24 fix: align with scalarString(value: Jsonish | undefined)
  // expectation — frontmatter is structurally Jsonish, not arbitrary unknown.
  isCrossProject?: (relPath: string, frontmatter: Record<string, import("./types").Jsonish>) => boolean;
}

/** Round 7 P0-C: target_path now reflects where `--go` will actually move
 *  the entry (abrain projects substrate / abrain workflows dir / abrain
 *  project-scoped workflows dir). When `abrainHome` or `projectId` is
 *  unresolved at dry-run time, returns a `<unresolved — ...>` sentinel
 *  so users see explicitly that dry-run can't pin the destination without
 *  the same flags `--go` would receive. */
function legacyTargetPath(
  sourcePath: string,
  projectRoot: string,
  relPath: string,
  slug: string,
  kind: string,
  status: string,
  // 2026-05-24 fix: align with scalarString(value: Jsonish | undefined).
  frontmatter: Record<string, import("./types").Jsonish>,
  opts: MigrationDryRunOptions,
): string {
  const { area, shortTerm } = inferLegacyArea(relPath);
  if (!area) return sourcePath;

  const abrainHome = opts.abrainHome;
  const projectId = opts.projectId;
  if (!abrainHome || !projectId) {
    return `<unresolved — run /abrain bind --project=<id> first to see destination>`;
  }

  if (area === "pipelines") {
    const crossProject = opts.isCrossProject
      ? opts.isCrossProject(relPath, frontmatter)
      : scalarString(frontmatter.cross_project) === "true";
    const wfDir = crossProject ? abrainWorkflowsDir(abrainHome) : abrainProjectWorkflowsDir(abrainHome, projectId);
    return path.join(wfDir, `${slug}.md`);
  }

  // knowledge kinds: maxim/decision/anti-pattern/pattern/fact/preference/smell
  // archive remains in `archive/` zone when status is archived.
  const KIND_DIR: Record<string, string> = {
    maxim: "maxims",
    decision: "decisions",
    "anti-pattern": "knowledge",
    pattern: "knowledge",
    fact: "knowledge",
    preference: "knowledge",
    smell: "staging",
  };
  const subdir = status === "archived" ? "archive" : (KIND_DIR[kind] || "knowledge");
  return path.join(abrainProjectDir(abrainHome, projectId), subdir, `${slug}.md`);
}

async function planMigrationForFile(
  file: string,
  projectRoot: string,
  cwd: string,
  settings: MemorySettings,
  opts: MigrationDryRunOptions,
): Promise<{ item?: MigrationPlanItem; skipped?: MigrationSkipItem }> {
  const relPath = path.relative(projectRoot, file);
  const area = inferLegacyArea(relPath);
  if (area.unsupported) {
    return { skipped: { source_path: prettyPath(file, cwd), reason: area.unsupported } };
  }

  const raw = await fs.readFile(file, "utf-8");
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const { timeline } = splitCompiledTruth(body);
  const sourceDisplay = prettyPath(file, cwd);

  const seed = legacyPensieveSeedFor(relPath, frontmatter);
  if (seed) {
    if (seed.disposition === "extract" && seed.globalTarget && opts.abrainHome) {
      const globalCopy = path.join(opts.abrainHome, seed.globalTarget);
      try {
        await fs.access(globalCopy);
      } catch {
        return {
          skipped: {
            source_path: sourceDisplay,
            reason: `would fail: extract seed's canonical copy not found in abrain: ${seed.globalTarget}`,
          },
        };
      }
    }
    return { skipped: { source_path: sourceDisplay, reason: legacyPensieveSeedDryRunReason(seed) } };
  }

  const id = scalarString(frontmatter.id);
  const pathSlug = path.basename(file, path.extname(file)) === "content"
    ? path.basename(path.dirname(file))
    : path.basename(file, path.extname(file));
  const slug = normalizeBareSlug(id || pathSlug || extractTitle(body) || "entry");
  const title = scalarString(frontmatter.title) || extractTitle(body) || titleFromSlug(slug);
  const kind = normalizeLegacyKind(
    scalarString(frontmatter.kind) || scalarString(frontmatter.type) || inferKindFromPath(relPath),
  );
  const status = scalarString(frontmatter.status) || "active";
  const confidence = clamp(
    scalarNumber(frontmatter.confidence) ?? defaultConfidence(kind),
    0,
    10,
  );
  const created = scalarString(frontmatter.created);
  const targetPath = legacyTargetPath(file, projectRoot, relPath, slug, kind, status, frontmatter, opts);
  const targetDisplay = targetPath.startsWith("<unresolved") ? targetPath : prettyPath(targetPath, cwd);

  const reasons: string[] = [];
  const actions: string[] = [];

  if (!frontmatterText) reasons.push("missing frontmatter");
  if (isEmptyFrontmatterValue(frontmatter.schema_version)) reasons.push("missing schema_version");
  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (isEmptyFrontmatterValue(frontmatter[field])) reasons.push(`missing ${field}`);
  }
  if (timeline.length === 0) reasons.push("missing Timeline entries");
  if (!/^##\s+Timeline\s*$/m.test(body)) reasons.push("missing ## Timeline heading");
  if (targetPath !== file) reasons.push("legacy path layout");

  if (reasons.length === 0) {
    return { skipped: { source_path: sourceDisplay, reason: "already schema_version v1-compatible" } };
  }

  actions.push(`write frontmatter schema_version: 1, scope: project, kind: ${kind}, confidence: ${confidence}`);
  if (targetPath !== file) actions.push(`move/rename to ${targetDisplay}`);
  if (area.shortTerm) {
    const expires = addDaysIso(created, settings.shortTermTtlDays);
    actions.push(`add lifetime.kind: ttl, lifetime.expires_at: ${expires} (${settings.shortTermTtlDays}d)`);
  }
  if (!/^##\s+Timeline\s*$/m.test(body)) {
    actions.push("append ## Timeline with migrated-from-legacy entry");
  } else if (timeline.length === 0) {
    actions.push("append initial migrated-from-legacy timeline entry");
  }

  return {
    item: {
      source_path: sourceDisplay,
      target_path: targetDisplay,
      slug,
      title,
      kind,
      status,
      confidence,
      reasons: stableUnique(reasons),
      actions,
    },
  };
}

function inferProjectRoot(absTarget: string): string {
  if (path.basename(absTarget) === ".pensieve") return absTarget;
  const parts = absTarget.split(path.sep);
  const idx = parts.lastIndexOf(".pensieve");
  if (idx >= 0) return parts.slice(0, idx + 1).join(path.sep) || path.sep;
  return absTarget;
}

export async function planMigrationDryRun(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
  opts: MigrationDryRunOptions = {},
): Promise<MigrationPlanReport> {
  const absTarget = path.resolve(target);
  // Migration targets legacy `.pensieve/` as an explicit source snapshot.
  // Many repos intentionally have `.pensieve/.gitignore: *`; dry-run must
  // still see those ignored/untracked entries, otherwise it reports only
  // support files such as state.md.
  const files = await markdownFilesForTarget(absTarget, settings, signal, { includeIgnored: true });
  const projectRoot = inferProjectRoot(absTarget);

  const items: MigrationPlanItem[] = [];
  const skipped: MigrationSkipItem[] = [];

  for (const file of files) {
    throwIfAborted(signal);
    try {
      const planned = await planMigrationForFile(file, projectRoot, cwd, settings, opts);
      if (planned.item) items.push(planned.item);
      if (planned.skipped) skipped.push(planned.skipped);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      skipped.push({ source_path: prettyPath(file, cwd), reason: `failed to inspect: ${message}` });
    }
  }

  return {
    target: prettyPath(absTarget, cwd),
    filesScanned: files.length,
    migrateCount: items.length,
    skippedCount: skipped.length,
    items,
    skipped,
    dryRun: true,
    writeAvailable: false,
  };
}

function countValues(items: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

export function formatMigrationReportMarkdown(report: MigrationPlanReport): string {
  const kindCounts = countValues(report.items.map((item) => item.kind));
  const reasonCounts = countValues(report.items.flatMap((item) => item.reasons));
  const lines: string[] = [
    "# Memory Migration Dry-Run Report",
    "",
    `> Generated ${formatLocalIsoTimestamp()} | target: \`${report.target}\``,
    "",
    "## Summary",
    "",
    `- Files scanned: ${report.filesScanned}`,
    `- Need migration: ${report.migrateCount}`,
    `- Skipped: ${report.skippedCount}`,
    `- Dry run: ${report.dryRun}`,
    `- Writes available: ${report.writeAvailable}`,
    "",
    "## By Kind",
    "",
  ];

  for (const [kind, count] of Object.entries(kindCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`- ${kind}: ${count}`);
  }
  if (Object.keys(kindCounts).length === 0) lines.push("- None");

  lines.push("", "## By Reason", "");
  for (const [reason, count] of Object.entries(reasonCounts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    lines.push(`- ${reason}: ${count}`);
  }
  if (Object.keys(reasonCounts).length === 0) lines.push("- None");

  lines.push("", "## Migration Items", "");
  lines.push("_Per-file migration substrate retired 2026-05-12. Per-repo one-shot migration: run `/abrain bind --project=<id>` once, then `/memory migrate --go` (B4+B4.5 shipped 2026-05-12, see `extensions/memory/migrate-go.ts`). Spec: docs/migration/abrain-pensieve-migration.md §3. Rollback: see summary printed by `--go` (pre-migration SHAs)._");
  lines.push("");
  if (report.items.length === 0) {
    lines.push("- None");
  } else {
    lines.push("| Source | Target | Title | Kind | Confidence | Reasons | Actions |");
    lines.push("|---|---|---|---:|---:|---|---|");
    for (const item of report.items) {
      lines.push([
        markdownCell(item.source_path),
        markdownCell(item.target_path),
        markdownCell(item.title),
        markdownCell(item.kind),
        String(item.confidence),
        markdownCell(item.reasons.join(", ")),
        markdownCell(item.actions.join("; ")),
      ].join(" | ").replace(/^/, "| ").replace(/$/, " |"));
    }
  }

  lines.push("", "## Skipped", "");
  if (report.skipped.length === 0) {
    lines.push("- None");
  } else {
    lines.push("| Source | Reason |");
    lines.push("|---|---|");
    for (const item of report.skipped) {
      lines.push(`| ${markdownCell(item.source_path)} | ${markdownCell(item.reason)} |`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

async function atomicWrite(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  // Round 8 P1 (deepseek R8 audit): finally-cleanup tmp file.
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function writeMigrationReport(
  target: string,
  report: MigrationPlanReport,
  cwd = process.cwd(),
): Promise<MigrationReportWriteResult> {
  const projectRoot = inferProjectRoot(path.resolve(target));
  // The pensieve target lives at <projectRoot>/.pensieve; one-up to the
  // pi-astack project root for the runtime artifact path.
  const piAstackProjectRoot = path.dirname(projectRoot);
  const reportPath = memoryMigrationReportPath(piAstackProjectRoot);
  await atomicWrite(reportPath, formatMigrationReportMarkdown(report));
  return {
    report_path: prettyPath(reportPath, cwd),
    migrateCount: report.migrateCount,
    skippedCount: report.skippedCount,
  };
}

export function formatMigrationPlan(report: MigrationPlanReport, maxItems = 12): string {
  const lines: string[] = [
    `Memory migrate dry-run: ${report.migrateCount} file(s) need migration, ${report.skippedCount} skipped, ${report.filesScanned} scanned`,
    // Per-file migration substrate retired 2026-05-12. Per-repo one-shot
    // migration (`/memory migrate --go`) shipped same day (B4); this dry-run
    // planner stays read-only and only surfaces what would migrate. To execute,
    // run `/abrain bind --project=<id>` once, then `/memory migrate --go`.
    // See migrate-go.ts and docs/migration/abrain-pensieve-migration.md §3.
    "Read-only plan (no writes). To execute migration: `/abrain bind --project=<id>` once, then `/memory migrate --go` (B4+B4.5 shipped 2026-05-12).",
    "target_path values below show where `--go` would route each entry into ~/.abrain/.",
  ];

  if (report.items.length > 0) {
    lines.push("");
    for (const item of report.items.slice(0, maxItems)) {
      lines.push(`- ${item.source_path} -> ${item.target_path}`);
      lines.push(`  slug=${item.slug} kind=${item.kind} status=${item.status} confidence=${item.confidence}`);
      lines.push(`  reasons: ${item.reasons.join(", ")}`);
      lines.push(`  actions: ${item.actions.join("; ")}`);
    }
    if (report.items.length > maxItems) {
      lines.push(`- ... ${report.items.length - maxItems} more migration item(s) omitted`);
    }
  }

  if (report.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const item of report.skipped.slice(0, maxItems)) {
      lines.push(`- ${item.source_path}: ${item.reason}`);
    }
    if (report.skipped.length > maxItems) {
      lines.push(`- ... ${report.skipped.length - maxItems} more skipped item(s) omitted`);
    }
  }
  return lines.join("\n");
}
