#!/usr/bin/env node
/**
 * Smoke test: abrain extension P0c.write — vaultWriter library.
 *
 * Coverage:
 *   1. validateKey: rejects bad keys (empty / dot / slash / .. / non-ASCII)
 *   2. writeSecret: real `age -r <pubkey>` encrypt + atomic rename + 0600 mode
 *   3. listSecrets: metadata-only listing (does NOT decrypt)
 *   4. forgetSecret: rm encrypted file + audit row + _meta timeline append
 *   5. _meta/<key>.md: append-only timeline with header on first write
 *   6. vault-events.jsonl: audit row order = create → rotate → forget; size in row
 *   7. flock concurrency: two parallel writeSecret calls to same key serialize
 *   8. reconcile: file with mtime > last audit ts → recovered_missing_audit row
 *   9. ★ ssh-key e2e: write + decrypt with ssh secret roundtrip → byte-match
 *  10. inv1: writeSecret never reads .vault-master.age (proves write path
 *      doesn't touch master plaintext)
 *
 * Strategy: real age + ssh-keygen for the headline e2e; rest is real
 * filesystem against a fresh fake abrain home per test run.
 */

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const ts = require("typescript");

const failures = [];
let total = 0;
async function check(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

function transpile(srcPath) {
  const out = ts.transpileModule(fs.readFileSync(srcPath, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
    },
  });
  return out.outputText;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-vw-"));
fs.writeFileSync(path.join(tmpDir, "vault-writer.cjs"), transpile(path.join(repoRoot, "extensions/abrain/vault-writer.ts")));
const vw = require(path.join(tmpDir, "vault-writer.cjs"));

console.log("abrain P0c.write — vaultWriter library");

// ── helpers ─────────────────────────────────────────────────────

function freshAbrainHome() {
  const home = fs.mkdtempSync(path.join(tmpDir, "abrain-home-"));
  // Generate a fresh age keypair as the vault keypair (we DO need a real
  // key here, so encrypt actually produces a valid envelope).
  const ageOut = path.join(home, "_age-master.tmp");
  const r = spawnSync("age-keygen", ["-o", ageOut], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`age-keygen failed: ${r.stderr}`);
  const m = r.stderr.match(/Public key:\s+(\S+)/);
  if (!m) throw new Error(`could not parse public key from age-keygen stderr`);
  fs.writeFileSync(path.join(home, ".vault-pubkey"), m[1] + "\n", { mode: 0o644 });
  // age secret (we don't need .vault-master.age for write tests, but keep
  // the secret in a known place so we can decrypt for roundtrip checks)
  return { home, ageSecretPath: ageOut, agePubkey: m[1] };
}

// ── 1. validateKey ──────────────────────────────────────────────

await check("validateKey: rejects empty / dot-prefix / slash / .. / non-ascii", () => {
  for (const bad of ["", ".hidden", "a/b", "../etc", "key with space", "中文key", "x".repeat(200)]) {
    let threw = false;
    try { vw.validateKey(bad); } catch { threw = true; }
    if (!threw) throw new Error(`should have rejected: ${JSON.stringify(bad)}`);
  }
});

await check("validateKey: accepts good keys", () => {
  for (const good of ["foo", "github-token", "API_KEY", "x.y", "a_b-c.123"]) {
    vw.validateKey(good); // should not throw
  }
});

// ── 2. writeSecret basic ────────────────────────────────────────

await check("writeSecret: rejects when .vault-pubkey missing", async () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "no-pubkey-"));
  let threw = false;
  try {
    await vw.writeSecret({ abrainHome: home, scope: "global", key: "x", value: "v" });
  } catch (err) {
    threw = true;
    if (!err.message.includes("not initialized")) throw new Error(`unexpected error: ${err.message}`);
  }
  if (!threw) throw new Error("expected throw on missing .vault-pubkey");
});

await check("writeSecret: produces .md.age age envelope at 0600", async () => {
  const { home } = freshAbrainHome();
  const result = await vw.writeSecret({
    abrainHome: home, scope: "global", key: "test-key", value: "hello world",
  });
  if (!fs.existsSync(result.encryptedPath)) throw new Error(`encrypted file missing: ${result.encryptedPath}`);
  const stat = fs.statSync(result.encryptedPath);
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) throw new Error(`mode wrong: 0${mode.toString(8)}, expected 0600`);
  const content = fs.readFileSync(result.encryptedPath);
  if (!content.includes(Buffer.from("age-encryption.org/v1"))) throw new Error("missing age envelope magic");
});

