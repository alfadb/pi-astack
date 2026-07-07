#!/usr/bin/env node
/**
 * Smoke test: PR-9/P2a workflow DSL v1 validation (ADR 0032 §7).
 *
 * Locks every v1 boundary the 合议 pinned: schema_version, global id
 * uniqueness (children included), needs scope (top-level only, children
 * unaddressable), parallel aggregate-node constraints, tools whitelist +
 * dispatch-class HARD reject (§6 H5 软肋闭合), mutating ⇔ declaration ⇔
 * readOnly triple (W9, fail-not-strip), on_fail/max_retries bounds, DAG
 * cycle detection, W12 concurrency pre-check, and the dry-run report
 * (gate (b): plan presented to the user).
 */

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

const D = await jiti.import(`${repoRoot}/extensions/workflow/dsl.ts`);

const RO = { readOnly: true };
const RW = { readOnly: false };
const agent = (id, over = {}) => ({ id, kind: "agent", prompt: `do ${id}`, ...over });
const doc = (stages, over = {}) => ({ schema_version: 1, name: "t", stages, ...over });
const errsOf = (r) => r.errors.join("\n");

console.log("workflow DSL v1 — PR-9/P2a (ADR 0032 §7)");

await check("valid minimal: single agent stage; report shows plan", async () => {
  const r = D.validateWorkflow(doc([agent("a")]), RO);
  assert(r.ok, errsOf(r));
  assert(r.summary.order.join() === "a" && r.summary.estConcurrency === 1, JSON.stringify(r.summary));
  const report = D.formatDryRunReport(r, { readOnly: true, enabled: false });
  assert(report.includes("✓") && report.includes("plan:") && report.includes("peak concurrency (wave estimate): 1/4"), report);
  assert(report.includes("execution channel disabled"), "disabled-channel footer present");
});

await check("schema_version: unknown rejected; JSON parse errors structured", async () => {
  assert(!D.validateWorkflow(doc([agent("a")], { schema_version: 2 }), RO).ok, "v2 rejected");
  assert(!D.validateWorkflow(doc([agent("a")], { schema_version: "1" }), RO).ok, "string version rejected");
  assert(D.parseWorkflowJson("{not json").error.startsWith("invalid JSON"), "parse error structured");
  assert(D.parseWorkflowJson("[1,2]").error.includes("object"), "array root rejected");
});

await check("id rules: global uniqueness incl. children; format enforced", async () => {
  const r = D.validateWorkflow(doc([
    agent("a"),
    { id: "p", kind: "parallel", children: [agent("a")] },
  ]), RO);
  assert(!r.ok && errsOf(r).includes('duplicate id "a"'), errsOf(r));
  assert(!D.validateWorkflow(doc([agent("BAD ID")]), RO).ok, "id format enforced");
});

await check("needs: unknown rejected; child id unaddressable; self-ref rejected; cycle detected", async () => {
  assert(errsOf(D.validateWorkflow(doc([agent("a", { needs: ["nope"] })]), RO)).includes("unknown stage"), "unknown needs");
  const child = D.validateWorkflow(doc([
    { id: "p", kind: "parallel", children: [agent("c1")] },
    agent("b", { needs: ["c1"] }),
  ]), RO);
  assert(!child.ok && errsOf(child).includes("parallel CHILD"), errsOf(child));
  assert(errsOf(D.validateWorkflow(doc([agent("a", { needs: ["a"] })]), RO)).includes("needs itself"), "self-ref");
  const cyc = D.validateWorkflow(doc([agent("a", { needs: ["b"] }), agent("b", { needs: ["a"] })]), RO);
  assert(!cyc.ok && errsOf(cyc).includes("cycle"), errsOf(cyc));
});

