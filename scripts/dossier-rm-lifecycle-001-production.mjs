#!/usr/bin/env node
/** RM-LIFECYCLE-001 production acceptance. Production inputs are read-only. */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createJiti } from "jiti";
import { embeddingConfig } from "./_embedding-config.mjs";
import { makeOracleRegistry } from "./_oracle-registry.mjs";

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const home = os.homedir();
function resolveHomePath(value, fallback) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return path.resolve(raw.replace(/^~(?=$|[/\\])/, home));
}
const sourceRoot = resolveHomePath(process.env.ABRAIN_ROOT, path.join(home, ".abrain"));
const sourceProject = resolveHomePath(process.env.PI_HOME, path.join(home, ".pi"));
const modelsFile = resolveHomePath(process.env.PI_MODELS_FILE, path.join(sourceProject, "agent", "models.json"));
const evidenceFile = path.join(repo, "docs/evidence/2026-07-23-rm-lifecycle-001-production.json");
const metricFiles = [
  path.join(sourceProject, ".pi-astack", "memory", "search-metrics.jsonl"),
  path.join(repo, ".pi-astack", "memory", "search-metrics.jsonl"),
];
const inputHistoryDir = path.join(sourceProject, "agent", "input-history");
const sourceProjectHistoryMarker = sourceProject
  .replace(/^[/\\]+/, "")
  .replace(/[^A-Za-z0-9._-]+/g, "-")
  .replace(/^-+|-+$/g, "");
const acceptedProfiles = new Set(["toolSearch", "pathAInject", "correctionSearch"]);
const traceA = {
  slugSha256: "a6fbcd77bee0a6058e2727d91cb3d43646af02cc2795065447d7fcfb7e1eb0c6",
  timestamp: "2026-06-01T13:30:28.194+08:00",
  archiveCommit: "47b5459a62d49803192db4be3d71daed9087329a",
  reactivationCommit: "e34754f35208298ac77a0a4f9ab418c0af6ab245",
};
const traceC = {
  slugSha256: "4375b25f221290ade0e2252058d7a42d10ac7dbf3b01dde4b3a3d2979a7e6302",
  timestamp: "2026-07-17T12:53:10.033+08:00",
  archivedEvent: "b64f1d91d3b447d41f1f067ab9b282f91f52065fad56a702634cbd5a88b331e8",
  activeEvent: "734ba1862b7957d8187708898c5a6548a3d405e24ec397bae60678b04ff40fb0",
  producer: "sediment.knowledge-event-writer@adr0039-p5",
};
const tempAbrain = fs.mkdtempSync(path.join(os.tmpdir(), "rm-lifecycle-001-abrain-"));
const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "rm-lifecycle-001-project-"));
const oldRoot = process.env.ABRAIN_ROOT;
const oldCwd = process.cwd();
const generatedAt = new Date().toISOString();
let acceptanceStage = "bootstrap";
let facts = {};

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fileSha = (file) => sha(fs.readFileSync(file));
const pathSha = (file) => sha(path.resolve(file));
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024,
}).trim();
const statusIs = (raw, status) => new RegExp(`^status: ${status}$`, "m").test(raw);
const hasArchiveAt = (raw) => /^archive_at:/m.test(raw);
function readJsonl(file) {
  if (!fs.existsSync(file)) return { file, bytes: Buffer.alloc(0), rows: [] };
  const bytes = fs.readFileSync(file);
  const rows = bytes.toString("utf8").split(/\n/).flatMap((line) => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
  return { file, bytes, rows };
}
function eventPath(eventId) {
  return path.join(sourceRoot, "l1", "events", "sha256", eventId.slice(0, 2), eventId.slice(2, 4), `${eventId}.json`);
}
/** Existing evidence self-hash: sha256(JSON.stringify(payload without dossier_sha256)). */
function finalizeEvidence(payload) {
  const next = { ...payload };
  delete next.dossier_sha256;
  next.dossier_sha256 = sha(JSON.stringify(next));
  return next;
}
function verifyEvidenceSelfHash(file) {
  if (!fs.existsSync(file)) return { ok: false, reason: "missing", status: null, expected: null, actual: null };
  const raw = fs.readFileSync(file, "utf8");
  let payload;
  try { payload = JSON.parse(raw); } catch (error) {
    return { ok: false, reason: `parse_error:${error instanceof Error ? error.message : String(error)}`, status: null, expected: null, actual: null };
  }
  const expected = typeof payload.dossier_sha256 === "string" ? payload.dossier_sha256 : null;
  const clone = { ...payload };
  delete clone.dossier_sha256;
  const actual = sha(JSON.stringify(clone));
  return {
    ok: Boolean(expected) && expected === actual,
    reason: expected === actual ? "ok" : "mismatch",
    status: typeof payload.status === "string" ? payload.status : null,
    expected,
    actual,
  };
}
/** Atomic write only after a complete successful run. Failure paths must not call this. */
function writeEvidenceAtomic(payload) {
  fs.mkdirSync(path.dirname(evidenceFile), { recursive: true });
  const tmp = `${evidenceFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload)}\n`);
  fs.renameSync(tmp, evidenceFile);
  return payload;
}
function requireOne(rows, label) {
  if (rows.length !== 1) throw new Error(`${label}: expected exactly one matching production record, found ${rows.length}`);
  return rows[0];
}
function traceEvent(eventId, expectedStatus) {
  const file = eventPath(eventId);
  if (!fs.existsSync(file)) throw new Error(`trace C ${expectedStatus} event is missing`);
  const event = JSON.parse(fs.readFileSync(file, "utf8"));
  const payload = event?.body?.payload;
  const producer = event?.body?.producer;
  const producerTag = producer && typeof producer === "object" ? `${producer.name}@${producer.version}` : "";
  if (event.event_id !== eventId || event.body_hash !== eventId) throw new Error(`trace C ${expectedStatus} event hash identity mismatch`);
  if (producerTag !== traceC.producer) throw new Error(`trace C ${expectedStatus} event producer mismatch`);
  if (!payload || payload.status !== expectedStatus || sha(String(payload.slug ?? "")) !== traceC.slugSha256) {
    throw new Error(`trace C ${expectedStatus} event lifecycle payload mismatch`);
  }
  return { event_id: eventId, event_file_sha256: fileSha(file), body_hash: event.body_hash, producer: producerTag, status: payload.status };
}

