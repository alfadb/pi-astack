/**
 * entry-lifecycle-proposals — Outcome/Truth-change -> Entry lifecycle proposal sidecar.
 *
 * Original M3 source is the AFFIRMATIVE LLM channel: `promoted_advisories[]`
 * carrying a `lifecycle_proposal`. D* Phase 1 adds a deterministic bridge from
 * current entry frontmatter: status=superseded + valid non-self superseded_by
 * becomes execution-ready archive proposal with expected_status=superseded; a
 * standing superseded entry without a valid successor becomes review_required
 * only and is not executable in Phase 1.
 *
 * HARD BOUNDARIES:
 *   - NEVER writes durable entry markdown. NEVER imports / calls the writer,
 *     curator, archive, or multi-view. NO LLM. NO user surface.
 *   - It ONLY writes ~/.abrain/.state/sediment/entry-lifecycle-proposals.jsonl.
 *     The gated executor is the sole consumer.
 *   - Usage-only signals are not accepted by this module.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  abrainProjectDir,
  ensureUserGlobalSidecarMigrated,
  formatLocalIsoTimestamp,
  resolveActiveProject,
  resolveUserGlobalAbrainHome,
  userGlobalSedimentDir,
} from "../_shared/runtime";
import { getCurrentAnchor, spreadAnchor } from "../_shared/causal-anchor";
import { withFileLock, atomicWriteText } from "../_shared/sync-file-lock";
import type { Jsonish, MemoryEntry, RelationEdge } from "../memory/types";
import type { LifecycleProposal, PromotedAdvisory } from "./aggregator-llm";

export type LifecycleProposalReason = LifecycleProposal["reason"] | "superseded_no_successor";
export type LifecycleProposalStatus = "pending" | "executed" | "failed";
export type LifecycleProposalDisposition = "execution_ready" | "review_required";
export type LifecycleProposalExpectedStatus = "active" | "superseded";
export type LifecycleProposalEvidenceSource = "aggregator_promoted_advisory" | "frontmatter_superseded";

export interface EntryLifecycleProposalRow {
  schema_version: 1;
  ts: string;
  project_root: string;
  /** Durable entry the proposal concerns. */
  slug?: string;
  kind: string;
  op: LifecycleProposal["op"];
  reason: LifecycleProposalReason;
  independent_evidence: string;
  falsifier: string;
  message?: string;
  /** Executor CAS precondition. Legacy LLM proposals default to active. */
  expected_status?: LifecycleProposalExpectedStatus;
  /** Phase 1 safety gate: only execution_ready rows may be executed. */
  disposition?: LifecycleProposalDisposition;
  /** Stable source/key pair used for idempotent deterministic replays. */
  evidence_source?: LifecycleProposalEvidenceSource;
  evidence_key?: string;
  /** Stable join key derived from the proposal identity. */
  proposal_id?: string;
  /** Stable join key for the proposal this row supersedes, when known. */
  supersedes_proposal_id?: string;
  /** Coarse evidence class for audit/ledger aggregation. */
  evidence_type?: string;
  /** E1 successor target when known. */
  target_slug?: string;
  /** Explicit marker for curator/manual review queues. */
  review_required?: boolean;
  /** normalizeRow 保留磁盘状态: executor transitions pending -> executed/failed. */
  status: LifecycleProposalStatus;
}

export interface AppendLifecycleProposalsOptions {
  projectRoot: string;
  promoted: PromotedAdvisory[];
  now?: Date;
}

export interface AppendLifecycleProposalsResult {
  ok: boolean;
  written: boolean;
  proposals_appended: number;
  rows_total: number;
  error?: string;
}

export type SupersededFrontmatterEntry = Pick<MemoryEntry, "slug" | "kind" | "status" | "frontmatter" | "relations">;

export interface AppendSupersededFrontmatterProposalsOptions {
  projectRoot: string;
  entries: SupersededFrontmatterEntry[];
  now?: Date;
}

export interface AppendSupersededFrontmatterProposalsResult extends AppendLifecycleProposalsResult {
  e1_count: number;
  e2_count: number;
  e1_slugs: string[];
  e2_slugs: string[];
}

export interface AppendSupersededMarkdownFrontmatterProposalsOptions {
  projectRoot: string;
  abrainHome?: string;
  projectId?: string;
  now?: Date;
}

