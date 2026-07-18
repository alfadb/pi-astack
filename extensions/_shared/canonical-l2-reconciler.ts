import { canonicalizeJcs, sha256Hex } from "./jcs";
import {
  CONSTRAINT_L2_V1,
  CURRENT_CONSTRAINT_L2,
  CURRENT_KNOWLEDGE_L2,
  KNOWLEDGE_L2_V1,
  canonicalKnowledgeEntryRelativePathV1,
  canonicalKnowledgeManifestRelativePathV1,
} from "./canonical-l2-contract";

export class CanonicalL2ReconcilerError extends Error {
  readonly code: string;
  readonly detail?: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, detail?: Record<string, unknown>) {
    super(`${code}: ${message}`);
    this.name = "CanonicalL2ReconcilerError";
    this.code = code;
    this.detail = detail ? Object.freeze({ ...detail }) : undefined;
  }
}

type KnowledgeNodeV1 = Readonly<{ eventId: string; body: any }>;

type KnowledgeProjectionV1 = Readonly<{
  kind: "entry" | "delete";
  markdown?: string;
  winnerEventId: string;
  inputEventSetHash: string;
}>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function markdownStringV1(value: string): string {
  return /^[A-Za-z0-9_.:/@+-]+$/.test(value) ? value : JSON.stringify(value);
}

function markdownListV1(key: string, values: string[]): string[] {
  return values.length ? [key + ":", ...values.map((value) => `  - ${markdownStringV1(value)}`)] : [];
}

function normalizeCompiledTruthV1(title: string, body: string): string {
  let text = body.trim().replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  text = text.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(text)) text = `# ${title}\n\n${text}`;
  return text.trim();
}

function knowledgeIdentityKeyV1(body: any): string {
  return body.scope.kind === "world"
    ? `world::${body.payload.slug}`
    : `project:${body.scope.project_id || "unknown"}:${body.payload.slug}`;
}

function sameLayerKeyV1(node: KnowledgeNodeV1): string {
  const seq = typeof node.body.device_event_seq === "number" ? String(node.body.device_event_seq).padStart(20, "0") : "";
  return [node.body.created_at_utc, node.body.device_id, seq, node.eventId].join("\0");
}

function topoSortKnowledgeEventsV1(nodes: readonly KnowledgeNodeV1[]): KnowledgeNodeV1[] {
  const byId = new Map(nodes.map((node) => [node.eventId, node]));
  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const node of nodes) indegree.set(node.eventId, 0);
  for (const node of nodes) {
    for (const parent of node.body.causal_parents || []) {
      if (!byId.has(parent)) continue;
      indegree.set(node.eventId, (indegree.get(node.eventId) ?? 0) + 1);
      children.set(parent, [...(children.get(parent) ?? []), node.eventId]);
    }
  }
  const ready = nodes.filter((node) => (indegree.get(node.eventId) ?? 0) === 0)
    .sort((left, right) => compareCodeUnits(sameLayerKeyV1(left), sameLayerKeyV1(right)));
  const output: KnowledgeNodeV1[] = [];
  const seen = new Set<string>();
  while (ready.length) {
    const node = ready.shift()!;
    if (seen.has(node.eventId)) continue;
    seen.add(node.eventId);
    output.push(node);
    let changed = false;
    for (const childId of children.get(node.eventId) ?? []) {
      indegree.set(childId, (indegree.get(childId) ?? 0) - 1);
      if ((indegree.get(childId) ?? 0) === 0 && !seen.has(childId)) {
        ready.push(byId.get(childId)!);
        changed = true;
      }
    }
    if (changed) ready.sort((left, right) => compareCodeUnits(sameLayerKeyV1(left), sameLayerKeyV1(right)));
  }
  if (output.length < nodes.length) {
    output.push(...nodes.filter((node) => !seen.has(node.eventId))
      .sort((left, right) => compareCodeUnits(sameLayerKeyV1(left), sameLayerKeyV1(right))));
  }
  return output;
}

