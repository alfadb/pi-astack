#!/usr/bin/env node
/** R4.1 production operator. Default preview is exact frozen/live-rebuilt read-only bytes. */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true, fsCache: false, moduleCache: false });
const r4 = jiti(path.join(repoRoot, "extensions/_shared/proposition-lifecycle-freshness-d3-v2-session-start-r4.ts"));
const evidence = jiti(path.join(repoRoot, r4.D3_V2_R4_EVIDENCE_MODULE));
const { canonicalizeJcs } = jiti(path.join(repoRoot, "extensions/_shared/jcs.ts"));

const argv = process.argv.slice(2);
const forbidden = ["--force", "--yes", "--target", "--settings", "--session", "--authorization", "--authorization-json", "--authorization-text", "--receipt", "--intent"].find((flag) => argv.includes(flag));
if (forbidden) throw new Error(`caller-supplied authority/path option forbidden: ${forbidden}`);
if (argv.length > 1 || (argv.length === 1 && argv[0] !== "--execute" && argv[0] !== "--continue")) throw new Error("usage: operator [--execute|--continue]; default is read-only preview");

// Every mode reuses the same live rebuild and exact committed-byte verification.
// This does not trust a recomputed dossier self-hash as authority.
const requestedMode = argv.length === 0 ? "preview" : argv[0] === "--execute" ? "execute" : "continue";
const verified = evidence.loadVerifiedD3V2R4ProductionEvidence(repoRoot, { mode: requestedMode });
if (argv.length === 0) {
  process.stdout.write(verified.previewRaw);
} else {
  if (verified.sourceCommitClosure.source_files_exact_at_head !== true || verified.evidenceFilesExactAtHead !== true) {
    throw new Error(`production ${argv[0]} blocked: source/evidence files are not exact non-ignored HEAD blobs (closure ${verified.sourceCommitClosure.closure_hash})`);
  }
  const mode = argv[0] === "--execute" ? "execute" : "continue";
  const result = r4.executeD3V2R4BindOperator({ target: "production", mode, frozen: verified.frozen });
  process.stdout.write(`${canonicalizeJcs(result)}\n`);
}
