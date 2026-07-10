import * as fs from "node:fs/promises";
import * as path from "node:path";
import { durableAtomicWriteFile } from "../../_shared/durable-write";
import { validateL1WritePreflight } from "../../_shared/l1-schema-registry";
import { makeConstraintEvidenceDiagnostic } from "./diagnostics";
import {
  constraintEvidenceEnvelopeJson,
  constraintEvidenceEventPath,
  constraintEvidenceEventRelativePath,
  createConstraintEvidenceEnvelope,
  isSha256Hex,
} from "./hash-envelope";
import { validateConstraintEvidenceEnvelope } from "./read";
import type {
  ConstraintEvidenceDiagnostic,
  ConstraintEvidenceEnvelopeV1,
  ConstraintEvidenceEventBodyV1,
} from "./types";

export type ConstraintEvidenceAppendResult =
  | {
    ok: true;
    status: "appended" | "idempotent_duplicate";
    eventId: string;
    filePath: string;
    envelope: ConstraintEvidenceEnvelopeV1;
    diagnostics: ConstraintEvidenceDiagnostic[];
  }
  | {
    ok: false;
    status: "blocked" | "invalid" | "collision" | "path_violation" | "write_failed";
    eventId?: string;
    filePath?: string;
    envelope?: ConstraintEvidenceEnvelopeV1;
    diagnostics: ConstraintEvidenceDiagnostic[];
  };

export interface AppendConstraintEvidenceEventOptions {
  abrainHome: string;
  body: ConstraintEvidenceEventBodyV1;
  nowUtc?: string;
}

