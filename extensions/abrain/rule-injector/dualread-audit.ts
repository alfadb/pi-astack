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

interface ShadowDecision {
  schemaVersion?: string;
  inputRootHash?: string;
  validationHash?: string;
  constraints?: ShadowConstraint[];
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
    if (!fs.existsSync(decisionPath)) return finish("shadow_unavailable", { reason: "missing_decision" });
    const decision = validateDecision(readJsonBounded(decisionPath, input.settings.maxReadBytes));
    const coverage = fs.existsSync(coveragePath) ? eventCoverageSummary(readJsonBounded(coveragePath, input.settings.maxReadBytes)) : undefined;
    const decisionStat = fs.statSync(decisionPath);
    const shadowAgeMs = Math.max(0, nowMs - decisionStat.mtimeMs);
    const stale = shadowAgeMs > input.settings.staleAfterMs;
    const constraints = decision.constraints ?? [];
    const delta = classifyDelta(allLegacyRules(input.cache), constraints);
    const hasDelta = delta.compiledOnly.length > 0 || delta.legacyOnly.length > 0 || delta.textDelta.length > 0;
    return finish(hasDelta || stale ? "delta" : "match", {
      inputRootHash: decision.inputRootHash,
      validationHash: decision.validationHash,
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
    });
  } catch (err: unknown) {
    return finish("shadow_invalid", { reason: "read_or_parse_failed" }, err);
  }
}
