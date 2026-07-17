#!/usr/bin/env node
/** Deterministic fault-injection smoke for L1 schema registry discovery. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");
const jiti = createJiti(repoRoot, { interopDefault: true });
const l1 = jiti(path.join(repoRoot, "extensions/_shared/l1-schema-registry.ts"));

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err?.stack || err?.message || err}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

async function expectCode(code, fn, messageIncludes) {
  let caught;
  try {
    await fn();
  } catch (err) {
    caught = err;
  }
  assert(caught, `expected ${code}, but operation succeeded`);
  assert(caught.code === code, `expected ${code}, got ${caught.code || caught.message}`);
  if (messageIncludes) assert(String(caught.message || caught).includes(messageIncludes), `expected message to include ${messageIncludes}, got ${caught.message || caught}`);
  return caught;
}

function injectedError(code, file) {
  const err = new Error(`${code} injected for ${file}`);
  err.code = code;
  return err;
}

function tempHome(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pi-astack-l1-registry-faults-${label}-`));
}

function body(overrides = {}) {
  return {
    event_schema_version: "knowledge-evidence-event/v1",
    event_type: "knowledge_entry_observed",
    intent: { domain_hint: "knowledge", operation_hint: "create" },
    producer: { name: "sediment.knowledge-event-writer", version: "smoke" },
    fixture: "l1-registry-faults",
    ...overrides,
  };
}

function envelopeFor(value = body()) {
  const bodyHash = l1.canonicalL1BodyHash(value);
  return {
    schema: "knowledge-evidence-envelope/v1",
    canonicalization: "RFC8785-JCS",
    hash_alg: "sha256",
    event_id: bodyHash,
    body_hash: bodyHash,
    body: value,
  };
}

function writeEnvelope(abrainHome, envelope = envelopeFor()) {
  const file = l1.expectedL1EventPath(abrainHome, envelope.event_id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(envelope)}\n`, "utf8");
  return { envelope, file };
}

function adapter(overrides = {}) {
  const base = l1.__TEST.nodeL1ScanFileSystem;
  return {
    readdir: overrides.readdir || ((dir, opts) => base.readdir(dir, opts)),
    lstat: overrides.lstat || ((file) => base.lstat(file)),
    realpath: overrides.realpath || ((file) => base.realpath(file)),
    readFile: overrides.readFile || ((file, encoding) => base.readFile(file, encoding)),
  };
}

async function injectedScan(abrainHome, scanFs) {
  return l1.__TEST.scanWholeL1ValidatedWithFileSystem({ abrainHome }, scanFs);
}

console.log("L1 schema registry scanner fault smoke");

await check("discovery canonical leaf ENOENT fails closed as L1_EVENT_DISAPPEARED", async () => {
  const home = tempHome("canonical-vanish");
  try {
    const { file } = writeEnvelope(home);
    await expectCode("L1_EVENT_DISAPPEARED", () => injectedScan(home, adapter({
      lstat: async (candidate) => {
        if (candidate === file) throw injectedError("ENOENT", candidate);
        return l1.__TEST.nodeL1ScanFileSystem.lstat(candidate);
      },
    })), "during discovery");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("discovery durable temp ENOENT is skipped", async () => {
  const home = tempHome("temp-vanish");
  try {
    const shardDir = path.join(home, "l1/events/sha256/aa/bb");
    fs.mkdirSync(shardDir, { recursive: true });
    const residue = path.join(shardDir, ".aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json.123.456.abcdef0123456789.tmp");
    fs.writeFileSync(residue, "partial", "utf8");
    const result = await injectedScan(home, adapter({
      lstat: async (candidate) => {
        if (candidate === residue) throw injectedError("ENOENT", candidate);
        return l1.__TEST.nodeL1ScanFileSystem.lstat(candidate);
      },
    }));
    assert(result.all.length === 0, `unexpected records: ${result.all.length}`);
    assert(result.tempResidue.length === 0, `vanished residue should not be reported: ${JSON.stringify(result.tempResidue)}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("discovered canonical shard1 and shard2 lstat ENOENT fail closed", async () => {
  for (const depth of [1, 2]) {
    const home = tempHome(`shard${depth}-lstat-vanish`);
    try {
      const { file } = writeEnvelope(home);
      const secondShard = path.dirname(file);
      const firstShard = path.dirname(secondShard);
      const vanished = depth === 1 ? firstShard : secondShard;
      await expectCode("L1_EVENT_DISAPPEARED", () => injectedScan(home, adapter({
        lstat: async (candidate) => {
          if (candidate === vanished) throw injectedError("ENOENT", candidate);
          return l1.__TEST.nodeL1ScanFileSystem.lstat(candidate);
        },
      })), `depth ${depth} validation`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

await check("discovered canonical shard1 and shard2 readdir ENOENT fail closed", async () => {
  for (const depth of [1, 2]) {
    const home = tempHome(`shard${depth}-readdir-vanish`);
    try {
      const { file } = writeEnvelope(home);
      const secondShard = path.dirname(file);
      const firstShard = path.dirname(secondShard);
      const vanished = depth === 1 ? firstShard : secondShard;
      await expectCode("L1_EVENT_DISAPPEARED", () => injectedScan(home, adapter({
        readdir: async (candidate, opts) => {
          if (candidate === vanished) throw injectedError("ENOENT", candidate);
          return l1.__TEST.nodeL1ScanFileSystem.readdir(candidate, opts);
        },
      })), `depth ${depth} contents`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

await check("discovery unknown leaf never disappears silently", async () => {
  const home = tempHome("unknown-vanish");
  try {
    const shardDir = path.join(home, "l1/events/sha256/aa/bb");
    fs.mkdirSync(shardDir, { recursive: true });
    const stray = path.join(shardDir, "stray.json");
    fs.writeFileSync(stray, "{}\n", "utf8");
    await expectCode("L1_PATH_MISMATCH", () => injectedScan(home, adapter({
      lstat: async (candidate) => {
        if (candidate === stray) throw injectedError("ENOENT", candidate);
        return l1.__TEST.nodeL1ScanFileSystem.lstat(candidate);
      },
    })));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("discovery EACCES fails closed", async () => {
  const home = tempHome("eacces");
  try {
    const { file } = writeEnvelope(home);
    await expectCode("EACCES", () => injectedScan(home, adapter({
      lstat: async (candidate) => {
        if (candidate === file) throw injectedError("EACCES", candidate);
        return l1.__TEST.nodeL1ScanFileSystem.lstat(candidate);
      },
    })));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("selected post-discovery lstat ENOENT remains L1_EVENT_DISAPPEARED", async () => {
  const home = tempHome("selected-lstat");
  try {
    const { file } = writeEnvelope(home);
    let targetLstatCalls = 0;
    await expectCode("L1_EVENT_DISAPPEARED", () => injectedScan(home, adapter({
      lstat: async (candidate) => {
        if (candidate === file) {
          targetLstatCalls += 1;
          if (targetLstatCalls === 2) throw injectedError("ENOENT", candidate);
        }
        return l1.__TEST.nodeL1ScanFileSystem.lstat(candidate);
      },
    })), "during scan");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("selected realpath ENOENT remains L1_EVENT_DISAPPEARED", async () => {
  const home = tempHome("selected-realpath");
  try {
    const { file } = writeEnvelope(home);
    await expectCode("L1_EVENT_DISAPPEARED", () => injectedScan(home, adapter({
      realpath: async (candidate) => {
        if (candidate === file) throw injectedError("ENOENT", candidate);
        return l1.__TEST.nodeL1ScanFileSystem.realpath(candidate);
      },
    })), "during realpath");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

await check("selected read ENOENT remains L1_EVENT_DISAPPEARED", async () => {
  const home = tempHome("selected-read");
  try {
    const { file } = writeEnvelope(home);
    await expectCode("L1_EVENT_DISAPPEARED", () => injectedScan(home, adapter({
      readFile: async (candidate, encoding) => {
        if (candidate === file) throw injectedError("ENOENT", candidate);
        return l1.__TEST.nodeL1ScanFileSystem.readFile(candidate, encoding);
      },
    })), "during read");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

console.log();
if (failures.length) {
  console.log(`FAIL: ${failures.length} failure(s), ${passed} passed`);
  process.exit(1);
}
console.log(`PASS: ${passed} checks`);
