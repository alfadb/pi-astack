import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { RuleEntry, RuleInjectMode, RuleScanCache } from "./index";

export interface RuleInjectorDualReadAuditSettings {
  enabled: boolean;
  maxReadBytes: number;
  staleAfterMs: number;
}

export interface RuleInjectorDualReadAuditResult {
  attempted: boolean;
  status: "disabled" | "match" | "delta" | "shadow_unavailable" | "shadow_invalid" | "audit_write_failed";
  latencyMs: number;
  auditFile?: string;
  error?: string;
}

type ConstraintScope = { kind: "global" } | { kind: "project"; projectId: string };

interface ShadowConstraint {
  constraintId?: string;
  scope?: ConstraintScope;
  injectMode?: RuleInjectMode;
  title?: string;
  compiledBody?: string;
  mustDoSummary?: string;
  appliesWhen?: string;
  triggerPhrases?: string[];
  sourceRecordIds?: string[];
}

interface ShadowDecisionExclusion {
  reason?: string;
  sourceRecordIds?: string[];
  diagnosticIds?: string[];
}

interface ShadowDecisionUnresolved {
  reason?: string;
  sourceRecordIds?: string[];
  diagnosticIds?: string[];
}

interface ShadowDecisionMapping {
  sourceRecordId?: string;
  disposition?: string;
  targetId?: string;
  reason?: string;
}

interface ShadowDecisionDiagnostic {
  id?: string;
  code?: string;
  message?: string;
  sourceRecordIds?: string[];
  data?: Record<string, unknown>;
}

interface ShadowDecision {
  schemaVersion?: string;
  inputRootHash?: string;
  validationHash?: string;
  constraints?: ShadowConstraint[];
  exclusions?: ShadowDecisionExclusion[];
  unresolved?: ShadowDecisionUnresolved[];
  mappings?: ShadowDecisionMapping[];
  diagnostics?: ShadowDecisionDiagnostic[];
}

interface ShadowDiffRow {
  sourceRecordId?: string;
  category?: string;
  disposition?: string;
  targetId?: string;
  reason?: string;
}

interface ShadowDiffReport {
  schemaVersion?: string;
  rows?: ShadowDiffRow[];
}

interface ShadowEventCoverage {
  schemaVersion?: string;
  summary?: {
    totalEvents?: number;
    validEvents?: number;
    invalidEvents?: number;
    queuedEvents?: number;
    projectedEvents?: number;
    staleEvents?: number;
    appendFailedEvents?: number;
    oldestQueuedAgeMs?: number;
    coverageRatio?: number;
  };
}

type TextDeltaDisposition = "semantic_equivalent" | "normalization_possible" | "semantic_mismatch_fix_required" | "semantic_review_required";

interface TextDeltaDispositionItem {
  sourceRecordId: string;
  legacyHash: string;
  shadowHash: string;
  disposition: TextDeltaDisposition;
  reviewedAtUtc?: string;
  reviewRef?: string;
  reason?: string;
}

type ComparableRule = {
  key: string;
  sourceRecordIds: string[];
  scope: string;
  injectMode: RuleInjectMode;
  title: string;
  mustDoSummary: string;
  bodyHash: string;
};

const DEFAULT_AUDIT_SETTINGS: RuleInjectorDualReadAuditSettings = {
  enabled: false,
  maxReadBytes: 1_000_000,
  staleAfterMs: 24 * 60 * 60 * 1000,
};

