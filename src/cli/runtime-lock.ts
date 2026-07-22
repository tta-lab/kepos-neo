import crypto from "node:crypto";
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";

interface RuntimeLockState {
  ownerToken: string;
  pid: number;
}

export interface SubscriberRuntimeLock {
  release: () => Promise<void>;
}

export function subscriberRuntimeLockPath(stateDir: string): string {
  const resolvedStateDir = path.resolve(stateDir);
  return path.join(
    path.dirname(resolvedStateDir),
    `.${path.basename(resolvedStateDir)}.subscriber.runtime.lock`,
  );
}

export async function acquireSubscriberRuntimeLock(
  stateDir: string,
): Promise<SubscriberRuntimeLock> {
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  const lockPath = subscriberRuntimeLockPath(stateDir);
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const state = { ownerToken, pid: process.pid };
  await removeOrphanedClaims(lockPath);

  for (let attempt = 0; ; attempt += 1) {
    try {
      await createLock(lockPath, state);
      break;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      let existing: RuntimeLockState;
      try {
        existing = await readLock(lockPath);
      } catch (readError) {
        if (!hasCauseCode(readError, "ENOENT")) throw readError;
        await waitForLockRetry(attempt);
        continue;
      }
      if (pidIsAlive(existing.pid)) {
        throw new Error(
          `Subscriber identity is already in use by process ${existing.pid}`,
        );
      }
      if (await replaceStaleLock(lockPath, existing, state)) break;
      await waitForLockRetry(attempt);
    }
  }

  let released = false;
  return {
    async release(): Promise<void> {
      if (released) return;
      const current = await readLock(lockPath);
      if (current.ownerToken !== ownerToken || current.pid !== process.pid) {
        throw new Error("Subscriber runtime lock ownership changed");
      }
      await unlink(lockPath);
      released = true;
    },
  };
}

async function replaceStaleLock(
  lockPath: string,
  existing: RuntimeLockState,
  replacement: RuntimeLockState,
): Promise<boolean> {
  const claimPath = `${lockPath}.reclaim.${replacement.pid}.${replacement.ownerToken}`;

  try {
    await link(lockPath, claimPath);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }

  try {
    if (!(await ownsOnlyStaleClaim(lockPath, claimPath, existing))) return false;

    await unlink(lockPath);
    try {
      await createLock(lockPath, replacement);
    } catch (error) {
      if (hasCode(error, "EEXIST")) return false;
      throw error;
    }
    return true;
  } finally {
    await unlink(claimPath).catch(() => undefined);
  }
}

async function ownsOnlyStaleClaim(
  lockPath: string,
  claimPath: string,
  existing: RuntimeLockState,
): Promise<boolean> {
  try {
    const claimed = await readLock(claimPath);
    const current = await readLock(lockPath);
    if (!sameLockState(claimed, existing) || !sameLockState(current, existing)) {
      return false;
    }
    const [claimedStat, currentStat] = await Promise.all([
      stat(claimPath),
      stat(lockPath),
    ]);
    return (
      claimedStat.dev === currentStat.dev &&
      claimedStat.ino === currentStat.ino &&
      claimedStat.nlink === 2
    );
  } catch (error) {
    if (hasCauseCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function waitForLockRetry(attempt: number): Promise<void> {
  if (attempt >= 15) {
    throw new Error("Subscriber identity is already in use");
  }
  const maxDelayMs = Math.min(64, 2 ** attempt);
  const delayMs = crypto.randomInt(1, maxDelayMs + 1);
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

async function removeOrphanedClaims(lockPath: string): Promise<void> {
  const directory = path.dirname(lockPath);
  const prefix = `${path.basename(lockPath)}.reclaim.`;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) continue;
    const match = /^(\d+)\.[a-f0-9]{32}$/.exec(name.slice(prefix.length));
    if (match === null || pidIsAlive(Number(match[1]))) continue;
    await unlink(path.join(directory, name)).catch((error: unknown) => {
      if (!hasCode(error, "ENOENT")) throw error;
    });
  }
}

function sameLockState(
  left: RuntimeLockState,
  right: RuntimeLockState,
): boolean {
  return left.ownerToken === right.ownerToken && left.pid === right.pid;
}

async function createLock(
  lockPath: string,
  state: RuntimeLockState,
): Promise<void> {
  const handle = await open(lockPath, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(state)}\n`, "utf8");
  } catch (error) {
    await unlink(lockPath).catch(() => undefined);
    throw error;
  } finally {
    await handle.close();
  }
}

async function readLock(lockPath: string): Promise<RuntimeLockState> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(lockPath, "utf8"));
  } catch (error) {
    throw new Error("Cannot verify subscriber runtime lock", {
      cause: error,
    });
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as Partial<RuntimeLockState>).ownerToken !== "string" ||
    !Number.isInteger((parsed as Partial<RuntimeLockState>).pid) ||
    ((parsed as Partial<RuntimeLockState>).pid ?? 0) <= 0
  ) {
    throw new Error("Cannot verify subscriber runtime lock");
  }
  return parsed as RuntimeLockState;
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !hasCode(error, "ESRCH");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function hasCauseCode(error: unknown, code: string): boolean {
  let current = error;
  while (current instanceof Error) {
    if (hasCode(current, code)) return true;
    current = current.cause;
  }
  return false;
}