const PROPOSALS_MAX_ROWS = 1000;
const PROPOSALS_TAIL_READ_BYTES = 2 * 1024 * 1024;
const STRING_FIELD_MAX_CHARS = 1_000;

export function entryLifecycleProposalsPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "entry-lifecycle-proposals.jsonl");
}

function clip(s: unknown, max = STRING_FIELD_MAX_CHARS): string {
  const text = typeof s === "string" ? s : String(s ?? "");
  return text.length > max ? `${text.slice(0, max)}...[truncated]` : text;
}

function normalizeProjectRoot(value: unknown): string {
  return typeof value === "string" && value.trim() ? path.resolve(value) : "";
}

function readJsonlTail<T = Record<string, unknown>>(filePath: string, maxBytes = PROPOSALS_TAIL_READ_BYTES): T[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const stat = fs.statSync(filePath);
    const start = maxBytes > 0 && stat.size > maxBytes ? stat.size - maxBytes : 0;
    const fd = fs.openSync(filePath, "r");
    let raw = "";
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      raw = buffer.toString("utf-8");
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
    const out: T[] = [];
    for (const line of raw.split("\n").map((l) => l.trim()).filter(Boolean)) {
      try { out.push(JSON.parse(line) as T); } catch { /* corrupt line ignored */ }
    }
    return out;
  } catch {
    return [];
  }
}

function validReason(value: unknown): LifecycleProposalReason | undefined {
  return value === "affirm_stale" || value === "affirm_superseded" || value === "affirm_echo_chamber" || value === "superseded_no_successor"
    ? value
    : undefined;
}

function lifecycleEvidenceType(reason: LifecycleProposalReason, source?: LifecycleProposalEvidenceSource, targetSlug?: string): string {
  if (source === "frontmatter_superseded" && reason === "affirm_superseded" && targetSlug) return "superseded_by";
  if (reason === "superseded_no_successor") return "superseded_no_successor";
  if (reason === "affirm_superseded") return "superseded_by";
  if (reason === "affirm_stale") return "stale";
  if (reason === "affirm_echo_chamber") return "echo_chamber";
  return reason;
}

function stableProposalId(row: EntryLifecycleProposalRow): string {
  return `elp-${createHash("sha256").update(proposalIdentity(row)).digest("hex").slice(0, 16)}`;
}

function normalizeRow(row: unknown): EntryLifecycleProposalRow | null {
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  const projectRoot = normalizeProjectRoot(r.project_root);
  const op = r.op === "contest" || r.op === "archive" || r.op === "supersede" ? r.op : undefined;
  const reason = validReason(r.reason);
  if (!projectRoot || !op || !reason) return null;
  const expected = r.expected_status === "superseded" ? "superseded" : r.expected_status === "active" ? "active" : undefined;
  const disposition = r.disposition === "review_required" ? "review_required" : r.disposition === "execution_ready" ? "execution_ready" : undefined;
  const source = r.evidence_source === "frontmatter_superseded" ? "frontmatter_superseded" : r.evidence_source === "aggregator_promoted_advisory" ? "aggregator_promoted_advisory" : undefined;
  const normalized: EntryLifecycleProposalRow = {
    schema_version: 1,
    ts: typeof r.ts === "string" ? r.ts : formatLocalIsoTimestamp(),
    project_root: projectRoot,
    ...(typeof r.slug === "string" && r.slug ? { slug: r.slug } : {}),
    kind: typeof r.kind === "string" ? r.kind : "unknown",
    op,
    reason,
    independent_evidence: typeof r.independent_evidence === "string" ? r.independent_evidence : "",
    falsifier: typeof r.falsifier === "string" ? r.falsifier : "",
    ...(typeof r.message === "string" ? { message: r.message } : {}),
    ...(expected ? { expected_status: expected } : {}),
    ...(disposition ? { disposition } : {}),
    ...(source ? { evidence_source: source } : {}),
    ...(typeof r.evidence_key === "string" && r.evidence_key ? { evidence_key: r.evidence_key } : {}),
    ...(typeof r.target_slug === "string" && r.target_slug ? { target_slug: r.target_slug } : {}),
    ...(typeof r.supersedes_proposal_id === "string" && r.supersedes_proposal_id ? { supersedes_proposal_id: r.supersedes_proposal_id } : {}),
    ...(r.review_required === true ? { review_required: true } : {}),
    status: (r.status === "executed" || r.status === "failed") ? r.status : "pending",
  };
  normalized.evidence_type = typeof r.evidence_type === "string" && r.evidence_type ? r.evidence_type : lifecycleEvidenceType(normalized.reason, normalized.evidence_source, normalized.target_slug);
  normalized.proposal_id = typeof r.proposal_id === "string" && r.proposal_id ? r.proposal_id : stableProposalId(normalized);
  return normalized;
}

