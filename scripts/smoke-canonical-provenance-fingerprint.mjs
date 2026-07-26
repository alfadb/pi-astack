#!/usr/bin/env node
/**
 * Process-level implementation fingerprint is sorted [label, bytesSha256].
 * Equivalent bytes under different sourceRoot / absolute paths must not
 * RUNTIME_PROVENANCE_SPLIT; real 1-byte drift still fail-closed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(root, { interopDefault: true });
const runtimeModule = jiti(path.join(root, "extensions/_shared/canonical-git-runtime.ts"));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-provenance-fp-"));
const gitEnv = {
  ...process.env,
  LANG: "C",
  LC_ALL: "C",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_TERMINAL_PROMPT: "0",
};

let fails = 0;
function assert(cond, msg) {
  if (!cond) {
    fails += 1;
    console.error(`FAIL: ${msg}`);
  } else {
    console.log(`PASS: ${msg}`);
  }
}

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", env: gitEnv }).trim();
}

function initRepo(name) {
  const repo = path.join(tmp, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.name", "prov-smoke");
  git(repo, "config", "user.email", "prov@example.invalid");
  fs.writeFileSync(path.join(repo, ".gitignore"), ".state/\n");
  fs.writeFileSync(path.join(repo, "README"), "prov\n");
  git(repo, "add", ".gitignore", "README");
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"], { env: gitEnv });
  return repo;
}

function writeSettings(file, extra = {}) {
  fs.writeFileSync(file, `${JSON.stringify({
    canonicalGitRuntime: { enabled: true, mode: "local_convergence_v2" },
    ...extra,
  }, null, 2)}\n`);
}

// ── static formula ──────────────────────────────────────────────────
{
  const src = fs.readFileSync(path.join(root, "extensions/_shared/canonical-git-runtime.ts"), "utf8");
  assert(/\[entry\.label,\s*entry\.bytesSha256\]/.test(src), "fingerprint uses [label, bytesSha256]");
  assert(!/entry\.label,\s*entry\.path,\s*entry\.bytesSha256/.test(src), "fingerprint no longer includes absolute path");
  assert(src.includes("assertProvenanceFrozen"), "freeze assert retained");
  assert(/now\.path !== loaded\.path/.test(src), "assertProvenanceFrozen still compares path per label");
  assert(/now\.bytesSha256 !== loaded\.bytesSha256/.test(src), "assertProvenanceFrozen still compares bytes per label");
}

// ── equivalent settings path + symlink sourceRoot do not split ──────
{
  const settingsA = path.join(tmp, "settings-a.json");
  const settingsB = path.join(tmp, "settings-b.json");
  writeSettings(settingsA);
  fs.copyFileSync(settingsA, settingsB);
  const linkRoot = path.join(tmp, "source-link");
  try { fs.unlinkSync(linkRoot); } catch { /* */ }
  fs.symlinkSync(root, linkRoot);

  const repo1 = initRepo("repo-1");
  const r1 = await runtimeModule.getCanonicalGitRuntime({
    abrainHome: repo1,
    settingsPath: settingsA,
    sourceRoot: root,
  });
  const fp1 = r1.diagnostics().implementationFingerprint;
  const paths1 = r1.diagnostics().loadedProvenance.map((e) => e.path);

  let split = null;
  let r2;
  try {
    r2 = await runtimeModule.getCanonicalGitRuntime({
      abrainHome: initRepo("repo-2"),
      settingsPath: settingsB,
      sourceRoot: linkRoot,
    });
  } catch (error) {
    split = error;
  }
  assert(!split, `equivalent bytes must not RUNTIME_PROVENANCE_SPLIT: ${split}`);
  const fp2 = r2.diagnostics().implementationFingerprint;
  const paths2 = r2.diagnostics().loadedProvenance.map((e) => e.path);
  assert(fp1 === fp2, "fingerprint equal across settingsPath/sourceRoot path variants");
  assert(paths1.some((p, i) => p !== paths2[i]), "LoadedProvenance path remains diagnostic and may differ");
  assert(
    r1.diagnostics().loadedProvenance.every((e, i) => e.label === r2.diagnostics().loadedProvenance[i].label
      && e.bytesSha256 === r2.diagnostics().loadedProvenance[i].bytesSha256),
    "label+bytesSha256 equal across equivalent copies",
  );
}

