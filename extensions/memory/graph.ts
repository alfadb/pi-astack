import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { MemorySettings } from "./settings";
import type { MemoryEntry, RelationScope, Scope } from "./types";
import { parseEntry, scanStore } from "./parser";
import { prettyPath } from "./utils";
import { formatLocalIsoTimestamp } from "../_shared/runtime";

interface GraphNode {
  title: string;
  scope: Scope;
  kind: string;
  status: string;
  confidence: number;
  in_degree: number;
  out_degree: number;
}

interface GraphEdge {
  from: string;
  to: string;
  type: string;
  source: "frontmatter" | "body_wikilink";
  /** Explicit scope from a prefixed wikilink / URL (parseWikilinkTarget).
   *  Mirrors RelationEdge.scope; undefined = implicit bare wikilink.
   *  2026-05-24 fix: previously dropped on edge creation — every
   *  edge.scope === "world" | "workflow" | "project" | "unknown"
   *  branch in cross-scope routing below evaluated false, so explicit
   *  prefixed wikilinks were silently treated as implicit fallthrough
   *  and `cross_scope_links` was always empty. */
  scope?: RelationScope;
  /** Extra qualifier: project id when scope==="project"; raw prefix when
   *  scope==="unknown". Mirrors RelationEdge.qualifier. */
  qualifier?: string;
}

export interface GraphSnapshot {
  built_at: string;
  git_head?: string | null;
  stale: false;
  nodes: Record<string, GraphNode>;
  edges: GraphEdge[];
  stats: {
    node_count: number;
    edge_count: number;
    orphans: string[];
    dead_links: Array<{ from: string; to: string; type: string }>;
    /**
     * Cross-scope wikilinks: from a project entry to a slug that is NOT
     * present in the project but IS present in global abrain
     * (`<abrainHome>/knowledge/` or `<abrainHome>/workflows/`). Tracked
     * separately from `dead_links` because they're navigable via
     * memory_search / memory_get, just not in-scope for project graph.
     * Empty array when target is not an abrain project (legacy
     * .pensieve / global abrain target / arbitrary markdown tree).
     */
    cross_scope_links: Array<{ from: string; to: string; type: string }>;
  };
}

interface BacklinkIssue {
  from: string;
  to: string;
  type: string;
  problem: "missing_symmetric_backlink" | "dead_link";
}

export interface BacklinkReport {
  target: string;
  nodeCount: number;
  edgeCount: number;
  deadLinkCount: number;
  missingSymmetricCount: number;
  issues: BacklinkIssue[];
}

export interface GraphRebuildReport {
  target: string;
  graph_path: string;
  nodeCount: number;
  edgeCount: number;
  deadLinkCount: number;
  orphanCount: number;
  git_head?: string | null;
}

const execFileAsync = promisify(execFile);

const SYMMETRIC_RELATIONS = new Set(["relates_to", "contested_with"]);

function abrainRoot(): string {
  return path.resolve(
    process.env.ABRAIN_ROOT
      ? process.env.ABRAIN_ROOT.replace(/^~(?=$|\/)/, os.homedir())
      : path.join(os.homedir(), ".abrain"),
  );
}

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function inferScopeFromTarget(target: string): Scope {
  return isInside(abrainRoot(), path.resolve(target)) ? "world" : "project";
}

/**
 * Detect whether `target` lives under `<abrainHome>/projects/<id>/`. When
 * yes, the project graph should treat wikilinks pointing at slugs found
 * in global abrain (`knowledge/` + `workflows/`) as CROSS-SCOPE links,
 * not dead links — the canonical copy lives one zone up. Returns null
 * for legacy .pensieve, the global abrain root itself, or arbitrary
 * markdown trees outside abrain.
 *
 * Used by buildGraphSnapshot so that doctor-lite no longer fires
 * deadLink errors on every project entry that references the 4 global
 * Linus maxims (`reduce-complexity-...`, `eliminate-special-cases-...`,
 * etc.) prune-extracted by the per-repo migration.
 */
function abrainProjectContext(target: string): { abrainHome: string; projectId: string } | null {
  const abs = path.resolve(target);
  const abrain = abrainRoot();
  if (!isInside(abrain, abs)) return null;
  const projectsDir = path.join(abrain, "projects");
  if (!isInside(projectsDir, abs)) return null;
  if (path.resolve(projectsDir) === abs) return null;  // target is `projects/` itself
  const rel = path.relative(projectsDir, abs);
  if (!rel || rel.startsWith("..")) return null;
  const projectId = rel.split(path.sep)[0]!;
  if (!projectId) return null;
  return { abrainHome: abrain, projectId };
}

/**
 * Collect global abrain slug sets KEYED BY zone:
 *   { world: Set(...knowledge slugs), workflow: Set(...workflows slugs) }
 *
 * Explicit `[[world:foo]]` / `[[workflow:foo]]` wikilinks resolve
 * against the matching zone; implicit bare `[[foo]]` wikilinks fall
 * back to either zone for transitional compatibility.
 */
