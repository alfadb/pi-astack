export class GitZParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "GitZParseError";
    this.code = code;
  }
}

export interface GitPorcelainV1Record {
  status: string;
  x: string;
  y: string;
  /** Porcelain v1 -z reports the destination/current path first. */
  path: string;
  /** Present only for rename/copy records. */
  sourcePath?: string;
  paths: readonly string[];
}

const STATUS_CHARS = " MADRCU?!";

function nextNulRecord(input: Buffer, offset: number): { record: Buffer; next: number } {
  const end = input.indexOf(0, offset);
  if (end < 0) throw new GitZParseError("GIT_Z_INCOMPLETE", "missing NUL terminator");
  return { record: input.subarray(offset, end), next: end + 1 };
}

export function decodeCanonicalGitPath(raw: Buffer): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new GitZParseError("GIT_PATH_UTF8_INVALID", "git path is not valid UTF-8");
  }
  if (
    value.length === 0
    || value.includes("\0")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)
    || value.includes("\\")
    || value.normalize("NFC") !== value
  ) {
    throw new GitZParseError("GIT_PATH_NONCANONICAL", `git path is not canonical: ${JSON.stringify(value)}`);
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new GitZParseError("GIT_PATH_NONCANONICAL", `git path is not canonical: ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseGitStatusPorcelainV1Z(input: Buffer): GitPorcelainV1Record[] {
  if (!Buffer.isBuffer(input)) throw new GitZParseError("GIT_Z_INPUT_INVALID", "porcelain input must be a Buffer");
  const records: GitPorcelainV1Record[] = [];
  let offset = 0;
  while (offset < input.length) {
    const first = nextNulRecord(input, offset);
    offset = first.next;
    if (first.record.length < 4 || first.record[2] !== 0x20) {
      throw new GitZParseError("GIT_STATUS_HEADER_INVALID", "invalid porcelain v1 -z record header");
    }
    const x = String.fromCharCode(first.record[0]!);
    const y = String.fromCharCode(first.record[1]!);
    if (!STATUS_CHARS.includes(x) || !STATUS_CHARS.includes(y) || (x === " " && y === " ")) {
      throw new GitZParseError("GIT_STATUS_CODE_INVALID", `invalid porcelain v1 status: ${JSON.stringify(x + y)}`);
    }
    const currentPath = decodeCanonicalGitPath(first.record.subarray(3));
    let sourcePath: string | undefined;
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const second = nextNulRecord(input, offset);
      offset = second.next;
      sourcePath = decodeCanonicalGitPath(second.record);
      if (sourcePath === currentPath) throw new GitZParseError("GIT_RENAME_PATH_INVALID", "rename/copy source and destination are identical");
    }
    const paths = Object.freeze(sourcePath ? [currentPath, sourcePath] : [currentPath]);
    records.push(Object.freeze({ status: x + y, x, y, path: currentPath, ...(sourcePath ? { sourcePath } : {}), paths }));
  }
  return records;
}

export function parseGitNulPathList(input: Buffer): string[] {
  if (!Buffer.isBuffer(input)) throw new GitZParseError("GIT_Z_INPUT_INVALID", "path-list input must be a Buffer");
  const paths: string[] = [];
  let offset = 0;
  while (offset < input.length) {
    const item = nextNulRecord(input, offset);
    offset = item.next;
    paths.push(decodeCanonicalGitPath(item.record));
  }
  return paths;
}
