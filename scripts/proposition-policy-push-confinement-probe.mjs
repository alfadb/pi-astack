#!/usr/bin/env node
/** Bubblewrap effectiveness probe. It mutates only the sandbox-bound probe target. */
import fs from "node:fs";
import net from "node:net";

const MANIFEST = "/run/pi-astack/probe-manifest.json";

function attemptWrite(file) {
  try {
    fs.writeFileSync(file, "probe\n", { flag: "wx", mode: 0o600 });
    fs.unlinkSync(file);
    return { denied: false, code: null };
  } catch (error) {
    return { denied: ["EROFS", "EACCES", "EPERM", "ENOENT"].includes(error?.code), code: error?.code ?? "ERROR" };
  }
}

function namespace(name) {
  try { return fs.readlinkSync(`/proc/self/ns/${name}`); } catch { return null; }
}

function capabilityEffective() {
  try {
    const row = fs.readFileSync("/proc/self/status", "utf8").split("\n").find((line) => line.startsWith("CapEff:"));
    return row?.split(/\s+/)[1] ?? null;
  } catch { return null; }
}

function inheritedRegularFds() {
  try {
    const output = [];
    for (const name of fs.readdirSync("/proc/self/fd")) {
      const fd = Number(name);
      if (!Number.isInteger(fd) || fd <= 2) continue;
      try {
        const value = fs.readlinkSync(`/proc/self/fd/${name}`);
        if (!value.startsWith("anon_inode:") && !value.startsWith("pipe:") && !value.startsWith("socket:")) output.push({ fd, value });
      } catch { /* descriptor used by readdir can disappear */ }
    }
    return output;
  } catch { return [];
  }
}

async function networkDenied() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "1.1.1.1", port: 53 });
    const timer = setTimeout(() => { socket.destroy(); resolve({ denied: true, code: "TIMEOUT" }); }, 500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve({ denied: false, code: null }); });
    socket.once("error", (error) => { clearTimeout(timer); resolve({ denied: true, code: error?.code ?? "ERROR" }); });
  });
}

try {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const writable = "/home/worker/.abrain/.state/sediment/proposition-policy-push-shadow/v1";
  const marker = `${writable}/.confinement-probe-${process.pid}`;
  const writableResult = attemptWrite(marker);
  const result = {
    schema_version: "proposition-policy-push-confinement-effectiveness/v1",
    nonce: manifest.nonce,
    environment_keys: Object.keys(process.env).sort(),
    namespaces: Object.fromEntries(["user", "mnt", "pid", "net", "ipc", "uts", "cgroup"].map((name) => [name, namespace(name)])),
    capability_effective_hex: capabilityEffective(),
    inherited_regular_fds: inheritedRegularFds(),
    target_writable: writableResult.denied === false,
    host_write_denials: {
      l1: attemptWrite("/home/worker/.abrain/l1/.p2a2-probe"),
      git: attemptWrite("/home/worker/.abrain/.git/.p2a2-probe"),
      sediment_sibling: attemptWrite("/home/worker/.abrain/.state/sediment/.p2a2-probe"),
      tmp: attemptWrite("/tmp/.p2a2-probe"),
    },
    network: await networkDenied(),
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`CONFINEMENT_PROBE_FAILED: ${error?.message || String(error)}\n`);
  process.exitCode = 1;
}
