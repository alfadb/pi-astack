#!/usr/bin/env node
/**
 * Smoke: memory/embedding.ts raw fetch sink applies cfg.headers with
 * WHATWG Headers string=set / null=delete semantics.
 *
 * Independent review found the production embedBatch used a plain object
 * spread (`...cfg.headers`) — a null delete marker (0.84.x ProviderHeaders)
 * would have reached fetch as a literal null value. This smoke drives the
 * REAL production embedTexts → embedBatch path with a mocked fetch and asserts:
 *   1. default Authorization + Content-Type are present
 *   2. string header values override/append normally
 *   3. null markers DELETE the default Authorization / any header (case-insensitive)
 *   4. no literal "null" value ever reaches the fetch sink
 * It also source-asserts the delete/set merge lives INSIDE the raw fetch sink
 * (embedBatch) and is not applied globally to provider headers elsewhere.
 */

import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const jiti = createJiti(import.meta.url);

const { embedTexts } = await jiti.import(
  path.join(repoRoot, "extensions/memory/embedding.ts"),
);
const embSource = fs.readFileSync(
  path.join(repoRoot, "extensions/memory/embedding.ts"),
  "utf8",
);

let failures = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}
async function checkAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

// ── intercept fetch on the production embed path ──────────────────────────
const realFetch = globalThis.fetch;
let capturedRequest = null; // { url, init }
globalThis.fetch = async (url, init) => {
  capturedRequest = { url, init };
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: {} }),
  };
};

function baseCfg(headers) {
  return {
    baseUrl: "https://example.invalid/v1",
    apiKey: "test-key",
    headers,
    model: "test-embedding",
    dim: 3,
    batchSize: 1,
    tpmLimit: 1_000_000,
    timeoutMs: 5000,
    maxRetries: 0,
    multiVector: false,
    multiVectorMaxChunks: 4,
  };
}

function headerSnapshot() {
  const h = capturedRequest?.init?.headers;
  if (!(h instanceof Headers)) throw new Error(`fetch headers is not a WHATWG Headers: ${String(h)}`);
  return {
    authorization: h.get("authorization"),
    contentType: h.get("content-type"),
    get: (k) => h.get(k),
    has: (k) => h.has(k),
    entries: [...h.entries()],
  };
}

console.log("Smoke: embedding raw fetch null-delete header semantics\n");

await checkAsync("string headers set + null delete markers + override (production embedTexts path)", async () => {
  await embedTexts(["hello world"], baseCfg({
    "X-Custom": "abc",
    "X-Delete-Me": null,
    "Content-Type": "application/json; charset=utf-8",
  }));
  const h = headerSnapshot();
  if (h.authorization !== "Bearer test-key") {
    throw new Error(`default Authorization lost: ${h.authorization}`);
  }
  if (h.contentType !== "application/json; charset=utf-8") {
    throw new Error(`string Content-Type override missing: ${h.contentType}`);
  }
  if (h.get("x-custom") !== "abc") {
    throw new Error(`string X-Custom header not set: ${h.get("x-custom")}`);
  }
  if (h.has("x-delete-me")) {
    throw new Error(`null marker must delete X-Delete-Me, still present: ${h.get("x-delete-me")}`);
  }
  for (const [, v] of h.entries) {
    if (v === "null") throw new Error(`literal "null" reached the fetch sink: ${JSON.stringify(h.entries)}`);
  }
});

await checkAsync("null Authorization deletes the default; Content-Type default kept", async () => {
  await embedTexts(["hello world"], baseCfg({ "Authorization": null, "X-Other": "keep" }));
  const h = headerSnapshot();
  if (h.has("authorization")) {
    throw new Error(`null marker must delete default Authorization, still present: ${h.authorization}`);
  }
  if (h.contentType !== "application/json") {
    throw new Error(`default Content-Type must survive: ${h.contentType}`);
  }
  if (h.get("x-other") !== "keep") {
    throw new Error(`unrelated string header dropped: ${h.get("x-other")}`);
  }
  for (const [, v] of h.entries) {
    if (v === "null") throw new Error(`literal "null" reached the fetch sink: ${JSON.stringify(h.entries)}`);
  }
});

await checkAsync("no cfg.headers → defaults intact, no null anywhere", async () => {
  await embedTexts(["hello world"], baseCfg(undefined));
  const h = headerSnapshot();
  if (h.authorization !== "Bearer test-key") {
    throw new Error(`default Authorization lost without cfg.headers: ${h.authorization}`);
  }
  if (h.contentType !== "application/json") {
    throw new Error(`default Content-Type lost without cfg.headers: ${h.contentType}`);
  }
  for (const [, v] of h.entries) {
    if (v === "null") throw new Error(`literal "null" reached the fetch sink: ${JSON.stringify(h.entries)}`);
  }
});

await checkAsync("case-insensitive delete: lowercase 'authorization' removes default too", async () => {
  await embedTexts(["hello world"], baseCfg({ "authorization": null }));
  const h = headerSnapshot();
  if (h.has("authorization")) {
    throw new Error(`case-insensitive null delete failed: ${h.authorization}`);
  }
  if (h.contentType !== "application/json") {
    throw new Error(`default Content-Type must survive: ${h.contentType}`);
  }
});

// ── source-level: merge only in the raw fetch sink ────────────────────────
{
  const batchStart = embSource.indexOf("async function embedBatch");
  const fetchCall = embSource.indexOf("const res = await fetch(", batchStart);
  const insideBatch = embSource.slice(batchStart, fetchCall);
  check("header merge uses WHATWG Headers exactly once", () => {
    const count = (embSource.match(/new Headers\(/g) || []).length;
    if (count !== 1) throw new Error(`expected exactly 1 new Headers(), got ${count}`);
  });
  check("null delete logic lives inside the embedBatch raw fetch sink", () => {
    if (!insideBatch.includes("new Headers(")) {
      throw new Error("new Headers( is not inside the embedBatch fetch sink body");
    }
    if (!/if \(value === null\) requestHeaders\.delete\(key\)/.test(insideBatch)) {
      throw new Error("null=delete branch not inside the embedBatch fetch sink body");
    }
  });
  check("no other header-delete filtering exists outside the fetch sink", () => {
    const deleteCalls = (embSource.match(/requestHeaders\.delete\(/g) || []).length;
    if (deleteCalls !== 1) {
      throw new Error(`expected exactly 1 requestHeaders.delete, got ${deleteCalls}`);
    }
  });
}

globalThis.fetch = realFetch;

console.log(`\nfailures: ${failures}/${total}`);
process.exit(failures === 0 ? 0 : 1);
