import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeDiagnostic } from "./diagnostics";
import { createConstraintDiffReport } from "./diff";
import { runConstraintCompilerWithInvoker } from "./llm-compiler";
import { scanLegacyConstraintSources } from "./legacy-scan";
import { normalizeConstraintSources, sha256Hex, stableCanonicalize } from "./normalize";
import { buildConstraintCompilerPrompt } from "./prompt";
import { renderConstraintShadowView } from "./render";
import { validateConstraintCompilerDecision } from "./validate-decision";
import type {
  ConstraintCompilerPrompt,
  ConstraintDiffReport,
  ConstraintShadowDiagnostic,
  ConstraintShadowRunArtifacts,
  ConstraintShadowRunOptions,
  ConstraintShadowRunResult,
  NormalizeConstraintResult,
  RenderedConstraintView,
  ValidatedConstraintCompilerDecision,
} from "./types";

const ARTIFACT_SCHEMA_VERSION = "constraint-shadow-artifact/v1";

function nowRunId(inputRootHash: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${inputRootHash.slice(0, 12)}`;
}

function defaultArtifactRoot(abrainHome: string): string {
  return path.join(abrainHome, ".state", "sediment", "constraint-shadow");
}

function pathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function artifactViolation(input: { abrainHome: string; artifactRoot?: string; target?: string }): ConstraintShadowDiagnostic | null {
  const allowedRoot = path.resolve(defaultArtifactRoot(input.abrainHome));
  const artifactRoot = path.resolve(input.artifactRoot ?? allowedRoot);
  const target = input.target ? path.resolve(input.target) : artifactRoot;
  if (!pathInside(allowedRoot, artifactRoot) || !pathInside(allowedRoot, target)) {
    return makeDiagnostic({
      code: "SC_SHADOW_ONLY_VIOLATION_ATTEMPT",
      message: "constraint shadow artifact path is outside allowed shadow state directory",
      data: { allowedRoot, artifactRoot, target },
    });
  }
  return null;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function writeText(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value.endsWith("\n") ? value : `${value}\n`, "utf-8");
}

async function writeAuditLine(root: string, event: unknown): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.appendFile(path.join(root, "audit.jsonl"), `${JSON.stringify(event)}\n`, "utf-8");
}

async function writeArtifacts(input: {
  abrainHome: string;
  artifactRoot?: string;
  runId: string;
  normalized: NormalizeConstraintResult;
  prompt?: ConstraintCompilerPrompt;
  rawOutputHash?: string;
  decision?: ValidatedConstraintCompilerDecision;
  view?: RenderedConstraintView;
  diff?: ConstraintDiffReport;
  diagnostics: ConstraintShadowDiagnostic[];
  ok: boolean;
}): Promise<{ ok: true; artifacts: ConstraintShadowRunArtifacts } | { ok: false; diagnostic: ConstraintShadowDiagnostic }> {
  const root = path.resolve(input.artifactRoot ?? defaultArtifactRoot(input.abrainHome));
  const violation = artifactViolation({ abrainHome: input.abrainHome, artifactRoot: root });
  if (violation) return { ok: false, diagnostic: violation };

  const runDir = path.join(root, "runs", input.runId);
  const latestDir = path.join(root, "latest");
  for (const target of [runDir, latestDir]) {
    const targetViolation = artifactViolation({ abrainHome: input.abrainHome, artifactRoot: root, target });
    if (targetViolation) return { ok: false, diagnostic: targetViolation };
  }

  const files = {
    input: "input.normalized.json",
    prompt: "prompt.txt",
    decision: "decision.json",
    view: "compiled-view.md",
    diffJson: "diff.json",
    diffMarkdown: "diff.md",
    diagnostics: "diagnostics.json",
  };
  const writeSet = async (dir: string): Promise<void> => {
    await writeJson(path.join(dir, files.input), input.normalized);
    if (input.prompt) await writeText(path.join(dir, files.prompt), input.prompt.text);
    if (input.decision) await writeJson(path.join(dir, files.decision), input.decision);
    if (input.view) await writeText(path.join(dir, files.view), input.view.markdown);
    if (input.diff) {
      await writeJson(path.join(dir, files.diffJson), input.diff);
      await writeText(path.join(dir, files.diffMarkdown), input.diff.markdown);
    }
    await writeJson(path.join(dir, files.diagnostics), input.diagnostics);
  };

  await writeSet(runDir);
  await writeSet(latestDir);
  await writeAuditLine(root, {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    ok: input.ok,
    runId: input.runId,
    inputRootHash: input.normalized.inputRootHash,
    promptHash: input.prompt?.promptHash,
    rawOutputHash: input.rawOutputHash,
    validationHash: input.decision?.validationHash,
    shadowOutputHash: input.view?.shadowOutputHash,
    sourceCount: input.normalized.records.length,
    diagnosticCodes: input.diagnostics.map((diagnostic) => diagnostic.code),
    artifacts: { runDir: path.relative(root, runDir), latestDir: path.relative(root, latestDir) },
  });

  return {
    ok: true,
    artifacts: {
      root,
      runDir,
      latestDir,
      files,
    },
  };
}

function validationFailure(err: unknown): ConstraintShadowDiagnostic {
  return makeDiagnostic({
    code: "SC_COMPILER_VALIDATION_FAILED",
    message: "constraint compiler decision failed validation",
    data: { error: err instanceof Error ? err.message : String(err) },
  });
}

function promptFailure(err: unknown): ConstraintShadowDiagnostic {
  const message = err instanceof Error ? err.message : String(err);
  const code = message.includes("maxPromptChars") ? "SC_INPUT_TOO_LARGE_FOR_SINGLE_PASS" : "SC_COMPILER_PARSE_FAILED";
  return makeDiagnostic({
    code,
    message: code === "SC_INPUT_TOO_LARGE_FOR_SINGLE_PASS" ? "constraint compiler input exceeds single-pass prompt budget" : "constraint compiler prompt construction failed",
    data: { error: message },
  });
}

export async function runConstraintShadowCompiler(options: ConstraintShadowRunOptions): Promise<ConstraintShadowRunResult> {
  const scan = await scanLegacyConstraintSources({
    abrainHome: options.abrainHome,
    cwd: options.cwd,
    includeProjects: options.includeProjects ?? (options.activeProjectId ? [options.activeProjectId] : "active"),
    includeStatuses: options.includeStatuses ?? "all",
    activeProjectId: options.activeProjectId,
  });
  const sources = [...scan.rules, ...scan.audits];
  const normalized = normalizeConstraintSources(sources, {
    activeProjectId: options.activeProjectId,
    knownProjectIds: options.knownProjectIds,
    ...(options.normalizeOptions ?? {}),
  });
  const diagnostics: ConstraintShadowDiagnostic[] = [...scan.warnings, ...normalized.diagnostics];
  const runId = options.runId ?? nowRunId(normalized.inputRootHash);

  let prompt: ConstraintCompilerPrompt | undefined;
  try {
    prompt = buildConstraintCompilerPrompt({
      normalized,
      knownProjectIds: options.knownProjectIds,
      activeProjectId: options.activeProjectId,
      maxPromptChars: options.maxPromptChars,
    });
  } catch (err) {
    diagnostics.push(promptFailure(err));
    const artifactResult = options.writeArtifacts ? await writeArtifacts({
      abrainHome: options.abrainHome,
      artifactRoot: options.artifactRoot,
      runId,
      normalized,
      diagnostics,
      ok: false,
    }) : undefined;
    if (artifactResult && !artifactResult.ok) diagnostics.push(artifactResult.diagnostic);
    return {
      ok: false,
      inputRootHash: normalized.inputRootHash,
      sourceCount: sources.length,
      diagnostics,
      ...(artifactResult?.ok ? { artifacts: artifactResult.artifacts } : {}),
    };
  }

  const compile = await runConstraintCompilerWithInvoker({
    prompt,
    invoker: options.compilerInvoker,
    modelRef: options.modelRef,
  });
  if (!compile.ok) {
    diagnostics.push(compile.diagnostic);
    const artifactResult = options.writeArtifacts ? await writeArtifacts({
      abrainHome: options.abrainHome,
      artifactRoot: options.artifactRoot,
      runId,
      normalized,
      prompt,
      rawOutputHash: compile.rawOutputHash,
      diagnostics,
      ok: false,
    }) : undefined;
    if (artifactResult && !artifactResult.ok) diagnostics.push(artifactResult.diagnostic);
    return {
      ok: false,
      inputRootHash: normalized.inputRootHash,
      sourceCount: sources.length,
      prompt,
      diagnostics,
      ...(artifactResult?.ok ? { artifacts: artifactResult.artifacts } : {}),
    };
  }

  let decision: ValidatedConstraintCompilerDecision;
  try {
    decision = validateConstraintCompilerDecision(sources, {
      ...compile.decision,
      diagnostics: [...diagnostics, ...compile.decision.diagnostics],
      inputRootHash: normalized.inputRootHash,
    }, {
      knownProjectIds: options.knownProjectIds,
      expectedInputRootHash: normalized.inputRootHash,
    });
  } catch (err) {
    diagnostics.push(validationFailure(err));
    const artifactResult = options.writeArtifacts ? await writeArtifacts({
      abrainHome: options.abrainHome,
      artifactRoot: options.artifactRoot,
      runId,
      normalized,
      prompt,
      rawOutputHash: compile.rawOutputHash,
      diagnostics,
      ok: false,
    }) : undefined;
    if (artifactResult && !artifactResult.ok) diagnostics.push(artifactResult.diagnostic);
    return {
      ok: false,
      inputRootHash: normalized.inputRootHash,
      sourceCount: sources.length,
      prompt,
      diagnostics,
      ...(artifactResult?.ok ? { artifacts: artifactResult.artifacts } : {}),
    };
  }

  const view = renderConstraintShadowView(decision);
  const diff = createConstraintDiffReport(sources, decision);
  const allDiagnostics = decision.diagnostics;
  const artifactResult = options.writeArtifacts ? await writeArtifacts({
    abrainHome: options.abrainHome,
    artifactRoot: options.artifactRoot,
    runId,
    normalized,
    prompt,
    rawOutputHash: compile.rawOutputHash,
    decision,
    view,
    diff,
    diagnostics: allDiagnostics,
    ok: true,
  }) : undefined;
  if (artifactResult && !artifactResult.ok) {
    const failedDiagnostics = [...allDiagnostics, artifactResult.diagnostic];
    return {
      ok: false,
      inputRootHash: normalized.inputRootHash,
      sourceCount: sources.length,
      prompt,
      diagnostics: failedDiagnostics,
    };
  }

  return {
    ok: true,
    inputRootHash: normalized.inputRootHash,
    sourceCount: sources.length,
    prompt,
    decision,
    view,
    diff,
    diagnostics: allDiagnostics,
    ...(artifactResult?.ok ? { artifacts: artifactResult.artifacts } : {}),
  };
}

export function constraintShadowRunHash(value: unknown): string {
  return sha256Hex(stableCanonicalize(value));
}
