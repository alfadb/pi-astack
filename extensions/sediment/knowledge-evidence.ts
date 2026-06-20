import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { slugify } from "../memory/utils";
import type { ProjectEntryDraft, WriteProjectEntryResult, WriterAuditContext } from "./writer";
import type { SedimentSettings } from "./settings";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type KnowledgeEvidenceOperation = "create" | "update" | "merge" | "archive" | "supersede" | "delete";
export type KnowledgeEvidenceScope = "project" | "world";

export interface KnowledgeEvidenceEventBodyV1 {
  event_schema_version: "knowledge-evidence-event/v1";
  event_type: "knowledge_entry_observed";
  created_at_utc: string;
  session_id?: string;
  turn_id?: string;
  actor: { role: "assistant"; id: "sediment" };
  source: {
    channel: "agent_end" | "manual" | "replay";
    source_ref: string;
    candidate_id?: string;
    correlation_id?: string;
  };
  intent: {
    domain_hint: "knowledge";
    operation_hint: KnowledgeEvidenceOperation;
    confidence?: number;
  };
  scope: {
    kind: KnowledgeEvidenceScope;
    project_id?: string;
  };
  payload: {
    slug: string;
    title: string;
    kind: string;
    status: string;
    provenance: string;
    confidence: number;
    compiled_truth: string;
    trigger_phrases: string[];
    derives_from: string[];
    timeline_note?: string;
  };
  legacy_parallel_write: {
    attempted: boolean;
    status: string;
    path?: string;
    git_commit?: string | null;
    reason?: string;
  };
  producer: {
    name: "sediment.knowledge-event-writer";
    version: "adr0039-p4";
  };
}

export interface KnowledgeEvidenceEnvelopeV1 {
  schema: "knowledge-evidence-envelope/v1";
  canonicalization: "RFC8785-JCS";
  hash_alg: "sha256";
  event_id: string;
  body_hash: string;
  body: KnowledgeEvidenceEventBodyV1;
}

export interface AppendKnowledgeEvidenceEventResult {
  ok: boolean;
  status: "appended" | "idempotent_duplicate" | "collision" | "write_failed" | "path_violation";
  eventId?: string;
  filePath?: string;
  envelope?: KnowledgeEvidenceEnvelopeV1;
  error?: string;
}

export interface ProjectKnowledgeEvidenceResult {
  ok: boolean;
  status: "projected" | "removed" | "disabled" | "invalid" | "write_failed";
  outputPath?: string;
  manifestPath?: string;
  error?: string;
}

export interface AppendKnowledgeEvidenceForWriteOptions {
  abrainHome: string;
  projectId: string;
  scope: KnowledgeEvidenceScope;
  draft: ProjectEntryDraft;
  result: WriteProjectEntryResult;
  settings: SedimentSettings;
  auditContext?: WriterAuditContext;
  sessionId?: string;
  operation?: KnowledgeEvidenceOperation;
  channel?: "agent_end" | "manual" | "replay";
  turnId?: string;
  createdAtUtc?: string;
  projectEvent?: boolean;
}

export interface AppendKnowledgeEvidenceForWriteResult {
  body?: KnowledgeEvidenceEventBodyV1;
  append: AppendKnowledgeEvidenceEventResult;
  projection?: ProjectKnowledgeEvidenceResult;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input, "utf-8").digest("hex");
}

