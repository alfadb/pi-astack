import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { SedimentSettings } from "./settings";
import { appendKnowledgeEvidenceForWrite, knowledgeEvidenceEventRelativePath, knowledgeProjectionOutputHashFromMarkdownBytes, knowledgeProjectionRoot, readKnowledgeEvidenceL1Head, readKnowledgeStableViewStores, type AppendKnowledgeEvidenceForWriteResult, type KnowledgeEvidenceL1Head } from "./knowledge-evidence";
import { detectProjectDuplicate, type DedupeResult } from "./dedupe";
import { sanitizeForMemory } from "./sanitizer";
import { type EntryKind, type EntryStatus, type ProvenanceClass, ENTRY_KINDS, ENTRY_STATUSES, validateProjectEntryDraft } from "./validation";
import { lintMarkdown } from "../memory/lint";
import { renameSlugInVectorIndexFile, rollbackRenameSlugInVectorIndexFile } from "../memory/embedding";
import {
  type RuleDraft,
  type RuleInjectMode,
  buildRuleMarkdown,
  lintRuleKind,
  lintRuleAlwaysSize,
  sanitizeRuleHint,
  ruleHintFallback,
  ruleBodySimilarity,
  ruleBodyHash,
  renderRuleBody,
  RULE_DEDUP_SIMILARITY_THRESHOLD,
} from "./rule-writer";
import { parseFrontmatter, relationValues, scalarNumber, scalarString, splitCompiledTruth, splitFrontmatter } from "../memory/parser";
import {
  applyRenamePlan,
  rollbackRenameTransaction,
  basicRenamePreflight,
  findPreexistingBareNewSlugRefs,
  frontmatterScopeMatchesFileScope,
  rewriteMarkdownForRename,
  type RenameApplyPlan,
  type RenameFileChangePlan,
  type RenameFileScope,
  type RenameTarget,
} from "../memory/rename-entry";
import type { Jsonish } from "../memory/types";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { gitSingleFlight } from "../_shared/git-singleflight";
import {
  canonicalGitRuntimeEnabled,
  createProducedArtifactReceipt,
  getCanonicalGitRuntime,
  getCanonicalStartupPromise,
  type CanonicalGitRuntime,
  type DrainResult,
  type ProducedArtifact,
} from "../_shared/canonical-git-runtime";
// `slugify` is the free-text-to-bare-slug normalizer. We deliberately
// do NOT use `normalizeBareSlug` here, because that one is designed
// for path/wikilink/id inputs (`[[X]]`, `project:foo:bar`,
// `path/to/file.md`) and treats `/` as a path separator, taking only
// the last component. For a free-text TITLE that happens to contain
// `/` as punctuation (e.g. "Distinguished by extractor/reason
// Combinations"), normalizeBareSlug would silently truncate to just
// the last segment ("reason-combinations"). Auto-write produced
// exactly this bug on first production fire (2026-05-08); we now
// always slugify titles directly.
import { slugify } from "../memory/utils";
import {
  abrainAboutMeDirByRegion,
  abrainHabitsDir,
  abrainIdentityDir,
  abrainKnowledgeDir,
  abrainStateDir,
  abrainProjectDir,
  abrainProjectsDir,
  abrainProjectRulesDir,
  abrainProjectWorkflowsDir,
  abrainSedimentAuditPath,
  abrainRulesDir,
  abrainSedimentLocksDir,
  abrainSkillsDir,
  acquireFileLock,
  abrainWorkflowsDir,
  ensureProjectGitignoredOnce,
  ensureSedimentLegacyMigrated,
  formatLocalIsoTimestamp,
  sedimentAuditPath,
  validateAbrainProjectId,
} from "../_shared/runtime";
import {
  applyStagingDowngrade,
  LANE_G_ALLOWED_REGIONS,
  type AboutMeRegion,
  type RouteDecision,
  RouterError,
  validateRouteDecision,
} from "./about-me-router";

const AUDIT_SCHEMA_VERSION = 2;

const execFileAsync = promisify(execFile);

export interface ProjectEntryDraft {
  title: string;
  kind: EntryKind;
  compiledTruth: string;
  /** Optional caller-provided durable identity slug. Most writers derive slug
   *  from title; staging promotion sets this after LLM identity resolution so
   *  title can stay human-readable while slug remains canonical. */
  preferredSlug?: string;
  summary?: string;
  status?: EntryStatus;
  // AX-PROVENANCE (ADR 0028 v1.1): ground-truth-strength axis carried from the
  // detector to the writer so rule frontmatter records the TRUE source (Tier-1
  // seed = user-expressed; extractor/curator = assistant-observed) rather than a
  // blanket default. Optional; rule-writer falls back to assistant-observed.
  provenance?: ProvenanceClass;
  confidence?: number;
  triggerPhrases?: string[];
  /** Slugs of upstream entries this entry derives from (set by curator CREATE op
   *  when the candidate is a downstream observation building on a neighbor's
   *  premise). Written to frontmatter `derives_from` for graph/reconciliation.
   *  ADR 0018 Layer 1 — update-vs-create discipline. */
  derivesFrom?: string[];
  sessionId?: string;
  timelineNote?: string;
}

export function resolveDraftSlug(draft: Pick<ProjectEntryDraft, "preferredSlug" | "title">): string {
  return (draft.preferredSlug && slugify(draft.preferredSlug)) || slugify(draft.title);
}

export interface WriterAuditContext {
  lane?: "explicit" | "auto_write" | string;
  sessionId?: string;
  correlationId?: string;
  candidateId?: string;
}

export interface WriteProjectEntryOptions {
  /** Project repo root — still used as the audit/lock substrate root
   *  for project-scoped entries (i.e. `<projectRoot>/.pi-astack/sediment/audit.jsonl`).
   *  For world-scoped entries, audit goes to abrain-side path. */
  projectRoot: string;
  /** Abrain home (required since the 2026-05-13 sediment cutover): the
   *  entry markdown is written under `<abrainHome>/projects/<projectId>/`
   *  (project scope) or `<abrainHome>/knowledge/` (world scope),
   *  and the corresponding git commit lands in the abrain repo. */
  abrainHome: string;
  /** Strict-binding project id (from `resolveActiveProject`). Required
   *  for project-scoped entries; ignored for world-scoped entries. */
  projectId: string;
  /** Scope routing (ADR 014 Lane C): "project" (default) writes to
   *  `<abrainHome>/projects/<projectId>/<kindDir>/<slug>.md`;
   *  "world" writes to `<abrainHome>/knowledge/<slug>.md` (flat, no kindDir). */
  scope?: "project" | "world";
  settings: SedimentSettings;
  dryRun?: boolean;
  auditOperation?: string;
  auditExtras?: Record<string, unknown>;
  auditContext?: WriterAuditContext;
}

export type DeleteMode = "soft" | "hard";

export interface ProjectEntryUpdateDraft {
  /** Optional A3 rename-on-update target slug. Project-scope v1 only. */
  newSlug?: string;
  title?: string;
  kind?: EntryKind;
  status?: EntryStatus;
  /** CAS / compare-and-swap precondition (ADR 0027 C3' infra). When set, the
   *  update is REJECTED (reason: status_precondition_failed) unless the
   *  entry's CURRENT on-disk status equals this value. Undefined = no check
   *  (backward-compatible: existing callers are unaffected). Needed by the
   *  staging-resolver (provisional→active) and hard_archive (git rm only when
   *  still archived) so a concurrent reactivate/update/delete cannot be
   *  clobbered by a stale-status transition. The on-disk read happens inside
   *  the sediment lock on the real RMW path, making this a true CAS. */
  expected_status?: EntryStatus;
  confidence?: number;
  compiledTruth?: string;
  triggerPhrases?: string[];
  frontmatterPatch?: Record<string, Jsonish | undefined>;
  sessionId?: string;
  timelineNote?: string;
  timelineAction?: string;
}

export type WriterPublicationStatus = "local_durable" | "durable_pending" | "clean" | "terminal_before_publish";

export interface WriterPublicationResult {
  status: WriterPublicationStatus;
  commit: string | null;
  localCommit: "not_published" | "published" | "index_converged";
  drainStatus: string;
  reason?: string;
  episodeId?: string;
  slot?: number;
  candidate?: string;
  canonical: boolean;
}

export interface WriteProjectEntryResult {
  slug: string;
  path: string;
  status: "created" | "updated" | "merged" | "archived" | "superseded" | "deleted" | "skipped" | "dry_run" | "rejected";
  reason?: string;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  publication?: WriterPublicationResult;
  auditPath?: string;
  deleteMode?: DeleteMode;
  sanitizedReplacements?: string[];
  duplicate?: DedupeResult;
  /** Shared adapter field for no-op semantic/exact dedupe results, especially rules-zone writes. */
  dedupedAgainst?: string;
  validationErrors?: Array<{ field: string; message: string }>;
  lane?: string;
  sessionId?: string;
  correlationId?: string;
  candidateId?: string;
  knowledgeEvidenceEvent?: AppendKnowledgeEvidenceForWriteResult;
  tier2RulesLegacyWriteGate?: {
    mode: "observe" | "block";
    caller: "curator_decision_writer";
    operation: "create" | "archive" | "delete";
    blocked: boolean;
  };
}

interface LockHandle {
  release(): Promise<void>;
}

function writerAuditFields(opts: WriteProjectEntryOptions, fallbackSessionId?: string): Record<string, unknown> {
  const ctx = opts.auditContext;
  const sessionId = ctx?.sessionId ?? fallbackSessionId;
  return {
    ...(ctx?.lane ? { lane: ctx.lane } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(ctx?.correlationId ? { correlation_id: ctx.correlationId } : {}),
    ...(ctx?.candidateId ? { candidate_id: ctx.candidateId } : {}),
  };
}

function resultAuditFields(opts: WriteProjectEntryOptions, fallbackSessionId?: string): Pick<WriteProjectEntryResult, "lane" | "sessionId" | "correlationId" | "candidateId"> {
  const ctx = opts.auditContext;
  return {
    ...(ctx?.lane ? { lane: ctx.lane } : {}),
    ...((ctx?.sessionId ?? fallbackSessionId) ? { sessionId: ctx?.sessionId ?? fallbackSessionId } : {}),
    ...(ctx?.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...(ctx?.candidateId ? { candidateId: ctx.candidateId } : {}),
  };
}

function withWriterAuditContext(opts: WriteProjectEntryOptions, fallbackSessionId: string | undefined, event: Record<string, unknown>): Record<string, unknown> {
  return { ...writerAuditFields(opts, fallbackSessionId), ...event };
}

function summarizeKnowledgeEvidenceEvent(result: AppendKnowledgeEvidenceForWriteResult): Record<string, unknown> {
  return {
    ok: result.append.ok,
    status: result.append.status,
    event_id: result.append.eventId ?? null,
    file_path: result.append.filePath ?? null,
    projection: result.projection ? {
      ok: result.projection.ok,
      status: result.projection.status,
      output_path: result.projection.outputPath ?? null,
      manifest_path: result.projection.manifestPath ?? null,
      error: result.projection.error ?? null,
    } : null,
    error: result.append.error ?? null,
    recovered_empty_residue: result.append.recoveredEmptyResidue ?? false,
    diagnostics: result.append.diagnostics ?? [],
  };
}

function shouldBlockKnowledgeLegacyWrite(settings: SedimentSettings, result: AppendKnowledgeEvidenceForWriteResult | undefined): boolean {
  return settings.knowledgeEvidenceEventWriter.enabled === true
    && settings.knowledgeEvidenceEventWriter.mode === "event_first"
    && settings.knowledgeEvidenceEventWriter.legacyFallbackOnEventFailure !== true
    && result?.append.ok !== true;
}

function isKnowledgeEvidenceEventFirst(settings: SedimentSettings): boolean {
  return settings.knowledgeEvidenceEventWriter.enabled === true
    && settings.knowledgeEvidenceEventWriter.mode === "event_first";
}

function shouldSkipKnowledgeLegacyMarkdownAfterEvent(settings: SedimentSettings, result: AppendKnowledgeEvidenceForWriteResult | undefined): boolean {
  return isKnowledgeEvidenceEventFirst(settings)
    && settings.knowledgeEvidenceEventWriter.legacyMarkdownWriteOnSuccessfulEvent === false
    && result?.append.ok === true;
}

function knowledgeLegacyMarkdownWriteDisabled(settings: SedimentSettings): boolean {
  return isKnowledgeEvidenceEventFirst(settings)
    && settings.knowledgeEvidenceEventWriter.legacyMarkdownWriteOnSuccessfulEvent === false;
}

function canMutateKnowledgeStableView(settings: SedimentSettings): boolean {
  return knowledgeLegacyMarkdownWriteDisabled(settings)
    && settings.knowledgeProjector.enabled === true
    && settings.knowledgeProjector.projectOnWrite === true
    && settings.knowledgeProjector.projectionMode === "topo";
}

function legacyMarkdownSkippedAudit(result: AppendKnowledgeEvidenceForWriteResult | undefined): Record<string, unknown> {
  return {
    attempted: false,
    reason: "legacy_markdown_write_disabled",
    event_id: result?.append.eventId ?? null,
  };
}

interface StableViewWatermarkCasResult {
  ok: boolean;
  detail?: string;
  l2?: { sediment_watermark_event_id?: string; sediment_input_event_set_hash?: string; sediment_output_hash?: string };
  l1?: KnowledgeEvidenceL1Head | null;
}

function isSha256Hex(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

async function checkKnowledgeStableViewWatermarkCas(args: {
  abrainHome: string;
  projectId: string;
  scope: "project" | "world";
  slug: string;
  raw: string;
}): Promise<StableViewWatermarkCasResult> {
  const frontmatter = parseFrontmatter(splitFrontmatter(args.raw).frontmatterText);
  const watermarkEventId = scalarString(frontmatter.sediment_watermark_event_id);
  const inputEventSetHash = scalarString(frontmatter.sediment_input_event_set_hash);
  const outputHash = scalarString(frontmatter.sediment_output_hash);
  const l2 = { sediment_watermark_event_id: watermarkEventId, sediment_input_event_set_hash: inputEventSetHash, sediment_output_hash: outputHash };
  if (!watermarkEventId || !inputEventSetHash) return { ok: false, detail: "missing_watermark", l2, l1: null };
  if (!isSha256Hex(watermarkEventId) || !isSha256Hex(inputEventSetHash)) return { ok: false, detail: "malformed_watermark", l2, l1: null };
  if (!outputHash) return { ok: false, detail: "missing_output_hash", l2, l1: null };
  if (!isSha256Hex(outputHash)) return { ok: false, detail: "malformed_output_hash", l2, l1: null };
  const actualOutputHash = knowledgeProjectionOutputHashFromMarkdownBytes(args.raw);
  if (!actualOutputHash) return { ok: false, detail: "malformed_output_hash", l2, l1: null };
  if (actualOutputHash !== outputHash) return { ok: false, detail: "output_hash_mismatch", l2, l1: null };
  const l1 = await readKnowledgeEvidenceL1Head({
    abrainHome: args.abrainHome,
    projectId: args.projectId,
    scope: args.scope,
    slug: args.slug,
  });
  if (!l1) return { ok: false, detail: "missing_l1_head", l2, l1: null };
  if (l1.projectionKind === "delete") return { ok: false, detail: "l1_head_deleted", l2, l1 };
  if (l1.winnerEventId !== watermarkEventId) return { ok: false, detail: "watermark_event_id_mismatch", l2, l1 };
  if (l1.inputEventSetHash !== inputEventSetHash) return { ok: false, detail: "input_event_set_hash_mismatch", l2, l1 };
  return { ok: true, l2, l1 };
}

function draftFromEntryMarkdown(raw: string, fallbackSlug: string, fallbackPatch?: ProjectEntryUpdateDraft): ProjectEntryDraft {
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const title = scalarString(frontmatter.title) || fallbackPatch?.title || fallbackSlug;
  const rawKind = scalarString(frontmatter.kind) || fallbackPatch?.kind || "fact";
  const kind = ENTRY_KINDS.includes(rawKind as EntryKind) ? rawKind as EntryKind : "fact";
  const rawStatus = scalarString(frontmatter.status) || fallbackPatch?.status || "provisional";
  const status = ENTRY_STATUSES.includes(rawStatus as EntryStatus) ? rawStatus as EntryStatus : "provisional";
  const rawProvenance = scalarString(frontmatter.provenance) || "assistant-observed";
  const provenance: ProvenanceClass = rawProvenance === "user-expressed" ? "user-expressed" : "assistant-observed";
  const confidence = Math.min(10, Math.max(0, Math.round(scalarNumber(frontmatter.confidence) ?? fallbackPatch?.confidence ?? 3)));
  return {
    title,
    kind,
    status,
    provenance,
    confidence,
    compiledTruth: splitCompiledTruth(body).compiledTruth.trim() || body.trim() || title,
    triggerPhrases: relationValues(frontmatter.trigger_phrases),
    derivesFrom: relationValues(frontmatter.derives_from),
    sessionId: fallbackPatch?.sessionId,
    timelineNote: fallbackPatch?.timelineNote,
  };
}

async function appendKnowledgeEvidenceForMarkdown(args: {
  abrainHome: string;
  projectId: string;
  scope: "project" | "world";
  raw: string;
  fallbackSlug: string;
  result: WriteProjectEntryResult;
  settings: SedimentSettings;
  auditContext?: WriterAuditContext;
  patch?: ProjectEntryUpdateDraft;
  operation: "update" | "merge" | "archive" | "supersede" | "delete";
  causalParents?: string[];
}): Promise<AppendKnowledgeEvidenceForWriteResult | undefined> {
  if (args.settings.knowledgeEvidenceEventWriter.enabled !== true) return undefined;
  const draft = draftFromEntryMarkdown(args.raw, args.fallbackSlug, args.patch);
  const legacyMarkdownDisabled = knowledgeLegacyMarkdownWriteDisabled(args.settings);
  return appendKnowledgeEvidenceForWrite({
    abrainHome: args.abrainHome,
    projectId: args.projectId,
    scope: args.scope,
    draft,
    result: args.result,
    settings: args.settings,
    auditContext: args.auditContext,
    sessionId: args.patch?.sessionId,
    operation: args.operation,
    causalParents: args.causalParents,
    ...(legacyMarkdownDisabled ? { legacyParallelWrite: { attempted: false, status: args.result.status, reason: "legacy_markdown_write_disabled" } } : {}),
  }).catch((err: unknown): AppendKnowledgeEvidenceForWriteResult => ({
    append: {
      ok: false,
      status: "write_failed",
      error: err instanceof Error ? err.message : String(err),
    },
  }));
}

function knowledgeEvidenceWrittenPaths(...events: Array<AppendKnowledgeEvidenceForWriteResult | undefined>): string[] {
  const paths = events.flatMap((event) => [
    event?.append.filePath,
    event?.projection?.outputPath,
    event?.projection?.manifestPath,
  ]);
  return Array.from(new Set(paths.filter((p): p is string => typeof p === "string" && p.length > 0)));
}

async function resetKnowledgeEvidenceIndex(abrainHome: string, event: AppendKnowledgeEvidenceForWriteResult | undefined): Promise<void> {
  const rels = knowledgeEvidenceWrittenPaths(event)
    .map((filePath) => path.relative(abrainHome, filePath))
    .filter((rel) => rel && !rel.startsWith("..") && rel !== ".");
  if (rels.length === 0) return;
  try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", ...rels], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort */ }
}

async function changedDerivedRepoPaths(abrainHome: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", abrainHome, "status", "--porcelain", "-z", "--", "l1", "l2"], { timeout: 10_000, maxBuffer: 1024 * 1024, encoding: "utf-8" });
    const records = String(stdout).split("\0").filter(Boolean);
    const out: string[] = [];
    for (let i = 0; i < records.length; i += 1) {
      const rec = records[i]!;
      const status = rec.slice(0, 2);
      const firstPath = rec.slice(3);
      if (status.startsWith("R") || status.startsWith("C")) {
        if (records[i + 1]) {
          out.push(records[i + 1]!);
          i += 1;
        }
      } else if (firstPath) {
        out.push(firstPath);
      }
    }
    return Array.from(new Set(out.filter((rel) => rel === "l1" || rel === "l2" || rel.startsWith("l1/") || rel.startsWith("l2/")))).sort();
  } catch {
    return [];
  }
}

function nowIso(): string {
  return formatLocalIsoTimestamp();
}

function yamlString(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function yamlValue(value: Jsonish): string[] {
  if (Array.isArray(value)) return value.map((item) => `  - ${yamlString(String(item))}`);
  if (value && typeof value === "object") return [yamlString(JSON.stringify(value))];
  if (typeof value === "boolean") return [value ? "true" : "false"];
  if (typeof value === "number") return [String(value)];
  if (value === null) return ["null"];
  return [yamlString(String(value ?? ""))];
}

function yamlList(key: string, values: string[] | undefined): string[] {
  if (!values?.length) return [];
  return [
    `${key}:`,
    ...values.map((value) => `  - ${yamlString(value)}`),
  ];
}

function kindDirectory(kind: EntryKind, status?: EntryStatus): string {
  if (status === "archived") return "archive";
  switch (kind) {
    case "maxim": return "maxims";
    case "decision": return "decisions";
    case "smell": return "staging";
    case "anti-pattern":
    case "pattern":
    case "fact":
    case "preference":
    default:
      return "knowledge";
  }
}

function normalizeCompiledTruth(title: string, body: string): string {
  let text = body.trim();
  text = text.replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  // Defense against frontmatter break-out: a body line that is
  // exactly `---` would terminate frontmatter on the next read pass
  // (see `splitFrontmatter` in extensions/memory/parser.ts). Markdown
  // hr is a real authoring need though, so we don't reject — we escape
  // by indenting one space, which renders identically in CommonMark
  // (a paragraph-leading space does not start a code block) but no
  // longer matches the strict `^---$` frontmatter delimiter regex.
  text = text.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(text)) text = `# ${title}\n\n${text}`;
  return text.trim();
}

/**
 * Ensure the abrain project's <kind>/<status> tree exists under
 * `<abrainHome>/projects/<projectId>/`. Replaces the V6.x
 * `ensureProjectPensieveRoot` whose canonical write target was the
 * project repo's own `.pensieve/`. Per the 2026-05-13 sediment cutover
 * (writeProjectEntry / archive / delete / merge / supersede / update
 * all migrated to abrain), `.pensieve/` is no longer a sediment write
 * substrate; only migrate-go / doctor-lite still READ from `.pensieve/`
 * when staring at legacy unmigrated repos.
 *
 * Replaces V6.x `projectSlug(projectRoot)` which read
 * `<projectRoot>/.pensieve/config.yml` to recover a project id slug.
 * That config has no successor in the abrain world: the project id is
 * now part of strict-binding identity (passed in via opts.projectId).
 */
async function ensureAbrainEntryRoot(abrainHome: string, projectId: string): Promise<string> {
  const root = abrainProjectDir(abrainHome, projectId);
  await fs.mkdir(root, { recursive: true });
  return root;
}

// V6.x post-migration `.pensieve/MIGRATED_TO_ABRAIN` guard removed in the
// 2026-05-13 sediment cutover: sediment writer no longer touches
// `.pensieve/` under any condition, so a flag whose sole purpose was to
// REJECT `.pensieve/` writes had no remaining caller. Binding identity
// (`.abrain-project.json` + `<abrainHome>/projects/<id>/_project.json`
// + local-map confirmed path) is the canonical post-migration marker now.

function buildMarkdown(draft: ProjectEntryDraft, scope: "project" | "world", projectId?: string): { slug: string; markdown: string } {
  const timestamp = nowIso();
  const status = draft.status ?? "provisional";
  const confidence = Math.min(10, Math.max(0, Math.round(draft.confidence ?? 3)));
  // AX-PROVENANCE (ADR 0028 §12): persist the ground-truth-strength axis for
  // project/world entries too. Legacy/missing callers default to
  // assistant-observed; memory/parser.ts mirrors this fallback on read.
  const provenance = draft.provenance ?? "assistant-observed";
  const slug = resolveDraftSlug(draft);
  const compiledTruth = normalizeCompiledTruth(draft.title, draft.compiledTruth);
  const timelineSession = draft.sessionId || "sediment";
  const timelineNote = draft.timelineNote || `created by sediment ${scope} writer`;

  // projectId is already validated by validateAbrainProjectId (allowed
  // chars [a-zA-Z0-9_.-]+). DO NOT pass through slugify() here — that
  // would lowercase and rewrite `_`/`.` to `-`, producing an id that
  // disagrees with migrate-go's `id: project:<projectId>:<slug>`
  // (migrate-go.ts uses raw projectId). Mismatched ids would split
  // wikilink / backlink resolution between migrated and freshly-written
  // entries when the projectId contains any non-lowercase / non-dash chars.
  const entryId = scope === "world"
    ? `world:${slug}`
    : `project:${projectId}:${slug}`;

  const frontmatter: string[] = [
    "---",
    `id: ${entryId}`,
    `scope: ${scope}`,
    `kind: ${draft.kind}`,
    `status: ${status}`,
    `confidence: ${confidence}`,
    `provenance: ${yamlString(provenance)}`,
    "schema_version: 1",
    `title: ${yamlString(draft.title)}`,
    `created: ${timestamp}`,
    `updated: ${timestamp}`,
    // ADR 0025 §4.6: when an entry is born directly in `archived` state
    // (rare but legal — e.g. a curator may decide CREATE→ARCHIVE in the
    // same op for a self-superseded smell), persist the absolute archive
    // timestamp so future archive-reactivation-reviewer can age it.
    // For the common path (created as `active`/`provisional`), no
    // archive_at field is emitted; it appears only when `status=archived`
    // is set, either here or via the update path (see mergeUpdateMarkdown).
    ...(status === "archived" ? [`archive_at: ${timestamp}`] : []),
    ...yamlList("trigger_phrases", draft.triggerPhrases),
    ...yamlList("derives_from", draft.derivesFrom),
  ];
  if (scope === "project" && projectId) {
    frontmatter.push(`project_id: ${yamlString(projectId)}`);
  }
  frontmatter.push("---", "");

  const markdown = [
    ...frontmatter,
    compiledTruth,
    "",
    "## Timeline",
    "",
    `- ${timestamp} | ${timelineSession} | captured | ${timelineNote}`,
    "",
  ].join("\n");

  return { slug, markdown };
}

function frontmatterOrder(frontmatterText: string): string[] {
  const out: string[] = [];
  for (const line of frontmatterText.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):/);
    if (match && !out.includes(match[1])) out.push(match[1]);
  }
  return out;
}

