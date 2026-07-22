/**
 * Cross-scope wikilink rewriter (D-decision plan, 2026-05-13).
 *
 * Walks every entry under a project's abrain dir (`<abrainHome>/projects/<id>/`)
 * and rewrites bare wikilinks / relation values that point at a slug NOT
 * present in the project but PRESENT in global abrain (`knowledge/` or
 * `workflows/`) so they carry an explicit `world:` / `workflow:` prefix
 * (or the equivalent normalisation for `abrain://...` URL form):
 *
 *   body wikilink:  [[foo]]        → [[world:foo]]
 *   frontmatter:    derives_from:
 *                     - foo        → - world:foo
 *   URL form:       relates_to:
 *                     - abrain://world/patterns/foo → - world:foo
 *
 * What it does NOT touch:
 *   - wikilinks inside fenced code blocks (``` ```)
 *   - wikilinks inside inline code spans (`...`)
 *   - already-prefixed wikilinks (`world:` / `workflow:` / `project:` /
 *     user-defined typed links like `person:`, `company:`)
 *   - bare slugs that hit project-internal entries (the implicit reading
 *     is correct: same-project reference)
 *   - bare slugs that hit nothing (genuine dead links — left alone for
 *     the author to fix or sediment to clean up)
 *   - frontmatter fields that aren't in RELATION_KEYS
 *   - inline-list YAML form (e.g. `derives_from: [foo, bar]`) — empirically
 *     not present in pi-global; defer until we see it in the wild
 *
 * Idempotence: a second pass produces zero changes because already-prefixed
 * wikilinks have `parseWikilinkTarget(...).scope !== undefined` and bypass
 * the rewrite gate.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { MemorySettings } from "./settings";
import { parseWikilinkTarget, scanStore, splitFrontmatter } from "./parser";
import { withCanonicalMutationBarrier } from "../_shared/canonical-mutation-barrier";

const execFileAsync = promisify(execFile);

// Mirrors parser.ts RELATION_KEYS but kept as a local literal to avoid
// re-exporting an internal set. Keep in sync if RELATION_KEYS changes.
const REWRITABLE_RELATION_KEYS: ReadonlySet<string> = new Set([
  "relates_to",
  "derives_from",
  "superseded_by",
  "applied_in",
  "contested_with",
  "references",
]);

export type RewriteChangeLocation = "body" | "frontmatter";

export interface RewriteChange {
  location: RewriteChangeLocation;
  /** Only set for `location === "frontmatter"`. */
  field?: string;
  before: string;
  after: string;
  /** Human-readable explanation: "world: hit / workflow: hit / url-normalise". */
  reason: string;
}

export interface RewriteEntryPlan {
  file: string;          // absolute path
  relPath: string;       // path relative to projectDir for display
  changes: RewriteChange[];
  /** Post-rewrite file content; set only on dry-run and apply. */
  newContent?: string;
}

export interface RewritePlan {
  projectDir: string;
  abrainHome: string;
  projectSlugs: Set<string>;
  globalSlugs: { world: Set<string>; workflow: Set<string> };
  entries: RewriteEntryPlan[];
  /** Number of entries with at least one change. */
  affectedFileCount: number;
  /** Aggregate change count across all entries. */
  totalChanges: number;
  /** Breakdown by reason for dry-run summary. */
  changeCounts: Record<string, number>;
}

export interface RewriteOptions {
  projectDir: string;
  abrainHome: string;
  settings: MemorySettings;
  signal?: AbortSignal;
  cwd?: string;
}

export interface RewriteApplyResult {
  ok: boolean;
  filesWritten: number;
  totalChanges: number;
  /** True when projectDir is inside a git repo and `git add` succeeded. */
  gitStaged: boolean;
}

/* ── Code-range computation: skip wikilinks inside code ────────────── */

function computeCodeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // Fenced code blocks first (greedy multi-line).
  const fenceRe = /```[\s\S]*?```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(body))) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  // Inline code spans (single-line, backtick-delimited).
  const inlineRe = /`[^`\n]*`/g;
  while ((m = inlineRe.exec(body))) {
    const start = m.index;
    // Skip if entirely inside a fenced block.
    if (ranges.some(([s, e]) => start >= s && start < e)) continue;
    ranges.push([start, start + m[0].length]);
  }
  return ranges;
}

function isInside(pos: number, ranges: Array<[number, number]>): boolean {
  for (const [s, e] of ranges) {
    if (pos >= s && pos < e) return true;
  }
  return false;
}

/* ── Per-link rewrite decision ─────────────────────────────────────── */

function decideRewriteForBareSlug(
  slug: string,
  projectSlugs: Set<string>,
  globalSlugs: { world: Set<string>; workflow: Set<string> },
): "world" | "workflow" | null {
  if (!slug) return null;
  if (projectSlugs.has(slug)) return null;
  if (globalSlugs.world.has(slug)) return "world";
  if (globalSlugs.workflow.has(slug)) return "workflow";
  return null;
}

/* ── Body wikilink rewrite ─────────────────────────────────────────── */

function rewriteBodyWikilinks(
  body: string,
  projectSlugs: Set<string>,
  globalSlugs: { world: Set<string>; workflow: Set<string> },
): { body: string; changes: RewriteChange[] } {
  const ranges = computeCodeRanges(body);
  const re = /\[\[([^\]]+)\]\]/g;
  const changes: RewriteChange[] = [];
  let out = "";
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (isInside(m.index, ranges)) continue;
    const inner = m[1]!;
    const target = parseWikilinkTarget(inner);
    // Already-prefixed wikilinks (world:/workflow:/project:/person: etc.)
    // have target.scope set; do not rewrite.
    if (target.scope !== undefined) continue;
    const newScope = decideRewriteForBareSlug(target.slug, projectSlugs, globalSlugs);
    if (!newScope) continue;
    const before = m[0];
    const after = `[[${newScope}:${target.slug}]]`;
    out += body.slice(lastIdx, m.index) + after;
    lastIdx = m.index + before.length;
    changes.push({
      location: "body",
      before,
      after,
      reason: `${newScope} hit`,
    });
  }
  out += body.slice(lastIdx);
  return { body: out, changes };
}

/* ── Frontmatter relation rewrite ──────────────────────────────────── */

function maybeRewriteRelationValue(
  raw: string,
  projectSlugs: Set<string>,
  globalSlugs: { world: Set<string>; workflow: Set<string> },
): { value: string; reason: string } | null {
  // Strip surrounding quotes (single or double); preserve choice for
  // round-trip if rewrite happens.
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let inner = trimmed;
  let quote = "";
  const quoteMatch = /^(['"])(.+)\1$/.exec(trimmed);
  if (quoteMatch) {
    quote = quoteMatch[1]!;
    inner = quoteMatch[2]!;
  }

  // parseWikilinkTarget understands bare slug, `world:foo`, `workflow:foo`,
  // `project:<id>:foo`, `unknown:foo`, and `abrain://world/.../foo` URLs.
  const target = parseWikilinkTarget(inner);
  if (!target.slug) return null;

  // URL form: normalise to `world:slug` / `workflow:slug` regardless of
  // whether slug is currently in project — author explicitly used global
  // form, so respect the intent and compact the syntax.
  if (/^abrain:\/\//i.test(inner) && (target.scope === "world" || target.scope === "workflow")) {
    const compact = `${target.scope}:${target.slug}`;
    if (compact === inner) return null;  // already compact (impossible from URL, but defensive)
    return { value: `${quote}${compact}${quote}`, reason: "url-normalise" };
  }

  // Already prefixed (any non-undefined scope) → leave alone. This covers
  // `world:foo`, `workflow:foo`, `project:<id>:foo`, and user-defined
  // typed links (`person:foo`, `company:foo`).
  if (target.scope !== undefined) return null;

  // Bare slug: rewrite only if it hits a global zone and is NOT a
  // project-local slug.
  const newScope = decideRewriteForBareSlug(target.slug, projectSlugs, globalSlugs);
  if (!newScope) return null;
  return { value: `${quote}${newScope}:${target.slug}${quote}`, reason: `${newScope} hit` };
}

