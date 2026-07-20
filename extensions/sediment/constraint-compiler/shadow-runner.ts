import * as fs from "node:fs/promises";
import * as path from "node:path";
import { makeDiagnostic } from "./diagnostics";
import { createConstraintDiffReport } from "./diff";
import { createConstraintEventCoverageReport, createConstraintLegacyParallelDeltaReport } from "./event-report";
import { scanConstraintEvidenceEvents } from "./event-scan";
import { runConstraintCompilerWithInvoker } from "./llm-compiler";
import { scanLegacyConstraintSources } from "./legacy-scan";
import { runMergedSourceVerifierWithInvoker } from "./merged-source-verifier-llm";
import { buildMergedSourceVerifierInputRows, buildMergedSourceVerifierLookup, createMergedSourceVerifierReport } from "./merged-source-verifier";
import { normalizeConstraintSources, sha256Hex, stableCanonicalize } from "./normalize";
import { buildConstraintCompilerPrompt } from "./prompt";
import { renderConstraintShadowView } from "./render";
import { fixateConstraintDecisionAndRenderL2 } from "./projection";
import { buildCorpusSplitReport, type CorpusSplitReport } from "./corpus-split";
import { validateConstraintCompilerDecision } from "./validate-decision";
import type {
  ConstraintCompilerDecision,
  ConstraintCompilerPrompt,
  ConstraintCompilerRunResult,
  ConstraintDiffReport,
  ConstraintEventCoverageReport,
  ConstraintLegacyParallelDeltaReport,
  ConstraintMergedSourceVerifierReport,
  ConstraintRepoProjectionPlan,
  ConstraintShadowDiagnostic,
  ConstraintShadowInputSnapshot,
  ConstraintShadowRunArtifacts,
  ConstraintShadowRunOptions,
  ConstraintShadowRunResult,
  NormalizeConstraintResult,
  RenderedConstraintView,
  ValidatedConstraintCompilerDecision,
} from "./types";

const ARTIFACT_SCHEMA_VERSION = "constraint-shadow-artifact/v1";
const DEFAULT_EVENT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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
  rawOutput?: string;
  rawOutputHash?: string;
  parsedDecision?: ConstraintCompilerDecision;
  decision?: ValidatedConstraintCompilerDecision;
  view?: RenderedConstraintView;
  diff?: ConstraintDiffReport;
  corpusSplit?: CorpusSplitReport;
  eventCoverage?: ConstraintEventCoverageReport;
  legacyParallelDelta?: ConstraintLegacyParallelDeltaReport;
  mergedSourceVerifier?: ConstraintMergedSourceVerifierReport;
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

  const files: Record<string, string> = {
    input: "input.normalized.json",
    prompt: "prompt.txt",
    rawOutput: "raw-output.txt",
    parsedDecision: "parsed-decision.json",
    decision: "decision.json",
    view: "compiled-view.md",
    diffJson: "diff.json",
    diffMarkdown: "diff.md",
    corpusSplitJson: "corpus-split.json",
    corpusSplitMarkdown: "corpus-split.md",
    eventCoverage: "event-coverage.json",
    legacyParallelDelta: "legacy-parallel-delta.json",
    diagnostics: "diagnostics.json",
  };
  if (input.mergedSourceVerifier) files.mergedSourceVerifier = "merged-source-verifier.json";
  const writeSet = async (dir: string): Promise<void> => {
    await writeJson(path.join(dir, files.input), input.normalized);
    if (input.prompt) await writeText(path.join(dir, files.prompt), input.prompt.text);
    if (input.rawOutput !== undefined) await writeText(path.join(dir, files.rawOutput), input.rawOutput);
    if (input.parsedDecision) await writeJson(path.join(dir, files.parsedDecision), input.parsedDecision);
    if (input.decision) await writeJson(path.join(dir, files.decision), input.decision);
    if (input.view) await writeText(path.join(dir, files.view), input.view.markdown);
    if (input.diff) {
      await writeJson(path.join(dir, files.diffJson), input.diff);
      await writeText(path.join(dir, files.diffMarkdown), input.diff.markdown);
    }
    if (input.corpusSplit) {
      await writeJson(path.join(dir, files.corpusSplitJson), input.corpusSplit.manifest);
      await writeText(path.join(dir, files.corpusSplitMarkdown), input.corpusSplit.markdown);
    }
    if (input.eventCoverage) await writeJson(path.join(dir, files.eventCoverage), input.eventCoverage);
    if (input.legacyParallelDelta) await writeJson(path.join(dir, files.legacyParallelDelta), input.legacyParallelDelta);
    if (input.mergedSourceVerifier) await writeJson(path.join(dir, files.mergedSourceVerifier), input.mergedSourceVerifier);
    await writeJson(path.join(dir, files.diagnostics), input.diagnostics);
  };

  await writeSet(runDir);
  await writeSet(latestDir);
  if (!input.mergedSourceVerifier) {
    await fs.rm(path.join(latestDir, "merged-source-verifier.json"), { force: true });
  }
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
    eventCoverage: input.eventCoverage?.summary,
    legacyParallelDelta: input.legacyParallelDelta?.summary,
    mergedSourceVerifier: input.mergedSourceVerifier?.summary,
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