function renderFrontmatter(frontmatter: Record<string, Jsonish>, originalOrder: string[]): string {
  const preferred = [
    "id", "scope", "kind", "status", "confidence", "provenance", "schema_version",
    "title", "created", "updated",
    // ADR 0025 §4.6: keep archive_at adjacent to the other lifecycle
    // timestamps so a hand-reader can spot the archive epoch at a glance.
    "archive_at",
    "trigger_phrases", "derives_from",
  ];
  const keys = [
    ...preferred,
    ...originalOrder,
    ...Object.keys(frontmatter).sort(),
  ].filter((key, index, arr) => frontmatter[key] !== undefined && arr.indexOf(key) === index);

  const lines = ["---"];
  for (const key of keys) {
    const value = frontmatter[key];
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`, ...yamlValue(value));
      continue;
    }
    lines.push(`${key}: ${yamlValue(value)[0]}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

async function findWorldEntryFile(abrainHome: string, slug: string): Promise<string | undefined> {
  const target = path.join(abrainKnowledgeDir(abrainHome), `${slug}.md`);
  try {
    await fs.access(target);
    return target;
  } catch {
    return undefined;
  }
}

async function findProjectEntryFile(entryRoot: string, slug: string): Promise<string | undefined> {
  const targetName = `${slug}.md`;
  async function walk(dir: string): Promise<string | undefined> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    for (const entry of entries) {
      // Skip metadata + lock + tmp + workflow output dirs (workflows live
      // under the same project root but are written by a separate writer,
      // and `_project.json` is the binding manifest, not an entry).
      if (entry.name === ".git" || entry.name === ".state" || entry.name === ".index" || entry.name === "_project.json" || entry.name === "workflows" || entry.name === "vault") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const hit = await walk(abs);
        if (hit) return hit;
      } else if (entry.isFile() && entry.name === targetName) {
        return abs;
      }
    }
    return undefined;
  }
  return walk(entryRoot);
}

function shouldPreferKnowledgeStableViewForMutation(settings: SedimentSettings): boolean {
  return canMutateKnowledgeStableView(settings);
}

async function findStableViewEntryFile(args: {
  abrainHome: string;
  projectId: string;
  settings: SedimentSettings;
  scope: "project" | "world";
  slug: string;
}): Promise<string | undefined> {
  const stores = await readKnowledgeStableViewStores({ abrainHome: args.abrainHome, projectId: args.projectId, settings: args.settings });
  for (const store of stores) {
    if (store.scope !== args.scope) continue;
    const target = path.join(store.root, `${args.slug}.md`);
    try {
      await fs.access(target);
      return target;
    } catch { /* try next stable-view store */ }
  }
  return undefined;
}

async function findKnowledgeMutationReadFile(args: {
  abrainHome: string;
  projectId: string;
  entryRoot: string;
  settings: SedimentSettings;
  scope: "project" | "world";
  slug: string;
}): Promise<{ path: string; source: "stable_view" | "legacy" } | undefined> {
  if (shouldPreferKnowledgeStableViewForMutation(args.settings)) {
    const stable = await findStableViewEntryFile(args);
    if (stable) return { path: stable, source: "stable_view" };
  }
  const legacy = args.scope === "world"
    ? await findWorldEntryFile(args.abrainHome, args.slug)
    : await findProjectEntryFile(args.entryRoot, args.slug);
  return legacy ? { path: legacy, source: "legacy" } : undefined;
}

async function listMarkdownFiles(root: string, skipNames = new Set([".git", ".state", ".index", "vault"])): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skipNames.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  return out.sort();
}

function fileScopeForMemoryPath(abrainHome: string, filePath: string): RenameFileScope | null {
  const rel = path.relative(abrainHome, filePath).split(path.sep);
  if (rel[0] === "knowledge") return { scope: "world" };
  if (rel[0] === "projects" && rel[1] && !["rules", "workflows", "vault"].includes(rel[2] ?? "")) {
    return { scope: "project", projectId: rel[1] };
  }
  return null;
}

async function listMemoryEntryMarkdownFiles(abrainHome: string): Promise<string[]> {
  const roots = [abrainKnowledgeDir(abrainHome), abrainProjectsDir(abrainHome)];
  const files: string[] = [];
  for (const root of roots) files.push(...await listMarkdownFiles(root, new Set([".git", ".state", ".index", "_project.json", "rules", "workflows", "vault"])));
  return files.sort();
}

async function listProjectIds(abrainHome: string): Promise<string[]> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(abrainProjectsDir(abrainHome), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function listExternalZoneMarkdownFiles(abrainHome: string): Promise<Array<{ path: string; zone: string }>> {
  const zones: Array<{ root: string; zone: string }> = [
    { root: abrainRulesDir(abrainHome), zone: "rules" },
    { root: abrainWorkflowsDir(abrainHome), zone: "workflows" },
    { root: abrainIdentityDir(abrainHome), zone: "identity" },
    { root: abrainSkillsDir(abrainHome), zone: "skills" },
    { root: abrainHabitsDir(abrainHome), zone: "habits" },
  ];
  for (const projectId of await listProjectIds(abrainHome)) {
    zones.push(
      { root: abrainProjectRulesDir(abrainHome, projectId), zone: `project:${projectId}:rules` },
      { root: abrainProjectWorkflowsDir(abrainHome, projectId), zone: `project:${projectId}:workflows` },
    );
  }
  const out: Array<{ path: string; zone: string }> = [];
  for (const zone of zones) {
    for (const file of await listMarkdownFiles(zone.root)) out.push({ path: file, zone: zone.zone });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function activeStatusOf(raw: string): string {
  try {
    const status = parseFrontmatter(splitFrontmatter(raw).frontmatterText).status;
    return typeof status === "string" ? status : "provisional";
  } catch {
    return "provisional";
  }
}

function replaceEntryIdForRename(raw: string, projectId: string, newSlug: string): string {
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  frontmatter.id = `project:${projectId}:${newSlug}`;
  frontmatter.scope = "project";
  frontmatter.project_id = projectId;
  return `${renderFrontmatter(frontmatter, frontmatterOrder(frontmatterText))}${body}`;
}

async function gitHead(abrainHome: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", abrainHome, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    return stdout.trim();
  } catch {
    throw new Error("rename_requires_git_head");
  }
}

async function buildRenameApplyPlan(args: {
  abrainHome: string;
  entryRoot: string;
  targetPath: string;
  originalRaw: string;
  mergedMarkdown: string;
  oldSlug: string;
  newSlugRaw: string;
  projectId: string;
}): Promise<{ ok: true; plan: RenameApplyPlan; issueCount: number } | { ok: false; reason: string; detail?: string }> {
  const newSlug = slugify(args.newSlugRaw);
  const target: RenameTarget = { scope: "project", projectId: args.projectId, oldSlug: args.oldSlug, newSlug };
  const basicIssues = basicRenamePreflight(target);
  if (basicIssues.length > 0) return { ok: false, reason: basicIssues[0]!.code, detail: basicIssues.map((i) => i.detail).join("; ") };
  const currentStatus = activeStatusOf(args.originalRaw);
  if (currentStatus === "archived" || currentStatus === "superseded" || currentStatus === "deprecated") {
    return { ok: false, reason: "rename_inactive_entry", detail: `status=${currentStatus}` };
  }
  const sameProjectCollision = await findProjectEntryFile(args.entryRoot, newSlug);
  if (sameProjectCollision) return { ok: false, reason: "rename_collision", detail: path.relative(args.abrainHome, sameProjectCollision) };

  for (const file of await listMemoryEntryMarkdownFiles(args.abrainHome)) {
    if (path.basename(file) !== `${newSlug}.md`) continue;
    const raw = await fs.readFile(file, "utf-8").catch(() => "");
    const status = activeStatusOf(raw);
    if (status !== "archived" && status !== "superseded" && status !== "deprecated") {
      return { ok: false, reason: "rename_active_corpus_collision", detail: path.relative(args.abrainHome, file) };
    }
  }

  const externalNeedle = `project:${args.projectId}:${args.oldSlug}`;
  for (const external of await listExternalZoneMarkdownFiles(args.abrainHome)) {
    const raw = await fs.readFile(external.path, "utf-8").catch(() => "");
    if (raw.includes(externalNeedle)) {
      return { ok: false, reason: "external_zone_reference_unhandled", detail: `${external.zone}:${path.relative(args.abrainHome, external.path)}` };
    }
  }

  const entryNewPath = path.join(path.dirname(args.targetPath), `${newSlug}.md`);
  let entryNewContent = replaceEntryIdForRename(args.mergedMarkdown, args.projectId, newSlug);
  const fileChanges: RenameFileChangePlan[] = [];
  let issueCount = 0;
  for (const file of await listMemoryEntryMarkdownFiles(args.abrainHome)) {
    const fileScope = file === args.targetPath
      ? { scope: "project", projectId: args.projectId } as RenameFileScope
      : fileScopeForMemoryPath(args.abrainHome, file);
    if (!fileScope) continue;
    const raw = file === args.targetPath ? entryNewContent : await fs.readFile(file, "utf-8");
    const scopeIssues = frontmatterScopeMatchesFileScope(splitFrontmatter(raw).frontmatterText, fileScope);
    const shadowIssues = findPreexistingBareNewSlugRefs(raw, fileScope, target);
    const rewritten = rewriteMarkdownForRename(raw, fileScope, target);
    const issues = [...scopeIssues, ...shadowIssues, ...rewritten.issues];
    if (issues.length > 0) return { ok: false, reason: issues[0]!.code, detail: issues.map((i) => `${path.relative(args.abrainHome, file)}:${i.line ?? 0}:${i.detail}`).join("; ") };
    issueCount += rewritten.changes.length;
    const finalPath = file === args.targetPath ? entryNewPath : file;
    if (file === args.targetPath) {
      entryNewContent = rewritten.content;
    } else if (rewritten.content !== raw) {
      fileChanges.push({ path: finalPath, newContent: rewritten.content });
    }
  }
  const baseHead = await gitHead(args.abrainHome);
  return {
    ok: true,
    plan: {
      target,
      baseHead,
      entryOldPath: args.targetPath,
      entryNewPath,
      entryNewContent,
      expectedNewId: `project:${args.projectId}:${newSlug}`,
      fileChanges: fileChanges.filter((change) => change.path !== entryNewPath),
      vectorStaleSlugs: [args.oldSlug, newSlug],
    },
    issueCount,
  };
}

function mergeUpdateMarkdown(
  raw: string,
  patch: ProjectEntryUpdateDraft,
  slug: string,
  projectId: string,
  mergeOpts: { scope?: "project" | "world" } = {},
): { markdown: string; validationDraft: ProjectEntryDraft; sanitizedReplacements: string[] } | { error: string } {
  const timestamp = nowIso();
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const { compiledTruth: existingCompiledTruth, timeline } = splitCompiledTruth(body);

  const title = patch.title ?? (typeof frontmatter.title === "string" ? frontmatter.title : slug);
  const kindRaw = typeof frontmatter.kind === "string" ? frontmatter.kind : null;
  const kind = (patch.kind ?? ((kindRaw && (ENTRY_KINDS as readonly string[]).includes(kindRaw)) ? kindRaw as EntryKind : undefined)) ?? "fact";
  const statusRaw = typeof frontmatter.status === "string" ? frontmatter.status : null;
  const status = (patch.status ?? ((statusRaw && (ENTRY_STATUSES as readonly string[]).includes(statusRaw)) ? statusRaw as EntryStatus : undefined)) ?? "provisional";
  const confidenceRaw = patch.confidence ?? (typeof frontmatter.confidence === "number" ? frontmatter.confidence : Number(frontmatter.confidence ?? 3));
  const confidence = Math.min(10, Math.max(0, Math.round(Number.isFinite(confidenceRaw) ? confidenceRaw : 3)));
  const compiledTruth = patch.compiledTruth !== undefined
    ? normalizeCompiledTruth(title, patch.compiledTruth)
    : existingCompiledTruth.trim();

  const validationDraft: ProjectEntryDraft = { title, kind, status, confidence, compiledTruth };
  const validationErrors = validateProjectEntryDraft(validationDraft);
  if (validationErrors.length > 0) return { error: `validation_error: ${validationErrors.map((e) => `${e.field}:${e.message}`).join("; ")}` };

  const titleSanitize = sanitizeForMemory(title);
  const bodySanitize = sanitizeForMemory(compiledTruth);
  const noteSanitize = patch.timelineNote
    ? sanitizeForMemory(patch.timelineNote)
    : { ok: true, text: undefined, replacements: [] as string[] };
  const triggerPhrases = patch.triggerPhrases;
  const triggerPhraseSanitizes = (triggerPhrases ?? []).map((p) => sanitizeForMemory(p));
  const failedSanitize = [titleSanitize, bodySanitize, noteSanitize, ...triggerPhraseSanitizes].find((result) => !result.ok);
  if (failedSanitize) return { error: failedSanitize.error ?? "sanitize_error" };

  const safeTitle = titleSanitize.text ?? title;
  const safeCompiledTruth = bodySanitize.text ?? compiledTruth;
  const safeTimelineNote = patch.timelineNote ? (noteSanitize.text ?? patch.timelineNote) : "updated by sediment curator";
  const safeTimelineAction = (patch.timelineAction || "updated").replace(/[|\r\n]/g, " ").trim() || "updated";
  const sanitizedReplacements = [
    ...titleSanitize.replacements,
    ...bodySanitize.replacements,
    ...noteSanitize.replacements,
    ...triggerPhraseSanitizes.flatMap((s) => s.replacements),
  ];

  // Round 8 P1 (gpt-5.5 R8 audit): `frontmatterPatch` was applied AFTER
  // validateProjectEntryDraft, letting callers slip in arbitrary keys
  // including the lifecycle-controlled ones (`id`, `scope`, `kind`,
  // `status`, `confidence`, `schema_version`, `title`, `created`,
  // `updated`) and search-anchor keys (`trigger_phrases`) that must go
  // through dedicated merge/sanitize logic. All in-repo callers (`mergeProjectEntries`,
  // `supersedeProjectEntry`) only set relation keys (`derives_from`,
  // `superseded_by`), so the current blast radius is theoretical — but
  // the API contract leaves an obvious foot-gun if a future Lane G /
  // curator path starts passing patches LLM-driven. Enforce a denylist
  // of system-managed keys so the validator/lint contract is preserved.
  const PROTECTED_FRONTMATTER_KEYS = new Set([
    "id", "scope", "kind", "status", "confidence", "schema_version",
    "title", "created", "updated", "trigger_phrases",
    // ADR 0025 §4.6 archive_at is lifecycle-managed: it is the absolute
    // ISO timestamp of the first transition into `status=archived`. Setting
    // it from frontmatterPatch would let curator's natural-language rationale
    // route around the lifecycle logic below (set/preserve/clear), defeating
    // the future archive-reactivation-reviewer's N-day age window. Lifecycle
    // path: mergeUpdateMarkdown below manages it based on status transition.
    "archive_at",
  ]);
  const userPatch = patch.frontmatterPatch ?? {};
  for (const k of Object.keys(userPatch)) {
    if (PROTECTED_FRONTMATTER_KEYS.has(k)) {
      throw new Error(
        `frontmatterPatch cannot override protected key '${k}'. Use the dedicated WriteProjectEntryOptions field (e.g. status flows through ProjectEntryUpdateDraft.status) so validation runs.`,
      );
    }
    // Also guard key shape (no newline/control chars in keys themselves):
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) {
      throw new Error(`frontmatterPatch key contains invalid characters: ${JSON.stringify(k)}`);
    }
  }

  const scope = mergeOpts.scope ?? (frontmatter.scope === "world" ? "world" : "project");
  const nextFrontmatter: Record<string, Jsonish> = {
    ...frontmatter,
    // See buildMarkdown above: stay consistent with migrate-go's raw
    // `project:<projectId>:<slug>` form; never run projectId through slugify
    // (would corrupt ids whose projectId uses uppercase or `_`/`.`). World
    // lifecycle updates must keep world identity instead of rewriting the
    // file into project-scoped frontmatter.
    id: scope === "world" ? `world:${slug}` : (frontmatter.id ?? `project:${projectId}:${slug}`),
    scope,
    kind,
    status,
    confidence,
    schema_version: frontmatter.schema_version ?? 1,
    title: safeTitle,
    created: frontmatter.created ?? timestamp,
    updated: timestamp,
    ...userPatch,
  };
  for (const [key, value] of Object.entries(userPatch)) {
    if (value === undefined) delete nextFrontmatter[key];
  }
  if (scope === "world") {
    delete nextFrontmatter.project_id;
  } else {
    nextFrontmatter.project_id = frontmatter.project_id ?? projectId;
  }

  // ADR 0025 §4.6 archive_at lifecycle management.
  //
  // Three transitions to handle:
  //   (a) NON-ARCHIVED → ARCHIVED: stamp archive_at = now. This is the
  //       wall-clock origin from which the future archive-reactivation
  //       reviewer counts its N-day soft-delete window.
  //   (b) ARCHIVED → ARCHIVED (subsequent update to an already-archived
  //       entry, e.g. reason rewrite): PRESERVE existing archive_at. If
  //       we reset on every update, an automated re-archive sweep (or a
  //       trivial cosmetic patch) would silently slide the N-day window
  //       forward, defeating the whole reviewer-window idea.
  //   (c) ARCHIVED → NON-ARCHIVED (reactivation, however performed): clear
  //       archive_at. The field's meaning is "currently archived since
  //       ..."; leaving it set on a reactivated entry would be a lie.
  //
  // status was resolved above from patch.status OR existing frontmatter
  // (which may itself be "archived"). The PRIOR status is what determines
  // (a) vs (b); we read it from the on-disk frontmatter directly.
  const priorStatus = typeof frontmatter.status === "string" ? frontmatter.status : null;
  if (status === "archived") {
    if (priorStatus !== "archived") {
      // (a) New archive event — always stamp fresh, ignore any leaked value.
      nextFrontmatter.archive_at = timestamp;
    } else if (typeof frontmatter.archive_at === "string" && frontmatter.archive_at) {
      // (b) Preserve existing absolute timestamp.
      nextFrontmatter.archive_at = frontmatter.archive_at;
    } else {
      // (b′) Already-archived entry missing archive_at (e.g. legacy entries
      // archived before this field existed). Backfill with now — N-day
      // window starts from this backfill, which is the safest default:
      // a stale legacy archive will not be eligible for early hard-delete
      // but also not for indefinite review accumulation.
      nextFrontmatter.archive_at = timestamp;
    }
  } else {
    // (c) Reactivation — explicitly clear the field if present.
    delete nextFrontmatter.archive_at;
  }
  if (triggerPhrases) {
    // Defense-in-depth against curator P0 (2026-05-13 abrain commit
    // 521405b): curator on update replaced 5 existing trigger_phrases
    // ("bidirectional gate" etc., key retrieval anchors for the entry)
    // with 4 unrelated new phrases. trigger_phrases are search anchors
    // — dropping one breaks memory_search recall for that aspect of
    // the entry. Mechanical fix: UNION the existing phrases with the
    // candidate's, never REPLACE. Curator's prompt now also instructs
    // UNION, but enforcing it here ensures it even when prompt is
    // ignored.
    //
    // Dedup is case-insensitive on the trimmed string (different casing
    // of the same phrase → keep the first form encountered; existing
    // phrases win on conflict). If a curator deliberately wants to
    // retire a phrase, they need to do it via supersede/archive (not
    // update), which is the correct workflow.
    // Defense-in-depth for the UNION semantics: handle both the
    // canonical multi-line YAML list form (parser returns Array) and
    // the legacy scalar string form (`trigger_phrases: only one`)
    // that handwritten / older entries may have. Without the scalar
    // branch, an entry with a single bare-string trigger_phrase would
    // silently lose it on UNION (Array.isArray=false → existing=[] →
    // candidate REPLACES, defeating the floor's whole purpose).
    const existingRaw = frontmatter.trigger_phrases;
    const existing: string[] = Array.isArray(existingRaw)
      ? (existingRaw as unknown[]).filter((v): v is string => typeof v === "string")
      : typeof existingRaw === "string" && existingRaw.trim()
        ? [existingRaw.trim()]
        : [];
    const candidate = triggerPhraseSanitizes.map((s, i) => s.text ?? triggerPhrases[i]);
    const seen = new Set<string>();
    const union: string[] = [];
    for (const p of [...existing, ...candidate]) {
      const key = p.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      union.push(p);
    }
    nextFrontmatter.trigger_phrases = union;
  }

  const timelineSession = patch.sessionId || "sediment";
  const nextTimeline = [
    ...timeline,
    `- ${timestamp} | ${timelineSession} | ${safeTimelineAction} | ${safeTimelineNote}`,
  ];
  const markdown = [
    renderFrontmatter(nextFrontmatter, frontmatterOrder(frontmatterText)),
    safeCompiledTruth.trim(),
    "",
    "## Timeline",
    "",
    ...nextTimeline,
    "",
  ].join("\n");

  return {
    markdown,
    validationDraft: { title: safeTitle, kind, status, confidence, compiledTruth: safeCompiledTruth },
    sanitizedReplacements,
  };
}

/**
 * If a lock file is older than this, the previous holder is assumed to have
 * crashed without releasing it and the lock can be reclaimed. Set generously
 * (vs the few-second-tops typical sediment write) so a slow agent_end run is
 * never stolen mid-flight; but short enough that a `kill -9` followed by
 * restart auto-heals within seconds, not days.
 *
 * History: Round 5 audit (2026-05-12, deepseek-v4-pro) found that
 * `acquireLock` and `acquireAbrainWorkflowLock` had no reclaim path at all
 * — a crash mid-write left the lock file on disk forever, and every
 * subsequent /memory write call timed out after `lockTimeoutMs` (5s default)
 * with the misleading "sediment lock timeout" error. The pattern below is
 * borrowed from `withCheckpointLock` (`checkpoint.ts:139`) which uses the
 * same owner-token stale reclaim helper. The helper validates the lock
 * token before both stealing and releasing, so a slow previous holder cannot
 * delete a fresh successor's lock in its finally block.
 */
const SEDIMENT_LOCK_STEAL_AFTER_MS = 30_000;

async function acquireLock(abrainHome: string, timeoutMs: number): Promise<LockHandle> {
  // Lock substrate moved from project-local `<projectRoot>/.pi-astack/
  // sediment/locks/` to `<abrainHome>/.state/sediment/locks/` along with
  // the entry write target: parallel sediment writes from multiple
  // projects bound to the same abrain home must serialize against the
  // SAME lock file, since they all commit into the same abrain git repo.
  // Per-project lock would let two sessions race the abrain index head.
  const lockPath = path.join(abrainSedimentLocksDir(abrainHome), "sediment.lock");
  const handle = await acquireFileLock(lockPath, {
    timeoutMs,
    staleMs: SEDIMENT_LOCK_STEAL_AFTER_MS,
    retryMs: 100,
    label: "sediment",
  });
  return { release: handle.release };
}

async function recoverRenameTransactionIfNeeded(abrainHome: string) {
  const rollback = await rollbackRenameTransaction(abrainHome);
  let vectorRollback: ReturnType<typeof rollbackRenameSlugInVectorIndexFile> | undefined;
  if (rollback.didRollback && rollback.target?.scope === "project") {
    vectorRollback = rollbackRenameSlugInVectorIndexFile(
      rollback.target.oldSlug,
      rollback.target.newSlug,
      `project:${rollback.target.projectId}`,
      path.join(abrainStateDir(abrainHome), "memory", "embeddings.json"),
    );
  }
  return { ...rollback, vectorRollback };
}

async function atomicWrite(file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  // Round 8 P1 (deepseek R8 audit): if writeFile succeeds but rename
  // throws (ENOSPC / EXDEV / fs full / EACCES), or if writeFile throws
  // mid-write, the tmp file used to leak. Idempotent cleanup via finally
  // catches both paths. Successful rename leaves nothing for unlink to do
  // (ENOENT swallowed).
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => { /* tmp already renamed or never written */ });
  }
}

function shouldAppendWriterPublicationAudit(publication: WriterPublicationResult): boolean {
  return publication.drainStatus !== "metadata_deferred";
}

async function appendWriterPublicationAudit(abrainHome: string, publication: WriterPublicationResult, sourceId: string): Promise<void> {
  try {
    const stateDir = path.join(abrainHome, ".state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(path.join(stateDir, "git-sync.jsonl"), `${JSON.stringify({
      ...spreadAnchor(getCurrentAnchor()),
      ts: new Date().toISOString(),
      op: "writer_publication",
      result: publication.status,
      sourceId,
      commit: publication.commit,
      localCommit: publication.localCommit,
      drainStatus: publication.drainStatus,
      reason: publication.reason ?? null,
      episodeId: publication.episodeId ?? null,
      slot: publication.slot ?? null,
      candidate: publication.candidate ?? null,
      canonical: publication.canonical,
    })}\n`, "utf-8");
  } catch (error) {
    console.error(`[sediment-writer] publication audit append failed: ${pushTriggerErrorSummary(error)}`);
  }
}

function legacyPublication(commit: string | null): WriterPublicationResult {
  return commit
    ? { status: "local_durable", commit, localCommit: "index_converged", drainStatus: "legacy_commit", canonical: false }
    : { status: "terminal_before_publish", commit: null, localCommit: "not_published", drainStatus: "legacy_commit_failed", reason: "git_commit_failed", canonical: false };
}

function publicationNeedsCleanup(publication: WriterPublicationResult): boolean {
  return publication.canonical === false
    && publication.status === "terminal_before_publish"
    && publication.localCommit === "not_published";
}

async function assertCanonicalWriterSettings(
  abrainHome: string,
  settings: Pick<SedimentSettings, "gitCommit">,
): Promise<void> {
  // gitCommit:false is the established non-Git writer contract used by temp
  // fixtures and embedders. It bypasses the canonical Git gate completely.
  if (settings.gitCommit === false) return;
  // Enabled/default production writers validate the three-state settings gate
  // before mutation, then consume the shared Path A startup promise.
  if (!canonicalGitRuntimeEnabled()) return;
  const startup = await getCanonicalStartupPromise({ abrainHome: path.resolve(abrainHome) });
  if (startup.startup !== "ready") {
    throw new Error(`canonical startup barrier blocked: ${startup.blockedReason ?? "unknown"}`);
  }
}

export function writerPublicationFromCanonicalDrain(drained: DrainResult): WriterPublicationResult {
  if (drained.status === "empty") {
    return { status: "clean", commit: drained.commit ?? null, localCommit: drained.localCommit, drainStatus: drained.status, canonical: true };
  }
  if (drained.status === "metadata_deferred") {
    return { status: "clean", commit: null, localCommit: "not_published", drainStatus: drained.status, canonical: true };
  }
  if (drained.status !== "index_converged" || !drained.commit) {
    return {
      status: drained.status === "disabled" ? "terminal_before_publish" : "durable_pending",
      commit: drained.commit ?? null,
      localCommit: drained.localCommit,
      drainStatus: drained.status,
      reason: drained.reason ?? drained.status,
      ...(drained.episodeId ? { episodeId: drained.episodeId } : {}),
      ...(drained.slot !== undefined ? { slot: drained.slot } : {}),
      ...(drained.candidate ? { candidate: drained.candidate } : {}),
      canonical: true,
    };
  }
  return { status: "local_durable", commit: drained.commit, localCommit: "index_converged", drainStatus: drained.status, canonical: true };
}

async function canonicalCommitExplicitPaths(
  abrainHome: string,
  filePaths: readonly string[],
  message: string,
  sourceId: string,
): Promise<WriterPublicationResult> {
  let runtime: CanonicalGitRuntime;
  let drained: Awaited<ReturnType<CanonicalGitRuntime["requestDrain"]>>;
  try {
    const receipts: ProducedArtifact[] = [];
    for (const filePath of Array.from(new Set(filePaths.map((item) => path.resolve(item))))) {
      const rel = path.relative(path.resolve(abrainHome), filePath);
      if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${path.sep}`)) continue;
      receipts.push(await createProducedArtifactReceipt({ abrainHome, filePath, sourceIds: [sourceId] }));
    }
    if (receipts.length === 0) return { status: "clean", commit: null, localCommit: "not_published", drainStatus: "empty_receipt_cohort", canonical: true };
    runtime = await getCanonicalGitRuntime({ abrainHome });
    drained = await runtime.requestDrain(receipts, message);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    const recoverable = code === "INDEX_LOCK_PRESENT"
      || code === "OWNED_INDEX_CONFLICT"
      || code === "RECOVERY_PUBLISHED_REF_DIVERGED";
    const publication: WriterPublicationResult = {
      status: recoverable ? "durable_pending" : "terminal_before_publish",
      commit: null,
      localCommit: "not_published",
      drainStatus: recoverable ? "blocked" : "threw",
      reason: pushTriggerErrorSummary(error),
      canonical: true,
    };
    if (shouldAppendWriterPublicationAudit(publication)) await appendWriterPublicationAudit(abrainHome, publication, sourceId);
    return publication;
  }
  const publication = writerPublicationFromCanonicalDrain(drained);
  if (publication.status === "local_durable" && publication.commit) {
    // Device delivery is deliberately detached from canonical success. The
    // native git-sync audit owns delivery diagnostics and never changes this
    // local publication result.
    void maybePushAbrainAsync(abrainHome, publication.commit);
  }
  if (shouldAppendWriterPublicationAudit(publication)) await appendWriterPublicationAudit(abrainHome, publication, sourceId);
  return publication;
}