function renderKnowledgeMarkdownBytesV1(
  body: any,
  eventId: string,
  outputHash: string,
  overrides?: { created?: string; updated?: string; setHash?: string },
): string {
  const timestamp = body.created_at_utc;
  const payload = body.payload;
  const id = body.scope.kind === "world" ? `world:${payload.slug}` : `project:${body.scope.project_id}:${payload.slug}`;
  const frontmatter = [
    "---",
    `id: ${id}`,
    `scope: ${body.scope.kind}`,
    `kind: ${payload.kind}`,
    `status: ${payload.status}`,
    `confidence: ${payload.confidence}`,
    `provenance: ${markdownStringV1(payload.provenance)}`,
    `schema_version: ${KNOWLEDGE_L2_V1.entrySchemaVersion}`,
    `title: ${markdownStringV1(payload.title)}`,
    `created: ${overrides?.created ?? timestamp}`,
    `updated: ${overrides?.updated ?? timestamp}`,
    `sediment_projection: ${KNOWLEDGE_L2_V1.projection}`,
    `sediment_projector: ${KNOWLEDGE_L2_V1.projector}`,
    `sediment_projector_version: ${KNOWLEDGE_L2_V1.projectorVersion}`,
    `sediment_template_version: ${KNOWLEDGE_L2_V1.templateVersion}`,
    `sediment_input_event_set_hash: ${overrides?.setHash ?? eventId}`,
    `sediment_output_hash: ${outputHash}`,
    `sediment_watermark_event_id: ${eventId}`,
    `sediment_event_id: ${eventId}`,
    ...markdownListV1("trigger_phrases", payload.trigger_phrases),
    ...markdownListV1("derives_from", payload.derives_from),
  ];
  if (body.scope.kind === "project" && body.scope.project_id) frontmatter.push(`project_id: ${markdownStringV1(body.scope.project_id)}`);
  frontmatter.push("---", "");
  return [
    ...frontmatter,
    normalizeCompiledTruthV1(payload.title, payload.compiled_truth),
    "",
    "## Timeline",
    "",
    `- ${timestamp} | ${body.session_id} | projected | ${payload.timeline_note || "projected from Knowledge Evidence Event"}`,
    "",
  ].join("\n");
}

function renderKnowledgeProjectionFromSetV1(nodes: readonly KnowledgeNodeV1[]): KnowledgeProjectionV1 {
  if (!nodes.length) throw new CanonicalL2ReconcilerError("RECOVERY_L2_RECONCILER_INPUT", "knowledge v1 reconciler received an empty event set");
  const sorted = topoSortKnowledgeEventsV1(nodes);
  const winner = sorted[sorted.length - 1]!;
  const earliest = sorted[0]!;
  const sortedIds = sorted.map((node) => node.eventId).sort(compareCodeUnits);
  const inputEventSetHash = sorted.length === 1 ? winner.eventId : sha256Hex(canonicalizeJcs(sortedIds));
  if (winner.body.intent.operation_hint === "delete") return Object.freeze({ kind: "delete", winnerEventId: winner.eventId, inputEventSetHash });
  const overrides = sorted.length === 1 && (winner.body.causal_parents?.length ?? 0) === 0
    ? undefined
    : { created: earliest.body.created_at_utc, updated: winner.body.created_at_utc, setHash: inputEventSetHash };
  const withoutHash = renderKnowledgeMarkdownBytesV1(winner.body, winner.eventId, "", overrides);
  const outputHash = sha256Hex(withoutHash);
  return Object.freeze({
    kind: "entry",
    markdown: renderKnowledgeMarkdownBytesV1(winner.body, winner.eventId, outputHash, overrides),
    winnerEventId: winner.eventId,
    inputEventSetHash,
  });
}

