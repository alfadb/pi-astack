#!/usr/bin/env node
/**
 * Smoke test: ADR 0017 / B4.5 strict active-project resolver.
 *
 * The old resolver read ~/.abrain/projects/_bindings.md and inferred project
 * identity from cwd / git remote. B4.5 replaces that with a strict three-
 * artifact model:
 *   1. <project>/.abrain-project.json
 *   2. ~/.abrain/projects/<id>/_project.json
 *   3. ~/.abrain/.state/projects/local-map.json
 *
 * Only when all three agree does project-scoped vault / sediment / migrate
 * become available.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  return ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  }).outputText;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-active-project-"));
const compiled = path.join(tmpDir, "runtime.cjs");
fs.writeFileSync(compiled, transpile(path.join(repoRoot, "extensions/_shared/runtime.ts")));
const runtime = require(compiled);

console.log("abrain — strict active project resolver (ADR 0017)");

const abrainHome = fs.mkdtempSync(path.join(tmpDir, "abrain-"));
fs.mkdirSync(path.join(abrainHome, "projects"), { recursive: true });

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

function fakeExec(map) {
  return (file, args) => {
    const key = `${file} ${args.join(" ")}`;
    for (const [pattern, value] of Object.entries(map)) {
      if (key.startsWith(pattern)) {
        if (value === null) throw new Error("ENOENT");
        return value;
      }
    }
    throw new Error(`unmocked exec: ${key}`);
  };
}

function makeOpts(extra = {}) {
  return { abrainHome, ...extra };
}

function writeManifest(projectRoot, projectId) {
  writeJson(runtime.abrainProjectManifestPath(projectRoot), { schema_version: 1, project_id: projectId });
}
function writeRegistry(projectId, extra = {}) {
  writeJson(runtime.abrainProjectRegistryPath(abrainHome, projectId), {
    schema_version: 1,
    project_id: projectId,
    created_at: "2026-05-12T20:00:00.000+08:00",
    updated_at: "2026-05-12T20:00:00.000+08:00",
    ...extra,
  });
}
function writeLocalMap(map) {
  writeJson(runtime.abrainProjectLocalMapPath(abrainHome), map);
}
function localMapFor(projectId, paths) {
  return {
    schema_version: 1,
    projects: {
      [projectId]: {
        paths: paths.map((p) => ({ path: p, first_seen: "2026-05-12T20:00:00.000+08:00", last_seen: "2026-05-12T20:00:00.000+08:00", confirmed_at: "2026-05-12T20:00:00.000+08:00" })),
      },
    },
  };
}

// ── path / id helpers ─────────────────────────────────────────
await check("path helpers resolve strict binding artifacts", () => {
  const projectRoot = path.join(tmpDir, "project-a");
  const manifest = runtime.abrainProjectManifestPath(projectRoot);
  if (manifest !== path.join(projectRoot, ".abrain-project.json")) throw new Error(`manifest=${manifest}`);
  const registry = runtime.abrainProjectRegistryPath(abrainHome, "alpha");
  if (registry !== path.join(abrainHome, "projects", "alpha", "_project.json")) throw new Error(`registry=${registry}`);
  const localMap = runtime.abrainProjectLocalMapPath(abrainHome);
  if (localMap !== path.join(abrainHome, ".state", "projects", "local-map.json")) throw new Error(`localMap=${localMap}`);
});

await check("resolveBrainPaths returns project + vault + registry/localMap paths", () => {
  const paths = runtime.resolveBrainPaths(abrainHome, "pi-astack");
  if (!paths.projectDir.endsWith(path.join("projects", "pi-astack"))) throw new Error(`bad projectDir: ${paths.projectDir}`);
  if (!paths.projectVaultDir.endsWith(path.join("projects", "pi-astack", "vault"))) throw new Error(`bad vault dir: ${paths.projectVaultDir}`);
  if (!paths.registryPath.endsWith(path.join("projects", "pi-astack", "_project.json"))) throw new Error(`bad registryPath: ${paths.registryPath}`);
  if (!paths.localMapPath.endsWith(path.join(".state", "projects", "local-map.json"))) throw new Error(`bad localMapPath: ${paths.localMapPath}`);
});

await check("listAbrainProjects returns sorted ids and skips unsafe entries", () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "list-projects-"));
  if (runtime.listAbrainProjects(home).length !== 0) throw new Error("missing projects/ should yield []");
  const projectsRoot = path.join(home, "projects");
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(path.join(projectsRoot, "zebra"));
  fs.mkdirSync(path.join(projectsRoot, "alpha"));
  fs.mkdirSync(path.join(projectsRoot, ".hidden"));
  fs.writeFileSync(path.join(projectsRoot, "_bindings.md"), "# legacy file, not a project dir");
  const got = runtime.listAbrainProjects(home);
  if (JSON.stringify(got) !== JSON.stringify(["alpha", "zebra"])) {
    throw new Error(`expected [alpha, zebra], got ${JSON.stringify(got)}`);
  }
});

await check("validateAbrainProjectId rejects unsafe ids", () => {
  for (const bad of ["", "..", "../escape", ".hidden", "with/slash", "with\\slash", "spaces here", "weird*"]) {
    let threw = false;
    try { runtime.validateAbrainProjectId(bad); } catch { threw = true; }
    if (!threw) throw new Error(`expected reject for ${JSON.stringify(bad)}`);
  }
  runtime.validateAbrainProjectId("pi-astack");
  runtime.validateAbrainProjectId("work.uamp_full");
});

// ── strict resolver states ────────────────────────────────────
const roots = fs.mkdtempSync(path.join(tmpDir, "projects-"));
const alphaRoot = path.join(roots, "alpha");
const alphaSub = path.join(alphaRoot, "src/lib");
const betaRoot = path.join(roots, "beta");
fs.mkdirSync(alphaSub, { recursive: true });
fs.mkdirSync(betaRoot, { recursive: true });

await check("manifest_missing when .abrain-project.json is absent", () => {
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts({ execFileSync: fakeExec({ "git rev-parse --show-toplevel": null }) }));
  if (r.activeProject || r.reason !== "manifest_missing") throw new Error(JSON.stringify(r));
});

await check("manifest_invalid when .abrain-project.json is bad JSON", () => {
  fs.writeFileSync(runtime.abrainProjectManifestPath(alphaRoot), "{not json\n");
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts({ execFileSync: fakeExec({ "git rev-parse --show-toplevel": null }) }));
  if (r.activeProject || r.reason !== "manifest_invalid") throw new Error(JSON.stringify(r));
});

await check("registry_missing when manifest exists but registry is absent", () => {
  writeManifest(alphaRoot, "alpha");
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts({ execFileSync: fakeExec({ "git rev-parse --show-toplevel": null }) }));
  if (r.activeProject || r.reason !== "registry_missing" || r.projectId !== "alpha") throw new Error(JSON.stringify(r));
});

await check("registry_mismatch when registry project_id differs", () => {
  writeManifest(alphaRoot, "alpha");
  writeRegistry("alpha", { project_id: "beta" });
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts({ execFileSync: fakeExec({ "git rev-parse --show-toplevel": null }) }));
  if (r.activeProject || r.reason !== "registry_mismatch") throw new Error(JSON.stringify(r));
});

await check("path_unconfirmed when manifest+registry exist but local-map lacks current path", () => {
  writeRegistry("alpha");
  writeLocalMap(localMapFor("alpha", [betaRoot]));
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts({ execFileSync: fakeExec({ "git rev-parse --show-toplevel": null }) }));
  if (r.activeProject || r.reason !== "path_unconfirmed") throw new Error(JSON.stringify(r));
});

await check("path_conflict when current path is confirmed for another project", () => {
  writeRegistry("alpha");
  writeRegistry("beta");
  writeLocalMap(localMapFor("beta", [alphaRoot]));
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts({ execFileSync: fakeExec({ "git rev-parse --show-toplevel": null }) }));
  if (r.activeProject || r.reason !== "path_conflict") throw new Error(JSON.stringify(r));
});

await check("bound when manifest+registry+local-map all agree", () => {
  writeManifest(alphaRoot, "alpha");
  writeRegistry("alpha");
  writeLocalMap(localMapFor("alpha", [alphaRoot]));
  const r = runtime.resolveActiveProject(alphaRoot, makeOpts({ execFileSync: fakeExec({ "git rev-parse --show-toplevel": null }) }));
  if (!r.activeProject) throw new Error(JSON.stringify(r));
  if (r.activeProject.projectId !== "alpha") throw new Error(`projectId=${r.activeProject.projectId}`);
  if (r.activeProject.matchedBy !== "strict_local_map") throw new Error(`matchedBy=${r.activeProject.matchedBy}`);
});

await check("git root lookup reads manifest from repo root even when cwd is subdir", () => {
  writeManifest(alphaRoot, "alpha");
  writeRegistry("alpha");
  writeLocalMap(localMapFor("alpha", [alphaRoot]));
  const exec = fakeExec({ "git rev-parse --show-toplevel": `${alphaRoot}\n` });
  const r = runtime.resolveActiveProject(alphaSub, makeOpts({ execFileSync: exec }));
  if (!r.activeProject) throw new Error(JSON.stringify(r));
  if (r.activeProject.projectRoot !== alphaRoot) throw new Error(`projectRoot=${r.activeProject.projectRoot}`);
  if (r.activeProject.cwd !== alphaSub) throw new Error(`cwd=${r.activeProject.cwd}`);
});

// ── bind command substrate ────────────────────────────────────
await check("bindAbrainProject creates manifest + registry + local-map", async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, "bind-create-"));
  const result = await runtime.bindAbrainProject({ abrainHome, cwd: root, projectId: "created-project", now: "2026-05-12T21:00:00.000+08:00" });
  if (!result.manifestCreated || !result.registryCreated || !result.localPathAdded) throw new Error(JSON.stringify(result));
  const manifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf-8"));
  if (manifest.project_id !== "created-project") throw new Error(`manifest=${JSON.stringify(manifest)}`);
  const local = JSON.parse(fs.readFileSync(result.localMapPath, "utf-8"));
  const paths = local.projects["created-project"].paths.map((p) => p.path);
  if (!paths.includes(path.resolve(root))) throw new Error(`local paths=${JSON.stringify(paths)}`);
  const gitignore = fs.readFileSync(result.abrainGitignorePath, "utf-8");
  if (!/(^|\n)\.state\/(\n|$)/.test(gitignore)) throw new Error(`abrain .gitignore should ignore .state/: ${gitignore}`);
});

await check("bindAbrainProject rejects a symlink .gitignore before portable writes", async () => {
  const guardedHome = fs.mkdtempSync(path.join(tmpDir, "bind-gitignore-guard-home-"));
  const root = fs.mkdtempSync(path.join(tmpDir, "bind-gitignore-guard-root-"));
  const foreign = path.join(tmpDir, "bind-gitignore-foreign");
  const foreignRaw = "foreign\n";
  fs.writeFileSync(foreign, foreignRaw);
  fs.symlinkSync(foreign, path.join(guardedHome, ".gitignore"));
  let blocked = false;
  try {
    await runtime.bindAbrainProject({ abrainHome: guardedHome, cwd: root, projectId: "guarded-project" });
  } catch (error) {
    blocked = ["ELOOP", "regular non-symlink"].some((token) => String(error).includes(token));
  }
  if (!blocked) throw new Error("symlink .gitignore was accepted");
  if (fs.readFileSync(foreign, "utf8") !== foreignRaw) throw new Error("foreign symlink target changed");
  if (fs.existsSync(runtime.abrainProjectManifestPath(root))) throw new Error("manifest was written after unsafe .gitignore");
  if (fs.existsSync(runtime.abrainProjectRegistryPath(guardedHome, "guarded-project"))) throw new Error("registry was written after unsafe .gitignore");
});

await check("bindAbrainProject is idempotent and refreshes existing path", async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, "bind-refresh-"));
  await runtime.bindAbrainProject({ abrainHome, cwd: root, projectId: "refresh-project", now: "2026-05-12T21:00:00.000+08:00" });
  const result = await runtime.bindAbrainProject({ abrainHome, cwd: root, projectId: "refresh-project", now: "2026-05-12T22:00:00.000+08:00" });
  if (result.localPathAdded) throw new Error(`second bind should refresh, not add: ${JSON.stringify(result)}`);
  const local = JSON.parse(fs.readFileSync(result.localMapPath, "utf-8"));
  const paths = local.projects["refresh-project"].paths;
  if (paths.length !== 1) throw new Error(`should not duplicate paths: ${JSON.stringify(paths)}`);
  if (paths[0].last_seen !== "2026-05-12T22:00:00.000+08:00") throw new Error(`last_seen not refreshed: ${paths[0].last_seen}`);
});

await check("bindAbrainProject can confirm a second path from an existing manifest", async () => {
  const root1 = fs.mkdtempSync(path.join(tmpDir, "bind-multipath-1-"));
  const root2 = fs.mkdtempSync(path.join(tmpDir, "bind-multipath-2-"));
  await runtime.bindAbrainProject({ abrainHome, cwd: root1, projectId: "multi-project", now: "2026-05-12T21:00:00.000+08:00" });
  // Simulate a second clone carrying the same portable manifest.
  fs.copyFileSync(runtime.abrainProjectManifestPath(root1), runtime.abrainProjectManifestPath(root2));
  const result = await runtime.bindAbrainProject({ abrainHome, cwd: root2, now: "2026-05-13T09:00:00.000+08:00" });
  if (result.projectId !== "multi-project" || !result.localPathAdded) throw new Error(JSON.stringify(result));
  const local = JSON.parse(fs.readFileSync(result.localMapPath, "utf-8"));
  const paths = local.projects["multi-project"].paths.map((p) => p.path).sort();
  const want = [path.resolve(root1), path.resolve(root2)].sort();
  if (JSON.stringify(paths) !== JSON.stringify(want)) throw new Error(`paths=${JSON.stringify(paths)}, want=${JSON.stringify(want)}`);
});

await check("bindAbrainProject rejects manifest_conflict", async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, "bind-conflict-"));
  await runtime.bindAbrainProject({ abrainHome, cwd: root, projectId: "first-project" });
  let threw = false;
  try { await runtime.bindAbrainProject({ abrainHome, cwd: root, projectId: "second-project" }); }
  catch (e) { threw = /manifest_conflict/.test(String(e.message)); }
  if (!threw) throw new Error("expected manifest_conflict");
});

await check("bindAbrainProject rejects path_conflict", async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, "bind-path-conflict-"));
  await runtime.bindAbrainProject({ abrainHome, cwd: root, projectId: "path-first" });
  // Rewrite manifest to simulate a corrupt/manual rebind attempt; local-map
  // still authorizes this path for path-first, so binding to path-second must fail.
  writeManifest(root, "path-second");
  let threw = false;
  try { await runtime.bindAbrainProject({ abrainHome, cwd: root }); }
  catch (e) { threw = /path_conflict/.test(String(e.message)); }
  if (!threw) throw new Error("expected path_conflict");
});

await check("bindAbrainProject path_conflict leaves no partial new manifest", async () => {
  const root = fs.mkdtempSync(path.join(tmpDir, "bind-no-partial-conflict-"));
  writeRegistry("existing-owner");
  writeLocalMap(localMapFor("existing-owner", [root]));
  let threw = false;
  try { await runtime.bindAbrainProject({ abrainHome, cwd: root, projectId: "new-owner" }); }
  catch (e) { threw = /path_conflict/.test(String(e.message)); }
  if (!threw) throw new Error("expected path_conflict");
  if (fs.existsSync(runtime.abrainProjectManifestPath(root))) throw new Error("manifest should not be created on path_conflict");
  if (fs.existsSync(runtime.abrainProjectRegistryPath(abrainHome, "new-owner"))) throw new Error("registry should not be created on path_conflict");
});

await check("bindAbrainProject serializes concurrent local-map updates", async () => {
  const root1 = fs.mkdtempSync(path.join(tmpDir, "bind-race-1-"));
  const root2 = fs.mkdtempSync(path.join(tmpDir, "bind-race-2-"));
  await Promise.all([
    runtime.bindAbrainProject({ abrainHome, cwd: root1, projectId: "race-shared", now: "2026-05-12T21:00:00.000+08:00" }),
    runtime.bindAbrainProject({ abrainHome, cwd: root2, projectId: "race-shared", now: "2026-05-12T21:00:00.000+08:00" }),
  ]);
  const local = JSON.parse(fs.readFileSync(runtime.abrainProjectLocalMapPath(abrainHome), "utf-8"));
  const paths = local.projects["race-shared"]?.paths?.map((p) => p.path) || [];
  if (!paths.includes(path.resolve(root1))) throw new Error(`race root1 path lost: ${JSON.stringify(local.projects["race-shared"])}`);
  if (!paths.includes(path.resolve(root2))) throw new Error(`race root2 path lost: ${JSON.stringify(local.projects["race-shared"])}`);
});

await check("file lock release does not delete another owner's lock", async () => {
  const lockPath = path.join(tmpDir, "locks", "owner-token.lock");
  const handle = await runtime.acquireFileLock(lockPath, { timeoutMs: 500, staleMs: 30_000, retryMs: 10, label: "smoke" });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: "other-owner", created_at: "old" }) + "\n");
  await handle.release();
  const raw = fs.readFileSync(lockPath, "utf-8");
  if (!raw.includes("other-owner")) throw new Error(`release removed or changed another owner's lock: ${raw}`);
  fs.rmSync(lockPath, { force: true });
});

await check("file lock immediately recovers a fresh lock owned by a dead pid", async () => {
  const lockPath = path.join(tmpDir, "locks", "dead-fresh.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999999, token: "dead-owner", created_at: new Date().toISOString() }) + "\n");
  const started = Date.now();
  const handle = await runtime.acquireFileLock(lockPath, { timeoutMs: 500, staleMs: 30 * 60 * 1_000, retryMs: 10, label: "smoke-dead" });
  const elapsedMs = Date.now() - started;
  const record = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
  if (record.token === "dead-owner") throw new Error("dead owner lock was not replaced");
  if (elapsedMs >= 500) throw new Error(`dead owner recovery waited for timeout: ${elapsedMs}ms`);
  await handle.release();
  if (fs.existsSync(lockPath)) throw new Error("recovered dead-owner lock was not releasable");
});

await check("file lock does not steal stale lock from a live pid", async () => {
  const lockPath = path.join(tmpDir, "locks", "live-stale.lock");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "live-owner", created_at: "old" }) + "\n");
  const old = (Date.now() - 60_000) / 1000;
  fs.utimesSync(lockPath, old, old);
  let timedOut = false;
  try {
    await runtime.acquireFileLock(lockPath, { timeoutMs: 80, staleMs: 1, retryMs: 10, label: "smoke-live" });
  } catch (err) {
    timedOut = /lock timeout/.test(String(err?.message || err));
  }
  if (!timedOut) throw new Error("expected live stale lock to be preserved until timeout");
  const raw = fs.readFileSync(lockPath, "utf-8");
  if (!raw.includes("live-owner")) throw new Error(`live lock should remain untouched: ${raw}`);
  fs.rmSync(lockPath, { force: true });
});

await check("file lock cleans up if record write fails before acquire returns", async () => {
  const fsp = await import("node:fs/promises");
  const protoProbe = path.join(tmpDir, "locks", "proto-write.tmp");
  fs.mkdirSync(path.dirname(protoProbe), { recursive: true });
  const probe = await fsp.open(protoProbe, "w");
  const proto = Object.getPrototypeOf(probe);
  await probe.close();
  fs.rmSync(protoProbe, { force: true });

  const originalWriteFile = proto.writeFile;
  let failNext = true;
  proto.writeFile = async function (...args) {
    if (failNext) {
      failNext = false;
      throw new Error("injected lock record write failure");
    }
    return originalWriteFile.apply(this, args);
  };

  const lockPath = path.join(tmpDir, "locks", "write-fails.lock");
  try {
    let threw = false;
    try {
      await runtime.acquireFileLock(lockPath, { timeoutMs: 500, staleMs: 30_000, retryMs: 10, label: "smoke-write-fail" });
    } catch (err) {
      threw = /injected lock record write failure/.test(String(err?.message || err));
    }
    if (!threw) throw new Error("expected injected write failure");
    if (fs.existsSync(lockPath)) throw new Error("failed acquisition must remove partial lock record immediately");
    const handle = await runtime.acquireFileLock(lockPath, { timeoutMs: 500, staleMs: 30_000, retryMs: 10, label: "smoke-write-fail" });
    await handle.release();
  } finally {
    proto.writeFile = originalWriteFile;
    fs.rmSync(lockPath, { force: true });
  }
});


fs.rmSync(tmpDir, { recursive: true, force: true });

console.log("");
if (failures.length === 0) {
  console.log(`all ok — strict active-project resolver holds (${total} assertions).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  for (const f of failures) console.log(` - ${f.name}: ${f.err.stack || f.err.message}`);
  process.exit(1);
}
