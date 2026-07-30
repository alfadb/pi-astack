#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { interopDefault: true });
const authority = await jiti.import(path.join(repoRoot, "extensions/sediment/local-executor-authority.ts"));
const worker = await jiti.import(path.join(repoRoot, "extensions/sediment/worker-rpc.ts"));
const mutationAuthority = await jiti.import(path.join(repoRoot, "extensions/_shared/canonical-mutation-authority.ts"));
const edge = await jiti.import(path.join(repoRoot, "extensions/sediment/edge-protocol-shadow.ts"));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-lsea-worker-"));
process.once("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
const abrain = path.join(tmp, "abrain");
const legacyAbrain = path.join(tmp, "legacy-abrain");
const malformedLegacyAbrain = path.join(tmp, "malformed-legacy-abrain");
const project = path.join(tmp, "project");
const copyStore = path.join(tmp, "copy-store");
for (const dir of [abrain, legacyAbrain, malformedLegacyAbrain, project, copyStore]) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
fs.writeFileSync(path.join(project, "baseline.txt"), "baseline\n", { mode: 0o600 });
for (const args of [
  ["init", "-q", project],
  ["-C", project, "add", "baseline.txt"],
  ["-C", project, "-c", "user.name=LSEA Smoke", "-c", "user.email=lsea@example.invalid", "commit", "-qm", "baseline"],
]) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  assert(result.status === 0, `git fixture failed: ${args.join(" ")} ${result.stderr}`);
}
const authorityDir = path.join(abrain, ".state", "sediment", "local-executor-authority");
const authorityPath = path.join(authorityDir, "authority.json");
const lockPath = path.join(authorityDir, "authority.lock");
const epoch = "7";
const holderNonce = hex64("holder");
const stateDirKey = hex64("state-dir");
const runNonce = hex64("run");

function authorityRecord(overrides = {}) {
  return {
    schema: "pi-router/local-sediment-executor-authority/v1",
    local_executor_epoch: epoch,
    mode: "held",
    holder_kind: "daemon",
    holder_nonce: holderNonce,
    state_dir_key: stateDirKey,
    run_nonce: runNonce,
    ...overrides,
  };
}

