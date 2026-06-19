import * as fs from "node:fs/promises";
import * as path from "node:path";
import { splitCompiledTruth, splitFrontmatter, parseFrontmatter, scalarNumber, scalarString, relationValues, extractTitle } from "../../memory/parser";
import { normalizeBareSlug } from "../../memory/utils";
import {
  abrainProjectRulesModeDir,
  abrainRulesModeDir,
  listAbrainProjects,
} from "../../_shared/runtime";
import { makeDiagnostic } from "./diagnostics";
import { sha256Hex, stableCanonicalize } from "./normalize";
import type {
  ConstraintInjectMode,
  ConstraintScope,
  LegacyConstraintScanOptions,
  LegacyConstraintScanResult,
  LegacyRuleSourceRecord,
  LegacyRuleStatus,
  ConstraintShadowDiagnostic,
} from "./types";

const INJECT_MODES: ConstraintInjectMode[] = ["always", "listed"];
const KNOWN_STATUSES = new Set<LegacyRuleStatus>(["active", "contested", "archived", "superseded", "deprecated"]);

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch {
    return false;
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  if (!(await pathExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function normalizeStatus(raw: string | undefined): LegacyRuleStatus {
  const status = raw?.trim() as LegacyRuleStatus | undefined;
  if (!status) return "active";
  return KNOWN_STATUSES.has(status) ? status : "unknown";
}

function sourceIdFor(scope: ConstraintScope, injectMode: ConstraintInjectMode, slug: string): string {
  if (scope.kind === "global") return `rule:global:${injectMode}:${slug}`;
  return `rule:project:${scope.projectId}:${injectMode}:${slug}`;
}

function sourceRefFor(scope: ConstraintScope, injectMode: ConstraintInjectMode, slug: string): string {
  return sourceIdFor(scope, injectMode, slug);
}

async function readRuleFile(file: string, scope: ConstraintScope, injectMode: ConstraintInjectMode): Promise<LegacyRuleSourceRecord> {
  const raw = await fs.readFile(file, "utf-8");
  const { frontmatterText, body } = splitFrontmatter(raw);
  const frontmatter = parseFrontmatter(frontmatterText);
  const { compiledTruth, timeline } = splitCompiledTruth(body);
  const fileSlug = normalizeBareSlug(path.basename(file, ".md"));
  const id = scalarString(frontmatter.id);
  const slug = normalizeBareSlug(id ? id.split(":").pop() ?? fileSlug : fileSlug);
  const title = scalarString(frontmatter.title) || extractTitle(body) || slug;
  const status = normalizeStatus(scalarString(frontmatter.status));
  const bodyText = compiledTruth.trim();
  const rawBodyHash = scalarString(frontmatter.body_hash) || scalarString(frontmatter.bodyHash) || sha256Hex(bodyText);
  const computedBodyHash = sha256Hex(bodyText);
  const sourceId = sourceIdFor(scope, injectMode, slug);

  return {
    sourceKind: "legacy_rule",
    sourceId,
    slug,
    title,
    path: file,
    scope,
    injectMode,
    status,
    body: bodyText,
    rawBodyHash,
    computedBodyHash,
    rawFileHash: sha256Hex(raw),
    frontmatterHash: sha256Hex(frontmatterText),
    provenance: scalarString(frontmatter.provenance) || "assistant-observed",
    confidence: Math.max(0, Math.min(10, scalarNumber(frontmatter.confidence) ?? 5)),
    kind: scalarString(frontmatter.kind) || "preference",
    triggerPhrases: relationValues(frontmatter.trigger_phrases).sort(),
    appliesWhen: scalarString(frontmatter.applies_when) || "",
    mustDoSummary: scalarString(frontmatter.must_do_summary) || scalarString(frontmatter.hint) || "",
    created: scalarString(frontmatter.created_at) || scalarString(frontmatter.created),
    updated: scalarString(frontmatter.updated_at) || scalarString(frontmatter.updated),
    frontmatter,
    timelineEvents: timeline,
    sourceRef: { path: file, ref: sourceRefFor(scope, injectMode, slug) },
  };
}

function projectIdsForScan(options: LegacyConstraintScanOptions): string[] {
  if (Array.isArray(options.includeProjects)) return options.includeProjects.slice().sort();
  if (options.includeProjects === "all") return listAbrainProjects(options.abrainHome);
  return options.activeProjectId ? [options.activeProjectId] : [];
}

export async function scanLegacyConstraintSources(options: LegacyConstraintScanOptions): Promise<LegacyConstraintScanResult> {
  const abrainHome = path.resolve(options.abrainHome);
  const cwd = path.resolve(options.cwd);
  const warnings: ConstraintShadowDiagnostic[] = [];
  const rules: LegacyRuleSourceRecord[] = [];

  for (const injectMode of INJECT_MODES) {
    const dir = abrainRulesModeDir(abrainHome, injectMode);
    for (const file of await listMarkdownFiles(dir)) {
      try {
        const record = await readRuleFile(file, { kind: "global" }, injectMode);
        if (options.includeStatuses !== "active_only" || record.status === "active") rules.push(record);
      } catch (err) {
        warnings.push(makeDiagnostic({
          code: "SC_INPUT_MALFORMED_RULE",
          message: `failed to parse legacy rule ${file}`,
          data: { file, error: err instanceof Error ? err.message : String(err) },
        }));
      }
    }
  }

  for (const projectId of projectIdsForScan({ ...options, abrainHome })) {
    for (const injectMode of INJECT_MODES) {
      const dir = abrainProjectRulesModeDir(abrainHome, projectId, injectMode);
      for (const file of await listMarkdownFiles(dir)) {
        try {
          const record = await readRuleFile(file, { kind: "project", projectId }, injectMode);
          if (options.includeStatuses !== "active_only" || record.status === "active") rules.push(record);
        } catch (err) {
          warnings.push(makeDiagnostic({
            code: "SC_INPUT_MALFORMED_RULE",
            message: `failed to parse project legacy rule ${file}`,
            data: { file, projectId, error: err instanceof Error ? err.message : String(err) },
          }));
        }
      }
    }
  }

  rules.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return {
    abrainHome,
    cwd,
    activeProjectId: options.activeProjectId,
    rules,
    audits: [],
    warnings,
  };
}

export function sourceSetHash(records: LegacyRuleSourceRecord[]): string {
  return sha256Hex(stableCanonicalize(records.map((record) => ({
    sourceId: record.sourceId,
    scope: record.scope,
    injectMode: record.injectMode,
    status: record.status,
    rawFileHash: record.rawFileHash,
    rawBodyHash: record.rawBodyHash,
    computedBodyHash: record.computedBodyHash,
  }))));
}