async function gitCommit(
  abrainHome: string,
  filePath: string,
  slug: string,
  op: string,
  projectId?: string,
  derivedFilePaths: string[] = [],
): Promise<WriterPublicationResult> {
  if (canonicalGitRuntimeEnabled()) {
    const scopeTag = projectId ? `project:${projectId}` : "world";
    return canonicalCommitExplicitPaths(
      abrainHome,
      [filePath, ...derivedFilePaths],
      `sediment: ${op} ${slug} (${scopeTag})`,
      `sediment:${op}:${scopeTag}:${slug}`,
    );
  }
  return legacyPublication(await gitSingleFlight(abrainHome, () =>
    gitCommitUnlocked(abrainHome, filePath, slug, op, projectId, derivedFilePaths)));
}

async function gitCommitUnlocked(
  abrainHome: string,
  filePath: string,
  slug: string,
  op: string,
  projectId?: string,
  derivedFilePaths: string[] = [],
): Promise<string | null> {
  return gitCommitManyUnlocked(abrainHome, [filePath], slug, op, projectId, derivedFilePaths);
}

function pushTriggerErrorSummary(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).trim().slice(0, 500) || "unknown";
}

async function appendPushTriggerFailureAudit(abrainHome: string, err: unknown): Promise<void> {
  try {
    const stateDir = path.join(abrainHome, ".state");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(
      path.join(stateDir, "git-sync.jsonl"),
      JSON.stringify({
        ts: new Date().toISOString(),
        op: "push",
        result: "trigger_failed",
        error: pushTriggerErrorSummary(err),
      }) + "\n",
      "utf-8",
    );
  } catch (auditErr) {
    console.error(`[sediment-writer] push trigger failure audit append failed: ${pushTriggerErrorSummary(auditErr)}`);
    // Audit failure must not block the sediment commit path.
  }
}

async function maybePushAbrainAsync(abrainHome: string, sha: string | null): Promise<void> {
  // After each successful sediment commit, trigger best-effort device delivery.
  // Push execution failures are audited by git-sync itself; trigger/load failures
  // are audited here so cross-device stalls remain visible.
  if (sha
    && process.env.PI_ABRAIN_NO_AUTOSYNC !== "1"
    && process.env.PI_ABRAIN_DISABLED !== "1") {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const gitSync = require("../abrain/git-sync");
      if (typeof gitSync.pushAsync !== "function") {
        await appendPushTriggerFailureAudit(abrainHome, new Error("git-sync pushAsync unavailable"));
        return;
      }
      gitSync.pushAsync({ abrainHome }).catch((err: unknown) => {
        void appendPushTriggerFailureAudit(abrainHome, err);
      });
    } catch (err) {
      await appendPushTriggerFailureAudit(abrainHome, err);
    }
  }
}

async function gitCommitMany(
  abrainHome: string,
  filePaths: string[],
  slug: string,
  op: string,
  projectId?: string,
  derivedFilePaths: string[] = [],
): Promise<WriterPublicationResult> {
  if (canonicalGitRuntimeEnabled()) {
    const scopeTag = projectId ? `project:${projectId}` : "world";
    return canonicalCommitExplicitPaths(
      abrainHome,
      [...filePaths, ...derivedFilePaths],
      `sediment: ${op} ${slug} (${scopeTag})`,
      `sediment:${op}:${scopeTag}:${slug}`,
    );
  }
  return legacyPublication(await gitSingleFlight(abrainHome, () =>
    gitCommitManyUnlocked(abrainHome, filePaths, slug, op, projectId, derivedFilePaths)));
}

async function gitCommitManyUnlocked(
  abrainHome: string,
  filePaths: string[],
  slug: string,
  op: string,
  projectId?: string,
  derivedFilePaths: string[] = [],
): Promise<string | null> {
  // Commits land in the abrain repo (cross-project knowledge substrate).
  const scopeTag = projectId ? `project:${projectId}` : "world";
  try {
    const rels = Array.from(new Set([...filePaths, ...derivedFilePaths]
      .map((filePath) => path.relative(abrainHome, filePath))
      .filter((rel) => rel && !rel.startsWith("..") && rel !== ".")));
    if (rels.length === 0) return null;
    // ADR0039 A1: stage the exact canonical/L1/L2 files produced by this
    // writer transaction. A directory pathspec (`git add -A -- l1 l2`) can
    // silently fold unrelated hand-edited derived files into a valid commit.
    await execFileAsync("git", ["-C", abrainHome, "add", "-A", "--", ...rels], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    await execFileAsync(
      "git",
      ["-C", abrainHome, "commit", "-m", `sediment: ${op} ${slug} (${scopeTag})`],
      { timeout: 30_000, maxBuffer: 1024 * 1024 },
    );
    const { stdout } = await execFileAsync("git", ["-C", abrainHome, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    const sha = stdout.trim() || null;
    await maybePushAbrainAsync(abrainHome, sha);
    return sha;
  } catch {
    return null;
  }
}

// ADR0039 Part A (T0 2026-06-24): the constraint pipeline writes l1/l2 outputs
// OUTSIDE a sediment create commit — the background auto-refresh 固化 completes
// AFTER the agent_end create that would have swept it, and a duplicate rule fires
// no create at all. Those dirty l1/l2 then stall the git-sync merge preflight
// (refuses on a dirty tree) and trip the B4 pre-push dirty-view block. This
// commits whatever is dirty under l1/l2 via the SAME single-flight + sweep +
// fire-and-forget push path as gitCommitMany, CONDITIONAL on change (unchanged
// compiler re-runs = zero churn / no empty commit) and NO-THROW (a failed commit
// must never crash the background compile).
export async function commitAbrainDerivedOutputs(
  abrainHome: string,
  reason: string,
  producedFilePaths: readonly string[] = [],
): Promise<WriterPublicationResult> {
  if (canonicalGitRuntimeEnabled()) {
    // This is the post-mutation barrier for constraint auto-refresh: the
    // explicit receipt drain awaits runtime startup before publishing. The
    // surrounding agent_end only writes ignored .state markers before this
    // projector path, so it does not need a second canonical worktree barrier.
    // Enabled runtime forbids status/directory harvesting. The projector must
    // name every output created by this transaction.
    if (producedFilePaths.length === 0) return { status: "terminal_before_publish", commit: null, localCommit: "not_published", drainStatus: "empty_projector_receipts", reason: "projector did not name outputs", canonical: true };
    return canonicalCommitExplicitPaths(
      abrainHome,
      producedFilePaths,
      `sediment: derived l1/l2 outputs (${reason})`,
      `constraint-projector:${reason}`,
    );
  }
  return legacyPublication(await gitSingleFlight(abrainHome, () => commitAbrainDerivedOutputsUnlocked(abrainHome, reason)));
}

async function commitAbrainDerivedOutputsUnlocked(abrainHome: string, reason: string): Promise<string | null> {
  const derivedRels = await changedDerivedRepoPaths(abrainHome);
  if (derivedRels.length === 0) return null;
  try {
    // This helper is the explicit constraint/derived-output drain. It has no
    // per-projector return value to thread, so it narrows the former directory
    // sweep to the exact dirty l1/l2 files reported by git status.
    await execFileAsync("git", ["-C", abrainHome, "add", "-A", "--", ...derivedRels], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    let hasStaged = true;
    try {
      await execFileAsync("git", ["-C", abrainHome, "diff", "--cached", "--quiet", "--", ...derivedRels], { timeout: 10_000, maxBuffer: 1024 * 1024 });
      hasStaged = false;
    } catch {
      hasStaged = true;
    }
    if (!hasStaged) return null;
    await execFileAsync("git", ["-C", abrainHome, "commit", "-m", `sediment: derived l1/l2 outputs (${reason})`], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", abrainHome, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    const sha = stdout.trim() || null;
    await maybePushAbrainAsync(abrainHome, sha);
    return sha;
  } catch {
    // Best-effort unstage so a failed commit never leaves a half-staged index a
    // later writer commit would accidentally fold in.
    try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", ...derivedRels], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort */ }
    return null;
  }
}

export async function appendAudit(projectRoot: string, event: Record<string, unknown>): Promise<string> {
  await ensureSedimentLegacyMigrated(projectRoot);
  // Round 9 P0 (sonnet R9-5 fix): ensure `.pi-astack/` is in the
  // project's .gitignore on first audit touch. audit.jsonl contains
  // LLM raw response, error messages, query text — anything that
  // could embed secrets echoed back from windowText. If the project
  // forgets to gitignore .pi-astack/, `git add .` stages this stream
  // and `git push` exfiltrates. Best-effort: failures (non-git repo,
  // permission, subdir vs toplevel) do not block audit.
  await ensureProjectGitignoredOnce(projectRoot);
  const auditPath = sedimentAuditPath(projectRoot);
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  // Schema v2 enrichment: every audit row carries the local-tz timestamp
  // plus standard execution context (PID, project root) so that ad-hoc
  // analysis on the JSONL doesn't need to cross-reference other sources.
  // Per-operation fields from `event` are spread last so callers can
  // override anything (rarely needed).
  //
  // ADR 0025 P0: callers SHOULD include `prompt_version` in their event
  // object (additive, backward-compatible — absent rows default to
  // "v0-unknown"). The field tracks which prompt produced the classifier
  // reasoning trace so aggregator health checks can attribute quality
  // changes to specific prompt versions.
  // ADR 0027 C6b: cross-layer causal anchor.
  //
  // P0-β fix (R1 review): lifecycle handlers (sediment / compaction-tuner
  // agent_end) wrap their body in `runWithTriggerAnchor(...)` so this
  // appendAudit — even when called from a fire-and-forget bg task that
  // completes AFTER the user submits the next prompt — sees the
  // trigger-time snapshot anchor, not the advanced live state.
  // getCurrentAnchor() consults AsyncLocalStorage first, then falls back
  // to live module state for sync callers outside any scope (e.g.,
  // tool-handler-triggered writes that complete within the calling turn).
  // Caller-provided session_id in event takes precedence (spread order:
  // anchor first, event last) so existing schema semantics survive.
  // turn_id is anchor-sourced (callers don't set it).
  const enriched = {
    timestamp: formatLocalIsoTimestamp(),
    ...spreadAnchor(getCurrentAnchor()),
    audit_version: AUDIT_SCHEMA_VERSION,
    pid: process.pid,
    project_root: path.resolve(projectRoot),
    ...event,
  };
  await fs.appendFile(auditPath, `${JSON.stringify(enriched)}\n`, "utf-8");
  return auditPath;
}

export async function mergeProjectEntries(
  targetSlugRaw: string,
  sourceSlugRaws: string[],
  patch: { compiledTruth: string; reason?: string; sessionId?: string; timelineNote?: string },
  opts: WriteProjectEntryOptions & { sourceExpectedStatus?: Record<string, EntryStatus> },
): Promise<WriteProjectEntryResult[]> {
  const targetSlug = slugify(targetSlugRaw);
  const sources = Array.from(new Set(sourceSlugRaws.map((slug) => slugify(slug)).filter(Boolean)));
  const nonTargetSources = sources.filter((slug) => slug !== targetSlug);
  const reason = patch.reason || patch.timelineNote || "merged by sediment curator";
  // P1 fix (2026-05-14 audit): thread opts.scope through so world-scoped
  // merge target resolution uses abrainKnowledgeDir instead of
  // abrainProjectDir.
  const targetResult = await updateProjectEntry(targetSlug, {
    compiledTruth: patch.compiledTruth,
    sessionId: patch.sessionId,
    timelineAction: "merged",
    timelineNote: reason,
    frontmatterPatch: nonTargetSources.length > 0 ? { derives_from: nonTargetSources } : undefined,
  }, {
    projectRoot: opts.projectRoot,
    abrainHome: opts.abrainHome,
    projectId: opts.projectId,
    scope: opts.scope,
    settings: opts.settings,
    dryRun: opts.dryRun,
    auditOperation: "merge",
    auditExtras: { sources, reason },
    auditContext: opts.auditContext,
  });

  const results: WriteProjectEntryResult[] = [
    { ...targetResult, status: targetResult.status === "dry_run" ? "dry_run" : targetResult.status === "rejected" ? "rejected" : "merged" },
  ];
  if (targetResult.status === "rejected") return results;
  for (const source of nonTargetSources) {
    results.push(await archiveProjectEntry(source, {
      projectRoot: opts.projectRoot,
      abrainHome: opts.abrainHome,
      projectId: opts.projectId,
      scope: opts.scope,
      settings: opts.settings,
      dryRun: opts.dryRun,
      reason: `merged into ${targetSlug}: ${reason}`,
      // ADR 0031 CAS parity: archive the merge source only if it is still
      // in the status the curator observed — abort instead of silently
      // clobbering a concurrent reactivation/status change.
      expected_status: opts.sourceExpectedStatus?.[source],
      sessionId: patch.sessionId,
      auditContext: opts.auditContext,
    }));
  }
  return results;
}

export async function archiveProjectEntry(
  slugRaw: string,
  opts: WriteProjectEntryOptions & { reason?: string; sessionId?: string; expected_status?: EntryStatus },
): Promise<WriteProjectEntryResult> {
  const reason = opts.reason || "archived by sediment curator";
  const result = await updateProjectEntry(slugRaw, {
    status: "archived",
    // ADR 0031 P1-1: CAS —— 仅当当前 status 仍为 expected(executor 传 "active")才归档,
    // 防把用户刚复活的条目再打回 archived(侵蚀 §2.1 复活安全网)。
    ...(opts.expected_status ? { expected_status: opts.expected_status } : {}),
    sessionId: opts.sessionId,
    timelineAction: "archived",
    timelineNote: reason,
  }, {
    projectRoot: opts.projectRoot,
    abrainHome: opts.abrainHome,
    projectId: opts.projectId,
    scope: opts.scope,
    settings: opts.settings,
    dryRun: opts.dryRun,
    auditOperation: "archive",
    auditExtras: { reason },
    auditContext: opts.auditContext,
  });
  return { ...result, status: result.status === "dry_run" ? "dry_run" : result.status === "rejected" ? "rejected" : "archived" };
}

export async function supersedeProjectEntry(
  slugRaw: string,
  opts: WriteProjectEntryOptions & { reason?: string; newSlug?: string; sessionId?: string },
): Promise<WriteProjectEntryResult> {
  const reason = opts.reason || "superseded by sediment curator";
  const note = opts.newSlug ? `superseded by ${opts.newSlug}: ${reason}` : reason;
  const result = await updateProjectEntry(slugRaw, {
    status: "superseded",
    sessionId: opts.sessionId,
    timelineAction: "superseded",
    timelineNote: note,
    frontmatterPatch: opts.newSlug ? { superseded_by: [opts.newSlug] } : undefined,
  }, {
    projectRoot: opts.projectRoot,
    abrainHome: opts.abrainHome,
    projectId: opts.projectId,
    scope: opts.scope,
    settings: opts.settings,
    dryRun: opts.dryRun,
    auditOperation: "supersede",
    auditExtras: { reason, ...(opts.newSlug ? { new_slug: opts.newSlug } : {}) },
    auditContext: opts.auditContext,
  });
  return { ...result, status: result.status === "dry_run" ? "dry_run" : result.status === "rejected" ? "rejected" : "superseded" };
}

export async function deleteProjectEntry(
  slugRaw: string,
  // `expected_status` is the CAS precondition (same semantics as
  // ProjectEntryUpdateDraft.expected_status): when set, the delete is
  // rejected (status_precondition_failed) unless the entry's current on-disk
  // status matches. Honored for BOTH soft (→ updateProjectEntry) and hard
  // (in-lock check before unlink) modes, so hard_archive can do an atomic
  // "git rm only when still archived".
  opts: WriteProjectEntryOptions & { reason?: string; mode?: DeleteMode; sessionId?: string; expected_status?: EntryStatus },
): Promise<WriteProjectEntryResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const abrainHome = path.resolve(opts.abrainHome);
  const scope = opts.scope ?? "project";
  // P1 fix (2026-05-14 audit): thread scope through entry root resolution.
  // World-scoped entries live flat under abrainHome/knowledge/, not under
  // abrainHome/projects/<projectId>/. Without this, world-scope delete
  // always returns entry_not_found.
  const entryRoot = scope === "world"
    ? abrainKnowledgeDir(abrainHome)
    : await ensureAbrainEntryRoot(abrainHome, opts.projectId);
  const auditRoot = scope === "world" ? abrainHome : projectRoot;
  const targetPrefix = scope === "world" ? "world" : `project:${opts.projectId}`;
  const slug = slugify(slugRaw);
  // Autonomous curator output is soft-only (curator.ts downgrades hard to soft).
  // The hard branch below is retained for explicit non-autonomous callers such
  // as CAS/maintenance tests and future reviewed archive-reclamation tools.
  const mode: DeleteMode = opts.mode === "hard" ? "hard" : "soft";
  const reason = opts.reason || "deleted by sediment curator";
  const resultCtx = resultAuditFields(opts, opts.sessionId);

  const resolvedTarget = await findKnowledgeMutationReadFile({ abrainHome, projectId: opts.projectId, entryRoot, settings: opts.settings, scope, slug });
  const target = resolvedTarget?.path;
  if (!target) {
    const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
      operation: "reject",
      reason: "entry_not_found",
      target: `${targetPrefix}:${slug}`,
      delete_mode: mode,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: path.join(entryRoot, `${slug}.md`), status: "rejected", reason: "entry_not_found", auditPath, deleteMode: mode, ...resultCtx };
  }

  if (mode === "soft") {
    const result = await updateProjectEntry(slug, {
      status: "archived",
      expected_status: opts.expected_status,
      sessionId: opts.sessionId,
      timelineAction: "deleted",
      timelineNote: `soft delete: ${reason}`,
    }, {
      projectRoot,
      abrainHome: opts.abrainHome,
      projectId: opts.projectId,
      scope: opts.scope,
      settings: opts.settings,
      dryRun: opts.dryRun,
      auditOperation: "delete",
      auditExtras: { delete_mode: "soft", reason },
      auditContext: opts.auditContext,
    });
    return { ...result, status: result.status === "dry_run" ? "dry_run" : result.status === "rejected" ? "rejected" : "deleted", deleteMode: "soft" };
  }

  if (opts.dryRun) {
    return { slug, path: target, status: "dry_run", deleteMode: "hard", ...resultCtx };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(abrainHome, opts.settings.lockTimeoutMs);
    const recoveredRename = await recoverRenameTransactionIfNeeded(abrainHome);
    if (recoveredRename.didRollback) {
      const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
        operation: "reject",
        reason: "rename_transaction_rolled_back",
        target: `${targetPrefix}:${slug}`,
        delete_mode: "hard",
        rollback: recoveredRename,
        duration_ms: Date.now() - started,
      }));
      return { slug, path: target, status: "rejected", reason: "rename_transaction_rolled_back", auditPath, deleteMode: "hard", ...resultCtx };
    }
    const lockedTarget = await findKnowledgeMutationReadFile({ abrainHome, projectId: opts.projectId, entryRoot, settings: opts.settings, scope, slug });
    if (!lockedTarget) {
      const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
        operation: "reject",
        reason: "entry_not_found",
        target: `${targetPrefix}:${slug}`,
        delete_mode: "hard",
        duration_ms: Date.now() - started,
      }));
      return { slug, path: target, status: "rejected", reason: "entry_not_found", auditPath, deleteMode: "hard", ...resultCtx };
    }
    const lockedPath = lockedTarget.path;
    const originalRaw = await fs.readFile(lockedPath, "utf-8");
    const originalProjectionManifestPath = lockedTarget.source === "stable_view"
      ? path.join(knowledgeProjectionRoot(abrainHome, opts.settings), "latest", "manifest.json")
      : undefined;
    const originalProjectionManifestRaw = originalProjectionManifestPath
      ? await fs.readFile(originalProjectionManifestPath, "utf-8").catch(() => null)
      : undefined;
    if (lockedTarget.source === "stable_view") {
      const watermarkCas = await checkKnowledgeStableViewWatermarkCas({ abrainHome, projectId: opts.projectId, scope, slug, raw: originalRaw });
      if (!watermarkCas.ok) {
        const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
          operation: "reject",
          reason: "stale_projection",
          stale_projection_detail: watermarkCas.detail,
          target: `${targetPrefix}:${slug}`,
          path: path.relative(auditRoot, lockedPath),
          delete_mode: "hard",
          stable_view_watermark_cas: watermarkCas,
          duration_ms: Date.now() - started,
        }));
        return { slug, path: lockedPath, status: "rejected", reason: "stale_projection", auditPath, deleteMode: "hard", ...resultCtx };
      }
    }
    // CAS / expected-status guard (ADR 0027 C3'): the read of originalRaw and
    // the unlink below are both inside the sediment lock, so comparing the
    // freshly-read on-disk status to opts.expected_status is a true
    // compare-and-swap. Stable-view reads prove their watermark first, so a
    // stale or tampered L2 projection cannot drive this frontmatter check.
    // Opt-in: undefined expected_status skips the check (backward-compatible).
    if (opts.expected_status !== undefined) {
      const actualStatusRaw = parseFrontmatter(splitFrontmatter(originalRaw).frontmatterText).status;
      const actualStatus = typeof actualStatusRaw === "string" ? actualStatusRaw : null;
      if (actualStatus !== opts.expected_status) {
        const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
          operation: "reject",
          reason: "status_precondition_failed",
          target: `${targetPrefix}:${slug}`,
          delete_mode: "hard",
          detail: `expected status '${opts.expected_status}', found '${actualStatus ?? "(none)"}'`,
          duration_ms: Date.now() - started,
        }));
        return { slug, path: lockedPath, status: "rejected", reason: "status_precondition_failed", auditPath, deleteMode: "hard", ...resultCtx };
      }
    }
    const baseResult: WriteProjectEntryResult = { slug, path: lockedPath, status: "deleted", gitCommit: null, deleteMode: "hard", ...resultCtx };
    let knowledgeEvidenceEvent: AppendKnowledgeEvidenceForWriteResult | undefined;
    if (isKnowledgeEvidenceEventFirst(opts.settings)) {
      knowledgeEvidenceEvent = await appendKnowledgeEvidenceForMarkdown({
        abrainHome,
        projectId: opts.projectId,
        scope,
        raw: originalRaw,
        fallbackSlug: slug,
        result: baseResult,
        settings: opts.settings,
        auditContext: opts.auditContext,
        patch: { sessionId: opts.sessionId, timelineNote: reason },
        operation: "delete",
      });
      if (shouldBlockKnowledgeLegacyWrite(opts.settings, knowledgeEvidenceEvent)) {
        const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
          operation: "reject",
          reason: "knowledge_evidence_append_failed",
          target: `${targetPrefix}:${slug}`,
          path: path.relative(auditRoot, lockedPath),
          delete_mode: "hard",
          knowledge_evidence_event: knowledgeEvidenceEvent ? summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) : null,
          duration_ms: Date.now() - started,
        }));
        return { slug, path: lockedPath, status: "rejected", reason: "knowledge_evidence_append_failed", gitCommit: null, auditPath, deleteMode: "hard", ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}), ...resultCtx };
      }
    }
    const legacyMarkdownSkipped = shouldSkipKnowledgeLegacyMarkdownAfterEvent(opts.settings, knowledgeEvidenceEvent);
    if (lockedTarget.source === "stable_view" && !legacyMarkdownSkipped) {
      const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
        operation: "reject",
        reason: "knowledge_evidence_append_failed",
        target: `${targetPrefix}:${slug}`,
        path: path.relative(auditRoot, lockedPath),
        delete_mode: "hard",
        knowledge_evidence_event: knowledgeEvidenceEvent ? summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) : null,
        duration_ms: Date.now() - started,
      }));
      return { slug, path: lockedPath, status: "rejected", reason: "knowledge_evidence_append_failed", gitCommit: null, auditPath, deleteMode: "hard", ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}), ...resultCtx };
    }
    if (!legacyMarkdownSkipped) await fs.unlink(lockedPath);
    const gitCommitProjectId = scope === "world" ? undefined : opts.projectId;
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? legacyMarkdownSkipped
        ? await gitCommitMany(abrainHome, [], slug, "delete", gitCommitProjectId, knowledgeEvidenceWrittenPaths(knowledgeEvidenceEvent))
        : await gitCommit(abrainHome, lockedPath, slug, "delete", gitCommitProjectId, knowledgeEvidenceWrittenPaths(knowledgeEvidenceEvent))
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    // P0 fix (2026-05-14 audit round 6): if gitCommit() returns null
    // (git add succeeded but git commit failed), reset the index to
    // prevent the staged deletion from being committed alongside a
    // later successful write — same ghost-file class bug as b40df1e.
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      let knowledgeEvidenceCompensationEvent: AppendKnowledgeEvidenceForWriteResult | undefined;
      let knowledgeEvidenceCompensationGitCommit: string | null | undefined;
      let restoreMode = legacyMarkdownSkipped
        ? "projection_only_compensation_not_attempted"
        : isKnowledgeEvidenceEventFirst(opts.settings) ? "restored_original_and_projected_compensation" : "legacy_restored";
      if (legacyMarkdownSkipped) {
        const resetL1L2Index = async () => {
          await resetKnowledgeEvidenceIndex(abrainHome, knowledgeEvidenceEvent);
        };
        const restoreProjectionPreimage = async () => {
          try { await atomicWrite(lockedPath, originalRaw); } catch { /* best-effort fail-safe restore */ }
          if (originalProjectionManifestPath) {
            try {
              if (originalProjectionManifestRaw === null) await fs.rm(originalProjectionManifestPath, { force: true });
              else if (typeof originalProjectionManifestRaw === "string") await atomicWrite(originalProjectionManifestPath, originalProjectionManifestRaw);
            } catch { /* best-effort fail-safe restore */ }
          }
        };
        const removeUncommittedEventFile = async (event: AppendKnowledgeEvidenceForWriteResult | undefined) => {
          if (event?.append.status !== "appended") return;
          const filePath = event.append.filePath
            ?? (event.append.eventId ? path.join(abrainHome, knowledgeEvidenceEventRelativePath(event.append.eventId)) : undefined);
          if (!filePath) return;
          try { await fs.rm(filePath, { force: true }); } catch { /* best-effort cleanup */ }
        };

        await resetL1L2Index();
        knowledgeEvidenceCompensationEvent = isKnowledgeEvidenceEventFirst(opts.settings) && knowledgeEvidenceEvent?.append.ok
          ? await appendKnowledgeEvidenceForMarkdown({
              abrainHome,
              projectId: opts.projectId,
              scope,
              raw: originalRaw,
              fallbackSlug: slug,
              result: { slug, path: lockedPath, status: "updated", gitCommit: null, ...resultCtx },
              settings: opts.settings,
              auditContext: opts.auditContext,
              patch: { sessionId: opts.sessionId, timelineNote: "restore after delete git commit failure" },
              operation: "update",
              causalParents: knowledgeEvidenceEvent.append.eventId ? [knowledgeEvidenceEvent.append.eventId] : undefined,
            })
          : undefined;
        const compensationAppendRestoredProjection = knowledgeEvidenceCompensationEvent?.append.ok === true
          && knowledgeEvidenceCompensationEvent.projection?.status === "projected";
        if (compensationAppendRestoredProjection) {
          knowledgeEvidenceCompensationGitCommit = (await gitCommitMany(abrainHome, [], slug, "restore_after_delete_git_failure", gitCommitProjectId, knowledgeEvidenceWrittenPaths(knowledgeEvidenceEvent, knowledgeEvidenceCompensationEvent))).commit;
        }
        if (compensationAppendRestoredProjection && knowledgeEvidenceCompensationGitCommit) {
          restoreMode = "projection_only_compensation_committed";
        } else {
          restoreMode = compensationAppendRestoredProjection
            ? "fallback_restore_after_compensation_commit_failed"
            : "fallback_restore_after_compensation_append_failed";
          await resetL1L2Index();
          await restoreProjectionPreimage();
          await removeUncommittedEventFile(knowledgeEvidenceEvent);
          await removeUncommittedEventFile(knowledgeEvidenceCompensationEvent);
          await resetL1L2Index();
        }
      } else {
        try {
          const rel = path.relative(abrainHome, lockedPath);
          // async reset (parity with all other rollback paths): never block the
          // event loop on git while holding the sediment lock.
          await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 });
        } catch { /* best-effort */ }
        try {
          await atomicWrite(lockedPath, originalRaw);
        } catch { /* best-effort rollback */ }
        knowledgeEvidenceCompensationEvent = isKnowledgeEvidenceEventFirst(opts.settings) && knowledgeEvidenceEvent?.append.ok
          ? await appendKnowledgeEvidenceForMarkdown({
              abrainHome,
              projectId: opts.projectId,
              scope,
              raw: originalRaw,
              fallbackSlug: slug,
              result: { slug, path: lockedPath, status: "updated", gitCommit: null, ...resultCtx },
              settings: opts.settings,
              auditContext: opts.auditContext,
              patch: { sessionId: opts.sessionId, timelineNote: "restore after delete git commit failure" },
              operation: "update",
            })
          : undefined;
      }
      const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
        operation: "reject",
        reason: "git_commit_failed",
        target: `${targetPrefix}:${slug}`,
        path: path.relative(auditRoot, lockedPath),
        delete_mode: "hard",
        event_first_legacy_compensation: restoreMode,
        ...(knowledgeEvidenceEvent ? { knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) } : {}),
        ...(knowledgeEvidenceCompensationEvent ? { knowledge_evidence_compensation_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceCompensationEvent) } : {}),
        ...(legacyMarkdownSkipped ? { knowledge_evidence_compensation_git_commit: knowledgeEvidenceCompensationGitCommit ?? null } : {}),
        ...(legacyMarkdownSkipped ? { legacy_markdown_write: legacyMarkdownSkippedAudit(knowledgeEvidenceEvent) } : {}),
        duration_ms: Date.now() - started,
      }));
      return { slug, path: lockedPath, status: "rejected", reason: "git_commit_failed", gitCommit: git, publication, auditPath, deleteMode: "hard", ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}), ...resultCtx };
    }
    const result: WriteProjectEntryResult = { ...baseResult, gitCommit: git, publication };
    if (opts.settings.knowledgeEvidenceEventWriter.enabled === true && !isKnowledgeEvidenceEventFirst(opts.settings)) {
      knowledgeEvidenceEvent = await appendKnowledgeEvidenceForMarkdown({
        abrainHome,
        projectId: opts.projectId,
        scope,
        raw: originalRaw,
        fallbackSlug: slug,
        result,
        settings: opts.settings,
        auditContext: opts.auditContext,
        patch: { sessionId: opts.sessionId, timelineNote: reason },
        operation: "delete",
      });
    }
    const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
      operation: "delete",
      target: `${targetPrefix}:${slug}`,
      path: path.relative(auditRoot, lockedPath),
      delete_mode: "hard",
      reason,
      git_commit: git,
      ...(knowledgeEvidenceEvent ? { knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) } : {}),
      ...(legacyMarkdownSkipped ? { legacy_markdown_write: legacyMarkdownSkippedAudit(knowledgeEvidenceEvent) } : {}),
      duration_ms: Date.now() - started,
    }));
    return { ...result, auditPath, ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}) };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAudit(auditRoot, withWriterAuditContext(opts, opts.sessionId, {
      operation: "error",
      target: `${targetPrefix}:${slug}`,
      delete_mode: "hard",
      reason: message,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: message, auditPath, deleteMode: "hard", ...resultCtx };
  } finally {
    await lock?.release();
  }
}