function renderKnowledgeManifestFromSetV1(nodes: readonly KnowledgeNodeV1[]): string {
  if (!nodes.length) throw new CanonicalL2ReconcilerError("RECOVERY_L2_RECONCILER_INPUT", "knowledge v1 manifest reconciler received no events");
  const byIdentity = new Map<string, KnowledgeNodeV1[]>();
  for (const node of nodes) byIdentity.set(knowledgeIdentityKeyV1(node.body), [...(byIdentity.get(knowledgeIdentityKeyV1(node.body)) ?? []), node]);
  const byId = new Map(nodes.map((node) => [node.eventId, node]));
  const winners = [...byIdentity.values()].map((set) => renderKnowledgeProjectionFromSetV1(set).winnerEventId)
    .map((eventId) => byId.get(eventId)!)
    .sort((left, right) => compareCodeUnits(sameLayerKeyV1(left), sameLayerKeyV1(right)) || compareCodeUnits(left.eventId, right.eventId));
  const winner = winners[winners.length - 1]!;
  const body = winner.body;
  const latestOutputPath = body.scope.kind === "world"
    ? `latest/world/${body.payload.slug}.md`
    : `latest/projects/${body.scope.project_id || "unknown"}/${body.payload.slug}.md`;
  return `${JSON.stringify({
    schemaVersion: KNOWLEDGE_L2_V1.manifestSchemaVersion,
    updatedAtUtc: body.created_at_utc,
    latestEventId: winner.eventId,
    latestOutputPath,
    latestScope: body.scope,
    latestOperation: body.intent.operation_hint,
  }, null, 2)}\n`;
}

function stableValueV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValueV1);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort(compareCodeUnits)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) output[key] = stableValueV1(child);
  }
  return output;
}

function listLineV1(label: string, value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value.length ? [`- ${label}: ${value.join(", ")}`] : [];
  return value?.trim() ? [`- ${label}: ${value.trim()}`] : [];
}

function constraintScopeSortKeyV1(constraint: any): string {
  const scope = constraint.scope.kind === "global" ? "0:global" : `1:${constraint.scope.projectId}`;
  const inject = constraint.injectMode === "always" ? "0:always" : "1:listed";
  return `${scope}\0${inject}\0${String(999 - (constraint.priorityHint ?? 0)).padStart(4, "0")}\0${constraint.title}\0${constraint.constraintId}`;
}

function constraintScopeHeadingV1(constraint: any): string {
  if (constraint.scope.kind === "global") return constraint.injectMode === "always" ? "Global always" : "Global listed";
  return `Project ${constraint.scope.projectId} ${constraint.injectMode}`;
}

function renderConstraintV1(constraint: any): string[] {
  return [
    `### ${constraint.title}`,
    "",
    ...listLineV1("id", constraint.constraintId),
    ...listLineV1("source refs", constraint.sourceRecordIds.slice().sort()),
    ...listLineV1("must do", constraint.mustDoSummary),
    ...listLineV1("applies when", constraint.appliesWhen),
    ...listLineV1("trigger phrases", constraint.triggerPhrases?.slice().sort()),
    "",
    constraint.compiledBody.trim(),
    "",
  ];
}

function renderConstraintItemsV1(items: any[], empty: string): string[] {
  if (!items.length) return [empty, ""];
  return items.slice()
    .sort((left, right) => compareCodeUnits(`${left.reason}:${left.sourceRecordIds.join("+")}`, `${right.reason}:${right.sourceRecordIds.join("+")}`))
    .map((item) => `- ${item.reason}: ${item.sourceRecordIds.slice().sort().join(", ")}${item.note ? ` \u2014 ${item.note}` : ""}`)
    .concat("");
}

