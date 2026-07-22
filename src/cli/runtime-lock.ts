import crypto from "node:crypto";
import {
  mkdir,
  open,
  readFile,
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

  try {
    await createLock(lockPath, state);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    const existing = await readLock(lockPath);
    if (pidIsAlive(existing.pid)) {
      throw new Error(
        `Subscriber identity is already in use by process ${existing.pid}`,
      );
    }
    await unlink(lockPath);
    try {
      await createLock(lockPath, state);
    } catch (retryError) {
      if (hasCode(retryError, "EEXIST")) {
        throw new Error("Subscriber identity is already in use", {
          cause: retryError,
        });
      }
      throw retryError;
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