export async function updateProjectEntry(
  slugRaw: string,
  patch: ProjectEntryUpdateDraft,
  opts: WriteProjectEntryOptions,
): Promise<WriteProjectEntryResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const abrainHome = path.resolve(opts.abrainHome);
  const scope = opts.scope ?? "project";
  const entryRoot = scope === "world"
    ? await fs.mkdir(abrainKnowledgeDir(abrainHome), { recursive: true }).then(() => abrainKnowledgeDir(abrainHome))
    : await ensureAbrainEntryRoot(abrainHome, opts.projectId);
  const auditRoot = scope === "world" ? abrainHome : projectRoot;
  const targetPrefix = scope === "world" ? `world` : `project:${opts.projectId}`;
  const slug = slugify(slugRaw);
  const resultCtx = resultAuditFields(opts, patch.sessionId);
  const doAudit = (event: Record<string, unknown>) =>
    scope === "world"
      ? appendAbrainAudit(abrainHome, (typeof event.lane === "string" ? event.lane : undefined) ?? "auto_write", event)
      : appendAudit(projectRoot, event);

  // Round 8 P0 (gpt-5.5 audit fix): the full read-modify-write (find target +
  // readFile + merge + lint + write) MUST happen inside the sediment lock.
  // Previously read/merge/lint happened lock-OUTSIDE and only atomicWrite
  // was lock-INSIDE — a textbook lost-update race:
  //
  //   Process A: read raw → prepare merged markdown → (no lock yet)
  //   Process B: acquire lock → deleteProjectEntry hard delete: unlink(target)
  //              → audit row says deleted → release lock
  //   Process A: acquire lock → atomicWrite(target, merged) → entry RESURRECTED
  //
  // Same race applies for concurrent update overlaps (older raw overwrites
  // newer state) and for archive/supersede vs update (older active-status
  // snapshot overwrites the post-archive state).
  //
  // The dry-run path stays lock-OUTSIDE (read-only preview; tolerating a
  // brief race window here is acceptable because no disk mutation happens).
  // The real RMW path is wrapped end-to-end in the lock and re-does the
  // find+read+merge+lint after acquireLock so any concurrent unlink /
  // atomicWrite is observed.

  // Helper: prepare merged markdown + lint, returning either ok result or
  // a rejected response. Used by both dry-run preview and locked RMW path.
  async function prepareMergedMarkdown(): Promise<
    | { ok: true; target: string; source: "stable_view" | "legacy"; originalRaw: string; merged: { markdown: string; sanitizedReplacements: string[] }; lintErrors: number; lintWarnings: number }
    | { ok: false; response: WriteProjectEntryResult }
  > {
    const resolvedTarget = await findKnowledgeMutationReadFile({ abrainHome, projectId: opts.projectId, entryRoot, settings: opts.settings, scope, slug });
    const target = resolvedTarget?.path;
    if (!target) {
      const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
        operation: "reject",
        reason: "entry_not_found",
        target: `${targetPrefix}:${slug}`,
        duration_ms: Date.now() - started,
      }));
      return { ok: false, response: { slug, path: path.join(entryRoot, `${slug}.md`), status: "rejected", reason: "entry_not_found", auditPath, ...resultCtx } };
    }
    let raw: string;
    try {
      raw = await fs.readFile(target, "utf-8");
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
        operation: "reject",
        reason: `read_error: ${message}`,
        target: `${targetPrefix}:${slug}`,
        duration_ms: Date.now() - started,
      }));
      return { ok: false, response: { slug, path: target, status: "rejected", reason: `read_error: ${message}`, auditPath, ...resultCtx } };
    }
    if (resolvedTarget.source === "stable_view") {
      const watermarkCas = await checkKnowledgeStableViewWatermarkCas({ abrainHome, projectId: opts.projectId, scope, slug, raw });
      if (!watermarkCas.ok) {
        const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
          operation: "reject",
          reason: "stale_projection",
          stale_projection_detail: watermarkCas.detail,
          target: `${targetPrefix}:${slug}`,
          path: path.relative(auditRoot, target),
          stable_view_watermark_cas: watermarkCas,
          duration_ms: Date.now() - started,
          ...(opts.auditExtras ?? {}),
        }));
        return { ok: false, response: { slug, path: target, status: "rejected", reason: "stale_projection", auditPath, ...resultCtx } };
      }
    }
    // CAS / expected-status guard (ADR 0027 C3' infra). Opt-in: only runs when
    // a caller sets patch.expected_status. On the real RMW path this read of
    // `raw` happens INSIDE the sediment lock (prepareMergedMarkdown is
    // re-invoked post-acquireLock), so comparing the freshly-read on-disk
    // status to the caller's expectation is a true compare-and-swap against
    // concurrent archive / reactivate / update / delete. Mismatch → reject
    // (terminal, see index.ts shouldAdvanceAfterResults) instead of
    // clobbering newer state with a stale-status transition.
    if (patch.expected_status !== undefined) {
      const actualStatusRaw = parseFrontmatter(splitFrontmatter(raw).frontmatterText).status;
      const actualStatus = typeof actualStatusRaw === "string" ? actualStatusRaw : null;
      if (actualStatus !== patch.expected_status) {
        const reason = "status_precondition_failed";
        const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
          operation: "reject",
          reason,
          target: `${targetPrefix}:${slug}`,
          detail: `expected status '${patch.expected_status}', found '${actualStatus ?? "(none)"}'`,
          duration_ms: Date.now() - started,
        }));
        return { ok: false, response: { slug, path: target, status: "rejected", reason, auditPath, ...resultCtx } };
      }
    }
    const requestedNewSlugForMerge = patch.newSlug ? slugify(patch.newSlug) : "";
    const mergePatch = requestedNewSlugForMerge && requestedNewSlugForMerge !== slug
      ? { ...patch, timelineAction: patch.timelineAction || "renamed", timelineNote: patch.timelineNote || `${slug} → ${requestedNewSlugForMerge}` }
      : patch;
    const merged = mergeUpdateMarkdown(raw, mergePatch, slug, opts.projectId, { scope });
    if ("error" in merged) {
      const reason = merged.error.startsWith("credential pattern detected") ? merged.error : merged.error.split(":")[0];
      const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
        operation: "reject",
        reason,
        target: `${targetPrefix}:${slug}`,
        detail: merged.error,
        duration_ms: Date.now() - started,
      }));
      return { ok: false, response: { slug, path: target, status: "rejected", reason, auditPath, ...resultCtx } };
    }
    const lint = lintMarkdown(merged.markdown, target);
    const lintErrors = lint.filter((issue) => issue.severity === "error").length;
    const lintWarnings = lint.filter((issue) => issue.severity === "warning").length;
    if (lintErrors > 0) {
      const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
        operation: "reject",
        reason: "lint_error",
        target: `${targetPrefix}:${slug}`,
        lintErrors,
        lintWarnings,
        duration_ms: Date.now() - started,
      }));
      return { ok: false, response: { slug, path: target, status: "rejected", reason: "lint_error", lintErrors, lintWarnings, auditPath, ...resultCtx } };
    }
    return { ok: true, target, source: resolvedTarget.source, originalRaw: raw, merged, lintErrors, lintWarnings };
  }

  // Dry-run path: lock-outside preview. Stale reads are acceptable here
  // because no disk mutation happens; callers requesting dry_run already
  // accept best-effort semantics.
  if (opts.dryRun) {
    const preview = await prepareMergedMarkdown();
    if (!preview.ok) return preview.response;
    return {
      slug,
      path: preview.target,
      status: "dry_run",
      lintErrors: preview.lintErrors,
      lintWarnings: preview.lintWarnings,
      sanitizedReplacements: preview.merged.sanitizedReplacements,
      ...resultCtx,
    };
  }

  let lock: LockHandle | undefined;
  let target = "";
  let lintErrors = 0;
  let lintWarnings = 0;
  try {
    lock = await acquireLock(abrainHome, opts.settings.lockTimeoutMs);
    const recoveredRename = await recoverRenameTransactionIfNeeded(abrainHome);
    if (recoveredRename.didRollback) {
      const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
        operation: "reject",
        reason: "rename_transaction_rolled_back",
        target: `${targetPrefix}:${slug}`,
        rollback: recoveredRename,
        duration_ms: Date.now() - started,
        ...(opts.auditExtras ?? {}),
      }));
      return { slug, path: path.join(entryRoot, `${slug}.md`), status: "rejected", reason: "rename_transaction_rolled_back", auditPath, ...resultCtx };
    }
    // Re-do the find+read+merge+lint cycle INSIDE the lock to observe any
    // concurrent state changes (hard delete, prior atomic write).
    const prepared = await prepareMergedMarkdown();
    if (!prepared.ok) return prepared.response;
    target = prepared.target;
    lintErrors = prepared.lintErrors;
    lintWarnings = prepared.lintWarnings;
    const merged = prepared.merged;
    const operation = opts.auditOperation || "update";
    const gitCommitProjectId = scope === "world" ? undefined : opts.projectId;
    const requestedNewSlug = patch.newSlug ? slugify(patch.newSlug) : "";
    if (requestedNewSlug && requestedNewSlug !== slug) {
      if (scope !== "project") {
        const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
          operation: "reject",
          reason: "rename_world_unsupported",
          target: `${targetPrefix}:${slug}`,
          new_slug: requestedNewSlug,
          duration_ms: Date.now() - started,
          ...(opts.auditExtras ?? {}),
        }));
        return { slug, path: target, status: "rejected", reason: "rename_world_unsupported", lintErrors, lintWarnings, auditPath, sanitizedReplacements: merged.sanitizedReplacements, ...resultCtx };
      }
      if (knowledgeLegacyMarkdownWriteDisabled(opts.settings)) {
        const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
          operation: "reject",
          reason: "legacy_markdown_rename_disabled",
          target: `${targetPrefix}:${slug}`,
          new_slug: requestedNewSlug,
          duration_ms: Date.now() - started,
          ...(opts.auditExtras ?? {}),
        }));
        return { slug, path: target, status: "rejected", reason: "legacy_markdown_rename_disabled", lintErrors, lintWarnings, auditPath, sanitizedReplacements: merged.sanitizedReplacements, ...resultCtx };
      }
      const renamePlan = await buildRenameApplyPlan({
        abrainHome,
        entryRoot,
        targetPath: target,
        originalRaw: prepared.originalRaw,
        mergedMarkdown: merged.markdown,
        oldSlug: slug,
        newSlugRaw: requestedNewSlug,
        projectId: opts.projectId,
      });
      if (!renamePlan.ok) {
        const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
          operation: "reject",
          reason: renamePlan.reason,
          target: `${targetPrefix}:${slug}`,
          new_slug: requestedNewSlug,
          detail: renamePlan.detail,
          duration_ms: Date.now() - started,
          ...(opts.auditExtras ?? {}),
        }));
        return { slug, path: target, status: "rejected", reason: renamePlan.reason, lintErrors, lintWarnings, auditPath, sanitizedReplacements: merged.sanitizedReplacements, ...resultCtx };
      }
      let vectorRename: ReturnType<typeof renameSlugInVectorIndexFile> | undefined;
      let knowledgeEvidenceEvent: AppendKnowledgeEvidenceForWriteResult | undefined;
      const vectorIndexFile = path.join(abrainStateDir(abrainHome), "memory", "embeddings.json");
      const renameEventResult: WriteProjectEntryResult = { slug: requestedNewSlug, path: renamePlan.plan.entryNewPath, status: "updated", lintErrors, lintWarnings, gitCommit: null, sanitizedReplacements: merged.sanitizedReplacements, ...resultCtx };
      let applied: Awaited<ReturnType<typeof applyRenamePlan>>;
      let renamePublication: WriterPublicationResult | undefined;
      try {
        applied = await applyRenamePlan(renamePlan.plan, {
          abrainHome,
          onVectorRename: () => {
            vectorRename = renameSlugInVectorIndexFile(slug, requestedNewSlug, `project:${opts.projectId}`, vectorIndexFile);
            if (!vectorRename.ok && (vectorRename.reason === "scope_mismatch" || vectorRename.reason === "new_exists")) {
              throw new Error(`vector_rename_failed:${vectorRename.reason}`);
            }
          },
          onVectorRollback: () => {
            rollbackRenameSlugInVectorIndexFile(slug, requestedNewSlug, `project:${opts.projectId}`, vectorIndexFile);
          },
          onBeforeCommit: isKnowledgeEvidenceEventFirst(opts.settings)
            ? async () => {
                knowledgeEvidenceEvent = await appendKnowledgeEvidenceForMarkdown({
                  abrainHome,
                  projectId: opts.projectId,
                  scope,
                  raw: renamePlan.plan.entryNewContent,
                  fallbackSlug: requestedNewSlug,
                  result: renameEventResult,
                  settings: opts.settings,
                  auditContext: opts.auditContext,
                  patch,
                  operation: "update",
                });
                if (shouldBlockKnowledgeLegacyWrite(opts.settings, knowledgeEvidenceEvent)) throw new Error("knowledge_evidence_append_failed");
              }
            : undefined,
          onCommit: opts.settings.gitCommit
            ? async (paths) => {
                renamePublication = await gitCommitMany(abrainHome, paths, requestedNewSlug, "rename", opts.projectId, knowledgeEvidenceWrittenPaths(knowledgeEvidenceEvent));
                return renamePublication.commit;
              }
            : undefined,
        });
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        const knowledgeEvidenceCompensationEvent = isKnowledgeEvidenceEventFirst(opts.settings) && knowledgeEvidenceEvent?.append.ok
          ? await appendKnowledgeEvidenceForMarkdown({
              abrainHome,
              projectId: opts.projectId,
              scope,
              raw: prepared.originalRaw,
              fallbackSlug: slug,
              result: { slug, path: target, status: "updated", gitCommit: null, lintErrors, lintWarnings, sanitizedReplacements: merged.sanitizedReplacements, ...resultCtx },
              settings: opts.settings,
              auditContext: opts.auditContext,
              patch: { ...patch, newSlug: undefined, timelineNote: "restore after rename failure" },
              operation: "update",
            })
          : undefined;
        const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
          operation: "reject",
          reason,
          target: `${targetPrefix}:${slug}`,
          new_slug: requestedNewSlug,
          path: path.relative(auditRoot, target),
          event_first_legacy_compensation: knowledgeEvidenceCompensationEvent ? "restored_original_projection" : undefined,
          ...(knowledgeEvidenceEvent ? { knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) } : {}),
          ...(knowledgeEvidenceCompensationEvent ? { knowledge_evidence_compensation_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceCompensationEvent) } : {}),
          duration_ms: Date.now() - started,
          ...(opts.auditExtras ?? {}),
        }));
        return { slug, path: target, status: "rejected", reason, lintErrors, lintWarnings, ...(renamePublication ? { publication: renamePublication } : {}), auditPath, sanitizedReplacements: merged.sanitizedReplacements, ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}), ...resultCtx };
      }
      const renameResult: WriteProjectEntryResult = { ...renameEventResult, gitCommit: applied.gitCommit ?? null, ...(renamePublication ? { publication: renamePublication } : {}) };
      if (opts.settings.knowledgeEvidenceEventWriter.enabled === true && !isKnowledgeEvidenceEventFirst(opts.settings)) {
        knowledgeEvidenceEvent = await appendKnowledgeEvidenceForMarkdown({
          abrainHome,
          projectId: opts.projectId,
          scope,
          raw: renamePlan.plan.entryNewContent,
          fallbackSlug: requestedNewSlug,
          result: renameResult,
          settings: opts.settings,
          auditContext: opts.auditContext,
          patch,
          operation: "update",
        });
      }
      const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
        operation: "rename",
        target: `${targetPrefix}:${requestedNewSlug}`,
        old_slug: slug,
        new_slug: requestedNewSlug,
        path: path.relative(auditRoot, renamePlan.plan.entryNewPath),
        rewritten_refs: renamePlan.issueCount,
        vector_rename: vectorRename ?? { ok: false, reason: "not_attempted" },
        lint_result: "pass",
        git_commit: applied.gitCommit ?? null,
        ...(knowledgeEvidenceEvent ? { knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) } : {}),
        duration_ms: Date.now() - started,
        ...(opts.auditExtras ?? {}),
      }));
      return { ...renameResult, auditPath, ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}) };
    }
    const eventOperation = operation === "delete" && patch.status === "archived" ? "archive"
      : operation === "merge" || operation === "archive" || operation === "supersede" || operation === "delete" ? operation : "update";
    const resultStatus = eventOperation === "merge" ? "merged"
      : eventOperation === "archive" ? "archived"
        : eventOperation === "supersede" ? "superseded"
          : eventOperation === "delete" ? "deleted"
            : "updated";
    const eventFirstResult: WriteProjectEntryResult = {
      slug,
      path: target,
      status: resultStatus,
      lintErrors,
      lintWarnings,
      gitCommit: null,
      sanitizedReplacements: merged.sanitizedReplacements,
      ...resultCtx,
    };
    let knowledgeEvidenceEvent: AppendKnowledgeEvidenceForWriteResult | undefined;
    if (isKnowledgeEvidenceEventFirst(opts.settings)) {
      knowledgeEvidenceEvent = await appendKnowledgeEvidenceForMarkdown({
        abrainHome,
        projectId: opts.projectId,
        scope,
        raw: merged.markdown,
        fallbackSlug: slug,
        result: eventFirstResult,
        settings: opts.settings,
        auditContext: opts.auditContext,
        patch,
        operation: eventOperation,
      });
      if (shouldBlockKnowledgeLegacyWrite(opts.settings, knowledgeEvidenceEvent)) {
        const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
          operation: "reject",
          reason: "knowledge_evidence_append_failed",
          target: `${targetPrefix}:${slug}`,
          path: path.relative(auditRoot, target),
          knowledge_evidence_event: knowledgeEvidenceEvent ? summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) : null,
          duration_ms: Date.now() - started,
          ...(opts.auditExtras ?? {}),
        }));
        return { slug, path: target, status: "rejected", reason: "knowledge_evidence_append_failed", lintErrors, lintWarnings, auditPath, sanitizedReplacements: merged.sanitizedReplacements, ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}), ...resultCtx };
      }
    }
    const legacyMarkdownSkipped = shouldSkipKnowledgeLegacyMarkdownAfterEvent(opts.settings, knowledgeEvidenceEvent);
    if (prepared.source === "stable_view" && !legacyMarkdownSkipped) {
      const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
        operation: "reject",
        reason: "knowledge_evidence_append_failed",
        target: `${targetPrefix}:${slug}`,
        path: path.relative(auditRoot, target),
        knowledge_evidence_event: knowledgeEvidenceEvent ? summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) : null,
        duration_ms: Date.now() - started,
        ...(opts.auditExtras ?? {}),
      }));
      return { slug, path: target, status: "rejected", reason: "knowledge_evidence_append_failed", lintErrors, lintWarnings, auditPath, sanitizedReplacements: merged.sanitizedReplacements, ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}), ...resultCtx };
    }
    if (!legacyMarkdownSkipped) await atomicWrite(target, merged.markdown);
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? legacyMarkdownSkipped
        ? await gitCommitMany(abrainHome, [], slug, operation, gitCommitProjectId, knowledgeEvidenceWrittenPaths(knowledgeEvidenceEvent))
        : await gitCommit(abrainHome, target, slug, operation, gitCommitProjectId, knowledgeEvidenceWrittenPaths(knowledgeEvidenceEvent))
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    // P0 fix (2026-05-14 audit round 6): if gitCommit() returns null
    // (git add succeeded but git commit failed), reset the index to
    // prevent the staged update from being committed alongside a later
    // successful write — same class of bug as b40df1e (create path).
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      let knowledgeEvidenceCompensationEvent: AppendKnowledgeEvidenceForWriteResult | undefined;
      if (legacyMarkdownSkipped) {
        await resetKnowledgeEvidenceIndex(abrainHome, knowledgeEvidenceEvent);
      } else {
        try {
          const rel = path.relative(abrainHome, target);
          // async reset (parity with all other rollback paths): never block the
          // event loop on git while holding the sediment lock.
          await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 });
        } catch { /* best-effort */ }
        try {
          await atomicWrite(target, prepared.originalRaw);
        } catch { /* best-effort rollback */ }
        knowledgeEvidenceCompensationEvent = isKnowledgeEvidenceEventFirst(opts.settings) && knowledgeEvidenceEvent?.append.ok
          ? await appendKnowledgeEvidenceForMarkdown({
              abrainHome,
              projectId: opts.projectId,
              scope,
              raw: prepared.originalRaw,
              fallbackSlug: slug,
              result: { slug, path: target, status: "updated", gitCommit: null, lintErrors, lintWarnings, sanitizedReplacements: merged.sanitizedReplacements, ...resultCtx },
              settings: opts.settings,
              auditContext: opts.auditContext,
              patch: { ...patch, timelineNote: "restore after update git commit failure" },
              operation: "update",
            })
          : undefined;
      }
      const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
        operation: "reject",
        reason: "git_commit_failed",
        target: `${targetPrefix}:${slug}`,
        path: path.relative(auditRoot, target),
        event_first_legacy_compensation: legacyMarkdownSkipped ? "projection_only_commit_failed_no_legacy_mutation" : isKnowledgeEvidenceEventFirst(opts.settings) ? "legacy_restored_after_commit_failure" : "legacy_restored",
        ...(knowledgeEvidenceEvent ? { knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) } : {}),
        ...(knowledgeEvidenceCompensationEvent ? { knowledge_evidence_compensation_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceCompensationEvent) } : {}),
        ...(legacyMarkdownSkipped ? { legacy_markdown_write: legacyMarkdownSkippedAudit(knowledgeEvidenceEvent) } : {}),
        duration_ms: Date.now() - started,
        ...(opts.auditExtras ?? {}),
      }));
      return { slug, path: target, status: "rejected", reason: "git_commit_failed", lintErrors, lintWarnings, gitCommit: git, publication, auditPath, sanitizedReplacements: merged.sanitizedReplacements, ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}), ...resultCtx };
    }
    const baseResult: WriteProjectEntryResult = {
      ...eventFirstResult,
      gitCommit: git,
      publication,
    };
    if (opts.settings.knowledgeEvidenceEventWriter.enabled === true && !isKnowledgeEvidenceEventFirst(opts.settings)) {
      knowledgeEvidenceEvent = await appendKnowledgeEvidenceForMarkdown({
        abrainHome,
        projectId: opts.projectId,
        scope,
        raw: merged.markdown,
        fallbackSlug: slug,
        result: baseResult,
        settings: opts.settings,
        auditContext: opts.auditContext,
        patch,
        operation: eventOperation,
      });
    }
    const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
      operation,
      target: `${targetPrefix}:${slug}`,
      path: path.relative(auditRoot, target),
      lint_result: "pass",
      git_commit: git,
      ...(knowledgeEvidenceEvent ? { knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) } : {}),
      ...(legacyMarkdownSkipped ? { legacy_markdown_write: legacyMarkdownSkippedAudit(knowledgeEvidenceEvent) } : {}),
      duration_ms: Date.now() - started,
      ...(opts.auditExtras ?? {}),
    }));
    return {
      ...baseResult,
      auditPath,
      ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}),
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await doAudit(withWriterAuditContext(opts, patch.sessionId, {
      operation: "error",
      target: `${targetPrefix}:${slug}`,
      reason: message,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: message, lintErrors, lintWarnings, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}

export async function writeProjectEntry(
  draft: ProjectEntryDraft,
  opts: WriteProjectEntryOptions,
): Promise<WriteProjectEntryResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const projectRoot = path.resolve(opts.projectRoot);
  const abrainHome = path.resolve(opts.abrainHome);
  const scope = opts.scope ?? "project";
  const entryRoot = scope === "world"
    ? await fs.mkdir(abrainKnowledgeDir(abrainHome), { recursive: true }).then(() => abrainKnowledgeDir(abrainHome))
    : await ensureAbrainEntryRoot(abrainHome, opts.projectId);
  // World-scope entries audit to the abrain-side audit log (no project root).
  const auditRoot = scope === "world" ? abrainHome : projectRoot;
  const resultCtx = resultAuditFields(opts, draft.sessionId);
  const audit = (event: Record<string, unknown>) =>
    scope === "world"
      ? appendAbrainAudit(abrainHome, (typeof event.lane === "string" ? event.lane : undefined) ?? "auto_write", event)
      : appendAudit(projectRoot, event);

  const validationErrors = validateProjectEntryDraft(draft);
  if (validationErrors.length > 0) {
    const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: "validation_error",
      title: draft.title,
      validationErrors,
      duration_ms: Date.now() - started,
    }));
    return {
      slug: resolveDraftSlug(draft),
      path: entryRoot,
      status: "rejected",
      reason: "validation_error",
      validationErrors,
      auditPath,
      ...resultCtx,
    };
  }

  const titleSanitize = sanitizeForMemory(draft.title);
  const bodySanitize = sanitizeForMemory(draft.compiledTruth);
  const noteSanitize = draft.timelineNote
    ? sanitizeForMemory(draft.timelineNote)
    : { ok: true, text: undefined, replacements: [] as string[] };
  // triggerPhrases are part of frontmatter and otherwise bypass
  // sanitize. We run each phrase through the same gate; failure of any
  // phrase fails the whole draft (the dropped-credential alternative is
  // worse — silently losing trigger phrases would also remove the
  // signal that something was wrong).
  const triggerPhraseSanitizes = (draft.triggerPhrases ?? []).map((p) => sanitizeForMemory(p));
  const failedSanitize = [titleSanitize, bodySanitize, noteSanitize, ...triggerPhraseSanitizes].find((result) => !result.ok);
  if (failedSanitize) {
    const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: failedSanitize.error,
      title: draft.title,
      duration_ms: Date.now() - started,
    }));
    return { slug: resolveDraftSlug(draft), path: entryRoot, status: "rejected", reason: failedSanitize.error, auditPath, ...resultCtx };
  }

  const sanitizedReplacements = [
    ...titleSanitize.replacements,
    ...bodySanitize.replacements,
    ...noteSanitize.replacements,
    ...triggerPhraseSanitizes.flatMap((s) => s.replacements),
  ];

  const safeDraft: ProjectEntryDraft = {
    ...draft,
    title: titleSanitize.text ?? draft.title,
    compiledTruth: bodySanitize.text ?? draft.compiledTruth,
    timelineNote: draft.timelineNote ? noteSanitize.text : draft.timelineNote,
    triggerPhrases: draft.triggerPhrases
      ? triggerPhraseSanitizes.map((s, i) => s.text ?? draft.triggerPhrases![i])
      : draft.triggerPhrases,
    status: draft.status,
  };

  const { slug, markdown } = buildMarkdown(safeDraft, scope, opts.projectId);
  const status = safeDraft.status ?? "provisional";
  // World-scope entries are flat under knowledge/; project-scope entries
  // nest under kind/status subdirectories per the abrain project layout.
  const target = scope === "world"
    ? path.join(entryRoot, `${slug}.md`)
    : path.join(entryRoot, kindDirectory(safeDraft.kind, status), `${slug}.md`);
  const targetId = scope === "world" ? `world:${slug}` : `project:${opts.projectId}:${slug}`;

  const duplicate = await detectProjectDuplicate(entryRoot, safeDraft.title, {
    slug,
    kind: safeDraft.kind,
  });
  if (duplicate.duplicate) {
    const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: "duplicate_slug",
      target: targetId,
      duplicate,
      duration_ms: Date.now() - started,
    }));
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "duplicate_slug",
      duplicate,
      auditPath,
      ...resultCtx,
    };
  }
  const lint = lintMarkdown(markdown, target);
  const lintErrors = lint.filter((issue) => issue.severity === "error").length;
  const lintWarnings = lint.filter((issue) => issue.severity === "warning").length;
  if (lintErrors > 0) {
    const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
      operation: "reject",
      reason: "lint_error",
      target: targetId,
      lintErrors,
      lintWarnings,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: "lint_error", lintErrors, lintWarnings, auditPath, ...resultCtx };
  }

  if (opts.dryRun) {
    return {
      slug,
      path: target,
      status: "dry_run",
      lintErrors,
      lintWarnings,
      sanitizedReplacements,
      ...resultCtx,
    };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireLock(abrainHome, opts.settings.lockTimeoutMs);
    const recoveredRename = await recoverRenameTransactionIfNeeded(abrainHome);
    if (recoveredRename.didRollback) {
      const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
        operation: "reject",
        reason: "rename_transaction_rolled_back",
        target: targetId,
        rollback: recoveredRename,
        duration_ms: Date.now() - started,
      }));
      return { slug, path: target, status: "rejected", reason: "rename_transaction_rolled_back", auditPath, ...resultCtx };
    }
    if (fsSync.existsSync(target)) {
      const duplicateRace: DedupeResult = {
        duplicate: true,
        reason: "slug_exact",
        score: 1,
        match: { slug, title: safeDraft.title, kind: safeDraft.kind, status, source_path: path.relative(auditRoot, target) },
      };
      const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
        operation: "reject",
        reason: "duplicate_slug",
        target: targetId,
        duplicate: duplicateRace,
        duration_ms: Date.now() - started,
      }));
      return { slug, path: target, status: "rejected", reason: "duplicate_slug", duplicate: duplicateRace, auditPath, ...resultCtx };
    }

    let knowledgeEvidenceEvent: AppendKnowledgeEvidenceForWriteResult | undefined;
    let git: string | null = null;
    const baseResult: WriteProjectEntryResult = {
      slug,
      path: target,
      status: "created",
      lintErrors,
      lintWarnings,
      gitCommit: null,
      sanitizedReplacements,
      ...resultCtx,
    };
    if (isKnowledgeEvidenceEventFirst(opts.settings)) {
      const eventResult = await appendKnowledgeEvidenceForWrite({
        abrainHome,
        projectId: opts.projectId,
        scope,
        draft: safeDraft,
        result: baseResult,
        settings: opts.settings,
        auditContext: opts.auditContext,
        sessionId: draft.sessionId,
        operation: "create",
        ...(knowledgeLegacyMarkdownWriteDisabled(opts.settings) ? { legacyParallelWrite: { attempted: false, status: baseResult.status, reason: "legacy_markdown_write_disabled" } } : {}),
      }).catch((err: unknown): AppendKnowledgeEvidenceForWriteResult => ({
        append: {
          ok: false,
          status: "write_failed",
          error: err instanceof Error ? err.message : String(err),
        },
      }));
      knowledgeEvidenceEvent = eventResult;
      if (shouldBlockKnowledgeLegacyWrite(opts.settings, eventResult)) {
        const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
          operation: "reject",
          reason: "knowledge_evidence_append_failed",
          target: targetId,
          knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(eventResult),
          duration_ms: Date.now() - started,
        }));
        return { slug, path: target, status: "rejected", reason: "knowledge_evidence_append_failed", lintErrors, lintWarnings, auditPath, knowledgeEvidenceEvent: eventResult, ...resultCtx };
      }
    }

    const legacyMarkdownSkipped = shouldSkipKnowledgeLegacyMarkdownAfterEvent(opts.settings, knowledgeEvidenceEvent);
    if (!legacyMarkdownSkipped) await atomicWrite(target, markdown);
    const gitCommitProjectId = scope === "world" ? undefined : opts.projectId;
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? legacyMarkdownSkipped
        ? await gitCommitMany(abrainHome, [], slug, "create", gitCommitProjectId, knowledgeEvidenceWrittenPaths(knowledgeEvidenceEvent))
        : await gitCommit(abrainHome, target, slug, "create", gitCommitProjectId, knowledgeEvidenceWrittenPaths(knowledgeEvidenceEvent))
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    git = publication.commit;
    // P2 fix (2026-05-14 audit): when gitCommit is enabled but returns null
    // (e.g. index.lock race, hook failure, EACCES), the markdown file is on
    // disk but git has no record. Without cleanup, the next write for this
    // slug hits the duplicate_slug race check forever (orphan wedge).
    // Unlink the orphan and reject — parity with writeAbrainWorkflow R9 P1-3.
    //
    // P4 fix (2026-05-14 R5 audit): gitCommit() does git add + git commit.
    // If add succeeds but commit fails, the file is staged in git index even
    // after unlink. The next successful commit then commits this ghost file
    // (staged add of a now-deleted file), leaving a "deleted" entry in git
    // history with no corresponding disk file — a silent wedge in the abrain
    // repo. git reset HEAD -- <rel> below cleans the index.
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      let knowledgeEvidenceCompensationEvent: AppendKnowledgeEvidenceForWriteResult | undefined;
      if (legacyMarkdownSkipped) {
        await resetKnowledgeEvidenceIndex(abrainHome, knowledgeEvidenceEvent);
      } else {
        const rel = path.relative(abrainHome, target);
        try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort */ }
        await fs.unlink(target).catch(() => {});
        knowledgeEvidenceCompensationEvent = isKnowledgeEvidenceEventFirst(opts.settings) && knowledgeEvidenceEvent?.append.ok
          ? await appendKnowledgeEvidenceForWrite({
              abrainHome,
              projectId: opts.projectId,
              scope,
              draft: { ...safeDraft, timelineNote: "remove projection after create git commit failure" },
              result: { slug, path: target, status: "deleted", gitCommit: null, ...resultCtx },
              settings: opts.settings,
              auditContext: opts.auditContext,
              sessionId: draft.sessionId,
              operation: "delete",
            }).catch((err: unknown): AppendKnowledgeEvidenceForWriteResult => ({
              append: {
                ok: false,
                status: "write_failed",
                error: err instanceof Error ? err.message : String(err),
              },
            }))
          : undefined;
      }
      const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
        operation: "reject",
        reason: "git_commit_failed",
        target: targetId,
        event_first_legacy_compensation: legacyMarkdownSkipped ? "projection_only_commit_failed_no_legacy_mutation" : isKnowledgeEvidenceEventFirst(opts.settings) ? "orphan_removed_and_projection_deleted" : "orphan_removed",
        ...(knowledgeEvidenceEvent ? { knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) } : {}),
        ...(knowledgeEvidenceCompensationEvent ? { knowledge_evidence_compensation_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceCompensationEvent) } : {}),
        ...(legacyMarkdownSkipped ? { legacy_markdown_write: legacyMarkdownSkippedAudit(knowledgeEvidenceEvent) } : {}),
        duration_ms: Date.now() - started,
      }));
      return { slug, path: target, status: "rejected", reason: "git_commit_failed", gitCommit: git, publication, auditPath, ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}), ...resultCtx };
    }
    const result: WriteProjectEntryResult = { ...baseResult, gitCommit: git, publication };
    if (opts.settings.knowledgeEvidenceEventWriter.enabled === true && !isKnowledgeEvidenceEventFirst(opts.settings)) {
      const eventResult = await appendKnowledgeEvidenceForWrite({
        abrainHome,
        projectId: opts.projectId,
        scope,
        draft: safeDraft,
        result,
        settings: opts.settings,
        auditContext: opts.auditContext,
        sessionId: draft.sessionId,
        operation: "create",
      }).catch((err: unknown): AppendKnowledgeEvidenceForWriteResult => ({
        append: {
          ok: false,
          status: "write_failed",
          error: err instanceof Error ? err.message : String(err),
        },
      }));
      knowledgeEvidenceEvent = eventResult;
    }
    const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
      operation: "create",
      target: targetId,
      path: path.relative(auditRoot, target),
      lint_result: "pass",
      git_commit: git,
      ...(knowledgeEvidenceEvent ? { knowledge_evidence_event: summarizeKnowledgeEvidenceEvent(knowledgeEvidenceEvent) } : {}),
      ...(legacyMarkdownSkipped ? { legacy_markdown_write: legacyMarkdownSkippedAudit(knowledgeEvidenceEvent) } : {}),
      duration_ms: Date.now() - started,
    }));

    return {
      ...result,
      auditPath,
      ...(knowledgeEvidenceEvent ? { knowledgeEvidenceEvent } : {}),
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await audit(withWriterAuditContext(opts, draft.sessionId, {
      operation: "error",
      target: targetId,
      reason: message,
      duration_ms: Date.now() - started,
    }));
    return { slug, path: target, status: "rejected", reason: message, lintErrors, lintWarnings, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}

// ══ abrain workflows lane writer (B1) ═════════════════════════════════════
//
// `writeAbrainWorkflow` writes pipeline-shaped entries ("run-when-*" task
// blueprints, sediment-event-style automations) into the abrain `workflows/`
// zone instead of the project `.pensieve/` knowledge tree.
//
// Why a separate API instead of extending writeProjectEntry / ENTRY_KINDS:
//   - ENTRY_KINDS is the 7-kind knowledge contract (maxim / decision /
//     pattern / anti-pattern / fact / preference / smell). Pipeline is NOT
//     knowledge; it's a flow. Mixing it into ENTRY_KINDS pollutes the kind
//     model that sediment curator + memory_search rely on.
//   - abrain workflows live outside the per-project pensieve git tree
//     (cross-project workflows are global; project-specific live under
//     ~/.abrain/projects/<id>/workflows/), so substrate paths (lock /
//     audit / git commit) target abrainHome, not projectRoot.
//   - workflow frontmatter shape differs from knowledge entries: it has
//     `trigger`, `tags`, no `confidence`, no `compiled_truth` section.
//
// What it shares with writeProjectEntry (intentionally, to avoid drift):
//   - sanitize gate (sanitizeForMemory redacts secrets/PII to placeholders)
//   - atomic write (tmp + rename)
//   - markdown lint (lintMarkdown)
//   - lockfile + atomic stale reclaim
//   - git commit + audit row append (lane="workflow")
//
// Callers (today only future /memory migrate --go, B4): can produce both
// cross-project (~/.abrain/workflows/<slug>.md) and project-specific
// (~/.abrain/projects/<id>/workflows/<slug>.md) outputs via the
// `crossProject` flag.

export interface WorkflowDraft {
  /** Human-readable workflow title, e.g. "更新 Claude Code 插件" */
  title: string;
  /** Trigger description: when this workflow should run (e.g. "用户要求更新插件" or "触发词: update plugins") */
  trigger: string;
  /** Workflow body markdown (Task Blueprint, completion criteria, etc). Min 20 chars. */
  body: string;
  /** true → ~/.abrain/workflows/ (cross-project); false (default) → ~/.abrain/projects/<id>/workflows/ */
  crossProject?: boolean;
  /** Required when crossProject=false; ignored otherwise. Must pass validateAbrainProjectId. */
  projectId?: string;
  /** Optional tags, sanitized like everything else. */
  tags?: string[];
  /** Optional slug override (defaults to slugify(title)) for stable rename to `run-when-*` style. */
  slug?: string;
  /** Status enum, default "provisional". */
  status?: EntryStatus;
  /** Optional session id for audit correlation. */
  sessionId?: string;
  /** Optional Timeline note; defaults to "created by sediment workflow writer". */
  timelineNote?: string;
}

export interface WriteWorkflowOptions {
  abrainHome: string;
  settings: SedimentSettings;
  dryRun?: boolean;
  auditContext?: WriterAuditContext;
}

export interface WriteWorkflowResult {
  slug: string;
  path: string;
  status: "created" | "skipped" | "dry_run" | "rejected";
  reason?: string;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  publication?: WriterPublicationResult;
  auditPath?: string;
  sanitizedReplacements?: string[];
  validationErrors?: Array<{ field: string; message: string }>;
  crossProject?: boolean;
  projectId?: string;
  lane?: string;
  sessionId?: string;
  correlationId?: string;
  candidateId?: string;
}

function validateWorkflowDraft(draft: WorkflowDraft): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  if (typeof draft.title !== "string" || draft.title.trim().length === 0) {
    issues.push({ field: "title", message: "title is required" });
  }
  if (typeof draft.trigger !== "string" || draft.trigger.trim().length === 0) {
    issues.push({ field: "trigger", message: "trigger is required" });
  }
  if (typeof draft.body !== "string" || draft.body.trim().length < 20) {
    issues.push({ field: "body", message: "body must be at least 20 characters" });
  }
  if (draft.crossProject === false || draft.crossProject === undefined) {
    if (typeof draft.projectId !== "string" || draft.projectId.length === 0) {
      issues.push({ field: "projectId", message: "projectId is required when crossProject is false (default)" });
    } else {
      try { validateAbrainProjectId(draft.projectId); }
      catch (e) { issues.push({ field: "projectId", message: (e as Error).message }); }
    }
  }
  // Round 8 P1 (gpt-5.5 R8 audit): validate status against ENTRY_STATUSES
  // enum, not just `typeof === "string"`. Previously any string would
  // pass and land in YAML as `status: <whatever>`, producing entries that
  // the read-side validator wouldn't recognize (and dual-read dedup
  // tiebreak / search filters silently misbehave).
  if (draft.status !== undefined) {
    if (typeof draft.status !== "string" || !(ENTRY_STATUSES as readonly string[]).includes(draft.status)) {
      issues.push({ field: "status", message: `status must be one of: ${ENTRY_STATUSES.join(", ")}` });
    }
  }
  return issues;
}