await check("parallel aggregate node: children agent-only, no needs/nesting, no stage-level tools; on_fail on parent only", async () => {
  const bad = D.validateWorkflow(doc([{
    id: "p", kind: "parallel",
    children: [
      { id: "c1", kind: "parallel", prompt: "x", children: [agent("c2")] },
      agent("c3", { needs: ["c1"] }),
      agent("c4", { on_fail: "retry" }),
    ],
  }]), RO);
  const es = errsOf(bad);
  assert(es.includes("no nested parallel"), "nested parallel rejected");
  assert(es.includes("must not declare needs"), "child needs rejected");
  assert(es.includes("on_fail/max_retries live on the parallel stage"), "child on_fail rejected");
  const toolsOnParent = D.validateWorkflow(doc([{ id: "p", kind: "parallel", tools: ["read"], children: [agent("c1")] }]), RO);
  assert(errsOf(toolsOnParent).includes("must not carry tools"), "parent tools rejected");
  const empty = D.validateWorkflow(doc([{ id: "p", kind: "parallel", children: [] }]), RO);
  assert(errsOf(empty).includes("non-empty children"), "empty children rejected");
});

await check("H5 软肋闭合: dispatch-class tools HARD-rejected regardless of flags (ADR 0032 §6)", async () => {
  for (const t of ["dispatch_agent", "dispatch_parallel", "dispatch_parallel_subagent"]) {
    const r = D.validateWorkflow(doc([agent("a", { tools: [t], mutating: true })]), RW);
    assert(!r.ok && errsOf(r).includes("FORBIDDEN") && errsOf(r).includes("ADR 0030"), `${t}: ${errsOf(r)}`);
  }
  assert(errsOf(D.validateWorkflow(doc([agent("a", { tools: ["frobnicate"] })]), RO)).includes("unknown tool"), "unknown tool rejected");
});

await check("W9 triple: mutating tools require declaration; readOnly=true fails (never strips); RW + declared passes", async () => {
  const undeclared = D.validateWorkflow(doc([agent("a", { tools: ["write"] })]), RW);
  assert(!undeclared.ok && errsOf(undeclared).includes('"mutating": true'), errsOf(undeclared));
  const roViolation = D.validateWorkflow(doc([agent("a", { tools: ["write"], mutating: true })]), RO);
  assert(!roViolation.ok && errsOf(roViolation).includes("readOnly=true") && errsOf(roViolation).includes("never silently stripped"), errsOf(roViolation));
  const rw = D.validateWorkflow(doc([agent("a", { tools: ["write", "read"], mutating: true })]), RW);
  assert(rw.ok, errsOf(rw));
  assert(rw.summary.mutatingStages.join() === "a", "mutating stage surfaced in summary");
  const report = D.formatDryRunReport(rw, { readOnly: false, enabled: true });
  assert(report.includes("PI_MULTI_AGENT_ALLOW_MUTATING=1"), "runtime env requirement surfaced");
  const inert = D.validateWorkflow(doc([agent("a", { mutating: true })]), RW);
  assert(inert.ok && inert.warnings.some((w) => w.includes("inert")), "inert declaration warns");
});

await check("on_fail bounds: closed set; max_retries only with retry, [1,3]", async () => {
  assert(!D.validateWorkflow(doc([agent("a", { on_fail: "panic" })]), RO).ok, "closed set");
  assert(errsOf(D.validateWorkflow(doc([agent("a", { on_fail: "degrade", max_retries: 2 })]), RO)).includes("only valid with"), "max_retries needs retry");
  assert(!D.validateWorkflow(doc([agent("a", { on_fail: "retry", max_retries: 9 })]), RO).ok, "cap 3");
  assert(D.validateWorkflow(doc([agent("a", { on_fail: "retry", max_retries: 3 })]), RO).ok, "valid retry");
});

await check("taskProfile/profile: valid on agents incl. parallel children; invalid profile rejected", async () => {
  const valid = D.validateWorkflow(doc([
    agent("a", { taskProfile: "research" }),
    { id: "p", kind: "parallel", children: [agent("c1", { profile: "heavy" })] },
  ]), RO);
  assert(valid.ok, errsOf(valid));
  const invalidTop = D.validateWorkflow(doc([agent("a", { taskProfile: "unbounded" })]), RO);
  assert(!invalidTop.ok && errsOf(invalidTop).includes("taskProfile/profile"), errsOf(invalidTop));
  const invalidChild = D.validateWorkflow(doc([{ id: "p", kind: "parallel", children: [agent("c1", { profile: "unbounded" })] }]), RO);
  assert(!invalidChild.ok && errsOf(invalidChild).includes("taskProfile/profile"), errsOf(invalidChild));
});

