import assert from "node:assert/strict";
import { Duplex, Transform } from "node:stream";
import { once } from "node:events";
import { test } from "node:test";

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

  override _final(callback: (error?: Error | null) => void): void {
    setImmediate(() => this.peer?.push(null));
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

class PacedService extends Duplex {
  readonly totalChunks: number;
  chunksSent = 0;
  private scheduled = false;

  constructor(totalChunks: number) {
    super();
    this.totalChunks = totalChunks;
  }

  override _read(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.chunksSent === this.totalChunks) {
        this.push(null);
        return;
      }
      this.chunksSent++;
      this.push(Buffer.alloc(4 * 1024, this.chunksSent % 251));
    });
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
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

function replyAfterFin(): Duplex {
  let request = "";
  return new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      request += chunk.toString();
      callback();
    },
    final(callback) {
      this.push(`reply:${request}`);
      this.push(null);
      callback();
    },
  });
}

async function exchange(stream: Duplex, payload: string): Promise<string> {
  const response = once(stream, "data");
  stream.write(payload);
  const [chunk] = (await response) as [Buffer];
  return chunk.toString();
}

async function readToEnd(stream: Duplex): Promise<string> {
  stream.setEncoding("utf8");
  let body = "";
  stream.on("data", (chunk: string) => {
    body += chunk;
  });
  await once(stream, "end");
  return body;
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

test("multiplexes independent service streams over one persistent connection", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const openedServices: string[] = [];
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async (serviceId) => {
      openedServices.push(serviceId);
      return prefixService(`${serviceId}:`);
    },
  });
  const subscriber = createMuxSubscriber(subscriberOuter);

  const [home, ssh] = await Promise.all([
    subscriber.open("home"),
    subscriber.open("ssh"),
  ]);

  assert.equal(await exchange(home, "page"), "home:page");
  assert.equal(await exchange(ssh, "hello"), "ssh:hello");

  home.destroy();
  ssh.destroy();
  await Promise.all([once(home, "close"), once(ssh, "close")]);

  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(publisherOuter.destroyed, false);

  const navidrome = await subscriber.open("navidrome");
  assert.equal(await exchange(navidrome, "song"), "navidrome:song");
  assert.deepEqual(openedServices.sort(), ["home", "navidrome", "ssh"]);

  navidrome.destroy();
  subscriber.close();
  publisher.close();
});

test("rejects an unpublished service without closing the persistent connection", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async (serviceId) => {
      if (serviceId !== "home") {
        throw new Error(`Service is not published: ${serviceId}`);
      }
      return prefixService("home:");
    },
  });
  const subscriber = createMuxSubscriber(subscriberOuter);

  await assert.rejects(
    () => subscriber.open("database"),
    /not published.*database/i,
  );
  assert.equal(subscriberOuter.destroyed, false);
  assert.equal(publisherOuter.destroyed, false);

  const home = await subscriber.open("home");
  assert.equal(await exchange(home, "page"), "home:page");

  home.destroy();
  subscriber.close();
  publisher.close();
});

test("preserves TCP half-close so a service can reply after request FIN", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => replyAfterFin(),
  });
  const subscriber = createMuxSubscriber(subscriberOuter);
  const stream = await subscriber.open("request-response");

  const response = Promise.race([
    readToEnd(stream),
    new Promise<string>((_resolve, reject) => {
      setTimeout(() => reject(new Error("half-close timed out")), 100);
    }),
  ]);
  stream.end("question");

  await assert.doesNotReject(async () => {
    assert.equal(await response, "reply:question");
  });

  subscriber.close();
  publisher.close();
});

test("pauses one service when its subscriber channel applies backpressure", async () => {
  const [subscriberOuter, publisherOuter] = framedPair();
  const service = new PacedService(128);
  const publisher = createMuxPublisher(publisherOuter, {
    connect: async () => service,
  });
  const subscriber = createMuxSubscriber(subscriberOuter);
  const stream = await subscriber.open("download");

  await waitFor(
    () => stream.readableLength >= stream.readableHighWaterMark,
    "subscriber buffer never filled",
  );
  const sentAtBackpressure = service.chunksSent;
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.ok(
    service.chunksSent < service.totalChunks,
    "publisher source stops before buffering the complete response",
  );
  assert.ok(
    service.chunksSent <= sentAtBackpressure + 4,
    "publisher source stops promptly after channel backpressure",
  );

  stream.resume();
  await once(stream, "end");
  assert.equal(service.chunksSent, service.totalChunks);

  subscriber.close();
  publisher.close();
});