function buildWorkflowMarkdown(draft: WorkflowDraft, slug: string): string {
  const timestamp = nowIso();
  const status = draft.status ?? "provisional";
  const crossProject = draft.crossProject === true;
  const id = crossProject ? `workflow:${slug}` : `project:${draft.projectId}:workflow:${slug}`;
  const timelineSession = draft.sessionId || "sediment";
  const timelineNote = draft.timelineNote || "created by sediment workflow writer";
  const tags = (draft.tags ?? []).map((t) => t.trim()).filter(Boolean);

  const fmLines: string[] = [];
  fmLines.push("---");
  fmLines.push(`id: ${yamlString(id)}`);
  // T7 frontmatter-required (lint.ts REQUIRED_FRONTMATTER_FIELDS): title +
  // confidence are mandatory for every markdown entry. Workflows aren't
  // ranked by confidence in retrieval, but we set a deterministic mid
  // value (5) to satisfy the storage contract; the field is informational
  // for workflows.
  fmLines.push(`title: ${yamlString(draft.title)}`);
  fmLines.push(`scope: workflow`);
  fmLines.push(`kind: workflow`);
  fmLines.push(`cross_project: ${crossProject ? "true" : "false"}`);
  if (!crossProject) fmLines.push(`project_id: ${yamlString(draft.projectId!)}`);
  fmLines.push(`status: ${yamlString(status)}`);
  fmLines.push(`confidence: 5`);
  fmLines.push(`trigger: ${yamlString(draft.trigger)}`);
  fmLines.push(...yamlList("tags", tags));
  fmLines.push(`created: ${yamlString(timestamp)}`);
  fmLines.push(`updated: ${yamlString(timestamp)}`);
  fmLines.push(`schema_version: 1`);
  fmLines.push("---");

  // Body normalization: ensure body starts with `# <title>`; escape bare `---` lines
  // (same defensive escape as normalizeCompiledTruth, frontmatter break-out guard).
  let body = draft.body.trim();
  body = body.replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  body = body.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(body)) body = `# ${draft.title}\n\n**Trigger**: ${draft.trigger}\n\n${body}`;

  // Timeline format aligns with buildMarkdown (project entries):
  // `- <ts> | <session> | <action> | <note>` pipe-separated columns.
  const timeline = `## Timeline\n- ${timestamp} | ${timelineSession} | created | ${timelineNote}`;

  return `${fmLines.join("\n")}\n\n${body.trim()}\n\n${timeline}\n`;
}

async function acquireAbrainWorkflowLock(abrainHome: string, timeoutMs: number): Promise<LockHandle> {
  // Same owner-token stale-lock reclaim as `acquireLock` above. The two
  // locks are intentionally distinct files in different repos (project-side
  // sediment.lock vs abrain-side workflow.lock) so a hang on one doesn't
  // block the other; both share the same grace period.
  const lockPath = path.join(abrainSedimentLocksDir(abrainHome), "workflow.lock");
  const handle = await acquireFileLock(lockPath, {
    timeoutMs,
    staleMs: SEDIMENT_LOCK_STEAL_AFTER_MS,
    retryMs: 100,
    label: "abrain workflow",
  });
  return { release: handle.release };
}

async function appendAbrainAudit(abrainHome: string, lane: string, event: Record<string, unknown>): Promise<string> {
  const auditPath = abrainSedimentAuditPath(abrainHome);
  await fs.mkdir(path.dirname(auditPath), { recursive: true });
  const enriched = {
    timestamp: formatLocalIsoTimestamp(),
    audit_version: AUDIT_SCHEMA_VERSION,
    pid: process.pid,
    abrain_home: path.resolve(abrainHome),
    lane,
    ...event,
  };
  await fs.appendFile(auditPath, `${JSON.stringify(enriched)}\n`, "utf-8");
  return auditPath;
}

async function appendAbrainWorkflowAudit(abrainHome: string, event: Record<string, unknown>): Promise<string> {
  return appendAbrainAudit(abrainHome, "workflow", event);
}

async function gitCommitAbrain(abrainHome: string, filePath: string, slug: string, label = "workflow"): Promise<WriterPublicationResult> {
  if (canonicalGitRuntimeEnabled()) {
    return canonicalCommitExplicitPaths(abrainHome, [filePath], `${label}: ${slug}`, `${label}:${slug}`);
  }
  return legacyPublication(await gitSingleFlight(abrainHome, () =>
    gitCommitAbrainUnlocked(abrainHome, filePath, slug, label)));
}