function diagnosticErrorText(diagnostic: ConstraintShadowDiagnostic): string {
  const data = diagnostic.data as Record<string, unknown> | undefined;
  const error = data && typeof data === "object" ? data.error : undefined;
  return typeof error === "string" && error.trim() ? error : diagnostic.message;
}

// ADR0039 §B: build a one-shot retry prompt that appends the EXACT prior error so
// the model self-corrects only that cause and re-emits the complete JSON decision.
function withRetryFeedback(
  prompt: ConstraintCompilerPrompt,
  errorMessage: string,
  attempt: number,
  failureKind: "compile" | "validation" | undefined,
): ConstraintCompilerPrompt {
  const what = failureKind === "validation"
    ? "failed automated validation"
    : "could not be parsed as the required JSON decision";
  const feedback = [
    "",
    `## RETRY ${attempt}`,
    `Your previous response ${what} with this exact error:`,
    "",
    errorMessage,
    "",
    "Re-emit the COMPLETE corrected JSON decision object (schemaVersion \"constraint-shadow-decision/v1\") for the SAME input payload above. Fix ONLY the cause of that error and keep every other field identical. Output ONLY the JSON object \u2014 no prose, no markdown fences.",
  ].join("\n");
  const text = `${prompt.text}\n${feedback}`;
  return { ...prompt, text, promptHash: sha256Hex(text) };
}

function diagnosticDedupeKey(diagnostic: ConstraintShadowDiagnostic): string {
  return `${diagnostic.code}:${diagnostic.sourceRecordIds.slice().sort().join("+")}`;
}

function dedupeDiagnostics(diagnostics: ConstraintShadowDiagnostic[]): ConstraintShadowDiagnostic[] {
  const seen = new Set<string>();
  const output: ConstraintShadowDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const key = diagnosticDedupeKey(diagnostic);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(diagnostic);
  }
  return output;
}

type ConstraintShadowInputOptions = Pick<
  ConstraintShadowRunOptions,
  "abrainHome" | "cwd" | "activeProjectId" | "knownProjectIds" | "includeProjects" | "includeStatuses" | "normalizeOptions"
>;

async function collectConstraintShadowInputs(options: ConstraintShadowInputOptions) {
  const scan = await scanLegacyConstraintSources({
    abrainHome: options.abrainHome,
    cwd: options.cwd,
    includeProjects: options.includeProjects ?? (options.activeProjectId ? [options.activeProjectId] : "active"),
    includeStatuses: options.includeStatuses ?? "all",
    activeProjectId: options.activeProjectId,
  });
  const eventScan = await scanConstraintEvidenceEvents({ abrainHome: options.abrainHome });
  const sources = [...scan.rules, ...scan.audits, ...eventScan.events];
  const normalized = normalizeConstraintSources(sources, {
    activeProjectId: options.activeProjectId,
    knownProjectIds: options.knownProjectIds,
    ...(options.normalizeOptions ?? {}),
  });
  return { scan, eventScan, sources, normalized };
}

export async function captureConstraintShadowInputSnapshot(options: ConstraintShadowInputOptions): Promise<ConstraintShadowInputSnapshot> {
  const { eventScan, normalized } = await collectConstraintShadowInputs(options);
  return Object.freeze({
    inputRootHash: normalized.inputRootHash,
    inputEventIds: Object.freeze(eventScan.events.map((event) => event.eventId).sort()),
  });
}

