import assert from "node:assert/strict";
import { link, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  acquireSubscriberRuntimeLock,
  subscriberRuntimeLockPath,
} from "../src/cli/runtime-lock.js";

test("allows only one CLI runtime for a subscriber state directory", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-lock-"));
  const first = await acquireSubscriberRuntimeLock(stateDir);

  try {
    assert.deepEqual(await readdir(stateDir), []);
    assert.equal(path.dirname(subscriberRuntimeLockPath(stateDir)), path.dirname(stateDir));
    await assert.rejects(
      () => acquireSubscriberRuntimeLock(stateDir),
      /subscriber identity is already in use/i,
    );
    await first.release();
    const next = await acquireSubscriberRuntimeLock(stateDir);
    await next.release();
  } finally {
    await first.release();
    await rm(subscriberRuntimeLockPath(stateDir), { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recovers a runtime lock owned by a dead process", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-stale-"));
  await writeFile(
    subscriberRuntimeLockPath(stateDir),
    `${JSON.stringify({ ownerToken: "stale", pid: 2_147_483_647 })}\n`,
    { mode: 0o600 },
  );

  try {
    const lock = await acquireSubscriberRuntimeLock(stateDir);
    await lock.release();
  } finally {
    await rm(subscriberRuntimeLockPath(stateDir), { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("grants exactly one concurrent stale-lock claimant", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-stale-race-"));
  await writeFile(
    subscriberRuntimeLockPath(stateDir),
    `${JSON.stringify({ ownerToken: "stale", pid: 2_147_483_647 })}\n`,
    { mode: 0o600 },
  );

  try {
    const attempts = await Promise.allSettled(
      Array.from({ length: 32 }, () =>
        acquireSubscriberRuntimeLock(stateDir),
      ),
    );
    const acquired = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireSubscriberRuntimeLock>>
      > => attempt.status === "fulfilled",
    );

    assert.equal(acquired.length, 1);
    for (const attempt of attempts) {
      if (attempt.status === "rejected") {
        assert.match(String(attempt.reason), /subscriber identity is already in use/i);
      }
    }
    await acquired[0].value.release();
  } finally {
    await rm(subscriberRuntimeLockPath(stateDir), { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("recovers after a stale-lock claimant crashes", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-claim-crash-"));
  const lockPath = subscriberRuntimeLockPath(stateDir);
  const orphanedClaim = `${lockPath}.reclaim.2147483647.${"a".repeat(32)}`;
  await writeFile(
    lockPath,
    `${JSON.stringify({ ownerToken: "stale", pid: 2_147_483_647 })}\n`,
    { mode: 0o600 },
  );
  await link(lockPath, orphanedClaim);

  try {
    const lock = await acquireSubscriberRuntimeLock(stateDir);
    await lock.release();
    assert.equal(
      (await readdir(path.dirname(lockPath))).includes(
        path.basename(orphanedClaim),
      ),
      false,
    );
  } finally {
    await rm(orphanedClaim, { force: true });
    await rm(lockPath, { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("fails closed for malformed runtime lock state", async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), "kepos-cli-invalid-"));
  await writeFile(subscriberRuntimeLockPath(stateDir), "not-json\n", {
    mode: 0o600,
  });

  try {
    await assert.rejects(
      () => acquireSubscriberRuntimeLock(stateDir),
      /cannot verify subscriber runtime lock/i,
    );
  } finally {
    await rm(subscriberRuntimeLockPath(stateDir), { force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});