function renderConstraintL2V1(decision: any): string {
  const grouped = new Map<string, any[]>();
  for (const constraint of decision.constraints.slice().sort((left: any, right: any) => compareCodeUnits(constraintScopeSortKeyV1(left), constraintScopeSortKeyV1(right)))) {
    const heading = constraintScopeHeadingV1(constraint);
    grouped.set(heading, [...(grouped.get(heading) ?? []), constraint]);
  }
  const sections: string[] = [];
  const headings = ["Global always", "Global listed", ...[...grouped.keys()].filter((heading) => heading.startsWith("Project ")).sort(compareCodeUnits)];
  for (const heading of headings) {
    sections.push(`## ${heading}`, "");
    const constraints = grouped.get(heading) ?? [];
    if (!constraints.length) sections.push("No constraints.", "");
    else for (const constraint of constraints) sections.push(...renderConstraintV1(constraint));
  }
  sections.push(
    "## Conflicts", "", ...renderConstraintItemsV1(decision.unresolved, "No unresolved constraints."),
    "## Not-memory diagnostics", "", ...renderConstraintItemsV1(decision.exclusions, "No exclusions."),
  );
  const decisionHash = sha256Hex(JSON.stringify(stableValueV1(decision)));
  const lines = [
    "---",
    `schema_version: ${CONSTRAINT_L2_V1.schemaVersion}`,
    "view: compiled_constraint",
    `projector: ${CONSTRAINT_L2_V1.projector}`,
    `template_version: ${CONSTRAINT_L2_V1.templateVersion}`,
    `input_root_hash: ${decision.inputRootHash}`,
    `decision_hash: ${decisionHash}`,
    "shadow_only: false",
    "canonical_output_hash: __PENDING__",
    "---",
    "",
    "# Compiled Constraint View",
    "",
    ...sections,
  ];
  const pending = `${lines.join("\n").trimEnd()}\n`;
  return pending.replace("canonical_output_hash: __PENDING__", `canonical_output_hash: ${sha256Hex(pending.replace("canonical_output_hash: __PENDING__", "canonical_output_hash: "))}`);
}

export interface CanonicalL2ReconcilerSelection {
  readonly knowledgeVersion: typeof KNOWLEDGE_L2_V1.reconcilerVersion;
  readonly constraintVersion: typeof CONSTRAINT_L2_V1.reconcilerVersion;
}

function frontmatterValue(markdown: string, key: string): string | null {
  if (!markdown.startsWith("---\n")) return null;
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const prefix = `${key}: `;
  const matches = markdown.slice(4, end).split("\n").filter((line) => line.startsWith(prefix));
  return matches.length === 1 ? matches[0]!.slice(prefix.length) : null;
}

export function selectCanonicalL2ReconcilerVersions(input: {
  knowledgeMarkdown: readonly string[];
  knowledgeManifest: string | null;
  constraintMarkdown: string | null;
  constraintSourceTemplateVersions: readonly string[];
}): CanonicalL2ReconcilerSelection {
  for (const markdown of input.knowledgeMarkdown) {
    const matchesV1 = frontmatterValue(markdown, "schema_version") === KNOWLEDGE_L2_V1.entrySchemaVersion
      && frontmatterValue(markdown, "sediment_projection") === KNOWLEDGE_L2_V1.projection
      && frontmatterValue(markdown, "sediment_projector") === KNOWLEDGE_L2_V1.projector
      && frontmatterValue(markdown, "sediment_projector_version") === KNOWLEDGE_L2_V1.projectorVersion
      && frontmatterValue(markdown, "sediment_template_version") === KNOWLEDGE_L2_V1.templateVersion;
    if (!matchesV1) throw new CanonicalL2ReconcilerError("RECOVERY_L2_RECONCILER_UNSUPPORTED", "knowledge canonical output has no registered deterministic reconciler");
  }
  if (input.knowledgeManifest !== null) {
    let schema: unknown;
    try { schema = (JSON.parse(input.knowledgeManifest) as Record<string, unknown>).schemaVersion; }
    catch { throw new CanonicalL2ReconcilerError("RECOVERY_L2_RECONCILER_UNSUPPORTED", "knowledge manifest is not version-selectable JSON"); }
    if (schema !== KNOWLEDGE_L2_V1.manifestSchemaVersion) throw new CanonicalL2ReconcilerError("RECOVERY_L2_RECONCILER_UNSUPPORTED", "knowledge manifest version has no registered deterministic reconciler", { schema });
  }
  if (input.constraintSourceTemplateVersions.some((version) => version !== CONSTRAINT_L2_V1.templateVersion)) {
    throw new CanonicalL2ReconcilerError("RECOVERY_L2_RECONCILER_UNSUPPORTED", "constraint projection event requires an unregistered deterministic reconciler", { versions: [...new Set(input.constraintSourceTemplateVersions)].sort(compareCodeUnits) });
  }
  if (input.constraintMarkdown !== null) {
    const matchesV1 = frontmatterValue(input.constraintMarkdown, "schema_version") === CONSTRAINT_L2_V1.schemaVersion
      && frontmatterValue(input.constraintMarkdown, "projector") === CONSTRAINT_L2_V1.projector
      && frontmatterValue(input.constraintMarkdown, "template_version") === CONSTRAINT_L2_V1.templateVersion;
    if (!matchesV1) throw new CanonicalL2ReconcilerError("RECOVERY_L2_RECONCILER_UNSUPPORTED", "constraint canonical output has no registered deterministic reconciler");
  }
  return Object.freeze({ knowledgeVersion: KNOWLEDGE_L2_V1.reconcilerVersion, constraintVersion: CONSTRAINT_L2_V1.reconcilerVersion });
}

