/**
 * ADR 0023-R5 read-path: session-start rule injection.
 *
 * This module intentionally implements ONLY the ADR 0024-compatible read
 * path: scan existing rules/ entries and inject them into the main-session
 * system prompt.  It does not write rules, promote rules, ask for veto, or
 * expose a lifecycle-management UI.  State visibility (/rule list/explain)
 * is diagnostic pull; no user decision is required.
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
  scalarNumber,
  scalarString,
  splitCompiledTruth,
  splitFrontmatter,
} from "../../memory/parser";
import { slugify } from "../../memory/utils";

export type RuleTier = "always" | "listed";
export type RuleScope = "global" | "project";

type NotifyType = "info" | "warning" | "error";

export interface RuleInjectorSettings {
  enabled: boolean;
  alwaysTokenCapPerScope: number;
  listedTokenCapPerScope: number;
  alwaysCountCapPerScope: number;
  listedCountCapPerScope: number;
  maxAlwaysBodyChars: number;
  maxListedHintChars: number;
}

export interface RuleEntry {
  slug: string;
  scopedSlug: string;
  title: string;
  kind: string;
  status: string;
  confidence: number;
  tier: RuleTier;
  scope: RuleScope;
  projectId?: string;
  sourcePath: string;
  body: string;
  injectedText: string;
  hint: string;
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

const RULE_FENCE_RE = /<!-- BEGIN_ABRAIN_RULES session=([0-9a-f]+)[^>]*-->[\s\S]*?<!-- END_ABRAIN_RULES -->/g;

const DEFAULT_SETTINGS: RuleInjectorSettings = {
  enabled: true,
  alwaysTokenCapPerScope: 2_500,
  listedTokenCapPerScope: 1_500,
  alwaysCountCapPerScope: 15,
  listedCountCapPerScope: 30,
  maxAlwaysBodyChars: 300,
  maxListedHintChars: 80,
};

let cachedRules: RuleScanCache | null = null;

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

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const s = value.toLowerCase();
    if (["true", "1", "yes", "on"].includes(s)) return true;
    if (["false", "0", "no", "off"].includes(s)) return false;
  }
  return fallback;
}

function asNumber(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function resolveRuleInjectorSettings(): RuleInjectorSettings {
  const root = loadPiStackSettings();
  const cfg = (root.ruleInjector as Record<string, unknown>) ?? {};
  return {
    enabled: asBoolean(cfg.enabled, DEFAULT_SETTINGS.enabled),
    alwaysTokenCapPerScope: Math.max(100, asNumber(cfg.alwaysTokenCapPerScope, DEFAULT_SETTINGS.alwaysTokenCapPerScope)),
    listedTokenCapPerScope: Math.max(100, asNumber(cfg.listedTokenCapPerScope, DEFAULT_SETTINGS.listedTokenCapPerScope)),
    alwaysCountCapPerScope: Math.max(1, Math.floor(asNumber(cfg.alwaysCountCapPerScope, DEFAULT_SETTINGS.alwaysCountCapPerScope))),
    listedCountCapPerScope: Math.max(1, Math.floor(asNumber(cfg.listedCountCapPerScope, DEFAULT_SETTINGS.listedCountCapPerScope))),
    maxAlwaysBodyChars: Math.max(80, Math.floor(asNumber(cfg.maxAlwaysBodyChars, DEFAULT_SETTINGS.maxAlwaysBodyChars))),
    maxListedHintChars: Math.max(20, Math.floor(asNumber(cfg.maxListedHintChars, DEFAULT_SETTINGS.maxListedHintChars))),
  };
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
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function readRuleFile(
  file: string,
  tier: RuleTier,
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
  const hint = sanitizeSingleLine(
    scalarString(fm.hint) || firstBodyLine(body) || title,
    settings.maxListedHintChars,
  );
  const ruleBody = normalizeRuleBody(body, settings.maxAlwaysBodyChars);
  const injectedText = tier === "always"
    ? `[${kind}] ${ruleBody || title}`
    : `${scope === "project" && projectId ? `project:${projectId}:${slug}` : `global:${slug}`} — ${hint}`;

  return {
    entry: {
      slug,
      scopedSlug: scope === "project" && projectId ? `project:${projectId}:${slug}` : `global:${slug}`,
      title,
      kind,
      status,
      confidence,
      tier,
      scope,
      ...(projectId ? { projectId } : {}),
      sourcePath: file,
      body,
      injectedText,
      hint,
      tokenEstimate: estimateTokens(injectedText),
      updated: scalarString(fm.updated),
      created: scalarString(fm.created),
    },
  };
}

function scanTierDir(
  dir: string,
  tier: RuleTier,
  scope: RuleScope,
  settings: RuleInjectorSettings,
  warnings: RuleScanWarning[],
  projectId?: string,
): RuleEntry[] {
  const out: RuleEntry[] = [];
  for (const ent of readDirSorted(dir)) {
    if (!ent.isFile() || !ent.name.endsWith(".md") || ent.name === "_index.md") continue;
    const parsed = readRuleFile(path.join(dir, ent.name), tier, scope, settings, projectId);
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
// effect (no truncation, no demotion), which falsely implied an enforced cap
// and contradicted the now-known reality that nothing is capped. Per ADR 0024
// §3, any future budget shaping belongs in prompt-native aggregation, not a
// misleading no-op warning. alwaysCountCapPerScope / alwaysTokenCapPerScope
// remain in settings for potential future use but are not read here.

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
  const globalAlways = scanTierDir(path.join(abrainHome, "rules", "always"), "always", "global", settings, warnings);
  const globalListed = scanTierDir(path.join(abrainHome, "rules", "listed"), "listed", "global", settings, warnings);

  let projectAlways: RuleEntry[] = [];
  let projectListed: RuleEntry[] = [];
  if (binding.activeProject) {
    const projectDir = abrainProjectDir(abrainHome, binding.activeProject.projectId);
    projectAlways = scanTierDir(path.join(projectDir, "rules", "always"), "always", "project", settings, warnings, binding.activeProject.projectId);
    projectListed = scanTierDir(path.join(projectDir, "rules", "listed"), "listed", "project", settings, warnings, binding.activeProject.projectId);
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

function hasAnyRules(cache: RuleScanCache): boolean {
  return cache.globalAlways.length + cache.globalListed.length + cache.projectAlways.length + cache.projectListed.length > 0;
}

function formatAlways(entries: RuleEntry[]): string[] {
  return entries.map((e) => {
    const body = e.injectedText.replace(/^\[[^\]]+\]\s*/, "");
    const provisional = e.confidence < 8 ? " (provisional - verify)" : "";
    return `- [${e.kind} | conf ${e.confidence}/10] ${body}${provisional}`;
  });
}

