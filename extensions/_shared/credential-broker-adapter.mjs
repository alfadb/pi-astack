#!/usr/bin/env node
import net from "node:net";

const [socketPath, capability, indexRaw, operation] = process.argv.slice(2);
const index = Number(indexRaw);
if (!socketPath || !capability || !Number.isInteger(index) || index < 0 || !["get", "store", "erase"].includes(operation)) {
  process.stderr.write("credential adapter arguments rejected\n");
  process.exit(2);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const input = Buffer.concat(chunks);
for (const chunk of chunks) chunk.fill(0);
const socket = net.createConnection({ path: socketPath });
const response = [];
let header = null;
let bodyOffset = 0;
const wipe = () => {
  input.fill(0);
  for (const chunk of response) chunk.fill(0);
};

socket.on("connect", () => {
  socket.write(`${JSON.stringify({ capability, index, operation, bytes: input.length })}\n`);
  socket.write(input, () => input.fill(0));
});
socket.on("data", (chunk) => response.push(Buffer.from(chunk)));
socket.on("error", () => {
  wipe();
  process.stderr.write("credential broker unavailable\n");
  process.exitCode = 3;
});
socket.on("close", () => {
  if (process.exitCode) { wipe(); return; }
  const raw = Buffer.concat(response);
  const newline = raw.indexOf(0x0a);
  if (newline < 0) {
    raw.fill(0);
    wipe();
    process.stderr.write("credential broker response rejected\n");
    process.exitCode = 4;
    return;
  }
  try {
    header = JSON.parse(raw.subarray(0, newline).toString("utf8"));
    bodyOffset = newline + 1;
  } catch {
    raw.fill(0);
    wipe();
    process.stderr.write("credential broker response rejected\n");
    process.exitCode = 4;
    return;
  }
  if (!header || !Number.isInteger(header.bytes) || header.bytes < 0 || raw.length - bodyOffset !== header.bytes) {
    raw.fill(0);
    wipe();
    process.stderr.write("credential broker response rejected\n");
    process.exitCode = 4;
    return;
  }
  if (header.ok !== true) {
    const stderrHash = typeof header.stderr_sha256 === "string" && /^[0-9a-f]{64}$/.test(header.stderr_sha256) ? header.stderr_sha256 : "unknown";
    raw.fill(0);
    wipe();
    process.stderr.write(`credential helper failed (${stderrHash})\n`);
    process.exitCode = Number.isInteger(header.exit_code) ? header.exit_code || 5 : 5;
    return;
  }
  process.stdout.write(raw.subarray(bodyOffset), () => {
    raw.fill(0);
    wipe();
  });
});