function proposalIdentity(row: EntryLifecycleProposalRow): string {
  // Rows written before evidence_source/evidence_key existed came only from the
  // promoted-advisory path, so normalize them to the modern identity to avoid a
  // one-time duplicate after upgrade.
  const source = row.evidence_source ?? "aggregator_promoted_advisory";
  const key = row.evidence_key ?? (source === "aggregator_promoted_advisory"
    ? `${row.slug ?? ""}:${row.kind}:${row.op}:${row.reason}:${row.independent_evidence}`
    : `${row.kind}:${row.op}:${row.reason}:${row.independent_evidence}`);
  return [row.project_root, row.slug ?? "", row.op, source, key].join("\0");
}

function appendRows(projectRoot: string, rows: EntryLifecycleProposalRow[]): AppendLifecycleProposalsResult {
  const pr = normalizeProjectRoot(projectRoot);
  try {
    if (!pr || rows.length === 0) {
      const existing = readJsonlTail<unknown>(entryLifecycleProposalsPath())
        .map(normalizeRow)
        .filter((r): r is EntryLifecycleProposalRow => r !== null);
      return { ok: true, written: false, proposals_appended: 0, rows_total: existing.length };
    }
    const locked = withFileLock(entryLifecycleProposalsLockPath(), () => {
      const existing = readJsonlTail<unknown>(entryLifecycleProposalsPath())
        .map(normalizeRow)
        .filter((r): r is EntryLifecycleProposalRow => r !== null);
      const e1Slugs = new Set(rows
        .map((row) => normalizeRow({ ...row, project_root: pr }))
        .filter((row): row is EntryLifecycleProposalRow => !!row && row.evidence_source === "frontmatter_superseded" && row.disposition === "execution_ready" && row.expected_status === "superseded" && !!row.slug)
        .map((row) => row.slug as string));
      const supersededBySlug = new Map(existing
        .filter((row) => row.status === "pending" && row.disposition === "review_required" && row.evidence_source === "frontmatter_superseded" && !!row.slug)
        .map((row) => [row.slug as string, row.proposal_id as string]));
      const reconciledExisting = e1Slugs.size === 0 ? existing : existing.map((row) => {
        if (row.status === "pending" && row.disposition === "review_required" && row.evidence_source === "frontmatter_superseded" && row.slug && e1Slugs.has(row.slug)) {
          return { ...row, status: "failed" as const, message: `${row.message ?? ""} superseded_by_edge_observed; replaced_by_E1` };
        }
        return row;
      });
      const seen = new Set(reconciledExisting.map(proposalIdentity));
      const newRows: EntryLifecycleProposalRow[] = [];
      for (const row of rows) {
        const normalized = normalizeRow({ ...row, project_root: pr });
        if (!normalized) continue;
        if (normalized.evidence_source === "frontmatter_superseded" && normalized.disposition === "execution_ready" && normalized.slug) {
          const supersededId = supersededBySlug.get(normalized.slug);
          if (supersededId) normalized.supersedes_proposal_id = supersededId;
        }
        const id = proposalIdentity(normalized);
        if (seen.has(id)) continue;
        seen.add(id);
        newRows.push(normalized);
      }
      const changedExisting = reconciledExisting.some((row, idx) => row !== existing[idx]);
      if (newRows.length === 0 && !changedExisting) return { proposals_appended: 0, rows_total: existing.length };
      const allRows = [...reconciledExisting, ...newRows].slice(-PROPOSALS_MAX_ROWS);
      const enriched = allRows.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      atomicWriteText(entryLifecycleProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
      return { proposals_appended: newRows.length, rows_total: allRows.length, written: true };
    });
    if (!locked.ok) return { ok: false, written: false, proposals_appended: 0, rows_total: 0, error: "proposal_lock_contention" };
    return { ok: true, written: locked.value.written === true, proposals_appended: locked.value.proposals_appended, rows_total: locked.value.rows_total };
  } catch (e) {
    return {
      ok: false,
      written: false,
      proposals_appended: 0,
      rows_total: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Append affirmative lifecycle proposals carried by PROMOTED advisories. This is
 * still observation-only; demoted_signals are not accepted by contract.
 */
export function appendLifecycleProposals(options: AppendLifecycleProposalsOptions): AppendLifecycleProposalsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const ts = formatLocalIsoTimestamp(options.now ?? new Date());
  const promoted = Array.isArray(options.promoted) ? options.promoted : [];
  const carrying = promoted.filter((a) => a && a.lifecycle_proposal);
  const rows: EntryLifecycleProposalRow[] = carrying.map((a) => {
    const p = a.lifecycle_proposal as LifecycleProposal;
    const evidence = clip(p.independent_evidence);
    return {
      schema_version: 1,
      ts,
      project_root: projectRoot,
      ...(typeof a.slug === "string" && a.slug ? { slug: a.slug } : {}),
      kind: a.kind,
      op: p.op,
      reason: p.reason,
      independent_evidence: evidence,
      falsifier: clip(p.falsifier),
      ...(a.message ? { message: clip(a.message) } : {}),
      expected_status: "active",
      disposition: "execution_ready",
      evidence_source: "aggregator_promoted_advisory",
      evidence_key: `${a.slug ?? ""}:${a.kind}:${p.op}:${p.reason}:${evidence}`,
      status: "pending",
    };
  });
  return appendRows(projectRoot, rows);
}

function scalarString(value: Jsonish | undefined): string | undefined {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function rawRelationValues(value: Jsonish | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  return [];
}

function normalizeRelationTarget(raw: string): string {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0]!.split("#")[0]!.trim();
  const url = /^abrain:\/\/([^/]+)\/(.+)$/.exec(s);
  if (url) s = url[2] ?? "";
  const parts = s.split(":").filter(Boolean);
  if (parts.length >= 2) s = parts[parts.length - 1]!;
  s = s.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? s;
  s = s.replace(/\.md$/i, "");
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function validSupersededBy(entry: SupersededFrontmatterEntry): string | undefined {
  const candidates: string[] = [];
  for (const edge of (entry.relations ?? []) as RelationEdge[]) {
    if (edge?.type === "superseded_by" && edge.to) candidates.push(edge.to);
  }
  for (const raw of rawRelationValues(entry.frontmatter?.superseded_by)) candidates.push(normalizeRelationTarget(raw));
  const self = normalizeRelationTarget(entry.slug);
  return candidates.map(normalizeRelationTarget).find((slug) => slug && slug !== self);
}

/**
 * D* Phase 1 deterministic bridge. Reads current parsed frontmatter state and
 * emits:
 *   E1: status=superseded + non-self superseded_by -> execution_ready archive
 *       proposal with expected_status=superseded.
 *   E2: status=superseded without a valid successor -> review_required pending
 *       proposal; the executor must not execute it in Phase 1.
 *
 * TODO(D* Phase 2): add L1/writer-audit backfill sources, always revalidated
 * against current frontmatter before proposal emission.
 */
export function appendSupersededFrontmatterProposals(options: AppendSupersededFrontmatterProposalsOptions): AppendSupersededFrontmatterProposalsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const ts = formatLocalIsoTimestamp(options.now ?? new Date());
  const rows: EntryLifecycleProposalRow[] = [];
  const e1: string[] = [];
  const e2: string[] = [];

  for (const entry of Array.isArray(options.entries) ? options.entries : []) {
    if (!entry || typeof entry.slug !== "string" || !entry.slug) continue;
    const currentStatus = scalarString(entry.frontmatter?.status);
    if (currentStatus !== "superseded") continue;
    const target = validSupersededBy(entry);
    if (target) {
      e1.push(entry.slug);
      rows.push({
        schema_version: 1,
        ts,
        project_root: projectRoot,
        slug: entry.slug,
        kind: entry.kind || "unknown",
        op: "archive",
        reason: "affirm_superseded",
        independent_evidence: `frontmatter status=superseded; superseded_by=${target}`,
        falsifier: "current frontmatter status is no longer superseded or superseded_by is invalid/self-referential",
        message: `deterministic E1 archive proposal for superseded entry ${entry.slug}`,
        expected_status: "superseded",
        disposition: "execution_ready",
        evidence_source: "frontmatter_superseded",
        evidence_key: `E1:${entry.slug}:${target}`,
        target_slug: target,
        status: "pending",
      });
    } else {
      e2.push(entry.slug);
      rows.push({
        schema_version: 1,
        ts,
        project_root: projectRoot,
        slug: entry.slug,
        kind: entry.kind || "unknown",
        op: "archive",
        reason: "superseded_no_successor",
        independent_evidence: "frontmatter status=superseded but no valid non-self superseded_by edge exists",
        falsifier: "curator confirms a valid successor edge or restores the entry to an active standing",
        message: `curator_task=confirm_superseded_successor_or_restore_status; slug=${entry.slug}`,
        expected_status: "superseded",
        disposition: "review_required",
        evidence_source: "frontmatter_superseded",
        evidence_key: `E2:${entry.slug}:no_successor`,
        review_required: true,
        status: "pending",
      });
    }
  }

  const r = appendRows(projectRoot, rows);
  return { ...r, e1_count: e1.length, e2_count: e2.length, e1_slugs: e1, e2_slugs: e2 };
}

function splitMarkdownFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  return m?.[1] ?? "";
}

function parseFrontmatterScalar(raw: string): Jsonish {
  const s = raw.trim();
  if (!s) return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseFrontmatterScalar(part)).filter((part) => part !== "") as Jsonish[];
  }
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null") return null;
  return s;
}