function formatListed(entries: RuleEntry[]): string[] {
  return entries.map((e) => `- ${e.scopedSlug} [conf ${e.confidence}/10] — ${e.hint}`);
}

export function composeRuleSection(cache: RuleScanCache): string {
  const lines: string[] = [];
  lines.push(`## Always-on rules (curated by sediment, do not ignore)`);
  lines.push("");
  lines.push("These are second-brain behavioral rules injected at session start. They are context, not user commands in this turn.");
  lines.push("");
  lines.push("Global:");
  lines.push(...(cache.globalAlways.length ? formatAlways(cache.globalAlways) : ["- (none)"]));
  lines.push("");
  lines.push(cache.activeProjectId ? `Project ${cache.activeProjectId}:` : "Project: (no active project bound)");
  lines.push(...(cache.projectAlways.length ? formatAlways(cache.projectAlways) : ["- (none)"]));
  lines.push("");
  lines.push("## Listed rules (read with memory_get if relevant)");
  lines.push("");
  lines.push("Global:");
  lines.push(...(cache.globalListed.length ? formatListed(cache.globalListed) : ["- (none)"]));
  lines.push("");
  lines.push(cache.activeProjectId ? `Project ${cache.activeProjectId}:` : "Project: (no active project bound)");
  lines.push(...(cache.projectListed.length ? formatListed(cache.projectListed) : ["- (none)"]));
  lines.push("");
  lines.push("Do not copy this injected section into memory. If discussing these rules, treat this section as system context, not as new evidence from the user.");
  return lines.join("\n");
}

