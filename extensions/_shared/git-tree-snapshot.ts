import { execFile, spawn } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_ENV = Object.freeze({
  LANG: "C",
  LC_ALL: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
});

function gitReadEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) env[key] = value;
  }
  return { ...env, ...GIT_ENV };
}

export interface GitTreeBlob {
  path: string;
  mode: string;
  oid: string;
  content: Buffer;
}

export class GitTreeSnapshotError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GitTreeSnapshotError";
    this.code = code;
  }
}

async function readBlobObjectsBatch(
  repo: string,
  oids: readonly string[],
  limits: { maxBlobBytes: number; maxTotalBytes: number },
): Promise<ReadonlyMap<string, Buffer>> {
  if (oids.length === 0) return new Map();
  const unique = [...new Set(oids)];
  const output = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", ["-C", repo, "--literal-pathspecs", "cat-file", "--batch"], {
      env: gitReadEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let overflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > limits.maxTotalBytes + unique.length * 256) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (overflow) {
        reject(new GitTreeSnapshotError("GIT_TREE_SNAPSHOT_TOO_LARGE", `cat-file output exceeded ${limits.maxTotalBytes} bytes`));
      } else if (code !== 0) {
        reject(new GitTreeSnapshotError("GIT_CAT_FILE_FAILED", Buffer.concat(stderr).toString("utf-8").trim() || `git cat-file exited ${code}`));
      } else {
        resolve(Buffer.concat(stdout));
      }
    });
    child.stdin.end(`${unique.join("\n")}\n`);
  });

  const blobs = new Map<string, Buffer>();
  let cursor = 0;
  for (const requestedOid of unique) {
    const newline = output.indexOf(0x0a, cursor);
    if (newline < 0) throw new GitTreeSnapshotError("GIT_CAT_FILE_PROTOCOL", `missing header for ${requestedOid}`);
    const header = output.subarray(cursor, newline).toString("ascii");
    cursor = newline + 1;
    const match = /^([0-9a-f]+) ([a-z]+) (\d+)$/.exec(header);
    if (!match) throw new GitTreeSnapshotError("GIT_CAT_FILE_PROTOCOL", `invalid header for ${requestedOid}: ${header}`);
    const [, actualOid, type, sizeRaw] = match;
    const size = Number(sizeRaw);
    if (actualOid !== requestedOid || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
      throw new GitTreeSnapshotError("GIT_CAT_FILE_PROTOCOL", `unexpected object for ${requestedOid}: ${header}`);
    }
    if (size > limits.maxBlobBytes) {
      throw new GitTreeSnapshotError("GIT_TREE_BLOB_TOO_LARGE", `${requestedOid} exceeds ${limits.maxBlobBytes} bytes`);
    }
    const end = cursor + size;
    if (end >= output.length || output[end] !== 0x0a) {
      throw new GitTreeSnapshotError("GIT_CAT_FILE_PROTOCOL", `truncated blob for ${requestedOid}`);
    }
    blobs.set(requestedOid, Buffer.from(output.subarray(cursor, end)));
    cursor = end + 1;
  }
  if (cursor !== output.length) throw new GitTreeSnapshotError("GIT_CAT_FILE_PROTOCOL", "unexpected trailing cat-file output");
  return blobs;
}

/** Read exact blobs from one immutable commit tree through ls-tree + cat-file --batch. */
export async function readGitTreeBlobs(options: {
  repo: string;
  commit: string;
  roots: readonly string[];
  maxBlobBytes?: number;
  maxTotalBytes?: number;
}): Promise<readonly GitTreeBlob[]> {
  const repo = path.resolve(options.repo);
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(options.commit)) {
    throw new GitTreeSnapshotError("GIT_TREE_COMMIT_INVALID", `invalid frozen commit: ${options.commit}`);
  }
  if (options.roots.length === 0 || options.roots.some((root) => !root || root.startsWith("/") || root.includes("\\") || root.split("/").some((part) => !part || part === "." || part === ".."))) {
    throw new GitTreeSnapshotError("GIT_TREE_ROOT_INVALID", "snapshot roots must be normalized repo-relative paths");
  }
  const { stdout } = await execFileAsync("git", [
    "-C", repo, "--literal-pathspecs", "ls-tree", "-r", "-z", "--full-tree", options.commit, "--", ...options.roots,
  ], {
    env: gitReadEnvironment(),
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  const records: Array<{ path: string; mode: string; oid: string }> = [];
  const seenPaths = new Set<string>();
  for (const record of (stdout as Buffer).toString("utf-8").split("\0").filter(Boolean)) {
    const tab = record.indexOf("\t");
    const meta = tab < 0 ? [] : record.slice(0, tab).split(" ");
    const relativePath = tab < 0 ? "" : record.slice(tab + 1);
    if (meta.length !== 3 || meta[1] !== "blob" || !/^[0-9a-f]+$/.test(meta[2] ?? "") || !relativePath || seenPaths.has(relativePath)) {
      throw new GitTreeSnapshotError("GIT_LS_TREE_PROTOCOL", `invalid or duplicate tree record: ${record.slice(0, 200)}`);
    }
    seenPaths.add(relativePath);
    records.push({ path: relativePath, mode: meta[0]!, oid: meta[2]! });
  }
  const blobs = await readBlobObjectsBatch(repo, records.map((record) => record.oid), {
    maxBlobBytes: options.maxBlobBytes ?? 16 * 1024 * 1024,
    maxTotalBytes: options.maxTotalBytes ?? 256 * 1024 * 1024,
  });
  return Object.freeze(records.map((record) => Object.freeze({
    ...record,
    content: Buffer.from(blobs.get(record.oid)!),
  })));
}
