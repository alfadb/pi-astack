import { parseWikilinkTarget, splitFrontmatter, type WikilinkTarget } from "./parser";
import { normalizeBareSlug, slugify } from "./utils";

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