const SCHEMA_VERSION = "rule-injector-dualread-audit/v1";
const TEXT_DELTA_DISPOSITION_SCHEMA_VERSION = "constraint-text-delta-dispositions/v1";
const TEXT_DELTA_DISPOSITIONS = new Set<string>([
  "semantic_equivalent",
  "normalization_possible",
  "semantic_mismatch_fix_required",
  "semantic_review_required",
]);
const SHADOW_ROOT_REL = path.join(".state", "sediment", "constraint-shadow");
const AUDIT_DIR_REL = path.join(SHADOW_ROOT_REL, "session-start-dualread");

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeText(value: string | undefined): string {
  return String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRelative(base: string, target: string): string {
  const relative = path.relative(base, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : target;
}

function readJsonBounded(file: string, maxReadBytes: number): unknown {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a file`);
  if (stat.size > maxReadBytes) throw new Error(`${path.basename(file)} exceeds maxReadBytes`);
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function scopeKey(scope: ConstraintScope | undefined): string {
  if (!scope) return "unknown";
  return scope.kind === "project" ? `project:${scope.projectId}` : "global";
}

function entryScopeKey(entry: RuleEntry): string {
  return entry.scope === "project" && entry.projectId ? `project:${entry.projectId}` : "global";
}

function allLegacyRules(cache: RuleScanCache): RuleEntry[] {
  return [...cache.globalAlways, ...cache.projectAlways, ...cache.globalListed, ...cache.projectListed];
}

function legacyComparable(entry: RuleEntry): ComparableRule {
  const sourceRecordId = legacySourceId(entry);
  return {
    key: `legacy:${entry.scopedSlug}`,
    sourceRecordIds: [sourceRecordId],
    scope: entryScopeKey(entry),
    injectMode: entry.injectMode,
    title: normalizeText(entry.title),
    mustDoSummary: normalizeText(entry.mustDoSummary),
    bodyHash: sha256Hex(normalizeText(entry.body)),
  };
}

function shadowComparable(constraint: ShadowConstraint): ComparableRule {
  const sourceRecordIds = constraint.sourceRecordIds?.slice().sort() ?? [];
  const firstSource = sourceRecordIds[0] ?? constraint.constraintId ?? constraint.title ?? "unknown";
  return {
    key: `shadow:${firstSource}`,
    sourceRecordIds,
    scope: scopeKey(constraint.scope),
    injectMode: constraint.injectMode === "always" ? "always" : "listed",
    title: normalizeText(constraint.title),
    mustDoSummary: normalizeText(constraint.mustDoSummary),
    bodyHash: sha256Hex(normalizeText(constraint.compiledBody)),
  };
}

function comparableSignature(rule: ComparableRule): string {
  return `${rule.scope}\0${rule.injectMode}\0${rule.title}\0${rule.mustDoSummary}\0${rule.bodyHash}`;
}

function displayKey(rule: ComparableRule): string {
  return rule.key.replace(/^(legacy|shadow):/, "");
}

function sourceKeysFromShadow(rule: ComparableRule): string[] {
  return rule.sourceRecordIds.length ? rule.sourceRecordIds : [displayKey(rule)];
}

function legacySourceId(entry: RuleEntry): string {
  const mode = entry.injectMode;
  const slug = entry.slug;
  if (entry.scope === "project" && entry.projectId) return `rule:project:${entry.projectId}:${mode}:${slug}`;
  return `rule:global:${mode}:${slug}`;
}

function bySourceKey(entries: RuleEntry[]): Map<string, ComparableRule> {
  const out = new Map<string, ComparableRule>();
  for (const entry of entries) out.set(legacySourceId(entry), legacyComparable(entry));
  return out;
}

function classifyDelta(legacyRules: RuleEntry[], shadowConstraints: ShadowConstraint[]) {
  const legacyBySource = bySourceKey(legacyRules);
  const shadowRows = shadowConstraints.map(shadowComparable);
  const shadowBySource = new Map<string, ComparableRule>();
  for (const row of shadowRows) {
    for (const sourceKey of sourceKeysFromShadow(row)) shadowBySource.set(sourceKey, row);
  }

  const legacyOnly: string[] = [];
  const compiledOnly: string[] = [];
  const bothMatch: string[] = [];
  const textDelta: Array<{ sourceRecordId: string; legacyHash: string; shadowHash: string }> = [];

  for (const [sourceRecordId, legacyRule] of legacyBySource) {
    const shadowRule = shadowBySource.get(sourceRecordId);
    if (!shadowRule) {
      legacyOnly.push(sourceRecordId);
      continue;
    }
    if (comparableSignature(legacyRule) === comparableSignature(shadowRule)) {
      bothMatch.push(sourceRecordId);
    } else {
      textDelta.push({ sourceRecordId, legacyHash: legacyRule.bodyHash, shadowHash: shadowRule.bodyHash });
    }
  }

  for (const row of shadowRows) {
    const sourceKeys = sourceKeysFromShadow(row);
    if (!sourceKeys.some((sourceRecordId) => legacyBySource.has(sourceRecordId))) compiledOnly.push(displayKey(row));
  }

  return {
    legacyOnly: legacyOnly.sort(),
    compiledOnly: compiledOnly.sort(),
    bothMatch: bothMatch.sort(),
    textDelta: textDelta.sort((left, right) => left.sourceRecordId.localeCompare(right.sourceRecordId)),
  };
}

function validateDecision(value: unknown): ShadowDecision {
  if (!isObject(value)) throw new Error("decision is not an object");
  if (value.schemaVersion !== "constraint-shadow-decision/v1") throw new Error("unexpected decision schemaVersion");
  if (!Array.isArray(value.constraints)) throw new Error("decision.constraints is not an array");
  return value as unknown as ShadowDecision;
}

function eventCoverageSummary(value: unknown): ShadowEventCoverage["summary"] | undefined {
  if (!isObject(value)) return undefined;
  if (value.schemaVersion !== "constraint-event-coverage/v1") return undefined;
  const summary = (value as ShadowEventCoverage).summary;
  return isObject(summary) ? summary : undefined;
}

function diffRows(value: unknown): ShadowDiffRow[] {
  if (!isObject(value)) return [];
  if (value.schemaVersion !== "constraint-shadow-diff/v1") return [];
  const rows = (value as ShadowDiffReport).rows;
  return Array.isArray(rows) ? rows.filter((row): row is ShadowDiffRow => isObject(row)) : [];
}

function textDeltaDispositionKey(item: { sourceRecordId: string; legacyHash: string; shadowHash: string }): string {
  return `${item.sourceRecordId}\0${item.legacyHash}\0${item.shadowHash}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readTextDeltaDispositions(file: string, maxReadBytes: number): Map<string, TextDeltaDispositionItem> {
  const value = readJsonBounded(file, maxReadBytes);
  if (!isObject(value)) throw new Error("text-delta-dispositions is not an object");
  if (value.schemaVersion !== TEXT_DELTA_DISPOSITION_SCHEMA_VERSION) throw new Error("unexpected text-delta-dispositions schemaVersion");
  if (!Array.isArray(value.items)) throw new Error("text-delta-dispositions.items is not an array");
  const out = new Map<string, TextDeltaDispositionItem>();
  for (const raw of value.items) {
    if (!isObject(raw)) throw new Error("text-delta-dispositions item is not an object");
    const sourceRecordId = raw.sourceRecordId;
    const legacyHash = raw.legacyHash;
    const shadowHash = raw.shadowHash;
    const disposition = raw.disposition;
    if (typeof sourceRecordId !== "string" || typeof legacyHash !== "string" || typeof shadowHash !== "string") {
      throw new Error("text-delta-dispositions item missing sourceRecordId/legacyHash/shadowHash");
    }
    if (typeof disposition !== "string" || !TEXT_DELTA_DISPOSITIONS.has(disposition)) {
      throw new Error("text-delta-dispositions item has invalid disposition");
    }
    const item: TextDeltaDispositionItem = {
      sourceRecordId,
      legacyHash,
      shadowHash,
      disposition: disposition as TextDeltaDisposition,
      ...(optionalString(raw.reviewedAtUtc) ? { reviewedAtUtc: optionalString(raw.reviewedAtUtc) } : {}),
      ...(optionalString(raw.reviewRef) ? { reviewRef: optionalString(raw.reviewRef) } : {}),
      ...(optionalString(raw.reason) ? { reason: optionalString(raw.reason) } : {}),
    };
    out.set(textDeltaDispositionKey(item), item);
  }
  return out;
}

function sourceIn(ids: string[] | undefined, sourceRecordId: string): boolean {
  return Array.isArray(ids) && ids.includes(sourceRecordId);
}

function countByDisposition(details: Array<{ disposition: string }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const detail of details) out[detail.disposition] = (out[detail.disposition] ?? 0) + 1;
  return out;
}

function diagnosticReason(diagnostic: ShadowDecisionDiagnostic | undefined): string | undefined {
  if (!diagnostic) return undefined;
  const dataReason = diagnostic.data?.reason ?? diagnostic.data?.category;
  if (typeof dataReason === "string" && dataReason.trim()) return dataReason;
  const message = diagnostic.message ?? "";
  if (message.includes("settings_not_memory")) return "settings_not_memory";
  if (message.includes("tool_contract_not_memory")) return "tool_contract_not_memory";
  if (message.includes("model_uncertain")) return "model_uncertain";
  return undefined;
}

function dispositionFromDiagnostic(diagnostic: ShadowDecisionDiagnostic | undefined): string | undefined {
  const reason = diagnosticReason(diagnostic) ?? "";
  if (reason.includes("settings_not_memory") || diagnostic?.code === "SC_NOT_MEMORY_SETTINGS") return "settings_not_memory";
  if (reason.includes("tool_contract_not_memory") || diagnostic?.code === "SC_NOT_MEMORY_TOOL_CONTRACT") return "tool_contract_not_memory";
  if (reason.includes("model_uncertain")) return "model_uncertain";
  return undefined;
}

function dispositionFromDiff(row: ShadowDiffRow | undefined): string | undefined {
  if (!row) return undefined;
  const reason = row.reason ?? "";
  if (reason.includes("settings_not_memory") || row.category === "exclude_not_memory_settings") return "settings_not_memory";
  if (reason.includes("tool_contract_not_memory") || row.category === "exclude_not_memory_tool_contract") return "tool_contract_not_memory";
  if (reason.includes("model_uncertain")) return "model_uncertain";
  if (row.disposition === "compiled" || row.disposition === "merged_source") return "compiled_missing";
  return undefined;
}

function machineDisposition(input: {
  disposition: string;
  reason?: string;
  category?: string;
  compilerDisposition?: string;
  diagnosticCode?: string;
}): string {
  const text = [input.disposition, input.reason, input.category, input.compilerDisposition, input.diagnosticCode]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (text.includes("settings_not_memory") || text.includes("exclude_not_memory_settings") || input.diagnosticCode === "SC_NOT_MEMORY_SETTINGS") return "settings_not_memory";
  if (text.includes("tool_contract_not_memory") || text.includes("exclude_not_memory_tool_contract") || input.diagnosticCode === "SC_NOT_MEMORY_TOOL_CONTRACT") return "tool_contract_not_memory";
  if (text.includes("model_uncertain") || text.includes("keep_unresolved")) return "model_uncertain";
  if (input.disposition === "compiled_missing" || (input.disposition === "unknown" && (input.compilerDisposition === "compiled" || input.compilerDisposition === "merged_source"))) return "compiled_missing";
  if (input.disposition === "unknown") return "unknown";
  return input.disposition || "unknown";
}

function legacySourceNeedsHumanReview(sourceRecordId: string): boolean {
  const lower = sourceRecordId.toLowerCase();
  return sourceRecordId.includes("禁止使用-u-风格")
    || sourceRecordId.includes("unicode-转义")
    || lower.includes("runtime-kill-switch-flags-must-be-explicit")
    || sourceRecordId.includes("禁止行业黑话")
    || lower.includes("professional-neutral-vocabulary")
    || lower.includes("industry-slang")
    || lower.includes("jargon");
}

function legacyScopeCaveat(sourceRecordId: string): string | undefined {
  if (!sourceRecordId.includes("配置文件内联注释")) return undefined;
  return "pi-global event coverage; global legacy exclusion still needs scope acceptance before deletion";
}

function legacyHumanReviewRequired(input: { sourceRecordId: string; machineDisposition: string; unresolved: boolean }): boolean {
  if (input.unresolved) return true;
  if (["model_uncertain", "unknown", "compiled_missing"].includes(input.machineDisposition)) return true;
  return legacySourceNeedsHumanReview(input.sourceRecordId);
}

function inconsistentDiagnostics(decision: ShadowDecision) {
  const unresolvedSourceRecordIds = new Set<string>();
  for (const item of decision.unresolved ?? []) {
    for (const sourceRecordId of item.sourceRecordIds ?? []) unresolvedSourceRecordIds.add(sourceRecordId);
  }
  if (!unresolvedSourceRecordIds.size) return [];

  return (decision.diagnostics ?? []).flatMap((diagnostic) => {
    const sourceRecordIds = diagnostic.sourceRecordIds ?? [];
    const overlappingSourceRecordIds = sourceRecordIds.filter((sourceRecordId) => unresolvedSourceRecordIds.has(sourceRecordId));
    if (!overlappingSourceRecordIds.length) return [];
    const message = diagnostic.message ?? "";
    if (!/\bcompiled\b/i.test(message)) return [];
    return [{
      id: diagnostic.id,
      code: diagnostic.code,
      sourceRecordIds,
      overlappingSourceRecordIds,
      reason: "diagnostic_claims_compiled_for_unresolved_source",
    }];
  });
}

function legacyOnlyDetails(input: { sourceRecordIds: string[]; decision: ShadowDecision; diffRows: ShadowDiffRow[] }) {
  return input.sourceRecordIds.map((sourceRecordId) => {
    const exclusion = input.decision.exclusions?.find((item) => sourceIn(item.sourceRecordIds, sourceRecordId));
    const unresolved = input.decision.unresolved?.find((item) => sourceIn(item.sourceRecordIds, sourceRecordId));
    const mapping = input.decision.mappings?.find((item) => item.sourceRecordId === sourceRecordId);
    const diffRow = input.diffRows.find((row) => row.sourceRecordId === sourceRecordId);
    const diagnostic = input.decision.diagnostics?.find((item) => sourceIn(item.sourceRecordIds, sourceRecordId));

    const diagnosticReasonText = diagnosticReason(diagnostic);
    const disposition = exclusion?.reason
      ?? unresolved?.reason
      ?? (mapping?.disposition === "compiled" || mapping?.disposition === "merged_source" ? "compiled_missing" : undefined)
      ?? dispositionFromDiff(diffRow)
      ?? dispositionFromDiagnostic(diagnostic)
      ?? "unknown";
    const reason = exclusion?.reason
      ?? unresolved?.reason
      ?? mapping?.reason
      ?? diffRow?.reason
      ?? diagnosticReasonText;
    const normalizedDisposition = machineDisposition({
      disposition,
      reason,
      category: diffRow?.category,
      compilerDisposition: mapping?.disposition,
      diagnosticCode: diagnostic?.code,
    });

    return {
      sourceRecordId,
      disposition,
      machineDisposition: normalizedDisposition,
      humanReviewRequired: legacyHumanReviewRequired({ sourceRecordId, machineDisposition: normalizedDisposition, unresolved: !!unresolved }),
      ...(legacyScopeCaveat(sourceRecordId) ? { scopeCaveat: legacyScopeCaveat(sourceRecordId) } : {}),
      ...(exclusion?.reason ? { reason: exclusion.reason } : {}),
      ...(unresolved?.reason ? { reason: unresolved.reason } : {}),
      ...(mapping?.reason && !exclusion?.reason && !unresolved?.reason ? { reason: mapping.reason } : {}),
      ...(diffRow?.category ? { category: diffRow.category } : {}),
      ...(diffRow?.reason && !exclusion?.reason && !unresolved?.reason && !mapping?.reason ? { reason: diffRow.reason } : {}),
      ...(diagnosticReasonText && !exclusion?.reason && !unresolved?.reason && !mapping?.reason && !diffRow?.reason ? { reason: diagnosticReasonText } : {}),
      ...(mapping?.disposition ? { compilerDisposition: mapping.disposition } : {}),
      ...(diagnostic?.code ? { diagnosticCode: diagnostic.code } : {}),
      ...(mapping?.targetId ? { targetId: mapping.targetId } : {}),
      ...(exclusion?.diagnosticIds ? { diagnosticIds: exclusion.diagnosticIds } : {}),
      ...(unresolved?.diagnosticIds ? { diagnosticIds: unresolved.diagnosticIds } : {}),
      ...(diagnostic?.id && !exclusion?.diagnosticIds && !unresolved?.diagnosticIds ? { diagnosticIds: [diagnostic.id] } : {}),
    };
  });
}

function inferSourceKind(sourceRecordId: string): string {
  if (sourceRecordId.startsWith("rule:")) return "legacy_rule";
  if (sourceRecordId.startsWith("event:")) return "constraint_event";
  if (sourceRecordId.startsWith("audit:")) return "audit";
  if (sourceRecordId.startsWith("governance:")) return "governance_case";
  return "unknown";
}

function compiledOnlyDetails(sourceRecordIds: string[], constraints: ShadowConstraint[]) {
  return sourceRecordIds.map((sourceRecordId) => {
    const constraint = constraints.find((item) => (
      sourceIn(item.sourceRecordIds, sourceRecordId)
      || item.constraintId === sourceRecordId
      || item.title === sourceRecordId
    ));
    const sourceKind = inferSourceKind(sourceRecordId);
    return {
      sourceRecordId,
      sourceKind,
      scope: scopeKey(constraint?.scope),
      category: sourceKind === "constraint_event" ? "event_native" : "compiled_only",
      compiledOnlyBackfillAllowed: false,
      ...(constraint?.constraintId ? { constraintId: constraint.constraintId } : {}),
      ...(constraint?.injectMode ? { injectMode: constraint.injectMode } : {}),
    };
  });
}

function textDeltaDetails(input: {
  textDelta: Array<{ sourceRecordId: string; legacyHash: string; shadowHash: string }>;
  diffRows: ShadowDiffRow[];
  decision: ShadowDecision;
  dispositions?: Map<string, TextDeltaDispositionItem>;
}) {
  return input.textDelta.map((item) => {
    const disposition = input.dispositions?.get(textDeltaDispositionKey(item));
    const diffRow = input.diffRows.find((row) => row.sourceRecordId === item.sourceRecordId);
    const diagnostic = input.decision.diagnostics?.find((row) => sourceIn(row.sourceRecordIds, item.sourceRecordId));
    const normalizationPossible = diffRow?.category === "compact" || diagnostic?.code === "SC_NOT_MEMORY_SUBTYPE_NORMALIZED";
    if (disposition) {
      return {
        ...item,
        disposition: disposition.disposition,
        machineDisposition: disposition.disposition,
        humanReviewRequired: disposition.disposition === "semantic_mismatch_fix_required" || disposition.disposition === "semantic_review_required",
        reviewSource: "text-delta-dispositions",
        ...(disposition.reviewedAtUtc ? { reviewedAtUtc: disposition.reviewedAtUtc } : {}),
        ...(disposition.reviewRef ? { reviewRef: disposition.reviewRef } : {}),
        ...(disposition.reason ? { reason: disposition.reason } : {}),
        ...(diffRow?.category ? { category: diffRow.category } : {}),
        ...(diffRow?.targetId ? { targetId: diffRow.targetId } : {}),
        ...(diagnostic?.id ? { diagnosticIds: [diagnostic.id] } : {}),
      };
    }
    return {
      ...item,
      disposition: normalizationPossible ? "normalization_possible" : "semantic_review_required",
      humanReviewRequired: !normalizationPossible,
      ...(diffRow?.category ? { category: diffRow.category } : {}),
      ...(diffRow?.reason ? { reason: diffRow.reason } : {}),
      ...(diffRow?.targetId ? { targetId: diffRow.targetId } : {}),
      ...(diagnostic?.id ? { diagnosticIds: [diagnostic.id] } : {}),
    };
  });
}

function defaultShadowRoot(abrainHome: string): string {
  return path.join(abrainHome, SHADOW_ROOT_REL);
}

function defaultAuditDir(abrainHome: string): string {
  return path.join(abrainHome, AUDIT_DIR_REL);
}

function writeAudit(input: { abrainHome: string; auditDir?: string; row: unknown }): string {
  const allowedRoot = path.resolve(defaultShadowRoot(input.abrainHome));
  const auditDir = path.resolve(input.auditDir ?? defaultAuditDir(input.abrainHome));
  if (!pathInside(allowedRoot, auditDir)) throw new Error("dualread audit path outside constraint-shadow state root");
  fs.mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const auditFile = path.join(auditDir, "audit.jsonl");
  if (!pathInside(allowedRoot, auditFile)) throw new Error("dualread audit file outside constraint-shadow state root");
  fs.appendFileSync(auditFile, `${JSON.stringify(input.row)}\n`, "utf-8");
  return auditFile;
}

export function resolveRuleInjectorDualReadAuditSettings(value: unknown): RuleInjectorDualReadAuditSettings {
  const cfg = isObject(value) ? value : {};
  const enabled = typeof cfg.enabled === "boolean" ? cfg.enabled : DEFAULT_AUDIT_SETTINGS.enabled;
  const maxReadBytes = typeof cfg.maxReadBytes === "number" && Number.isFinite(cfg.maxReadBytes)
    ? Math.max(1_000, Math.floor(cfg.maxReadBytes))
    : DEFAULT_AUDIT_SETTINGS.maxReadBytes;
  const staleAfterMs = typeof cfg.staleAfterMs === "number" && Number.isFinite(cfg.staleAfterMs)
    ? Math.max(0, Math.floor(cfg.staleAfterMs))
    : DEFAULT_AUDIT_SETTINGS.staleAfterMs;
  return { enabled, maxReadBytes, staleAfterMs };
}

export function runRuleInjectorDualReadAudit(input: {
  abrainHome: string;
  cwd: string;
  cache: RuleScanCache;
  settings: RuleInjectorDualReadAuditSettings;
  shadowLatestDir?: string;
  auditDir?: string;
  nowMs?: number;
}): RuleInjectorDualReadAuditResult {
  const started = Date.now();
  if (!input.settings.enabled) return { attempted: false, status: "disabled", latencyMs: 0 };

  const abrainHome = path.resolve(input.abrainHome.replace(/^~(?=$|\/)/, os.homedir()));
  const shadowRoot = defaultShadowRoot(abrainHome);
  const latestDir = path.resolve(input.shadowLatestDir ?? path.join(shadowRoot, "latest"));
  const nowMs = input.nowMs ?? Date.now();

  const baseRow = {
    schemaVersion: SCHEMA_VERSION,
    observedAtUtc: new Date(nowMs).toISOString(),
    cwd: input.cwd,
    activeProjectId: input.cache.activeProjectId,
    shadowLatestDir: safeRelative(abrainHome, latestDir),
  };

  const finish = (status: RuleInjectorDualReadAuditResult["status"], row: Record<string, unknown>, error?: unknown): RuleInjectorDualReadAuditResult => {
    const latencyMs = Date.now() - started;
    const auditRow = { ...baseRow, status, latencyMs, ...row, ...(error ? { error: error instanceof Error ? error.message : String(error) } : {}) };
    try {
      const auditFile = writeAudit({ abrainHome, auditDir: input.auditDir, row: auditRow });
      return { attempted: true, status, latencyMs, auditFile };
    } catch (writeErr: unknown) {
      return {
        attempted: true,
        status: "audit_write_failed",
        latencyMs,
        error: writeErr instanceof Error ? writeErr.message : String(writeErr),
      };
    }
  };

  try {
    if (!pathInside(shadowRoot, latestDir)) throw new Error("shadow latest dir outside constraint-shadow state root");
    const decisionPath = path.join(latestDir, "decision.json");
    const coveragePath = path.join(latestDir, "event-coverage.json");
    const diffPath = path.join(latestDir, "diff.json");
    const textDeltaDispositionsPath = path.join(latestDir, "text-delta-dispositions.json");
    if (!fs.existsSync(decisionPath)) return finish("shadow_unavailable", { reason: "missing_decision" });
    const decision = validateDecision(readJsonBounded(decisionPath, input.settings.maxReadBytes));
    const coverage = fs.existsSync(coveragePath) ? eventCoverageSummary(readJsonBounded(coveragePath, input.settings.maxReadBytes)) : undefined;
    let diff: ShadowDiffRow[] = [];
    try {
      diff = fs.existsSync(diffPath) ? diffRows(readJsonBounded(diffPath, input.settings.maxReadBytes)) : [];
    } catch {
      diff = [];
    }
    let textDeltaDispositionItems = new Map<string, TextDeltaDispositionItem>();
    let textDeltaDispositionReadError: string | undefined;
    try {
      textDeltaDispositionItems = fs.existsSync(textDeltaDispositionsPath)
        ? readTextDeltaDispositions(textDeltaDispositionsPath, input.settings.maxReadBytes)
        : new Map<string, TextDeltaDispositionItem>();
    } catch (err: unknown) {
      textDeltaDispositionReadError = err instanceof Error ? err.message : String(err);
    }
    const decisionStat = fs.statSync(decisionPath);
    const shadowAgeMs = Math.max(0, nowMs - decisionStat.mtimeMs);
    const stale = shadowAgeMs > input.settings.staleAfterMs;
    const constraints = decision.constraints ?? [];
    const delta = classifyDelta(allLegacyRules(input.cache), constraints);
    const legacyDetails = legacyOnlyDetails({ sourceRecordIds: delta.legacyOnly, decision, diffRows: diff });
    const textDetails = textDeltaDetails({ textDelta: delta.textDelta, diffRows: diff, decision, dispositions: textDeltaDispositionItems });
    const hasDelta = delta.compiledOnly.length > 0 || delta.legacyOnly.length > 0 || delta.textDelta.length > 0;
    return finish(hasDelta || stale ? "delta" : "match", {
      inputRootHash: decision.inputRootHash,
      validationHash: decision.validationHash,
      ...(textDeltaDispositionReadError ? { textDeltaDispositionReadError } : {}),
      shadowAgeMs,
      stale,
      eventCoverage: coverage,
      summary: {
        legacyRules: allLegacyRules(input.cache).length,
        shadowConstraints: constraints.length,
        compiledOnly: delta.compiledOnly.length,
        legacyOnly: delta.legacyOnly.length,
        bothMatch: delta.bothMatch.length,
        textDelta: delta.textDelta.length,
      },
      delta,
      legacyOnlyDispositions: countByDisposition(legacyDetails),
      legacyOnlyDetails: legacyDetails,
      compiledOnlyBackfillAllowed: false,
      compiledOnlyDetails: compiledOnlyDetails(delta.compiledOnly, constraints),
      textDeltaDispositions: countByDisposition(textDetails),
      textDeltaDetails: textDetails,
      inconsistentDiagnostics: inconsistentDiagnostics(decision),
    });
  } catch (err: unknown) {
    return finish("shadow_invalid", { reason: "read_or_parse_failed" }, err);
  }
}
