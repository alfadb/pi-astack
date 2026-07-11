import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface DurableAtomicWriteFileOptions {
  encoding?: BufferEncoding;
  mode?: number;
  syncFile?: boolean;
  syncDirectory?: boolean;
  tmpPath?: string;
}

export async function durableAtomicWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options: DurableAtomicWriteFileOptions = {},
): Promise<void> {
  const dir = path.dirname(filePath);
  const tmpPath = options.tmpPath ?? path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`);
  const syncFile = options.syncFile ?? true;
  const syncDirectory = options.syncDirectory ?? true;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "wx", options.mode);
    try {
      if (typeof content === "string") await handle.writeFile(content, options.encoding ?? "utf-8");
      else await handle.writeFile(content);
      if (syncFile) await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }
    await fs.rename(tmpPath, filePath);
    if (syncDirectory) await fsyncDirectory(dir);
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

export type DurableCreateStatus = "created" | "identical" | "collision";

/** Canonical-path R3.4.2 P1-S2: atomic NO-REPLACE create (publish-if-absent).
 *  Writes a temp file (wx + fsync), then `link(temp, target)` which fails with
 *  EEXIST instead of replacing. Exactly one concurrent publisher observes
 *  `created`; losers observe `identical` when the existing bytes match or
 *  `collision` when they differ. Never overwrites an existing file. */
export async function durableAtomicCreateFile(
  filePath: string,
  content: string | Uint8Array,
  options: DurableAtomicWriteFileOptions = {},
): Promise<DurableCreateStatus> {
  const dir = path.dirname(filePath);
  const tmpPath = options.tmpPath ?? path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${randomBytes(8).toString("hex")}.tmp`);
  const bytes = typeof content === "string" ? Buffer.from(content, options.encoding ?? "utf-8") : Buffer.from(content);
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tmpPath, "wx", options.mode);
    try {
      await handle.writeFile(bytes);
      if (options.syncFile ?? true) await handle.sync();
    } finally {
      await handle.close();
      handle = undefined;
    }
    try {
      await fs.link(tmpPath, filePath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const existing = await fs.readFile(filePath);
        return existing.equals(bytes) ? "identical" : "collision";
      }
      throw err;
    }
    if (options.syncDirectory ?? true) await fsyncDirectory(dir);
    const readBack = await fs.readFile(filePath);
    if (!readBack.equals(bytes)) throw new Error(`durable create read-back mismatch: ${filePath}`);
    return "created";
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
  }
}

export async function atomicRenameWriteFile(
  filePath: string,
  content: string | Uint8Array,
  options: Omit<DurableAtomicWriteFileOptions, "syncFile" | "syncDirectory"> = {},
): Promise<void> {
  await durableAtomicWriteFile(filePath, content, { ...options, syncFile: false, syncDirectory: false });
}

export async function fsyncDirectory(dir: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}