function rewriteFrontmatter(
  fmText: string,
  projectSlugs: Set<string>,
  globalSlugs: { world: Set<string>; workflow: Set<string> },
): { fmText: string; changes: RewriteChange[] } {
  const lines = fmText.split("\n");
  const changes: RewriteChange[] = [];
  let currentKey: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Skip the YAML delimiter lines if present (caller may include them).
    if (line === "---") continue;

    // Top-level key: `<name>:` or `<name>: <inline value>` at column 0.
    const topMatch = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/.exec(line);
    if (topMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      currentKey = topMatch[1]!;
      const afterColon = topMatch[2]!;
      const inline = afterColon.trimStart();
      // Inline scalar value form: `derives_from: foo-bar` (no list, no
      // multi-line). The YAML may also be inline-list `[a, b]` — we don't
      // touch that form (empirically absent in pi-global).
      if (
        inline &&
        !inline.startsWith("[") &&
        !inline.startsWith("{") &&
        REWRITABLE_RELATION_KEYS.has(currentKey)
      ) {
        const decision = maybeRewriteRelationValue(inline, projectSlugs, globalSlugs);
        if (decision) {
          // Preserve any leading whitespace between colon and value.
          const leading = afterColon.slice(0, afterColon.length - inline.length);
          lines[i] = `${currentKey}:${leading}${decision.value}`;
          changes.push({
            location: "frontmatter",
            field: currentKey,
            before: inline,
            after: decision.value,
            reason: decision.reason,
          });
        }
      }
      continue;
    }

    // List item under the current key: `<indent>- <value>` or
    // `<indent>- to: <value>` (object form, where `to` is the slug field).
    if (currentKey && REWRITABLE_RELATION_KEYS.has(currentKey)) {
      const bullet = /^(\s+-\s+)(.*)$/.exec(line);
      if (bullet) {
        const head = bullet[1]!;
        const rest = bullet[2]!;
        // Object form: `- to: foo` or `- {to: foo, type: ...}` — the
        // wider form rarely appears; we handle the `- to: <slug>` line
        // and let inline-flow `{}` form pass through.
        const toMatch = /^to:\s*(.+?)\s*$/.exec(rest);
        if (toMatch) {
          const decision = maybeRewriteRelationValue(toMatch[1]!, projectSlugs, globalSlugs);
          if (decision) {
            lines[i] = `${head}to: ${decision.value}`;
            changes.push({
              location: "frontmatter",
              field: currentKey,
              before: toMatch[1]!,
              after: decision.value,
              reason: decision.reason,
            });
          }
          continue;
        }
        // Plain scalar list item: `- foo-bar`.
        const decision = maybeRewriteRelationValue(rest, projectSlugs, globalSlugs);
        if (decision) {
          lines[i] = `${head}${decision.value}`;
          changes.push({
            location: "frontmatter",
            field: currentKey,
            before: rest,
            after: decision.value,
            reason: decision.reason,
          });
        }
      }
    }
  }

  return { fmText: lines.join("\n"), changes };
}

/* ── Plan / Apply ─────────────────────────────────────────────────── */

async function collectProjectSlugs(
  projectDir: string,
  settings: MemorySettings,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<Set<string>> {
  const slugs = new Set<string>();
  const entries = await scanStore(
    { scope: "project", root: projectDir, label: "project" },
    cwd,
    settings,
    signal,
  );
  for (const entry of entries) slugs.add(entry.slug);
  return slugs;
}

async function collectGlobalSlugs(
  abrainHome: string,
  settings: MemorySettings,
  signal: AbortSignal | undefined,
  cwd: string,
): Promise<{ world: Set<string>; workflow: Set<string> }> {
  const out = { world: new Set<string>(), workflow: new Set<string>() };
  for (const [scope, subdir] of [
    ["world" as const, "knowledge"],
    ["workflow" as const, "workflows"],
  ]) {
    const root = path.join(abrainHome, subdir);
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const entries = await scanStore({ scope: "world", root, label: subdir }, cwd, settings, signal);
    for (const entry of entries) out[scope].add(entry.slug);
  }
  return out;
}

export async function scanRewritePlan(opts: RewriteOptions): Promise<RewritePlan> {
  const projectDir = path.resolve(opts.projectDir);
  const abrainHome = path.resolve(opts.abrainHome);
  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();

  const projectSlugs = await collectProjectSlugs(projectDir, opts.settings, opts.signal, cwd);
  const globalSlugs = await collectGlobalSlugs(abrainHome, opts.settings, opts.signal, cwd);

  // Enumerate every .md under projectDir except derived files. Reuse the
  // scanStore listing path indirectly via filesystem walk, since scanStore
  // returns parsed entries (we want raw paths AND any non-_index.md file
  // including frontmatter-broken ones — but legacy seeds are absent here
  // post-migration so the gap is academic).
  const files = await listMarkdownFilesUnder(projectDir);

  const entries: RewriteEntryPlan[] = [];
  let affectedFileCount = 0;
  let totalChanges = 0;
  const changeCounts: Record<string, number> = {};

  for (const file of files) {
    const raw = await fs.readFile(file, "utf-8");
    const { frontmatterText, body } = splitFrontmatter(raw);

    const fmResult = rewriteFrontmatter(frontmatterText, projectSlugs, globalSlugs);
    const bodyResult = rewriteBodyWikilinks(body, projectSlugs, globalSlugs);
    const changes = [...fmResult.changes, ...bodyResult.changes];

    const relPath = path.relative(projectDir, file);
    const entry: RewriteEntryPlan = { file, relPath, changes };
    if (changes.length > 0) {
      // Reconstruct file content preserving the original delimiters.
      const newContent = frontmatterText
        ? `---\n${fmResult.fmText}\n---\n${bodyResult.body}`
        : bodyResult.body;
      entry.newContent = newContent;
      affectedFileCount += 1;
      totalChanges += changes.length;
      for (const change of changes) {
        changeCounts[change.reason] = (changeCounts[change.reason] ?? 0) + 1;
      }
    }
    entries.push(entry);
  }

  return {
    projectDir,
    abrainHome,
    projectSlugs,
    globalSlugs,
    entries,
    affectedFileCount,
    totalChanges,
    changeCounts,
  };
}

async function listMarkdownFilesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      // Skip hidden / index / state dirs that scanStore would also skip.
      if (name.startsWith(".") || name === "_index.md" || name === "_project.json") continue;
      const abs = path.join(dir, name);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await walk(abs);
      } else if (stat.isFile() && abs.endsWith(".md")) {
        out.push(abs);
      }
    }
  }
  await walk(root);
  out.sort();
  return out;
}