function canonicalJson(value: JsonValue): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(",")}}`;
}

function toJsonValue(value: unknown, at = "root"): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`non-finite number at ${at}`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => toJsonValue(item, `${at}[${index}]`));
  if (value && typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child !== undefined) out[key] = toJsonValue(child, `${at}.${key}`);
    }
    return out;
  }
  throw new Error(`unsupported JSON value at ${at}: ${typeof value}`);
}

function evidenceRoot(abrainHome: string): string {
  return path.resolve(abrainHome, "l1", "events");
}

function stateRoot(abrainHome: string): string {
  return path.resolve(abrainHome, ".state", "sediment", "knowledge-projection");
}

export function knowledgeEvidenceEventRelativePath(eventId: string): string {
  if (!/^[0-9a-f]{64}$/.test(eventId)) throw new Error(`invalid knowledge evidence event id: ${eventId}`);
  return `l1/events/sha256/${eventId.slice(0, 2)}/${eventId.slice(2, 4)}/${eventId}.json`;
}

export function knowledgeEvidenceEventPath(abrainHome: string, eventId: string): string {
  return path.join(path.resolve(abrainHome), knowledgeEvidenceEventRelativePath(eventId));
}

function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function guardEventPath(abrainHome: string, targetPath: string): boolean {
  return isPathInside(evidenceRoot(abrainHome), targetPath);
}

function createEnvelope(body: KnowledgeEvidenceEventBodyV1): KnowledgeEvidenceEnvelopeV1 {
  const bodyHash = sha256Hex(canonicalJson(toJsonValue(body)));
  return {
    schema: "knowledge-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body,
  };
}

export async function appendKnowledgeEvidenceEvent(args: { abrainHome: string; body: KnowledgeEvidenceEventBodyV1 }): Promise<AppendKnowledgeEvidenceEventResult> {
  let envelope: KnowledgeEvidenceEnvelopeV1;
  try {
    envelope = createEnvelope(args.body);
  } catch (err) {
    return { ok: false, status: "write_failed", error: err instanceof Error ? err.message : String(err) };
  }
  const eventId = envelope.event_id;
  const filePath = knowledgeEvidenceEventPath(args.abrainHome, eventId);
  if (!guardEventPath(args.abrainHome, filePath)) return { ok: false, status: "path_violation", eventId, filePath, envelope };
  const content = `${JSON.stringify(envelope, null, 2)}\n`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existing = await fs.readFile(filePath, "utf-8").catch((err: NodeJS.ErrnoException) => err.code === "ENOENT" ? null : Promise.reject(err));
    if (existing !== null) {
      if (existing === content) return { ok: true, status: "idempotent_duplicate", eventId, filePath, envelope };
      return { ok: false, status: "collision", eventId, filePath, envelope };
    }
    const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    await fs.writeFile(tmp, content, { encoding: "utf-8", flag: "wx" });
    await fs.rename(tmp, filePath);
    return { ok: true, status: "appended", eventId, filePath, envelope };
  } catch (err) {
    return { ok: false, status: "write_failed", eventId, filePath, envelope, error: err instanceof Error ? err.message : String(err) };
  }
}

function markdownString(value: string): string {
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

function markdownList(key: string, values: string[]): string[] {
  if (!values.length) return [];
  return [key + ":", ...values.map((value) => `  - ${markdownString(value)}`)];
}

function normalizeCompiledTruth(title: string, body: string): string {
  let text = body.trim().replace(/^##\s+Timeline\s*[\s\S]*$/m, "").trim();
  text = text.replace(/^---$/gm, " ---");
  if (!/^#\s+/m.test(text)) text = `# ${title}\n\n${text}`;
  return text.trim();
}

export function renderKnowledgeProjectionMarkdown(body: KnowledgeEvidenceEventBodyV1, eventId: string): string {
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
    `provenance: ${markdownString(payload.provenance)}`,
    "schema_version: 1",
    `title: ${markdownString(payload.title)}`,
    `created: ${timestamp}`,
    `updated: ${timestamp}`,
    `sediment_projection: knowledge-evidence/v1`,
    `sediment_event_id: ${eventId}`,
    ...markdownList("trigger_phrases", payload.trigger_phrases),
    ...markdownList("derives_from", payload.derives_from),
  ];
  if (body.scope.kind === "project" && body.scope.project_id) frontmatter.push(`project_id: ${markdownString(body.scope.project_id)}`);
  frontmatter.push("---", "");
  return [
    ...frontmatter,
    normalizeCompiledTruth(payload.title, payload.compiled_truth),
    "",
    "## Timeline",
    "",
    `- ${timestamp} | ${body.session_id || "sediment"} | projected | ${payload.timeline_note || "projected from Knowledge Evidence Event"}`,
    "",
  ].join("\n");
}

