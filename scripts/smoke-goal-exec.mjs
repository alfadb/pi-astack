#!/usr/bin/env node
/**
 * Smoke: goal v1 evidence executor (extensions/goal/exec.ts, G3).
 * Runs REAL child processes — exit-code, timeout, guard, file facts.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti/static";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url, { moduleCache: false });

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try { await fn(); console.log(`  ok    ${name}`); }
  catch (err) { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.stack || err.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const X = await jiti.import(`${repoRoot}/extensions/goal/exec.ts`);
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-exec-"));

console.log("goal v1 — evidence executor (real spawn)");

await check("exit 0 -> verified, with output sha + duration", async () => {
  const r = await X.runEvidenceCmd("printf hello", { cwd });
  assert(r.exit === 0 && r.status === "verified", `verified (exit=${r.exit})`);
  assert(typeof r.stdout_sha === "string" && r.stdout_sha.length === 16, "stdout_sha recorded");
  assert(typeof r.duration_ms === "number", "duration recorded");
  assert(r.timed_out === false && r.truncated === false, "no timeout/trunc");
});

await check("exit non-zero -> failed", async () => {
  const r = await X.runEvidenceCmd("sh -c 'exit 3'", { cwd });
  assert(r.exit === 3 && r.status === "failed", `failed (exit=${r.exit})`);
});

await check("deterministic stdout sha for same output", async () => {
  const a = await X.runEvidenceCmd("printf abc123", { cwd });
  const b = await X.runEvidenceCmd("printf abc123", { cwd });
  assert(a.stdout_sha === b.stdout_sha, "same output -> same sha");
  const c = await X.runEvidenceCmd("printf different", { cwd });
  assert(c.stdout_sha !== a.stdout_sha, "different output -> different sha");
});

await check("timeout kills and marks timed_out=failed", async () => {
  const r = await X.runEvidenceCmd("sleep 5", { cwd, timeoutMs: 300 });
  assert(r.timed_out === true && r.status === "failed", `timed out (timed_out=${r.timed_out})`);
  assert(r.exit === -1, "exit -1 on timeout");
});

await check("output cap -> truncated flag, still hashes", async () => {
  const r = await X.runEvidenceCmd("sh -c 'yes x | head -c 100000'", { cwd, maxOutputBytes: 1024 });
  assert(r.truncated === true, "truncated set");
  assert(typeof r.stdout_sha === "string", "still hashed");
});

await check("dangerous-command guard blocks rm -rf / (default on)", async () => {
  assert(X.isDangerousCommand("rm -rf / --no-preserve-root") === true, "classifier flags rm -rf /");
  assert(X.isDangerousCommand("npm run smoke:goal-evidence") === false, "normal cmd allowed");
  assert(X.isDangerousCommand("rm -rf ./build") === false, "scoped rm allowed");
  const r = await X.runEvidenceCmd("rm -rf / ", { cwd });
  assert(r.status === "failed" && /guard/.test(r.reason || ""), "guard blocks at run");
  const forced = await X.runEvidenceCmd("true", { cwd, guardDangerous: false });
  assert(forced.status === "verified", "override path still works");
});

await check("resolveFileFacts + fileContentSha", async () => {
  const fp = path.join(cwd, "a.txt");
  assert(X.resolveFileFacts("a.txt", cwd).exists === false, "missing -> exists:false");
  fs.writeFileSync(fp, "content-1");
  const f = X.resolveFileFacts("a.txt", cwd);
  assert(f.exists === true && f.size === 9 && typeof f.content_sha === "string", "facts present");
  const sha1 = X.fileContentSha("a.txt", cwd);
  fs.writeFileSync(fp, "content-2-changed");
  assert(X.fileContentSha("a.txt", cwd) !== sha1, "content change -> sha change (feeds G6)");
  assert(X.fileContentSha("nope.txt", cwd) === undefined, "missing -> undefined");
});

await check("git evidence: cat-file -e verifies a real object, fails on bogus", async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "pi-goal-git-"));
  const g = async (c) => X.runEvidenceCmd(c, { cwd: repo });
  await g("git init -q && git config user.email t@t && git config user.name t");
  fs.writeFileSync(path.join(repo, "f.txt"), "hi");
  await g("git add -A && git commit -q -m x");
  const head = await g("git rev-parse HEAD");
  assert(head.exit === 0, "got a commit");
  const ok = await g("git cat-file -e HEAD");
  assert(ok.status === "verified", "HEAD object exists -> verified");
  const bad = await g("git cat-file -e deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
  assert(bad.status === "failed", "bogus sha -> failed");
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (goal exec).`
  : `FAIL — ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