/* ── Apply: write files + git-add (no commit) ─────────────────────── */

async function gitRootOf(dir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      timeout: 3000,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf-8");
  await fs.rename(tmp, file);
}

export async function applyRewritePlan(plan: RewritePlan): Promise<RewriteApplyResult> {
  return withCanonicalMutationBarrier(plan.abrainHome, () => applyRewritePlanUnlocked(plan));
}

async function applyRewritePlanUnlocked(plan: RewritePlan): Promise<RewriteApplyResult> {
  const affected = plan.entries.filter((e) => e.changes.length > 0 && e.newContent !== undefined);
  let filesWritten = 0;
  for (const entry of affected) {
    await atomicWrite(entry.file, entry.newContent!);
    filesWritten += 1;
  }

  // Best-effort git-add (no commit). If projectDir isn't inside a repo we
  // simply report gitStaged=false; caller can `git add` themselves.
  let gitStaged = false;
  const gitRoot = await gitRootOf(plan.projectDir);
  if (gitRoot && filesWritten > 0) {
    try {
      const rel = affected.map((e) => path.relative(gitRoot, e.file));
      await execFileAsync("git", ["-C", gitRoot, "add", "--", ...rel], {
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      gitStaged = true;
    } catch {
      gitStaged = false;
    }
  }

  return { ok: true, filesWritten, totalChanges: plan.totalChanges, gitStaged };
}

/* ── Format dry-run report ────────────────────────────────────────── */

export function formatRewritePlan(plan: RewritePlan, maxEntries = 20): string {
  const lines: string[] = [
    `Cross-scope wikilink rewrite plan:`,
    `  project:   ${plan.projectDir}`,
    `  abrain:    ${plan.abrainHome}`,
    `  files affected: ${plan.affectedFileCount} / ${plan.entries.length}`,
    `  total changes: ${plan.totalChanges}`,
  ];
  if (Object.keys(plan.changeCounts).length > 0) {
    lines.push(`  by reason:`);
    for (const [reason, count] of Object.entries(plan.changeCounts).sort()) {
      lines.push(`    - ${reason}: ${count}`);
    }
  }
  if (plan.totalChanges === 0) {
    lines.push("");
    lines.push("(no changes — project already explicit, or no global slugs hit)");
    return lines.join("\n");
  }
  lines.push("");
  lines.push(`Changes (first ${maxEntries} file(s)):`);
  let shown = 0;
  for (const entry of plan.entries) {
    if (entry.changes.length === 0) continue;
    if (shown >= maxEntries) {
      lines.push(`  ... ${plan.affectedFileCount - shown} more file(s) omitted`);
      break;
    }
    lines.push(`  - ${entry.relPath} (${entry.changes.length} change(s))`);
    for (const change of entry.changes.slice(0, 5)) {
      const field = change.field ? ` [${change.field}]` : "";
      lines.push(`      ${change.location}${field}: ${change.before}  →  ${change.after}`);
    }
    if (entry.changes.length > 5) {
      lines.push(`      ... ${entry.changes.length - 5} more change(s) in this file`);
    }
    shown += 1;
  }
  return lines.join("\n");
}