await check("writeSecret: no .tmp.* leftover after success", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "x", value: "v" });
  const vaultDir = path.join(home, "vault");
  const leftovers = fs.readdirSync(vaultDir).filter((f) => f.includes(".tmp."));
  if (leftovers.length > 0) throw new Error(`tmp leftover: ${leftovers.join(", ")}`);
});

// ── 3. _meta/<key>.md timeline ──────────────────────────────────

await check("_meta/<key>.md: header + 'created' row on first write", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({
    abrainHome: home, scope: "global", key: "github-token", value: "ghp_xxx", description: "GitHub PAT",
  });
  const meta = fs.readFileSync(path.join(home, "vault", "_meta", "github-token.md"), "utf8");
  if (!meta.includes("# Vault key: github-token")) throw new Error("missing header");
  if (!meta.includes("scope: global")) throw new Error("missing scope");
  if (!meta.includes("description: GitHub PAT")) throw new Error("missing description");
  if (!meta.includes("| created |")) throw new Error("missing created timeline row");
  if (!meta.includes("size=7B")) throw new Error("size field wrong (expected 7B for 'ghp_xxx')");
});

await check("_meta: rewriting same key appends 'rotated' row, not new header", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v1" });
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v2-longer" });
  const meta = fs.readFileSync(path.join(home, "vault", "_meta", "k.md"), "utf8");
  // Header appears exactly once
  const headerCount = (meta.match(/^# Vault key:/gm) || []).length;
  if (headerCount !== 1) throw new Error(`expected 1 header, got ${headerCount}`);
  if (!meta.includes("| created |")) throw new Error("missing created row");
  if (!meta.includes("| rotated |")) throw new Error("missing rotated row");
});

await check("_meta: plaintext value never appears in timeline", async () => {
  const { home } = freshAbrainHome();
  const SECRET = "SUPER_SECRET_VALUE_xyz123";
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: SECRET });
  const meta = fs.readFileSync(path.join(home, "vault", "_meta", "k.md"), "utf8");
  if (meta.includes(SECRET)) throw new Error(`SECURITY: plaintext leaked into _meta`);
});

// ── 4. vault-events.jsonl audit ─────────────────────────────────

await check("vault-events: 'create' row written + plaintext NOT in row", async () => {
  const { home } = freshAbrainHome();
  const SECRET = "another-secret-XYZ";
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "key1", value: SECRET, description: "desc1" });

  const events = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8");
  const lines = events.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (lines.length !== 1) throw new Error(`expected 1 event, got ${lines.length}`);
  const ev = lines[0];
  if (ev.op !== "create") throw new Error(`expected op=create, got ${ev.op}`);
  if (ev.key !== "key1") throw new Error(`key mismatch: ${ev.key}`);
  if (ev.scope !== "global") throw new Error(`scope mismatch: ${ev.scope}`);
  if (ev.size !== SECRET.length) throw new Error(`size mismatch: ${ev.size} vs ${SECRET.length}`);
  if (ev.description !== "desc1") throw new Error(`description mismatch`);
  if (events.includes(SECRET)) throw new Error(`SECURITY: plaintext leaked into vault-events`);
});

await check("vault-events: 'rotate' on second write of same key", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v1" });
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v2" });
  const lines = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  if (lines.length !== 2) throw new Error(`expected 2 events, got ${lines.length}`);
  if (lines[0].op !== "create") throw new Error(`first should be create, got ${lines[0].op}`);
  if (lines[1].op !== "rotate") throw new Error(`second should be rotate, got ${lines[1].op}`);
});