export interface ConstraintEvidencePathGuardResult {
  ok: boolean;
  normalizedPath: string;
  diagnostics: ConstraintEvidenceDiagnostic[];
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function constraintEvidenceAllowedEventRoot(abrainHome: string): string {
  return path.resolve(abrainHome, "l1", "events");
}

export function constraintEvidenceAllowedStateRoot(abrainHome: string): string {
  return path.resolve(abrainHome, ".state", "sediment", "constraint-events");
}

export function guardConstraintEvidencePath(input: { abrainHome: string; targetPath: string; allowState?: boolean }): ConstraintEvidencePathGuardResult {
  const abrainHome = path.resolve(input.abrainHome);
  const targetPath = path.resolve(input.targetPath);
  const allowedRoots = [constraintEvidenceAllowedEventRoot(abrainHome)];
  if (input.allowState) allowedRoots.push(constraintEvidenceAllowedStateRoot(abrainHome));

  const canonicalRoots = [
    path.join(abrainHome, "rules"),
    path.join(abrainHome, "knowledge"),
    path.join(abrainHome, "projects"),
  ];
  if (canonicalRoots.some((root) => isPathInside(root, targetPath))) {
    return {
      ok: false,
      normalizedPath: targetPath,
      diagnostics: [makeConstraintEvidenceDiagnostic({
        code: "CE_APPEND_FAILED",
        message: "constraint evidence target path points at canonical memory",
        data: { targetPath },
      })],
    };
  }

  if (!allowedRoots.some((root) => isPathInside(root, targetPath))) {
    return {
      ok: false,
      normalizedPath: targetPath,
      diagnostics: [makeConstraintEvidenceDiagnostic({
        code: "CE_APPEND_FAILED",
        message: "constraint evidence target path is outside allowed event state roots",
        data: { targetPath, allowedRoots },
      })],
    };
  }

  return { ok: true, normalizedPath: targetPath, diagnostics: [] };
}

export async function appendConstraintEvidenceEvent(options: AppendConstraintEvidenceEventOptions): Promise<ConstraintEvidenceAppendResult> {
  const envelope = createConstraintEvidenceEnvelope(options.body);
  const eventId = envelope.event_id;
  const filePath = path.resolve(constraintEvidenceEventPath(options.abrainHome, eventId));
  const guard = guardConstraintEvidencePath({ abrainHome: options.abrainHome, targetPath: filePath });
  if (!guard.ok) return { ok: false, status: "path_violation", eventId, filePath, envelope, diagnostics: guard.diagnostics };

  if (options.body.sanitizer.status === "blocked") {
    return {
      ok: false,
      status: "blocked",
      eventId,
      filePath,
      envelope,
      diagnostics: [makeConstraintEvidenceDiagnostic({
        code: "CE_SANITIZER_BLOCKED",
        message: "constraint evidence sanitizer blocked append",
        eventIds: [eventId],
        data: blockedAuditData(options.body, eventId),
      })],
    };
  }

  const validation = validateConstraintEvidenceEnvelope(envelope, {
    abrainHome: options.abrainHome,
    filePath,
    relativePath: constraintEvidenceEventRelativePath(eventId),
  });
  if (!validation.ok) return { ok: false, status: "invalid", eventId, filePath, envelope, diagnostics: validation.diagnostics };

  // Canonical-path R3.4.2 P1-S3 write gate: central registry role/producer
  // check plus lstat+realpath symlink-escape validation before durable write.
  try {
    await validateL1WritePreflight({
      abrainHome: options.abrainHome,
      envelope,
      targetPath: filePath,
      expected: { domain: "constraint", role: "evidence" },
    });
  } catch (err) {
    return {
      ok: false,
      status: "invalid",
      eventId,
      filePath,
      envelope,
      diagnostics: [makeConstraintEvidenceDiagnostic({
        code: "CE_HASH_PATH_MISMATCH",
        message: `central schema-role registry rejected constraint evidence write: ${err instanceof Error ? err.message : String(err)}`,
        eventIds: [eventId],
        data: { filePath },
      })],
    };
  }

  const content = constraintEvidenceEnvelopeJson(envelope);
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const existing = await readExisting(filePath);
    if (existing !== null) {
      if (existing === content) {
        return {
          ok: true,
          status: "idempotent_duplicate",
          eventId,
          filePath,
          envelope,
          diagnostics: [makeConstraintEvidenceDiagnostic({
            code: "CE_APPEND_IDEMPOTENT_DUPLICATE",
            message: "constraint evidence event already exists with identical content",
            eventIds: [eventId],
          })],
        };
      }
      return {
        ok: false,
        status: "collision",
        eventId,
        filePath,
        envelope,
        diagnostics: [makeConstraintEvidenceDiagnostic({
          code: "CE_HASH_PATH_COLLISION",
          message: "constraint evidence event path already exists with different content",
          eventIds: [eventId],
          data: { filePath },
        })],
      };
    }

    await writeDurableEvidenceFile(filePath, content);

    return {
      ok: true,
      status: "appended",
      eventId,
      filePath,
      envelope,
      diagnostics: [makeConstraintEvidenceDiagnostic({
        code: "CE_APPEND_OK",
        message: "constraint evidence event appended",
        eventIds: [eventId],
      })],
    };
  } catch (err) {
    return {
      ok: false,
      status: "write_failed",
      eventId,
      filePath,
      envelope,
      diagnostics: [makeConstraintEvidenceDiagnostic({
        code: "CE_APPEND_FAILED",
        message: "constraint evidence append failed",
        eventIds: [eventId],
        data: { error: err instanceof Error ? err.message : String(err), ...blockedAuditData(options.body, eventId) },
      })],
    };
  }
}

async function readExisting(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return null;
    throw err;
  }
}

async function writeDurableEvidenceFile(filePath: string, content: string): Promise<void> {
  await durableAtomicWriteFile(filePath, content);
}

function blockedAuditData(body: ConstraintEvidenceEventBodyV1, eventId: string): Record<string, unknown> {
  const intendedBodyHash = isSha256Hex(eventId) ? eventId : undefined;
  return {
    sessionId: body.session_id,
    turnId: body.turn_id,
    sanitizedQuoteHash: body.source.quote_hash,
    intendedBodyHash,
    retryEligible: false,
  };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return !!err && typeof err === "object" && "code" in err;
}
