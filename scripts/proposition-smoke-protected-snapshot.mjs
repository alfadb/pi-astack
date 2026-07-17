import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const PROTECTED_ROOTS = Object.freeze([
  "l1",
  "l2",
  "rules",
  "knowledge",
  "projects",
  "identity",
  "skills",
  "habits",
  "workflows",
  ".state/sediment/proposition-knowledge-shadow",
]);

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

export function snapshotProtectedAbrain(abrainHome) {
  return snapshotPaths(abrainHome, PROTECTED_ROOTS, "proposition-offline-smoke-protected-abrain-snapshot/v1");
}

export function snapshotPropositionProductionTargets(abrainHome, eventRelativePaths) {
  const roots = new Set([
    "l2/views/proposition",
    "rules/proposition",
    "knowledge/proposition",
    "projects/pi-astack/proposition",
    ".state/sediment/proposition-knowledge-shadow",
  ]);
  for (const relative of eventRelativePaths) {
    const parts = relative.split("/");
    if (parts.length !== 6 || parts.slice(0, 3).join("/") !== "l1/events/sha256") throw new Error(`invalid proposition event relative path: ${relative}`);
    roots.add(parts.slice(0, 4).join("/"));
    roots.add(parts.slice(0, 5).join("/"));
    roots.add(relative);
  }
  return snapshotPaths(abrainHome, Object.freeze([...roots].sort()), "proposition-offline-smoke-owned-production-target-snapshot/v1");
}

function snapshotPaths(abrainHome, protectedRoots, schemaVersion) {
  const root = path.resolve(abrainHome);
  const entries = [];
  const walk = (file, relative) => {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(file);
      entries.push({ path: relative, type: "symlink", target, target_sha256: sha256(target) });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ path: relative, type: "directory" });
      for (const child of fs.readdirSync(file).sort()) walk(path.join(file, child), `${relative}/${child}`);
      return;
    }
    if (stat.isFile()) {
      const content = fs.readFileSync(file);
      entries.push({ path: relative, type: "file", size: content.length, sha256: sha256(content) });
      return;
    }
    entries.push({ path: relative, type: "other" });
  };

  for (const relative of protectedRoots) {
    const file = path.join(root, ...relative.split("/"));
    if (fs.existsSync(file)) walk(file, relative);
    else entries.push({ path: relative, type: "missing" });
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return Object.freeze({
    schema_version: schemaVersion,
    protected_roots: protectedRoots,
    count: entries.length,
    sha256: sha256(JSON.stringify(entries)),
    entries: Object.freeze(entries),
  });
}