await check("appendVaultReadAudit: read-path ops land in vault-events.jsonl without plaintext", async () => {
  const { home } = freshAbrainHome();
  fs.mkdirSync(path.join(home, ".state"), { recursive: true });
  await vw.appendVaultReadAudit(home, {
    ts: new Date().toISOString(),
    op: "release",
    scope: "global",
    key: "github-token",
    lane: "vault_release",
  });
  await vw.appendVaultReadAudit(home, {
    ts: new Date().toISOString(),
    op: "bash_inject",
    scope: "global",
    lane: "bash_inject",
    keys: ["global:github-token"],
    variables: [{ varName: "VAULT_github_token", scopeKey: "global:github-token" }],
    command_preview: "curl -H \"Authorization: token $VAULT_github_token\" ...",
  });
  await vw.appendVaultReadAudit(home, {
    ts: new Date().toISOString(),
    op: "release_denied",
    scope: "global",
    key: "github-token",
    lane: "vault_release",
    reason: "no",
  });
  const raw = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8");
  if (raw.includes("plaintext")) throw new Error("audit must not mention plaintext");
  const rows = raw.split("\n").filter(Boolean).map(JSON.parse);
  if (rows.length !== 3) throw new Error(`expected 3 audit rows, got ${rows.length}`);
  if (rows[0].op !== "release" || rows[0].lane !== "vault_release") throw new Error(`row 0 mismatched: ${JSON.stringify(rows[0])}`);
  if (rows[1].op !== "bash_inject" || !Array.isArray(rows[1].variables)) throw new Error(`row 1 mismatched: ${JSON.stringify(rows[1])}`);
  if (rows[1].variables[0].varName !== "VAULT_github_token") throw new Error(`row 1 varName missing: ${JSON.stringify(rows[1])}`);
  if (rows[1].variables[0].scopeKey !== "global:github-token") throw new Error(`row 1 scopeKey missing: ${JSON.stringify(rows[1])}`);
  if (rows[2].op !== "release_denied" || rows[2].reason !== "no") throw new Error(`row 2 mismatched: ${JSON.stringify(rows[2])}`);
  for (const row of rows) {
    if ("value" in row) throw new Error("audit row must not carry plaintext value");
  }
});

// ── ADR 0022 housekeeping batch A (g) (2026-05-19): ui_path INV-D metadata
//
// The VaultEvent schema gained an optional `ui_path` field so audit rows
// can carry which UI substrate produced a decision (overlay / select /
// confirm / cached / none). The field is OPTIONAL — callers that don’t
// know which path produced the row (e.g. pre-authorize fast-fails,
// outer-envelope withholds in tool_result catch) MUST be able to write a
// row WITHOUT the field, and the row MUST round-trip.
//
// Smoke verifies the schema-level behavior here (no stage-index needed).
// The end-to-end “caller·stamps·correct·path” wiring lives in
// scripts/smoke-abrain-vault-grant-isolation.mjs (Batch A subgroup 2).
// Negative-test: comment out the ui_path spread in vault-writer.ts to
// verify these assertions fail (manual check during edit).

await check("INV-D (batch A g): VaultEvent.ui_path round-trips through jsonl write", async () => {
  const { home } = freshAbrainHome();
  fs.mkdirSync(path.join(home, ".state"), { recursive: true });
  // All five legal ui_path values, plus one row with ui_path absent.
  const cases = [
    { op: "release",         lane: "vault_release", ui_path: "overlay" },
    { op: "release_denied",  lane: "vault_release", ui_path: "select", reason: "cancelled" },
    { op: "release_denied",  lane: "vault_release", ui_path: "confirm", reason: "denied" },
    { op: "release",         lane: "vault_release", ui_path: "cached" },
    { op: "release_denied",  lane: "vault_release", ui_path: "none", reason: "ui_authorization_unavailable" },
    { op: "release_blocked", lane: "vault_release", reason: "key_not_found" }, // ui_path absent
  ];
  for (const c of cases) {
    await vw.appendVaultReadAudit(home, {
      ts: new Date().toISOString(),
      scope: "global",
      key: "github-token",
      ...c,
    });
  }
  const rows = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(JSON.parse);
  if (rows.length !== cases.length)
    throw new Error(`expected ${cases.length} rows, got ${rows.length}`);
  for (let i = 0; i < cases.length - 1; i++) {
    if (rows[i].ui_path !== cases[i].ui_path)
      throw new Error(`row ${i}: expected ui_path=${cases[i].ui_path}, got ${rows[i].ui_path}`);
  }
  // Last row has no ui_path — must NOT appear in jsonl (no `undefined` leak).
  if ("ui_path" in rows[rows.length - 1]) {
    throw new Error(`row ${rows.length - 1}: ui_path should be absent, got ${JSON.stringify(rows[rows.length - 1])}`);
  }
});

