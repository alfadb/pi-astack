import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseWikilinkTarget, splitFrontmatter, type WikilinkTarget } from "./parser";
import { normalizeBareSlug, slugify } from "./utils";

const execFileAsync = promisify(execFile);

export type RenameFileScope =
  | { scope: "project"; projectId: string }
  | { scope: "world" }
  | { scope: "external"; zone: string };

export interface RenameTarget {
  scope: "project";
  projectId: string;
  oldSlug: string;
  newSlug: string;
}

export type RenameChangeKind = "wikilink" | "relation";

export interface RenameChange {
  kind: RenameChangeKind;
  from: string;
  to: string;
  line?: number;
}

export type RenamePreflightIssueCode =
  | "invalid_new_slug"
  | "same_slug"
  | "unsupported_inline_relation"
  | "scope_mismatch"
  | "preexisting_newslug_bare_ref"
  | "external_zone_reference_unhandled";

export interface RenamePreflightIssue {
  code: RenamePreflightIssueCode;
  detail: string;
  line?: number;
}

export interface RenameRewriteResult {
  content: string;
  changes: RenameChange[];
  issues: RenamePreflightIssue[];
}

export const RENAME_RELATION_KEYS: ReadonlySet<string> = new Set([
  "relates_to",
  "derives_from",
  "superseded_by",
  "applied_in",
  "contested_with",
  "references",
]);

function computeCodeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const fenceRe = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(body))) ranges.push([m.index, m.index + m[0].length]);
  const inlineRe = /`[^`\n]*`/g;
  while ((m = inlineRe.exec(body))) {
    const start = m.index;
    if (ranges.some(([s, e]) => start >= s && start < e)) continue;
    ranges.push([start, start + m[0].length]);
  }
  return ranges;
}

function isInside(pos: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([s, e]) => pos >= s && pos < e);
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

export function normalizeRenameTarget(input: RenameTarget): RenameTarget {
  return {
    scope: "project",
    projectId: input.projectId,
    oldSlug: slugify(input.oldSlug),
    newSlug: slugify(input.newSlug),
  };
}

export function basicRenamePreflight(targetRaw: RenameTarget): RenamePreflightIssue[] {
  const target = normalizeRenameTarget(targetRaw);
  const issues: RenamePreflightIssue[] = [];
  if (!target.newSlug) {
    issues.push({ code: "invalid_new_slug", detail: "newSlug slugifies to empty" });
  }
  if (target.oldSlug === target.newSlug) {
    issues.push({ code: "same_slug", detail: `oldSlug and newSlug are both ${target.oldSlug}` });
  }
  return issues;
}

function isBareTarget(tgt: WikilinkTarget): boolean {
  return !tgt.scope && !tgt.qualifier;
}

export function renameDecisionForTarget(
  tgt: WikilinkTarget,
  fileScope: RenameFileScope,
  targetRaw: RenameTarget,
): "bare" | "qualified" | null {
  const target = normalizeRenameTarget(targetRaw);
  if (!target.oldSlug || !target.newSlug) return null;
  if (tgt.scope === "project" && tgt.qualifier === target.projectId && tgt.slug === target.oldSlug) {
    return "qualified";
  }
  if (isBareTarget(tgt) && tgt.slug === target.oldSlug && fileScope.scope === "project" && fileScope.projectId === target.projectId) {
    return "bare";
  }
  return null;
}

function splitWikilinkInner(rawInner: string): { suffix: string } {
  const s = String(rawInner || "").trim();
  const aliasIdx = s.indexOf("|");
  const beforeAlias = aliasIdx >= 0 ? s.slice(0, aliasIdx) : s;
  const aliasSuffix = aliasIdx >= 0 ? s.slice(aliasIdx) : "";
  const anchorIdx = beforeAlias.indexOf("#");
  const anchorSuffix = anchorIdx >= 0 ? beforeAlias.slice(anchorIdx) : "";
  return { suffix: `${anchorSuffix}${aliasSuffix}` };
}

export function rewriteWikilinkInnerForRename(
  rawInner: string,
  fileScope: RenameFileScope,
  targetRaw: RenameTarget,
): string | null {
  const target = normalizeRenameTarget(targetRaw);
  const tgt = parseWikilinkTarget(rawInner);
  const decision = renameDecisionForTarget(tgt, fileScope, target);
  if (!decision) return null;
  const { suffix } = splitWikilinkInner(rawInner);
  if (decision === "qualified") return `project:${target.projectId}:${target.newSlug}${suffix}`;
  return `${target.newSlug}${suffix}`;
}

export function rewriteBodyWikilinksForRename(
  body: string,
  fileScope: RenameFileScope,
  target: RenameTarget,
): { body: string; changes: RenameChange[]; issues: RenamePreflightIssue[] } {
  const ranges = computeCodeRanges(body);
  const changes: RenameChange[] = [];
  const issues: RenamePreflightIssue[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (isInside(m.index, ranges)) continue;
    const rawInner = m[1]!;
    const rewritten = rewriteWikilinkInnerForRename(rawInner, fileScope, target);
    if (!rewritten) continue;
    const replacement = `[[${rewritten}]]`;
    out += body.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    changes.push({ kind: "wikilink", from: m[0], to: replacement, line: lineNumberAt(body, m.index) });
  }
  if (last === 0) return { body, changes, issues };
  out += body.slice(last);
  return { body: out, changes, issues };
}

function stripSymmetricQuotes(value: string): { inner: string; quote: "'" | '"' | "" } {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return { inner: trimmed.slice(1, -1), quote: trimmed[0] as "'" | '"' };
  }
  return { inner: trimmed, quote: "" };
}

function quoteValue(inner: string, quote: "'" | '"' | ""): string {
  return quote ? `${quote}${inner}${quote}` : inner;
}

function rewriteRelationValueForRename(
  rawValue: string,
  fileScope: RenameFileScope,
  targetRaw: RenameTarget,
): string | null {
  const target = normalizeRenameTarget(targetRaw);
  const { inner, quote } = stripSymmetricQuotes(rawValue);
  const tgt = parseWikilinkTarget(inner);
  const decision = renameDecisionForTarget(tgt, fileScope, target);
  if (!decision) return null;
  const next = decision === "qualified" ? `project:${target.projectId}:${target.newSlug}` : target.newSlug;
  return quoteValue(next, quote);
}

function inlineRelationMentionsTarget(inline: string, targetRaw: RenameTarget): boolean {
  const target = normalizeRenameTarget(targetRaw);
  const s = inline.toLowerCase();
  return s.includes(target.oldSlug.toLowerCase()) || s.includes(target.newSlug.toLowerCase());
}

export function rewriteFrontmatterRelationsForRename(
  frontmatterText: string,
  fileScope: RenameFileScope,
  target: RenameTarget,
): { frontmatterText: string; changes: RenameChange[]; issues: RenamePreflightIssue[] } {
  if (!frontmatterText) return { frontmatterText, changes: [], issues: [] };
  const lines = frontmatterText.split("\n");
  const changes: RenameChange[] = [];
  const issues: RenamePreflightIssue[] = [];
  let activeRelationKey: string | null = null;

  const out = lines.map((line, idx) => {
    const keyMatch = /^(\s*)([A-Za-z0-9_]+):(.*)$/.exec(line);
    if (keyMatch) {
      const indent = keyMatch[1]!;
      const key = keyMatch[2]!;
      const inline = keyMatch[3] ?? "";
      activeRelationKey = RENAME_RELATION_KEYS.has(key) && inline.trim() === "" ? key : null;
      if (!RENAME_RELATION_KEYS.has(key)) return line;
      const trimmedInline = inline.trim();
      if (!trimmedInline) return line;
      if (trimmedInline.startsWith("[") && inlineRelationMentionsTarget(trimmedInline, target)) {
        issues.push({ code: "unsupported_inline_relation", detail: `${key} uses inline/flow list; convert to block list before rename`, line: idx + 1 });
        return line;
      }
      const rewritten = rewriteRelationValueForRename(trimmedInline, fileScope, target);
      if (!rewritten) return line;
      const next = `${indent}${key}: ${rewritten}`;
      changes.push({ kind: "relation", from: line, to: next, line: idx + 1 });
      return next;
    }

    if (activeRelationKey) {
      const itemMatch = /^(\s*-\s*)(.+)$/.exec(line);
      if (!itemMatch) {
        if (/^\S/.test(line)) activeRelationKey = null;
        return line;
      }
      const prefix = itemMatch[1]!;
      const value = itemMatch[2]!.trim();
      const rewritten = rewriteRelationValueForRename(value, fileScope, target);
      if (!rewritten) return line;
      const next = `${prefix}${rewritten}`;
      changes.push({ kind: "relation", from: line, to: next, line: idx + 1 });
      return next;
    }
    return line;
  });

  return { frontmatterText: out.join("\n"), changes, issues };
}

export function rewriteMarkdownForRename(
  raw: string,
  fileScope: RenameFileScope,
  target: RenameTarget,
): RenameRewriteResult {
  const { frontmatterText, body } = splitFrontmatter(raw);
  const fm = rewriteFrontmatterRelationsForRename(frontmatterText, fileScope, target);
  const bodyResult = rewriteBodyWikilinksForRename(body, fileScope, target);
  const content = frontmatterText
    ? `---\n${fm.frontmatterText}\n---\n${bodyResult.body}`
    : bodyResult.body;
  return {
    content,
    changes: [...fm.changes, ...bodyResult.changes],
    issues: [...fm.issues, ...bodyResult.issues],
  };
}

export function findPreexistingBareNewSlugRefs(
  raw: string,
  fileScope: RenameFileScope,
  targetRaw: RenameTarget,
): RenamePreflightIssue[] {
  const target = normalizeRenameTarget(targetRaw);
  if (fileScope.scope !== "project" || fileScope.projectId !== target.projectId) return [];
  const issues: RenamePreflightIssue[] = [];
  const { frontmatterText, body } = splitFrontmatter(raw);
  const ranges = computeCodeRanges(body);
  const re = /\[\[([^\]]+)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (isInside(m.index, ranges)) continue;
    const tgt = parseWikilinkTarget(m[1]!);
    if (isBareTarget(tgt) && tgt.slug === target.newSlug) {
      issues.push({ code: "preexisting_newslug_bare_ref", detail: `bare [[${target.newSlug}]] already exists before rename`, line: lineNumberAt(body, m.index) });
    }
  }
  const fmLines = frontmatterText ? frontmatterText.split("\n") : [];
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i]!;
    const keyMatch = /^\s*([A-Za-z0-9_]+):(.*)$/.exec(line);
    if (!keyMatch || !RENAME_RELATION_KEYS.has(keyMatch[1]!)) continue;
    const inline = keyMatch[2]!.trim();
    if (inline && !inline.startsWith("[") && normalizeBareSlug(stripSymmetricQuotes(inline).inner) === target.newSlug) {
      issues.push({ code: "preexisting_newslug_bare_ref", detail: `relation ${keyMatch[1]} already contains bare ${target.newSlug} before rename`, line: i + 1 });
    }
  }
  return issues;
}

export function frontmatterScopeMatchesFileScope(frontmatterText: string, fileScope: RenameFileScope): RenamePreflightIssue[] {
  if (!frontmatterText || fileScope.scope === "external") return [];
  const m = /^scope:\s*([^\n#]+)/m.exec(frontmatterText);
  if (!m) return [];
  const declared = m[1]!.trim().replace(/^['"]|['"]$/g, "");
  if ((declared === "world" && fileScope.scope !== "world") || (declared === "project" && fileScope.scope !== "project")) {
    return [{ code: "scope_mismatch", detail: `frontmatter scope=${declared} conflicts with file scope=${fileScope.scope}` }];
  }
  return [];
}

export interface RenameFileChangePlan {
  path: string;
  newContent: string;
}

export interface RenameApplyPlan {
  target: RenameTarget;
  baseHead: string;
  entryOldPath: string;
  entryNewPath: string;
  entryNewContent: string;
  expectedNewId: string;
  fileChanges: RenameFileChangePlan[];
  /** Slugs that must be marked stale if rollback happens after vector mutation. */
  vectorStaleSlugs?: string[];
}

export interface RenameTransactionMarker {
  kind: "abrain-rename-transaction";
  version: 1;
  startedAt: string;
  target: RenameTarget;
  baseHead: string;
  entryOldPath: string;
  entryNewPath: string;
  expectedNewId: string;
  plannedPaths: string[];
  vectorStaleSlugs: string[];
}

export interface RenameApplyOptions {
  abrainHome: string;
  markerPath?: string;
  commitMessage?: string;
  /** Test hook: throw after a deterministic apply step. */
  failAfterStep?: "marker" | "entry_new" | "refs" | "vector" | "old_removed" | "git_add";
  /** Called after reference writes and before old-path removal. */
  onVectorRename?: () => Promise<void> | void;
}

export interface RenameRollbackResult {
  didRollback: boolean;
  markerPath: string;
  vectorStaleSlugs: string[];
  reason?: string;
}

function defaultMarkerPath(abrainHome: string): string {
  return path.join(abrainHome, ".state", "sediment", "rename-transaction.json");
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${path.basename(file)}-${process.pid}-${Date.now()}`);
  try {
    await fs.writeFile(tmp, content, "utf-8");
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => { /* already renamed / never written */ });
  }
}

