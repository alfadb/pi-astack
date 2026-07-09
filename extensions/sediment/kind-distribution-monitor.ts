import * as fs from "node:fs";
import * as path from "node:path";
import { abrainProjectDir, resolveActiveProject, resolveUserGlobalAbrainHome } from "../_shared/runtime";

export interface KindStatusSample {
  slug: string;
  kind: string;
  status: string;
}

export interface KindDistributionBucket {
  kind: string;
  active: number;
  archived: number;
  active_ratio: number;
  archived_ratio: number;
  ratio: number;
  sample: number;
  alert: boolean;
}

export interface KindDistributionReport {
  active_total: number;
  archived_total: number;
  threshold_ratio: number;
  min_sample: number;
  buckets: KindDistributionBucket[];
  alerts: KindDistributionBucket[];
}

const DEFAULT_THRESHOLD_RATIO = 2;
const DEFAULT_MIN_SAMPLE = 10;
const SKIP_DIRS: ReadonlySet<string> = new Set([".git", ".state", "staging", "vault", "workflows", "rules"]);

function splitFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized);
  return m?.[1] ?? "";
}

function scalar(frontmatter: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.*)$`, "m");
  const m = re.exec(frontmatter);
  if (!m) return "";
  return (m[1] ?? "").trim().replace(/^['\"]|['\"]$/g, "");
}

function readMarkdownSamples(root: string): KindStatusSample[] {
  const out: KindStatusSample[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const file = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(file); continue; }
      if (!ent.isFile() || !file.endsWith(".md") || ent.name === "_index.md") continue;
      try {
        const fm = splitFrontmatter(fs.readFileSync(file, "utf-8"));
        const kind = scalar(fm, "kind") || "unknown";
        const status = scalar(fm, "status") || "unknown";
        if (status !== "active" && status !== "archived") continue;
        const id = scalar(fm, "id");
        const slug = (id.split(":").filter(Boolean).pop() || path.basename(file, ".md")).toLowerCase();
        out.push({ slug, kind, status });
      } catch { /* ignore unreadable/non-entry markdown */ }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

function candidateRoots(abrainHome: string, projectRoot?: string): string[] {
  const roots: string[] = [];
  if (projectRoot) {
    try {
      const projectId = resolveActiveProject(projectRoot, { abrainHome }).activeProject?.projectId;
      if (projectId) {
        roots.push(abrainProjectDir(abrainHome, projectId));
        roots.push(path.join(abrainHome, "l2", "views", "knowledge", "latest", "projects", projectId));
        return roots;
      }
    } catch { /* fall through to global scan */ }
  }
  roots.push(path.join(abrainHome, "projects"));
  roots.push(path.join(abrainHome, "l2", "views", "knowledge", "latest", "projects"));
  roots.push(path.join(abrainHome, "knowledge"));
  return roots;
}

export function computeKindDistribution(samples: KindStatusSample[], thresholdRatio = DEFAULT_THRESHOLD_RATIO, minSample = DEFAULT_MIN_SAMPLE): KindDistributionReport {
  const activeByKind = new Map<string, number>();
  const archivedByKind = new Map<string, number>();
  for (const sample of samples) {
    if (sample.status === "active") activeByKind.set(sample.kind, (activeByKind.get(sample.kind) ?? 0) + 1);
    else if (sample.status === "archived") archivedByKind.set(sample.kind, (archivedByKind.get(sample.kind) ?? 0) + 1);
  }
  const activeTotal = [...activeByKind.values()].reduce((a, b) => a + b, 0);
  const archivedTotal = [...archivedByKind.values()].reduce((a, b) => a + b, 0);
  const kinds = new Set([...activeByKind.keys(), ...archivedByKind.keys()]);
  const buckets = [...kinds].sort().map((kind) => {
    const active = activeByKind.get(kind) ?? 0;
    const archived = archivedByKind.get(kind) ?? 0;
    const activeRatio = activeTotal > 0 ? active / activeTotal : 0;
    const archivedRatio = archivedTotal > 0 ? archived / archivedTotal : 0;
    const ratio = activeRatio > 0 ? archivedRatio / activeRatio : (archivedRatio > 0 ? Number.POSITIVE_INFINITY : 0);
    const sample = active + archived;
    const alert = sample >= minSample && archived > 0 && ratio > thresholdRatio;
    return { kind, active, archived, active_ratio: activeRatio, archived_ratio: archivedRatio, ratio, sample, alert };
  });
  return {
    active_total: activeTotal,
    archived_total: archivedTotal,
    threshold_ratio: thresholdRatio,
    min_sample: minSample,
    buckets,
    alerts: buckets.filter((b) => b.alert),
  };
}

export function kindDistributionReport(projectRoot?: string, abrainHome = resolveUserGlobalAbrainHome()): KindDistributionReport {
  const bySlug = new Map<string, KindStatusSample>();
  for (const root of candidateRoots(path.resolve(abrainHome), projectRoot)) {
    for (const sample of readMarkdownSamples(root)) bySlug.set(`${sample.slug}\0${sample.status}`, sample);
  }
  return computeKindDistribution([...bySlug.values()]);
}
