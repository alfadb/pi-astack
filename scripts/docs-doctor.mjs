#!/usr/bin/env node
/**
 * docs-doctor — P0 hygiene checker for the human↔abrain consensus layer.
 *
 * Charter: docs/README.md. This script enforces the machine-checkable half of
 * "docs are a consensus surface, not a code mirror". It is the guardrail that
 * every Phase-2 migration step is validated against (see docs/roadmap.md).
 *
 * Severity model (intentional during the Phase-2 migration window):
 *   ERROR (exit 1):
 *     - relative .md / asset link points at a missing file
 *     - duplicate `canonical_for` across two active canonical docs
 *   WARN (exit 0, reported):
 *     - link points at a missing #anchor in an existing .md target
 *     - bare git commit hash embedded in a canonical doc body (REQ-006)
 *     - canonical doc hardcodes an extension/tool COUNT (code-mirror smell)
 *     - canonical doc missing frontmatter (advisory until split lands)
 *
 * Once the migration completes, anchor + frontmatter WARN tiers can be promoted
 * to ERROR by flipping STRICT=1 (env) — see roadmap Phase-2 close-out.
 *
 * No external deps. Node >= 18.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const docsRoot = path.join(repoRoot, "docs");
const STRICT = process.env.STRICT === "1";

// Canonical scope: top-level docs + these subtrees. Everything else under docs/
// (archive/, audits/, notes/) is explicitly OUT of the consensus surface.
const CANONICAL_SUBDIRS = ["adr", "architecture", "reference", "migration"];
const EXCLUDED_SUBDIRS = new Set(["archive", "audits", "notes"]);

const errors = [];
const warns = [];        // strictable: promoted to ERROR under STRICT=1
const softWarns = [];    // advisory ALWAYS (never promoted) — e.g. REQ-006 hash/count
                         // inside non-consensus docs (ADR pending-ingest mechanism
                         // bodies legitimately cite commit evidence per adr/README §0).
const err = (file, msg) => errors.push(`${rel(file)}: ${msg}`);
const warn = (file, msg) => warns.push(`${rel(file)}: ${msg}`);
const softWarn = (file, msg) => softWarns.push(`${rel(file)}: ${msg}`);
const rel = (p) => path.relative(repoRoot, p);

function listCanonicalDocs() {
  const out = [];
  // top-level docs/*.md
  for (const name of fs.readdirSync(docsRoot)) {
    const full = path.join(docsRoot, name);
    const st = fs.statSync(full);
    if (st.isFile() && name.endsWith(".md")) out.push(full);
  }
  // selected subtrees (recursive)
  for (const sub of CANONICAL_SUBDIRS) {
    const dir = path.join(docsRoot, sub);
    if (!fs.existsSync(dir)) continue;
    walk(dir, out);
  }
  return out.sort();
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (EXCLUDED_SUBDIRS.has(name)) continue;
      walk(full, out);
    } else if (name.endsWith(".md")) {
      out.push(full);
    }
  }
}

// --- frontmatter -----------------------------------------------------------
function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 4);
  if (end === -1) return null;
  const block = text.slice(4, end);
  const fm = {};
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

// --- GitHub-ish heading slug ----------------------------------------------
function slugify(heading) {
  // Mirror github-slugger: strip markdown emphasis/backticks, remove punctuation
  // in place (no space inserted), then map EACH remaining space to one hyphen
  // (GitHub does NOT collapse consecutive hyphens left by removed punctuation).
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*~]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function headingSlugs(text) {
  const slugs = new Set();
  const counts = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*$/);
    if (!m) continue;
    let s = slugify(m[1]);
    if (counts.has(s)) {
      const n = counts.get(s) + 1;
      counts.set(s, n);
      s = `${s}-${n}`;
    } else {
      counts.set(s, 0);
    }
    slugs.add(s);
  }
  return slugs;
}

// strip fenced code blocks so prose-only checks don't fire inside code
function stripCodeFences(text) {
  return text.replace(/```[\s\S]*?```/g, (b) => b.replace(/[^\n]/g, " "));
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

// --- checks ----------------------------------------------------------------
const LINK_RE = /\[[^\]]*\]\(([^)]+)\)/g;
const COMMIT_RE = /\b(?=[0-9a-f]*[0-9])(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
const EXT_COUNT_RE = /(\d+)\s*(?:个|个独立的)?\s*(?:extension|extensions|扩展|tool|tools|工具)\b/gi;

const anchorCache = new Map();
function anchorsFor(file) {
  if (anchorCache.has(file)) return anchorCache.get(file);
  let slugs = new Set();
  try {
    slugs = headingSlugs(fs.readFileSync(file, "utf8"));
  } catch {
    /* unreadable target reported elsewhere */
  }
  anchorCache.set(file, slugs);
  return slugs;
}

