import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  startDogfoodPublisher,
  type RunningDogfoodPublisher,
} from "../src/dogfood/publisher.js";
import {
  startDogfoodClient,
  type RunningDogfoodClient,
} from "../src/dogfood/client.js";
import { setupClient, writePublisherContact } from "../src/dogfood/setup-client.js";
import { setupPublisher } from "../src/dogfood/setup-publisher.js";

interface HyperDhtTestnet {
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}

type CreateHyperDhtTestnet = (size: number) => Promise<HyperDhtTestnet>;

const require = createRequire(import.meta.url);
const createHyperDhtTestnet = require("hyperdht/testnet") as CreateHyperDhtTestnet;
const noLog = (): void => undefined;

async function listen(server: Server | HttpServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture address is unavailable");
  }
  return address.port;
}

async function closeServer(server: Server | HttpServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function exchangeTcp(port: number, payload: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(5_000, () => socket.destroy(new Error("TCP exchange timed out")));
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response));
  });
}

async function waitForHttpOk(url: string, timeoutMs = 8_000): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`HTTP endpoint did not recover: ${String(lastError)}`);
}

test("one persistent subscriber connection carries Home, Navidrome, and SSH", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-daemon-"));
  const subscriberState = path.join(root, "subscriber");
  const publisherState = path.join(root, "publisher");
  const sshServer = createServer({ allowHalfOpen: true }, (socket) => {
    let request = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      request += chunk;
    });
    socket.on("end", () => socket.end(`ssh:${request}`));
  });
  const navidromeServer = createHttpServer((request, response) => {
    response.writeHead(200, {
      "content-type": "audio/flac",
      "x-request-path": request.url ?? "/",
    });
    response.end(Buffer.alloc(64 * 1024, 7));
  });
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningDogfoodPublisher | undefined;
  let subscriber: RunningDogfoodClient | undefined;
  let testError: unknown;

  try {
    const [sshPort, navidromePort] = await Promise.all([
      listen(sshServer),
      listen(navidromeServer),
    ]);
    const subscriberSetup = await setupClient({
      stateDir: subscriberState,
      log: noLog,
    });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      clientPublicKeys: [subscriberSetup.publicKey],
      services: [
        { id: "navidrome", name: "Navidrome", targetPort: navidromePort },
        { id: "ssh", name: "SSH", targetPort: sshPort },
      ],
      log: noLog,
    });
    await writePublisherContact({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });

    testnet = await createHyperDhtTestnet(3);
    publisher = await startDogfoodPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    subscriber = await startDogfoodClient({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      services: [
        { id: "navidrome", localPort: 0 },
        { id: "ssh", localPort: 0 },
      ],
      log: noLog,
    });

    const navidrome = subscriber.services.find((service) => service.id === "navidrome");
    const ssh = subscriber.services.find((service) => service.id === "ssh");
    assert.ok(navidrome);
    assert.ok(ssh);

    const [homeResponse, audioResponse, sshResponse] = await Promise.all([
      fetch(subscriber.home.url),
      fetch(`http://127.0.0.1:${navidrome.port}/rest/stream`),
      exchangeTcp(ssh.port, "hello"),
    ]);
    assert.equal(homeResponse.status, 200);
    assert.equal(audioResponse.status, 200);
    assert.equal((await audioResponse.arrayBuffer()).byteLength, 64 * 1024);
    assert.equal(sshResponse, "ssh:hello");
    assert.equal(publisher.acceptedConnections(), 1);

    const repeated = await fetch(`${subscriber.home.url}/healthz`);
    assert.equal(repeated.status, 200);
    assert.equal(publisher.acceptedConnections(), 1);
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    closeServer(sshServer),
    closeServer(navidromeServer),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "mux daemon test or cleanup failed",
    );
  }
});

