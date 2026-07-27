/**
 * ADR 0023-R5 / ADR0040 read-path: session-start rule injection.
 *
 * Production authority is the content-addressed Policy stable-view only.
 * Legacy rules/ on disk remain a readonly diagnostic neighbor for /rule
 * list|explain|reload and footer counts. Compiled-view, dual-read audit,
 * and self-heal scheduling are retired and unreachable.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FOOTER_STATUS_KEYS } from "../../_shared/footer-status";
import { isSubAgentSession } from "../../_shared/pi-internals";
import {
  abrainProjectDir,
  resolveActiveProject,
  type ResolveActiveProjectResult,
} from "../../_shared/runtime";
import {
  parseFrontmatter,
  relationValues,
  scalarNumber,
  scalarString,
  splitCompiledTruth,
  splitFrontmatter,
} from "../../memory/parser";
import { slugify } from "../../memory/utils";
import {
  readPropositionPolicyStableViewForRuntime,
  resolvePropositionPolicyStableViewInjectionSettings,
  selectPropositionPolicyStableViewSession,
  type PropositionPolicyStableViewInjectionSettings,
  type PropositionPolicyStableViewRuntimeReadResult,
} from "./proposition-policy-stable-view-reader";
import {
  appendPropositionPolicyStableViewRuntimeAudit,
  buildPropositionPolicyStableViewRuntimeAuditRow,
} from "./proposition-policy-stable-view-runtime-audit";

/** ADR 0028 §12.3: the rules injection-budget axis is INJECT-MODE (values
 *  always/listed), renamed away from "tier" to stop colliding with the GTIER
 *  Tier-1/2 write-path predicate. Directory names embed the VALUES and stay. */
export type RuleInjectMode = "always" | "listed";
export type RuleScope = "global" | "project";

type NotifyType = "info" | "warning" | "error";

export interface RuleInjectorSettings {
  maxCatalogSummaryChars: number;
  maxCatalogTriggerChars: number;
  propositionPolicyStableViewInjection: PropositionPolicyStableViewInjectionSettings;
}

export interface RuleEntry {
  slug: string;
  scopedSlug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  injectMode: RuleInjectMode;
  scope: RuleScope;
  projectId?: string;
  sourcePath: string;
  body: string;
  provenance: string;
  appliesWhen: string;
  triggerPhrases: string[];
  mustDoSummary: string;
  catalogText: string;
  tokenEstimate: number;
  updated?: string;
  created?: string;
}

export interface RuleScanWarning {
  level: NotifyType;
  message: string;
  file?: string;
}

export interface RuleScanCache {
  nonce: string;
  abrainHome: string;
  cwd: string;
  activeProjectId?: string;
  bindingReason?: string;
  globalAlways: RuleEntry[];
  globalListed: RuleEntry[];
  projectAlways: RuleEntry[];
  projectListed: RuleEntry[];
  warnings: RuleScanWarning[];
  scannedAt: string;
}

const ABRAIN_HOME = process.env.ABRAIN_ROOT
  ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
  : path.join(os.homedir(), ".abrain");

const PI_STACK_SETTINGS_PATH = path.join(
  os.homedir(), ".pi", "agent", "pi-astack-settings.json",
);

export const BEGIN_ABRAIN_RULES = "<!-- BEGIN_ABRAIN_RULES";
export const END_ABRAIN_RULES = "<!-- END_ABRAIN_RULES -->";
export const RULE_STATUS_KEY = FOOTER_STATUS_KEYS.abrainRules;

const DEFAULT_SETTINGS: RuleInjectorSettings = {
  maxCatalogSummaryChars: 220,
  maxCatalogTriggerChars: 160,
  propositionPolicyStableViewInjection: resolvePropositionPolicyStableViewInjectionSettings(undefined),
};

let cachedRules: RuleScanCache | null = null;

interface PolicyFooterState {
  sessionId: string;
  text: string;
}

// Final per-session policy selection. Footer refresh paths must preserve this
// after before_agent_start has chosen the actual injected source.
let policyFooterState: PolicyFooterState | null = null;