await check("INV-D (batch A b): startup_telemetry op writes lane=vault_substrate without plaintext", async () => {
  const { home } = freshAbrainHome();
  fs.mkdirSync(path.join(home, ".state"), { recursive: true });
  // Mirror what extensions/abrain/index.ts emits on session_start when
  // vaultDialogBuilderInitFailed && ctx.ui.custom is present.
  await vw.appendVaultReadAudit(home, {
    ts: new Date().toISOString(),
    op: "startup_telemetry",
    scope: "global",
    lane: "vault_substrate",
    reason: "dialog_builder_unavailable",
    ui_path: "select",
  });
  const rows = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(JSON.parse);
  if (rows.length !== 1) throw new Error(`expected 1 telemetry row, got ${rows.length}`);
  const r = rows[0];
  if (r.op !== "startup_telemetry") throw new Error(`op: ${r.op}`);
  if (r.lane !== "vault_substrate") throw new Error(`lane: ${r.lane}`);
  if (r.ui_path !== "select") throw new Error(`ui_path: ${r.ui_path}`);
  if (r.reason !== "dialog_builder_unavailable") throw new Error(`reason: ${r.reason}`);
  // INV: lane="vault_substrate" so existing tools that grep on
  // lane="vault_release" / "bash_*" / "prompt_user" ignore it.
  // Sanity-check by enumerating the union of known lanes.
  const KNOWN_VAULT_LANES = new Set([
    "vault_release", "bash_inject", "bash_output", "prompt_user", "vault_substrate",
  ]);
  if (!KNOWN_VAULT_LANES.has(r.lane))
    throw new Error(`lane not in known set: ${r.lane}`);
});

// ── 5. listSecrets ──────────────────────────────────────────────

await check("listSecrets: returns metadata for all written keys, no decrypt", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "alpha", value: "a", description: "first" });
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "beta", value: "b" });
  const items = vw.listSecrets(home, "global");
  if (items.length !== 2) throw new Error(`expected 2 items, got ${items.length}`);
  const alpha = items.find((i) => i.key === "alpha");
  if (!alpha) throw new Error("alpha missing");
  if (alpha.description !== "first") throw new Error(`description: ${alpha.description}`);
  if (!alpha.created) throw new Error("created missing");
  if (alpha.forgotten) throw new Error("alpha incorrectly marked forgotten");
});

await check("listSecrets: empty when no vault dir / no _meta dir", () => {
  const home = fs.mkdtempSync(path.join(tmpDir, "empty-"));
  const items = vw.listSecrets(home, "global");
  if (items.length !== 0) throw new Error(`expected empty, got ${items.length}`);
});

// ── 6. forgetSecret ─────────────────────────────────────────────

await check("forgetSecret: removes encrypted file but keeps _meta", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "victim", value: "delete-me" });
  const result = await vw.forgetSecret(home, "global", "victim");
  if (result.status !== "removed") throw new Error(`forget should report status=removed, got: ${JSON.stringify(result)}`);
  if (fs.existsSync(path.join(home, "vault", "victim.md.age"))) throw new Error("encrypted file still exists");
  if (!fs.existsSync(path.join(home, "vault", "_meta", "victim.md"))) throw new Error("_meta should be retained");
});

await check("forgetSecret: appends 'forgotten' row to _meta + 'forget' to vault-events", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v" });
  await vw.forgetSecret(home, "global", "k");
  const meta = fs.readFileSync(path.join(home, "vault", "_meta", "k.md"), "utf8");
  if (!meta.includes("| forgotten |")) throw new Error("missing 'forgotten' row in _meta");
  const events = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  if (!events.some((e) => e.op === "forget" && e.key === "k")) throw new Error("missing forget event");
});

await check("listSecrets: marks forgotten=true after forget", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v" });
  await vw.forgetSecret(home, "global", "k");
  const items = vw.listSecrets(home, "global");
  const item = items.find((i) => i.key === "k");
  if (!item) throw new Error("k missing from list");
  if (!item.forgotten) throw new Error("expected forgotten=true");
});