function parseMarkdownFrontmatter(raw: string): Record<string, Jsonish> {
  const out: Record<string, Jsonish> = {};
  const lines = splitMarkdownFrontmatter(raw).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    const rest = m[2]!;
    if (rest.trim()) {
      out[key] = parseFrontmatterScalar(rest);
      continue;
    }
    const items: Jsonish[] = [];
    let j = i + 1;
    while (j < lines.length) {
      const item = /^\s+-\s*(.*)$/.exec(lines[j]!);
      if (!item) break;
      items.push(parseFrontmatterScalar(item[1] ?? ""));
      j++;
    }
    if (items.length > 0) {
      out[key] = items;
      i = j - 1;
    } else {
      out[key] = "";
    }
  }
  return out;
}

function markdownEntrySlug(file: string, fm: Record<string, Jsonish>): string {
  const id = scalarString(fm.id) ?? "";
  const tail = id.includes(":") ? id.split(":").filter(Boolean).pop() ?? id : id;
  return normalizeRelationTarget(tail || path.basename(file, ".md"));
}

function readMarkdownEntries(root: string): SupersededFrontmatterEntry[] {
  const out: SupersededFrontmatterEntry[] = [];
  const skip = new Set([".git", ".state", "staging", "workflows", "rules", "vault"]);
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (skip.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!ent.isFile() || !p.endsWith(".md") || ent.name === "_index.md") continue;
      try {
        const fm = parseMarkdownFrontmatter(fs.readFileSync(p, "utf-8"));
        const kind = scalarString(fm.kind) ?? "unknown";
        const status = scalarString(fm.status) ?? "";
        const slug = markdownEntrySlug(p, fm);
        if (!slug || !status) continue;
        const relations = rawRelationValues(fm.superseded_by).map((raw) => ({ type: "superseded_by", to: normalizeRelationTarget(raw), source: "frontmatter" as const }));
        out.push({ slug, kind, status, frontmatter: fm, relations });
      } catch { /* ignore unreadable/non-entry markdown */ }
    }
  };
  walk(root);
  return out;
}

