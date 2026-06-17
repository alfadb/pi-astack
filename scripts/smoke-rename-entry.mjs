#!/usr/bin/env node
/**
 * A3 rename-on-update deterministic smoke: scope-aware mapper + preflight.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);

const jiti = createJiti(import.meta.url);
const {
  rewriteWikilinkInnerForRename,
  rewriteMarkdownForRename,
  findPreexistingBareNewSlugRefs,
  frontmatterScopeMatchesFileScope,
  basicRenamePreflight,
  applyRenamePlan,
  rollbackRenameTransaction,
} = jiti("../extensions/memory/rename-entry.ts");

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const target = { scope: "project", projectId: "p", oldSlug: "old-slug", newSlug: "new-slug" };
const pScope = { scope: "project", projectId: "p" };
const qScope = { scope: "project", projectId: "q" };
const worldScope = { scope: "world" };

let pass = 0;
function test(name, fn) {
  fn();
  pass++;
  console.log(`ok ${pass} - ${name}`);
}

async function testAsync(name, fn) {
  await fn();
  pass++;
  console.log(`ok ${pass} - ${name}`);
}

async function git(root, args) {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], { timeout: 10_000, maxBuffer: 1024 * 1024 });
  return String(stdout).trim();
}

async function initRenameRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rename-entry-"));
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "smoke@example.invalid"]);
  await git(root, ["config", "user.name", "rename smoke"]);
  await fs.mkdir(path.join(root, "projects", "p", "decisions"), { recursive: true });
  await fs.mkdir(path.join(root, "knowledge"), { recursive: true });
  const oldPath = path.join(root, "projects", "p", "decisions", "old-slug.md");
  const newPath = path.join(root, "projects", "p", "decisions", "new-slug.md");
  const refPath = path.join(root, "knowledge", "ref.md");
  await fs.writeFile(oldPath, "---\nid: project:p:old-slug\nscope: project\n---\n# Old\n", "utf-8");
  await fs.writeFile(refPath, "---\nscope: world\n---\nSee [[project:p:old-slug]].\n", "utf-8");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "base"]);
  const baseHead = await git(root, ["rev-parse", "HEAD"]);
  const plan = {
    target,
    baseHead,
    entryOldPath: oldPath,
    entryNewPath: newPath,
    entryNewContent: "---\nid: project:p:new-slug\nscope: project\n---\n# New\n",
    expectedNewId: "project:p:new-slug",
    fileChanges: [{ path: refPath, newContent: "---\nscope: world\n---\nSee [[project:p:new-slug]].\n" }],
    vectorStaleSlugs: ["old-slug", "new-slug"],
  };
  return { root, oldPath, newPath, refPath, plan };
}

test("basic preflight rejects empty/same slug", () => {
  assert(basicRenamePreflight({ ...target, newSlug: "!!!" }).some((i) => i.code === "invalid_new_slug"), "empty newSlug should be invalid");
  assert(basicRenamePreflight({ ...target, newSlug: "old slug" }).some((i) => i.code === "same_slug"), "same slug should be rejected");
});

test("scope table: bare rewrites only inside owning project", () => {
  assert(rewriteWikilinkInnerForRename("old-slug", pScope, target) === "new-slug", "P bare old should rewrite");
  assert(rewriteWikilinkInnerForRename("old-slug", qScope, target) === null, "Q bare old must not rewrite");
  assert(rewriteWikilinkInnerForRename("old-slug", worldScope, target) === null, "world bare old must not rewrite");
});

test("scope table: qualified project:P rewrites everywhere, project:Q/world do not", () => {
  assert(rewriteWikilinkInnerForRename("project:p:old-slug", qScope, target) === "project:p:new-slug", "qualified P old should rewrite in Q");
  assert(rewriteWikilinkInnerForRename("project:p:old-slug", worldScope, target) === "project:p:new-slug", "qualified P old should rewrite in world");
  assert(rewriteWikilinkInnerForRename("project:q:old-slug", pScope, target) === null, "qualified Q old must not rewrite");
  assert(rewriteWikilinkInnerForRename("world:old-slug", pScope, target) === null, "world old must not rewrite");
});

test("wikilink aliases and anchors are preserved", () => {
  assert(rewriteWikilinkInnerForRename("old-slug|label", pScope, target) === "new-slug|label", "alias should be preserved");
  assert(rewriteWikilinkInnerForRename("old-slug#part|label", pScope, target) === "new-slug#part|label", "anchor+alias should be preserved");
  assert(rewriteWikilinkInnerForRename("project:p:old-slug#part|label", qScope, target) === "project:p:new-slug#part|label", "qualified anchor+alias should be preserved");
  assert(rewriteWikilinkInnerForRename("path/to/old-slug.md#part|label", pScope, target) === "new-slug#part|label", "path/.md form should canonicalize slug but preserve suffix");
});

test("body rewrite skips code spans and fences", () => {
  const raw = "---\nscope: project\n---\nA [[old-slug]] `[[old-slug]]`\n```\n[[old-slug]]\n```\nB [[project:p:old-slug|P]]";
  const r = rewriteMarkdownForRename(raw, pScope, target);
  assert(r.content.includes("A [[new-slug]] `[[old-slug]]`"), "inline code should not rewrite");
  assert(r.content.includes("```\n[[old-slug]]\n```"), "fenced code should not rewrite");
  assert(r.content.includes("B [[project:p:new-slug|P]]"), "qualified body link should rewrite");
  assert(r.changes.length === 2, `expected 2 body changes, got ${r.changes.length}`);
});

test("frontmatter relation scalar and block list rewrite", () => {
  const raw = "---\nscope: project\nderives_from:\n  - old-slug\n  - project:p:old-slug\n  - project:q:old-slug\nrelates_to: \"old-slug\"\n---\nBody";
  const r = rewriteMarkdownForRename(raw, pScope, target);
  assert(r.content.includes("  - new-slug"), "bare relation list item should rewrite");
  assert(r.content.includes("  - project:p:new-slug"), "qualified relation list item should rewrite");
  assert(r.content.includes("  - project:q:old-slug"), "other project relation must not rewrite");
  assert(r.content.includes('relates_to: "new-slug"'), "quoted scalar relation should preserve quotes");
});

test("inline relation list is rejected if it mentions old/new slug", () => {
  const raw = "---\nscope: project\nderives_from: [old-slug, other]\n---\nBody";
  const r = rewriteMarkdownForRename(raw, pScope, target);
  assert(r.issues.some((i) => i.code === "unsupported_inline_relation"), `expected unsupported_inline_relation, got ${JSON.stringify(r.issues)}`);
  assert(r.content.includes("derives_from: [old-slug, other]"), "unsupported inline relation should not be silently changed");
});

test("preexisting bare newSlug refs are detected in owning project", () => {
  const raw = "---\nscope: project\nrelates_to: new-slug\n---\nAlready [[new-slug]] before rename. `[[new-slug]]`";
  const issues = findPreexistingBareNewSlugRefs(raw, pScope, target);
  assert(issues.filter((i) => i.code === "preexisting_newslug_bare_ref").length === 2, `expected body+relation preexisting newSlug refs, got ${JSON.stringify(issues)}`);
  assert(findPreexistingBareNewSlugRefs(raw, qScope, target).length === 0, "Q scope should not flag P preexisting newSlug refs");
});

test("frontmatter scope mismatch is rejected", () => {
  const issues = frontmatterScopeMatchesFileScope("scope: world\ntitle: bad", pScope);
  assert(issues.some((i) => i.code === "scope_mismatch"), "project file declaring world scope should be rejected");
  assert(frontmatterScopeMatchesFileScope("scope: project\ntitle: ok", pScope).length === 0, "matching project scope should pass");
});

await testAsync("transaction apply succeeds with single commit and removes marker", async () => {
  const { root, oldPath, newPath, refPath, plan } = await initRenameRepo();
  const markerPath = path.join(root, ".state", "sediment", "rename-transaction.json");
  try {
    await applyRenamePlan(plan, { abrainHome: root, markerPath, commitMessage: "rename old-slug to new-slug" });
    assert(await fs.stat(newPath).then(() => true, () => false), "new path should exist after successful apply");
    assert(!(await fs.stat(oldPath).then(() => true, () => false)), "old path should be removed after successful apply");
    assert((await fs.readFile(refPath, "utf-8")).includes("[[project:p:new-slug]]"), "ref file should be rewritten to new slug");
    assert(!(await fs.stat(markerPath).then(() => true, () => false)), "marker should be removed after successful apply");
    assert((await git(root, ["status", "--porcelain"])) === "", "repo should be clean after successful apply");
    assert((await git(root, ["log", "--oneline", "-1"])).includes("rename old-slug to new-slug"), "rename commit should be created");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await testAsync("transaction marker-only crash rolls back on next lock", async () => {
  const { root, oldPath, newPath, refPath, plan } = await initRenameRepo();
  const markerPath = path.join(root, ".state", "sediment", "rename-transaction.json");
  try {
    let threw = false;
    try {
      await applyRenamePlan(plan, { abrainHome: root, markerPath, failAfterStep: "marker" });
    } catch {
      threw = true;
    }
    assert(threw, "injected marker failure should throw");
    assert(await fs.stat(markerPath).then(() => true, () => false), "marker should remain after marker-only crash");
    const rb = await rollbackRenameTransaction(root, markerPath);
    assert(rb.didRollback === true && rb.vectorStaleSlugs.includes("old-slug") && rb.vectorStaleSlugs.includes("new-slug"), `rollback should report stale slugs, got ${JSON.stringify(rb)}`);
    assert(await fs.stat(oldPath).then(() => true, () => false), "old path should remain after marker-only rollback");
    assert(!(await fs.stat(newPath).then(() => true, () => false)), "new path should not exist after marker-only rollback");
    assert((await fs.readFile(refPath, "utf-8")).includes("[[project:p:old-slug]]"), "ref file should remain old after marker-only rollback");
    assert(!(await fs.stat(markerPath).then(() => true, () => false)), "marker should be deleted after rollback");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

await testAsync("transaction failure after vector step auto-rolls back files and marker", async () => {
  const { root, oldPath, newPath, refPath, plan } = await initRenameRepo();
  const markerPath = path.join(root, ".state", "sediment", "rename-transaction.json");
  let vectorTouched = false;
  try {
    let threw = false;
    try {
      await applyRenamePlan(plan, {
        abrainHome: root,
        markerPath,
        failAfterStep: "vector",
        onVectorRename: () => { vectorTouched = true; },
      });
    } catch {
      threw = true;
    }
    assert(threw && vectorTouched, "injected vector failure should throw after vector hook");
    assert(await fs.stat(oldPath).then(() => true, () => false), "old path should be restored after vector-step failure");
    assert(!(await fs.stat(newPath).then(() => true, () => false)), "new path should be removed after vector-step rollback");
    assert((await fs.readFile(refPath, "utf-8")).includes("[[project:p:old-slug]]"), "ref file should be restored after vector-step rollback");
    assert(!(await fs.stat(markerPath).then(() => true, () => false)), "marker should be deleted after auto rollback");
    assert((await git(root, ["status", "--porcelain"])) === "", "repo should be clean after vector-step rollback");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

console.log(`\nPASS ${pass} / ${pass}`);