export async function materializeConstraintRepoProjection(options: {
  abrainHome: string;
  plan: ConstraintRepoProjectionPlan;
}): Promise<{ status: string; eventId?: string; l2RelativePath: string; decisionHash: string }> {
  const { plan } = options;
  if (plan.schemaVersion !== "constraint-repo-projection-plan/v1"
    || plan.inputRootHash !== plan.decision.inputRootHash
    || plan.provenance.input_hash !== plan.inputRootHash) {
    throw new Error("constraint repo projection plan binding is invalid");
  }
  const fixate = await fixateConstraintDecisionAndRenderL2({
    abrainHome: options.abrainHome,
    decision: plan.decision,
    provenance: plan.provenance,
    inputEventIds: [...plan.inputEventIds],
    createdAtUtc: plan.createdAtUtc,
    deviceId: plan.deviceId,
    producerVersion: plan.producerVersion,
  });
  return { status: fixate.status, eventId: fixate.eventId, l2RelativePath: fixate.l2RelativePath, decisionHash: fixate.decisionHash };
}

export async function runConstraintShadowCompiler(options: ConstraintShadowRunOptions): Promise<ConstraintShadowRunResult> {
  const { scan, eventScan, sources, normalized } = await collectConstraintShadowInputs(options);
  const diagnostics: ConstraintShadowDiagnostic[] = dedupeDiagnostics([...scan.warnings, ...eventScan.diagnostics, ...normalized.diagnostics]);
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

  // ADR0039 §B (T0 consensus 2026-06-23): validation/parse-feedback retry loop.
  // A single brittle parse/validate failure must NOT hard-fail the whole compile
  // (8/8 live runs died this way, each on a DIFFERENT invariant; the model can
  // usually self-correct one named error). Attempt invoke+parse+validate up to
  // 1+maxCompileRetries times; on failure re-prompt with the EXACT error so the
  // model fixes only that; on the FINAL attempt escalate to escalationModelRef
  // (stronger / alternate route — also the cure for SC_COMPILER_MODEL_UNAVAILABLE
  // on a flaky primary route). Always falls through to a graceful ok:false write;
  // never throws (sediment must not crash on a bad compile).
  const maxAttempts = 1 + Math.max(0, Math.trunc(options.maxCompileRetries ?? 0));
  let compile: Extract<ConstraintCompilerRunResult, { ok: true }> | undefined;
  let decision: ValidatedConstraintCompilerDecision | undefined;
  let lastAttempt: ConstraintCompilerRunResult | undefined;
  let lastFailureKind: "compile" | "validation" | undefined;
  let lastErrorMessage: string | undefined;
  const retryDiagnostics: ConstraintShadowDiagnostic[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const isFinalAttempt = attempt === maxAttempts - 1;
    const attemptModelRef = isFinalAttempt && options.escalationModelRef
      ? options.escalationModelRef
      : options.modelRef;
    const attemptPrompt = attempt > 0 && lastErrorMessage
      ? withRetryFeedback(prompt, lastErrorMessage, attempt, lastFailureKind)
      : prompt;
    if (attempt > 0) {
      retryDiagnostics.push(makeDiagnostic({
        code: "SC_COMPILER_RETRY_ATTEMPT",
        message: `constraint compiler retry attempt ${attempt} after ${lastFailureKind ?? "unknown"} failure`,
        data: {
          attempt,
          failureKind: lastFailureKind ?? "unknown",
          error: (lastErrorMessage ?? "").slice(0, 500),
          modelRef: attemptModelRef ?? "",
        },
      }));
    }

    const attemptCompile = await runConstraintCompilerWithInvoker({
      prompt: attemptPrompt,
      invoker: options.compilerInvoker,
      modelRef: attemptModelRef,
    });
    lastAttempt = attemptCompile;
    if (!attemptCompile.ok) {
      lastFailureKind = "compile";
      lastErrorMessage = diagnosticErrorText(attemptCompile.diagnostic);
      continue;
    }
    try {
      decision = validateConstraintCompilerDecision(sources, {
        ...attemptCompile.decision,
        diagnostics: dedupeDiagnostics([...diagnostics, ...attemptCompile.decision.diagnostics]),
        inputRootHash: normalized.inputRootHash,
      }, {
        knownProjectIds: options.knownProjectIds,
        expectedInputRootHash: normalized.inputRootHash,
        // ADR0039: a fresh compile must disposition every in-scope event; an
        // uncovered event throws here -> caught below -> B loop re-prompts the
        // model with the missing ids (it self-corrects). Without this an event
        // silently drops, coverage stays <1, and the injection gate never flips.
        requireEventCompleteness: true,
      });
      compile = attemptCompile;
      break;
    } catch (err) {
      lastFailureKind = "validation";
      lastErrorMessage = err instanceof Error ? err.message : String(err);
    }
  }

  if (!compile || !decision) {
    const failureDiagnostic = lastFailureKind === "compile" && lastAttempt && !lastAttempt.ok
      ? lastAttempt.diagnostic
      : validationFailure(lastErrorMessage ?? "constraint compiler decision failed validation");
    const failDiagnostics = dedupeDiagnostics([...diagnostics, ...retryDiagnostics, failureDiagnostic]);
    const artifactResult = options.writeArtifacts ? await writeArtifacts({
      abrainHome: options.abrainHome,
      artifactRoot: options.artifactRoot,
      runId,
      normalized,
      prompt,
      rawOutput: lastAttempt?.rawOutput,
      rawOutputHash: lastAttempt?.rawOutputHash,
      parsedDecision: lastAttempt?.ok ? lastAttempt.decision : undefined,
      diagnostics: failDiagnostics,
      ok: false,
    }) : undefined;
    if (artifactResult && !artifactResult.ok) failDiagnostics.push(artifactResult.diagnostic);
    return {
      ok: false,
      inputRootHash: normalized.inputRootHash,
      sourceCount: sources.length,
      prompt,
      diagnostics: failDiagnostics,
      ...(artifactResult?.ok ? { artifacts: artifactResult.artifacts } : {}),
    };
  }

  const view = renderConstraintShadowView(decision);
  const diff = createConstraintDiffReport(sources, decision);
  // ADR0039 P5 (4×T0 v4): deterministic pure re-projection of the diff into the
  // corpus-split shadow report (no new classification; read-only over the diff).
  const corpusSplit = buildCorpusSplitReport(diff, { inputRootHash: normalized.inputRootHash });
  const initialDiagnostics = dedupeDiagnostics(decision.diagnostics);
  let candidateMergedSourceVerifier = options.mergedSourceVerifier;
  const verifierDiagnostics: ConstraintShadowDiagnostic[] = [];
  if (!candidateMergedSourceVerifier && options.generateMergedSourceVerifier) {
    const verifierInputRows = buildMergedSourceVerifierInputRows(eventScan.events, decision);
    if (verifierInputRows.length === 0) {
      candidateMergedSourceVerifier = createMergedSourceVerifierReport({
        events: eventScan.events,
        decision,
        verdictRows: [],
      });
    } else if (!options.verifierInvoker) {
      verifierDiagnostics.push(makeDiagnostic({
        code: "SC_MERGED_SOURCE_VERIFIER_MODEL_UNAVAILABLE",
        message: "constraint merged-source verifier invoker missing",
        data: { error: "verifier invoker missing" },
      }));
    } else if (options.verifierInvoker) {
      const generatedVerifier = await runMergedSourceVerifierWithInvoker({
        events: eventScan.events,
        decision,
        invoker: options.verifierInvoker,
        modelRef: options.verifierModelRef,
        maxPromptChars: options.verifierMaxPromptChars,
      });
      if (generatedVerifier.ok) {
        candidateMergedSourceVerifier = generatedVerifier.report;
      } else {
        verifierDiagnostics.push(generatedVerifier.diagnostic);
      }
    }
  }
  const coverage = createConstraintEventCoverageReport({
    events: eventScan.events,
    invalidEventIds: eventScan.invalidEventIds,
    decision,
    diagnostics: initialDiagnostics,
    staleAfterMs: options.eventStaleAfterMs ?? DEFAULT_EVENT_STALE_AFTER_MS,
    nowMs: options.nowMs,
    mergedSourceVerifier: candidateMergedSourceVerifier,
  });
  const legacyParallelDelta = createConstraintLegacyParallelDeltaReport({ events: eventScan.events, decision });
  const mergedSourceVerifierLookup = buildMergedSourceVerifierLookup({ events: eventScan.events, decision, verifier: candidateMergedSourceVerifier });
  const validatedMergedSourceVerifier = mergedSourceVerifierLookup.reportStatus === "valid" ? candidateMergedSourceVerifier : undefined;
  const allDiagnostics = dedupeDiagnostics([...initialDiagnostics, ...retryDiagnostics, ...verifierDiagnostics, ...coverage.diagnostics, ...legacyParallelDelta.diagnostics]);
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
    corpusSplit,
    eventCoverage: coverage.report,
    legacyParallelDelta: legacyParallelDelta.report,
    mergedSourceVerifier: validatedMergedSourceVerifier,
    diagnostics: allDiagnostics,
    ok: true,
  }) : undefined;
  if (artifactResult && !artifactResult.ok) {
    const failedDiagnostics = dedupeDiagnostics([...allDiagnostics, artifactResult.diagnostic]);
    return {
      ok: false,
      inputRootHash: normalized.inputRootHash,
      sourceCount: sources.length,
      prompt,
      diagnostics: failedDiagnostics,
    };
  }

  // Freeze the deterministic repo write as data. Auto-refresh materializes this
  // plan only after entering the canonical mutation barrier and revalidating the
  // compiler input/HEAD freeze; direct callers preserve the historical inline path.
  const repoProjectionPlan: ConstraintRepoProjectionPlan | undefined = options.l2OutputRoot === "repo" ? Object.freeze({
    schemaVersion: "constraint-repo-projection-plan/v1" as const,
    inputRootHash: normalized.inputRootHash,
    inputEventIds: Object.freeze(eventScan.events.map((event) => event.eventId).sort()),
    decision,
    provenance: Object.freeze({
      model: options.modelRef ?? "",
      prompt_hash: prompt.promptHash,
      input_hash: normalized.inputRootHash,
      raw_output_hash: compile.rawOutputHash ?? "",
      ...(decision.validationHash ? { parsed_output_hash: decision.validationHash } : {}),
      acceptance: "accepted_for_event_append" as const,
    }),
    createdAtUtc: new Date().toISOString(),
    deviceId: options.deviceId ?? "unknown-device",
    producerVersion: ARTIFACT_SCHEMA_VERSION,
  }) : undefined;
  let l2Projection: { status: string; eventId?: string; l2RelativePath: string; decisionHash: string } | undefined;
  if (repoProjectionPlan && !options.deferRepoProjection) {
    try {
      l2Projection = await materializeConstraintRepoProjection({ abrainHome: options.abrainHome, plan: repoProjectionPlan });
    } catch (err) {
      l2Projection = { status: `threw:${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`, l2RelativePath: "l2/views/constraint/latest/compiled-view.md", decisionHash: "" };
    }
  }

  // ADR0039 Constraint L2 (4×T0 v3 bundle-b): the repo block is best-effort and
  // swallows 固化/L2 write failures into l2Projection.status. Surface any
  // non-{written,unchanged} status as an SC_L2_WRITE_FAILED diagnostic so the
  // silent failure is observable in the returned diagnostics stream.
  const l2WriteFailed = l2Projection && l2Projection.status !== "written" && l2Projection.status !== "unchanged"
    ? makeDiagnostic({
        code: "SC_L2_WRITE_FAILED",
        message: `constraint L2 repo-mode 固化/render failed: ${l2Projection.status}`,
        data: { status: l2Projection.status, decisionHash: l2Projection.decisionHash, ...(l2Projection.eventId ? { eventId: l2Projection.eventId } : {}) },
      })
    : undefined;
  return {
    ok: true,
    inputRootHash: normalized.inputRootHash,
    sourceCount: sources.length,
    prompt,
    decision,
    view,
    diff,
    eventCoverage: coverage.report,
    legacyParallelDelta: legacyParallelDelta.report,
    ...(validatedMergedSourceVerifier ? { mergedSourceVerifier: validatedMergedSourceVerifier } : {}),
    diagnostics: l2WriteFailed ? dedupeDiagnostics([...allDiagnostics, l2WriteFailed]) : allDiagnostics,
    ...(artifactResult?.ok ? { artifacts: artifactResult.artifacts } : {}),
    ...(repoProjectionPlan ? { repoProjectionPlan } : {}),
    ...(l2Projection ? { l2Projection } : {}),
  };
}

export function constraintShadowRunHash(value: unknown): string {
  return sha256Hex(stableCanonicalize(value));
}
