export const KNOWLEDGE_L2_V1 = Object.freeze({
  reconcilerVersion: "knowledge-l2-reconciler/v1",
  projection: "knowledge-evidence/v1",
  projector: "knowledge-projector",
  projectorVersion: "adr0039-p5",
  templateVersion: "knowledge-markdown/v1",
  entrySchemaVersion: "1",
  manifestSchemaVersion: "knowledge-projection-manifest/v1",
  canonicalRoot: "l2/views/knowledge/latest",
  projectionRoot: "latest",
  manifestName: "manifest.json",
} as const);

export const CONSTRAINT_L2_V1 = Object.freeze({
  reconcilerVersion: "constraint-l2-reconciler/v1",
  schemaVersion: "constraint-l2-view/v1",
  projector: "constraint-compiler",
  templateVersion: "constraint-shadow-render/v1",
  canonicalRoot: "l2/views/constraint",
  canonicalPath: "l2/views/constraint/latest/compiled-view.md",
} as const);

// Live projectors point at an explicit descriptor. A future projector version
// must add a reconciler and then move this pointer; history keeps selecting v1
// from the version signals committed in canonical output.
export const CURRENT_KNOWLEDGE_L2 = KNOWLEDGE_L2_V1;
export const CURRENT_CONSTRAINT_L2 = CONSTRAINT_L2_V1;

export function knowledgeProjectionEntryRelativePathV1(input: {
  scopeKind: "world" | "project";
  projectId?: string;
  slug: string;
}): string {
  return input.scopeKind === "world"
    ? `${KNOWLEDGE_L2_V1.projectionRoot}/world/${input.slug}.md`
    : `${KNOWLEDGE_L2_V1.projectionRoot}/projects/${input.projectId || "unknown"}/${input.slug}.md`;
}

export function canonicalKnowledgeEntryRelativePathV1(input: {
  scopeKind: "world" | "project";
  projectId?: string;
  slug: string;
}): string {
  return input.scopeKind === "world"
    ? `${KNOWLEDGE_L2_V1.canonicalRoot}/world/${input.slug}.md`
    : `${KNOWLEDGE_L2_V1.canonicalRoot}/projects/${input.projectId || "unknown"}/${input.slug}.md`;
}

export function knowledgeProjectionManifestRelativePathV1(): string {
  return `${KNOWLEDGE_L2_V1.projectionRoot}/${KNOWLEDGE_L2_V1.manifestName}`;
}

export function canonicalKnowledgeManifestRelativePathV1(): string {
  return `${KNOWLEDGE_L2_V1.canonicalRoot}/${KNOWLEDGE_L2_V1.manifestName}`;
}