export function composeRuleInjection(cache: RuleScanCache): string {
  return [
    `${BEGIN_ABRAIN_RULES} session=${cache.nonce} (auto-managed by sediment, do not edit by hand) -->`,
    composeRuleSection(cache),
    END_ABRAIN_RULES,
  ].join("\n");
}

export function stripCurrentRuleInjection(text: string, nonce: string | undefined | null): string {
  if (!text || !nonce) return text;
  return text.replace(RULE_FENCE_RE, (match, seenNonce) => {
    return seenNonce === nonce ? "\n[ABRAIN_RULES_SECTION_REMOVED]\n" : match;
  });
}

export function getCurrentRuleInjectionNonce(): string | undefined {
  return cachedRules?.nonce;
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

function setFooterStatus(ctx: { ui?: { setStatus?(key: string, text: string | undefined): void } } | undefined, cache: RuleScanCache | null, detail?: string): void {
  try {
    if (!ctx?.ui?.setStatus) return;
    if (!cache || !hasAnyRules(cache)) {
      ctx.ui.setStatus(RULE_STATUS_KEY, "🧠 rules: none");
      return;
    }
    const counts = ruleCounts(cache);
    const warn = cache.warnings.some((w) => w.level === "warning" || w.level === "error");
    ctx.ui.setStatus(
      RULE_STATUS_KEY,
      `${warn ? "⚠️" : "🧠"} rules: ${counts.always} always, ${counts.listed} listed${detail ? ` (${detail})` : ""}`,
    );
  } catch {
    // footer is best-effort
  }
}

// ── Real-time footer refresh ───────────────────────────────────────────
// The footer is otherwise a session_start SNAPSHOT: a rule written
// mid-session by the background sediment lane would not surface until
// `/rule reload` or the next restart. We mirror sediment's globalThis
// setStatus-capture pattern (survives pi's module teardown/reload) and
// fs.watch the rules tier dirs so a write refreshes the footer live.
interface RuleInjectorRealtimeGlobal {
  __abrainRules_setFooter?: (msg: string) => void;
  __abrainRules_watchers?: fs.FSWatcher[];
  __abrainRules_debounce?: ReturnType<typeof setTimeout>;
  __abrainRules_watchKey?: string;
}
const _RG = globalThis as unknown as RuleInjectorRealtimeGlobal;

function footerText(cache: RuleScanCache | null): string {
  if (!cache || !hasAnyRules(cache)) return "🧠 rules: none";
  const counts = ruleCounts(cache);
  const warn = cache.warnings.some((w) => w.level === "warning" || w.level === "error");
  return `${warn ? "⚠️" : "🧠"} rules: ${counts.always} always, ${counts.listed} listed`;
}

/** Capture a KEY-bound setStatus into globalThis so the fs.watch callback
 *  (which has no ctx) can push the footer. Mirrors sediment's pattern. */
function captureRulesFooterSetter(
  ctx: { ui?: { setStatus?(key: string, text: string | undefined): void } } | undefined,
): void {
  const setStatus = ctx?.ui?.setStatus;
  if (!setStatus) {
    // Clear a stale setter from a previous session so the watch callback does
    // not target a dead UI (audit P2).
    _RG.__abrainRules_setFooter = undefined;
    return;
  }
  const bound = setStatus.bind(ctx!.ui);
  _RG.__abrainRules_setFooter = (msg: string) => { try { bound(RULE_STATUS_KEY, msg); } catch { /* best-effort */ } };
}

/** Re-scan + push the footer via the captured setter. Best-effort. */
export function refreshRulesFooterRealtime(cwd: string, settings: RuleInjectorSettings): void {
  const setFooter = _RG.__abrainRules_setFooter;
  if (!setFooter) return;
  try {
    cachedRules = scanRules({ abrainHome: ABRAIN_HOME, cwd, settings });
    setFooter(footerText(cachedRules));
  } catch { /* best-effort */ }
}

/** Watch the rules tier dirs (leaf, non-recursive — rule files are flat
 *  files in always/ and listed/) so a mid-session write refreshes the
 *  footer in real time. Idempotent: re-keys + tears down prior watchers on
 *  cwd/project change. persistent:false so it never blocks pi exit. */
function setupRulesWatcher(cwd: string, settings: RuleInjectorSettings, activeProjectId: string | undefined): void {
  const key = `${cwd}|${activeProjectId ?? ""}`;
  if (_RG.__abrainRules_watchKey === key && (_RG.__abrainRules_watchers?.length ?? 0) > 0) return;
  for (const w of _RG.__abrainRules_watchers ?? []) { try { w.close(); } catch { /* */ } }
  // Cancel any queued debounce from the OLD key so it cannot later refresh the
  // footer with stale (wrong-project) counts (audit P2).
  if (_RG.__abrainRules_debounce) { clearTimeout(_RG.__abrainRules_debounce); _RG.__abrainRules_debounce = undefined; }
  _RG.__abrainRules_watchers = [];
  _RG.__abrainRules_watchKey = key;
  const dirs = [
    path.join(ABRAIN_HOME, "rules", "always"),
    path.join(ABRAIN_HOME, "rules", "listed"),
    ...(activeProjectId ? [
      path.join(ABRAIN_HOME, "projects", activeProjectId, "rules", "always"),
      path.join(ABRAIN_HOME, "projects", activeProjectId, "rules", "listed"),
    ] : []),
  ];
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const w = fs.watch(dir, { persistent: false }, () => {
        if (_RG.__abrainRules_debounce) clearTimeout(_RG.__abrainRules_debounce);
        _RG.__abrainRules_debounce = setTimeout(() => refreshRulesFooterRealtime(cwd, settings), 300);
      });
      // fs.watch emits async 'error' events that the surrounding try/catch does
      // NOT catch; an unhandled one can crash the process (audit P1).
      w.on("error", () => { try { w.close(); } catch { /* */ } });
      _RG.__abrainRules_watchers.push(w);
    } catch { /* fs.watch unsupported / dir vanished — best-effort */ }
  }
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

