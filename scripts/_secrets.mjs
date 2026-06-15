// Shared secret reader for oracle/smoke dev scripts.
//
// Single source of truth: the centralized ~/.pi/secrets.json store
// (chmod 600, gitignored). This replaces the per-key SUB2API_API_KEY_*
// environment variables that used to live in ~/.zshrc — dev scripts now
// read keys from the same one file the running pi agent does (models.json
// and web-search resolve it via "!jq ... secrets.json").
//
// Usage:
//   import { secret } from "./_secrets.mjs";
//   const EMBED_KEY = secret("embedding");
//   if (!EMBED_KEY) { console.log("SKIP — no embedding key"); process.exit(0); }
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let _cache;
function load() {
  if (_cache) return _cache;
  try {
    _cache = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".pi", "secrets.json"), "utf8"),
    );
  } catch {
    _cache = {};
  }
  return _cache;
}

/** Return the plaintext secret for `name` from ~/.pi/secrets.json, or "" if absent. */
export function secret(name) {
  const v = load()[name];
  return typeof v === "string" ? v : "";
}