const canonicalForOwners = new Map(); // id -> file

for (const file of listCanonicalDocs()) {
  const raw = fs.readFileSync(file, "utf8");
  const fm = parseFrontmatter(raw);
  const prose = stripCodeFences(raw);
  const dir = path.dirname(file);
  // REQ-006 (no bare hash / no hardcoded count) is a CONSENSUS-surface rule.
  // Non-consensus docs (adr/architecture/reference/migration) may cite commit
  // evidence / code facts; their hash/count findings stay advisory even under STRICT.
  const req006 = fm && fm.doc_type === "consensus" ? warn : softWarn;

  // frontmatter presence (WARN advisory during migration)
  if (!fm) {
    warn(file, "missing frontmatter (doc_type/status) — advisory during Phase-2");
  } else {
    // canonical_for uniqueness (ERROR)
    if (fm.canonical_for) {
      for (const id of fm.canonical_for.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (canonicalForOwners.has(id)) {
          err(file, `canonical_for "${id}" already claimed by ${rel(canonicalForOwners.get(id))}`);
        } else {
          canonicalForOwners.set(id, file);
        }
      }
    }
  }

  // links
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(prose))) {
    const target = m[1].trim().split(/\s+/)[0]; // drop optional "title"
    if (/^(https?:|mailto:|tel:)/.test(target)) continue;
    const [pathPart, anchor] = target.split("#");
    if (pathPart === "") {
      // same-page anchor
      if (anchor && !anchorsFor(file).has(anchor)) {
        warn(file, `same-page anchor #${anchor} not found`);
      }
      continue;
    }
    const resolved = path.resolve(dir, pathPart);
    if (!fs.existsSync(resolved)) {
      err(file, `broken link → ${target} (missing ${rel(resolved)})`);
      continue;
    }
    if (anchor && pathPart.endsWith(".md")) {
      if (!anchorsFor(resolved).has(anchor)) {
        warn(file, `link ${target} → anchor #${anchor} not found in ${rel(resolved)}`);
      }
    }
  }

  // bare commit hashes (REQ-006) — prose only; strictable only on consensus docs
  COMMIT_RE.lastIndex = 0;
  while ((m = COMMIT_RE.exec(prose))) {
    req006(file, `bare commit hash "${m[0]}" at line ${lineOf(prose, m.index)} (REQ-006: docs are not a commit log)`);
  }

  // hardcoded extension/tool counts (code-mirror smell) — strictable only on consensus docs
  EXT_COUNT_RE.lastIndex = 0;
  while ((m = EXT_COUNT_RE.exec(prose))) {
    req006(file, `hardcoded count "${m[0].trim()}" at line ${lineOf(prose, m.index)} (code-mirror smell — derive from ls extensions/)`);
  }
}

// --- report ----------------------------------------------------------------
const promotedErrors = STRICT ? [...errors, ...warns] : errors;
const remainingWarns = STRICT ? [...softWarns] : [...warns, ...softWarns];

console.log(`docs-doctor — canonical scope: docs/*.md + ${CANONICAL_SUBDIRS.join("/")}/ (excl ${[...EXCLUDED_SUBDIRS].join(",")})`);
console.log(`STRICT=${STRICT ? "1 (warns promoted to errors)" : "0 (migration window)"}\n`);

if (remainingWarns.length) {
  console.log(`WARN (${remainingWarns.length}):`);
  for (const w of remainingWarns) console.log(`  ~ ${w}`);
  console.log("");
}
if (promotedErrors.length) {
  console.log(`ERROR (${promotedErrors.length}):`);
  for (const e of promotedErrors) console.log(`  ✗ ${e}`);
  console.log("");
  console.log(`docs-doctor: FAIL (${promotedErrors.length} error${promotedErrors.length > 1 ? "s" : ""})`);
  process.exit(1);
}
console.log(`docs-doctor: OK${warns.length ? ` (${warns.length} advisory warn${warns.length > 1 ? "s" : ""})` : ""}`);
process.exit(0);