async function gitStdout(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return String(stdout).trim();
}

async function isGitClean(cwd: string): Promise<boolean> {
  return (await gitStdout(cwd, ["status", "--porcelain"])).trim() === "";
}

function relPath(root: string, file: string): string {
  return path.relative(root, file);
}

async function readMaybe(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return null;
  }
}

function contentHasExpectedId(raw: string | null, expectedId: string): boolean {
  if (!raw) return false;
  const { frontmatterText } = splitFrontmatter(raw);
  const escaped = expectedId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^id:\\s*["']?${escaped}["']?\\s*$`, "m");
  return re.test(frontmatterText);
}

export async function writeRenameTransactionMarker(plan: RenameApplyPlan, opts: RenameApplyOptions): Promise<string> {
  const markerPath = opts.markerPath ?? defaultMarkerPath(opts.abrainHome);
  const target = normalizeRenameTarget(plan.target);
  const plannedPaths = Array.from(new Set([
    plan.entryOldPath,
    plan.entryNewPath,
    ...plan.fileChanges.map((c) => c.path),
  ])).sort();
  const marker: RenameTransactionMarker = {
    kind: "abrain-rename-transaction",
    version: 1,
    startedAt: new Date().toISOString(),
    target,
    baseHead: plan.baseHead,
    entryOldPath: plan.entryOldPath,
    entryNewPath: plan.entryNewPath,
    expectedNewId: plan.expectedNewId,
    plannedPaths,
    vectorStaleSlugs: plan.vectorStaleSlugs ?? [target.oldSlug, target.newSlug],
  };
  await atomicWrite(markerPath, `${JSON.stringify(marker, null, 2)}\n`);
  return markerPath;
}

async function loadRenameTransactionMarker(markerPath: string): Promise<RenameTransactionMarker | null> {
  const raw = await readMaybe(markerPath);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as RenameTransactionMarker;
  if (parsed.kind !== "abrain-rename-transaction" || parsed.version !== 1) {
    throw new Error(`unexpected rename transaction marker at ${markerPath}`);
  }
  return parsed;
}

export async function rollbackRenameTransaction(abrainHome: string, markerPath = defaultMarkerPath(abrainHome)): Promise<RenameRollbackResult> {
  const marker = await loadRenameTransactionMarker(markerPath);
  if (!marker) return { didRollback: false, markerPath, vectorStaleSlugs: [], reason: "no_marker" };

  const newRaw = await readMaybe(marker.entryNewPath);
  const oldExists = await fs.stat(marker.entryOldPath).then(() => true, () => false);
  const completed = !oldExists && contentHasExpectedId(newRaw, marker.expectedNewId);
  if (completed) {
    await fs.rm(markerPath, { force: true });
    return { didRollback: false, markerPath, vectorStaleSlugs: [], reason: "already_completed" };
  }

  const rels = marker.plannedPaths
    .filter((p) => p !== marker.entryNewPath)
    .map((p) => relPath(abrainHome, p))
    .filter((p) => p && !p.startsWith(".."));
  if (rels.length > 0) {
    await execFileAsync("git", ["-C", abrainHome, "restore", "--source", marker.baseHead, "--staged", "--worktree", "--", ...rels], { timeout: 20_000, maxBuffer: 1024 * 1024 });
  }
  await execFileAsync("git", ["-C", abrainHome, "rm", "--cached", "--ignore-unmatch", "--", relPath(abrainHome, marker.entryNewPath)], { timeout: 10_000, maxBuffer: 512 * 1024 }).catch(() => { /* not staged */ });
  await fs.rm(marker.entryNewPath, { force: true });
  await fs.rm(markerPath, { force: true });
  return { didRollback: true, markerPath, vectorStaleSlugs: marker.vectorStaleSlugs, reason: "rolled_back" };
}

export async function applyRenamePlan(plan: RenameApplyPlan, opts: RenameApplyOptions): Promise<{ committed: boolean; markerPath: string }> {
  const markerPath = opts.markerPath ?? defaultMarkerPath(opts.abrainHome);
  if (!(await isGitClean(opts.abrainHome))) {
    throw new Error("dirty_worktree");
  }
  await writeRenameTransactionMarker(plan, { ...opts, markerPath });
  if (opts.failAfterStep === "marker") throw new Error("injected failure after marker");
  try {
    await atomicWrite(plan.entryNewPath, plan.entryNewContent);
    if (opts.failAfterStep === "entry_new") throw new Error("injected failure after entry_new");
    for (const change of plan.fileChanges) await atomicWrite(change.path, change.newContent);
    if (opts.failAfterStep === "refs") throw new Error("injected failure after refs");
    await opts.onVectorRename?.();
    if (opts.failAfterStep === "vector") throw new Error("injected failure after vector");
    await fs.rm(plan.entryOldPath, { force: true });
    if (opts.failAfterStep === "old_removed") throw new Error("injected failure after old_removed");
    const rels = Array.from(new Set([
      plan.entryOldPath,
      plan.entryNewPath,
      ...plan.fileChanges.map((c) => c.path),
    ])).map((p) => relPath(opts.abrainHome, p));
    await execFileAsync("git", ["-C", opts.abrainHome, "add", "-A", "--", ...rels], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    if (opts.failAfterStep === "git_add") throw new Error("injected failure after git_add");
    if (opts.commitMessage) {
      await execFileAsync("git", ["-C", opts.abrainHome, "commit", "-m", opts.commitMessage], { timeout: 20_000, maxBuffer: 1024 * 1024 });
    }
    if (!contentHasExpectedId(await readMaybe(plan.entryNewPath), plan.expectedNewId)) {
      throw new Error("postcheck_failed_expected_id");
    }
    await fs.rm(markerPath, { force: true });
    return { committed: !!opts.commitMessage, markerPath };
  } catch (e) {
    await rollbackRenameTransaction(opts.abrainHome, markerPath);
    throw e;
  }
}
