import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parsePublisherConfig } from "../src/config.js";
import { startDogfoodClient, type RunningDogfoodClient } from "../src/dogfood/client.js";
import {
  startDogfoodPublisher,
  type RunningDogfoodPublisher,
} from "../src/dogfood/publisher.js";
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

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("TCP fixture address is unavailable");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
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
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length >= `kosmos:${payload}`.length) {
        socket.end();
      }
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(response));
  });
}

test("isolated DHT carries Home and TCP through one identity and stable service keys", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-dogfood-smoke-"));
  const clientStateDir = path.join(root, "client");
  const publisherStateDir = path.join(root, "publisher");
  const tcpServer = createServer((socket) => {
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => socket.write(`kosmos:${chunk}`));
  });
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningDogfoodPublisher | undefined;
  let client: RunningDogfoodClient | undefined;
  let testError: unknown;

  try {
    const targetPort = await listen(tcpServer);
    const clientSetup = await setupClient({ stateDir: clientStateDir, log: noLog });
    const publisherSetup = await setupPublisher({
      stateDir: publisherStateDir,
      displayName: "kosmos",
      clientPublicKeys: [clientSetup.publicKey],
      services: [{ id: "ssh", name: "SSH", targetPort }],
      log: noLog,
    });
    await writePublisherContact({
      stateDir: clientStateDir,
      label: "kosmos",
      homeKey: publisherSetup.homeKey,
    });
    const originalHomeConfig = parsePublisherConfig(
      JSON.parse(
        await readFile(path.join(publisherStateDir, "home.publisher.json"), "utf8"),
      ) as unknown,
    );
    const originalServiceConfig = parsePublisherConfig(
      JSON.parse(
        await readFile(path.join(publisherStateDir, "ssh.publisher.json"), "utf8"),
      ) as unknown,
    );

    testnet = await createHyperDhtTestnet(3);
    const bootstrap = testnet.bootstrap[0];
    assert.ok(bootstrap);
    publisher = await startDogfoodPublisher({
      stateDir: publisherStateDir,
      testBootstrapPort: bootstrap.port,
      log: noLog,
    });
    client = await startDogfoodClient({
      stateDir: clientStateDir,
      serviceId: "ssh",
      localPort: 0,
      testBootstrapPort: bootstrap.port,
      log: noLog,
    });

    const [home, registry, tcpResponse] = await Promise.all([
      fetch(`${client.home.url}/`),
      fetch(`${client.home.url}/.well-known/kepos/services.json`),
      exchangeTcp(client.service.port, "hello"),
    ]);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /Local Publisher/);
    assert.equal(registry.status, 200);
    assert.deepEqual(
      ((await registry.json()) as { services: Array<{ id: string }> }).services.map(
        (service) => service.id,
      ),
      ["home", "ssh"],
    );
    assert.equal(tcpResponse, "kosmos:hello");

    await client.stop();
    client = undefined;
    await publisher.stop();
    publisher = undefined;
    const repeatedSetup = await setupPublisher({
      stateDir: publisherStateDir,
      displayName: "kosmos",
      clientPublicKeys: [clientSetup.publicKey],
      services: [{ id: "ssh", name: "SSH", targetPort }],
      log: noLog,
    });
    assert.equal(repeatedSetup.created, false);
    assert.equal(repeatedSetup.homeKey, publisherSetup.homeKey);
    assert.deepEqual(repeatedSetup.services, publisherSetup.services);
    assert.deepEqual(
      parsePublisherConfig(
        JSON.parse(
          await readFile(path.join(publisherStateDir, "home.publisher.json"), "utf8"),
        ) as unknown,
      ),
      originalHomeConfig,
    );
    assert.deepEqual(
      parsePublisherConfig(
        JSON.parse(
          await readFile(path.join(publisherStateDir, "ssh.publisher.json"), "utf8"),
        ) as unknown,
      ),
      originalServiceConfig,
    );
  } catch (error) {
    testError = error;
  }

  const cleanup = await Promise.allSettled([
    client?.stop(),
    publisher?.stop(),
    closeServer(tcpServer),
    testnet?.destroy(),
    rm(root, { recursive: true, force: true }),
  ]);
  const cleanupErrors = cleanup
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (testError || cleanupErrors.length > 0) {
    throw new AggregateError(
      [testError, ...cleanupErrors].filter((error) => error !== undefined),
      "dogfood smoke or cleanup failed",
    );
  }
});