function scanMarkdownEntries(legacyRoot: string, canonicalRoot?: string): SupersededFrontmatterEntry[] {
  const bySlug = new Map<string, SupersededFrontmatterEntry>();
  for (const entry of readMarkdownEntries(legacyRoot)) bySlug.set(entry.slug, entry);
  if (canonicalRoot && fs.existsSync(canonicalRoot)) {
    for (const canonical of readMarkdownEntries(canonicalRoot)) {
      const legacy = bySlug.get(canonical.slug);
      const fm = { ...canonical.frontmatter };
      if (fm.superseded_by === undefined && legacy?.frontmatter?.superseded_by !== undefined) fm.superseded_by = legacy.frontmatter.superseded_by;
      const relations = rawRelationValues(fm.superseded_by).map((raw) => ({ type: "superseded_by", to: normalizeRelationTarget(raw), source: "frontmatter" as const }));
      bySlug.set(canonical.slug, { ...canonical, frontmatter: fm, relations });
    }
  }
  return Array.from(bySlug.values());
}

/** Scan canonical project markdown frontmatter directly. This deliberately does
 * not use loadEntries because projection views can omit legacy relation fields. */
export function appendSupersededMarkdownFrontmatterProposals(options: AppendSupersededMarkdownFrontmatterProposalsOptions): AppendSupersededFrontmatterProposalsResult {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  if (!projectRoot) return { ok: true, written: false, proposals_appended: 0, rows_total: readLifecycleProposals().length, e1_count: 0, e2_count: 0, e1_slugs: [], e2_slugs: [] };
  try {
    const abrainHome = path.resolve(options.abrainHome ?? resolveUserGlobalAbrainHome());
    const projectId = options.projectId ?? resolveActiveProject(projectRoot, { abrainHome }).activeProject?.projectId;
    if (!projectId) return { ok: true, written: false, proposals_appended: 0, rows_total: readLifecycleProposals(projectRoot).length, e1_count: 0, e2_count: 0, e1_slugs: [], e2_slugs: [] };
    const entries = scanMarkdownEntries(
      abrainProjectDir(abrainHome, projectId),
      path.join(abrainHome, "l2", "views", "knowledge", "latest", "projects", projectId),
    );
    return appendSupersededFrontmatterProposals({ projectRoot, entries, now: options.now });
  } catch (e) {
    return { ok: false, written: false, proposals_appended: 0, rows_total: 0, e1_count: 0, e2_count: 0, e1_slugs: [], e2_slugs: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** Read proposals, optionally scoped to one project. Read-only consumer API. */
export function readLifecycleProposals(projectRoot?: string): EntryLifecycleProposalRow[] {
  const rows = readJsonlTail<unknown>(entryLifecycleProposalsPath())
    .map(normalizeRow)
    .filter((r): r is EntryLifecycleProposalRow => r !== null);
  if (!projectRoot) return rows;
  const normalized = normalizeProjectRoot(projectRoot);
  return rows.filter((r) => r.project_root === normalized);
}

function entryLifecycleProposalsLockPath(): string {
  ensureUserGlobalSidecarMigrated();
  return path.join(userGlobalSedimentDir(), "locks", "entry-lifecycle-proposals.lock");
}

/** Executor bookkeeping: mark execution-ready pending archive proposals as executed/failed. */
export function markProposalsExecuted(
  projectRoot: string,
  slugs: string[],
  status: "executed" | "failed" = "executed",
): { ok: boolean; updated: number; error?: string } {
  const pr = normalizeProjectRoot(projectRoot);
  const slugSet = new Set((Array.isArray(slugs) ? slugs : []).filter((s): s is string => typeof s === "string" && s.length > 0));
  if (!pr || slugSet.size === 0) return { ok: true, updated: 0 };
  const locked = withFileLock(entryLifecycleProposalsLockPath(), () => {
    const rows = readJsonlTail<unknown>(entryLifecycleProposalsPath())
      .map(normalizeRow)
      .filter((r): r is EntryLifecycleProposalRow => r !== null);
    let updated = 0;
    const next = rows.map((r) => {
      const executable = (r.disposition ?? "execution_ready") === "execution_ready";
      if (executable && r.project_root === pr && r.op === "archive" && r.status === "pending" && r.slug && slugSet.has(r.slug)) {
        updated++;
        return { ...r, status };
      }
      return r;
    });
    if (updated > 0) {
      const enriched = next.map((row) => ({ ...spreadAnchor(getCurrentAnchor()), ...row }));
      atomicWriteText(entryLifecycleProposalsPath(), enriched.map((row) => JSON.stringify(row)).join("\n") + "\n");
    }
    return updated;
  });
  if (!locked.ok) return { ok: false, updated: 0, error: "proposal_lock_contention" };
  return { ok: true, updated: locked.value };
}
