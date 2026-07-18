import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import { test } from "node:test";

import type { DhtStream } from "../src/mux/hyperdht.js";
import type { Observation } from "../src/mux/observability.js";
import {
  connectionOptionsForRoute,
  parseRoute,
} from "../src/mux/route.js";
import { createPublisherConnection } from "../src/mux/subscriber.js";

class FakeDhtStream extends Duplex implements DhtStream {
  connected: boolean;
  remotePublicKey = Buffer.alloc(32, 7);

  constructor(connected: boolean) {
    super();
    this.connected = connected;
  }

  override _read(): void {}

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("auto route permits the HyperDHT local shortcut", () => {
  assert.equal(parseRoute("auto"), "auto");
  assert.deepEqual(connectionOptionsForRoute("auto"), {
    localConnection: true,
    reusableSocket: true,
  });
});

test("public route disables only the HyperDHT local shortcut", () => {
  assert.equal(parseRoute("public"), "public");
  assert.deepEqual(connectionOptionsForRoute("public"), {
    localConnection: false,
    reusableSocket: true,
  });
});

test("unknown route is rejected", () => {
  assert.throws(() => parseRoute("relay"), /route must be auto or public/);
  assert.throws(
    () => connectionOptionsForRoute("relay"),
    /route must be auto or public/,
  );
});

test("reconnect observations report failed attempt delay and total recovery", async () => {
  const events: Observation[] = [];
  const delays: number[] = [];
  const initial = new FakeDhtStream(true);
  const failed = new FakeDhtStream(false);
  const restored = new FakeDhtStream(true);
  const candidates = [initial, failed, restored];
  let now = 1_000;
  const connection = createPublisherConnection({
    connect: () => {
      const stream = candidates.shift();
      if (!stream) throw new Error("unexpected connection attempt");
      if (stream === failed) {
        setImmediate(() => stream.destroy(new Error("holepunch failed")));
      }
      return stream;
    },
    now: () => now,
    observe: (event) => events.push(event),
    route: "public",
    sleep: async (delayMs) => {
      delays.push(delayMs);
      now += delayMs;
    },
  });

  await connection.start();
  initial.destroy();
  await waitFor(
    () => events.some(({ event }) => event === "outer.restored"),
    "connection did not restore",
  );

  assert.deepEqual(delays, [100]);
  const retry = events.find(({ event }) => event === "outer.retry");
  assert.equal(retry?.route, "public");
  assert.equal(retry?.delayMs, 100);
  assert.equal(retry?.error, "holepunch failed");
  const restoredEvent = events.find(
    ({ event }) => event === "outer.restored",
  );
  assert.equal(restoredEvent?.recoveryAttempt, 2);
  assert.equal(restoredEvent?.recoveryElapsedMs, 100);

  await connection.stop();
});

test("stop aborts an initial connection that is still pending", async () => {
  const pending = new FakeDhtStream(false);
  const connection = createPublisherConnection({
    connect: () => pending,
    now: () => 1_000,
    route: "auto",
    sleep: async () => undefined,
  });
  const starting = connection.start();
  await new Promise((resolve) => setImmediate(resolve));

  try {
    await connection.stop();
    await assert.rejects(
      Promise.race([
        starting,
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error("connection stop timed out")),
            100,
          );
        }),
      ]),
      /Subscriber stopped/,
    );
  } finally {
    pending.destroy();
  }
});
