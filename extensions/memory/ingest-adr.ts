import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MemorySettings } from "./settings";
import { parseDirectionImpact } from "./direction-impact";
import { validateProjectEntryDraft } from "../sediment/validation";
import type { SanitizeResult } from "../sediment/sanitizer";
import { gitSingleFlight } from "../_shared/git-singleflight";
import { abrainProjectDir, abrainSedimentAuditPath } from "../_shared/runtime";

/**
 * Source-aware ADR-mechanism ingest lane — ADR 0034 §2.1 (Accepted 2026-06-13).
 *
 * Decomposes ADR mechanism bodies into multiple short typed memory entries
 * (one ADR ≠ one entry) and writes them into ~/.abrain/projects/<id>/ via the
 * legitimate sediment write path. This is a maintenance lane invoked explicitly
 * by the user (mirrors `/memory migrate --go`), NOT a main-session write tool —
 * INV-MAIN-SESSION-READ-ONLY (acceptance ①).
 *
 * The cognitive step (mechanism → typed drafts + coverage) is an injected
 * `decomposition` (production: an LLM prompt; smoke: a stub), so this lane is a
 * pure/testable planner + writer. Decisions baked in per the Phase-0 3×T0 ratify:
 *   - provenance = content-in-transcript (AX-PROVENANCE; mechanically non-Tier-1,
 *     ADR 0028 §12 / ADR 0034 §4). timeline marker = migrated-from-mechanism-docs.
 *   - source provenance is stored in a DISTINCT `source_ref` frontmatter field
 *     (path#heading@SHA), NOT `derives_from` — the latter is a slug graph-link
 *     field (parser.ts RELATION_KEYS) and would be mis-parsed as a wikilink.
 *     ADR 0034 §7 delegates field shape to the implementation.
 *   - dry-run manifest carries coverage + advisory stats (NO blocking threshold
 *     gate — AI-Native, direction §4 走偏 #6).
 *   - rollback: capture abrainPreSha, `git reset --hard` on any failure.
 *   - secret boundary (⑩): title + body run through the sediment sanitizer;
 *     sanitize failure withholds the entry (raw secret never persisted).
 */

export const INGEST_PROVENANCE = "content-in-transcript";
export const INGEST_TIMELINE_MARKER = "migrated-from-mechanism-docs";

const DEFAULT_STATUS = "active";
const DEFAULT_CONFIDENCE = 5;
/** Advisory only — surface possible under-decomposition. NEVER blocks a write. */
const LONG_BODY_CHARS = 1500;

const execFileAsync = promisify(execFile);

export interface AdrIngestDraft {
  slug: string;
  title: string;
  kind: string;
  status?: string;
  confidence?: number;
  /** The one compiled-truth body for this entry. */
  compiledTruth: string;
  /** The ADR §section this entry derives from (for source_ref provenance). */
  sourceHeading: string;
  /** Flat direction_impact rows (Phase-1 encoding); validated here. */
  directionImpact?: string[];
}

export interface AdrDecomposition {
  drafts: AdrIngestDraft[];
  /** Self-reported coverage (ADR 0034 §2.1 + Phase-0 revision #5). */
  processed: string[];
  skipped: Array<{ heading: string; reason: string }>;
}

export interface AdrSource {
  /** repo-relative path to the source ADR, e.g. docs/adr/0026-....md */
  adrPath: string;
  /** git SHA pinning the source at ingest time (acceptance ③ + staleness). */
  sha: string;
  decomposition: AdrDecomposition;
}

export interface PlannedEntry {
  slug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  /** adrPath#heading@sha */
  sourceRef: string;
  bodyLength: number;
  directionImpactCount: number;
  /** validation issues (schema + direction_impact 红线 + slug/heading). */
  issues: string[];
  draft: AdrIngestDraft;
  adrPath: string;
  sha: string;
}

export interface AdrCoverage {
  adrPath: string;
  processed: string[];
  skipped: Array<{ heading: string; reason: string }>;
  entryCount: number;
  bodyLengths: number[];
}

