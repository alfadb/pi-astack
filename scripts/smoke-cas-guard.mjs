#!/usr/bin/env node
/**
 * smoke-cas-guard — Stage 2 (autonomous evolution): CAS / expected-status
 * guard on the sediment writer (ADR 0027 C3' infra; unblocks staging-resolver
 * + hard_archive).
 *
 * Locks the compare-and-swap contract on updateProjectEntry:
 *   - expected_status mismatch → rejected (reason: status_precondition_failed)
 *   - expected_status match     → updated
 *   - no expected_status        → updated (backward-compatible, opt-in)
 *   - guard is re-checked after a status change (archive) → CAS against the
 *     NEW on-disk status
 *   - entry_not_found short-circuits BEFORE the guard (guard never masks it)
 *
 * Real writer, real abrain target on a tmp home; gitCommit disabled so no
 * git is required. ABRAIN_ROOT is pointed at the tmp home so the writer's
 * causal-anchor device-id stays sandboxed.
 */

import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const here = path.dirname(new URL(import.meta.url).pathname);
const repoRoot = path.resolve(here, "..");
const require = createRequire(import.meta.url);
const { default: createJitiDefault, createJiti } = require("jiti");
const makeJiti = createJiti ?? createJitiDefault;
const jiti = makeJiti(repoRoot, { interopDefault: true });