function writeAuthority(record = authorityRecord()) {
  fs.mkdirSync(authorityDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(lockPath, "", { mode: 0o600 });
  fs.chmodSync(lockPath, 0o600);
  fs.writeFileSync(authorityPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.chmodSync(authorityPath, 0o600);
}

function replaceAuthority(record = authorityRecord()) {
  const temp = path.join(authorityDir, `authority.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, authorityPath);
}

function expectation(overrides = {}) {
  return {
    local_executor_epoch: epoch,
    local_executor_holder_nonce: holderNonce,
    ...overrides,
  };
}

function admit(opts = {}) {
  return authority.admitLocalExecutorAuthority({
    abrainHome: abrain,
    expectation: opts.expectation ?? expectation(),
    expectedHolderKind: opts.expectedHolderKind ?? "daemon",
    observation: opts.observation ?? { observeLock: () => "held" },
  });
}

function expectAuthorityCode(fn, expected) {
  let code = null;
  try {
    fn();
  } catch (error) {
    code = error?.code;
  }
  assert(code === expected, `expected ${expected}, got ${code}`);
}

function gitIdentity() {
  const result = spawnSync("git", ["-C", project, "rev-parse", "HEAD", "HEAD^{tree}"], {
    encoding: "utf8",
  });
  assert(result.status === 0, `git identity failed: ${result.stderr}`);
  return result.stdout.trim();
}

function snapshotTree(root) {
  const rows = [];
  const walk = (dir, relative = "") => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = path.join(relative, name).split(path.sep).join("/");
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) {
        rows.push(`l:${rel}:${fs.readlinkSync(abs)}`);
      } else if (stat.isDirectory()) {
        rows.push(`d:${rel}:${stat.mode & 0o777}`);
        walk(abs, rel);
      } else if (stat.isFile()) {
        rows.push(`f:${rel}:${stat.mode & 0o777}:${crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex")}`);
      } else {
        rows.push(`o:${rel}:${stat.mode & 0o777}`);
      }
    }
  };
  walk(root);
  return rows.join("\n");
}

function taskManifest(overrides = {}) {
  const terminal = hex64("rejected-terminal");
  return {
    schema: "pi-astack/sediment-worker-task/v1",
    request_id: hex64("rejected-request"),
    terminal_record_id: terminal,
    session_id: "lsea-rejected-session",
    owner_project_root: fs.realpathSync.native(project),
    owner_key: crypto.createHash("sha256").update(fs.realpathSync.native(project)).digest("hex"),
    sidecar_path: path.join(copyStore, "records", terminal, "sidecar.bin"),
    content_id: hex64("missing-sidecar"),
    task_kind: "terminal_witness",
    c6: { session_id: "lsea-rejected-session", turn_id: 1 },
    ...overrides,
  };
}

function maintenanceRequest(overrides = {}) {
  return {
    schema: "pi-astack/sediment-worker-maintenance/v1",
    request_id: hex64("rejected-maintenance"),
    budget_ms: 60_000,
    kind: "publication_outbox",
    ...overrides,
  };
}

console.log("LSEA worker-first minimum admission");

await check("rollout: absent store + absent pair is the only legacy manifest case", async () => {
  const legacy = authority.admitLocalExecutorAuthority({
    abrainHome: legacyAbrain,
    expectation: {},
    expectedHolderKind: "daemon",
  });
  assert(legacy.regime === "legacy", `regime=${legacy.regime}`);
  expectAuthorityCode(() => authority.admitLocalExecutorAuthority({
    abrainHome: legacyAbrain,
    expectation: expectation(),
    expectedHolderKind: "daemon",
  }), "local_executor_authority_unavailable");

  writeAuthority();
  expectAuthorityCode(() => authority.admitLocalExecutorAuthority({
    abrainHome: abrain,
    expectation: {},
    expectedHolderKind: "daemon",
    observation: { observeLock: () => "held" },
  }), "local_executor_authority_unavailable");
  expectAuthorityCode(() => authority.validateLocalExecutorAuthorityManifestExpectation({
    local_executor_epoch: epoch,
  }), "local_executor_authority_unavailable");
});

await check("legacy .state anomalies intentionally narrow compatibility and fail closed", async () => {
  const statePath = path.join(malformedLegacyAbrain, ".state");
  fs.writeFileSync(statePath, "not-a-directory\n", { mode: 0o600 });
  expectAuthorityCode(() => authority.admitLocalExecutorAuthority({
    abrainHome: malformedLegacyAbrain,
    expectation: {},
    expectedHolderKind: "daemon",
  }), "local_executor_authority_unavailable");
  assert(authority.classifyForegroundLocalExecutorPosture(malformedLegacyAbrain) === "capture_only",
    "non-directory legacy .state must be capture-only");

  if (process.platform !== "win32") {
    fs.rmSync(statePath);
    const foreignState = path.join(tmp, "foreign-state");
    fs.mkdirSync(foreignState);
    fs.symlinkSync(foreignState, statePath);
    expectAuthorityCode(() => authority.admitLocalExecutorAuthority({
      abrainHome: malformedLegacyAbrain,
      expectation: {},
      expectedHolderKind: "daemon",
    }), "local_executor_authority_unavailable");
    assert(authority.classifyForegroundLocalExecutorPosture(malformedLegacyAbrain) === "capture_only",
      "symlink legacy .state must be capture-only");
  }
});

await check("strict schema rejects every missing field, unknown, duplicate, bad epoch, nonce, and mode pairing", async () => {
  const complete = authorityRecord();
  for (const field of Object.keys(complete)) {
    const missing = { ...complete };
    delete missing[field];
    writeAuthority(missing);
    expectAuthorityCode(() => admit(), "local_executor_authority_unavailable");
  }

  writeAuthority({ ...authorityRecord(), unknown: "x" });
  expectAuthorityCode(() => admit(), "local_executor_authority_unavailable");

  const duplicate = `{"schema":"pi-router/local-sediment-executor-authority/v1","schema":"pi-router/local-sediment-executor-authority/v1","local_executor_epoch":"7","mode":"held","holder_kind":"daemon","holder_nonce":"${holderNonce}","state_dir_key":"${stateDirKey}","run_nonce":"${runNonce}"}\n`;
  fs.writeFileSync(authorityPath, duplicate, { mode: 0o600 });
  expectAuthorityCode(() => admit(), "local_executor_authority_unavailable");

  for (const badEpoch of ["0", "01", "+1", "18446744073709551616"]) {
    writeAuthority(authorityRecord({ local_executor_epoch: badEpoch }));
    expectAuthorityCode(() => admit(), "local_executor_authority_unavailable");
  }
  writeAuthority(authorityRecord({ holder_nonce: holderNonce.toUpperCase() }));
  expectAuthorityCode(() => admit(), "local_executor_authority_unavailable");
  writeAuthority(authorityRecord({ mode: "free", holder_kind: "daemon" }));
  expectAuthorityCode(() => admit(), "local_executor_authority_unavailable");
});

await check("Unix strict files reject non-0600 permissions", async () => {
  if (process.platform === "win32") {
    console.log("        skip POSIX mode checks on Windows");
    return;
  }
  writeAuthority();
  fs.chmodSync(authorityPath, 0o640);
  expectAuthorityCode(() => admit(), "local_executor_authority_unavailable");

  writeAuthority();
  fs.chmodSync(lockPath, 0o640);
  expectAuthorityCode(() => authority.admitLocalExecutorAuthority({
    abrainHome: abrain,
    expectation: expectation(),
    expectedHolderKind: "daemon",
    observation: { platform: "linux" },
  }), "local_executor_authority_unavailable");
});

await check("read-lock-read rejects byte-restored authority ABA", async () => {
  writeAuthority();
  expectAuthorityCode(() => admit({
    observation: {
      observeLock() {
        replaceAuthority(authorityRecord({ local_executor_epoch: "8" }));
        replaceAuthority(authorityRecord());
        return "held";
      },
    },
  }), "local_executor_authority_unavailable");
});

await check("strict admission returns exact stale/revoked/unavailable closed codes", async () => {
  writeAuthority();
  const accepted = admit();
  assert(accepted.regime === "strict" && accepted.local_executor_epoch === epoch, "matching strict admission");
  expectAuthorityCode(() => admit({ expectation: expectation({ local_executor_epoch: "8" }) }), "local_executor_authority_stale");
  expectAuthorityCode(() => admit({ expectation: expectation({ local_executor_holder_nonce: hex64("other") }) }), "local_executor_authority_stale");
  expectAuthorityCode(() => admit({ observation: { observeLock: () => "free" } }), "local_executor_authority_revoked");
  writeAuthority(authorityRecord({ mode: "draining" }));
  expectAuthorityCode(() => admit(), "local_executor_authority_revoked");
  writeAuthority(authorityRecord({ holder_kind: "foreground" }));
  expectAuthorityCode(() => admit(), "local_executor_authority_revoked");
  fs.writeFileSync(authorityPath, "not-json\n", { mode: 0o600 });
  expectAuthorityCode(() => admit(), "local_executor_authority_unavailable");
});

await check("Unix native flock observation sees holder and release without mutation", async () => {
  if (process.platform !== "linux" || !fs.existsSync("/usr/bin/flock")) {
    console.log("        skip native flock (non-Linux runner)");
    return;
  }
  writeAuthority();
  const before = snapshotTree(abrain);
  const holder = spawn("/usr/bin/flock", ["-F", "-x", lockPath, "/bin/sleep", "20"], {
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 5_000;
    let accepted = false;
    while (Date.now() < deadline) {
      try {
        const result = authority.admitLocalExecutorAuthority({
          abrainHome: abrain,
          expectation: expectation(),
          expectedHolderKind: "daemon",
        });
        if (result.regime === "strict") {
          accepted = true;
          break;
        }
      } catch (error) {
        if (error?.code !== "local_executor_authority_revoked") throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert(accepted, "native flock holder was not observed");
    assert(snapshotTree(abrain) === before, "native observation mutated authority tree");

    let passCalls = 0;
    const strictTask = await worker.runSedimentWorkerTask(JSON.stringify(taskManifest(expectation())), {
      resolveAbrainHome: () => abrain,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async () => ({}),
      runAgentEndPass: async () => { passCalls += 1; },
      env: {
        ...process.env,
        PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
        PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([fs.realpathSync.native(project)]),
      },
    });
    assert(strictTask.error_code === "sidecar_unreadable", `strict task entry code=${strictTask.error_code}`);
    assert(passCalls === 0, "missing sidecar unexpectedly entered pass");

    const staleTask = await worker.runSedimentWorkerTask(
      JSON.stringify(taskManifest(expectation({ local_executor_epoch: "8" }))),
      {
        resolveAbrainHome: () => abrain,
        resolveExecutionOwner: () => "daemon",
        loadSessionCheckpoint: async () => ({}),
        runAgentEndPass: async () => { passCalls += 1; },
        env: {
          ...process.env,
          PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
          PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([fs.realpathSync.native(project)]),
        },
      },
    );
    assert(staleTask.error_code === "local_executor_authority_stale", `stale task=${JSON.stringify(staleTask)}`);
    assert(staleTask.retryable === true && staleTask.restart_child === false, "stale task must globally pause without child restart");

    writeAuthority(authorityRecord({ mode: "draining" }));
    const revokedTask = await worker.runSedimentWorkerTask(JSON.stringify(taskManifest(expectation())), {
      resolveAbrainHome: () => abrain,
      resolveExecutionOwner: () => "daemon",
      loadSessionCheckpoint: async () => ({}),
      runAgentEndPass: async () => { passCalls += 1; },
      env: {
        ...process.env,
        PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
        PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([fs.realpathSync.native(project)]),
      },
    });
    assert(revokedTask.error_code === "local_executor_authority_revoked", `revoked task=${JSON.stringify(revokedTask)}`);
    assert(revokedTask.retryable === true && revokedTask.restart_child === false, "revoked task must globally pause without child restart");
    writeAuthority();

    let countCalls = 0;
    const strictMaintenance = await worker.runSedimentWorkerMaintenance(
      JSON.stringify(maintenanceRequest(expectation())),
      {
        resolveAbrainHome: () => abrain,
        resolveEffectiveExecutionOwner: () => "daemon",
        countPublicationOutboxPending: async () => { countCalls += 1; return 0; },
        countPublicationOutboxFailed: async () => { countCalls += 1; return 0; },
        drainKnowledgePublicationOutbox: async () => {
          throw new Error("empty strict maintenance must not drain");
        },
        env: {
          ...process.env,
          PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
          PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([fs.realpathSync.native(project)]),
        },
      },
    );
    assert(strictMaintenance.status === "idle", `strict maintenance=${JSON.stringify(strictMaintenance)}`);
    assert(countCalls === 2, `strict maintenance count calls=${countCalls}`);

    let pendingReads = 0;
    let failedReads = 0;
    let repairSawContext = false;
    let drainSawContext = false;
    const strictRepairDrain = await worker.runSedimentWorkerMaintenance(
      JSON.stringify(maintenanceRequest({
        ...expectation(),
        request_id: hex64("strict-repair-drain-context"),
        repair_policy: "legacy_world_project_stamp",
        repair_limit: 1,
      })),
      {
        resolveAbrainHome: () => abrain,
        resolveEffectiveExecutionOwner: () => "daemon",
        countPublicationOutboxPending: async () => {
          pendingReads += 1;
          return pendingReads === 1 ? 0 : pendingReads === 2 ? 1 : 0;
        },
        countPublicationOutboxFailed: async () => {
          failedReads += 1;
          return failedReads === 1 ? 1 : 0;
        },
        repairLegacyWorldProjectStampFailures: async () => {
          await mutationAuthority.assertCanonicalMutationAuthorized(abrain);
          repairSawContext = true;
          return { status: "repaired", repaired: 1 };
        },
        drainKnowledgePublicationOutbox: async () => {
          await mutationAuthority.assertCanonicalMutationAuthorized(abrain);
          drainSawContext = true;
          return { status: "completed", processed: 1, drained: 1, terminalFailed: 0, pending: 0 };
        },
        env: {
          ...process.env,
          PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
          PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([fs.realpathSync.native(project)]),
        },
      },
    );
    assert(strictRepairDrain.status === "drained", `strict repair/drain=${JSON.stringify(strictRepairDrain)}`);
    assert(repairSawContext && drainSawContext, "maintenance repair/drain missed mutation authority context");
  } finally {
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("close", resolve));
  }
  const releaseDeadline = Date.now() + 5_000;
  let released = false;
  while (Date.now() < releaseDeadline) {
    try {
      authority.admitLocalExecutorAuthority({
        abrainHome: abrain,
        expectation: expectation(),
        expectedHolderKind: "daemon",
      });
    } catch (error) {
      if (error?.code === "local_executor_authority_revoked") {
        released = true;
        break;
      }
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(released, "native flock did not become observable as released");
});

await check("mid-operation authority revoke maps task/maintenance to local_executor_authority_revoked", async () => {
  writeAuthority();
  const sessionId = "lsea-mid-revoke-session";
  const terminal = hex64("mid-pass-authority-revoked-terminal");
  const messages = [
    { role: "user", content: [{ type: "text", text: "mid revoke" }] },
    { role: "assistant", content: [{ type: "text", text: "acked" }], stopReason: "stop" },
  ];
  const messagesJson = JSON.stringify(messages);
  const contentId = edge.computePayloadDigest(messagesJson);
  const body = edge.buildEdgeSourceEnvelopeBody({
    contentId,
    sessionId,
    messageCount: messages.length,
    messagesJson,
  });
  const sidecarDir = path.join(copyStore, "records", terminal);
  fs.mkdirSync(sidecarDir, { recursive: true, mode: 0o700 });
  const sidecarPath = path.join(sidecarDir, "sidecar.bin");
  fs.writeFileSync(sidecarPath, body, { mode: 0o600 });
  const ownerRoot = fs.realpathSync.native(project);

  const revokedMidPass = await worker.runSedimentWorkerTask(JSON.stringify({
    ...taskManifest({
      ...expectation(),
      request_id: hex64("mid-pass-authority-revoked"),
      terminal_record_id: terminal,
      session_id: sessionId,
      owner_project_root: ownerRoot,
      owner_key: crypto.createHash("sha256").update(ownerRoot).digest("hex"),
      sidecar_path: sidecarPath,
      content_id: contentId,
      c6: { session_id: sessionId, turn_id: 1 },
      leaf_tip: {
        id: "leaf-mid-revoke",
        parentId: null,
        type: "message",
        timestampUtc: "2026-07-30T00:00:00.000Z",
      },
    }),
  }), {
    resolveAbrainHome: () => abrain,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => {
      throw Object.assign(new Error(mutationAuthority.CANONICAL_MUTATION_NOT_AUTHORIZED), {
        code: mutationAuthority.CANONICAL_MUTATION_NOT_AUTHORIZED,
        name: "CanonicalMutationAuthorityError",
      });
    },
    env: {
      ...process.env,
      PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
      PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([ownerRoot]),
    },
  });
  assert(revokedMidPass.error_code === "local_executor_authority_revoked", `mid-pass revoke=${JSON.stringify(revokedMidPass)}`);
  assert(revokedMidPass.retryable === true, "mid-pass authority revoke must be retryable");
  assert(revokedMidPass.error_code !== "pipeline_threw", "mid-pass authority revoke must not degrade to pipeline_threw");

  const revokedRepair = await worker.runSedimentWorkerMaintenance(
    JSON.stringify(maintenanceRequest({
      ...expectation(),
      request_id: hex64("mid-repair-authority-revoked"),
      repair_policy: "legacy_world_project_stamp",
      repair_limit: 1,
    })),
    {
      resolveAbrainHome: () => abrain,
      resolveEffectiveExecutionOwner: () => "daemon",
      countPublicationOutboxPending: async () => 0,
      countPublicationOutboxFailed: async () => 1,
      repairLegacyWorldProjectStampFailures: async () => {
        throw Object.assign(new Error(mutationAuthority.CANONICAL_MUTATION_NOT_AUTHORIZED), {
          code: mutationAuthority.CANONICAL_MUTATION_NOT_AUTHORIZED,
          name: "CanonicalMutationAuthorityError",
        });
      },
      drainKnowledgePublicationOutbox: async () => {
        throw new Error("repair revoke must not reach drain");
      },
      env: {
        ...process.env,
        PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
        PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([ownerRoot]),
      },
    },
  );
  assert(revokedRepair.status === "failed", `repair revoke status=${revokedRepair.status}`);
  assert(revokedRepair.error_code === "local_executor_authority_revoked", `repair revoke=${JSON.stringify(revokedRepair)}`);
  assert(revokedRepair.retryable === true && revokedRepair.restart_child === false, "repair revoke must be retryable without child restart");
  assert(revokedRepair.error_code !== "publication_repair_failed", "repair revoke must not map to publication_repair_failed");

  const revokedDrain = await worker.runSedimentWorkerMaintenance(
    JSON.stringify(maintenanceRequest({
      ...expectation(),
      request_id: hex64("mid-drain-authority-revoked"),
      repair_policy: "none",
    })),
    {
      resolveAbrainHome: () => abrain,
      resolveEffectiveExecutionOwner: () => "daemon",
      countPublicationOutboxPending: async () => 1,
      countPublicationOutboxFailed: async () => 0,
      drainKnowledgePublicationOutbox: async () => {
        throw Object.assign(new Error(mutationAuthority.CANONICAL_MUTATION_NOT_AUTHORIZED), {
          code: mutationAuthority.CANONICAL_MUTATION_NOT_AUTHORIZED,
          name: "CanonicalMutationAuthorityError",
        });
      },
      env: {
        ...process.env,
        PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
        PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([ownerRoot]),
      },
    },
  );
  assert(revokedDrain.status === "failed", `drain revoke status=${revokedDrain.status}`);
  assert(revokedDrain.error_code === "local_executor_authority_revoked", `drain revoke=${JSON.stringify(revokedDrain)}`);
  assert(revokedDrain.retryable === true && revokedDrain.restart_child === false, "drain revoke must be retryable without child restart");
  assert(revokedDrain.error_code !== "publication_drain_failed", "drain revoke must not map to publication_drain_failed");
});

await check("Windows observer distinguishes sharing violation from ACL/unavailable", async () => {
  const errno = (code) => Object.assign(new Error(code), { code });
  writeAuthority();
  const before = snapshotTree(abrain);
  const held = admit({
    observation: {
      platform: "win32",
      openWindowsLock() { throw errno("EBUSY"); },
    },
  });
  assert(held.regime === "strict", "win32 EBUSY sharing violation must mean held");
  for (const code of ["EACCES", "EPERM", "ENOENT", "UNKNOWN"]) {
    expectAuthorityCode(() => admit({
      observation: {
        platform: "win32",
        openWindowsLock() { throw errno(code); },
      },
    }), "local_executor_authority_unavailable");
  }
  expectAuthorityCode(() => admit({
    observation: { platform: "win32", openWindowsLock: fs.openSync },
  }), "local_executor_authority_revoked");
  assert(snapshotTree(abrain) === before, "Windows classification mutated authority tree");

  fs.rmSync(lockPath);
  fs.symlinkSync(path.basename(authorityPath), lockPath);
  expectAuthorityCode(() => admit({
    observation: {
      platform: "win32",
      openWindowsLock() { throw errno("EBUSY"); },
    },
  }), "local_executor_authority_unavailable");
  fs.rmSync(lockPath);
  fs.mkdirSync(lockPath);
  expectAuthorityCode(() => admit({
    observation: {
      platform: "win32",
      openWindowsLock() { throw errno("EBUSY"); },
    },
  }), "local_executor_authority_unavailable");
  fs.rmSync(lockPath, { recursive: true, force: true });
  writeAuthority();
});

await check("foreground: store-exists capture-only (held/draining/corrupt/free); missing legacy", async () => {
  writeAuthority();
  assert(authority.classifyForegroundLocalExecutorPosture(abrain, {
    observeLock: () => "held",
  }) === "capture_only", "held must be capture-only");
  writeAuthority(authorityRecord({ mode: "draining" }));
  assert(authority.classifyForegroundLocalExecutorPosture(abrain, {
    observeLock: () => "held",
  }) === "capture_only", "draining must be capture-only");
  fs.writeFileSync(authorityPath, "{}\n", { mode: 0o600 });
  assert(authority.classifyForegroundLocalExecutorPosture(abrain, {
    observeLock: () => "held",
  }) === "capture_only", "corrupt must be capture-only");
  writeAuthority(authorityRecord({ mode: "free", holder_kind: "none" }));
  assert(authority.classifyForegroundLocalExecutorPosture(abrain, {
    observeLock: () => "held",
  }) === "capture_only", "free + held lock must remain capture-only");
  assert(authority.classifyForegroundLocalExecutorPosture(abrain, {
    observeLock: () => "free",
  }) === "capture_only", "free + unlocked must remain capture-only after authority activation");
  assert(authority.classifyForegroundLocalExecutorPosture(legacyAbrain) === "legacy", "missing store must be legacy");
});

await check("task rejection occurs before receipt/checkpoint/L1/outbox/Git/audit mutation", async () => {
  writeAuthority();
  const beforeAbrain = snapshotTree(abrain);
  const beforeProject = snapshotTree(project);
  const beforeGit = gitIdentity();
  let passCalls = 0;
  const result = await worker.runSedimentWorkerTask(JSON.stringify(taskManifest()), {
    resolveAbrainHome: () => abrain,
    resolveExecutionOwner: () => "daemon",
    loadSessionCheckpoint: async () => ({}),
    runAgentEndPass: async () => { passCalls += 1; },
    env: {
      ...process.env,
      PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
      PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([fs.realpathSync.native(project)]),
    },
  });
  assert(result.error_code === "local_executor_authority_unavailable", `task code=${result.error_code}`);
  assert(result.status === "failed" && result.settled === false, "task rejection shape");
  assert(result.retryable === true && result.restart_child === false, "authority rejection must be retryable without restart");
  assert(passCalls === 0, "rejected task entered pass");
  assert(snapshotTree(abrain) === beforeAbrain, "rejected task changed abrain artifacts");
  assert(snapshotTree(project) === beforeProject, "rejected task changed project/Git artifacts");
  assert(gitIdentity() === beforeGit, "rejected task changed Git HEAD/tree");
});

await check("maintenance rejection occurs before count/drain/repair mutation", async () => {
  writeAuthority();
  const beforeAbrain = snapshotTree(abrain);
  const beforeProject = snapshotTree(project);
  const beforeGit = gitIdentity();
  let countCalls = 0;
  let drainCalls = 0;
  const progressEvents = [];
  const result = await worker.runSedimentWorkerMaintenance(JSON.stringify(maintenanceRequest()), {
    resolveAbrainHome: () => abrain,
    resolveEffectiveExecutionOwner: () => "daemon",
    countPublicationOutboxPending: async () => { countCalls += 1; return 0; },
    countPublicationOutboxFailed: async () => { countCalls += 1; return 0; },
    drainKnowledgePublicationOutbox: async () => {
      drainCalls += 1;
      return { status: "completed", processed: 0, drained: 0, terminalFailed: 0, pending: 0 };
    },
    onProgress(event) { progressEvents.push(event); },
    env: {
      ...process.env,
      PI_ASTACK_SEDIMENT_WORKER_COPY_STORE_ROOT: copyStore,
      PI_ASTACK_SEDIMENT_WORKER_ALLOWED_OWNER_ROOTS: JSON.stringify([fs.realpathSync.native(project)]),
    },
  });
  assert(result.error_code === "local_executor_authority_unavailable", `maintenance code=${result.error_code}`);
  assert(result.retryable === true && result.restart_child === false, "maintenance authority rejection shape");
  assert(progressEvents.length > 0, "process-local maintenance progress may occur before durable admission");
  assert(countCalls === 0 && drainCalls === 0, "rejected maintenance entered count/drain");
  assert(snapshotTree(abrain) === beforeAbrain, "rejected maintenance changed abrain artifacts");
  assert(snapshotTree(project) === beforeProject, "rejected maintenance changed project artifacts");
  assert(gitIdentity() === beforeGit, "rejected maintenance changed Git HEAD/tree");
});

await check("task and maintenance manifests reject each required field omission", async () => {
  const completeTask = taskManifest(expectation());
  for (const field of Object.keys(completeTask)) {
    const missing = { ...completeTask };
    delete missing[field];
    let rejected = false;
    try { worker.validateSedimentWorkerManifest(missing); } catch { rejected = true; }
    assert(rejected, `task manifest accepted missing ${field}`);
  }
  for (const c6Field of ["session_id", "turn_id"]) {
    const missing = { ...completeTask, c6: { ...completeTask.c6 } };
    delete missing.c6[c6Field];
    let rejected = false;
    try { worker.validateSedimentWorkerManifest(missing); } catch { rejected = true; }
    assert(rejected, `task manifest accepted missing c6.${c6Field}`);
  }

  const completeMaintenance = maintenanceRequest(expectation());
  for (const field of [
    "schema", "request_id", "kind", "local_executor_epoch", "local_executor_holder_nonce",
  ]) {
    const missing = { ...completeMaintenance };
    delete missing[field];
    let rejected = false;
    try { worker.validateSedimentWorkerMaintenanceRequest(missing); } catch { rejected = true; }
    assert(rejected, `maintenance manifest accepted missing ${field}`);
  }
});

await check("paired fields validate on task and maintenance manifests", async () => {
  for (const validate of [
    () => worker.validateSedimentWorkerManifest(taskManifest({ local_executor_epoch: epoch })),
    () => worker.validateSedimentWorkerMaintenanceRequest(maintenanceRequest({ local_executor_holder_nonce: holderNonce })),
    () => worker.validateSedimentWorkerManifest(taskManifest({
      local_executor_epoch: 7,
      local_executor_holder_nonce: holderNonce,
    })),
    () => worker.validateSedimentWorkerMaintenanceRequest(maintenanceRequest({
      local_executor_epoch: epoch,
      local_executor_holder_nonce: holderNonce.toUpperCase(),
    })),
  ]) {
    let code = null;
    try { validate(); } catch (error) { code = error?.code; }
    assert(code === "local_executor_authority_unavailable", `paired validation code=${code}`);
  }
  const task = worker.validateSedimentWorkerManifest(taskManifest(expectation()));
  const maintenance = worker.validateSedimentWorkerMaintenanceRequest(maintenanceRequest(expectation()));
  assert(task.local_executor_epoch === epoch && maintenance.local_executor_epoch === epoch, "paired fields preserved");

  const partialTaskResult = await worker.runSedimentWorkerTask(
    JSON.stringify(taskManifest({ local_executor_epoch: epoch })),
    {},
  );
  assert(partialTaskResult.error_code === "local_executor_authority_unavailable"
    && partialTaskResult.retryable === true
    && partialTaskResult.restart_child === false,
  `partial task authority result=${JSON.stringify(partialTaskResult)}`);
  const partialMaintenanceResult = await worker.runSedimentWorkerMaintenance(
    JSON.stringify(maintenanceRequest({ local_executor_holder_nonce: holderNonce })),
    {},
  );
  assert(partialMaintenanceResult.error_code === "local_executor_authority_unavailable"
    && partialMaintenanceResult.retryable === true
    && partialMaintenanceResult.restart_child === false,
  `partial maintenance authority result=${JSON.stringify(partialMaintenanceResult)}`);
});

await check("capability command declares process-lifetime v1 with zero semantic side effects", async () => {
  const commands = new Map();
  worker.registerSedimentWorkerCapabilitiesCommand({
    registerCommand(name, options) { commands.set(name, options); },
  });
  assert(commands.size === 1 && commands.has("sediment-worker-capabilities"), "capability command registration");
  const beforeAbrain = snapshotTree(abrain);
  const beforeProject = snapshotTree(project);
  const beforeGit = gitIdentity();
  const notifications = [];
  await commands.get("sediment-worker-capabilities").handler("", {
    ui: { notify(message, type) { notifications.push({ message, type }); } },
  });
  assert(notifications.length === 1, "one capability notification");
  const parsed = worker.tryParseSedimentWorkerCapabilitiesNotify(notifications[0].message);
  assert(parsed?.capabilities?.[0] === "local_executor_authority_process_lifetime_v1", "closed capability value");
  assert(snapshotTree(abrain) === beforeAbrain, "capability probe changed abrain");
  assert(snapshotTree(project) === beforeProject, "capability probe changed project");
  assert(gitIdentity() === beforeGit, "capability probe changed Git HEAD/tree");
});

await check("authority admission is limited to entry plus execution-time mutation frames", async () => {
  const rpcSource = fs.readFileSync(path.join(repoRoot, "extensions/sediment/worker-rpc.ts"), "utf8");
  const rpcCalls = rpcSource.match(/\badmitLocalExecutorAuthority\s*\(/g) ?? [];
  assert(rpcCalls.length === 5, `expected task/maintenance entry plus pass/repair/drain re-admissions, got ${rpcCalls.length}`);
  const controlSource = fs.readFileSync(path.join(repoRoot, "extensions/sediment/canonical-control.ts"), "utf8");
  const controlCalls = controlSource.match(/\badmitLocalExecutorAuthority\s*\(/g) ?? [];
  assert(controlCalls.length === 2, `expected DCC control entry plus kick-frame re-admission, got ${controlCalls.length}`);
  const barrierLabels = `${rpcSource}\n${controlSource}`.match(/\bB[1-8]\b/g) ?? [];
  assert(barrierLabels.length === 0, `unexpected B1-B8 barrier labels: ${barrierLabels.join(",")}`);
  const files = fs.readdirSync(path.join(repoRoot, "extensions/sediment"))
    .filter((name) => name.endsWith(".ts")
      && name !== "worker-rpc.ts"
      && name !== "canonical-control.ts"
      && name !== "local-executor-authority.ts");
  for (const name of files) {
    const source = fs.readFileSync(path.join(repoRoot, "extensions/sediment", name), "utf8");
    assert(!source.includes("admitLocalExecutorAuthority("), `authority barrier leaked into ${name}`);
  }
});

console.log(`\n${passed} checks passed`);
