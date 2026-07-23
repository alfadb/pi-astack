#!/usr/bin/env node
/** Focused smoke for the durable-intake sediment scheduler. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-astack-sediment-queue-"));
const settingsPath = path.join(tmp, "settings.json");
fs.writeFileSync(settingsPath, `${JSON.stringify({
  canonicalGitRuntime: { enabled: false, mode: "local_convergence_v2" },
  sediment: { enabled: true },
}, null, 2)}\n`);
process.env.PI_ASTACK_SETTINGS_PATH = settingsPath;
process.env.PI_ASTACK_ENABLE_TEST_HOOKS = "1";
process.env.ABRAIN_ROOT = path.join(tmp, "abrain");
fs.mkdirSync(process.env.ABRAIN_ROOT, { recursive: true });

const jiti = createJiti(import.meta.url, { interopDefault: true });
const queue = await jiti.import(path.join(root, "extensions/sediment/agent-end-queue.ts"));

function assert(value, message) {
  if (!value) throw new Error(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitUntil(predicate, message, timeoutMs = 2000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ok    ${name}`);
}

console.log("sediment durable-intake queue");

await check("same key is serial and active coalescing keeps latest", async () => {
  queue.resetDetachedAgentEndQueueForTests();
  const release = deferred();
  const runs = [];
  let live = 0;
  let peak = 0;
  queue.enqueueDetachedAgentEnd({
    key: "session:A",
    run: async () => {
      live += 1;
      peak = Math.max(peak, live);
      runs.push("first");
      await release.promise;
      live -= 1;
    },
  });
  await waitUntil(() => runs.length === 1, "first same-key job did not start");
  queue.enqueueDetachedAgentEnd({ key: "session:A", run: async () => { runs.push("middle"); } });
  queue.enqueueDetachedAgentEnd({ key: "session:A", run: async () => { runs.push("latest"); } });
  release.resolve();
  await queue.waitForDetachedAgentEndQueueIdle();
  assert(JSON.stringify(runs) === JSON.stringify(["first", "latest"]), `latest coalesce mismatch: ${JSON.stringify(runs)}`);
  assert(peak === 1, `same key overlapped: peak=${peak}`);
  const stats = queue.detachedAgentEndQueueStats();
  assert(stats.enqueued === 3 && stats.coalesced === 2, `coalesce stats mismatch: ${JSON.stringify(stats)}`);
  assert(stats.claimed === 2 && stats.completed === 2 && stats.pendingKeys === 0, `completion stats mismatch: ${JSON.stringify(stats)}`);
});

await check("more continuation drains backlog without another lifecycle edge", async () => {
  queue.resetDetachedAgentEndQueueForTests();
  let windows = 0;
  queue.enqueueDetachedAgentEnd({
    key: "session:continuation",
    run: async () => {
      windows += 1;
      if (windows < 5) return { more: true };
    },
  });
  await queue.waitForDetachedAgentEndQueueIdle();
  const stats = queue.detachedAgentEndQueueStats();
  assert(windows === 5, `continuation stopped early: ${windows}`);
  assert(stats.continuations === 4 && stats.completed === 1 && stats.claimed === 5, `continuation stats mismatch: ${JSON.stringify(stats)}`);
});

await check("different sessions run concurrently under the global cap", async () => {
  queue.resetDetachedAgentEndQueueForTests();
  queue.configureDetachedAgentEndQueueForTests({ maxGlobalConcurrent: 2 });
  const releases = [deferred(), deferred(), deferred()];
  const started = [];
  let live = 0;
  let peak = 0;
  for (let i = 0; i < releases.length; i += 1) {
    queue.enqueueDetachedAgentEnd({
      key: `session:${i}`,
      run: async () => {
        live += 1;
        peak = Math.max(peak, live);
        started.push(i);
        await releases[i].promise;
        live -= 1;
      },
    });
  }
  await waitUntil(() => started.length === 2, "two distinct sessions did not start concurrently");
  assert(peak === 2, `cross-session concurrency missing: peak=${peak}`);
  assert(started.length === 2, `global cap exceeded before release: ${JSON.stringify(started)}`);
  for (const release of releases) release.resolve();
  await queue.waitForDetachedAgentEndQueueIdle();
  assert(started.length === 3, `queued session was lost: ${JSON.stringify(started)}`);
  assert(queue.detachedAgentEndQueueStats().maxConcurrent === 2, "maxConcurrent did not record cross-session overlap");
});

await check("job error is contained and later same-key work recovers", async () => {
  queue.resetDetachedAgentEndQueueForTests();
  const errors = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  queue.enqueueDetachedAgentEnd({
    key: "session:error",
    run: async () => { throw new Error("injected queue failure"); },
    onError: async (error) => { errors.push(String(error)); },
  });
  await queue.waitForDetachedAgentEndQueueIdle();
  let recovered = false;
  queue.enqueueDetachedAgentEnd({ key: "session:error", run: async () => { recovered = true; } });
  await queue.waitForDetachedAgentEndQueueIdle();
  await new Promise((resolve) => setImmediate(resolve));
  process.off("unhandledRejection", onUnhandled);
  assert(errors.length === 1 && errors[0].includes("injected queue failure"), `onError mismatch: ${JSON.stringify(errors)}`);
  assert(recovered, "later same-key job did not recover");
  assert(unhandled.length === 0, `unhandled rejection escaped: ${unhandled.map(String).join(" | ")}`);
  const stats = queue.detachedAgentEndQueueStats();
  assert(stats.errors === 1 && stats.completed === 1 && stats.pendingKeys === 0, `error recovery stats mismatch: ${JSON.stringify(stats)}`);
});

await check("strict unhandled-rejection mode exits cleanly", async () => {
  const { spawnSync } = await import("node:child_process");
  const strictPath = path.join(tmp, "strict-queue.mjs");
  fs.writeFileSync(strictPath, `
    import { createRequire } from "node:module";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const root = ${JSON.stringify(root)};
    const require = createRequire(path.join(root, "package.json"));
    const { createJiti } = require("jiti");
    const jiti = createJiti(pathToFileURL(path.join(root, "scripts/smoke-sediment-agent-end-queue.mjs")).href, { interopDefault: true });
    const queue = await jiti.import(path.join(root, "extensions/sediment/agent-end-queue.ts"));
    queue.resetDetachedAgentEndQueueForTests();
    let audited = false;
    queue.enqueueDetachedAgentEnd({
      key: "session:strict",
      run: async () => { throw new Error("strict failure"); },
      onError: async () => { audited = true; },
    });
    await queue.waitForDetachedAgentEndQueueIdle();
    if (!audited) process.exit(2);
  `);
  const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", strictPath], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: path.join(root, "node_modules") },
  });
  assert(result.status === 0, `strict child failed: ${result.stderr || result.stdout}`);
});

await check("readiness and park lifecycle surface is deleted", async () => {
  const source = fs.readFileSync(path.join(root, "extensions/sediment/agent-end-queue.ts"), "utf8");
  for (const retired of ["waitUntilReady", "wakeParked", "parkTtl", "maxParked", "readyPending", "onNotReady", "onParkEvicted"]) {
    assert(!source.includes(retired), `retired queue surface remains: ${retired}`);
  }
  const indexSource = fs.readFileSync(path.join(root, "extensions/sediment/index.ts"), "utf8");
  assert(!indexSource.includes("scheduleCanonicalStartupConsumer"), "sediment index still imports/calls canonical startup consumer");
  assert(!indexSource.includes("agent_end_queue_not_ready"), "sediment index still audits retired not-ready lifecycle");
});

queue.resetDetachedAgentEndQueueForTests();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`PASS - ${passed} queue checks passed.`);