await check("W12 concurrency pre-check: parallel+agent same wave fails; needs ordering fixes it; parallel children self-cap", async () => {
  const over = D.validateWorkflow(doc([
    { id: "p", kind: "parallel", children: [agent("c1"), agent("c2"), agent("c3"), agent("c4"), agent("c5")] },
    agent("a"),
  ]), RO);
  assert(!over.ok && errsOf(over).includes("W12"), errsOf(over)); // min(5,4)+1 = 5 > 4
  const ordered = D.validateWorkflow(doc([
    { id: "p", kind: "parallel", children: [agent("c1"), agent("c2"), agent("c3"), agent("c4"), agent("c5")] },
    agent("a", { needs: ["p"] }),
  ]), RO);
  assert(ordered.ok, errsOf(ordered)); // wave1: min(5,4)=4; wave2: 1
  assert(ordered.summary.estConcurrency === 4 && ordered.summary.levels.length === 2, JSON.stringify(ordered.summary));
});

await check("timeout bounds + stage caps", async () => {
  assert(!D.validateWorkflow(doc([agent("a")], { timeout_minutes: -1 }), RO).ok, "negative timeout");
  assert(!D.validateWorkflow(doc([agent("a")], { timeout_minutes: 100000 }), RO).ok, "timeout cap");
  assert(D.validateWorkflow(doc([agent("a")], { timeout_minutes: 90 }), RO).summary.timeoutMinutes === 90, "timeout recorded");
  const many = Array.from({ length: 33 }, (_, i) => agent(`s${i}`, { needs: i ? [`s${i - 1}`] : undefined }));
  assert(!D.validateWorkflow(doc(many), RO).ok, "stage cap 32");
});

await check("adversarial: case-variant tools normalized; control-char name sanitized; empty-string tool rejected; duplicate needs warns", async () => {
  const fb = D.validateWorkflow(doc([agent("a", { tools: ["Dispatch_Agent"] })]), RO);
  assert(!fb.ok && errsOf(fb).includes("FORBIDDEN"), `case-variant forbidden hits FORBIDDEN message: ${errsOf(fb)}`);
  const mb = D.validateWorkflow(doc([agent("a", { tools: ["BASH"] })]), RW);
  assert(!mb.ok && errsOf(mb).includes('"mutating": true'), `case-variant mutating hits declaration message: ${errsOf(mb)}`);
  const rd = D.validateWorkflow(doc([agent("a", { tools: ["Read"] })]), RO);
  assert(rd.ok, `case-variant readonly passes: ${errsOf(rd)}`);
  const empty = D.validateWorkflow(doc([agent("a", { tools: ["read", ""] })]), RO);
  assert(!empty.ok && errsOf(empty).includes("unknown tool"), "empty-string tool rejected");
  const evil = D.validateWorkflow(doc([agent("a")], { name: "x\n\u0007evil" }), RO);
  assert(evil.ok, errsOf(evil));
  const report = D.formatDryRunReport(evil, { readOnly: true, enabled: false });
  assert(!report.includes("\u0007") && !report.includes('"x\n'), `name sanitized in report: ${JSON.stringify(report.slice(0, 60))}`);
  const dup = D.validateWorkflow(doc([agent("a"), agent("b", { needs: ["a", "a"] })]), RO);
  assert(dup.ok && dup.warnings.some((w) => w.includes("duplicate needs")), "duplicate needs warns");
});

await check("timeout integer required (0.5 rejected, not floored to 0)", async () => {
  assert(!D.validateWorkflow(doc([agent("a")], { timeout_minutes: 0.5 }), RO).ok, "fractional rejected");
});

await check("dry-run report failure mode lists all errors", async () => {
  const r = D.validateWorkflow(doc([agent("a", { tools: ["dispatch_agent"] }), agent("a")], { schema_version: 7 }), RO);
  const report = D.formatDryRunReport(r, { readOnly: true, enabled: false });
  assert(report.startsWith("✗") && report.includes("schema_version") && report.includes("duplicate") && report.includes("FORBIDDEN"), report);
});

console.log(failures.length === 0
  ? `PASS — ${total} checks (workflow DSL).`
  : `FAIL — ${failures.length}/${total} checks failed.`);
process.exit(failures.length === 0 ? 0 : 1);