export async function projectKnowledgeEvidenceEvent(args: { abrainHome: string; envelope: KnowledgeEvidenceEnvelopeV1; settings: SedimentSettings }): Promise<ProjectKnowledgeEvidenceResult> {
  if (!args.settings.knowledgeProjector.enabled) return { ok: false, status: "disabled" };
  const body = args.envelope.body;
  if (body.event_schema_version !== "knowledge-evidence-event/v1" || body.intent.domain_hint !== "knowledge") return { ok: false, status: "invalid" };
  const projectPart = body.scope.kind === "world" ? "world" : `projects/${body.scope.project_id || "unknown"}`;
  const outputRoot = path.join(stateRoot(args.abrainHome), "latest", projectPart);
  const outputPath = path.join(outputRoot, `${body.payload.slug}.md`);
  const manifestPath = path.join(stateRoot(args.abrainHome), "latest", "manifest.json");
  if (!isPathInside(stateRoot(args.abrainHome), outputPath) || !isPathInside(stateRoot(args.abrainHome), manifestPath)) return { ok: false, status: "invalid", error: "projection path escaped state root" };
  try {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    if (body.intent.operation_hint === "delete") {
      await fs.rm(outputPath, { force: true });
    } else {
      await fs.writeFile(outputPath, renderKnowledgeProjectionMarkdown(body, args.envelope.event_id), "utf-8");
    }
    await fs.mkdir(path.dirname(manifestPath), { recursive: true });
    const manifest = {
      schemaVersion: "knowledge-projection-manifest/v1",
      updatedAtUtc: new Date().toISOString(),
      latestEventId: args.envelope.event_id,
      latestOutputPath: outputPath,
      latestScope: body.scope,
      latestOperation: body.intent.operation_hint,
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    return { ok: true, status: body.intent.operation_hint === "delete" ? "removed" : "projected", outputPath, manifestPath };
  } catch (err) {
    return { ok: false, status: "write_failed", error: err instanceof Error ? err.message : String(err) };
  }
}

export function buildKnowledgeEvidenceBodyForWrite(args: AppendKnowledgeEvidenceForWriteOptions): KnowledgeEvidenceEventBodyV1 {
  const now = args.createdAtUtc || new Date().toISOString();
  const slug = args.result.slug || slugify(args.draft.title);
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    created_at_utc: now,
    ...(args.sessionId || args.auditContext?.sessionId ? { session_id: args.sessionId || args.auditContext?.sessionId } : {}),
    ...(args.turnId ? { turn_id: args.turnId } : {}),
    actor: { role: "assistant", id: "sediment" },
    source: {
      channel: args.channel || "agent_end",
      source_ref: `sediment:${args.auditContext?.lane || "writer"}:${args.result.status}:${slug}`,
      ...(args.auditContext?.candidateId ? { candidate_id: args.auditContext.candidateId } : {}),
      ...(args.auditContext?.correlationId ? { correlation_id: args.auditContext.correlationId } : {}),
    },
    intent: {
      domain_hint: "knowledge",
      operation_hint: args.operation || "create",
      confidence: typeof args.draft.confidence === "number" ? Math.max(0, Math.min(1, args.draft.confidence / 10)) : undefined,
    },
    scope: args.scope === "world" ? { kind: "world" } : { kind: "project", project_id: args.projectId },
    payload: {
      slug,
      title: args.draft.title,
      kind: args.draft.kind,
      status: args.draft.status || "provisional",
      provenance: args.draft.provenance || "assistant-observed",
      confidence: Math.min(10, Math.max(0, Math.round(args.draft.confidence ?? 3))),
      compiled_truth: args.draft.compiledTruth,
      trigger_phrases: args.draft.triggerPhrases ?? [],
      derives_from: args.draft.derivesFrom ?? [],
      ...(args.draft.timelineNote ? { timeline_note: args.draft.timelineNote } : {}),
    },
    legacy_parallel_write: {
      attempted: true,
      status: args.result.status,
      ...(args.result.path ? { path: args.result.path } : {}),
      ...("gitCommit" in args.result ? { git_commit: args.result.gitCommit ?? null } : {}),
      ...(args.result.reason ? { reason: args.result.reason } : {}),
    },
    producer: { name: "sediment.knowledge-event-writer", version: "adr0039-p4" },
  };
}

export async function appendKnowledgeEvidenceForWrite(args: AppendKnowledgeEvidenceForWriteOptions): Promise<AppendKnowledgeEvidenceForWriteResult> {
  if (!args.settings.knowledgeEvidenceEventWriter.enabled) return { append: { ok: false, status: "write_failed", error: "knowledge_event_writer_disabled" } };
  const body = buildKnowledgeEvidenceBodyForWrite(args);
  const append = await appendKnowledgeEvidenceEvent({ abrainHome: args.abrainHome, body });
  const projection = append.ok && append.envelope && args.projectEvent !== false && args.settings.knowledgeProjector.projectOnWrite
    ? await projectKnowledgeEvidenceEvent({ abrainHome: args.abrainHome, envelope: append.envelope, settings: args.settings })
    : undefined;
  return { body, append, ...(projection ? { projection } : {}) };
}

export async function readKnowledgeProjectionStores(args: { abrainHome: string; projectId?: string; settings: SedimentSettings }): Promise<Array<{ scope: KnowledgeEvidenceScope; root: string; label: string }>> {
  if (!args.settings.knowledgeProjector.enabled || !args.settings.knowledgeProjector.hotOverlayEnabled) return [];
  const latest = path.join(stateRoot(args.abrainHome), "latest");
  const stores: Array<{ scope: KnowledgeEvidenceScope; root: string; label: string }> = [];
  if (args.projectId) {
    const projectRoot = path.join(latest, "projects", args.projectId);
    const stat = await fs.stat(projectRoot).catch(() => null);
    if (stat?.isDirectory()) stores.push({ scope: "project", root: projectRoot, label: "knowledge-projection-project" });
  }
  const worldRoot = path.join(latest, "world");
  const worldStat = await fs.stat(worldRoot).catch(() => null);
  if (worldStat?.isDirectory()) stores.push({ scope: "world", root: worldRoot, label: "knowledge-projection-world" });
  return stores;
}
