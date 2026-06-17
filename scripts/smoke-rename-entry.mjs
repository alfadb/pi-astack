#!/usr/bin/env node
/**
 * A3 rename-on-update deterministic smoke: scope-aware mapper + preflight.
 */
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  rewriteWikilinkInnerForRename,
  rewriteMarkdownForRename,
  findPreexistingBareNewSlugRefs,
  frontmatterScopeMatchesFileScope,
  basicRenamePreflight,
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

console.log(`\nPASS ${pass} / ${pass}`);