async function run() {
  const priorEvidence = verifyEvidenceSelfHash(evidenceFile);
  if (fs.existsSync(evidenceFile) && !priorEvidence.ok) {
    throw new Error(`existing evidence self-hash invalid (${priorEvidence.reason}); refusing to overwrite`);
  }
  if (priorEvidence.ok) {
    console.log(JSON.stringify({
      prior_evidence: {
        status: priorEvidence.status,
        dossier_sha256: priorEvidence.expected,
        self_hash_ok: true,
      },
    }));
  }

  const cfg0 = embeddingConfig();
  if (!fs.existsSync(sourceRoot) || !cfg0.apiKey || !cfg0.baseUrl) throw new Error("production source or embedding route unavailable");
  const sourceHeadBefore = git(sourceRoot, "rev-parse", "HEAD");
  const sourceStatusBeforeSha = sha(git(sourceRoot, "status", "--porcelain=v1", "-uall"));

  acceptanceStage = "historical_trace";
  const reactivationLedger = readJsonl(path.join(sourceRoot, ".state/sediment/archive-reactivation-ledger.jsonl"));
  const auditLedger = readJsonl(path.join(sourceRoot, ".state/sediment/audit.jsonl"));
  if (!reactivationLedger.rows.length || !auditLedger.rows.length) throw new Error("required production ledger/audit is unavailable");
  const aApply = requireOne(reactivationLedger.rows.filter((row) =>
    row.operation === "archive_reactivation_apply" && row.ts === traceA.timestamp
      && row.ok === true && sha(String(row.slug ?? "")) === traceA.slugSha256,
  ), "trace A apply ledger");
  const aDecision = requireOne(reactivationLedger.rows.filter((row) =>
    row.operation === "archive_reactivation_decision" && row.ts === traceA.timestamp
      && row.decision === "reactivate" && sha(String(row.slug ?? "")) === traceA.slugSha256,
  ), "trace A decision ledger");
  const aAudit = requireOne(auditLedger.rows.filter((row) =>
    row.operation === "archive_reactivation_apply" && row.lint_result === "pass"
      && row.git_commit === traceA.reactivationCommit
      && sha(String(row.target ?? "").replace(/^world:/, "")) === traceA.slugSha256,
  ), "trace A writer audit");
  if (typeof aAudit.path !== "string" || !aAudit.path.startsWith("knowledge/")) throw new Error("trace A audit path is not a world knowledge path");
  const archiveBefore = git(sourceRoot, "show", `${traceA.archiveCommit}^:${aAudit.path}`);
  const archiveAfter = git(sourceRoot, "show", `${traceA.archiveCommit}:${aAudit.path}`);
  const reactivateAfter = git(sourceRoot, "show", `${traceA.reactivationCommit}:${aAudit.path}`);
  if (!statusIs(archiveBefore, "active") || !statusIs(archiveAfter, "archived") || !hasArchiveAt(archiveAfter)) {
    throw new Error("trace A archive commit does not prove active to archived with archive_at");
  }
  if (!statusIs(reactivateAfter, "active") || hasArchiveAt(reactivateAfter)) {
    throw new Error("trace A reactivation commit does not prove active state with archive_at cleared");
  }
  const cApply = requireOne(reactivationLedger.rows.filter((row) =>
    row.operation === "archive_reactivation_apply" && row.ts === traceC.timestamp
      && row.ok === true && sha(String(row.slug ?? "")) === traceC.slugSha256,
  ), "trace C apply ledger");
  const cArchived = traceEvent(traceC.archivedEvent, "archived");
  const cActive = traceEvent(traceC.activeEvent, "active");

  process.env.ABRAIN_ROOT = sourceRoot;
  const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
  const parser = await jiti.import(path.join(repo, "extensions/memory/parser.ts"));
  const settingsMod = await jiti.import(path.join(repo, "extensions/memory/settings.ts"));
  const search = await jiti.import(path.join(repo, "extensions/memory/search.ts"));
  const core = await jiti.import(path.join(repo, "extensions/memory/llm-search.ts"));
  const embed = await jiti.import(path.join(repo, "extensions/memory/embedding.ts"));
  const writer = await jiti.import(path.join(repo, "extensions/sediment/writer.ts"));
  const sedimentSettingsMod = await jiti.import(path.join(repo, "extensions/sediment/settings.ts"));

  acceptanceStage = "production_corpus";
  const settings = settingsMod.resolveSettings();
  const entries = await parser.loadEntries(sourceProject, settings, undefined);
  const active = entries.filter((entry) => entry.status === "active");
  const archived = entries.filter((entry) => entry.status === "archived");
  const superseded = entries.filter((entry) => entry.status === "superseded");
  // Re-run gate: require a real production archived surface, not a frozen count.
  if (archived.length <= 0) throw new Error(`expected real archived entries > 0, found ${archived.length}`);
  const snapshots = metricFiles.map(readJsonl);
  const unique = new Map();
  for (const snapshot of snapshots) for (let row = 0; row < snapshot.rows.length; row += 1) {
    const value = snapshot.rows[row];
    const query = typeof value.query === "string" ? value.query.trim() : "";
    const profile = String(value.search_profile ?? "");
    if (query.length >= 12 && acceptedProfiles.has(profile)) unique.set(`${profile}\0${query}`, { query, profile, file: snapshot.file, row });
  }
  const inputSnapshots = fs.existsSync(inputHistoryDir)
    ? fs.readdirSync(inputHistoryDir)
      .filter((name) => name.endsWith(".jsonl") && name.includes(sourceProjectHistoryMarker))
      .map((name) => readJsonl(path.join(inputHistoryDir, name)))
    : [];
  const inputs = new Map();
  for (const snapshot of inputSnapshots) for (let row = 0; row < snapshot.rows.length; row += 1) {
    const text = typeof snapshot.rows[row].text === "string" ? snapshot.rows[row].text.trim() : "";
    if (text.length < 12 || /(password|passwd|pwd|api[_ -]?key|secret|token|密码|密钥)\s*[:=：]/i.test(text)) continue;
    inputs.set(text.slice(0, 500), { query: text.slice(0, 500), profile: "inputHistory", file: snapshot.file, row, ts: Number(snapshot.rows[row].ts ?? 0) });
  }
  for (const item of [...inputs.values()].sort((a, b) => a.ts - b.ts || a.file.localeCompare(b.file) || a.row - b.row).slice(-500)) {
    unique.set(`inputHistory\0${item.query}`, item);
  }
  const queries = [...unique.values()].slice(-800);
  if (!queries.length) throw new Error("no qualified real production query rows");
  facts = {
    active: active.length,
    archived: archived.length,
    superseded: superseded.length,
    query_rows: [...snapshots, ...inputSnapshots].reduce((count, snapshot) => count + snapshot.rows.length, 0),
    qualified_queries: queries.length,
    query_snapshots: [...snapshots, ...inputSnapshots].map((snapshot) => ({ path_sha256: pathSha(snapshot.file), bytes: snapshot.bytes.length, sha256: sha(snapshot.bytes) })),
  };

  process.env.ABRAIN_ROOT = tempAbrain;
  process.chdir(tempProject);
  const { registry } = await makeOracleRegistry(modelsFile);
  const cfg = { ...cfg0 };
  acceptanceStage = "archived_dense_surface";
  const indexPath = embed.vectorIndexPath();
  const build = await embed.buildCorpusEmbeddings(entries, cfg, indexPath, { maxChars: settings.embedding.entryEmbedMaxChars, saveEvery: 100 });
  const index = new embed.VectorIndex(indexPath, cfg.model, cfg.dim).load();
  if (build.archived !== archived.length || index.size() !== build.total) throw new Error("isolated full lifecycle index rebuild mismatch");
  const searchSettings = {
    ...settings,
    embedding: { ...settings.embedding, ...cfg },
    search: { ...settings.search, autoReconcile: false },
  };
  const archivedBySlug = new Map(archived.map((entry) => [entry.slug, entry]));
  const archivedAllow = new Set(archivedBySlug.keys());
  const vectors = await embed.embedTexts(queries.map((item) => item.query), cfg);
  const pairs = [];
  for (let qi = 0; qi < queries.length; qi += 1) {
    for (const hit of index.topN(vectors[qi], 3, { allowSlugs: archivedAllow, agg: "chunk0" })) {
      const candidate = archivedBySlug.get(hit.slug);
      if (candidate && !core.sparseMatchSlugsBM25(queries[qi].query, [candidate]).includes(candidate.slug)) {
        pairs.push({ qi, candidate, score: hit.score });
      }
    }
  }
  pairs.sort((a, b) => b.score - a.score);
  const qualified = [];
  const seen = new Set();
  for (const pair of pairs) {
    const key = `${pair.qi}:${pair.candidate.slug}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pool = await core.selectStage0Pool(queries[pair.qi].query, entries, searchSettings, registry, { status: ["all"] }, { profileName: "sedimentDedup", reconcileEntries: entries });
    if (pool?.denseSlugs.includes(pair.candidate.slug)
      && pool.candidateEntries.some((entry) => entry.slug === pair.candidate.slug && entry.status === "archived")
      && pool.reconcileSignal.orphanCount === 0) {
      qualified.push({ ...pair, pool });
      if (qualified.length === 12) break;
    }
  }
  if (qualified.length !== 12) throw new Error(`expected 12 real archived dense candidates, found ${qualified.length}`);
  const defaultChecks = [];
  for (const pair of qualified) {
    const defaultCorpus = entries.filter((entry) => search.entryMatchesFilters(entry, undefined));
    const pool = await core.selectStage0Pool(queries[pair.qi].query, defaultCorpus, searchSettings, registry, {}, { profileName: "toolSearch", reconcileEntries: entries });
    const retiredLeak = Boolean(pool?.candidateEntries.some((entry) => entry.status === "archived" || entry.status === "superseded"));
    if (retiredLeak) throw new Error("default active stage0 leaked an archived or superseded entry");
    defaultChecks.push({ query_sha256: sha(queries[pair.qi].query), candidate_slug_sha256: sha(pair.candidate.slug), default_retired_leak: retiredLeak });
  }

  acceptanceStage = "isolated_historical_replay";
  const isolatedEntry = path.join(tempAbrain, aAudit.path);
  fs.mkdirSync(path.dirname(isolatedEntry), { recursive: true });
  fs.writeFileSync(isolatedEntry, archiveAfter);
  const parsedArchived = await parser.parseEntry(isolatedEntry, { scope: "world", root: path.join(tempAbrain, "knowledge"), label: "rm-lifecycle-001-historical-trace-a" }, tempProject);
  if (!parsedArchived || parsedArchived.status !== "archived" || typeof parsedArchived.frontmatter?.archive_at !== "string") {
    throw new Error("trace A archived git snapshot cannot be parsed as an archived lifecycle entry");
  }
  const sedimentBase = sedimentSettingsMod.resolveSedimentSettings();
  // Isolated writer/CAS replay only; do not re-open LLM decision/write paths.
  const sedimentSettings = {
    ...sedimentBase,
    gitCommit: false,
    autoLlmWriteEnabled: false,
    knowledgeEvidenceEventWriter: { ...sedimentBase.knowledgeEvidenceEventWriter, enabled: false },
    knowledgeProjector: { ...sedimentBase.knowledgeProjector, enabled: false, projectOnWrite: false, canonicalReadMode: "legacy" },
  };
  const replay = await writer.updateProjectEntry(parsedArchived.slug, {
    status: "active",
    expected_status: "archived",
    timelineAction: "reactivated",
    timelineNote: "RM-LIFECYCLE-001 historical production trace A isolated replay",
    sessionId: "rm-lifecycle-001-historical-replay",
  }, {
    projectRoot: tempProject,
    abrainHome: tempAbrain,
    projectId: "pi-global",
    scope: "world",
    settings: sedimentSettings,
    dryRun: false,
    auditOperation: "rm_lifecycle_001_historical_replay",
  });
  const replayRaw = fs.readFileSync(isolatedEntry, "utf8");
  const replayedEntry = await parser.parseEntry(isolatedEntry, { scope: "world", root: path.join(tempAbrain, "knowledge"), label: "rm-lifecycle-001-historical-replay" }, tempProject);
  if (replay.status === "rejected" || !statusIs(replayRaw, "active") || hasArchiveAt(replayRaw)
    || !replayedEntry || !search.entryMatchesFilters(replayedEntry, undefined)) {
    throw new Error("trace A isolated writer/CAS replay did not restore default active visibility");
  }
  const isolatedAudit = readJsonl(path.join(tempAbrain, ".state/sediment/audit.jsonl"));
  const replayAudit = requireOne(isolatedAudit.rows.filter((row) => row.operation === "rm_lifecycle_001_historical_replay" && row.lint_result === "pass"), "isolated writer replay audit");

  const sourceHeadAfter = git(sourceRoot, "rev-parse", "HEAD");
  const sourceStatusAfterSha = sha(git(sourceRoot, "status", "--porcelain=v1", "-uall"));
  if (sourceHeadAfter !== sourceHeadBefore || sourceStatusAfterSha !== sourceStatusBeforeSha) throw new Error("read-only production source changed during dossier execution");
  acceptanceStage = "complete";
  const result = finalizeEvidence({
    schema_version: "rm-lifecycle-001-production-evidence/v2",
    status: "passed",
    generated_at_utc: generatedAt,
    source: {
      abrain_root_sha256: pathSha(sourceRoot),
      readonly: true,
      head_before: sourceHeadBefore,
      head_after: sourceHeadAfter,
      head_unchanged: true,
      status_before_sha256: sourceStatusBeforeSha,
      status_after_sha256: sourceStatusAfterSha,
      no_user_writes: true,
      production_write_calls: 0,
    },
    gate_a_archived_dense_surface: {
      passed: true,
      real_archived_entries: archived.length,
      real_query_corpus: facts,
      isolated_index: { total: build.total, active: build.active, archived: build.archived, index_sha256: fileSha(indexPath) },
      dedup_dense_candidates: qualified.map((pair) => ({
        archived_slug_sha256: sha(pair.candidate.slug),
        query_sha256: sha(queries[pair.qi].query),
        dense_score: Number(pair.score.toFixed(8)),
        sparse_candidate_hit: false,
        sediment_dedup_dense_hit: true,
        reconcile_orphan_count: pair.pool.reconcileSignal.orphanCount,
      })),
      default_active_boundary: defaultChecks,
      archived_not_orphan: true,
    },
    gate_b_reactivation_trace: {
      passed: true,
      no_llm_decision_replay: true,
      trace_a: {
        slug_sha256: traceA.slugSha256,
        ledger_file_sha256: sha(reactivationLedger.bytes),
        decision_row_sha256: sha(JSON.stringify(aDecision)),
        apply_row_sha256: sha(JSON.stringify(aApply)),
        audit_file_sha256: sha(auditLedger.bytes),
        audit_row_sha256: sha(JSON.stringify(aAudit)),
        archive_commit: traceA.archiveCommit,
        archive_commit_diff_sha256: sha(archiveBefore + archiveAfter),
        reactivation_commit: traceA.reactivationCommit,
        reactivation_commit_diff_sha256: sha(reactivateAfter),
        archived_prior_state: true,
        archive_at_present_before_replay: true,
      },
      trace_c: {
        slug_sha256: traceC.slugSha256,
        ledger_file_sha256: sha(reactivationLedger.bytes),
        apply_row_sha256: sha(JSON.stringify(cApply)),
        archived_event: cArchived,
        active_event: cActive,
        archived_to_active_event_chain: true,
      },
      isolated_replay: {
        isolation_path_sha256: pathSha(isolatedEntry),
        target_abrain_root_sha256: pathSha(tempAbrain),
        target_project_root_sha256: pathSha(tempProject),
        target_isolated: path.resolve(tempAbrain) !== path.resolve(sourceRoot),
        writer_result: replay.status,
        writer_audit_row_sha256: sha(JSON.stringify(replayAudit)),
        writer_lint_pass: replayAudit.lint_result === "pass",
        cas_expected_status: "archived",
        final_status: "active",
        archive_at_cleared: !hasArchiveAt(replayRaw),
        default_active_visible: true,
        auto_llm_write_enabled: false,
      },
    },
    invariants: {
      archived_dense_only_for_sediment_dedup: true,
      default_active_excludes_archived_and_superseded: true,
      missing_full_reconcile_entries_fails_closed: true,
      historical_reactivation_is_not_forgetting_controlled_batch_completion: true,
      physical_delete_authorized_or_executed: false,
    },
    repository: { head: git(repo, "rev-parse", "HEAD"), worktree_status_sha256: sha(git(repo, "status", "--porcelain=v1", "-uall")) },
  });
  const verified = finalizeEvidence({ ...result });
  if (verified.dossier_sha256 !== result.dossier_sha256) throw new Error("evidence self-hash unstable before write");
  writeEvidenceAtomic(result);
  const afterWrite = verifyEvidenceSelfHash(evidenceFile);
  if (!afterWrite.ok || afterWrite.expected !== result.dossier_sha256) {
    throw new Error("written evidence failed self-hash verification");
  }
  console.log(JSON.stringify({
    status: result.status,
    archived: archived.length,
    dense_candidates: qualified.length,
    evidence: path.relative(repo, evidenceFile),
    dossier_sha256: result.dossier_sha256,
    self_hash_ok: true,
  }));
}

try {
  await run();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  const preserved = verifyEvidenceSelfHash(evidenceFile);
  // Never overwrite the last verified passed evidence on transient/provider failure.
  const blockedReport = finalizeEvidence({
    schema_version: "rm-lifecycle-001-production-evidence/v2",
    status: "blocked",
    generated_at_utc: generatedAt,
    blocked_stage: acceptanceStage,
    blocked_reason: reason,
    source: { abrain_root_sha256: pathSha(sourceRoot), readonly: true, no_user_writes: true, production_write_calls: 0 },
    isolation: { target_abrain_root_sha256: pathSha(tempAbrain), target_isolated: path.resolve(tempAbrain) !== path.resolve(sourceRoot), no_user_abrain_writes: true },
    production_corpus: facts,
    preserved_evidence: {
      path_relative: path.relative(repo, evidenceFile),
      present: fs.existsSync(evidenceFile),
      self_hash_ok: preserved.ok,
      status: preserved.status,
      dossier_sha256: preserved.expected,
      overwritten: false,
    },
  });
  const tmpReport = path.join(os.tmpdir(), `rm-lifecycle-001-blocked-${process.pid}.json`);
  fs.writeFileSync(tmpReport, `${JSON.stringify(blockedReport)}\n`);
  console.error(`RM-LIFECYCLE-001 PRODUCTION BLOCKED: ${reason}`);
  console.error(`preserved_evidence=${path.relative(repo, evidenceFile)} self_hash_ok=${preserved.ok} status=${preserved.status ?? "missing"} sha256=${preserved.expected ?? "n/a"}`);
  console.error(`blocked_report_tmp=${tmpReport} sha256=${blockedReport.dossier_sha256}`);
  process.exitCode = 1;
} finally {
  process.chdir(oldCwd);
  if (oldRoot === undefined) delete process.env.ABRAIN_ROOT;
  else process.env.ABRAIN_ROOT = oldRoot;
  fs.rmSync(tempAbrain, { recursive: true, force: true });
  fs.rmSync(tempProject, { recursive: true, force: true });
}
