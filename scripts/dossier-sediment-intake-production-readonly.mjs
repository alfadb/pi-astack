#!/usr/bin/env node
/**
 * Read-only production dossier for durable intake / publication outbox paths.
 *
 * Proves:
 *  - format compatibility of existing ~/.abrain sediment state layout
 *  - scan performance of intake/outbox pending dirs (create if missing is NOT done)
 *  - does NOT write, rename, or delete anything under production ~/.abrain
 *
 * Default: print JSON to stdout only.
 * Explicit --output <path> (or --output=<path>) is required to write a file.
 *
 * Production acceptance of the durable intake / frozen-publisher path is a
 * separate evidence artifact (see docs/evidence/2026-07-23-sediment-production-acceptance.json).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

function parseOutputPath(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--output" || arg === "-o") {
      const next = argv[i + 1];
      if (!next || next.startsWith("-")) throw new Error("--output requires a path");
      return path.resolve(next);
    }
    if (arg.startsWith("--output=")) {
      const value = arg.slice("--output=".length);
      if (!value) throw new Error("--output requires a path");
      return path.resolve(value);
    }
  }
  return null;
}

const outputPath = parseOutputPath(process.argv.slice(2));

const abrainHome = process.env.ABRAIN_ROOT
  ? path.resolve(process.env.ABRAIN_ROOT.replace(/^~(?=$|[/])/, os.homedir()))
  : path.join(os.homedir(), ".abrain");

const jiti = createJiti(import.meta.url, { interopDefault: true });
const intake = await jiti.import(path.join(root, "extensions/sediment/intake.ts"));
const outbox = await jiti.import(path.join(root, "extensions/sediment/publication-outbox.ts"));
const writer = await jiti.import(path.join(root, "extensions/sediment/writer.ts"));

function sha256(value) {
  return createHash("sha256").update(String(value), "utf-8").digest("hex");
}

function dirInfo(dir) {
  try {
    const st = fs.statSync(dir);
    const names = fs.readdirSync(dir);
    return {
      exists: true,
      isDirectory: st.isDirectory(),
      entries: names.length,
      sample: names.slice(0, 5),
    };
  } catch (err) {
    if (err && err.code === "ENOENT") return { exists: false, entries: 0, sample: [] };
    return { exists: false, error: err instanceof Error ? err.message : String(err), entries: 0, sample: [] };
  }
}

const pendingDir = intake.sedimentIntakePendingDir(abrainHome);
const ackedDir = intake.sedimentIntakeAckedDir(abrainHome);
const outboxPendingDir = outbox.publicationOutboxPendingDir(abrainHome);
const sedimentState = path.join(abrainHome, ".state", "sediment");
const l1Events = path.join(abrainHome, "l1", "events");

const t0 = performance.now();
const pending = await intake.listSedimentIntakePending(abrainHome);
const t1 = performance.now();
const outboxPending = await outbox.listPublicationOutboxPending(abrainHome);
const t2 = performance.now();
const headClosure = await writer.inspectKnowledgeHeadClosure(abrainHome);
const t3 = performance.now();

// Count a sample of knowledge L1 events without loading bodies (names only).
function countFiles(dir, maxDepth = 4) {
  let n = 0;
  let walked = 0;
  function walk(d, dpt) {
    if (dpt > maxDepth) return;
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); }
    catch { return; }
    for (const ent of names) {
      walked += 1;
      if (ent.isDirectory()) walk(path.join(d, ent.name), dpt + 1);
      else if (ent.isFile() && ent.name.endsWith(".json")) n += 1;
    }
  }
  walk(dir, 0);
  return { files: n, walked };
}

const t4 = performance.now();
const l1Count = fs.existsSync(l1Events) ? countFiles(l1Events) : { files: 0, walked: 0 };
const t5 = performance.now();

const dossier = {
  generated_at_utc: new Date().toISOString(),
  mode: "production_readonly",
  abrainHome,
  notes: [
    "Read-only probe only. No production files were created, modified, or deleted.",
    "Missing intake/outbox directories are expected before the phase-1 pipeline has run in production.",
    "This dossier is generated only by this explicit command; no lifecycle hook invokes it.",
    "HEAD closure is read through structured Git tree/blob APIs and excludes every unpublished worktree tail.",
    "Default stdout only; pass --output <path> to persist. Does not invoke publisher or consume live intake/outbox.",
    "Production acceptance evidence lives at docs/evidence/2026-07-23-sediment-production-acceptance.json when gates pass.",
  ],
  layout: {
    sediment_state: dirInfo(sedimentState),
    intake_pending: dirInfo(pendingDir),
    intake_acked: dirInfo(ackedDir),
    publication_outbox_pending: dirInfo(outboxPendingDir),
    l1_events: dirInfo(l1Events),
  },
  scans: {
    intake_pending_count: pending.length,
    intake_scan_ms: Number((t1 - t0).toFixed(3)),
    outbox_pending_count: outboxPending.length,
    outbox_scan_ms: Number((t2 - t1).toFixed(3)),
    head_knowledge_l1_count: headClosure.knowledgeL1Count,
    head_closure_violation_count: headClosure.violations.length,
    head_closure_scan_ms: Number((t3 - t2).toFixed(3)),
    l1_json_files: l1Count.files,
    l1_walk_nodes: l1Count.walked,
    l1_walk_ms: Number((t5 - t4).toFixed(3)),
  },
  head_knowledge_closure: {
    commit: headClosure.commit,
    violations: headClosure.violations,
  },
  format_compatibility: {
    intake_schema: intake.SEDIMENT_INTAKE_SCHEMA,
    outbox_schema: outbox.SEDIMENT_PUBLICATION_OUTBOX_SCHEMA,
    intake_pending_path_pattern: "<abrain>/.state/sediment/intake/pending/<windowIdsha256>.json",
    outbox_pending_path_pattern: "<abrain>/.state/sediment/publication-outbox/pending/<itemIdsha256>.json",
    knowledge_l1_path_pattern: "<abrain>/l1/events/sha256/<aa>/<bb>/<eventId>.json",
    knowledge_l1_write_primitive: "durableAtomicCreateFile (create-only CAS)",
  },
  sample_pending_intake: pending.slice(0, 3).map((p) => ({
    windowId: p.windowId,
    sessionIdSha256: sha256(p.sessionId),
    approxBytes: p.approxBytes,
    mtimeMs: p.mtimeMs,
  })),
  pending_outbox: outboxPending.map((p) => ({
    itemId: p.itemId,
    domain: p.item.domain,
    sessionIdSha256: sha256(p.item.sessionId),
    eventId: p.item.eventId,
    operation: p.item.operation,
  })),
};

const payload = `${JSON.stringify(dossier, null, 2)}\n`;
if (outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, payload);
  console.log(JSON.stringify({
    ok: true,
    mode: "wrote",
    outPath: outputPath,
    scans: dossier.scans,
    layout_exists: {
      sediment_state: dossier.layout.sediment_state.exists,
      intake_pending: dossier.layout.intake_pending.exists,
      outbox_pending: dossier.layout.publication_outbox_pending.exists,
      l1_events: dossier.layout.l1_events.exists,
    },
  }, null, 2));
} else {
  process.stdout.write(payload);
}