export interface IngestManifest {
  entries: PlannedEntry[];
  coverage: AdrCoverage[];
  /** Advisory flags (infra layer, NOT blocking — AI-Native). */
  flags: string[];
  totalIssues: number;
}

export function buildSourceRef(adrPath: string, heading: string, sha: string): string {
  return `${adrPath}#${heading}@${sha}`;
}

/**
 * Pure planner: validate drafts, compute source_ref, coverage, advisory stats.
 * Never throws; invalid drafts are surfaced via `issues` (and skipped at write).
 */
export function planIngest(sources: AdrSource[]): IngestManifest {
  const entries: PlannedEntry[] = [];
  const coverage: AdrCoverage[] = [];
  const flags: string[] = [];

  for (const src of sources) {
    const bodyLengths: number[] = [];
    for (const draft of src.decomposition.drafts) {
      const status = draft.status ?? DEFAULT_STATUS;
      const confidence = draft.confidence ?? DEFAULT_CONFIDENCE;
      const issues: string[] = [];

      for (const si of validateProjectEntryDraft({
        title: draft.title,
        kind: draft.kind,
        compiledTruth: draft.compiledTruth,
        status,
        confidence,
        directionImpact: draft.directionImpact,
      })) {
        issues.push(`${si.field}: ${si.message}`);
      }
      if (!draft.slug || !/^[a-z0-9-]+$/.test(draft.slug)) {
        issues.push(`slug: must be a bare kebab-case slug (got "${draft.slug}")`);
      }
      if (!draft.sourceHeading) {
        issues.push("sourceHeading: required for source_ref provenance (acceptance ③)");
      }

      const directionImpactCount = draft.directionImpact
        ? parseDirectionImpact(draft.directionImpact).impacts.length
        : 0;

      entries.push({
        slug: draft.slug,
        title: draft.title,
        kind: draft.kind,
        status,
        confidence,
        sourceRef: buildSourceRef(src.adrPath, draft.sourceHeading, src.sha),
        bodyLength: draft.compiledTruth.length,
        directionImpactCount,
        issues,
        draft,
        adrPath: src.adrPath,
        sha: src.sha,
      });
      bodyLengths.push(draft.compiledTruth.length);
      if (draft.compiledTruth.length > LONG_BODY_CHARS) {
        flags.push(`${src.adrPath} → ${draft.slug}: body ${draft.compiledTruth.length} chars > ${LONG_BODY_CHARS} (possible under-decomposition / whole-section dump?)`);
      }
    }

    if (src.decomposition.drafts.length === 1) {
      flags.push(`${src.adrPath}: only 1 entry produced — verify this is not a whole-ADR dump (走偏 #1)`);
    }
    if (src.decomposition.skipped.length > 0) {
      flags.push(`${src.adrPath}: ${src.decomposition.skipped.length} heading(s) skipped — verify intentional, not partial-drop`);
    }

    coverage.push({
      adrPath: src.adrPath,
      processed: src.decomposition.processed,
      skipped: src.decomposition.skipped,
      entryCount: src.decomposition.drafts.length,
      bodyLengths,
    });
  }

  const totalIssues = entries.reduce((n, e) => n + e.issues.length, 0);
  return { entries, coverage, flags, totalIssues };
}

function yamlScalar(value: string): string {
  if (value === "") return '""';
  if (/^[A-Za-z0-9._\-/+:@ ]+$/.test(value) && !/^[\s\-?:]/.test(value)) return value;
  return JSON.stringify(value);
}

export interface BuildEntryResult {
  ok: boolean;
  content?: string;
  error?: string;
}

/**
 * Render an entry's markdown. Secret boundary (acceptance ⑩): title + body go
 * through the sanitizer; a sanitize failure withholds the entry entirely.
 */