function loadPiStackSettings(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(PI_STACK_SETTINGS_PATH, "utf-8"));
  } catch (e: unknown) {
    // Missing config is normal; only malformed JSON is worth a visible log.
    if (e && typeof e === "object" && (e as NodeJS.ErrnoException).code === "ENOENT") return {};
    const message = e instanceof Error ? e.message : String(e);
    console.error(`pi-astack: failed to parse ${PI_STACK_SETTINGS_PATH}: ${message}. Using defaults.`);
    return {};
  }
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function resolveRuleInjectorSettings(): RuleInjectorSettings {
  const root = loadPiStackSettings();
  const cfg = asObject(root.ruleInjector);
  return {
    maxCatalogSummaryChars: Math.max(80, Math.floor(asNumber(cfg.maxCatalogSummaryChars, DEFAULT_SETTINGS.maxCatalogSummaryChars))),
    maxCatalogTriggerChars: Math.max(40, Math.floor(asNumber(cfg.maxCatalogTriggerChars, DEFAULT_SETTINGS.maxCatalogTriggerChars))),
    propositionPolicyStableViewInjection: resolvePropositionPolicyStableViewInjectionSettings(cfg.propositionPolicyStableViewInjection),
  };
}

/** Diagnostic-only settings surface for /rule. No compiled-view mutation. */
export function resolveRuntimeRuleInjectorSettings(
  settings: RuleInjectorSettings,
  _ctx?: { sessionManager?: unknown },
): RuleInjectorSettings {
  return settings;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

function generateNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

function readDirSorted(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function firstBodyLine(body: string): string {
  for (const rawLine of body.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line || line === "---" || /^#{1,6}\s+/.test(line)) continue;
    return line.replace(/^[#>*\-\s]+/, "").trim();
  }
  return "";
}

function sanitizeSingleLine(raw: string, maxChars: number): string {
  const clean = String(raw || "")
    .replace(/[\x00-\x1F\x7F]/g, " ")
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/<!--/g, "")
    .replace(/-->/g, "")
    .replace(/BEGIN_ABRAIN_RULES|END_ABRAIN_RULES/g, "")
    .replace(/```/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function normalizeRuleBody(body: string, maxChars: number): string {
  const compiled = splitCompiledTruth(body).compiledTruth
    .replace(/^#\s+.*$/m, "")
    .replace(/^---$/gm, "")
    .replace(/\s+$/gm, "")
    .trim();
  const text = compiled || firstBodyLine(body);
  return sanitizeSingleLine(text, maxChars);
}

function formatCatalogList(values: string[], maxChars: number): string {
  const clean = values.map((v) => sanitizeSingleLine(v, Math.max(20, maxChars))).filter(Boolean);
  if (clean.length === 0) return "-";
  return sanitizeSingleLine(clean.join("; "), maxChars);
}

function catalogRuleText(entry: Omit<RuleEntry, "catalogText" | "tokenEstimate">): string {
  const where = entry.scope === "project" && entry.projectId ? `project:${entry.projectId}` : "global";
  return `- ${entry.scopedSlug} | title=${entry.title} | scope=${where} | inject=${entry.injectMode} | kind=${entry.kind} | provenance=${entry.provenance} | confidence=${entry.confidence}/10 | applies_when=${entry.appliesWhen || "-"} | trigger_phrases=${formatCatalogList(entry.triggerPhrases, 240)} | must_do_summary=${entry.mustDoSummary} | full_rule_path=${entry.sourcePath}`;
}

function readRuleFile(
  file: string,
  injectMode: RuleInjectMode,
  scope: RuleScope,
  settings: RuleInjectorSettings,
  projectId?: string,
): { entry?: RuleEntry; warning?: RuleScanWarning } {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e: unknown) {
    return { warning: { level: "warning", message: `rules: cannot read ${path.basename(file)} (${e instanceof Error ? e.message : String(e)})`, file } };
  }

  const { frontmatterText, body } = splitFrontmatter(raw);
  if (!frontmatterText.trim()) {
    return { warning: { level: "warning", message: `rules: skip ${path.basename(file)} (missing frontmatter)`, file } };
  }

  const fm = parseFrontmatter(frontmatterText);
  const status = scalarString(fm.status) || "active";
  if (status !== "active") return {};

  const kind = scalarString(fm.kind) || scalarString(fm.type) || "maxim";
  const confidence = Math.min(10, Math.max(0, scalarNumber(fm.confidence) ?? 5));
  // Confidence floor removed 2026-06-06 (mechanical-guard cleanup R4/C1): a hard
  // `confidence < N -> drop` gate silently excluded the curator-LLM's own
  // confidence assessment from injection (ADR 0024 §3 violation). All active
  // rules now inject WITH a confidence label so the reading LLM weighs them.

  const slug = slugify(path.basename(file, ".md"));
  if (!slug) return { warning: { level: "warning", message: `rules: skip ${path.basename(file)} (empty slug after normalization)`, file } };

  const title = sanitizeSingleLine(
    scalarString(fm.title) || body.match(/^#\s+(.+)$/m)?.[1] || slug,
    120,
  );
  const provenance = sanitizeSingleLine(scalarString(fm.provenance) || "assistant-observed", 80);
  const triggerPhrases = relationValues(fm.trigger_phrases).map((v) => sanitizeSingleLine(v, settings.maxCatalogTriggerChars)).filter(Boolean);
  const appliesWhen = sanitizeSingleLine(
    scalarString(fm.applies_when) || scalarString(fm.routing_reason) || formatCatalogList(triggerPhrases, settings.maxCatalogTriggerChars),
    settings.maxCatalogTriggerChars,
  );
  const mustDoSummary = sanitizeSingleLine(
    scalarString(fm.must_do_summary)
      || scalarString(fm.hint)
      || normalizeRuleBody(body, settings.maxCatalogSummaryChars)
      || title,
    settings.maxCatalogSummaryChars,
  );

  const entryBase = {
    slug,
    scopedSlug: scope === "project" && projectId ? `project:${projectId}:${slug}` : `global:${slug}`,
    title,
    kind,
    status,
    confidence,
    injectMode,
    scope,
    ...(projectId ? { projectId } : {}),
    sourcePath: file,
    body,
    provenance,
    appliesWhen,
    triggerPhrases,
    mustDoSummary,
    updated: scalarString(fm.updated),
    created: scalarString(fm.created),
  } satisfies Omit<RuleEntry, "catalogText" | "tokenEstimate">;
  const catalogText = catalogRuleText(entryBase);

  return {
    entry: {
      ...entryBase,
      catalogText,
      tokenEstimate: estimateTokens(catalogText),
    },
  };
}

function scanModeDir(
  dir: string,
  injectMode: RuleInjectMode,
  scope: RuleScope,
  settings: RuleInjectorSettings,
  warnings: RuleScanWarning[],
  projectId?: string,
): RuleEntry[] {
  const out: RuleEntry[] = [];
  for (const ent of readDirSorted(dir)) {
    if (!ent.isFile() || !ent.name.endsWith(".md") || ent.name === "_index.md") continue;
    const parsed = readRuleFile(path.join(dir, ent.name), injectMode, scope, settings, projectId);
    if (parsed.warning) warnings.push(parsed.warning);
    if (parsed.entry) out.push(parsed.entry);
  }
  out.sort((a, b) => {
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return (b.updated || b.created || "").localeCompare(a.updated || a.created || "");
  });
  return out;
}

// enforceBudget removed 2026-06-06 (mechanical-guard cleanup D1): it only
// emitted advisory "over cap; injected in full" warnings with ZERO behavioral
// effect (no truncation, no demotion), which falsely implied an enforced cap.
// Session-start injection is now a compact catalog; full rule bodies are read
// on demand from full_rule_path when the catalog summary is insufficient.

export function scanRules(
  opts: {
    abrainHome: string;
    cwd: string;
    nonce?: string;
    settings?: RuleInjectorSettings;
    resolveProject?: (cwd: string, abrainHome: string) => ResolveActiveProjectResult;
  },
): RuleScanCache {
  const settings = opts.settings ?? resolveRuleInjectorSettings();
  const warnings: RuleScanWarning[] = [];
  const abrainHome = path.resolve(opts.abrainHome);
  const cwd = path.resolve(opts.cwd || process.cwd());
  const nonce = opts.nonce ?? generateNonce();

  const binding = (() => {
    try {
      return opts.resolveProject ? opts.resolveProject(cwd, abrainHome) : resolveActiveProject(cwd, { abrainHome });
    } catch (e: unknown) {
      return {
        activeProject: null,
        reason: "invalid_cwd" as const,
        cwd,
        detail: e instanceof Error ? e.message : String(e),
      } satisfies ResolveActiveProjectResult;
    }
  })();

  const activeProjectId = binding.activeProject?.projectId;
  const globalAlways = scanModeDir(path.join(abrainHome, "rules", "always"), "always", "global", settings, warnings);
  const globalListed = scanModeDir(path.join(abrainHome, "rules", "listed"), "listed", "global", settings, warnings);

  let projectAlways: RuleEntry[] = [];
  let projectListed: RuleEntry[] = [];
  if (binding.activeProject) {
    const projectDir = abrainProjectDir(abrainHome, binding.activeProject.projectId);
    projectAlways = scanModeDir(path.join(projectDir, "rules", "always"), "always", "project", settings, warnings, binding.activeProject.projectId);
    projectListed = scanModeDir(path.join(projectDir, "rules", "listed"), "listed", "project", settings, warnings, binding.activeProject.projectId);
  }

  return {
    nonce,
    abrainHome,
    cwd,
    ...(activeProjectId ? { activeProjectId } : {}),
    ...(!binding.activeProject && binding.reason ? { bindingReason: binding.reason } : {}),
    globalAlways,
    globalListed,
    projectAlways,
    projectListed,
    warnings,
    scannedAt: new Date().toISOString(),
  };
}

export function composePropositionPolicyStableViewInjection(
  nonce: string,
  result: Extract<PropositionPolicyStableViewRuntimeReadResult, { ok: true }>,
): string {
  return `${BEGIN_ABRAIN_RULES} session=${nonce} source=proposition-policy-stable-view bundle=${result.bundleHash} (auto-managed by sediment, do not edit by hand) -->\n${result.viewMd}${END_ABRAIN_RULES}`;
}

export function stripAllManagedRuleInjections(text: string): string {
  let sanitized = text.replace(
    /(?:\r?\n){0,2}<!-- BEGIN_ABRAIN_RULES[^\n]*-->[\s\S]*?<!-- END_ABRAIN_RULES -->(?:\r?\n)?/g,
    "\n",
  );
  const unterminated = sanitized.indexOf(BEGIN_ABRAIN_RULES);
  if (unterminated >= 0) sanitized = sanitized.slice(0, unterminated);
  sanitized = sanitized.replaceAll(END_ABRAIN_RULES, "");
  return sanitized.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function stripCurrentRuleInjection(text: string, _nonce: string | undefined | null): string {
  return stripAllManagedRuleInjections(text);
}

export function getCurrentRuleInjectionNonce(): string | undefined {
  return cachedRules?.nonce;
}

export function getCurrentInjectedRuleEntries(): RuleEntry[] {
  return cachedRules ? allRules(cachedRules) : [];
}

export function refreshRuleCacheForTests(cache: RuleScanCache | null): void {
  if (process.env.PI_ASTACK_ENABLE_TEST_HOOKS !== "1") {
    throw new Error("refreshRuleCacheForTests requires PI_ASTACK_ENABLE_TEST_HOOKS=1");
  }
  cachedRules = cache;
}

function ruleCounts(cache: RuleScanCache): { always: number; listed: number; total: number } {
  const always = cache.globalAlways.length + cache.projectAlways.length;
  const listed = cache.globalListed.length + cache.projectListed.length;
  return { always, listed, total: always + listed };
}

function hasAnyRules(cache: RuleScanCache): boolean {
  return cache.globalAlways.length + cache.globalListed.length + cache.projectAlways.length + cache.projectListed.length > 0;
}

/** Readonly-neighbor footer: on-disk rules/ counts only. Not injection authority. */
function neighborFooterText(cache: RuleScanCache | null, detail?: string): string {
  if (!cache || !hasAnyRules(cache)) {
    const base = "🧠 rules: none";
    return detail ? `${base} (${detail})` : base;
  }
  const counts = ruleCounts(cache);
  const warn = cache.warnings.some((w) => w.level === "warning" || w.level === "error");
  const base = `${warn ? "⚠️" : "🧠"} rules: neighbor ${counts.always} always, ${counts.listed} listed`;
  return detail ? `${base} (${detail})` : base;
}

function alignPolicyFooterSession(selection: { selected: boolean; sessionId?: string }): void {
  if (!selection.selected || !selection.sessionId) {
    policyFooterState = null;
    return;
  }
  if (policyFooterState?.sessionId !== selection.sessionId) policyFooterState = null;
}

function setPolicyStableFooter(
  result: Extract<PropositionPolicyStableViewRuntimeReadResult, { ok: true }>,
): void {
  const itemLabel = result.itemCount === 1 ? "item" : "items";
  const stale = result.selectionStale ? `, stale diagnostic age ${Math.round(result.selectionAgeMs / 1_000)}s` : "";
  policyFooterState = {
    sessionId: result.sessionId,
    text: `🧠 rules: policy stable-view ${result.itemCount} ${itemLabel} (${result.viewBytes} B, bundle ${result.bundleHash.slice(0, 8)}…${stale})`,
  };
}

function setPolicyRejectedFooter(sessionId: string, reason: string): void {
  policyFooterState = {
    sessionId,
    text: `⚠️ rules: policy stable-view rejected (${reason.slice(0, 64)}); zero injection`,
  };
}

function runtimeFooterText(cache: RuleScanCache | null, _settings: RuleInjectorSettings, detail?: string): string {
  if (policyFooterState) return policyFooterState.text;
  return neighborFooterText(cache, detail);
}

function setFooterStatus(ctx: { ui?: { setStatus?(key: string, text: string | undefined): void } } | undefined, cache: RuleScanCache | null, settings: RuleInjectorSettings, detail?: string): void {
  try {
    if (!ctx?.ui?.setStatus) return;
    ctx.ui.setStatus(RULE_STATUS_KEY, runtimeFooterText(cache, settings, detail));
  } catch {
    // footer is best-effort
  }
}

// ── Diagnostic footer refresh (no watcher; /rule reload + test hook only) ──
interface RuleInjectorRealtimeGlobal {
  __abrainRules_setFooter?: (msg: string) => void;
}
const _RG = globalThis as unknown as RuleInjectorRealtimeGlobal;

function footerText(cache: RuleScanCache | null, settings: RuleInjectorSettings): string {
  return runtimeFooterText(cache, settings);
}

/** Capture a KEY-bound setStatus into globalThis so diagnostic refresh can push. */
function captureRulesFooterSetter(
  ctx: { ui?: { setStatus?(key: string, text: string | undefined): void } } | undefined,
): void {
  const setStatus = ctx?.ui?.setStatus;
  if (!setStatus) {
    _RG.__abrainRules_setFooter = undefined;
    return;
  }
  const bound = setStatus.bind(ctx!.ui);
  _RG.__abrainRules_setFooter = (msg: string) => { try { bound(RULE_STATUS_KEY, msg); } catch { /* best-effort */ } };
}

/** Re-scan + push the readonly-neighbor footer via the captured setter. Best-effort. */
export function refreshRulesFooterRealtime(cwd: string, settings: RuleInjectorSettings): void {
  const setFooter = _RG.__abrainRules_setFooter;
  if (!setFooter) return;
  try {
    cachedRules = scanRules({ abrainHome: ABRAIN_HOME, cwd, settings });
    setFooter(footerText(cachedRules, settings));
  } catch { /* best-effort */ }
}

function notifyWarningsOnce(ctx: { ui?: { notify?(message: string, type?: NotifyType): void } } | undefined, cache: RuleScanCache): void {
  if (!ctx?.ui?.notify) return;
  const warnings = cache.warnings.filter((w) => w.level === "warning" || w.level === "error");
  if (warnings.length === 0) return;
  const preview = warnings.slice(0, 4).map((w) => `- ${w.message}`).join("\n");
  const suffix = warnings.length > 4 ? `\n- ... ${warnings.length - 4} more` : "";
  try {
    ctx.ui.notify(`abrain rules: loaded with ${warnings.length} warning(s)\n${preview}${suffix}`, "warning");
  } catch {
    // notify is best-effort
  }
}

function allRules(cache: RuleScanCache): RuleEntry[] {
  return [...cache.globalAlways, ...cache.projectAlways, ...cache.globalListed, ...cache.projectListed];
}

function formatRuleList(cache: RuleScanCache, args: string): string {
  const scopeMatch = args.match(/--scope=(global|project)/);
  // §12.3 rename: --inject= is canonical; --tier= stays accepted as a legacy
  // alias for human muscle memory (diagnostic CLI only).
  const modeMatch = args.match(/--(?:inject|tier)=(always|listed)/);
  const scopeFilter = scopeMatch?.[1] as RuleScope | undefined;
  const modeFilter = modeMatch?.[1] as RuleInjectMode | undefined;
  const entries = allRules(cache).filter((e) => (!scopeFilter || e.scope === scopeFilter) && (!modeFilter || e.injectMode === modeFilter));
  if (entries.length === 0) return "No active abrain rules matched.";
  const lines = entries.map((e) => {
    const where = e.scope === "project" && e.projectId ? `project:${e.projectId}` : "global";
    return `- ${e.scopedSlug} [${where}/${e.injectMode}/${e.kind}/conf=${e.confidence}] ${e.mustDoSummary}`;
  });
  const counts = ruleCounts(cache);
  return [
    `Abrain rules: ${counts.always} always, ${counts.listed} listed (diagnostic view)`,
    ...lines,
  ].join("\n");
}

function findRule(cache: RuleScanCache, raw: string): RuleEntry | undefined {
  const query = slugify(raw);
  if (!query) return undefined;
  return allRules(cache).find((e) => e.slug === query || slugify(e.scopedSlug) === query || slugify(e.title) === query);
}

function formatRuleExplain(cache: RuleScanCache, rawSlug: string): string {
  const entry = findRule(cache, rawSlug);
  if (!entry) return `Rule not found: ${rawSlug}`;
  return [
    `${entry.scopedSlug}`,
    `title: ${entry.title}`,
    `scope: ${entry.scope}${entry.projectId ? ` (${entry.projectId})` : ""}`,
    `inject_mode: ${entry.injectMode}`,
    `kind: ${entry.kind}`,
    `confidence: ${entry.confidence}`,
    `status: ${entry.status}`,
    `source: ${entry.sourcePath}`,
    `applies_when: ${entry.appliesWhen || "-"}`,
    `trigger_phrases: ${formatCatalogList(entry.triggerPhrases, 240)}`,
    `must_do_summary: ${entry.mustDoSummary}`,
  ].join("\n");
}

function createPolicyRuntimeCache(cwdInput: string): RuleScanCache {
  const cwd = path.resolve(cwdInput || process.cwd());
  let activeProjectId: string | undefined;
  try { activeProjectId = resolveActiveProject(cwd, { abrainHome: ABRAIN_HOME }).activeProject?.projectId; } catch { /* unbound */ }
  return {
    abrainHome: ABRAIN_HOME,
    cwd,
    nonce: generateNonce(),
    globalAlways: [],
    globalListed: [],
    projectAlways: [],
    projectListed: [],
    warnings: [],
    scannedAt: new Date().toISOString(),
    ...(activeProjectId ? { activeProjectId } : {}),
  };
}

function runtimeMessageId(event: unknown): string | undefined {
  const row = event && typeof event === "object" ? event as Record<string, unknown> : {};
  for (const value of [row.messageId, row.message_id, row.id]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export default function activateRuleInjector(pi: ExtensionAPI): void {
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  const settings = resolveRuleInjectorSettings();

  const maybePi = pi as unknown as {
    on?: (event: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) => void;
    registerCommand?: (name: string, options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: { cwd?: string; sessionManager?: unknown; ui?: { notify?(message: string, type?: NotifyType): void; setStatus?(key: string, text: string | undefined): void } }) => Promise<void> | void;
    }) => void;
  };

  if (typeof maybePi.on === "function") maybePi.on("session_start", async (_event, ctx) => {
    if (isSubAgentSession(ctx)) return;
    const selection = selectPropositionPolicyStableViewSession({
      settings: settings.propositionPolicyStableViewInjection,
      sessionManager: ctx?.sessionManager,
    });
    alignPolicyFooterSession(selection);
    captureRulesFooterSetter(ctx);
    if (!selection.selected || !selection.sessionId) {
      cachedRules = null;
      try { ctx?.ui?.setStatus?.(RULE_STATUS_KEY, "🧠 rules: ephemeral session (no policy)"); } catch { /* best-effort */ }
      return;
    }
    cachedRules = createPolicyRuntimeCache(ctx?.cwd || process.cwd());
    try { ctx?.ui?.setStatus?.(RULE_STATUS_KEY, "🧠 rules: policy stable-view pending"); } catch { /* best-effort */ }
  });

  if (typeof maybePi.on === "function") maybePi.on("before_agent_start", async (event, ctx) => {
    if (isSubAgentSession(ctx)) return undefined;

    const current = typeof event.systemPrompt === "string" ? event.systemPrompt : "";
    const sanitized = stripAllManagedRuleInjections(current);
    const selection = selectPropositionPolicyStableViewSession({
      settings: settings.propositionPolicyStableViewInjection,
      sessionManager: ctx?.sessionManager,
    });
    alignPolicyFooterSession(selection);
    if (!selection.selected || !selection.sessionId) {
      cachedRules = null;
      return sanitized === current ? undefined : { systemPrompt: sanitized };
    }

    const cwd = ctx?.cwd || process.cwd();
    if (!cachedRules || path.resolve(cwd) !== cachedRules.cwd) cachedRules = createPolicyRuntimeCache(cwd);
    const readResult = readPropositionPolicyStableViewForRuntime({
      abrainHome: cachedRules.abrainHome,
      settings: settings.propositionPolicyStableViewInjection,
      sessionManager: ctx?.sessionManager,
      activeProjectId: cachedRules.activeProjectId,
    });

    let finalPrompt = sanitized;
    let decision: "policy_stable_view_injected" | "policy_stable_view_rejected";
    if (readResult.ok) {
      const injection = composePropositionPolicyStableViewInjection(cachedRules.nonce, readResult);
      finalPrompt = sanitized ? `${sanitized}\n\n${injection}` : injection;
      decision = "policy_stable_view_injected";
      setPolicyStableFooter(readResult);
    } else {
      decision = "policy_stable_view_rejected";
      setPolicyRejectedFooter(selection.sessionId, readResult.reason);
      try {
        ctx?.ui?.notify?.(`abrain rules: policy stable-view rejected (${readResult.reason}); zero injection`, "error");
      } catch { /* best-effort */ }
    }
    try { ctx?.ui?.setStatus?.(RULE_STATUS_KEY, policyFooterState?.text); } catch { /* best-effort */ }

    const audit = appendPropositionPolicyStableViewRuntimeAudit(buildPropositionPolicyStableViewRuntimeAuditRow({
      sessionId: selection.sessionId,
      latestUserText: typeof event.prompt === "string" ? event.prompt : "",
      ...(runtimeMessageId(event) ? { latestUserMessageId: runtimeMessageId(event) } : {}),
      decision,
      reason: readResult.reason,
      renderedPrompt: finalPrompt,
      readResult,
    }));
    if ("error" in audit) {
      try { console.error(`pi-astack: ADR0040 runtime audit write failed: ${audit.error}`); } catch { /* best-effort */ }
      try { ctx?.ui?.notify?.(`abrain rules: ADR0040 runtime audit write failed: ${audit.error}`, "error"); } catch { /* best-effort */ }
    }
    if (readResult.ok || finalPrompt !== current) return { systemPrompt: finalPrompt };
    return undefined;
  });

  if (typeof maybePi.registerCommand !== "function") return;
  maybePi.registerCommand("rule", {
    description: "Abrain rules diagnostics: /rule list [--scope=global|project] [--inject=always|listed] | /rule explain <slug> | /rule reload",
    getArgumentCompletions(prefix: string) {
      const items = ["list", "list --scope=global", "list --scope=project", "list --inject=always", "list --inject=listed", "explain ", "reload"];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx) {
      const trimmed = args.trim();
      const [sub = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : [];
      const runtimeSettings = resolveRuntimeRuleInjectorSettings(settings, ctx);
      if (sub === "reload") {
        cachedRules = scanRules({ abrainHome: ABRAIN_HOME, cwd: ctx?.cwd || process.cwd(), settings: runtimeSettings });
        setFooterStatus(ctx, cachedRules, runtimeSettings, "reloaded");
        notifyWarningsOnce(ctx, cachedRules);
        const counts = ruleCounts(cachedRules);
        ctx.ui?.notify?.(`abrain rules reloaded: ${counts.always} always, ${counts.listed} listed`, "info");
        return;
      }
      if (!cachedRules || path.resolve(ctx?.cwd || process.cwd()) !== cachedRules.cwd) {
        cachedRules = scanRules({ abrainHome: ABRAIN_HOME, cwd: ctx?.cwd || process.cwd(), settings: runtimeSettings });
      }
      if (sub === "list") {
        ctx.ui?.notify?.(formatRuleList(cachedRules, rest.join(" ")), "info");
        return;
      }
      if (sub === "explain") {
        const slug = rest.join(" ").trim();
        if (!slug) {
          ctx.ui?.notify?.("Usage: /rule explain <slug>", "warning");
          return;
        }
        ctx.ui?.notify?.(formatRuleExplain(cachedRules, slug), "info");
        return;
      }
      ctx.ui?.notify?.(`/rule: unknown subcommand '${sub}'. available: list / explain / reload`, "warning");
    },
  });
}
