// 共享同步文件锁 —— 从 entry-telemetry 的 proven 实现提取(ADR 0031 M4/M5 executor
// 需要多 writer 串行: entry-lifecycle-proposals 翻 status=executed 与 appendLifecycleProposals
// 共写同一 sidecar, 无锁 = 数据竞争, opus M4/M5 review P0-3)。
//
// best-effort 互斥: O_EXCL 创建 lock 文件; stale 检测(LOCK_STALE_MS)+ pid-alive 探测
// 兜底崩溃残留锁; token 校验防误删他人锁。绝不阻塞/抛错 —— 拿不到锁返回 ok:false,
// 调用方决定跳过/下轮重试。
import * as fs from "node:fs";
import * as path from "node:path";

const LOCK_STALE_MS = 30 * 60 * 1000;

interface SyncLockClaim {
  pid: number;
  token: string;
  created_at: string;
}

function makeLockClaim(): SyncLockClaim {
  return {
    pid: process.pid,
    token: `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`,
    created_at: new Date().toISOString(),
  };
}

function parseLockClaim(raw: string): SyncLockClaim | null {
  try {
    const p = JSON.parse(raw) as Partial<SyncLockClaim>;
    if (!p || typeof p !== "object" || typeof p.pid !== "number" || typeof p.token !== "string" || typeof p.created_at !== "string") return null;
    return { pid: p.pid, token: p.token, created_at: p.created_at };
  } catch {
    return null;
  }
}

function pidAppearsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

export function tryAcquireSyncLock(file: string): SyncLockClaim | null {
  const claim = makeLockClaim();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", { flag: "wx" });
    return claim;
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") return null;
  }
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return null;
    const raw = fs.readFileSync(file, "utf-8");
    const existing = parseLockClaim(raw);
    if (existing && pidAppearsAlive(existing.pid)) return null;
    const currentRaw = fs.readFileSync(file, "utf-8");
    const current = parseLockClaim(currentRaw);
    if (existing?.token) {
      if (current?.token !== existing.token) return null;
    } else if (currentRaw !== raw) {
      return null;
    }
    const currentStat = fs.statSync(file);
    if (Date.now() - currentStat.mtimeMs <= LOCK_STALE_MS) return null;
    fs.unlinkSync(file);
    fs.writeFileSync(file, JSON.stringify(claim, null, 2) + "\n", { flag: "wx" });
    return claim;
  } catch {
    return null;
  }
}

export function releaseSyncLock(file: string, claim: SyncLockClaim | null): void {
  if (!claim) return;
  try {
    const current = parseLockClaim(fs.readFileSync(file, "utf-8"));
    if (current?.token !== claim.token) return;
    fs.unlinkSync(file);
  } catch {
    // best-effort
  }
}

export function atomicWriteText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already renamed or never written */ }
  }
}

/** 持锁运行 fn(同步)。拿不到锁 → { ok:false }(调用方跳过/下轮重试,绝不阻塞)。 */
export function withFileLock<T>(lockPath: string, fn: () => T): { ok: true; value: T } | { ok: false } {
  const lock = tryAcquireSyncLock(lockPath);
  if (!lock) return { ok: false };
  try {
    return { ok: true, value: fn() };
  } finally {
    releaseSyncLock(lockPath, lock);
  }
}