async function gitCommitAbrainUnlocked(abrainHome: string, filePath: string, slug: string, label = "workflow"): Promise<string | null> {
  try {
    const rel = path.relative(abrainHome, filePath);
    // Round 2 audit fix (opus m3): same `--` defense-in-depth as gitCommit.
    // ADR0039 A1: workflow/rules writes do not receive a projector-produced
    // file list, so they stage only their own canonical file. Derived-output
    // drains go through commitAbrainDerivedOutputs(), which audits its scope.
    await execFileAsync("git", ["-C", abrainHome, "add", "--", rel], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    await execFileAsync("git", ["-C", abrainHome, "commit", "-m", `${label}: ${slug}`], { timeout: 30_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", abrainHome, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Write a workflow entry to the abrain workflows zone.
 *
 * Routing:
 *   - draft.crossProject === true  → ~/.abrain/workflows/<slug>.md
 *   - otherwise (default)          → ~/.abrain/projects/<projectId>/workflows/<slug>.md
 *
 * Substrate (mirrors writeProjectEntry):
 *   1. validation (schema)
 *   2. sanitize all free-text fields (redact secrets/PII to placeholders)
 *   3. build markdown (frontmatter v1 + body + Timeline)
 *   4. lint (warnings recorded; errors reject)
 *   5. dedupe (slug collision)
 *   6. lock (abrain-side, separate from project sediment lock)
 *   7. atomic write + git commit in abrain repo + audit row in abrain audit
 */
export async function writeAbrainWorkflow(
  draft: WorkflowDraft,
  opts: WriteWorkflowOptions,
): Promise<WriteWorkflowResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const abrainHome = path.resolve(opts.abrainHome);
  const crossProject = draft.crossProject === true;
  const projectId = !crossProject ? draft.projectId : undefined;
  const lane = "workflow";
  const sessionId = opts.auditContext?.sessionId ?? draft.sessionId;
  const resultCtx = {
    lane,
    sessionId,
    correlationId: opts.auditContext?.correlationId,
    candidateId: opts.auditContext?.candidateId,
  };

  const validationErrors = validateWorkflowDraft(draft);
  if (validationErrors.length > 0) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "reject",
      reason: "validation_error",
      title: draft.title,
      validationErrors,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug: slugify(draft.title || "workflow"),
      path: abrainHome,
      status: "rejected",
      reason: "validation_error",
      validationErrors,
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  // Sanitize free-text fields (title, trigger, body, tags, timelineNote).
  const titleSan = sanitizeForMemory(draft.title);
  const triggerSan = sanitizeForMemory(draft.trigger);
  const bodySan = sanitizeForMemory(draft.body);
  const noteSan = draft.timelineNote
    ? sanitizeForMemory(draft.timelineNote)
    : { ok: true as const, text: undefined, replacements: [] as string[] };
  const tagSans = (draft.tags ?? []).map((t) => sanitizeForMemory(t));
  const failed = [titleSan, triggerSan, bodySan, noteSan, ...tagSans].find((r) => !r.ok);
  if (failed) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "reject",
      reason: (failed as { ok: false; error: string }).error,
      title: draft.title,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug: slugify(draft.title),
      path: abrainHome,
      status: "rejected",
      reason: (failed as { ok: false; error: string }).error,
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  const sanitizedReplacements = [
    ...titleSan.replacements,
    ...triggerSan.replacements,
    ...bodySan.replacements,
    ...noteSan.replacements,
    ...tagSans.flatMap((s) => s.replacements),
  ];

  const safeDraft: WorkflowDraft = {
    ...draft,
    title: titleSan.text ?? draft.title,
    trigger: triggerSan.text ?? draft.trigger,
    body: bodySan.text ?? draft.body,
    timelineNote: draft.timelineNote ? noteSan.text : draft.timelineNote,
    tags: draft.tags ? tagSans.map((s, i) => s.text ?? draft.tags![i]) : draft.tags,
  };

  const slug = (draft.slug && slugify(draft.slug)) || slugify(safeDraft.title);
  const targetDir = crossProject
    ? abrainWorkflowsDir(abrainHome)
    : abrainProjectWorkflowsDir(abrainHome, projectId!);
  const target = path.join(targetDir, `${slug}.md`);

  // Storage-level dedupe: same slug already exists.
  if (fsSync.existsSync(target)) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "reject",
      reason: "duplicate_slug",
      target: crossProject ? `workflow:${slug}` : `project:${projectId}:workflow:${slug}`,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "duplicate_slug",
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  const markdown = buildWorkflowMarkdown(safeDraft, slug);
  const lintIssues = lintMarkdown(markdown, target);
  const lintErrors = lintIssues.filter((i) => i.severity === "error").length;
  const lintWarnings = lintIssues.filter((i) => i.severity === "warning").length;
  if (lintErrors > 0) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "reject",
      reason: "lint_error",
      target: path.relative(abrainHome, target),
      lint_errors: lintErrors,
      lint_warnings: lintWarnings,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "lint_error",
      lintErrors,
      lintWarnings,
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  if (opts.dryRun) {
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "dry_run",
      target: path.relative(abrainHome, target),
      lint_warnings: lintWarnings,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "dry_run",
      lintWarnings,
      auditPath,
      sanitizedReplacements,
      crossProject,
      projectId,
      ...resultCtx,
    };
  }

  let lock: LockHandle | undefined;
  try {
    lock = await acquireAbrainWorkflowLock(abrainHome, opts.settings.lockTimeoutMs ?? 5000);
    // Lock-held duplicate re-check (mirror writeProjectEntry @ ~882).
    //
    // The first existsSync above is best-effort and cheap, but it runs
    // *outside* the lock — two concurrent writers can both pass it,
    // then race past the lock barrier and silently overwrite each other
    // via atomicWrite → fs.rename. Re-checking here under the lock is
    // the only correct dedupe surface. Round 6 deepseek-v4-pro P0:
    // discovered by cross-file pattern audit (writeProjectEntry had the
    // re-check, writeAbrainWorkflow did not).
    if (fsSync.existsSync(target)) {
      const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
        operation: "reject",
        reason: "duplicate_slug_race",
        target: crossProject ? `workflow:${slug}` : `project:${projectId}:workflow:${slug}`,
        duration_ms: Date.now() - started,
        ...resultCtx,
      });
      return {
        slug,
        path: target,
        status: "rejected",
        reason: "duplicate_slug_race",
        auditPath,
        crossProject,
        projectId,
        ...resultCtx,
      };
    }
    await atomicWrite(target, markdown);
    // P2 fix (R6 audit): respect settings.gitCommit — don't force git commit
    // when user explicitly disabled it. Match writeProjectEntry behavior.
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? await gitCommitAbrain(abrainHome, target, slug)
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    // Round 9 P1 (deepseek R9 P1-3 fix): gitCommitAbrain swallows all
    // exceptions and returns null on any git failure (index.lock race,
    // commit hook fail, EACCES). Before this fix, a null git left an
    // orphan untracked file on disk. Subsequent writeAbrainWorkflow on
    // the same slug saw the file via fsSync.existsSync(target) and
    // returned status="rejected" reason="duplicate_slug_race" — the
    // entry was forever wedged. Detect null git + treat as a write
    // failure: unlink the orphan, emit audit row with reason, and
    // return rejected so caller can retry.
    //
    // P4 fix (2026-05-14 R5 audit): also git reset HEAD to unstage
    // the ghost file from the index — same bug as writeProjectEntry.
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      const rel = path.relative(abrainHome, target);
      try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort */ }
      try { await fs.unlink(target); } catch { /* file may already be gone */ }
      const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
        operation: "error",
        target: path.relative(abrainHome, target),
        cross_project: crossProject,
        project_id: projectId,
        reason: "git_commit_failed_orphan_cleaned",
        lint_result: "pass",
        lint_warnings: lintWarnings,
        git_commit: null,
        duration_ms: Date.now() - started,
        ...resultCtx,
      });
      return {
        slug,
        path: target,
        status: "rejected",
        reason: "git_commit_failed",
        gitCommit: git,
        publication,
        auditPath,
        crossProject,
        projectId,
        ...resultCtx,
      };
    }
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "create",
      target: path.relative(abrainHome, target),
      cross_project: crossProject,
      project_id: projectId,
      lint_result: "pass",
      lint_warnings: lintWarnings,
      git_commit: git,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "created",
      lintErrors,
      lintWarnings,
      gitCommit: git,
      publication,
      auditPath,
      sanitizedReplacements,
      crossProject,
      projectId,
      ...resultCtx,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAbrainWorkflowAudit(abrainHome, {
      operation: "error",
      target: path.relative(abrainHome, target),
      reason: message,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: message,
      auditPath,
      crossProject,
      projectId,
      ...resultCtx,
    };
  } finally {
    await lock?.release();
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Rules writer: writeAbrainRule + lifecycle (ADR 0023 D5)
// ───────────────────────────────────────────────────────────────────────────────
// Mirrors writeAbrainWorkflow substrate (sanitize / lint / dedupe / lock /
// atomic write / git commit + orphan cleanup / audit). Rule-specific lints
// (kind/size/hint) live in ./rule-writer; budget telemetry is advisory below.
// ui.notify (INV-R8/R9) is the DISPATCH layer's job (the writer has no ctx.ui);
// the result carries op/slug/injectMode/scope so the caller can notify.

export interface Tier2RulesLegacyWriteContext {
  caller: "curator_decision_writer";
  operation: "create" | "archive" | "delete";
  ruleScope: "global" | "project";
  projectId?: string;
  slug: string;
  injectMode?: RuleInjectMode;
}

export interface WriteRuleOptions {
  abrainHome: string;
  settings: SedimentSettings;
  dryRun?: boolean;
  auditContext?: WriterAuditContext;
  exactDuplicateAsDedup?: boolean;
  /** Advisory per-(scope,inject_mode) health cap. Over-budget never blocks writes. */
  budgetTokenCap?: number;
  /** Tier-2 rules-zone gate context. Only callers that pass this context are subject to block mode. */
  tier2RulesLegacyWriteContext?: Tier2RulesLegacyWriteContext;
  /** PR-4/P0.3 (O2 2026-06-10): cross-slug Jaccard near-dup policy.
   *  - "dedup" (default): autonomous gate — return status:"deduped" (legacy
   *    behavior, sole writer while tier1JaccardCuratorLane is off).
   *  - "report": NO write — return status:"similar_found" + dedupedAgainst so
   *    the Tier-1 caller can run the curator adjudication {update,merge,create}.
   *  - "off": skip the cross-slug scan (post-adjudication create, or Tier-2
   *    curator lane where rule neighbors were already in the prompt).
   *  Same-slug gates (duplicate_slug / exactDuplicateAsDedup) are unaffected. */
  semanticDedup?: "dedup" | "report" | "off";
}

export interface WriteRuleResult {
  slug: string;
  path: string;
  /** "similar_found" is an INTERMEDIATE status (semanticDedup:"report" only):
   *  nothing was written; the caller must resolve it via adjudication. It never
   *  reaches no-loss predicates / tells under the default settings. */
  status: "created" | "archived" | "deleted" | "updated" | "skipped" | "rejected" | "dry_run" | "deduped" | "similar_found";
  reason?: string;
  /** ADR 0028 §12.3: rules injection-budget axis (values always/listed),
   *  renamed from `tier` to stop colliding with the GTIER Tier-1/2 predicate. */
  injectMode?: RuleInjectMode;
  demotedFrom?: RuleInjectMode;
  dedupedAgainst?: string;
  ruleScope?: "global" | "project";
  projectId?: string;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  publication?: WriterPublicationResult;
  auditPath?: string;
  sanitizedReplacements?: string[];
  budgetTokens?: number;
  budgetCap?: number;
  overSoftBudget?: boolean;
  tier2RulesLegacyWriteGate?: {
    mode: "observe" | "block";
    caller: "curator_decision_writer";
    operation: "create" | "archive" | "delete";
    blocked: boolean;
  };
  lane?: string;
  sessionId?: string;
  correlationId?: string;
  candidateId?: string;
}

const DEFAULT_RULE_BUDGET_TOKENS: Record<RuleInjectMode, number> = { always: 2500, listed: 8000 };

function rulesBaseDir(abrainHome: string, scope: "global" | "project", projectId?: string): string {
  return scope === "global"
    ? path.join(abrainHome, "rules")
    : path.join(abrainProjectDir(abrainHome, projectId!), "rules");
}

async function acquireAbrainRuleLock(abrainHome: string, timeoutMs: number): Promise<LockHandle> {
  // Independent rules.lock (ADR 0023 D5.2): symmetric with workflow.lock /
  // about-me.lock so a hang on one lane does not block the others.
  const lockPath = path.join(abrainSedimentLocksDir(abrainHome), "rules.lock");
  const handle = await acquireFileLock(lockPath, {
    timeoutMs,
    staleMs: SEDIMENT_LOCK_STEAL_AFTER_MS,
    retryMs: 100,
    label: "abrain rules",
  });
  return { release: handle.release };
}

function estimateRuleTokens(text: string): number {
  // Approximate token count for non-blocking rules health telemetry. A flat
  // length/4 (Latin ~4 chars/token) UNDER-counts CJK 2-4x (audit round-2 P2),
  // so CJK code points are counted conservatively at ~2 tokens/char.
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isCjk =
      (cp >= 0x3000 && cp <= 0x9fff) ||   // CJK symbols + kana + unified ideographs
      (cp >= 0xac00 && cp <= 0xd7a3) ||   // Hangul syllables
      (cp >= 0xf900 && cp <= 0xfaff) ||   // CJK compatibility ideographs
      (cp >= 0x20000 && cp <= 0x2ffff);   // CJK unified ext-B..F (supplementary)
    if (isCjk) cjk++; else other++;
  }
  return Math.ceil(cjk * 2 + other / 4);
}

/** Rules budget health: sum existing mode-dir token footprint + the new entry.
 *  Over-budget is advisory only; it never blocks persistence. */
async function measureRuleBudget(
  modeDir: string,
  addedMarkdown: string,
  cap: number,
): Promise<{ tokens: number; overSoftBudget: boolean }> {
  let existing = 0;
  try {
    for (const f of await fs.readdir(modeDir)) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue;
      const fp = path.join(modeDir, f);
      try {
        existing += estimateRuleTokens(await fs.readFile(fp, "utf-8"));
      } catch { /* skip unreadable file */ }
    }
  } catch { /* mode dir absent -> 0 existing */ }
  const tokens = existing + estimateRuleTokens(addedMarkdown);
  return { tokens, overSoftBudget: tokens > cap };
}

/** #2 dedup scan (T0 consensus 2026-06-07): return the slug of an existing ACTIVE
 *  rule in this scope whose body is a semantic near-match (Jaccard ≥ threshold) to
 *  `body`, else undefined. Scans both inject modes; skips the same-slug file (that case is
 *  the exact duplicate_slug gate). A re-stated rule strengthens, never duplicates. */
function similarActiveRuleAtPath(fp: string, body: string): boolean {
  try {
    const raw = fsSync.readFileSync(fp, "utf-8");
    const { frontmatterText, body: otherBody } = splitFrontmatter(raw);
    const status = parseFrontmatter(frontmatterText).status;
    if (status && String(status) !== "active") return false;
    return ruleBodySimilarity(body, otherBody) >= RULE_DEDUP_SIMILARITY_THRESHOLD;
  } catch {
    return false;
  }
}

function findSimilarRuleSlug(abrainHome: string, scope: "global" | "project", projectId: string | undefined, body: string, excludeSlug: string): string | undefined {
  const base = rulesBaseDir(abrainHome, scope, projectId);
  for (const mode of ["always", "listed"] as RuleInjectMode[]) {
    const dir = path.join(base, mode);
    let files: string[] = [];
    try { files = fsSync.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith(".md") || f.startsWith("_")) continue;
      const otherSlug = f.replace(/\.md$/, "");
      if (otherSlug === excludeSlug) continue;
      if (similarActiveRuleAtPath(path.join(dir, f), body)) return otherSlug;
    }
  }
  return undefined;
}

async function applyTier2RulesLegacyWriteGate(args: {
  opts: WriteRuleOptions;
  context?: Tier2RulesLegacyWriteContext;
  audit: (event: Record<string, unknown>) => Promise<string>;
  result: Omit<WriteRuleResult, "status" | "reason" | "path" | "auditPath" | "tier2RulesLegacyWriteGate"> & { path?: string };
  fallbackPath: string;
}): Promise<WriteRuleResult | undefined> {
  const mode = args.opts.settings.tier2RulesLegacyWriteGate?.mode ?? "observe";
  if (!args.context || mode === "off") return undefined;
  const event = {
    operation: "tier2_rules_legacy_write_gate",
    gate_mode: mode,
    gate_decision: mode === "block" ? "block" : "allow",
    caller: args.context.caller,
    rule_operation: args.context.operation,
    target_scope: args.context.ruleScope,
    ...(args.context.projectId ? { project_id: args.context.projectId } : {}),
    context_slug: args.context.slug,
    ...(args.context.injectMode ? { inject_mode: args.context.injectMode } : {}),
    dry_run: args.opts.dryRun === true,
  };
  const auditPath = await args.audit(event);
  if (mode !== "block") return undefined;
  return {
    ...args.result,
    path: args.result.path ?? args.fallbackPath,
    status: "skipped",
    reason: "tier2_rules_legacy_write_blocked",
    auditPath,
    tier2RulesLegacyWriteGate: {
      mode: "block",
      caller: args.context.caller,
      operation: args.context.operation,
      blocked: true,
    },
  };
}

/** ADR 0023 D5: create a rule in ~/.abrain/[projects/<id>/]rules/<inject_mode>/. */
export async function writeAbrainRule(draft: RuleDraft, opts: WriteRuleOptions): Promise<WriteRuleResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const abrainHome = path.resolve(opts.abrainHome);
  const ruleScope: "global" | "project" = draft.scope === "global" ? "global" : "project";
  const projectId = draft.scope === "global" ? undefined : draft.scope.projectId;
  const sessionId = opts.auditContext?.sessionId ?? draft.sessionId;
  const resultCtx = { lane: "rules", sessionId, correlationId: opts.auditContext?.correlationId, candidateId: opts.auditContext?.candidateId };
  // Audit P2-1 (2026-06-07): final `|| "rule"` so an all-punctuation title
  // (slugify -> "") cannot produce a degenerate `<modeDir>/.md` dotfile + empty-slug id.
  const slug = (draft.slug && slugify(draft.slug)) || slugify(draft.title || "rule") || "rule";

  // ADR 0023 (T0 panel 2026-06-07): an always-mode body over the size target is
  // AUTO-DEMOTED to listed (full body kept on disk + compact catalog summary),
  // never rejected — losing a genuinely always-caliber rule is worse than demoting
  // it. effectiveInjectMode is what actually gets WRITTEN; draft.injectMode is the ask.
  let effectiveInjectMode: RuleInjectMode = draft.injectMode;
  let demotedFromAlways = false;

  const audit = (event: Record<string, unknown>) =>
    appendAbrainAudit(abrainHome, "rules", { inject_mode: effectiveInjectMode, ...(demotedFromAlways ? { demoted_from: "always" } : {}), scope: ruleScope, ...(projectId ? { project_id: projectId } : {}), slug, duration_ms: Date.now() - started, ...resultCtx, ...event });
  const reject = async (reason: string, extra: Partial<WriteRuleResult> = {}): Promise<WriteRuleResult> => {
    const auditPath = await audit({ operation: "reject", reason });
    return { slug, path: abrainHome, status: "rejected", reason, injectMode: effectiveInjectMode, ruleScope, projectId, auditPath, ...resultCtx, ...extra };
  };

  if (typeof draft.title !== "string" || !draft.title.trim()) return reject("validation_error_title");
  if (typeof draft.body !== "string" || draft.body.trim().length < 10) return reject("validation_error_body");
  if (draft.zone !== "rules") return reject("validation_error_zone");
  // Audit P1-a (2026-06-07): validate inject_mode even though the sole caller
  // coerces it. writeAbrainRule is exported and its contract claims to validate;
  // an unchecked value flows into path.join(modeDir, draft.injectMode)
  // (traversal) and the `inject_mode:` YAML line. Defense-in-depth: reject
  // anything outside the two known modes.
  if (draft.injectMode !== "always" && draft.injectMode !== "listed") return reject("validation_error_inject_mode");
  if (ruleScope === "project" && !projectId) return reject("validation_error_project_id");

  const kindLint = lintRuleKind(draft.kind, draft.injectMode);
  if (!kindLint.ok) return reject(`kind_invalid: ${kindLint.reason}`);

  const titleSan = sanitizeForMemory(draft.title);
  const bodySan = sanitizeForMemory(draft.body);
  const reasonSan = sanitizeForMemory(draft.routingReason || "");
  const tagSans = (draft.tags ?? []).map((t) => sanitizeForMemory(t));
  const failed = [titleSan, bodySan, reasonSan, ...tagSans].find((r) => !r.ok);
  if (failed) return reject((failed as { ok: false; error: string }).error);
  const safeBody = bodySan.text ?? draft.body;

  const sizeLint = lintRuleAlwaysSize(safeBody, draft.injectMode);
  if (!sizeLint.ok && draft.injectMode === "always") {
    // panel verdict (C, 2026-06-07): DEMOTE always->listed, do NOT reject.
    // With catalog injection, listed has no per-rule body-size cap: the compact
    // summary is injected and the full body is retrieved on demand.
    effectiveInjectMode = "listed";
    demotedFromAlways = true;
  }

  const hintRes = draft.hint ? sanitizeRuleHint(draft.hint) : null;
  const cleanHint = hintRes && hintRes.ok ? hintRes.clean : (ruleHintFallback(safeBody) ?? undefined);

  const safeDraft: RuleDraft = {
    ...draft,
    injectMode: effectiveInjectMode,
    title: titleSan.text ?? draft.title,
    body: safeBody,
    routingReason: reasonSan.text ?? draft.routingReason,
    tags: draft.tags ? tagSans.map((s, i) => s.text ?? draft.tags![i]) : draft.tags,
    hint: cleanHint,
  };
  const markdown = buildRuleMarkdown(safeDraft, slug);

  const lintIssues = lintMarkdown(markdown, "rule.md");
  const lintErrors = lintIssues.filter((i) => i.severity === "error").length;
  const lintWarnings = lintIssues.filter((i) => i.severity === "warning").length;
  if (lintErrors > 0) return reject("lint_error", { lintErrors, lintWarnings });

  const modeDir = path.join(rulesBaseDir(abrainHome, ruleScope, projectId), effectiveInjectMode);
  const target = path.join(modeDir, `${slug}.md`);
  const gateResult = await applyTier2RulesLegacyWriteGate({
    opts,
    context: opts.tier2RulesLegacyWriteContext,
    audit,
    result: { slug, injectMode: effectiveInjectMode, ruleScope, projectId, lintErrors, lintWarnings, ...resultCtx },
    fallbackPath: target,
  });
  if (gateResult) return gateResult;

  const cap = opts.budgetTokenCap ?? DEFAULT_RULE_BUDGET_TOKENS[effectiveInjectMode];

  // Budget is health telemetry only. It intentionally does NOT gate writes:
  // rules injection is moving to catalog/on-demand form, so persistence must
  // not be blocked by full-body prompt-budget pressure.
  const budget = await measureRuleBudget(modeDir, markdown, cap);

  if (fsSync.existsSync(target)) {
    if (opts.exactDuplicateAsDedup && similarActiveRuleAtPath(target, safeBody)) {
      const auditPath = await audit({ operation: "deduped", reason: "semantic_duplicate", against: slug });
      return { slug, path: abrainHome, status: "deduped", reason: `semantic_duplicate:${slug}`, dedupedAgainst: slug, injectMode: effectiveInjectMode, ruleScope, projectId, auditPath, ...resultCtx };
    }
    return reject("duplicate_slug");
  }

  // #2 write-time semantic dedup (T0 consensus 2026-06-07): the glab rule was
  // stated twice + had 2 staging entries; a re-statement must NOT create a near
  // duplicate. If an active rule with a near-identical body already exists, skip
  // the write (the existing rule already carries the intent).
  // PR-4/P0.3 调和 (O2 2026-06-10): the 06-07 consensus targeted exact/near-
  // verbatim restatements; Jaccard ≥ 0.85 similar ≠ exact duplicate, so on the
  // Tier-1 path this probabilistic gate is being migrated from an autonomous
  // kill (R2' violation: it consumes a user directive) to a curator
  // adjudication lane — "report" hands the hit back to the caller, "off"
  // bypasses after adjudication. Default "dedup" stays the sole write path
  // while sediment.tier1JaccardCuratorLane is off (§9.4 migration guardrail).
  if (opts.semanticDedup !== "off") {
    const dedupSlug = findSimilarRuleSlug(abrainHome, ruleScope, projectId, safeBody, slug);
    if (dedupSlug) {
      if (opts.semanticDedup === "report") {
        const auditPath = await audit({ operation: "similar_found", reason: "semantic_similar", against: dedupSlug });
        return { slug, path: abrainHome, status: "similar_found", reason: `semantic_similar:${dedupSlug}`, dedupedAgainst: dedupSlug, injectMode: effectiveInjectMode, ruleScope, projectId, auditPath, ...resultCtx };
      }
      const auditPath = await audit({ operation: "deduped", reason: "semantic_duplicate", against: dedupSlug });
      return { slug, path: abrainHome, status: "deduped", reason: `semantic_duplicate:${dedupSlug}`, dedupedAgainst: dedupSlug, injectMode: effectiveInjectMode, ruleScope, projectId, auditPath, ...resultCtx };
    }
  }

  const sanitizedReplacements = [...titleSan.replacements, ...bodySan.replacements, ...reasonSan.replacements];

  if (opts.dryRun) {
    const auditPath = await audit({ operation: "dry_run", target: path.relative(abrainHome, target), lint_warnings: lintWarnings, budget_tokens: budget.tokens, budget_cap: cap, over_soft_budget: budget.overSoftBudget });
    return { slug, path: target, status: "dry_run", injectMode: effectiveInjectMode, ...(demotedFromAlways ? { demotedFrom: "always" as const } : {}), ruleScope, projectId, lintWarnings, auditPath, sanitizedReplacements, budgetTokens: budget.tokens, budgetCap: cap, overSoftBudget: budget.overSoftBudget, ...resultCtx };
  }

  let lock: LockHandle | undefined;
  try {
    await fs.mkdir(modeDir, { recursive: true, mode: 0o700 });
    lock = await acquireAbrainRuleLock(abrainHome, opts.settings.lockTimeoutMs ?? 5000);
    if (fsSync.existsSync(target)) {
      if (opts.exactDuplicateAsDedup && similarActiveRuleAtPath(target, safeBody)) {
        const auditPath = await audit({ operation: "deduped", reason: "semantic_duplicate", against: slug });
        return { slug, path: abrainHome, status: "deduped", reason: `semantic_duplicate:${slug}`, dedupedAgainst: slug, injectMode: effectiveInjectMode, ruleScope, projectId, auditPath, ...resultCtx };
      }
      return reject("duplicate_slug_race");
    }
    await atomicWrite(target, markdown);
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? await gitCommitAbrain(abrainHome, target, slug, "rules")
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      const rel = path.relative(abrainHome, target);
      try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort */ }
      try { await fs.unlink(target); } catch { /* may be gone */ }
      const auditPath = await audit({ operation: "error", reason: "git_commit_failed_orphan_cleaned", target: path.relative(abrainHome, target) });
      return { slug, path: target, status: "rejected", reason: "git_commit_failed", injectMode: effectiveInjectMode, ruleScope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
    }
    const auditPath = await audit({ operation: "create", target: path.relative(abrainHome, target), lint_result: "pass", lint_warnings: lintWarnings, git_commit: git, budget_tokens: budget.tokens, budget_cap: cap, over_soft_budget: budget.overSoftBudget, routing_confidence: draft.routingConfidence, entry_confidence: draft.entryConfidence, routing_reason: safeDraft.routingReason });
    return { slug, path: target, status: "created", injectMode: effectiveInjectMode, ...(demotedFromAlways ? { demotedFrom: "always" as const } : {}), ruleScope, projectId, lintErrors, lintWarnings, gitCommit: git, publication, auditPath, sanitizedReplacements, budgetTokens: budget.tokens, budgetCap: cap, overSoftBudget: budget.overSoftBudget, ...resultCtx };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await audit({ operation: "error", reason: message, target: path.relative(abrainHome, target) });
    return { slug, path: target, status: "rejected", reason: message, injectMode: effectiveInjectMode, ruleScope, projectId, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}