function ensureRuleDirs(abrainHome: string): void {
  for (const rel of [path.join("rules", "always"), path.join("rules", "listed")]) {
    try { fs.mkdirSync(path.join(abrainHome, rel), { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
  }
}

function ensureProjectRuleDirs(abrainHome: string, projectId: string | undefined): void {
  if (!projectId) return;
  for (const rel of [path.join("rules", "always"), path.join("rules", "listed")]) {
    try { fs.mkdirSync(path.join(abrainProjectDir(abrainHome, projectId), rel), { recursive: true, mode: 0o700 }); } catch { /* best-effort */ }
  }
}

function allRules(cache: RuleScanCache): RuleEntry[] {
  return [...cache.globalAlways, ...cache.projectAlways, ...cache.globalListed, ...cache.projectListed];
}

function formatRuleList(cache: RuleScanCache, args: string): string {
  const scopeMatch = args.match(/--scope=(global|project)/);
  const tierMatch = args.match(/--tier=(always|listed)/);
  const scopeFilter = scopeMatch?.[1] as RuleScope | undefined;
  const tierFilter = tierMatch?.[1] as RuleTier | undefined;
  const entries = allRules(cache).filter((e) => (!scopeFilter || e.scope === scopeFilter) && (!tierFilter || e.tier === tierFilter));
  if (entries.length === 0) return "No active abrain rules matched.";
  const lines = entries.map((e) => {
    const where = e.scope === "project" && e.projectId ? `project:${e.projectId}` : "global";
    const display = e.tier === "always" ? e.injectedText.replace(/^\[[^\]]+\]\s*/, "") : e.hint;
    return `- ${e.scopedSlug} [${where}/${e.tier}/${e.kind}/conf=${e.confidence}] ${display}`;
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
    `tier: ${entry.tier}`,
    `kind: ${entry.kind}`,
    `confidence: ${entry.confidence}`,
    `status: ${entry.status}`,
    `source: ${entry.sourcePath}`,
    `injected: ${entry.tier === "always" ? entry.injectedText.replace(/^\[[^\]]+\]\s*/, "") : entry.hint}`,
  ].join("\n");
}

export default function activateRuleInjector(pi: ExtensionAPI): void {
  if (process.env.PI_ABRAIN_DISABLED === "1") return;

  const settings = resolveRuleInjectorSettings();
  if (!settings.enabled) return;

  const maybePi = pi as unknown as {
    on?: (event: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) => void;
    registerCommand?: (name: string, options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
      handler: (args: string, ctx: { cwd?: string; ui?: { notify?(message: string, type?: NotifyType): void; setStatus?(key: string, text: string | undefined): void } }) => Promise<void> | void;
    }) => void;
  };

  if (typeof maybePi.on === "function") maybePi.on("session_start", async (_event, ctx) => {
    // ADR 0027 PR-B: sub-agent has a dispatch-provided system prompt;
    // injecting project rules would conflict + the footer/notify channel
    // is main-session-only.
    if (isSubAgentSession(ctx)) return;

    try {
      ensureRuleDirs(ABRAIN_HOME);
      cachedRules = scanRules({ abrainHome: ABRAIN_HOME, cwd: ctx?.cwd || process.cwd(), settings });
      ensureProjectRuleDirs(ABRAIN_HOME, cachedRules.activeProjectId);
      setFooterStatus(ctx, cachedRules);
      notifyWarningsOnce(ctx, cachedRules);
      // Real-time footer: capture the setter + watch the rules dirs so a rule
      // written mid-session by background sediment refreshes the footer live
      // (no /rule reload or restart needed).
      captureRulesFooterSetter(ctx);
      setupRulesWatcher(ctx?.cwd || process.cwd(), settings, cachedRules.activeProjectId);
    } catch (e: unknown) {
      cachedRules = null;
      const msg = e instanceof Error ? e.message : String(e);
      try { ctx?.ui?.setStatus?.(RULE_STATUS_KEY, `⚠️ rules: ${msg.slice(0, 40)}`); } catch { /* ignore */ }
      try { ctx?.ui?.notify?.(`abrain rules: scan failed — ${msg}`, "warning"); } catch { /* ignore */ }
    }
  });

  if (typeof maybePi.on === "function") maybePi.on("before_agent_start", async (event, ctx) => {
    // ADR 0027 PR-B: do NOT inject project rules into a sub-agent’s
    // dispatch-crafted system prompt — would shadow the parent’s explicit
    // task framing.
    if (isSubAgentSession(ctx)) return undefined;

    const current = event.systemPrompt ?? "";
    if (current.includes(BEGIN_ABRAIN_RULES)) return undefined;
    if (!cachedRules || path.resolve(ctx?.cwd || process.cwd()) !== cachedRules.cwd) {
      try {
        cachedRules = scanRules({ abrainHome: ABRAIN_HOME, cwd: ctx?.cwd || process.cwd(), settings });
      } catch {
        return undefined;
      }
    }
    if (!hasAnyRules(cachedRules)) return undefined;
    return { systemPrompt: `${current}\n\n${composeRuleInjection(cachedRules)}` };
  });

  if (typeof maybePi.registerCommand !== "function") return;
  maybePi.registerCommand("rule", {
    description: "Abrain rules diagnostics: /rule list [--scope=global|project] [--tier=always|listed] | /rule explain <slug> | /rule reload",
    getArgumentCompletions(prefix: string) {
      const items = ["list", "list --scope=global", "list --scope=project", "list --tier=always", "list --tier=listed", "explain ", "reload"];
      const filtered = items.filter((item) => item.startsWith(prefix));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    async handler(args: string, ctx) {
      const trimmed = args.trim();
      const [sub = "list", ...rest] = trimmed ? trimmed.split(/\s+/) : [];
      if (sub === "reload") {
        cachedRules = scanRules({ abrainHome: ABRAIN_HOME, cwd: ctx?.cwd || process.cwd(), settings });
        setFooterStatus(ctx, cachedRules, "reloaded");
        notifyWarningsOnce(ctx, cachedRules);
        const counts = ruleCounts(cachedRules);
        ctx.ui?.notify?.(`abrain rules reloaded: ${counts.always} always, ${counts.listed} listed`, "info");
        return;
      }
      if (!cachedRules || path.resolve(ctx?.cwd || process.cwd()) !== cachedRules.cwd) {
        cachedRules = scanRules({ abrainHome: ABRAIN_HOME, cwd: ctx?.cwd || process.cwd(), settings });
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