let pass = 0;
let fail = 0;
function check(name, ok, why = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${why ? `  ← ${why}` : ""}`); }
}

const writer = jiti(path.join(repoRoot, "extensions/sediment/writer.ts"));
const sedSettings = jiti(path.join(repoRoot, "extensions/sediment/settings.ts"));

const settings = { ...sedSettings.DEFAULT_SEDIMENT_SETTINGS, gitCommit: false, lockTimeoutMs: 5000 };

const projectId = "cas-smoke-fixture";
const abrainHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-cas-abrain-"));
const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-cas-proj-"));
fs.mkdirSync(path.join(abrainHome, "projects", projectId), { recursive: true });

const prevRoot = process.env.ABRAIN_ROOT;
process.env.ABRAIN_ROOT = abrainHome; // sandbox device-id resolution

const opts = { projectRoot, abrainHome, projectId, settings, scope: "project" };

const body = [
  "This is a CAS-guard smoke fixture entry. It carries enough prose to pass",
  "the markdown lint minimum-content checks so the writer accepts the create",
  "and subsequent updates without lint rejections.",
].join(" ");

try {
  // ── Create an ACTIVE entry ────────────────────────────────────────
  const created = await writer.writeProjectEntry(
    { title: "CAS guard smoke entry", kind: "fact", status: "active", confidence: 5, compiledTruth: body },
    opts,
  );
  check("create: status=created", created.status === "created", JSON.stringify(created));
  const slug = created.slug;

  // ── CAS mismatch: expect provisional, actual active → reject ──────
  {
    const r = await writer.updateProjectEntry(slug, { expected_status: "provisional", compiledTruth: body + " v2" }, opts);
    check("CAS mismatch (expect provisional / actual active) → rejected", r.status === "rejected", JSON.stringify(r));
    check("CAS mismatch → reason=status_precondition_failed", r.reason === "status_precondition_failed", r.reason);
  }

  // ── CAS match: expect active, actual active → updated ─────────────
  {
    const r = await writer.updateProjectEntry(slug, { expected_status: "active", compiledTruth: body + " v3" }, opts);
    check("CAS match (expect active / actual active) → updated", r.status === "updated", JSON.stringify(r));
  }

  // ── No expected_status → updated (backward-compatible opt-in) ─────
  {
    const r = await writer.updateProjectEntry(slug, { compiledTruth: body + " v4" }, opts);
    check("no expected_status → updated (backward compat)", r.status === "updated", JSON.stringify(r));
  }

  // ── Flip entry to archived (plain update, no guard), then CAS vs NEW status ─
  {
    const flip = await writer.updateProjectEntry(slug, { status: "archived", compiledTruth: body + " v5" }, opts);
    check("flip to archived (no guard) → updated", flip.status === "updated", JSON.stringify(flip));

    const stale = await writer.updateProjectEntry(slug, { expected_status: "active", compiledTruth: body + " v6" }, opts);
    check("CAS after archive (expect active / actual archived) → rejected", stale.status === "rejected", JSON.stringify(stale));
    check("CAS after archive → reason=status_precondition_failed", stale.reason === "status_precondition_failed", stale.reason);

    const fresh = await writer.updateProjectEntry(slug, { expected_status: "archived", compiledTruth: body + " v7" }, opts);
    check("CAS with fresh expectation (expect archived / actual archived) → updated", fresh.status === "updated", JSON.stringify(fresh));
  }

  // ── entry_not_found short-circuits BEFORE the guard ──────────────
  {
    const r = await writer.updateProjectEntry("no-such-slug-xyz", { expected_status: "active", compiledTruth: body }, opts);
    check("missing slug + expected_status → entry_not_found (guard never masks it)",
      r.status === "rejected" && r.reason === "entry_not_found", JSON.stringify(r));
  }

  // ── delete-path CAS (hard): the named hard_archive consumer ──────
  {
    const d = await writer.writeProjectEntry(
      { title: "CAS hard-delete fixture", kind: "fact", status: "active", confidence: 5, compiledTruth: body },
      opts,
    );
    const dslug = d.slug;
    // wrong expectation (archived) vs actual active → rejected, entry survives
    const r1 = await writer.deleteProjectEntry(dslug, { ...opts, mode: "hard", expected_status: "archived" });
    check("hard delete CAS mismatch (expect archived / actual active) → rejected",
      r1.status === "rejected" && r1.reason === "status_precondition_failed", JSON.stringify(r1));
    const survived = await writer.updateProjectEntry(dslug, { compiledTruth: body + " survived rejected delete" }, opts);
    check("entry survived a CAS-rejected hard delete", survived.status === "updated", JSON.stringify(survived));
    // correct expectation → deleted
    const r2 = await writer.deleteProjectEntry(dslug, { ...opts, mode: "hard", expected_status: "active" });
    check("hard delete CAS match (expect active / actual active) → deleted", r2.status === "deleted", JSON.stringify(r2));
    // gone now
    const gone = await writer.updateProjectEntry(dslug, { compiledTruth: body }, opts);
    check("entry is gone after CAS-matched hard delete", gone.status === "rejected" && gone.reason === "entry_not_found", JSON.stringify(gone));
  }

  // ── delete-path CAS (soft) ───────────────────────────────────────
  {
    const d = await writer.writeProjectEntry(
      { title: "CAS soft-delete fixture", kind: "fact", status: "active", confidence: 5, compiledTruth: body },
      opts,
    );
    const r = await writer.deleteProjectEntry(d.slug, { ...opts, mode: "soft", expected_status: "provisional" });
    check("soft delete CAS mismatch (expect provisional / actual active) → rejected",
      r.status === "rejected" && r.reason === "status_precondition_failed", JSON.stringify(r));
    const ok = await writer.deleteProjectEntry(d.slug, { ...opts, mode: "soft", expected_status: "active" });
    check("soft delete CAS match (expect active / actual active) → deleted", ok.status === "deleted", JSON.stringify(ok));
  }

  // ── Source-level: guard is opt-in + interface field present ───────
  {
    const src = fs.readFileSync(path.join(repoRoot, "extensions/sediment/writer.ts"), "utf-8");
    check("writer: ProjectEntryUpdateDraft declares expected_status", /expected_status\?: EntryStatus;/.test(src));
    check("writer: guard is opt-in (patch.expected_status !== undefined)", /patch\.expected_status !== undefined/.test(src));
    check("writer: delete path honors opt-in expected_status", /opts\.expected_status !== undefined/.test(src));
    const idxSrc = fs.readFileSync(path.join(repoRoot, "extensions/sediment/index.ts"), "utf-8");
    check("index: status_precondition_failed is a terminal checkpoint reason", /"status_precondition_failed"/.test(idxSrc));
    check("index: archive-reactivation apply uses CAS (expected_status: archived)", /expected_status: "archived"/.test(idxSrc));
  }
} finally {
  if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = prevRoot;
  try { fs.rmSync(abrainHome, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch {}
}

console.log("\n────");
console.log(`PASS ${pass} / ${pass + fail}`);
if (fail > 0) { console.log("FAILURES — investigate before commit"); process.exit(1); }
process.exit(0);