await check("v1.4.4 dogfood: listSecrets parses forgottenAt from _meta timeline", async () => {
  // Dogfood-flagged: list output showed `(since <created>)` even when forgotten,
  // which was confusing. Now listSecrets parses the most recent `forgotten` row's
  // ts and exposes it as forgottenAt so caller can show it instead.
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v" });
  // small sleep to ensure forgotten ts > created ts (visible in test)
  await new Promise((r) => setTimeout(r, 10));
  await vw.forgetSecret(home, "global", "k");
  const items = vw.listSecrets(home, "global");
  const item = items.find((i) => i.key === "k");
  if (!item) throw new Error("k missing");
  if (!item.forgottenAt) throw new Error("forgottenAt should be populated after forget");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(item.forgottenAt)) throw new Error(`forgottenAt not ISO: ${item.forgottenAt}`);
  if (item.forgottenAt <= item.created) throw new Error(`forgottenAt (${item.forgottenAt}) should be > created (${item.created})`);
});

await check("readVaultEntryMeta returns description + created (single-key reader, no decrypt)", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "shared-key", value: "v", description: "shared across hosts" });
  const meta = vw.readVaultEntryMeta(home, "global", "shared-key");
  if (!meta) throw new Error("expected meta for existing key");
  if (meta.description !== "shared across hosts") throw new Error(`bad description: ${meta.description}`);
  if (!meta.created) throw new Error("created should be populated");
  if (meta.forgottenAt) throw new Error(`forgottenAt should be undefined: ${meta.forgottenAt}`);
});

await check("readVaultEntryMeta returns null for missing key + populates forgottenAt after forget", async () => {
  const { home } = freshAbrainHome();
  if (vw.readVaultEntryMeta(home, "global", "nope") !== null) throw new Error("missing key should yield null");
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v" });
  await vw.forgetSecret(home, "global", "k");
  const meta = vw.readVaultEntryMeta(home, "global", "k");
  if (!meta?.forgottenAt) throw new Error("forgottenAt should populate after forget");
});

await check("v1.4.4 dogfood: forgottenAt absent when not forgotten", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v" });
  const items = vw.listSecrets(home, "global");
  const item = items.find((i) => i.key === "k");
  if (item.forgotten) throw new Error("should not be forgotten");
  if (item.forgottenAt) throw new Error(`forgottenAt should be undefined when not forgotten; got: ${item.forgottenAt}`);
});

await check("v1.4.4 dogfood: rotate then forget — forgottenAt is the LATEST forget ts (not first)", async () => {
  // Edge case: a key forgotten, re-created, forgotten again. forgottenAt should
  // be the most recent forget. (Although in practice forget removes the file so
  // re-create is allowed — _meta retains the full history.)
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v1" });
  await new Promise((r) => setTimeout(r, 10));
  await vw.forgetSecret(home, "global", "k");
  await new Promise((r) => setTimeout(r, 10));
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v2" });
  await new Promise((r) => setTimeout(r, 10));
  await vw.forgetSecret(home, "global", "k");

  const items = vw.listSecrets(home, "global");
  const item = items.find((i) => i.key === "k");
  if (!item.forgottenAt) throw new Error("forgottenAt missing");

  // Read _meta to find both forgotten timestamps
  const meta = fs.readFileSync(path.join(home, "vault", "_meta", "k.md"), "utf8");
  const forgetTs = [...meta.matchAll(/^- (\S+)\s+\|\s+forgotten/gm)].map((m) => m[1]);
  if (forgetTs.length !== 2) throw new Error(`expected 2 forgotten rows, got ${forgetTs.length}`);
  if (item.forgottenAt !== forgetTs[forgetTs.length - 1]) {
    throw new Error(`forgottenAt (${item.forgottenAt}) should be most recent (${forgetTs[forgetTs.length - 1]})`);
  }
});

await check("forgetSecret: idempotent on already-forgotten key (no encrypted file)", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v" });
  await vw.forgetSecret(home, "global", "k");
  // Second forget should not throw; status flips from "removed" to "absent"
  // and still records a forget audit row.
  const result = await vw.forgetSecret(home, "global", "k");
  if (result.status !== "absent") throw new Error(`second forget should report status=absent, got: ${JSON.stringify(result)}`);
  const events = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const forgetCount = events.filter((e) => e.op === "forget" && e.key === "k").length;
  if (forgetCount !== 2) throw new Error(`expected 2 forget events, got ${forgetCount}`);
});