/** Locate a rule file by slug across both inject modes under the given scope. */
export function findRuleFile(abrainHome: string, scope: "global" | "project", projectId: string | undefined, slug: string): { injectMode: RuleInjectMode; path: string } | undefined {
  const base = rulesBaseDir(path.resolve(abrainHome), scope, projectId);
  for (const mode of ["always", "listed"] as RuleInjectMode[]) {
    const fp = path.join(base, mode, `${slug}.md`);
    if (fsSync.existsSync(fp)) return { injectMode: mode, path: fp };
  }
  return undefined;
}

/** A1 (2026-06-16, ADR-pending ruleset adjudication): list ALL active rules in
 *  a scope (both inject modes), scope-exact (independent of cwd binding), as
 *  candidates for the full-set rule adjudicator. Bodies are timeline-stripped
 *  (reuses readRuleForAdjudication); bodyHash is the frontmatter snapshot used
 *  as the merge TOCTOU witness. Small set (~dozens) — no prefilter.
 *  WARNING: small-set only. Do NOT use for large-corpus full-scan (it reads
 *  every file in scope); the 大库 dedup path (A2) uses embedding retrieval. */
export function listRulesInScope(
  abrainHome: string,
  scope: "global" | "project",
  projectId: string | undefined,
): Array<{ slug: string; title: string; body: string; injectMode: RuleInjectMode; bodyHash?: string }> {
  const base = rulesBaseDir(path.resolve(abrainHome), scope, projectId);
  const out: Array<{ slug: string; title: string; body: string; injectMode: RuleInjectMode; bodyHash?: string }> = [];
  for (const mode of ["always", "listed"] as RuleInjectMode[]) {
    const dir = path.join(base, mode);
    let names: string[];
    try { names = fsSync.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith(".md") || n === "_index.md") continue;
      const slug = n.slice(0, -3);
      const r = readRuleForAdjudication(path.resolve(abrainHome), scope, projectId, slug);
      if (r && r.status === "active") out.push({ slug: r.slug, title: r.title, body: r.body, injectMode: r.injectMode, bodyHash: r.bodyHash });
    }
  }
  return out;
}

/** PR-4/P0.3: read an existing rule for the Tier-1 Jaccard adjudication
 *  prompt — title/status from frontmatter, body WITHOUT the timeline section
 *  (evidence lines would bloat the prompt and skew the merge output). */
