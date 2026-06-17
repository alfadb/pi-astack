/**
 * source_ref provenance liveness ("理由保鲜").
 *
 * 251 abrain entries pin a `source_ref` of the form
 *   "docs/adr/NNNN-slug.md#<heading>@<sha>"
 * (built by ingest-adr.ts:buildSourceRef). rationale.ts surfaces it "so drift
 * is detectable" — this module IS the drift/liveness detector.
 *
 * It is a READ-ONLY detector: it resolves each source_ref against the ADR
 * docs tree and returns a deterministic verdict bucket per entry. It does NOT
 * archive or retire anything — that write decision is sediment's LLM judgment
 * (main session is read-only to memory). In particular `source_ingested`
 * (ADR archived because its rationale was decomposed into abrain entries — the
 * very entries citing it) is EXPECTED, not stale; only sediment decides what,
 * if anything, to do with a finding.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { splitFrontmatter } from "./parser";

export interface SourceRefParts {
  adrPath: string;
  heading: string;
  sha: string;
}

/**
 * Inverse of buildSourceRef. Format is `path#heading@sha`; the path always
 * ends in `.md`, the heading may itself carry leading `#`s (the captured
 * markdown heading level), and the sha is the trailing `@`-suffix.
 */
export function parseSourceRef(refRaw: string): SourceRefParts | null {
  if (typeof refRaw !== "string") return null;
  const ref = refRaw.trim().replace(/^["']|["']$/g, "").trim();
  const at = ref.lastIndexOf("@");
  if (at < 0) return null;
  const sha = ref.slice(at + 1).trim();
  const rest = ref.slice(0, at);
  // Faithful inverse of buildSourceRef(`${path}#${heading}`): the path always
  // ends in `.md` and the separator is the `#` immediately after it, so split
  // on the literal `.md#`. This rejects `.mdx` / `.md.bak` (→ unparseable)
  // instead of mis-parsing them. Strip any remaining leading `#`s, which are
  // the captured markdown heading-level markers (e.g. `### 3. auto-continue`).
  const sepIdx = rest.indexOf(".md#");
  if (sepIdx < 0) return null;
  const adrPath = rest.slice(0, sepIdx + 3).trim();
  const heading = rest.slice(sepIdx + 4).replace(/^#+\s*/, "").trim();
  if (!adrPath || !sha) return null;
  return { adrPath, heading, sha };
}

export type LivenessVerdict =
  | "live" //              accepted/active ADR, file + cited heading present
  | "source_ingested" //   ADR archived (rationale ingested into abrain) — EXPECTED, not stale
  | "source_superseded" // ADR superseded/deprecated — decision replaced → re-examine
  | "source_proposed" //   ADR still proposed — provisional source
  | "file_missing" //      ADR file gone (renamed/deleted) → source lost
  | "heading_missing" //   ADR present but the cited heading text is gone (section drift)
  | "unparseable"; //      source_ref malformed

/** Verdicts that warrant sediment's attention (vs. expected/live). */
export const FLAGGED_VERDICTS: ReadonlySet<LivenessVerdict> = new Set([
  "source_superseded",
  "file_missing",
  "heading_missing",
  "unparseable",
]);

export interface ProvenanceFinding {
  slug: string;
  sourceRef: string;
  adrPath?: string;
  heading?: string;
  adrStatus?: string;
  verdict: LivenessVerdict;
}

export interface ProvenanceReport {
  total: number;
  withSourceRef: number;
  findings: ProvenanceFinding[];
  byVerdict: Record<LivenessVerdict, number>;
}

export interface ProvenanceEntryInput {
  slug: string;
  sourceRef?: string;
}

// An ADR whose rationale was decomposed ("ingested") into abrain entries gets
// its detailed sections condensed to a 方向/机制 skeleton whose HEADING carries
// the marker (e.g. `## 机制（已分解入 abrain，逐条 slug）`). Its pinned headings
// legitimately disappear and its status may stay `accepted` (not just
// `archived`), so status alone misses these. We scope the marker to HEADING
// lines, not the whole body: a still-live ADR that merely MENTIONS another
// ADR's ingestion in prose (e.g. 0035 citing 0015) must NOT be classified as
// ingested, or genuine future drift on that live ADR would be hidden.
const INGEST_MARKER_RE = /逐条\s*slug|分解入\s*abrain|ingest\s*入\s*abrain/i;

interface AdrInfo {
  exists: boolean;
  status?: string;
  ingested: boolean;
  headings: Set<string>;
}

function loadAdr(absPath: string, cache: Map<string, AdrInfo>): AdrInfo {
  const hit = cache.get(absPath);
  if (hit) return hit;
  let info: AdrInfo = { exists: false, ingested: false, headings: new Set() };
  try {
    const raw = fs.readFileSync(absPath, "utf-8");
    const { frontmatterText } = splitFrontmatter(raw);
    const sm = frontmatterText.match(/^status:\s*(.+)$/m);
    const status = sm ? sm[1].trim().replace(/^["']|["']$/g, "").toLowerCase() : undefined;
    const headings = new Set<string>();
    for (const ln of raw.split("\n")) {
      const h = ln.match(/^#+\s*(.+?)\s*$/);
      if (h) headings.add(h[1].trim());
    }
    info = {
      exists: true,
      status,
      ingested: status === "archived" || [...headings].some((h) => INGEST_MARKER_RE.test(h)),
      headings,
    };
  } catch {
    /* exists stays false */
  }
  cache.set(absPath, info);
  return info;
}

const EMPTY_BY_VERDICT: Record<LivenessVerdict, number> = {
  live: 0,
  source_ingested: 0,
  source_superseded: 0,
  source_proposed: 0,
  file_missing: 0,
  heading_missing: 0,
  unparseable: 0,
};

/**
 * Resolve every entry's source_ref against `opts.docsRoot` (the repo root
 * the `docs/adr/...` paths are relative to) and classify liveness. Entries
 * without a source_ref are skipped (not counted in withSourceRef).
 */
export function checkProvenanceLiveness(
  entries: ProvenanceEntryInput[],
  opts: { docsRoot: string },
): ProvenanceReport {
  const findings: ProvenanceFinding[] = [];
  const adrCache = new Map<string, AdrInfo>();
  for (const e of entries) {
    const ref = e.sourceRef;
    if (!ref || !ref.trim()) continue;
    const parts = parseSourceRef(ref);
    if (!parts) {
      findings.push({ slug: e.slug, sourceRef: ref, verdict: "unparseable" });
      continue;
    }
    // Containment guard: a source_ref with `../` must not resolve outside the
    // docs root (path traversal). Out-of-tree → treat as file_missing.
    const root = path.resolve(opts.docsRoot);
    const abs = path.resolve(root, parts.adrPath);
    const escaped = abs !== root && !abs.startsWith(root + path.sep);
    const adr: AdrInfo = escaped
      ? { exists: false, ingested: false, headings: new Set<string>() }
      : loadAdr(abs, adrCache);
    const base: ProvenanceFinding = {
      slug: e.slug,
      sourceRef: ref,
      adrPath: parts.adrPath,
      heading: parts.heading,
      adrStatus: adr.status,
      verdict: "live",
    };
    // Precedence: gone > decision-replaced > ingested-condensation (expected)
    // > provisional > section-drift > live. superseded outranks ingested so a
    // replaced decision is still flagged even if its rationale was ingested.
    if (!adr.exists) {
      findings.push({ ...base, verdict: "file_missing" });
    } else if (adr.status === "superseded" || adr.status === "deprecated") {
      findings.push({ ...base, verdict: "source_superseded" });
    } else if (adr.ingested) {
      findings.push({ ...base, verdict: "source_ingested" });
    } else if (adr.status === "proposed") {
      findings.push({ ...base, verdict: "source_proposed" });
    } else if (parts.heading && !adr.headings.has(parts.heading)) {
      findings.push({ ...base, verdict: "heading_missing" });
    } else {
      findings.push(base);
    }
  }
  const byVerdict = { ...EMPTY_BY_VERDICT };
  for (const f of findings) byVerdict[f.verdict] += 1;
  return { total: entries.length, withSourceRef: findings.length, findings, byVerdict };
}

export function formatProvenanceReport(r: ProvenanceReport): string {
  const lines: string[] = [];
  lines.push(`provenance liveness: ${r.withSourceRef}/${r.total} entries carry source_ref`);
  const order: LivenessVerdict[] = [
    "live",
    "source_ingested",
    "source_proposed",
    "source_superseded",
    "heading_missing",
    "file_missing",
    "unparseable",
  ];
  for (const v of order) {
    const n = r.byVerdict[v];
    if (n > 0) lines.push(`  ${FLAGGED_VERDICTS.has(v) ? "⚠ " : "  "}${v}: ${n}`);
  }
  const flagged = r.findings.filter((f) => FLAGGED_VERDICTS.has(f.verdict));
  if (flagged.length > 0) {
    lines.push("");
    lines.push(`flagged for sediment review (${flagged.length}):`);
    for (const f of flagged) {
      lines.push(`  [${f.verdict}] ${f.slug}${f.adrStatus ? ` (adr status: ${f.adrStatus})` : ""} ← ${f.sourceRef}`);
    }
  }
  return lines.join("\n");
}