async function collectAbrainGlobalSlugsByScope(
  abrainHome: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<{ world: Set<string>; workflow: Set<string> }> {
  const result = { world: new Set<string>(), workflow: new Set<string>() };
  const mapping: Array<["world" | "workflow", string]> = [
    ["world", "knowledge"],
    ["workflow", "workflows"],
  ];
  for (const [scope, subdir] of mapping) {
    const root = path.join(abrainHome, subdir);
    try {
      const stat = await fs.stat(root);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const entries = await scanStore(
      { scope: "world", root, label: subdir },
      cwd,
      settings,
      signal,
    );
    for (const entry of entries) result[scope].add(entry.slug);
  }
  return result;
}

function storeRootForFile(abs: string): string {
  const resolved = path.resolve(abs);
  const abrain = abrainRoot();
  if (isInside(abrain, resolved)) return abrain;
  const parts = resolved.split(path.sep);
  const idx = parts.lastIndexOf(".pensieve");
  if (idx >= 0) return parts.slice(0, idx + 1).join(path.sep) || path.sep;
  return path.dirname(resolved);
}

async function graphRootForTarget(target: string): Promise<string> {
  const abs = path.resolve(target);
  try {
    const stat = await fs.stat(abs);
    if (stat.isFile()) return storeRootForFile(abs);
  } catch {
    return abs;
  }
  return abs;
}

async function entriesForGraphTarget(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<MemoryEntry[]> {
  const abs = path.resolve(target);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch {
    return [];
  }

  if (stat.isFile()) {
    const storeRoot = storeRootForFile(abs);
    const entry = await parseEntry(abs, { scope: inferScopeFromTarget(storeRoot), root: storeRoot, label: "target" }, cwd);
    return entry ? [entry] : [];
  }

  return scanStore(
    { scope: inferScopeFromTarget(abs), root: abs, label: "target" },
    cwd,
    settings,
    signal,
  );
}

async function gitHead(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "HEAD"], {
      timeout: 2_000,
      maxBuffer: 256 * 1024,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function graphIndexPath(target: string): Promise<string> {
  const root = await graphRootForTarget(target);
  if (inferScopeFromTarget(root) === "world") {
    return path.join(root, ".state", "index", "graph.json");
  }
  return path.join(root, ".index", "graph.json");
}

export async function buildGraphSnapshot(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<GraphSnapshot> {
  const root = await graphRootForTarget(target);
  const entries = await entriesForGraphTarget(target, settings, signal, cwd);
  const nodes: Record<string, GraphNode> = {};
  const edges: GraphEdge[] = [];

  for (const entry of entries) {
    nodes[entry.slug] = {
      title: entry.title,
      scope: entry.scope,
      kind: entry.kind,
      status: entry.status,
      confidence: entry.confidence,
      in_degree: 0,
      out_degree: 0,
    };
  }

  for (const entry of entries) {
    for (const relation of entry.relations) {
      const edge: GraphEdge = {
        from: entry.slug,
        to: relation.to,
        type: relation.type,
        source: relation.source,
      };
      // 2026-05-24 fix: forward scope/qualifier from RelationEdge so
      // cross-scope routing (edges with explicit world: / workflow: /
      // project: / typed-prefix) actually works downstream.
      if (relation.scope) edge.scope = relation.scope;
      if (relation.qualifier) edge.qualifier = relation.qualifier;
      edges.push(edge);
    }
  }

  // Pre-load global abrain slugs only when target is an abrain project;
  // legacy .pensieve / arbitrary trees / the global abrain root itself
  // don't have a meaningful "cross-scope fallback" zone above them.
  const projectCtx = abrainProjectContext(root);
  const globalZones = projectCtx
    ? await collectAbrainGlobalSlugsByScope(projectCtx.abrainHome, settings, signal, cwd)
    : null;

  const dead_links: Array<{ from: string; to: string; type: string }> = [];
  const cross_scope_links: Array<{ from: string; to: string; type: string }> = [];
  for (const edge of edges) {
    if (nodes[edge.from]) nodes[edge.from].out_degree += 1;

    // Explicit scope from a prefixed wikilink (parseWikilinkTarget):
    // bypass project-internal lookup entirely — the author named the
    // zone explicitly, so route there directly.
    if (edge.scope === "world" || edge.scope === "workflow") {
      const zoneSlugs = globalZones ? globalZones[edge.scope] : null;
      if (zoneSlugs && zoneSlugs.has(edge.to)) {
        cross_scope_links.push({ from: edge.from, to: edge.to, type: edge.type });
      } else {
        // Explicit prefix but slug not in target zone — genuine dead
        // link (typo / target moved / not yet seeded).
        dead_links.push({ from: edge.from, to: edge.to, type: edge.type });
      }
      continue;
    }
    if (edge.scope === "project") {
      // Cross-project reference (project:<id>:slug). Currently not
      // resolved by buildGraphSnapshot — we'd need to scan another
      // project's directory. Treat as cross-scope (acknowledged) so it
      // doesn't fire as dead. Cross-project resolution is future work.
      cross_scope_links.push({ from: edge.from, to: edge.to, type: edge.type });
      continue;
    }
    if (edge.scope === "unknown") {
      // User-defined typed link (`person:`, `company:`, etc.) — no
      // scope routing. Try project-internal; otherwise treat as
      // dead but DON'T cross-scope fall back (the prefix means the
      // author already declared this isn't a regular slug).
      if (nodes[edge.to]) nodes[edge.to].in_degree += 1;
      else dead_links.push({ from: edge.from, to: edge.to, type: edge.type });
      continue;
    }

    // Implicit bare wikilink: project-internal first, then global
    // fallback (transitional compatibility per D3). Once rewriter has
    // explicitised all historical cross-scope refs, this fallback is
    // mostly dormant; we keep it so hand-edited / third-party entries
    // that still use bare slugs don't immediately fire dead-link.
    if (nodes[edge.to]) {
      nodes[edge.to].in_degree += 1;
    } else if (globalZones && (globalZones.world.has(edge.to) || globalZones.workflow.has(edge.to))) {
      cross_scope_links.push({ from: edge.from, to: edge.to, type: edge.type });
    } else {
      dead_links.push({ from: edge.from, to: edge.to, type: edge.type });
    }
  }

  const orphans = Object.entries(nodes)
    .filter(([, node]) => node.in_degree === 0 && node.out_degree === 0)
    .map(([slug]) => slug)
    .sort();

  return {
    built_at: formatLocalIsoTimestamp(),
    git_head: await gitHead(root),
    stale: false,
    nodes,
    edges,
    stats: {
      node_count: Object.keys(nodes).length,
      edge_count: edges.length,
      orphans,
      dead_links,
      cross_scope_links,
    },
  };
}

export async function checkBacklinks(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<BacklinkReport> {
  const graph = await buildGraphSnapshot(target, settings, signal, cwd);
  const edgeSet = new Set(graph.edges.map((edge) => `${edge.from}\0${edge.to}\0${edge.type}`));
  const issues: BacklinkIssue[] = [];

  for (const dead of graph.stats.dead_links) {
    issues.push({ ...dead, problem: "dead_link" });
  }

  for (const edge of graph.edges) {
    if (!SYMMETRIC_RELATIONS.has(edge.type)) continue;
    if (!graph.nodes[edge.to]) continue;
    if (!edgeSet.has(`${edge.to}\0${edge.from}\0${edge.type}`)) {
      issues.push({
        from: edge.from,
        to: edge.to,
        type: edge.type,
        problem: "missing_symmetric_backlink",
      });
    }
  }

  return {
    target: prettyPath(path.resolve(target), cwd),
    nodeCount: graph.stats.node_count,
    edgeCount: graph.stats.edge_count,
    deadLinkCount: graph.stats.dead_links.length,
    missingSymmetricCount: issues.filter((issue) => issue.problem === "missing_symmetric_backlink").length,
    issues,
  };
}

export async function rebuildGraphIndex(
  target: string,
  settings: MemorySettings,
  signal?: AbortSignal,
  cwd = process.cwd(),
): Promise<GraphRebuildReport> {
  const graph = await buildGraphSnapshot(target, settings, signal, cwd);
  const outPath = await graphIndexPath(target);
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const tmpPath = `${outPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, `${JSON.stringify(graph, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, outPath);

  return {
    target: prettyPath(path.resolve(target), cwd),
    graph_path: prettyPath(outPath, cwd),
    nodeCount: graph.stats.node_count,
    edgeCount: graph.stats.edge_count,
    deadLinkCount: graph.stats.dead_links.length,
    orphanCount: graph.stats.orphans.length,
    git_head: graph.git_head,
  };
}

export function formatGraphRebuildReport(report: GraphRebuildReport): string {
  return [
    `Memory graph rebuilt: ${report.nodeCount} node(s), ${report.edgeCount} edge(s), ${report.deadLinkCount} dead link(s), ${report.orphanCount} orphan(s)`,
    `Graph path: ${report.graph_path}`,
    `Git head: ${report.git_head ?? "unavailable"}`,
  ].join("\n");
}

export function formatBacklinkReport(report: BacklinkReport, maxIssues = 20): string {
  const lines: string[] = [
    `Memory backlinks: ${report.deadLinkCount} dead link(s), ${report.missingSymmetricCount} missing symmetric backlink(s), ${report.nodeCount} node(s), ${report.edgeCount} edge(s)`,
  ];
  if (report.issues.length === 0) return `${lines[0]} — passed`;

  lines.push("");
  for (const issue of report.issues.slice(0, maxIssues)) {
    if (issue.problem === "dead_link") {
      lines.push(`- [error] ${issue.from} --${issue.type}--> ${issue.to}: target slug not found`);
    } else {
      lines.push(`- [warning] ${issue.from} --${issue.type}--> ${issue.to}: missing reverse ${issue.to} --${issue.type}--> ${issue.from}`);
    }
  }
  if (report.issues.length > maxIssues) {
    lines.push(`- ... ${report.issues.length - maxIssues} more backlink issue(s) omitted`);
  }
  return lines.join("\n");
}
