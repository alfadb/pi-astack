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
  const r = await X.runEvidenceCmd("false", { cwd });
  assert(r.exit !== 0 && r.status === "failed", `failed (exit=${r.exit})`);
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
  fs.writeFileSync(path.join(cwd, "big-output.mjs"), 'process.stdout.write("x".repeat(100000));\n');
  const r = await X.runEvidenceCmd("node big-output.mjs", { cwd, maxOutputBytes: 1024 });
  assert(r.truncated === true, "truncated set");
  assert(typeof r.stdout_sha === "string", "still hashed");
});

await check("dangerous-command guard blocks shell overreach and destructive shapes (default on)", async () => {
  // common simple evidence commands stay allowed
  assert(X.isDangerousCommand("npm run smoke:goal-evidence") === false, "npm run allowed");
  assert(X.isDangerousCommand("rg pattern file") === false, "rg allowed");
  assert(X.isDangerousCommand("node scripts/foo.mjs") === false, "node script allowed");
  assert(X.isDangerousCommand("git rev-parse HEAD") === false, "git allowed");
  assert(X.isDangerousCommand("rm -rf ./build") === false, "scoped rm allowed");

  // interpreter inline code
  assert(X.isDangerousCommand("node -e 'process.exit(3)'") === true, "node -e rejected");
  assert(X.isDangerousCommand("node --eval 'process.exit(3)'") === true, "node --eval rejected");
  assert(X.isDangerousCommand("node --eval=process.exit(3)") === true, "node --eval= rejected");
  assert(X.isDangerousCommand("node -p '1 + 1'") === true, "node -p rejected");
  assert(X.isDangerousCommand("node --print '1 + 1'") === true, "node --print rejected");
  assert(X.isDangerousCommand("node -pe '1 + 1'") === true, "node -pe rejected");
  assert(X.isDangerousCommand("python -c 'print(1)'") === true, "python -c rejected");
  assert(X.isDangerousCommand("python3 -c 'print(1)'") === true, "python3 -c rejected");
  assert(X.isDangerousCommand("python3.12 -c 'print(1)'") === true, "python3.12 -c rejected");
  assert(X.isDangerousCommand("perl -e 'print 1'") === true, "perl -e rejected");
  assert(X.isDangerousCommand("perl -e'print 1'") === true, "perl -e... rejected");
  assert(X.isDangerousCommand("ruby -e 'puts 1'") === true, "ruby -e rejected");
  assert(X.isDangerousCommand("php -r 'echo 1;'") === true, "php -r rejected");
  assert(X.isDangerousCommand("FOO=bar node -e 'process.exit(0)'") === true, "env-prefixed node -e rejected");

  // shell chaining / substitution / expansion
  assert(X.isDangerousCommand("cmd1 && cmd2") === true, "&& rejected");
  assert(X.isDangerousCommand("cmd1; cmd2") === true, "; rejected");
  assert(X.isDangerousCommand("cmd1 | cmd2") === true, "| rejected");
  assert(X.isDangerousCommand("cmd1 || cmd2") === true, "|| rejected");
  assert(X.isDangerousCommand("echo $(whoami)") === true, "$() rejected");
  assert(X.isDangerousCommand("echo `whoami`") === true, "backtick rejected");
  assert(X.isDangerousCommand("echo $HOME") === true, "$HOME rejected");
  assert(X.isDangerousCommand("sh -c 'exit 0'") === true, "sh -c rejected");

  // sensitive reads and network exfil
  assert(X.isDangerousCommand("cat ~/.ssh/id_rsa") === true, "~/.ssh rejected");
  assert(X.isDangerousCommand("cat ~/.abrain/ledger.json") === true, "~/.abrain rejected");
  assert(X.isDangerousCommand("cat .env") === true, "bare .env rejected");
  assert(X.isDangerousCommand("cat .env.local") === true, "bare .env.local rejected");
  assert(X.isDangerousCommand("cat .abrain/ledger.json") === true, "bare .abrain rejected");
  assert(X.isDangerousCommand("cat ../.ssh/id_rsa") === true, "parent-relative .ssh rejected");
  assert(X.isDangerousCommand("cat /tmp/.aws/credentials") === true, "absolute .aws rejected");
  assert(X.isDangerousCommand("curl https://example.com") === true, "curl rejected");
  assert(X.isDangerousCommand("/usr/bin/curl https://example.com") === true, "/usr/bin/curl rejected");
  assert(X.isDangerousCommand("./curl https://example.com") === true, "./curl rejected");
  assert(X.isDangerousCommand("FOO=bar curl https://example.com") === true, "env-prefixed curl rejected");
  assert(X.isDangerousCommand("env curl https://example.com") === true, "env wrapper rejected");
  assert(X.isDangerousCommand("wget -qO- x") === true, "wget rejected");

  // destructive ops
  assert(X.isDangerousCommand("rm -rf / --no-preserve-root") === true, "rm -rf / rejected");
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
  await g("git init -q");
  await g("git config user.email t@t");
  await g("git config user.name t");
  fs.writeFileSync(path.join(repo, "f.txt"), "hi");
  await g("git add -A");
  await g("git commit -q -m x");
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
