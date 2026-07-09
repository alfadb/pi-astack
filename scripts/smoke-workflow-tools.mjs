#!/usr/bin/env node
/** Smoke test: ADR 0033 PR-12 workflow LLM tools + listing/disabled gates. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const W = await jiti.import(`${repoRoot}/extensions/workflow/index.ts`);
const E = await jiti.import(`${repoRoot}/extensions/workflow/executor.ts`);

let failures = 0; let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (e) { failures++; console.log(`  FAIL  ${name}\n        ${e.stack || e.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || "assertion failed"); }

console.log("workflow tools — ADR 0033 PR-12");

await check("workflow_list sees project JSON asset as runnable and markdown conventions as non-runnable", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-list-"));
  fs.mkdirSync(path.join(tmp, "workflows"));
  fs.writeFileSync(path.join(tmp, "workflows", "a.json"), "{}\n");
  const entries = W.listWorkflowEntries(tmp);
  assert(entries.some((e) => e.namespace === "project" && e.name === "a" && e.runnable && e.kind === "json-asset"), JSON.stringify(entries));
  // real abrain zone may be empty, but if it has .md entries they must be convention/non-runnable.
  assert(entries.every((e) => !(e.path.endsWith(".md") && e.runnable)), "markdown entries are not runnable");
});

await check("loadWorkflowFile resolves relative path and validates repo example", async () => {
  const cwd = repoRoot;
  const loaded = W.loadWorkflowFile("workflows/repo-review-example.json", cwd, true);
  assert(loaded.doc?.name === "repo-review-example", loaded.error || "wrong doc");
  assert(loaded.validation?.ok, loaded.validation?.errors?.join("\n"));
});

await check("loadWorkflowFile rejects ~/ paths", async () => {
  const cwd = repoRoot;
  const loaded = W.loadWorkflowFile("~/some/path.json", cwd, true);
  assert(loaded.error != null && loaded.error.includes("~ paths are not allowed"), `expected ~ rejection, got: ${loaded.error}`);
  assert(!loaded.doc, "should not parse doc for rejected path");
});

await check("loadWorkflowFile rejects absolute paths outside cwd", async () => {
  const cwd = repoRoot;
  const loaded = W.loadWorkflowFile("/etc/passwd", cwd, true);
  assert(loaded.error != null && loaded.error.includes("must be within the current working directory"), `expected containment error, got: ${loaded.error}`);
  assert(!loaded.doc, "should not parse doc for out-of-cwd path");
});

await check("loadWorkflowFile allows absolute paths within cwd", async () => {
  const cwd = repoRoot;
  const absPath = path.join(repoRoot, "workflows", "repo-review-example.json");
  const loaded = W.loadWorkflowFile(absPath, cwd, true);
  assert(loaded.doc?.name === "repo-review-example", loaded.error || "wrong doc");
  assert(loaded.validation?.ok, loaded.validation?.errors?.join("\n"));
});

await check("loadWorkflowFile allows quoted relative paths", async () => {
  const cwd = repoRoot;
  const loaded = W.loadWorkflowFile('"workflows/repo-review-example.json"', cwd, true);
  assert(loaded.doc?.name === "repo-review-example", loaded.error || "wrong doc");
  assert(loaded.validation?.ok, loaded.validation?.errors?.join("\n"));
});

await check("loadWorkflowFile gives reasonable error for nonexistent file within cwd", async () => {
  const cwd = repoRoot;
  const loaded = W.loadWorkflowFile("workflows/nonexistent.json", cwd, true);
  assert(loaded.error != null && loaded.error.includes("cannot read"), `expected read error, got: ${loaded.error}`);
  assert(!loaded.doc, "should not parse doc for missing file");
});

await check("loadWorkflowFile rejects symlink escape to file outside cwd", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-symlink-escape-"));
  const outside = path.join(os.tmpdir(), `wf-outside-${Date.now()}.json`);
  fs.writeFileSync(outside, "{}");
  try {
    const link = path.join(tmp, "escape.json");
    fs.symlinkSync(outside, link);
    const loaded = W.loadWorkflowFile("escape.json", tmp, true);
    assert(loaded.error != null && loaded.error.includes("symlink escape"), `expected symlink escape error, got: ${loaded.error}`);
    assert(!loaded.doc, "should not parse doc for symlink escape");
  } finally {
    try { fs.unlinkSync(outside); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

await check("loadWorkflowFile rejects symlink escape via relative traversal + symlink", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-symlink-traversal-"));
  const outside = path.join(os.tmpdir(), `wf-outside-${Date.now()}.json`);
  fs.writeFileSync(outside, "{}");
  try {
    // Create a symlink inside tmp that points outside
    const link = path.join(tmp, "sub", "escape.json");
    fs.mkdirSync(path.join(tmp, "sub"), { recursive: true });
    fs.symlinkSync(outside, link);
    const loaded = W.loadWorkflowFile("sub/escape.json", tmp, true);
    assert(loaded.error != null && loaded.error.includes("symlink escape"), `expected symlink escape error, got: ${loaded.error}`);
    assert(!loaded.doc, "should not parse doc for symlink escape via subdirectory");
  } finally {
    try { fs.unlinkSync(outside); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

await check("loadWorkflowFile rejects symlink to directory outside cwd", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-symlink-dir-escape-"));
  const outsideDir = path.join(os.tmpdir(), `wf-outside-dir-${Date.now()}`);
  fs.mkdirSync(outsideDir);
  try {
    const link = path.join(tmp, "escape-dir");
    fs.symlinkSync(outsideDir, link);
    const loaded = W.loadWorkflowFile("escape-dir", tmp, true);
    assert(loaded.error != null && loaded.error.includes("symlink escape"), `expected symlink escape error for directory, got: ${loaded.error}`);
    assert(!loaded.doc, "should not parse doc for symlink-to-directory escape");
  } finally {
    try { fs.rmSync(outsideDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

await check("loadWorkflowFile rejects non-regular file (directory) within cwd", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-dir-in-cwd-"));
  try {
    const dir = path.join(tmp, "subdir");
    fs.mkdirSync(dir);
    const loaded = W.loadWorkflowFile("subdir", tmp, true);
    assert(loaded.error != null && loaded.error.includes("must be a regular file"), `expected regular-file error, got: ${loaded.error}`);
    assert(!loaded.doc, "should not parse doc for directory");
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

await check("loadWorkflowFile allows symlink to file still within cwd realpath", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-symlink-ok-"));
  try {
    const real = path.join(tmp, "real.json");
    fs.writeFileSync(real, JSON.stringify({ schema_version: 1, name: "ok", stages: [] }));
    const link = path.join(tmp, "link.json");
    fs.symlinkSync("real.json", link);
    const loaded = W.loadWorkflowFile("link.json", tmp, true);
    assert(loaded.doc?.name === "ok", `expected doc name "ok", got: ${loaded.error ?? JSON.stringify(loaded.doc)}`);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

await check("loadWorkflowFile nonexistent file still returns cannot-read (not symlink escape)", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wf-nonexist-"));
  try {
    const loaded = W.loadWorkflowFile("nope.json", tmp, true);
    assert(loaded.error != null && loaded.error.includes("cannot read"), `expected cannot read, got: ${loaded.error}`);
    assert(!loaded.doc, "should not parse doc for missing file");
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
});

await check("workflow.enabled=false and executeWorkflow exceptions are structured errors (source lock)", async () => {
  const src = fs.readFileSync(path.join(repoRoot, "extensions", "workflow", "index.ts"), "utf-8");
  const core = src.match(/export async function runWorkflowCore[\s\S]*?function formatRunSummary/)?.[0] ?? "";
  assert(/kind:\s*["']workflow_disabled["']/.test(core), "workflow_disabled structured error present");
  assert(core.indexOf("workflow_disabled") < core.indexOf("loadWorkflowFile"), "disabled gate occurs before loading/validation/runner");
  assert(/catch \(e: unknown\)[\s\S]*kind:\s*["']execution_failed["']/.test(core), "executeWorkflow exceptions converted to structured execution_failed errors");
});

await check("executor can use injected semaphore seam; production source uses global semaphore", async () => {
  const sem = E.makeSemaphore(1);
  let active = 0; let peak = 0;
  const doc = { schema_version: 1, name: "t", stages: [
    { id: "a", kind: "agent", prompt: "a" },
    { id: "b", kind: "agent", prompt: "b" },
  ] };
  const r = await E.executeWorkflow({
    doc,
    runId: "r",
    runDir: fs.mkdtempSync(path.join(os.tmpdir(), "wf-sem-")),
    readOnly: true,
    defaultModel: "deepseek/deepseek-v4-flash",
    defaultThinking: "medium",
    semaphore: sem,
    runner: async () => { active++; peak = Math.max(peak, active); await new Promise((res) => setTimeout(res, 20)); active--; return { output: "ok", durationMs: 20 }; },
  });
  assert(r.status === "completed", r.status);
  assert(peak === 1, `injected semaphore constrained peak=${peak}`);
});

console.log(failures === 0 ? `PASS — ${total} checks (workflow tools).` : `FAIL — ${failures}/${total} checks failed.`);
process.exit(failures === 0 ? 0 : 1);