test("one publisher accepts multiple subscribers with independent connections", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-subscribers-"));
  const publisherState = path.join(root, "publisher");
  const subscriberAState = path.join(root, "subscriber-a");
  const subscriberBState = path.join(root, "subscriber-b");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningDogfoodPublisher | undefined;
  let subscriberA: RunningDogfoodClient | undefined;
  let subscriberB: RunningDogfoodClient | undefined;
  let testError: unknown;

  try {
    const [subscriberASetup, subscriberBSetup] = await Promise.all([
      setupClient({ stateDir: subscriberAState, log: noLog }),
      setupClient({ stateDir: subscriberBState, log: noLog }),
    ]);
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      clientPublicKeys: [
        subscriberASetup.publicKey,
        subscriberBSetup.publicKey,
      ],
      services: [],
      log: noLog,
    });
    await Promise.all([
      writePublisherContact({
        stateDir: subscriberAState,
        label: "kosmos",
        publisherKey: publisherSetup.publisherKey,
      }),
      writePublisherContact({
        stateDir: subscriberBState,
        label: "kosmos",
        publisherKey: publisherSetup.publisherKey,
      }),
    ]);

    testnet = await createHyperDhtTestnet(3);
    publisher = await startDogfoodPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    subscriberA = await startDogfoodClient({
      stateDir: subscriberAState,
      bootstrap: testnet.bootstrap,
      services: [],
      log: noLog,
    });
    subscriberB = await startDogfoodClient({
      stateDir: subscriberBState,
      bootstrap: testnet.bootstrap,
      services: [],
      log: noLog,
    });

    const [homeA, homeB] = await Promise.all([
      fetch(subscriberA.home.url),
      fetch(subscriberB.home.url),
    ]);
    assert.equal(homeA.status, 200);
    assert.equal(homeB.status, 200);
    assert.equal(publisher.acceptedConnections(), 2);
    assert.equal(publisher.activeSubscribers(), 2);
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriberA?.stop(),
    subscriberB?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "multi-subscriber test or cleanup failed",
    );
  }
});

test("publisher allowlist rejects an unknown subscriber", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-denied-"));
  const allowedState = path.join(root, "allowed");
  const unknownState = path.join(root, "unknown");
  const publisherState = path.join(root, "publisher");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningDogfoodPublisher | undefined;
  let unknown: RunningDogfoodClient | undefined;
  let testError: unknown;

  try {
    const [allowedSetup] = await Promise.all([
      setupClient({ stateDir: allowedState, log: noLog }),
      setupClient({ stateDir: unknownState, log: noLog }),
    ]);
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      clientPublicKeys: [allowedSetup.publicKey],
      services: [],
      log: noLog,
    });
    await writePublisherContact({
      stateDir: unknownState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });

    testnet = await createHyperDhtTestnet(3);
    publisher = await startDogfoodPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    await assert.rejects(
      async () => {
        unknown = await startDogfoodClient({
          stateDir: unknownState,
          bootstrap: testnet?.bootstrap,
          services: [],
          log: noLog,
        });
      },
      /firewall|denied|connection|handshake|closed/i,
    );
    assert.equal(publisher.acceptedConnections(), 0);
    assert.equal(publisher.activeSubscribers(), 0);
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    unknown?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "allowlist test or cleanup failed",
    );
  }
});

test("subscriber reconnects in the background without changing local ports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-mux-reconnect-"));
  const subscriberState = path.join(root, "subscriber");
  const publisherState = path.join(root, "publisher");
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningDogfoodPublisher | undefined;
  let subscriber: RunningDogfoodClient | undefined;
  let testError: unknown;

  try {
    const subscriberSetup = await setupClient({
      stateDir: subscriberState,
      log: noLog,
    });
    const publisherSetup = await setupPublisher({
      stateDir: publisherState,
      displayName: "kosmos",
      clientPublicKeys: [subscriberSetup.publicKey],
      services: [],
      log: noLog,
    });
    await writePublisherContact({
      stateDir: subscriberState,
      label: "kosmos",
      publisherKey: publisherSetup.publisherKey,
    });
    testnet = await createHyperDhtTestnet(3);
    publisher = await startDogfoodPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });
    subscriber = await startDogfoodClient({
      stateDir: subscriberState,
      bootstrap: testnet.bootstrap,
      services: [],
      log: noLog,
    });
    const homeUrl = subscriber.home.url;
    assert.equal((await fetch(`${homeUrl}/healthz`)).status, 200);

    await publisher.stop();
    publisher = await startDogfoodPublisher({
      stateDir: publisherState,
      bootstrap: testnet.bootstrap,
      log: noLog,
    });

    const recovered = await waitForHttpOk(`${homeUrl}/healthz`);
    assert.equal(recovered.status, 200);
    assert.equal(subscriber.home.url, homeUrl);
    assert.equal(publisher.acceptedConnections(), 1);
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    subscriber?.stop(),
    publisher?.stop(),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "reconnect test or cleanup failed",
    );
  }
});