// ── real 1-byte drift fail-closed (settings provenance entry) ───────
{
  // Fresh child process so the process-global fingerprint starts clean.
  const settingsPath = path.join(tmp, "drift-settings.json");
  writeSettings(settingsPath);
  const repo = initRepo("repo-drift");
  const code = `
    const {createJiti}=require('jiti');
    const fs=require('fs');
    const p=require('path');
    (async()=>{
      const root=${JSON.stringify(root)};
      const settingsPath=${JSON.stringify(settingsPath)};
      const j=createJiti(root,{interopDefault:true});
      const m=j(p.join(root,'extensions/_shared/canonical-git-runtime.ts'));
      const r=await m.getCanonicalGitRuntime({
        abrainHome:${JSON.stringify(repo)},
        settingsPath,
        sourceRoot: root,
      });
      const fp=r.diagnostics().implementationFingerprint;
      // 1-byte drift on the settings provenance entry.
      fs.appendFileSync(settingsPath, ' ');
      let driftErr=null;
      try {
        const startup=await r.awaitStartup();
        if(startup.startup!=='ready') throw new Error(startup.blockedReason||startup.startup);
        await r.requestDrain([], 'drift-check');
      } catch(e) {
        driftErr=(e && (e.code || e.message)) || String(e);
      }
      let splitErr=null;
      try {
        await m.getCanonicalGitRuntime({
          abrainHome:${JSON.stringify(initRepo("repo-drift-2"))},
          settingsPath,
          sourceRoot: root,
        });
      } catch(e) {
        splitErr=(e && (e.code || e.message)) || String(e);
      }
      process.stdout.write(JSON.stringify({ fp, driftErr:String(driftErr), splitErr:String(splitErr) }));
    })().catch(e=>{console.error(e);process.exit(1);});
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    env: { ...process.env, PI_ASTACK_SETTINGS_PATH: settingsPath },
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  }));
  assert(
    /PROVENANCE_DRIFT/.test(out.driftErr) || /RUNTIME_PROVENANCE_SPLIT/.test(out.splitErr) || /PROVENANCE_DRIFT/.test(out.splitErr),
    `1-byte drift fail-closed: drift=${out.driftErr} split=${out.splitErr}`,
  );
  console.log(`INFO: drift protection driftErr=${out.driftErr} splitErr=${out.splitErr}`);
}

// ── settingsPath reconfigure protection still enforced ──────────────
{
  // In a child: load with settingsA, then try different settings bytes at another path.
  const settingsOk = path.join(tmp, "reconfig-ok.json");
  const settingsOther = path.join(tmp, "reconfig-other.json");
  writeSettings(settingsOk);
  writeSettings(settingsOther, { sediment: { enabled: false } }); // different bytes
  const repo = initRepo("repo-reconfig");
  const code = `
    const {createJiti}=require('jiti');
    const p=require('path');
    (async()=>{
      const root=${JSON.stringify(root)};
      const j=createJiti(root,{interopDefault:true});
      const m=j(p.join(root,'extensions/_shared/canonical-git-runtime.ts'));
      await m.getCanonicalGitRuntime({
        abrainHome:${JSON.stringify(repo)},
        settingsPath:${JSON.stringify(settingsOk)},
        sourceRoot: root,
      });
      let err=null;
      try {
        await m.getCanonicalGitRuntime({
          abrainHome:${JSON.stringify(repo)},
          settingsPath:${JSON.stringify(settingsOther)},
          sourceRoot: root,
        });
      } catch(e) {
        err=(e && (e.code || e.message)) || String(e);
      }
      process.stdout.write(JSON.stringify({ err:String(err) }));
    })().catch(e=>{console.error(e);process.exit(1);});
  `;
  const out = JSON.parse(execFileSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    cwd: root,
    maxBuffer: 8 * 1024 * 1024,
  }));
  assert(
    /RUNTIME_PROVENANCE_SPLIT|RUNTIME_RECONFIGURE_BLOCKED/.test(out.err),
    `different settings bytes still blocked: ${out.err}`,
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(fails === 0 ? "\n✅ ALL PASS — provenance fingerprint gate" : `\n❌ ${fails} FAIL`);
process.exit(fails === 0 ? 0 : 1);
