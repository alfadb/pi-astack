import { sanitizeForMemory } from "../sanitizer";
import { makeDiagnostic } from "./diagnostics";
import { sha256Hex, stableCanonicalize } from "./normalize";
import type {
  ConstraintCompilerDecision,
  ConstraintCompilerInvokeResult,
  ConstraintCompilerInvoker,
  ConstraintCompilerPrompt,
  ConstraintCompilerRunResult,
  ParsedConstraintCompilerDecision,
} from "./types";

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      escape = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, index + 1);
    }
  }
  return null;
}

function asDecision(value: unknown, inputRootHash: string): ConstraintCompilerDecision | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.schemaVersion !== "constraint-shadow-decision/v1") return null;
  return {
    schemaVersion: "constraint-shadow-decision/v1",
    inputRootHash,
    constraints: Array.isArray(candidate.constraints) ? candidate.constraints as ConstraintCompilerDecision["constraints"] : [],
    exclusions: Array.isArray(candidate.exclusions) ? candidate.exclusions as ConstraintCompilerDecision["exclusions"] : [],
    unresolved: Array.isArray(candidate.unresolved) ? candidate.unresolved as ConstraintCompilerDecision["unresolved"] : [],
    merges: Array.isArray(candidate.merges) ? candidate.merges as ConstraintCompilerDecision["merges"] : [],
    rescopeProposals: Array.isArray(candidate.rescopeProposals) ? candidate.rescopeProposals as ConstraintCompilerDecision["rescopeProposals"] : [],
    mappings: Array.isArray(candidate.mappings) ? candidate.mappings as ConstraintCompilerDecision["mappings"] : [],
    diagnostics: Array.isArray(candidate.diagnostics) ? candidate.diagnostics as ConstraintCompilerDecision["diagnostics"] : [],
  };
}

export function parseConstraintCompilerDecision(rawText: string, inputRootHash: string): ParsedConstraintCompilerDecision {
  const sanitized = sanitizeForMemory(rawText);
  const rawOutput = sanitized.text ?? rawText;
  const rawOutputHash = sha256Hex(rawOutput);
  const jsonText = extractJsonObject(rawOutput);
  if (!jsonText) {
    return {
      ok: false,
      rawOutput,
      rawOutputHash,
      diagnostic: makeDiagnostic({
        code: "SC_COMPILER_PARSE_FAILED",
        message: "constraint compiler returned no JSON object",
        data: { rawOutputHash },
      }),
    };
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const decision = asDecision(parsed, inputRootHash);
    if (!decision) {
      return {
        ok: false,
        rawOutput,
        rawOutputHash,
        diagnostic: makeDiagnostic({
          code: "SC_COMPILER_PARSE_FAILED",
          message: "constraint compiler returned unsupported decision schema",
          data: { rawOutputHash },
        }),
      };
    }
    return {
      ok: true,
      decision,
      rawOutput,
      rawOutputHash,
      parsedOutputHash: sha256Hex(stableCanonicalize(decision)),
    };
  } catch (err) {
    return {
      ok: false,
      rawOutput,
      rawOutputHash,
      diagnostic: makeDiagnostic({
        code: "SC_COMPILER_PARSE_FAILED",
        message: "constraint compiler JSON parse failed",
        data: { rawOutputHash, error: err instanceof Error ? err.message : String(err) },
      }),
    };
  }
}

export async function runConstraintCompilerWithInvoker(input: {
  prompt: ConstraintCompilerPrompt;
  invoker: ConstraintCompilerInvoker;
  modelRef?: string;
  signal?: AbortSignal;
}): Promise<ConstraintCompilerRunResult> {
  let invoked: ConstraintCompilerInvokeResult;
  try {
    invoked = await input.invoker({ prompt: input.prompt, modelRef: input.modelRef, signal: input.signal });
  } catch (err) {
    return {
      ok: false,
      prompt: input.prompt,
      modelRef: input.modelRef,
      diagnostic: makeDiagnostic({
        code: "SC_COMPILER_MODEL_UNAVAILABLE",
        message: "constraint compiler invoker threw",
        data: { error: err instanceof Error ? err.message : String(err) },
      }),
    };
  }

  if (!invoked.ok) {
    return {
      ok: false,
      prompt: input.prompt,
      modelRef: invoked.modelRef ?? input.modelRef,
      durationMs: invoked.durationMs,
      diagnostic: makeDiagnostic({
        code: "SC_COMPILER_MODEL_UNAVAILABLE",
        message: "constraint compiler model unavailable",
        data: { error: invoked.error },
      }),
    };
  }

  const parsed = parseConstraintCompilerDecision(invoked.text, input.prompt.inputRootHash);
  if (!parsed.ok) {
    return {
      ok: false,
      prompt: input.prompt,
      modelRef: invoked.modelRef ?? input.modelRef,
      durationMs: invoked.durationMs,
      rawOutput: parsed.rawOutput,
      rawOutputHash: parsed.rawOutputHash,
      diagnostic: parsed.diagnostic,
    };
  }

  return {
    ok: true,
    prompt: input.prompt,
    decision: parsed.decision,
    rawOutput: parsed.rawOutput,
    rawOutputHash: parsed.rawOutputHash,
    parsedOutputHash: parsed.parsedOutputHash,
    modelRef: invoked.modelRef ?? input.modelRef,
    durationMs: invoked.durationMs,
  };
}