export function readRuleForAdjudication(
  abrainHome: string,
  scope: "global" | "project",
  projectId: string | undefined,
  slug: string,
): { slug: string; path: string; injectMode: RuleInjectMode; title: string; status: string; body: string; bodyHash?: string } | undefined {
  const found = findRuleFile(path.resolve(abrainHome), scope, projectId, slug);
  if (!found) return undefined;
  try {
    const raw = fsSync.readFileSync(found.path, "utf-8");
    const { frontmatterText, body } = splitFrontmatter(raw);
    const fm = parseFrontmatter(frontmatterText);
    const bodySansTimeline = body.replace(/^## Timeline[\s\S]*$/m, "").trim();
    return {
      slug,
      path: found.path,
      injectMode: found.injectMode,
      title: typeof fm.title === "string" ? fm.title : slug,
      status: typeof fm.status === "string" ? fm.status : "active",
      body: bodySansTimeline,
      // R1 N5 (opus): TOCTOU witness — the caller threads this back as
      // expectedBodyHash so a concurrent body change between the unlocked
      // read (prompt build) and the locked apply is detected, not clobbered.
      bodyHash: typeof fm.body_hash === "string" ? fm.body_hash : undefined,
    };
  } catch {
    return undefined;
  }
}

export interface Tier1RuleAdjudicationApply {
  op: "update" | "merge";
  /** The new directive quote — appended as timeline evidence. Line-level
   *  dedup (O2: 同 quote 不重复 append 防膨胀): if the normalized quote
   *  already appears anywhere in the file, the apply is an idempotent no-op
   *  returning status "deduped" / reason evidence_duplicate. */
  evidenceQuote: string;
  /** merge only: replaces the rule BODY (frontmatter + timeline preserved,
   *  body_hash recomputed). */
  mergedBody?: string;
  /** Adjudicator rationale, recorded in the timeline note. */
  reason?: string;
  /** merge only (R1 N5): the frontmatter body_hash the adjudicator's input
   *  was read at. If the rule's body_hash changed by apply time (concurrent
   *  writer), the merge is REJECTED with reason "concurrent_modification"
   *  instead of last-write-wins clobbering — the caller's fallback then
   *  lands the directive as a visible create. */
  expectedBodyHash?: string;
}

/** PR-4/P0.3 (O2 2026-06-10): apply a curator adjudication verdict to an
 *  existing rule after a Tier-1 Jaccard near-dup hit.
 *  - update: the existing rule already carries the intent → refresh it
 *    (timeline evidence line + `updated` timestamp). Existing body untouched.
 *  - merge: the directive adds content → replace the body with the
 *    adjudicator-merged text (sanitize + lint gates, body_hash recomputed),
 *    plus timeline note.
 *  Mirrors mutateRuleStatusContested's lock/atomicWrite/git-rollback shape. */
export async function applyTier1RuleAdjudication(
  target: { slug: string; scope: "global" | "project"; projectId?: string },
  apply: Tier1RuleAdjudicationApply,
  opts: WriteRuleOptions,
): Promise<WriteRuleResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const abrainHome = path.resolve(opts.abrainHome);
  const { slug, scope, projectId } = target;
  const sessionId = opts.auditContext?.sessionId;
  const resultCtx = { lane: "rules", sessionId, correlationId: opts.auditContext?.correlationId, candidateId: opts.auditContext?.candidateId };
  const audit = (event: Record<string, unknown>) =>
    appendAbrainAudit(abrainHome, "rules", { scope, ...(projectId ? { project_id: projectId } : {}), slug, op: `tier1_adjudication_${apply.op}`, duration_ms: Date.now() - started, ...resultCtx, ...event });

  const found = findRuleFile(abrainHome, scope, projectId, slug);
  if (!found) {
    const auditPath = await audit({ operation: "reject", reason: "entry_not_found" });
    return { slug, path: abrainHome, status: "rejected", reason: "entry_not_found", ruleScope: scope, projectId, auditPath, ...resultCtx };
  }

  const quoteSan = sanitizeForMemory(apply.evidenceQuote ?? "");
  if (!quoteSan.ok) {
    const auditPath = await audit({ operation: "reject", reason: quoteSan.error });
    return { slug, path: found.path, status: "rejected", reason: quoteSan.error, injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
  }
  const evidenceLine = (quoteSan.text ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const reasonLine = (apply.reason ?? "tier1 jaccard adjudication").replace(/\s+/g, " ").trim().slice(0, 300);

  let lock: LockHandle | undefined;
  try {
    lock = await acquireAbrainRuleLock(abrainHome, opts.settings.lockTimeoutMs ?? 5000);
    const ts = nowIso();
    const raw = await fs.readFile(found.path, "utf-8");

    // Evidence line-level dedup: idempotent no-op when this quote is already
    // carried (body or a previous evidence line) — collapse whitespace on both
    // sides so wrapping differences don't defeat the check.
    if (apply.op === "update" && evidenceLine && raw.replace(/\s+/g, " ").includes(evidenceLine)) {
      const auditPath = await audit({ operation: "deduped", reason: "evidence_duplicate" });
      return { slug, path: found.path, status: "deduped", reason: `evidence_duplicate:${slug}`, dedupedAgainst: slug, injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
    }

    // Canonical frontmatter/body split (R1 N2 opus: no ad-hoc indexOf — an
    // externally-edited body containing a bare "---" line must not corrupt
    // the slice). Frontmatter patching is SCOPED to frontmatterText so a
    // body line that happens to start with "updated:"/"body_hash:" is never
    // mispatched (gpt R1 ②).
    const { frontmatterText, body: fileBody } = splitFrontmatter(raw);
    const tlIdx = fileBody.search(/^## Timeline$/m);
    if (!frontmatterText || tlIdx < 0) {
      const auditPath = await audit({ operation: "reject", reason: "malformed_rule_file" });
      return { slug, path: found.path, status: "rejected", reason: "malformed_rule_file", injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
    }
    let fmPatched = frontmatterText;
    let bodyPatched = fileBody;
    let mergeJaccardVsOld: number | undefined;

    if (apply.op === "merge") {
      const mergedRaw = (apply.mergedBody ?? "").trim();
      if (mergedRaw.length < 10) {
        const auditPath = await audit({ operation: "reject", reason: "validation_error_merged_body" });
        return { slug, path: found.path, status: "rejected", reason: "validation_error_merged_body", injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
      }
      const fm = parseFrontmatter(frontmatterText);
      const currentHash = typeof fm.body_hash === "string" ? fm.body_hash : undefined;
      // R1 N5 (opus): concurrent-modification witness — the body the
      // adjudicator reasoned about must still be the body on disk.
      if (apply.expectedBodyHash && currentHash && apply.expectedBodyHash !== currentHash) {
        const auditPath = await audit({ operation: "reject", reason: "concurrent_modification" });
        return { slug, path: found.path, status: "rejected", reason: "concurrent_modification", injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
      }
      const bodySan = sanitizeForMemory(mergedRaw);
      if (!bodySan.ok) {
        const auditPath = await audit({ operation: "reject", reason: bodySan.error });
        return { slug, path: found.path, status: "rejected", reason: bodySan.error, injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
      }
      // ADR0039 body_hash round-trip fix (T0 2026-06-22): hash the body AFTER
      // the display transforms via the SAME renderRuleBody helper that
      // buildRuleMarkdown uses, so the stamped body_hash equals what the
      // constraint compiler recomputes from the written file (legacy-scan.ts).
      // Previously hashed the pre-transform body → SC_INPUT_BODY_HASH_MISMATCH.
      // mergeJaccardVsOld below keeps using the pre-transform body as an
      // audit-only similarity metric; the idempotency check now compares
      // post-transform hashes on both sides (consistent after re-stamp).
      const hashSource = (bodySan.text ?? mergedRaw).trim();
      const newBody = renderRuleBody(hashSource, typeof fm.title === "string" ? fm.title : slug);
      const newHash = ruleBodyHash(newBody);
      // R1 N4 (opus) / N1 (deepseek): merge idempotency — re-applying a merge
      // that lands the same body (retry, user restatement re-adjudicated)
      // must not rewrite the file or append another timeline note.
      if (currentHash && newHash === currentHash) {
        const auditPath = await audit({ operation: "deduped", reason: "body_unchanged" });
        return { slug, path: found.path, status: "deduped", reason: `body_unchanged:${slug}`, dedupedAgainst: slug, injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
      }
      // R1 N5 (deepseek): audit-only fidelity metric — Jaccard between the
      // merged body and the old body segment. No gate (a legitimate merge
      // may rewrite heavily; false-block → create is worse), but a dogfood
      // distribution skewed low says the adjudicator REWRITES instead of
      // merging and the lane strategy needs a second look before cutover.
      const oldBodySegment = fileBody.slice(0, tlIdx);
      mergeJaccardVsOld = Math.round(ruleBodySimilarity(oldBodySegment, hashSource) * 100) / 100;
      bodyPatched = `\n${newBody}\n\n${fileBody.slice(tlIdx)}`;
      fmPatched = fmPatched.replace(/^body_hash:.*$/m, `body_hash: ${newHash}`);
      const lintErrors = lintMarkdown(`---\n${fmPatched}\n---\n${bodyPatched}`, "rule.md").filter((i) => i.severity === "error").length;
      if (lintErrors > 0) {
        const auditPath = await audit({ operation: "reject", reason: "lint_error" });
        return { slug, path: found.path, status: "rejected", reason: "lint_error", injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
      }
    }

    fmPatched = fmPatched.replace(/^updated:.*$/m, `updated: ${yamlString(ts)}`);
    let patched = `---\n${fmPatched}\n---\n${bodyPatched}`;
    const noteKind = apply.op === "merge" ? "tier1-merge" : "tier1-evidence";
    const note = apply.op === "merge" ? `${reasonLine}${evidenceLine ? ` — ${evidenceLine}` : ""}` : evidenceLine || reasonLine;
    patched = `${patched.trimEnd()}\n- ${ts} | ${sessionId || "sediment"} | ${noteKind} | ${note}\n`;

    await atomicWrite(found.path, patched);
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? await gitCommitAbrain(abrainHome, found.path, slug, `rules:${noteKind}`)
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      const rel = path.relative(abrainHome, found.path);
      try { await atomicWrite(found.path, raw); } catch { /* best-effort restore */ }
      try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort unstage */ }
      const auditPath = await audit({ operation: "reject", reason: "git_commit_failed" });
      return { slug, path: found.path, status: "rejected", reason: "git_commit_failed", injectMode: found.injectMode, ruleScope: scope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
    }
    const auditPath = await audit({ operation: apply.op === "merge" ? "merge" : "update", target: path.relative(abrainHome, found.path), git_commit: git, reason: reasonLine, ...(mergeJaccardVsOld !== undefined ? { merge_jaccard_vs_old: mergeJaccardVsOld } : {}) });
    return { slug, path: found.path, status: "updated", reason: apply.op === "merge" ? "tier1_merged_body" : "tier1_evidence_appended", injectMode: found.injectMode, ruleScope: scope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await audit({ operation: "error", reason: message });
    return { slug, path: found.path, status: "rejected", reason: message, injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}

export interface MutateRuleOptions extends WriteRuleOptions {
  reason?: string;
}

/** ADR 0028 R4 lifecycle: mark a contradicted injected rule as contested. */
export async function mutateRuleStatusContested(
  slug: string,
  scope: "global" | "project",
  projectId: string | undefined,
  opts: MutateRuleOptions,
): Promise<WriteRuleResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const abrainHome = path.resolve(opts.abrainHome);
  const sessionId = opts.auditContext?.sessionId;
  const resultCtx = { lane: "rules", sessionId, correlationId: opts.auditContext?.correlationId, candidateId: opts.auditContext?.candidateId };
  const reason = opts.reason || "contested by sediment outcome edge";
  const audit = (event: Record<string, unknown>) => appendAbrainAudit(abrainHome, "rules", { scope, ...(projectId ? { project_id: projectId } : {}), slug, duration_ms: Date.now() - started, ...resultCtx, ...event });

  const found = findRuleFile(abrainHome, scope, projectId, slug);
  if (!found) {
    const auditPath = await audit({ operation: "reject", op: "contest", reason: "entry_not_found" });
    return { slug, path: abrainHome, status: "rejected", reason: "entry_not_found", ruleScope: scope, projectId, auditPath, ...resultCtx };
  }
  let lock: LockHandle | undefined;
  try {
    lock = await acquireAbrainRuleLock(abrainHome, opts.settings.lockTimeoutMs ?? 5000);
    const ts = nowIso();
    const raw = await fs.readFile(found.path, "utf-8");
    let patched = raw.replace(/^status:.*$/m, `status: ${yamlString("contested")}`);
    patched = patched.replace(/^updated:.*$/m, `updated: ${yamlString(ts)}`);
    if (!/^status:/m.test(patched)) patched = patched.replace(/^---\n/, `---\nstatus: ${yamlString("contested")}\n`);
    patched = `${patched.trimEnd()}\n- ${ts} | ${sessionId || "sediment"} | contested | ${reason.replace(/\n/g, " ")}\n`;
    await atomicWrite(found.path, patched);
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? await gitCommitAbrain(abrainHome, found.path, slug, "rules:contest")
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      const rel = path.relative(abrainHome, found.path);
      try { await atomicWrite(found.path, raw); } catch { /* best-effort restore of pre-contest content */ }
      try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort unstage */ }
      const auditPath = await audit({ operation: "reject", op: "contest", reason: "git_commit_failed" });
      return { slug, path: found.path, status: "rejected", reason: "git_commit_failed", injectMode: found.injectMode, ruleScope: scope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
    }
    const auditPath = await audit({ operation: "contest", inject_mode: found.injectMode, target: path.relative(abrainHome, found.path), git_commit: git, reason });
    return { slug, path: found.path, status: "updated", reason: "contested", injectMode: found.injectMode, ruleScope: scope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await audit({ operation: "error", op: "contest", reason: message });
    return { slug, path: found.path, status: "rejected", reason: message, injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}

/** ADR 0023 D7 lifecycle: archive a rule (status -> archived). The
 *  rule-injector skips status!==active, so an archived rule stops injecting
 *  without being deleted (recoverable). */
export async function archiveAbrainRule(
  slug: string,
  scope: "global" | "project",
  projectId: string | undefined,
  opts: MutateRuleOptions,
): Promise<WriteRuleResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const abrainHome = path.resolve(opts.abrainHome);
  const sessionId = opts.auditContext?.sessionId;
  const resultCtx = { lane: "rules", sessionId, correlationId: opts.auditContext?.correlationId, candidateId: opts.auditContext?.candidateId };
  const reason = opts.reason || "archived by sediment curator";
  const audit = (event: Record<string, unknown>) => appendAbrainAudit(abrainHome, "rules", { scope, ...(projectId ? { project_id: projectId } : {}), slug, duration_ms: Date.now() - started, ...resultCtx, ...event });

  const found = findRuleFile(abrainHome, scope, projectId, slug);
  if (!found) {
    const auditPath = await audit({ operation: "reject", op: "archive", reason: "entry_not_found" });
    return { slug, path: abrainHome, status: "rejected", reason: "entry_not_found", ruleScope: scope, projectId, auditPath, ...resultCtx };
  }
  const gateResult = await applyTier2RulesLegacyWriteGate({
    opts,
    context: opts.tier2RulesLegacyWriteContext,
    audit,
    result: { slug, injectMode: found.injectMode, ruleScope: scope, projectId, ...resultCtx },
    fallbackPath: found.path,
  });
  if (gateResult) return gateResult;
  let lock: LockHandle | undefined;
  try {
    lock = await acquireAbrainRuleLock(abrainHome, opts.settings.lockTimeoutMs ?? 5000);
    const ts = nowIso();
    const raw = await fs.readFile(found.path, "utf-8");
    let patched = raw.replace(/^status:.*$/m, `status: ${yamlString("archived")}`);
    patched = patched.replace(/^updated:.*$/m, `updated: ${yamlString(ts)}`);
    if (!/^status:/m.test(patched)) patched = patched.replace(/^---\n/, `---\nstatus: ${yamlString("archived")}\n`);
    patched = `${patched.trimEnd()}\n- ${ts} | ${sessionId || "sediment"} | archived | ${reason.replace(/\n/g, " ")}\n`;
    await atomicWrite(found.path, patched);
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? await gitCommitAbrain(abrainHome, found.path, slug, "rules:archive")
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    // Audit round-2 P0 (2026-06-07): git-failure rollback parity with
    // writeAbrainRule. Without it a failed commit left the file status-patched
    // + staged in the index and returned "archived" — the next successful
    // sediment write would carry the dirty archive as a ghost commit.
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      const rel = path.relative(abrainHome, found.path);
      try { await atomicWrite(found.path, raw); } catch { /* best-effort restore of pre-archive content */ }
      try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort unstage */ }
      const auditPath = await audit({ operation: "reject", op: "archive", reason: "git_commit_failed" });
      return { slug, path: found.path, status: "rejected", reason: "git_commit_failed", injectMode: found.injectMode, ruleScope: scope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
    }
    const auditPath = await audit({ operation: "archive", inject_mode: found.injectMode, target: path.relative(abrainHome, found.path), git_commit: git, reason });
    return { slug, path: found.path, status: "archived", injectMode: found.injectMode, ruleScope: scope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await audit({ operation: "error", op: "archive", reason: message });
    return { slug, path: found.path, status: "rejected", reason: message, injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}

/** ADR 0023 D7 lifecycle: hard-delete a rule (rare; schema corruption / user
 *  explicit removal). Prefer archive for normal retirement. */
export async function deleteAbrainRule(
  slug: string,
  scope: "global" | "project",
  projectId: string | undefined,
  opts: MutateRuleOptions,
): Promise<WriteRuleResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const abrainHome = path.resolve(opts.abrainHome);
  const sessionId = opts.auditContext?.sessionId;
  const resultCtx = { lane: "rules", sessionId, correlationId: opts.auditContext?.correlationId, candidateId: opts.auditContext?.candidateId };
  const audit = (event: Record<string, unknown>) => appendAbrainAudit(abrainHome, "rules", { scope, ...(projectId ? { project_id: projectId } : {}), slug, duration_ms: Date.now() - started, ...resultCtx, ...event });

  const found = findRuleFile(abrainHome, scope, projectId, slug);
  if (!found) {
    const auditPath = await audit({ operation: "reject", op: "delete", reason: "entry_not_found" });
    return { slug, path: abrainHome, status: "rejected", reason: "entry_not_found", ruleScope: scope, projectId, auditPath, ...resultCtx };
  }
  const gateResult = await applyTier2RulesLegacyWriteGate({
    opts,
    context: opts.tier2RulesLegacyWriteContext,
    audit,
    result: { slug, injectMode: found.injectMode, ruleScope: scope, projectId, ...resultCtx },
    fallbackPath: found.path,
  });
  if (gateResult) return gateResult;
  let lock: LockHandle | undefined;
  try {
    lock = await acquireAbrainRuleLock(abrainHome, opts.settings.lockTimeoutMs ?? 5000);
    // Audit round-2 P0 (2026-06-07): capture the original content BEFORE unlink so
    // a git-commit failure can restore the file. Previously delete unlinked first,
    // then on git failure returned "deleted" with the file already gone + the
    // deletion staged — unrecoverable data loss + a ghost deletion in the next commit.
    const originalRaw = await fs.readFile(found.path, "utf-8");
    await fs.unlink(found.path);
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? await gitCommitAbrain(abrainHome, found.path, slug, "rules:delete")
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      const rel = path.relative(abrainHome, found.path);
      try { await atomicWrite(found.path, originalRaw); } catch { /* best-effort restore of deleted file */ }
      try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort unstage */ }
      const auditPath = await audit({ operation: "reject", op: "delete", reason: "git_commit_failed" });
      return { slug, path: found.path, status: "rejected", reason: "git_commit_failed", injectMode: found.injectMode, ruleScope: scope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
    }
    const auditPath = await audit({ operation: "delete", inject_mode: found.injectMode, target: path.relative(abrainHome, found.path), git_commit: git });
    return { slug, path: found.path, status: "deleted", injectMode: found.injectMode, ruleScope: scope, projectId, gitCommit: git, publication, auditPath, ...resultCtx };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await audit({ operation: "error", op: "delete", reason: message });
    return { slug, path: found.path, status: "rejected", reason: message, injectMode: found.injectMode, ruleScope: scope, projectId, auditPath, ...resultCtx };
  } finally {
    await lock?.release();
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Lane G writer: writeAbrainAboutMe (ADR 0021)
// ───────────────────────────────────────────────────────────────────────────────
// G1 scope per ADR 0021 §"实施 phase":
//   - writer + sanitizer/lint/lock/audit/git commit substrate
//   - validateRouteDecision enforcer (from about-me-router.ts)
//   - smoke fixture covering: three regions happy / validation_error /
//     sanitizer reject / router rule violations / git rollback / dedupe
//
// Mirrors writeAbrainWorkflow's substrate (lock + atomic write + audit +
// git commit + git rollback). Region selects the target dir:
//   identity  -> ~/.abrain/identity/<slug>.md
//   skills    -> ~/.abrain/skills/<slug>.md
//   habits    -> ~/.abrain/habits/<slug>.md
//   staging   -> ~/.abrain/projects/<active>/observations/staging/
//                 <YYYY-MM-DD>--<pid>--<sessionStartEpoch>.md
//
// Slug uniqueness is enforced ACROSS identity+skills+habits (3-zone scan);
// staging entries are date+pid+epoch-keyed and out of slug-collision scope.

export interface AboutMeDraft {
  title: string;
  body: string;
  region: AboutMeRegion;
  routingConfidence: number;
  routeCandidates: AboutMeRegion[];
  routingReason: string;
  /** Mirrors WorkflowDraft semantics: optional trigger phrases (retrieval anchors), tags, slug override. */
  triggerPhrases?: string[];
  tags?: string[];
  status?: EntryStatus;
  slug?: string;
  timelineNote?: string;
  sessionId?: string;
  /** When region==="staging", these locate the staging file path. Required for staging writes. */
  stagingProjectId?: string;
  stagingSessionEpoch?: number;
}

export interface WriteAboutMeOptions {
  abrainHome: string;
  settings: SedimentSettings;
  dryRun?: boolean;
  auditContext?: WriterAuditContext;
}

export interface WriteAboutMeResult {
  slug: string;
  path: string;
  status: "created" | "skipped" | "dry_run" | "rejected";
  reason?: string;
  region?: AboutMeRegion;
  lintErrors?: number;
  lintWarnings?: number;
  gitCommit?: string | null;
  publication?: WriterPublicationResult;
  auditPath?: string;
  sanitizedReplacements?: string[];
  validationErrors?: Array<{ field: string; message: string }>;
  routeRejected?: { rule: number; message: string };
  lane?: string;
  sessionId?: string;
  correlationId?: string;
  candidateId?: string;
}

function validateAboutMeDraft(draft: AboutMeDraft): Array<{ field: string; message: string }> {
  const issues: Array<{ field: string; message: string }> = [];
  if (typeof draft.title !== "string" || draft.title.trim().length === 0) {
    issues.push({ field: "title", message: "title is required" });
  } else if (draft.title.length > 200) {
    issues.push({ field: "title", message: "title must be ≤ 200 characters" });
  }
  if (typeof draft.body !== "string" || draft.body.trim().length < 20) {
    issues.push({ field: "body", message: "body must be at least 20 characters" });
  }
  // Region enum gate (P0-2 audit fix 2026-05-15, refactored 2026-05-16 P1-A).
  // TypeScript narrows the signature to AboutMeRegion, but in production the
  // fence extractor returns ExtractedAboutMeDraft with `region?: AboutMeRegion`
  // (optional), and G2 transcript-injected fences can carry region: undefined.
  // Without this guard, the writer falls through kindByRegion[undefined] ===
  // undefined and writes a frontmatter `kind: undefined` literal. The router's
  // validateRouteDecision rule 1 catches it later, but only AFTER we'd already
  // passed validation — routing the failure as route_rejected instead of
  // validation_error and burning a sample file. Catch it here.
  // Single source of truth: LANE_G_ALLOWED_REGIONS in about-me-router.ts.
  if (typeof draft.region !== "string" || !LANE_G_ALLOWED_REGIONS.includes(draft.region as AboutMeRegion)) {
    issues.push({ field: "region", message: `region must be one of: ${LANE_G_ALLOWED_REGIONS.join(", ")}` });
  }
  // Routing-confidence gate (P1-C audit fix 2026-05-16). Symmetric with the
  // region gate above: garbage input should fail-fast as validation_error
  // before the router (which would otherwise charge it a route_rejected
  // + a sample file). Router rule 6 still runs as defense-in-depth.
  if (typeof draft.routingConfidence !== "number" || !Number.isFinite(draft.routingConfidence)) {
    issues.push({ field: "routingConfidence", message: "routingConfidence must be a finite number" });
  } else if (draft.routingConfidence < 0 || draft.routingConfidence > 1) {
    issues.push({ field: "routingConfidence", message: "routingConfidence must be in [0, 1]" });
  }
  // Status enum check (ENTRY_STATUSES) mirrors validateWorkflowDraft (Round 8 P1).
  if (draft.status !== undefined) {
    if (typeof draft.status !== "string" || !(ENTRY_STATUSES as readonly string[]).includes(draft.status)) {
      issues.push({ field: "status", message: `status must be one of: ${ENTRY_STATUSES.join(", ")}` });
    }
  }
  // Staging requires a project id + session epoch to land in the right
  // staging file (per ADR 0014 §3.5: <YYYY-MM-DD>--<pid>--<sessionEpoch>.md).
  if (draft.region === "staging") {
    if (typeof draft.stagingProjectId !== "string" || draft.stagingProjectId.length === 0) {
      issues.push({ field: "stagingProjectId", message: "stagingProjectId is required when region=staging" });
    } else {
      try { validateAbrainProjectId(draft.stagingProjectId); }
      catch (e) { issues.push({ field: "stagingProjectId", message: (e as Error).message }); }
    }
    if (typeof draft.stagingSessionEpoch !== "number" || !Number.isFinite(draft.stagingSessionEpoch)) {
      issues.push({ field: "stagingSessionEpoch", message: "stagingSessionEpoch (number) is required when region=staging" });
    }
  }
  return issues;
}

/** Build markdown for Lane G entry. Frontmatter shape per ADR 0021 D5. */
function buildAboutMeMarkdown(draft: AboutMeDraft, slug: string): string {
  const timestamp = nowIso();
  const status = draft.status ?? "active";
  // ENTRY_KINDS-canonical mapping per ADR 0021 Q1:
  //   identity → maxim   (stable self-description, high-trust)
  //   skills   → fact    (declarative inventory)
  //   habits   → pattern (recurring behavioral pattern)
  //   staging  → fact    (defer classification until reviewed)
  // Falling back to a deterministic kind keeps memory_search rerank +
  // doctor enums happy without inventing new EntryKind values.
  const kindByRegion: Record<AboutMeRegion, EntryKind> = {
    identity: "maxim" as EntryKind,
    skills: "fact" as EntryKind,
    habits: "pattern" as EntryKind,
    staging: "fact" as EntryKind,
  };
  const kind = kindByRegion[draft.region];
  const id = `about-me:${draft.region}:${slug}`;
  const tags = (draft.tags ?? []).map((t) => t.trim()).filter(Boolean);
  const timelineSession = draft.sessionId || "sediment";
  const timelineNote = draft.timelineNote || "created by sediment about-me writer (Lane G)";

  // routing_confidence is normalized to 2-decimal-place float (P1-5 audit
  // fix 2026-05-15). Without toFixed, node template literals render 1.0
  // as "1" (int) and 0.95 as "0.95" (float); a YAML parser then types
  // them differently on round-trip. Forcing 2dp keeps the field strictly
  // float-shaped for downstream consumers (frontmatter parser, doctor,
  // future G3 router replay).
  const conf2dp = (draft.routingConfidence).toFixed(2);

  const fmLines: string[] = [];
  fmLines.push("---");
  fmLines.push(`id: ${yamlString(id)}`);
  fmLines.push(`title: ${yamlString(draft.title)}`);
  // scope is the canonical memory-architecture binary (world|project), per
  // memory/types.ts Scope type. Lane G entries are world-scoped ("about
  // alfadb", cross-project). Region is a Lane-G-specific sub-classification
  // carried separately below. Previously this field was `scope: about_me`
  // which the read-side parseEntry silently dropped (parser.ts §scopeRaw
  // check only accepts "world" / "project") — P0-1 audit fix 2026-05-15.
  // Exception: staging entries are physically under projects/<id>/
  // observations/staging/, so their scope is project; they're picked up
  // by the project-scope walker for review-staging (G4) tooling.
  fmLines.push(`scope: ${draft.region === "staging" ? "project" : "world"}`);
  fmLines.push(`kind: ${yamlString(kind)}`);
  fmLines.push(`status: ${yamlString(status)}`);
  fmLines.push(`confidence: 5`);
  fmLines.push(...yamlList("trigger_phrases", draft.triggerPhrases));
  fmLines.push(...yamlList("tags", tags));
  fmLines.push(`created: ${yamlString(timestamp)}`);
  fmLines.push(`updated: ${yamlString(timestamp)}`);
  fmLines.push(`schema_version: 1`);
  // Lane G-specific (ADR 0021 D5).
  fmLines.push(`lane: about_me`);
  fmLines.push(`region: ${yamlString(draft.region)}`);
  fmLines.push(...yamlList("route_candidates", draft.routeCandidates));
  fmLines.push(`routing_reason: ${yamlString(draft.routingReason)}`);
  fmLines.push(`routing_confidence: ${conf2dp}`);
  fmLines.push("---");

  // Body normalization: ensure `# <title>` heading; escape bare `---`
  // lines so they don't accidentally close frontmatter on round-trip.
  let body = draft.body.trim();
  body = body.replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  body = body.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(body)) body = `# ${draft.title}\n\n${body}`;

  const timeline = `## Timeline\n- ${timestamp} | ${timelineSession} | created | ${timelineNote}`;
  return `${fmLines.join("\n")}\n\n${body.trim()}\n\n${timeline}\n`;
}

async function acquireAbrainAboutMeLock(abrainHome: string, timeoutMs: number): Promise<LockHandle> {
  // Independent from workflow.lock so Lane G writes don't block on a
  // concurrent workflow write and vice versa.
  const lockPath = path.join(abrainSedimentLocksDir(abrainHome), "about-me.lock");
  const handle = await acquireFileLock(lockPath, {
    timeoutMs,
    staleMs: SEDIMENT_LOCK_STEAL_AFTER_MS,
    retryMs: 100,
    label: "abrain about-me",
  });
  return { release: handle.release };
}

async function appendAbrainAboutMeAudit(abrainHome: string, event: Record<string, unknown>): Promise<string> {
  return appendAbrainAudit(abrainHome, "about_me", event);
}

async function gitCommitAbrainAboutMe(
  abrainHome: string,
  filePath: string,
  slug: string,
  region: AboutMeRegion,
): Promise<WriterPublicationResult> {
  if (canonicalGitRuntimeEnabled()) {
    return canonicalCommitExplicitPaths(
      abrainHome,
      [filePath],
      `about-me: ${slug} [${region}] (lane=about_me)`,
      `about-me:${region}:${slug}`,
    );
  }
  return legacyPublication(await gitSingleFlight(abrainHome, () =>
    gitCommitAbrainAboutMeUnlocked(abrainHome, filePath, slug, region)));
}

async function gitCommitAbrainAboutMeUnlocked(
  abrainHome: string,
  filePath: string,
  slug: string,
  region: AboutMeRegion,
): Promise<string | null> {
  try {
    const rel = path.relative(abrainHome, filePath);
    await execFileAsync("git", ["-C", abrainHome, "add", "--", rel], { timeout: 5_000, maxBuffer: 512 * 1024 });
    await execFileAsync("git", ["-C", abrainHome, "commit", "-m", `about-me: ${slug} [${region}] (lane=about_me)`], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    const { stdout } = await execFileAsync("git", ["-C", abrainHome, "rev-parse", "HEAD"], { timeout: 5_000, maxBuffer: 128 * 1024 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Resolve target file path for given draft. Staging path is
 *  date+pid+epoch keyed per ADR 0014 §3.5. */
function resolveAboutMeTarget(abrainHome: string, draft: AboutMeDraft, slug: string): { dir: string; file: string } {
  if (draft.region === "staging") {
    const projectId = draft.stagingProjectId!;
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const stagingDir = path.join(
      abrainProjectDir(abrainHome, projectId),
      "observations",
      "staging",
    );
    // P0-A audit fix 2026-05-16: include Date.now() in the filename so
    // two staging writes within the same pi session (same epoch) on the
    // same day from the same pid land in distinct files.
    //
    // P1-B audit fix 2026-05-16 (round 3 opus-4-6): add an 8-hex-char
    // crypto-random suffix because Date.now() resolution is ms and not
    // monotonic across NTP adjustments — a `Promise.all([write(A),
    // write(B)])` with same pid+epoch+ms still collided previously,
    // P0-A's fix did not cover that. randomBytes(4) gives 2^32 entropy
    // per file; collision is astronomically unlikely. Date.now() is kept
    // for human readability of recency in `ls -1` listings.
    const file = path.join(
      stagingDir,
      `${today}--${process.pid}--${draft.stagingSessionEpoch}--${Date.now()}--${randomBytes(4).toString("hex")}.md`,
    );
    return { dir: stagingDir, file };
  }
  const dir = abrainAboutMeDirByRegion(abrainHome, draft.region);
  return { dir, file: path.join(dir, `${slug}.md`) };
}

/** Scan identity+skills+habits for a slug collision; returns true iff
 *  any zone already contains `<slug>.md`. */
function aboutMeSlugCollidesAcrossZones(abrainHome: string, slug: string): boolean {
  for (const dir of [abrainIdentityDir(abrainHome), abrainSkillsDir(abrainHome), abrainHabitsDir(abrainHome)]) {
    if (fsSync.existsSync(path.join(dir, `${slug}.md`))) return true;
  }
  return false;
}

/**
 * Write a Lane G about-me entry to identity/skills/habits/staging.
 *
 * Substrate mirrors writeAbrainWorkflow:
 *   1. validation (schema + region-specific fields)
 *   2. router enforcement (validateRouteDecision; auto-downgrade to
 *      staging when confidence < threshold via applyStagingDowngrade)
 *   3. sanitize free-text fields (title/body/triggerPhrases/tags/note)
 *   4. build markdown (frontmatter v1 + body + Timeline)
 *   5. lint (errors reject; warnings recorded)
 *   6. dedupe across 3 zones (identity+skills+habits) by slug
 *   7. lock (~/.abrain/.state/sediment/locks/about-me.lock)
 *   8. atomic write + git commit + audit row (lane=about_me)
 *
 * On `git commit` failure: orphan file is unlinked and `git reset HEAD --
 * <rel>` clears the staged ghost (parity with writeAbrainWorkflow).
 */
export async function writeAbrainAboutMe(
  draft: AboutMeDraft,
  opts: WriteAboutMeOptions,
): Promise<WriteAboutMeResult> {
  await assertCanonicalWriterSettings(opts.abrainHome, opts.settings);
  const started = Date.now();
  const abrainHome = path.resolve(opts.abrainHome);
  const sessionId = opts.auditContext?.sessionId ?? draft.sessionId;
  const lane = "about_me";
  const resultCtx = {
    lane,
    sessionId,
    correlationId: opts.auditContext?.correlationId,
    candidateId: opts.auditContext?.candidateId,
  };

  // 1. Validation.
  const validationErrors = validateAboutMeDraft(draft);
  if (validationErrors.length > 0) {
    const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
      operation: "reject",
      reason: "validation_error",
      title: draft.title,
      region: draft.region,
      validationErrors,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug: slugify(draft.title || "about-me"),
      path: abrainHome,
      status: "rejected",
      reason: "validation_error",
      region: draft.region,
      validationErrors,
      auditPath,
      ...resultCtx,
    };
  }

  // 2. Router enforcement. Auto-downgrade low-confidence first; then
  // validate. Caller is expected to pass `route_candidates` already.
  const rawDecision: RouteDecision = {
    lane: "about_me",
    chosen_region: draft.region,
    route_candidates: draft.routeCandidates,
    routing_reason: draft.routingReason,
    routing_confidence: draft.routingConfidence,
  };
  const decision = applyStagingDowngrade(rawDecision);

  // P0-1 audit fix 2026-05-16 (round 3 opus-4-6): post-downgrade staging
  // field check. applyStagingDowngrade may flip chosen_region to
  // "staging" when confidence < threshold; in that case stagingProjectId
  // / stagingSessionEpoch become REQUIRED but the upstream
  // validateAboutMeDraft only checked them when draft.region was
  // ALREADY "staging" (pre-downgrade). Without this, a downgrade-to-
  // staging with missing stagingProjectId throws an unhandled exception
  // at resolveAboutMeTarget's `draft.stagingProjectId!` non-null
  // assertion — violating the writer's "always returns WriteAboutMeResult"
  // contract. G2 wire-up triggers this on every low-confidence fence
  // (the extractor doesn't supply stagingProjectId; it's a writer-time
  // concept resolved from the active project).
  if (decision.chosen_region === "staging" && draft.region !== "staging") {
    const stagingValidationErrors: Array<{ field: string; message: string }> = [];
    if (typeof draft.stagingProjectId !== "string" || draft.stagingProjectId.length === 0) {
      stagingValidationErrors.push({
        field: "stagingProjectId",
        message: "stagingProjectId is required when router downgrades to staging (confidence < threshold)",
      });
    } else {
      try { validateAbrainProjectId(draft.stagingProjectId); }
      catch (e) { stagingValidationErrors.push({ field: "stagingProjectId", message: (e as Error).message }); }
    }
    if (typeof draft.stagingSessionEpoch !== "number" || !Number.isFinite(draft.stagingSessionEpoch)) {
      stagingValidationErrors.push({
        field: "stagingSessionEpoch",
        message: "stagingSessionEpoch (number) is required when router downgrades to staging",
      });
    }
    if (stagingValidationErrors.length > 0) {
      const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
        operation: "reject",
        reason: "validation_error",
        title: draft.title,
        region: decision.chosen_region,
        router_downgrade: true,
        validationErrors: stagingValidationErrors,
        duration_ms: Date.now() - started,
        ...resultCtx,
      });
      return {
        slug: slugify(draft.title || "about-me"),
        path: abrainHome,
        status: "rejected",
        reason: "validation_error",
        region: decision.chosen_region,
        validationErrors: stagingValidationErrors,
        auditPath,
        ...resultCtx,
      };
    }
  }

  try {
    validateRouteDecision(decision);
  } catch (e: unknown) {
    const err = e instanceof RouterError ? e : new RouterError(0, e instanceof Error ? e.message : String(e));
    // Per ADR 0014 §3.5: write a route_rejected audit row AND drop the
    // original input into staging/rejected/ so the sample isn't silently
    // lost. Staging-rejected files are best-effort (no lock; small).
    const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
      operation: "route_rejected",
      reason: err.message,
      router_rule: err.rule,
      title: draft.title,
      region: draft.region,
      routing_confidence: draft.routingConfidence,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    if (draft.stagingProjectId) {
      try {
        // P0-3 (2026-05-15) + P1-B/P2-A (2026-05-16 round 3):
        // Filename shape `<date>--<pid>--<epoch>--<ms>--<hex8>.md`.
        // Date.now() gives ms-resolution wall time (NOT monotonic — NTP
        // step can roll back); the 8-hex-char crypto suffix
        // (2^32 entropy) makes same-ms collisions astronomically
        // unlikely under Promise.all concurrency. We use plain
        // fs.writeFile (not `wx`) because the sample file is diagnostic
        // only — the audit row above is the canonical record.
        const today = new Date().toISOString().slice(0, 10);
        const rejectedDir = path.join(
          abrainProjectDir(abrainHome, draft.stagingProjectId),
          "observations",
          "staging",
          "rejected",
        );
        await fs.mkdir(rejectedDir, { recursive: true });
        const sample = path.join(
          rejectedDir,
          `${today}--${process.pid}--${draft.stagingSessionEpoch ?? "none"}--${Date.now()}--${randomBytes(4).toString("hex")}.md`,
        );
        await fs.writeFile(
          sample,
          `# rejected about-me sample\n\nrouter_rule: ${err.rule}\nreason: ${err.message}\nregion: ${draft.region}\nconfidence: ${draft.routingConfidence}\n\n---\n\n${draft.title}\n\n${draft.body}\n`,
          "utf-8",
        );
      } catch { /* best-effort */ }
    } else {
      // P1-E audit fix 2026-05-16: caller without a project anchor still
      // gets sample preservation, just under an abrain-home-level orphan
      // dir. Without this branch a route_rejected with stagingProjectId
      // missing would silently lose the input — violating ADR 0014 §3.5
      // "避免静默丢入作样本". orphan-rejects lives under .state/ so it's
      // local-only (not committed to abrain git), matching the sample
      // file's diagnostic-only role.
      try {
        const today = new Date().toISOString().slice(0, 10);
        const orphanDir = path.join(abrainHome, ".state", "sediment", "orphan-rejects");
        await fs.mkdir(orphanDir, { recursive: true });
        // P1-B audit fix 2026-05-16 (round 3): add crypto-random suffix
        // for the same reasons as staging happy + reject paths.
        const sample = path.join(orphanDir, `${today}--${process.pid}--${Date.now()}--${randomBytes(4).toString("hex")}.md`);
        await fs.writeFile(
          sample,
          `# orphan rejected about-me sample (no project anchor)\n\nrouter_rule: ${err.rule}\nreason: ${err.message}\nregion: ${draft.region}\nconfidence: ${draft.routingConfidence}\n\n---\n\n${draft.title}\n\n${draft.body}\n`,
          "utf-8",
        );
      } catch { /* best-effort */ }
    }
    return {
      slug: slugify(draft.title || "about-me"),
      path: abrainHome,
      status: "rejected",
      reason: "route_rejected",
      region: draft.region,
      routeRejected: { rule: err.rule, message: err.message },
      auditPath,
      ...resultCtx,
    };
  }

  // 3. Sanitize free-text fields.
  const titleSan = sanitizeForMemory(draft.title);
  const bodySan = sanitizeForMemory(draft.body);
  const reasonSan = sanitizeForMemory(decision.routing_reason);
  const noteSan = draft.timelineNote
    ? sanitizeForMemory(draft.timelineNote)
    : { ok: true as const, text: undefined, replacements: [] as string[] };
  const trigSans = (draft.triggerPhrases ?? []).map((t) => sanitizeForMemory(t));
  const tagSans = (draft.tags ?? []).map((t) => sanitizeForMemory(t));
  const failed = [titleSan, bodySan, reasonSan, noteSan, ...trigSans, ...tagSans].find((r) => !r.ok);
  if (failed) {
    const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
      operation: "reject",
      reason: (failed as { ok: false; error: string }).error,
      title: draft.title,
      region: decision.chosen_region,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug: slugify(draft.title),
      path: abrainHome,
      status: "rejected",
      reason: (failed as { ok: false; error: string }).error,
      region: decision.chosen_region,
      auditPath,
      ...resultCtx,
    };
  }

  const sanitizedReplacements = [
    ...titleSan.replacements,
    ...bodySan.replacements,
    ...reasonSan.replacements,
    ...noteSan.replacements,
    ...trigSans.flatMap((s) => s.replacements),
    ...tagSans.flatMap((s) => s.replacements),
  ];

  const safeDraft: AboutMeDraft = {
    ...draft,
    title: titleSan.text ?? draft.title,
    body: bodySan.text ?? draft.body,
    region: decision.chosen_region,
    routeCandidates: decision.route_candidates,
    routingReason: reasonSan.text ?? decision.routing_reason,
    routingConfidence: decision.routing_confidence,
    timelineNote: draft.timelineNote ? noteSan.text : draft.timelineNote,
    triggerPhrases: draft.triggerPhrases ? trigSans.map((s, i) => s.text ?? draft.triggerPhrases![i]) : draft.triggerPhrases,
    tags: draft.tags ? tagSans.map((s, i) => s.text ?? draft.tags![i]) : draft.tags,
    // P1-B audit fix 2026-05-16: timeline sessionId and audit sessionId
    // must come from the same resolved value, otherwise markdown timeline
    // shows draft.sessionId || "sediment" while audit shows opts.audit­
    // Context.sessionId ?? draft.sessionId — cross-line reconciliation
    // breaks. Force them equal via the resolved `sessionId` above.
    sessionId,
  };

  const slug = (draft.slug && slugify(draft.slug)) || slugify(safeDraft.title);
  const { dir: targetDir, file: target } = resolveAboutMeTarget(abrainHome, safeDraft, slug);
  await fs.mkdir(targetDir, { recursive: true });

  // 6. Dedupe (skip for staging — staging files are time-keyed, not
  // slug-keyed; multiple staging samples per day are append-style).
  if (safeDraft.region !== "staging" && aboutMeSlugCollidesAcrossZones(abrainHome, slug)) {
    const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
      operation: "reject",
      reason: "duplicate_slug",
      target: `about-me:${safeDraft.region}:${slug}`,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "duplicate_slug",
      region: safeDraft.region,
      auditPath,
      ...resultCtx,
    };
  }

  // 4. Build markdown + 5. lint.
  const markdown = buildAboutMeMarkdown(safeDraft, slug);
  const lintIssues = lintMarkdown(markdown, target);
  const lintErrors = lintIssues.filter((i) => i.severity === "error").length;
  const lintWarnings = lintIssues.filter((i) => i.severity === "warning").length;
  if (lintErrors > 0) {
    const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
      operation: "reject",
      reason: "lint_error",
      target: path.relative(abrainHome, target),
      lint_errors: lintErrors,
      lint_warnings: lintWarnings,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: "lint_error",
      region: safeDraft.region,
      lintErrors,
      lintWarnings,
      auditPath,
      ...resultCtx,
    };
  }

  if (opts.dryRun) {
    const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
      operation: "dry_run",
      target: path.relative(abrainHome, target),
      region: safeDraft.region,
      lint_warnings: lintWarnings,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "dry_run",
      region: safeDraft.region,
      lintWarnings,
      auditPath,
      sanitizedReplacements,
      ...resultCtx,
    };
  }

  // 7. Lock + 8. atomic write + git commit + audit row.
  let lock: LockHandle | undefined;
  try {
    lock = await acquireAbrainAboutMeLock(abrainHome, opts.settings.lockTimeoutMs ?? 5000);
    // Lock-held duplicate re-check (mirror writeAbrainWorkflow @ R6 P0).
    if (safeDraft.region !== "staging" && aboutMeSlugCollidesAcrossZones(abrainHome, slug)) {
      const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
        operation: "reject",
        reason: "duplicate_slug_race",
        target: `about-me:${safeDraft.region}:${slug}`,
        duration_ms: Date.now() - started,
        ...resultCtx,
      });
      return {
        slug,
        path: target,
        status: "rejected",
        reason: "duplicate_slug_race",
        region: safeDraft.region,
        auditPath,
        ...resultCtx,
      };
    }
    await atomicWrite(target, markdown);
    const publication: WriterPublicationResult = opts.settings.gitCommit
      ? await gitCommitAbrainAboutMe(abrainHome, target, slug, safeDraft.region)
      : { status: "clean", commit: null, localCommit: "not_published", drainStatus: "git_commit_disabled", canonical: false };
    const git = publication.commit;
    // Git rollback path (parity with writeAbrainWorkflow R9 P1-3 + R5
    // P4): if git commit fails we have an orphan markdown + staged
    // ghost. Clear both before returning rejected.
    if (opts.settings.gitCommit && publicationNeedsCleanup(publication)) {
      const rel = path.relative(abrainHome, target);
      try { await execFileAsync("git", ["-C", abrainHome, "reset", "HEAD", "--", rel], { timeout: 5_000, maxBuffer: 128 * 1024 }); } catch { /* best-effort */ }
      try { await fs.unlink(target); } catch { /* file may already be gone */ }
      const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
        operation: "error",
        target: rel,
        region: safeDraft.region,
        reason: "git_commit_failed_orphan_cleaned",
        lint_result: "pass",
        lint_warnings: lintWarnings,
        git_commit: null,
        duration_ms: Date.now() - started,
        ...resultCtx,
      });
      return {
        slug,
        path: target,
        status: "rejected",
        reason: "git_commit_failed",
        region: safeDraft.region,
        gitCommit: git,
        publication,
        auditPath,
        ...resultCtx,
      };
    }
    const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
      operation: "create",
      target: path.relative(abrainHome, target),
      region: safeDraft.region,
      routing_confidence: safeDraft.routingConfidence,
      route_candidates: safeDraft.routeCandidates,
      routing_reason: safeDraft.routingReason,
      lint_result: "pass",
      lint_warnings: lintWarnings,
      git_commit: git,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "created",
      region: safeDraft.region,
      lintErrors,
      lintWarnings,
      gitCommit: git,
      publication,
      auditPath,
      sanitizedReplacements,
      ...resultCtx,
    };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    const auditPath = await appendAbrainAboutMeAudit(abrainHome, {
      operation: "error",
      target: path.relative(abrainHome, target),
      region: safeDraft.region,
      reason: message,
      duration_ms: Date.now() - started,
      ...resultCtx,
    });
    return {
      slug,
      path: target,
      status: "rejected",
      reason: message,
      region: safeDraft.region,
      auditPath,
      ...resultCtx,
    };
  } finally {
    await lock?.release();
  }
}