export function buildIngestEntryMarkdown(
  planned: PlannedEntry,
  projectId: string,
  timestamp: string,
  sanitize: (s: string) => SanitizeResult,
): BuildEntryResult {
  const titleSan = sanitize(planned.title);
  if (!titleSan.ok || titleSan.text === undefined) {
    return { ok: false, error: `title sanitize failed: ${titleSan.error ?? "unknown"}` };
  }
  const bodySan = sanitize(planned.draft.compiledTruth);
  if (!bodySan.ok || bodySan.text === undefined) {
    return { ok: false, error: `body sanitize failed: ${bodySan.error ?? "unknown"}` };
  }

  const fm: string[] = ["---"];
  fm.push(`id: project:${projectId}:${planned.slug}`);
  fm.push("scope: project");
  fm.push(`kind: ${planned.kind}`);
  fm.push(`status: ${planned.status}`);
  fm.push(`confidence: ${planned.confidence}`);
  fm.push(`provenance: ${INGEST_PROVENANCE}`);
  fm.push("schema_version: 1");
  fm.push(`title: ${yamlScalar(titleSan.text)}`);
  fm.push(`created: ${yamlScalar(timestamp)}`);
  fm.push(`updated: ${yamlScalar(timestamp)}`);
  fm.push(`source_ref: ${yamlScalar(planned.sourceRef)}`);
  if (planned.draft.directionImpact && planned.draft.directionImpact.length > 0) {
    fm.push("direction_impact:");
    for (const di of planned.draft.directionImpact) fm.push(`  - ${di}`);
  }
  fm.push("---");

  const body = [
    `# ${titleSan.text}`,
    "",
    bodySan.text.trim(),
    "",
    "## Timeline",
    "",
    `- ${timestamp} | ${INGEST_TIMELINE_MARKER} | ingested from ${planned.sourceRef}`,
    "",
  ].join("\n");

  return { ok: true, content: `${fm.join("\n")}\n\n${body}` };
}

export interface RunIngestOptions {
  abrainHome: string;
  /** Strict binding — caller resolves via resolveActiveProject, no --project passthrough. */
  projectId: string;
  sources: AdrSource[];
  dryRun: boolean;
  settings: MemorySettings;
  cwd?: string;
  signal?: AbortSignal;
  timestamp?: string;
  /** Injected sanitizer (production: sediment sanitizeForMemory). */
  sanitize?: (s: string) => SanitizeResult;
}

export interface IngestRunResult {
  ok: boolean;
  dryRun: boolean;
  projectId: string;
  manifest: IngestManifest;
  abrainPreSha: string | null;
  written: string[];
  failed: Array<{ slug: string; reason: string }>;
  skippedWithIssues: string[];
  commitSha?: string | null;
  rolledBack?: boolean;
  graphRebuilt?: { nodeCount: number; edgeCount: number } | null;
  error?: string;
}

interface GitCommitOutcome {
  sha: string | null;
  error?: string;
  nothingToCommit?: boolean;
}

