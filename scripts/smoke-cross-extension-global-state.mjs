#!/usr/bin/env node
/**
 * Smoke: cross-extension module-state gate.
 *
 * pi loads extensions through separate jiti instances. A module imported across
 * extension directory boundaries must not rely on ordinary module-level mutable
 * state unless the state is intentionally process-global via
 * globalThis[Symbol.for(...)]. This heuristic finds cross-extension imported
 * modules, scans top-level let/var and top-level new Map/Set/WeakMap/WeakSet,
 * and requires every existing exception to be documented in the allowlist.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const extensionsRoot = path.join(repoRoot, "extensions");
const allowlistPath = path.join(__dirname, "cross-extension-global-state-allowlist.json");

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.isFile() && p.endsWith(".ts")) out.push(p);
  }
  return out;
}

function rel(p) {
  return path.relative(repoRoot, p).replaceAll(path.sep, "/");
}

function extensionDirOf(file) {
  const r = path.relative(extensionsRoot, file).split(path.sep);
  return r[0] || "";
}

function stripCommentsAndStrings(line) {
  return line
    .replace(/\/\/.*$/, "")
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "\"\"");
}

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    path.join(base, "index.ts"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile() && c.startsWith(extensionsRoot)) return c;
  }
  return null;
}

function findCrossImportedFiles(files) {
  const byRel = new Set(files.map(rel));
  const cross = new Set();
  const importRe = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;
  for (const file of files) {
    const fromExt = extensionDirOf(file);
    const text = fs.readFileSync(file, "utf8");
    let m;
    while ((m = importRe.exec(text))) {
      const target = resolveImport(file, m[1]);
      if (!target) continue;
      if (!byRel.has(rel(target))) continue;
      const toExt = extensionDirOf(target);
      if (fromExt !== toExt) cross.add(target);
    }
  }
  return cross;
}

function isAllCapsName(name) {
  return /^[A-Z0-9_]+$/.test(name);
}

function scanTopLevelMutableState(file) {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const findings = [];
  let depth = 0;
  let blockComment = false;

  for (let i = 0; i < lines.length; i++) {
    let raw = lines[i];
    let line = raw;
    if (blockComment) {
      const end = line.indexOf("*/");
      if (end === -1) continue;
      line = line.slice(end + 2);
      blockComment = false;
    }
    while (line.includes("/*")) {
      const start = line.indexOf("/*");
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        blockComment = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }

    const beforeDepth = depth;
    const code = stripCommentsAndStrings(line).trim();
    if (beforeDepth === 0 && code) {
      const letVar = code.match(/^(?:export\s+)?(?:declare\s+)?(let|var)\s+([A-Za-z_$][\w$]*)\b/);
      if (letVar) {
        findings.push({
          line: i + 1,
          kind: `top-level ${letVar[1]}`,
          name: letVar[2],
          text: raw.trim(),
        });
      }

      const newCollection = code.match(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\b[^=]*=\s*new\s+(WeakMap|WeakSet|Map|Set)\b/);
      if (newCollection) {
        const [, name, collection] = newCollection;
        const previous = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
        const symbolForNearby = previous.includes("Symbol.for") || previous.includes("globalThis");
        const uppercaseConstantSet = (collection === "Set" || collection === "Map") && isAllCapsName(name);
        if (!symbolForNearby && !uppercaseConstantSet) {
          findings.push({
            line: i + 1,
            kind: `top-level new ${collection}`,
            name,
            text: raw.trim(),
          });
        }
      }
    }

    for (const ch of stripCommentsAndStrings(line)) {
      if (ch === "{") depth++;
      else if (ch === "}") depth = Math.max(0, depth - 1);
    }
  }
  return findings;
}

function loadAllowlist() {
  const parsed = JSON.parse(fs.readFileSync(allowlistPath, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("allowlist must be an array");
  return parsed.map((entry, index) => {
    if (!entry || typeof entry.file !== "string" || typeof entry.pattern !== "string" || typeof entry.reason !== "string") {
      throw new Error(`allowlist entry ${index} must have file, pattern, reason strings`);
    }
    if (entry.reason.trim().length < 20) throw new Error(`allowlist entry ${index} reason is too terse`);
    return { ...entry, regex: new RegExp(entry.pattern) };
  });
}

const files = walk(extensionsRoot);
const crossImported = findCrossImportedFiles(files);
const allowlist = loadAllowlist();
const violations = [];

for (const file of [...crossImported].sort((a, b) => rel(a).localeCompare(rel(b)))) {
  for (const finding of scanTopLevelMutableState(file)) {
    const fileRel = rel(file);
    const allowed = allowlist.find((entry) => entry.file === fileRel && entry.regex.test(finding.text));
    if (!allowed) violations.push({ file: fileRel, ...finding });
  }
}

console.log("cross-extension global state gate");
console.log(`  scanned cross-imported modules: ${crossImported.size}`);
console.log(`  allowlist entries: ${allowlist.length}`);

if (violations.length === 0) {
  console.log("  ok    no unallowlisted cross-extension mutable module state");
  process.exit(0);
}

console.error(`  FAIL  ${violations.length} unallowlisted finding(s)`);
for (const v of violations) {
  console.error(`  - ${v.file}:${v.line} ${v.kind} ${v.name}: ${v.text}`);
}
process.exit(1);
