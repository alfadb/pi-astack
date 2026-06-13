#!/usr/bin/env node
/**
 * Smoke test for ADR 0034 §2.1 source-aware ingest lane (Phase 2).
 *
 * Sandbox only: a throwaway ~/.abrain git repo + project dir under os.tmpdir().
 * Never touches the real ~/.abrain. The cognitive decomposition step is injected
 * (stub drafts) so the lane's planner + writer + rollback are deterministically
 * exercised. Negative tests are bidirectional (red-line / sanitize-fail / rollback
 * all assert the failure path fires).
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

let passed = 0;
function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
  passed++;
}

function transpileDirs(outRoot, dirs) {
  const extRoot = path.join(repoRoot, "extensions");
  for (const dir of dirs) {
    const srcDir = path.join(extRoot, dir);
    for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith(".ts"))) {
      const src = fs.readFileSync(path.join(srcDir, file), "utf-8");
      const out = ts.transpileModule(src, {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
          moduleResolution: ts.ModuleResolutionKind.NodeJs,
          esModuleInterop: true,
          skipLibCheck: true,
        },
      }).outputText;
      const outPath = path.join(outRoot, dir, file.replace(/\.ts$/, ".js"));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, out);
    }
  }
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf-8" }).trim();
}

function makeAbrainRepo(projectId) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ingest-abrain-"));
  const projectDir = path.join(home, "projects", projectId);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, "_project.json"), JSON.stringify({ schema_version: 1, project_id: projectId }));
  git(home, ["init", "-q"]);
  git(home, ["config", "user.email", "smoke@example.com"]);
  git(home, ["config", "user.name", "smoke"]);
  git(home, ["add", "-A"]);
  git(home, ["commit", "-q", "-m", "init"]);
  return { home, projectDir };
}

function validDraft(slug, heading, extra = {}) {
  return {
    slug,
    title: `Title ${slug}`,
    kind: "decision",
    compiledTruth: `This is a compiled truth for ${slug}, long enough to pass schema validation.`,
    sourceHeading: heading,
    ...extra,
  };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-ingest-build-"));
transpileDirs(tmp, ["_shared", "memory", "sediment"]);

const ingest = require(path.join(tmp, "memory", "ingest-adr.js"));
const { DEFAULT_SETTINGS } = require(path.join(tmp, "memory", "settings.js"));
const { planIngest, runAdrIngest, buildSourceRef, INGEST_PROVENANCE, INGEST_TIMELINE_MARKER } = ingest;

const TS = "2026-06-13T18:00:00.000+08:00";
const SHA = "abc1234";
const ADR = "docs/adr/0026-second-brain-decision-participation.md";

// ─── planIngest (pure) ─────────────────────────────────────────────────────
{
  const src = {
    adrPath: ADR,
    sha: SHA,
    decomposition: {
      drafts: [validDraft("entry-a", "§2"), validDraft("entry-b", "§3"), validDraft("entry-c", "§4")],
      processed: ["§2", "§3", "§4"],
      skipped: [{ heading: "§5", reason: "direction-class, not mechanism" }],
    },
  };
  const m = planIngest([src]);
  assert(m.entries.length === 3, "plan: 3 entries");
  assert(m.totalIssues === 0, "plan: 0 issues for valid drafts");
  assert(m.entries[0].sourceRef === `${ADR}#§2@${SHA}`, "plan: sourceRef = adrPath#heading@sha");
  assert(buildSourceRef(ADR, "§2", SHA) === `${ADR}#§2@${SHA}`, "buildSourceRef format");
  assert(m.coverage[0].processed.length === 3 && m.coverage[0].skipped.length === 1, "plan: coverage processed/skipped");
  assert(m.flags.some((f) => /1 heading\(s\) skipped/.test(f)), "plan: skipped → advisory flag");
}
{
  // single-entry ADR → whole-dump advisory flag (走偏 #1)
  const m = planIngest([{ adrPath: ADR, sha: SHA, decomposition: { drafts: [validDraft("solo", "§2")], processed: ["§2"], skipped: [] } }]);
  assert(m.flags.some((f) => /only 1 entry/.test(f)), "plan: single entry → whole-dump flag");
}
{
  // red-line direction_impact + bad kind → issues (not silently accepted)
  const redline = validDraft("bad-di", "§2", { directionImpact: ["weakens | direction.md#INV-AUTONOMY | none"] });
  const badkind = validDraft("bad-kind", "§3", { kind: "notakind" });
  const noheading = validDraft("no-head", "");
  const m = planIngest([{ adrPath: ADR, sha: SHA, decomposition: { drafts: [redline, badkind, noheading], processed: ["§2", "§3"], skipped: [] } }]);
  assert(m.entries[0].issues.some((i) => /direction_impact/.test(i) && /MUST be escalated/.test(i)), "plan: red-line → issue");
  assert(m.entries[1].issues.some((i) => /kind/.test(i)), "plan: bad kind → issue");
  assert(m.entries[2].issues.some((i) => /sourceHeading/.test(i)), "plan: missing heading → issue");
  assert(m.totalIssues >= 3, "plan: totalIssues counts all");
}
{
  // long body → under-decomposition advisory flag
  const big = validDraft("big", "§2", { compiledTruth: "x".repeat(2000) });
  const m = planIngest([{ adrPath: ADR, sha: SHA, decomposition: { drafts: [big, validDraft("b2", "§3")], processed: ["§2", "§3"], skipped: [] } }]);
  assert(m.flags.some((f) => /possible under-decomposition/.test(f)), "plan: long body → flag");
}

// ─── dry-run: NO writes (acceptance ②) ──────────────────────────────────────
{
  const { home, projectDir } = makeAbrainRepo("pi-global");
  const src = { adrPath: ADR, sha: SHA, decomposition: { drafts: [validDraft("dry-a", "§2")], processed: ["§2"], skipped: [] } };
  const r = await runAdrIngest({ abrainHome: home, projectId: "pi-global", sources: [src], dryRun: true, settings: DEFAULT_SETTINGS, timestamp: TS });
  assert(r.ok === true && r.dryRun === true, "dry-run: ok");
  assert(r.manifest.entries.length === 1, "dry-run: manifest produced");
  assert(r.written.length === 0, "dry-run: nothing written");
  const mdFiles = fs.readdirSync(projectDir).filter((f) => f.endsWith(".md"));
  assert(mdFiles.length === 0, "dry-run: no .md files on disk");
  fs.rmSync(home, { recursive: true, force: true });
}

// ─── --go happy path ────────────────────────────────────────────────────────
{
  const { home, projectDir } = makeAbrainRepo("pi-global");
  const headBefore = git(home, ["rev-parse", "HEAD"]);
  const src = {
    adrPath: ADR,
    sha: SHA,
    decomposition: {
      drafts: [
        validDraft("go-a", "§2", { directionImpact: ["supports | requirements.md#REQ-003 | none"] }),
        validDraft("go-b", "§3"),
      ],
      processed: ["§2", "§3"],
      skipped: [],
    },
  };
  const r = await runAdrIngest({ abrainHome: home, projectId: "pi-global", sources: [src], dryRun: false, settings: DEFAULT_SETTINGS, timestamp: TS });
  assert(r.ok === true, `go: ok (err=${r.error})`);
  assert(r.written.length === 2, "go: 2 written");
  assert(r.abrainPreSha === headBefore, "go: abrainPreSha captured = HEAD before");
  const fileA = path.join(projectDir, "go-a.md");
  assert(fs.existsSync(fileA), "go: entry file written");
  const content = fs.readFileSync(fileA, "utf-8");
  assert(content.includes(`provenance: ${INGEST_PROVENANCE}`), "go: provenance = content-in-transcript");
  assert(/^source_ref:/m.test(content) && content.includes(`${ADR}#§2@${SHA}`), "go: source_ref present (pinned SHA)");
  assert(content.includes(INGEST_TIMELINE_MARKER), "go: timeline marker migrated-from-mechanism-docs");
  assert(content.includes("direction_impact:") && content.includes("supports | requirements.md#REQ-003 | none"), "go: direction_impact rendered");
  assert(!content.includes("derives_from:"), "go: uses source_ref not derives_from (no graph pollution)");
  assert(r.commitSha && r.commitSha !== headBefore, "go: committed new sha");
  // audit row
  const auditPath = path.join(home, ".sediment", "audit.jsonl");
  let auditFound = false;
  for (const cand of [auditPath, path.join(home, "sediment-audit.jsonl")]) {
    if (fs.existsSync(cand)) { auditFound = fs.readFileSync(cand, "utf-8").includes("ingest_adr"); break; }
  }
  // audit path may differ; check via recursive scan as fallback
  if (!auditFound) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
      const p = path.join(d, e.name);
      return e.isDirectory() ? (e.name === ".git" ? [] : walk(p)) : [p];
    });
    auditFound = walk(home).some((f) => /\.jsonl$/.test(f) && fs.readFileSync(f, "utf-8").includes("ingest_adr"));
  }
  assert(auditFound, "go: ingest_adr audit row written");
  fs.rmSync(home, { recursive: true, force: true });
}

// ─── --go skips entries with issues (red-line never persisted) ──────────────
{
  const { home, projectDir } = makeAbrainRepo("pi-global");
  const src = {
    adrPath: ADR,
    sha: SHA,
    decomposition: {
      drafts: [
        validDraft("ok-one", "§2"),
        validDraft("bad-one", "§3", { directionImpact: ["weakens | direction.md#INV-AUTONOMY | none"] }),
      ],
      processed: ["§2", "§3"],
      skipped: [],
    },
  };
  const r = await runAdrIngest({ abrainHome: home, projectId: "pi-global", sources: [src], dryRun: false, settings: DEFAULT_SETTINGS, timestamp: TS });
  assert(r.written.includes("ok-one"), "go-issues: valid entry written");
  assert(r.skippedWithIssues.includes("bad-one"), "go-issues: red-line entry skipped");
  assert(!fs.existsSync(path.join(projectDir, "bad-one.md")), "go-issues: red-line entry NOT on disk");
  assert(r.ok === false, "go-issues: ok=false when entries skipped");
  fs.rmSync(home, { recursive: true, force: true });
}

// ─── secret boundary (⑩): sanitizer redacts before persist ──────────────────
{
  const { home, projectDir } = makeAbrainRepo("pi-global");
  const redactor = (s) => ({ ok: true, text: s.replace(/SECRET[0-9]+/g, "[REDACTED]"), replacements: [] });
  const src = { adrPath: ADR, sha: SHA, decomposition: { drafts: [validDraft("sec", "§2", { compiledTruth: "Body with SECRET123 token inside, long enough to pass." })], processed: ["§2"], skipped: [] } };
  await runAdrIngest({ abrainHome: home, projectId: "pi-global", sources: [src], dryRun: false, settings: DEFAULT_SETTINGS, timestamp: TS, sanitize: redactor });
  const content = fs.readFileSync(path.join(projectDir, "sec.md"), "utf-8");
  assert(!content.includes("SECRET123"), "secret: raw secret redacted in persisted entry");
  assert(content.includes("[REDACTED]"), "secret: redaction marker present");
  fs.rmSync(home, { recursive: true, force: true });
}

// ─── sanitize-fail withholds the entry ──────────────────────────────────────
{
  const { home, projectDir } = makeAbrainRepo("pi-global");
  const failSan = (s) => (s.includes("UNSAFE") ? { ok: false, error: "unsanitizable", replacements: [] } : { ok: true, text: s, replacements: [] });
  const src = { adrPath: ADR, sha: SHA, decomposition: { drafts: [validDraft("withhold", "§2", { compiledTruth: "Body with UNSAFE content that cannot be sanitized at all." })], processed: ["§2"], skipped: [] } };
  const r = await runAdrIngest({ abrainHome: home, projectId: "pi-global", sources: [src], dryRun: false, settings: DEFAULT_SETTINGS, timestamp: TS, sanitize: failSan });
  assert(r.failed.some((f) => f.slug === "withhold"), "sanitize-fail: entry in failed[]");
  assert(!fs.existsSync(path.join(projectDir, "withhold.md")), "sanitize-fail: entry NOT persisted");
  fs.rmSync(home, { recursive: true, force: true });
}

// ─── rollback: partial writes reverted on mid-run failure ───────────────────
{
  const { home, projectDir } = makeAbrainRepo("pi-global");
  const headBefore = git(home, ["rev-parse", "HEAD"]);
  let n = 0;
  const throwOnSecond = (s) => {
    // succeed for entry 1's title+body, throw during entry 2 to trigger catch→rollback
    n += 1;
    if (n > 2) throw new Error("boom-during-entry-2");
    return { ok: true, text: s, replacements: [] };
  };
  const src = {
    adrPath: ADR,
    sha: SHA,
    decomposition: { drafts: [validDraft("roll-a", "§2"), validDraft("roll-b", "§3")], processed: ["§2", "§3"], skipped: [] },
  };
  const r = await runAdrIngest({ abrainHome: home, projectId: "pi-global", sources: [src], dryRun: false, settings: DEFAULT_SETTINGS, timestamp: TS, sanitize: throwOnSecond });
  assert(r.rolledBack === true, "rollback: rolledBack flag set");
  assert(/boom-during-entry-2/.test(r.error || ""), "rollback: error propagated");
  assert(!fs.existsSync(path.join(projectDir, "roll-a.md")), "rollback: partial write (roll-a) removed by reset+clean");
  assert(git(home, ["rev-parse", "HEAD"]) === headBefore, "rollback: HEAD restored to pre-ingest sha");
  assert(git(home, ["status", "--porcelain"]) === "", "rollback: working tree clean after rollback");
  fs.rmSync(home, { recursive: true, force: true });
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`smoke:adr-ingest OK (${passed} assertions)`);