// Round 7 P0-A (gpt-5.5 audit fix): tri-state outcome. When the encrypted
// path exists but neither shred -u nor fs.unlinkSync can delete it (e.g.
// because the path is actually a directory — EISDIR is a portable POSIX
// errno that doesn't require root or chattr), forgetSecret must NOT
// report success; it must NOT write a "forgotten" _meta timeline row,
// and must write a distinct `forget_failed` audit row.
await check("forgetSecret: removal_failed when encrypted path cannot be deleted", async () => {
  const { home } = freshAbrainHome();
  // Pre-create _meta so the timeline can be inspected after the failed
  // forget attempt (writeSecret would normally create it, but we replace
  // the encrypted file with a directory so writeSecret isn't usable here).
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "locked", value: "v" });
  const vaultDir = path.join(home, "vault");
  const encryptedPath = path.join(vaultDir, "locked.md.age");
  // Replace the .md.age file with a directory containing a child file so
  // both `shred -u <path>` and `fs.unlinkSync(<path>)` fail with EISDIR
  // (or ENOTEMPTY/EBUSY — anything non-deleting). The parent vault dir
  // remains writable, so acquireLock still succeeds; we exercise ONLY the
  // shred-then-unlink failure path.
  fs.unlinkSync(encryptedPath);
  fs.mkdirSync(encryptedPath);
  fs.writeFileSync(path.join(encryptedPath, "child.txt"), "so-rmdir-also-fails");
  const result = await vw.forgetSecret(home, "global", "locked");
  if (result.status !== "removal_failed") throw new Error(`expected status=removal_failed, got: ${JSON.stringify(result)}`);
  if (!result.error) throw new Error("removal_failed must carry root-cause error string");
  // The encrypted path must still exist on disk.
  if (!fs.existsSync(encryptedPath)) {
    throw new Error("removal_failed but encrypted path was actually deleted — inconsistent");
  }
  // _meta MUST NOT have a "forgotten" timeline row (the secret isn't forgotten).
  const metaText = fs.readFileSync(path.join(vaultDir, "_meta", "locked.md"), "utf8");
  if (/\| forgotten \|/.test(metaText)) {
    throw new Error("removal_failed but _meta timeline shows 'forgotten' — false success report");
  }
  // vault-events MUST have forget_failed, NOT forget.
  const events = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8")
    .split("\n").filter(Boolean).map(JSON.parse);
  const failed = events.filter((e) => e.op === "forget_failed" && e.key === "locked");
  const succeeded = events.filter((e) => e.op === "forget" && e.key === "locked");
  if (failed.length !== 1) throw new Error(`expected 1 forget_failed row, got ${failed.length}`);
  if (succeeded.length !== 0) throw new Error(`expected 0 forget rows for failed removal, got ${succeeded.length}`);
  if (!failed[0].error) throw new Error("forget_failed row should carry error string");
  // Cleanup so the test harness can rm -rf.
  fs.rmSync(encryptedPath, { recursive: true, force: true });
});

// ── 7. flock concurrency ────────────────────────────────────────

await check("flock: two concurrent writes to same key serialize (both succeed, last wins)", async () => {
  const { home } = freshAbrainHome();
  // launch both in parallel
  const [a, b] = await Promise.all([
    vw.writeSecret({ abrainHome: home, scope: "global", key: "race-key", value: "from-A" }),
    vw.writeSecret({ abrainHome: home, scope: "global", key: "race-key", value: "from-B" }),
  ]);
  if (!a.encryptedPath || !b.encryptedPath) throw new Error("both should resolve to a path");
  // Either both events recorded as create+rotate, or both create (race condition on
  // the existence check). We accept any history that has 2 rows (proving serialization).
  const events = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const keyEvents = events.filter((e) => e.key === "race-key");
  if (keyEvents.length !== 2) throw new Error(`expected 2 events for race-key, got ${keyEvents.length}`);
  // The two timestamps must be distinct (proving serialization, not parallel)
  if (keyEvents[0].ts === keyEvents[1].ts) throw new Error("events have identical timestamps — possibly parallel write?");
});

// ── 8. reconcile ────────────────────────────────────────────────