async function gitHeadSha(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 3000, maxBuffer: 64 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function gitResetHard(cwd: string, sha: string): Promise<void> {
  try {
    await execFileAsync("git", ["-C", cwd, "reset", "--hard", sha], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    await execFileAsync("git", ["-C", cwd, "clean", "-fd"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  } catch {
    // best-effort rollback; operator can `git reset --hard <abrainPreSha>` manually
  }
}

async function gitCommitAll(cwd: string, message: string): Promise<GitCommitOutcome> {
  try {
    await execFileAsync("git", ["-C", cwd, "add", "-A"], { timeout: 10_000, maxBuffer: 1024 * 1024 });
    await execFileAsync("git", ["-C", cwd, "commit", "-m", message], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", "HEAD"], { timeout: 3000, maxBuffer: 64 * 1024 });
    return { sha: stdout.trim() || null };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/nothing to commit|no changes added|no changes/i.test(msg)) return { sha: null, nothingToCommit: true };
    return { sha: null, error: msg || "git commit failed" };
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function appendIngestAudit(
  abrainHome: string,
  projectId: string,
  timestamp: string,
  result: IngestRunResult,
  manifest: IngestManifest,
): Promise<void> {
  try {
    const auditPath = abrainSedimentAuditPath(abrainHome);
    await fs.mkdir(path.dirname(auditPath), { recursive: true });
    const row = {
      timestamp,
      operation: "ingest_adr",
      lane: "system",
      projectId,
      written: result.written,
      writtenCount: result.written.length,
      skippedWithIssues: result.skippedWithIssues,
      failed: result.failed,
      sources: manifest.coverage.map((c) => ({ adrPath: c.adrPath, entryCount: c.entryCount, skipped: c.skipped.length })),
      flags: manifest.flags.slice(0, 50),
      abrainPreSha: result.abrainPreSha,
      // Per-entry source mapping for forensic reconstruction.
      entries: result.written.slice(0, 200).map((slug) => {
        const e = manifest.entries.find((x) => x.slug === slug);
        return e ? { slug, sourceRef: e.sourceRef, kind: e.kind } : { slug };
      }),
    };
    await fs.appendFile(auditPath, JSON.stringify(row) + "\n", "utf-8");
  } catch {
    // best-effort — audit failure does not abort or roll back the ingest
  }
}

/**
 * Orchestrate an ingest run. dryRun=true returns the manifest WITHOUT any write
 * (acceptance ②). dryRun=false: strict-binding check → capture abrainPreSha →
 * write valid entries (skip ones with issues) → rebuild index → audit → commit;
 * any failure triggers `git reset --hard <abrainPreSha>` rollback.
 */
export async function runAdrIngest(opts: RunIngestOptions): Promise<IngestRunResult> {
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();
  const abrainHome = path.resolve(opts.abrainHome);
  const timestamp = opts.timestamp || new Date().toISOString();
  const sanitize = opts.sanitize ?? ((s: string): SanitizeResult => ({ ok: true, text: s, replacements: [] }));
  const manifest = planIngest(opts.sources);

  const result: IngestRunResult = {
    ok: false,
    dryRun: opts.dryRun,
    projectId: opts.projectId,
    manifest,
    abrainPreSha: null,
    written: [],
    failed: [],
    skippedWithIssues: [],
  };

  if (opts.dryRun) {
    result.ok = true;
    return result;
  }

  const projectDir = abrainProjectDir(abrainHome, opts.projectId);
  try {
    await fs.access(projectDir);
  } catch {
    result.error = `abrain project dir not found: ${projectDir} (strict binding requires an existing bound project)`;
    return result;
  }

  const abrainPreSha = await gitHeadSha(abrainHome);
  result.abrainPreSha = abrainPreSha;

  try {
    for (const planned of manifest.entries) {
      if (planned.issues.length > 0) {
        // Never persist an entry that failed schema / direction_impact 红线.
        result.skippedWithIssues.push(planned.slug);
        continue;
      }
      const built = buildIngestEntryMarkdown(planned, opts.projectId, timestamp, sanitize);
      if (!built.ok || !built.content) {
        result.failed.push({ slug: planned.slug, reason: built.error ?? "build failed" });
        continue;
      }
      await atomicWrite(path.join(projectDir, `${planned.slug}.md`), built.content);
      result.written.push(planned.slug);
    }

    if (result.written.length > 0) {
      try {
        const { rebuildGraphIndex } = await import("./graph");
        const { rebuildMarkdownIndex } = await import("./index-file");
        const g = await rebuildGraphIndex(projectDir, opts.settings, opts.signal, cwd);
        result.graphRebuilt = { nodeCount: g.nodeCount, edgeCount: g.edgeCount };
        await rebuildMarkdownIndex(projectDir, opts.settings, opts.signal, cwd);
      } catch {
        result.graphRebuilt = null;
      }
    }

    await appendIngestAudit(abrainHome, opts.projectId, timestamp, result, manifest);

    const commit = await gitSingleFlight(abrainHome, () =>
      gitCommitAll(abrainHome, `ingest(adr): ${result.written.length} entries from ${opts.sources.length} ADR(s)`),
    );
    result.commitSha = commit.sha;
    if (commit.error) throw new Error(`git commit failed: ${commit.error}`);

    result.ok = result.failed.length === 0 && result.skippedWithIssues.length === 0;
    return result;
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    if (abrainPreSha) {
      await gitResetHard(abrainHome, abrainPreSha);
      result.rolledBack = true;
      result.written = [];
    }
    return result;
  }
}
