import assert from "node:assert/strict";
import { once } from "node:events";
import { Duplex, Transform } from "node:stream";
import { test } from "node:test";

import {
  createObserver,
  sanitizeObservation,
  type Observation,
} from "../src/mux/observability.js";
import {
  createMuxPublisher,
  createMuxSubscriber,
} from "../src/mux/transport.js";

class FramedDuplex extends Duplex {
  peer?: FramedDuplex;

  override _read(): void {}

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const frame = Buffer.from(chunk);
    setImmediate(() => this.peer?.push(frame));
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    setImmediate(() => this.peer?.push(null));
    callback(error);
  }
}

function framedPair(): [FramedDuplex, FramedDuplex] {
  const left = new FramedDuplex();
  const right = new FramedDuplex();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function prefixService(prefix: string): Duplex {
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      callback(null, Buffer.concat([Buffer.from(prefix), chunk]));
    },
  });
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("observer writes stable NDJSON context with elapsed time", () => {
  const lines: string[] = [];
  let now = 1_000;
  const observe = createObserver({
    enabled: true,
    role: "subscriber",
    outerId: "outer-sub-1",
    route: "public",
    now: () => now,
    write: (line) => lines.push(line),
  });

  now = 1_125;
  observe("outer.connected", { attempt: 2 });

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    component: "kepos",
    timestamp: new Date(1_125).toISOString(),
    elapsedMs: 125,
    role: "subscriber",
    route: "public",
    outerId: "outer-sub-1",
    event: "outer.connected",
    attempt: 2,
  });
});

test("observation sanitization removes secrets and truncates peer keys", () => {
  assert.deepEqual(
    sanitizeObservation({
      seed: "seed",
      nested: {
        secretKey: "secret",
        publicKey: "a".repeat(64),
        remotePublicKey: Buffer.from("b".repeat(64), "hex"),
        rtt: 42,
      },
    }),
    {
      nested: {
        publicKey: "a".repeat(16),
        remotePublicKey: "b".repeat(16),
        rtt: 42,
      },
    },
  );
});

test("observation fields cannot replace stable context", () => {
  const lines: string[] = [];
  const observe = createObserver({
    enabled: true,
    role: "subscriber",
    outerId: "outer-real",
    now: () => 1_000,
    write: (line) => lines.push(line),
  });

  observe("outer.connected", {
    component: "other",
    event: "channel.open",
    outerId: "outer-spoofed",
    role: "publisher",
  });

  const event = JSON.parse(lines[0] ?? "") as Observation;
  assert.equal(event.component, "kepos");
  assert.equal(event.event, "outer.connected");
  assert.equal(event.outerId, "outer-real");
  assert.equal(event.role, "subscriber");
});

test("mux observations identify channel open, first bytes, totals, and close source", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const subscriberEvents: Observation[] = [];
  const publisherEvents: Observation[] = [];
  let now = 2_000;
  const publisher = createMuxPublisher(publisherOuter, {
    outerId: "outer-pub-1",
    now: () => now,
    observe: (event) => publisherEvents.push(event),
    connect: async (serviceId) => prefixService(`${serviceId}:`),
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    outerId: "outer-sub-1",
    now: () => now,
    observe: (event) => subscriberEvents.push(event),
  });

  const stream = await subscriber.open("ssh");
  now = 2_100;
  stream.write("hello");
  const [response] = (await once(stream, "data")) as [Buffer];
  assert.equal(response.toString(), "ssh:hello");

  now = 2_300;
  stream.destroy();
  await once(stream, "close");
  await waitFor(
    () => publisherEvents.some(({ event }) => event === "channel.close"),
    "publisher did not report channel close",
  );

  const subscriberOpen = subscriberEvents.find(
    ({ event }) => event === "channel.open",
  );
  const subscriberOpenOk = subscriberEvents.find(
    ({ event }) => event === "channel.open-ok",
  );
  assert.equal(subscriberOpen?.serviceId, "ssh");
  assert.equal(subscriberOpenOk?.channelId, subscriberOpen?.channelId);
  assert.equal(subscriberOpenOk?.outerId, "outer-sub-1");

  assert.deepEqual(
    subscriberEvents
      .filter(({ event }) => event === "channel.first-byte")
      .map(({ direction, bytes }) => ({ direction, bytes })),
    [
      { direction: "subscriber-to-publisher", bytes: 5 },
      { direction: "publisher-to-subscriber", bytes: 9 },
    ],
  );

  const subscriberClose = subscriberEvents.find(
    ({ event }) => event === "channel.close",
  );
  assert.equal(subscriberClose?.trigger, "local.close");
  assert.equal(subscriberClose?.subscriberToPublisherBytes, 5);
  assert.equal(subscriberClose?.publisherToSubscriberBytes, 9);
  assert.equal(subscriberClose?.durationMs, 300);
  assert.equal(subscriberClose?.subscriberToPublisherFirstByteMs, 100);
  assert.equal(subscriberClose?.publisherToSubscriberFirstByteMs, 100);

  const publisherOpen = publisherEvents.find(
    ({ event }) => event === "channel.open",
  );
  assert.equal(publisherOpen?.channelId, subscriberOpen?.channelId);
  assert.equal(publisherOpen?.serviceId, "ssh");
  assert.equal(publisherOpen?.outerId, "outer-pub-1");

  subscriber.close();
  publisher.close();
});

test("mux reports service open errors without closing the outer connection", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const events: Observation[] = [];
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => {
      throw new Error("service unavailable");
    },
  });
  const subscriber = createMuxSubscriber(subscriberOuter, {
    outerId: "outer-sub-2",
    observe: (event) => events.push(event),
  });

  await assert.rejects(() => subscriber.open("ssh"), /service unavailable/);

  const openError = events.find(({ event }) => event === "channel.open-error");
  assert.equal(openError?.serviceId, "ssh");
  assert.equal(openError?.error, "service unavailable");
  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(publisherOuter.destroyed, false);

  subscriber.close();
  publisher.close();
});

test("publisher reports when the local target closes a channel", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisherEvents: Observation[] = [];
  const target = prefixService("ssh:");
  const publisher = createMuxPublisher(publisherOuter, {
    observe: (event) => publisherEvents.push(event),
    connect: async () => target,
  });
  const subscriber = createMuxSubscriber(subscriberOuter);
  const stream = await subscriber.open("ssh");

  target.destroy();
  await once(stream, "close");
  await waitFor(
    () => publisherEvents.some(({ event }) => event === "channel.close"),
    "publisher did not report target close",
  );

  const close = publisherEvents.find(({ event }) => event === "channel.close");
  assert.equal(close?.trigger, "target.close");

  subscriber.close();
  publisher.close();
});