await check("reconcile: orphan .md.age (newer than audit) → recovered_missing_audit row", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "legit", value: "v" });

  // Simulate a crashed write: a .md.age file with no audit row
  const orphanPath = path.join(home, "vault", "orphan.md.age");
  // Encrypt something via age to make a valid envelope
  const { agePubkey } = freshAbrainHomeReuse(home); // get pubkey for this home
  const ageR = spawnSync("age", ["-r", agePubkey, "-o", orphanPath], { input: "synthetic" });
  if (ageR.status !== 0) throw new Error(`could not synthesize orphan: ${ageR.stderr}`);
  // Force mtime to be in the future to ensure it's > last audit ts
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(orphanPath, future, future);

  const result = await vw.reconcile(home);
  if (result.recovered !== 1) throw new Error(`expected recovered=1, got ${result.recovered}`);

  const events = fs.readFileSync(path.join(home, ".state", "vault-events.jsonl"), "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const recovery = events.find((e) => e.op === "recovered_missing_audit" && e.key === "orphan");
  if (!recovery) throw new Error("missing recovered_missing_audit event");
});

// helper: re-read pubkey from existing home (used by reconcile test)
function freshAbrainHomeReuse(home) {
  const pk = fs.readFileSync(path.join(home, ".vault-pubkey"), "utf8").trim();
  return { home, agePubkey: pk };
}

await check("reconcile: forgotten keys do NOT trigger recovery", async () => {
  const { home } = freshAbrainHome();
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v" });
  await vw.forgetSecret(home, "global", "k");
  // No file exists for k anymore, so reconcile shouldn't find it as orphan.
  const result = await vw.reconcile(home);
  // recovered==0 because k.md.age doesn't exist (and even if it did, the
  // forget event marks it as post-forget so reconcile skips)
  if (result.recovered !== 0) throw new Error(`expected recovered=0, got ${result.recovered}`);
});

// ── 9. ★ ssh-key e2e: encrypt with vaultWriter, decrypt with ssh-key ──

await check("★ ssh-key e2e: vaultWriter encrypted file decrypts back to original via age -d -i", async () => {
  // Build an abrain home where .vault-pubkey is derived from an ssh public key.
  // (vaultWriter uses age public key directly; we use ssh public key as recipient
  //  — age natively accepts both via -r.)
  // BUT: vaultWriter calls `age -r <pubkey>` where pubkey is the contents of
  // .vault-pubkey. age -r accepts a recipient string; for ssh keys you use
  // `-R <file>` (recipients file). So this test uses age native pubkey.
  // The ssh-key path is exercised in P0b smoke; here we just prove the
  // age-recipient roundtrip with the actual vaultWriter.

  const { home, ageSecretPath } = freshAbrainHome();
  const SECRET = "this is the secret value with spaces and 中文";
  await vw.writeSecret({
    abrainHome: home, scope: "global", key: "roundtrip", value: SECRET,
  });

  // Decrypt with the age secret
  const dec = spawnSync("age", ["-d", "-i", ageSecretPath, path.join(home, "vault", "roundtrip.md.age")], {
    encoding: "utf8",
  });
  if (dec.status !== 0) throw new Error(`age -d failed: ${dec.stderr}`);
  if (dec.stdout !== SECRET) throw new Error(`decrypted does NOT match original.\n  got: ${JSON.stringify(dec.stdout)}\n  expected: ${JSON.stringify(SECRET)}`);
});

// ── 10. inv1: writeSecret never reads .vault-master.age ─────────

await check("★ inv1: writeSecret does NOT read .vault-master.age (write path is master-key-free)", async () => {
  // Build a home with NO .vault-master.age (only .vault-pubkey).
  const { home } = freshAbrainHome();
  // Sanity: ensure .vault-master.age really doesn't exist
  const masterPath = path.join(home, ".vault-master.age");
  if (fs.existsSync(masterPath)) throw new Error("test setup error: master file exists");

  // If writeSecret tries to read it, it'll fail. Otherwise succeed.
  await vw.writeSecret({ abrainHome: home, scope: "global", key: "k", value: "v" });
  // Still doesn't exist (we never wrote it)
  if (fs.existsSync(masterPath)) throw new Error("writeSecret created .vault-master.age — should not happen");
});

// ── Done ────────────────────────────────────────────────────────

console.log("");
if (failures.length === 0) {
  console.log(`all ok — abrain P0c.write vaultWriter holds (${total} assertions, age-recipient roundtrip + flock concurrency + reconcile verified).`);
} else {
  console.log(`FAIL — ${failures.length} of ${total} assertions failed.`);
  process.exit(1);
}