export function assertCanonicalL2ReconcilerCoverage(current: {
  knowledgeVersion: string;
  constraintVersion: string;
} = {
  knowledgeVersion: CURRENT_KNOWLEDGE_L2.reconcilerVersion,
  constraintVersion: CURRENT_CONSTRAINT_L2.reconcilerVersion,
}): void {
  if (current.knowledgeVersion !== KNOWLEDGE_L2_V1.reconcilerVersion || current.constraintVersion !== CONSTRAINT_L2_V1.reconcilerVersion) {
    throw new CanonicalL2ReconcilerError("RECOVERY_L2_RECONCILER_COVERAGE", "a live canonical projector version has no preserved deterministic history reconciler", current);
  }
}

export function buildCanonicalL2V1(scan: { selected: readonly any[] }): ReadonlyMap<string, Buffer> {
  const expected = new Map<string, Buffer>();
  const knowledgeNodes: KnowledgeNodeV1[] = scan.selected
    .filter((record) => record.registration.domain === "knowledge" && record.registration.role === "canonical")
    .map((record) => ({ eventId: record.eventId, body: record.body }));
  const byIdentity = new Map<string, KnowledgeNodeV1[]>();
  for (const node of knowledgeNodes) byIdentity.set(knowledgeIdentityKeyV1(node.body), [...(byIdentity.get(knowledgeIdentityKeyV1(node.body)) ?? []), node]);
  for (const nodes of byIdentity.values()) {
    const rendered = renderKnowledgeProjectionFromSetV1(nodes);
    if (rendered.kind === "delete") continue;
    const body = nodes[0]!.body;
    expected.set(canonicalKnowledgeEntryRelativePathV1({ scopeKind: body.scope.kind, projectId: body.scope.project_id, slug: body.payload.slug }), Buffer.from(rendered.markdown!, "utf-8"));
  }
  if (knowledgeNodes.length) expected.set(canonicalKnowledgeManifestRelativePathV1(), Buffer.from(renderKnowledgeManifestFromSetV1(knowledgeNodes), "utf-8"));

  const constraintRows = scan.selected.filter((record) => record.registration.envelope_schema === "constraint-projection-envelope/v1");
  const latest = constraintRows.slice().sort((left, right) => {
    const time = String(right.body.created_at_utc ?? "").localeCompare(String(left.body.created_at_utc ?? ""));
    return time || String(right.eventId).localeCompare(String(left.eventId));
  })[0];
  if (latest) expected.set(CONSTRAINT_L2_V1.canonicalPath, Buffer.from(renderConstraintL2V1(latest.body.validated_decision), "utf-8"));
  return expected;
}

export const __TEST = Object.freeze({
  renderKnowledgeProjectionFromSetV1,
  renderKnowledgeManifestFromSetV1,
  renderConstraintL2V1,
});
