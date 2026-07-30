#!/usr/bin/env node
/**
 * DCC: store-present foreground direct canonical business write gate +
 * /memory migrate --go capture_only reject. Temporary fixtures only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });

process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";

function assert(value, message) {
  if (!value) throw new Error(message);
}

function hex64(seed) {
  return crypto.createHash("sha256").update(String(seed)).digest("hex");
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-dcc-tui-write-"));
process.once("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

const abrainMod = await jiti.import(path.join(root, "extensions/abrain/index.ts"));
const memoryMod = await jiti.import(path.join(root, "extensions/memory/index.ts"));
const barrier = await jiti.import(path.join(root, "extensions/_shared/canonical-mutation-barrier.ts"));

function createHome(name, { authority = true } = {}) {
  const abrain = path.join(tmp, name);
  fs.mkdirSync(abrain, { recursive: true, mode: 0o700 });
  if (authority) {
    const directory = path.join(abrain, ".state", "sediment", "local-executor-authority");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "authority.lock"), "", { mode: 0o600 });
    fs.writeFileSync(path.join(directory, "authority.json"), `${JSON.stringify({
      schema: "pi-router/local-sediment-executor-authority/v1",
      local_executor_epoch: "9",
      mode: "held",
      holder_kind: "daemon",
      holder_nonce: hex64("tui-write-holder"),
      state_dir_key: hex64("tui-write-state"),
      run_nonce: hex64("tui-write-run"),
    })}\n`, { mode: 0o600 });
  }
  return abrain;
}

function snapshotTree(dir) {
  if (!fs.existsSync(dir)) return "";
  const rows = [];
  const walk = (current, rel = "") => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const next = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(full);
      if (st.isSymbolicLink()) rows.push(`l:${next}`);
      else if (st.isDirectory()) {
        rows.push(`d:${next}`);
        walk(full, next);
      } else rows.push(`f:${next}:${st.size}:${crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex")}`);
    }
  };
  walk(dir);
  return rows.join("\n");
}

await check("store-absent legacy: gate runs operation with zero observer/barrier", async () => {
  const abrain = createHome("legacy-absent", { authority: false });
  let ops = 0;
  let observed = 0;
  let barrierCalls = 0;
  const value = await abrainMod.withForegroundDirectCanonicalBusinessWrite(
    abrain,
    async () => {
      ops += 1;
      return "ok-legacy";
    },
    {
      observeConvergence: async () => {
        observed += 1;
        return { status: "ready", reason_code: "none" };
      },
      withBarrier: async (_home, op) => {
        barrierCalls += 1;
        return op();
      },
    },
  );
  assert(value === "ok-legacy", `value=${value}`);
  assert(ops === 1, `ops=${ops}`);
  assert(observed === 0, `legacy must not observe (got ${observed})`);
  assert(barrierCalls === 0, `legacy must not barrier (got ${barrierCalls})`);
});

await check("store-present: missing/pending/head mismatch/lock free all reject; op=0; tree zero delta", async () => {
  const cases = [
    { name: "missing", observe: { status: "unavailable", reason_code: "attestation_unavailable" } },
    { name: "pending", observe: { status: "blocked", reason_code: "attestation_not_ready" } },
    { name: "head-mismatch", observe: { status: "blocked", reason_code: "head_mismatch" } },
    { name: "lock-free", observe: { status: "blocked", reason_code: "authority_revoked" } },
  ];
  for (const item of cases) {
    const abrain = createHome(`reject-${item.name}`);
    const before = snapshotTree(abrain);
    let ops = 0;
    let code = null;
    try {
      await abrainMod.withForegroundDirectCanonicalBusinessWrite(
        abrain,
        async () => {
          ops += 1;
          fs.writeFileSync(path.join(abrain, "must-not-write"), "x\n");
          return "nope";
        },
        {
          observeConvergence: async () => item.observe,
        },
      );
    } catch (err) {
      code = err?.code ?? err?.message;
    }
    assert(ops === 0, `${item.name}: op ran`);
    assert(
      typeof code === "string" && code.startsWith("dcc_canonical_write_not_authorized:"),
      `${item.name}: closed code=${code}`,
    );
    assert(code.includes(item.observe.reason_code), `${item.name}: code=${code}`);
    assert(!code.includes(abrain), `${item.name}: path leaked`);
    assert(snapshotTree(abrain) === before, `${item.name}: tree delta`);
  }
});

await check("store-present ready + real OFD canonical mutation barrier: operation sees barrier held; no kick", async () => {
  const abrain = createHome("ready-barrier");
  let ops = 0;
  let heldInside = false;
  const value = await abrainMod.withForegroundDirectCanonicalBusinessWrite(
    abrain,
    async () => {
      ops += 1;
      heldInside = abrainMod.isForegroundCanonicalBusinessWriteBarrierHeld(abrain)
        || barrier.canonicalMutationBarrierHeld(abrain);
      return "wrote";
    },
    {
      // Authority observation is a hook here; the mutation barrier is the real OFD path.
      observeConvergence: async () => ({ status: "ready", reason_code: "none" }),
    },
  );
  assert(value === "wrote", `value=${value}`);
  assert(ops === 1, `ops=${ops}`);
  assert(heldInside === true, "operation must run with canonicalMutationBarrierHeld=true");
  assert(abrainMod.isForegroundCanonicalBusinessWriteBarrierHeld(abrain) === false,
    "barrier must release after gate returns");
});

await check("closedWriteDenial: free-form/path/secret reason collapses to unavailable; no leak", async () => {
  const abrain = createHome("deny-malformed-reason");
  const secretPath = path.join(abrain, ".state", "secret-token-do-not-leak");
  const cases = [
    { name: "path-bearing", reason_code: `blocked at ${abrain}/projects/x` },
    { name: "secret-bearing", reason_code: `ENOENT ${secretPath} token=super-secret-xyz` },
    { name: "free-form", reason_code: "something_custom_not_in_closed_set" },
    { name: "empty", reason_code: "" },
  ];
  for (const item of cases) {
    const before = snapshotTree(abrain);
    let ops = 0;
    let code = null;
    let message = null;
    try {
      await abrainMod.withForegroundDirectCanonicalBusinessWrite(
        abrain,
        async () => {
          ops += 1;
          return "nope";
        },
        {
          observeConvergence: async () => ({ status: "blocked", reason_code: item.reason_code }),
        },
      );
    } catch (err) {
      code = err?.code ?? null;
      message = err?.message ?? String(err);
    }
    assert(ops === 0, `${item.name}: op ran`);
    assert(code === "dcc_canonical_write_not_authorized:unavailable", `${item.name}: code=${code}`);
    assert(message === "dcc_canonical_write_not_authorized:unavailable", `${item.name}: message=${message}`);
    assert(!String(code).includes(abrain), `${item.name}: path leaked in code`);
    assert(!String(message).includes(abrain), `${item.name}: path leaked in message`);
    assert(!String(message).includes("super-secret"), `${item.name}: secret leaked`);
    assert(!String(message).includes(secretPath), `${item.name}: secret path leaked`);
    if (item.reason_code.length > 0) {
      assert(!String(message).includes(item.reason_code), `${item.name}: raw reason leaked`);
    }
    assert(snapshotTree(abrain) === before, `${item.name}: tree delta`);
  }
});

await check("inner second observation degradation rejects; op=0", async () => {
  const abrain = createHome("inner-degrade");
  let outer = 0;
  let ops = 0;
  let code = null;
  try {
    await abrainMod.withForegroundDirectCanonicalBusinessWrite(
      abrain,
      async () => {
        ops += 1;
        return "nope";
      },
      {
        observeConvergence: async () => {
          outer += 1;
          if (outer === 1) return { status: "ready", reason_code: "none" };
          return { status: "blocked", reason_code: "head_mismatch" };
        },
      },
    );
  } catch (err) {
    code = err?.code ?? err?.message;
  }
  assert(ops === 0, `ops=${ops}`);
  assert(outer === 2, `observations=${outer}`);
  assert(code === "dcc_canonical_write_not_authorized:unavailable", `code=${code}`);
});

await check("handler/source wiring: secret set/forget + vault init wrap gate; list/status not", async () => {
  const srcPath = path.join(root, "extensions/abrain/index.ts");
  const src = fs.readFileSync(srcPath, "utf8");
  const sf = ts.createSourceFile(srcPath, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  function textOf(node) {
    return src.slice(node.getStart(sf), node.getEnd());
  }

  function findFunction(name) {
    let found = null;
    function visit(node) {
      if (found) return;
      if (
        (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node))
        && node.name && ts.isIdentifier(node.name) && node.name.text === name
      ) {
        found = node;
        return;
      }
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (
            ts.isIdentifier(decl.name) && decl.name.text === name
            && decl.initializer
            && (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer))
          ) {
            found = decl.initializer;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return found;
  }

  const handleSecret = findFunction("handleSecret");
  assert(handleSecret, "handleSecret missing");
  const secretText = textOf(handleSecret);
  assert(secretText.includes("withForegroundDirectCanonicalBusinessWrite"), "handleSecret must gate writes");
  assert(secretText.includes("writeSecret"), "handleSecret writeSecret");
  assert(secretText.includes("forgetSecret"), "handleSecret forgetSecret");
  // list path must not be wrapped as the only gate target — gate appears only around write/forget calls.
  const listIdx = secretText.indexOf('sub === "list"');
  const setIdx = secretText.indexOf('sub === "set"');
  const forgetIdx = secretText.indexOf('sub === "forget"');
  assert(listIdx >= 0 && setIdx >= 0 && forgetIdx >= 0, "secret subcommands missing");
  const listSlice = secretText.slice(listIdx, Math.min(secretText.length, listIdx + 800));
  assert(!listSlice.includes("withForegroundDirectCanonicalBusinessWrite"), "list must not gate");

  const handleInit = findFunction("handleInit");
  assert(handleInit, "handleInit missing");
  const initText = textOf(handleInit);
  assert(initText.includes("withForegroundDirectCanonicalBusinessWrite"), "handleInit must gate runInit");
  assert(initText.includes("runInit"), "handleInit must call runInit");

  const localGuard = findFunction("assertVaultLocalSafety");
  assert(localGuard, "assertVaultLocalSafety missing");
  const guardText = textOf(localGuard);
  assert(guardText.includes("assertAbrainLocalWriteSafety"), "local safety still required");

  // Gate export itself must not kick / await Path A.
  const gate = findFunction("withForegroundDirectCanonicalBusinessWrite");
  assert(gate, "gate export missing");
  const gateText = textOf(gate);
  assert(!gateText.includes("kickCanonical"), "gate must not kick");
  assert(!gateText.includes("getCanonicalStartupPromise"), "gate must not Path A await");
  assert(gateText.includes("observeForegroundCanonicalConvergence") || gateText.includes("observe("),
    "gate must observe");
  assert(gateText.includes("withCanonicalMutationBarrier") || gateText.includes("barrier("),
    "gate must barrier");
});

await check("memory migrate --go store-present capture_only: helper rejects; handler never runMigrationGo; zero tree delta", async () => {
  assert(typeof memoryMod.decideMemoryMigrateGoAdmission === "function", "helper export missing");
  const present = createHome("migrate-go-present");
  const decision = memoryMod.decideMemoryMigrateGoAdmission(present);
  assert(decision.allowed === false, JSON.stringify(decision));
  assert(decision.reason === "store_present_capture_only", JSON.stringify(decision));
  assert(/capture_only|store-present|DCC/i.test(decision.message || ""), decision.message);
  assert(/post-cutover v1/i.test(decision.message || ""), `message must state post-cutover v1: ${decision.message}`);
  assert(/do not delete the authority store/i.test(decision.message || ""), `message must forbid store deletion bypass: ${decision.message}`);
  assert(/daemon-owned path/i.test(decision.message || ""), `message must point to future daemon-owned path: ${decision.message}`);
  assert(!/store-absent legacy window/i.test(decision.message || ""), `message must not suggest store-absent bypass: ${decision.message}`);

  const absent = createHome("migrate-go-absent", { authority: false });
  const legacy = memoryMod.decideMemoryMigrateGoAdmission(absent);
  assert(legacy.allowed === true && legacy.reason === "legacy_allowed", JSON.stringify(legacy));

  // Handler wiring + integration: register command, invoke --go, prove no tree write.
  const commands = new Map();
  memoryMod.default({
    registerCommand(name, options) { commands.set(name, options); },
    // Other activate surface may call more APIs; provide no-ops.
    on() {},
    registerTool() {},
    registerHandler() {},
  });
  const memoryCmd = commands.get("memory");
  assert(memoryCmd && typeof memoryCmd.handler === "function", "memory command not registered");

  const src = fs.readFileSync(path.join(root, "extensions/memory/index.ts"), "utf8");
  assert(src.includes("decideMemoryMigrateGoAdmission"), "handler source must call helper");
  // Ensure go path consults admission before runMigrationGo.
  const goBlock = src.slice(src.indexOf("if (goMode)"), src.indexOf("if (goMode)") + 900);
  assert(goBlock.includes("decideMemoryMigrateGoAdmission"), "goMode must call admission helper");
  const admissionIdx = goBlock.indexOf("decideMemoryMigrateGoAdmission");
  const runIdx = goBlock.indexOf("runMigrationGo");
  assert(admissionIdx >= 0 && runIdx > admissionIdx, "admission must precede runMigrationGo");

  // Integration: three-layer strict binding + pensieve canary must reach capture_only
  // admission (not earlier binding refusal). Zero delta on ABRAIN + project trees.
  const { spawnSync } = await import("node:child_process");
  const projectId = "migrate-capture-only";
  const project = path.join(tmp, "migrate-bound-project");
  fs.mkdirSync(project, { recursive: true });
  const gitInit = spawnSync("git", ["init", "-b", "main"], { cwd: project, encoding: "utf8" });
  assert(gitInit.status === 0, `project git init failed: ${gitInit.stderr}`);
  spawnSync("git", ["-C", project, "config", "user.email", "dcc-smoke@example.com"], { encoding: "utf8" });
  spawnSync("git", ["-C", project, "config", "user.name", "dcc-smoke"], { encoding: "utf8" });
  fs.writeFileSync(
    path.join(project, ".abrain-project.json"),
    `${JSON.stringify({ schema_version: 1, project_id: projectId }, null, 2)}\n`,
  );
  const pensieveDir = path.join(project, ".pensieve");
  fs.mkdirSync(pensieveDir, { recursive: true });
  const canaryRel = "canary-entry.md";
  const canaryPath = path.join(pensieveDir, canaryRel);
  fs.writeFileSync(canaryPath, [
    "---",
    "id: canary-entry",
    "title: Capture Only Canary",
    "type: knowledge",
    "---",
    "",
    "canary body must survive capture_only refuse",
    "",
  ].join("\n"));
  spawnSync("git", ["-C", project, "add", ".abrain-project.json", ".pensieve"], { encoding: "utf8" });
  spawnSync("git", ["-C", project, "commit", "-m", "seed bound project + pensieve canary"], { encoding: "utf8" });

  // Registry (abrain tracked layer).
  const registryDir = path.join(present, "projects", projectId);
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "_project.json"),
    `${JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      created_at: "2026-07-30T00:00:00.000+08:00",
      updated_at: "2026-07-30T00:00:00.000+08:00",
    }, null, 2)}\n`,
  );
  // Local map (path authorization).
  const localMapDir = path.join(present, ".state", "projects");
  fs.mkdirSync(localMapDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(localMapDir, "local-map.json"),
    `${JSON.stringify({
      schema_version: 1,
      projects: {
        [projectId]: {
          paths: [{
            path: project,
            first_seen: "2026-07-30T00:00:00.000+08:00",
            last_seen: "2026-07-30T00:00:00.000+08:00",
            confirmed_at: "2026-07-30T00:00:00.000+08:00",
          }],
        },
      },
    }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const prevRoot = process.env.ABRAIN_ROOT;
  process.env.ABRAIN_ROOT = present;
  const beforeAbrain = snapshotTree(present);
  const beforeProject = snapshotTree(project);
  const notes = [];
  try {
    await memoryCmd.handler("migrate --go", {
      cwd: project,
      ui: {
        notify(message, type) { notes.push({ message, type }); },
      },
    });
  } finally {
    if (prevRoot === undefined) delete process.env.ABRAIN_ROOT;
    else process.env.ABRAIN_ROOT = prevRoot;
  }
  assert(snapshotTree(present) === beforeAbrain, "store-present migrate --go mutated abrain tree");
  assert(snapshotTree(project) === beforeProject, "store-present migrate --go mutated project tree");
  assert(fs.existsSync(canaryPath), "pensieve canary must remain");
  const joined = notes.map((n) => n.message).join("\n");
  assert(!/movedCount|migrate\(in\)|Migration complete/i.test(joined), `unexpected success: ${joined}`);
  // Must reach capture_only admission — earlier binding refusal is not acceptable.
  assert(!/project binding status=/i.test(joined), `must not stop at binding refusal: ${joined}`);
  assert(/capture_only|store-present|DCC/i.test(joined), `expected capture_only error: ${joined}`);
  assert(/post-cutover v1/i.test(joined), `expected post-cutover wording: ${joined}`);
  assert(!/store-absent legacy window/i.test(joined), `must not suggest store-absent bypass: ${joined}`);
  assert(notes.some((n) => n.type === "error"), `capture_only must notify as error: ${JSON.stringify(notes)}`);
});

console.log(`\n${passed} checks passed`);
