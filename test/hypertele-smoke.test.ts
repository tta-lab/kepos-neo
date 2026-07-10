import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { serializePublisherConfig, type PublisherConfig } from "../src/config.js";
import { derivePublisherHomeKey, parseClientIdentity, type ClientIdentity } from "../src/keys.js";
import { startClient, type RunningClient } from "../src/p0/client.js";
import { startPublisher, type RunningPublisher } from "../src/p0/publisher.js";
import { setupP0 } from "../src/p0/setup.js";

interface HyperDhtTestnet {
  bootstrap: Array<{ host: string; port: number }>;
  destroy: () => Promise<void>;
}

type CreateHyperDhtTestnet = (size: number) => Promise<HyperDhtTestnet>;

interface SmokeState {
  publisher: PublisherConfig;
  clientA: ClientIdentity;
  clientB: ClientIdentity;
  publisherPath: string;
  clientAIdentityPath: string;
  clientBIdentityPath: string;
  clientAContactPath: string;
  clientBContactPath: string;
}

const require = createRequire(import.meta.url);
const createHyperDhtTestnet = require("hyperdht/testnet") as CreateHyperDhtTestnet;
const noLog = (): void => undefined;

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

async function createSmokeState(stateDir: string): Promise<SmokeState> {
  await setupP0({ stateDir, log: noLog });
  const publisherPath = path.join(stateDir, "publisher.json");
  return {
    publisher: (await readJson(publisherPath)) as PublisherConfig,
    clientA: parseClientIdentity(await readJson(path.join(stateDir, "client-a.identity.json"))),
    clientB: parseClientIdentity(await readJson(path.join(stateDir, "client-b.identity.json"))),
    publisherPath,
    clientAIdentityPath: path.join(stateDir, "client-a.identity.json"),
    clientBIdentityPath: path.join(stateDir, "client-b.identity.json"),
    clientAContactPath: path.join(stateDir, "client-a.contact.json"),
    clientBContactPath: path.join(stateDir, "client-b.contact.json"),
  };
}

async function writeAllowlist(state: SmokeState, allow: string[]): Promise<void> {
  await writeFile(
    state.publisherPath,
    serializePublisherConfig({ seed: state.publisher.seed, allow }),
    { mode: 0o600 },
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(state.publisherPath)).mode & 0o777, 0o600, "publisher config mode changed");
  }
}

async function assertNoHttpResponse(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let acceptedFailure = false;
    let failure: Error | undefined;
    const request = httpGet(url, { agent: false }, (response) => {
      failure = new assert.AssertionError({
        message: `denied client received HTTP ${response.statusCode ?? "response"}`,
      });
      response.resume();
    });

    request.setTimeout(3_000, () => {
      const timeout = new Error("denied request timed out") as NodeJS.ErrnoException;
      timeout.code = "ETIMEDOUT";
      request.destroy(timeout);
    });
    request.once("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ETIMEDOUT" ||
        error.code === "ECONNRESET" ||
        error.message.toLowerCase().includes("socket hang up")
      ) {
        acceptedFailure = true;
        return;
      }
      failure = new Error(`denied request failed unexpectedly: ${error.code ?? error.message}`, {
        cause: error,
      });
    });
    request.once("close", () => {
      if (failure) {
        reject(failure);
        return;
      }
      if (!acceptedFailure) {
        reject(new Error("denied request closed without a timeout or reset"));
        return;
      }
      resolve();
    });
  });
}

async function assertHomeResponse(homeResponse: Response): Promise<void> {
  assert.equal(homeResponse.status, 200);
  assert.match(await homeResponse.text(), /Local Publisher/);
}

async function assertRegistryResponse(registryResponse: Response, homeKey: string): Promise<void> {
  assert.equal(registryResponse.status, 200);
  const registry = (await registryResponse.json()) as {
    services?: Array<{ id?: string; serviceKey?: string }>;
  };
  assert.deepEqual(registry.services, [{ id: "home", name: "Home", kind: "http", serviceKey: homeKey }]);
}

async function assertHomeAndRegistry(url: string, homeKey: string): Promise<void> {
  const [homeResponse, registryResponse] = await Promise.all([
    fetch(`${url}/`),
    fetch(`${url}/.well-known/kepos/services.json`),
  ]);
  await Promise.all([
    assertHomeResponse(homeResponse),
    assertRegistryResponse(registryResponse, homeKey),
  ]);
}

async function stopResource(resource: RunningClient | RunningPublisher | undefined): Promise<void> {
  await resource?.stop();
}

test("isolated Hypertele smoke proves allowlist restart and two-client access", async () => {
  let root: string | undefined;
  let testnet: HyperDhtTestnet | undefined;
  let publisher: RunningPublisher | undefined;
  let clientA: RunningClient | undefined;
  let clientB: RunningClient | undefined;
  let testError: unknown;

  try {
    root = await mkdtemp(path.join(tmpdir(), "kepos-hypertele-smoke-"));
    const state = await createSmokeState(path.join(root, "p0"));
    const homeKey = derivePublisherHomeKey(state.publisher.seed);
    testnet = await createHyperDhtTestnet(3);
    const bootstrap = testnet.bootstrap[0];
    assert.equal(bootstrap?.host, "127.0.0.1");
    assert.equal(Number.isInteger(bootstrap?.port), true);
    assert.equal((bootstrap?.port ?? 0) >= 1 && (bootstrap?.port ?? 0) <= 65_535, true);
    const bootstrapPort = bootstrap.port;

    await writeAllowlist(state, []);
    publisher = await startPublisher({
      configPath: state.publisherPath,
      testBootstrapPort: bootstrapPort,
      log: noLog,
    });
    assert.equal(await publisher.process.ready, homeKey);

    clientA = await startClient({
      identityPath: state.clientAIdentityPath,
      contactPath: state.clientAContactPath,
      testBootstrapPort: bootstrapPort,
      log: noLog,
    });
    assert.equal(clientA.port > 0, true, "denied client A listener did not become ready");
    await assertNoHttpResponse(`${clientA.url}/healthz`);
    await clientA.stop();
    clientA = undefined;

    await publisher.stop();
    publisher = undefined;
    await writeAllowlist(state, [state.clientA.publicKey]);
    publisher = await startPublisher({
      configPath: state.publisherPath,
      testBootstrapPort: bootstrapPort,
      log: noLog,
    });
    assert.equal(await publisher.process.ready, homeKey);

    clientA = await startClient({
      identityPath: state.clientAIdentityPath,
      contactPath: state.clientAContactPath,
      testBootstrapPort: bootstrapPort,
      log: noLog,
    });
    await assertHomeAndRegistry(clientA.url, homeKey);
    const healthResponse = await fetch(`${clientA.url}/healthz`);
    assert.equal(healthResponse.status, 200);
    assert.equal(await healthResponse.text(), "ok\n");

    clientB = await startClient({
      identityPath: state.clientBIdentityPath,
      contactPath: state.clientBContactPath,
      testBootstrapPort: bootstrapPort,
      log: noLog,
    });
    assert.equal(clientB.port > 0, true, "denied client B listener did not become ready");
    await assertNoHttpResponse(`${clientB.url}/`);

    await writeAllowlist(state, [state.clientA.publicKey, state.clientB.publicKey]);
    await assertNoHttpResponse(`${clientB.url}/healthz`);

    const clientAPort = clientA.port;
    const clientBPort = clientB.port;
    await publisher.stop();
    publisher = undefined;
    publisher = await startPublisher({
      configPath: state.publisherPath,
      testBootstrapPort: bootstrapPort,
      log: noLog,
    });
    assert.equal(await publisher.process.ready, homeKey);
    assert.equal(clientA.port, clientAPort);
    assert.equal(clientB.port, clientBPort);

    const [clientAHome, clientARegistry, clientBHome, clientBRegistry] = await Promise.all([
      fetch(`${clientA.url}/`),
      fetch(`${clientA.url}/.well-known/kepos/services.json`),
      fetch(`${clientB.url}/`),
      fetch(`${clientB.url}/.well-known/kepos/services.json`),
    ]);
    await Promise.all([
      assertHomeResponse(clientAHome),
      assertRegistryResponse(clientARegistry, homeKey),
      assertHomeResponse(clientBHome),
      assertRegistryResponse(clientBRegistry, homeKey),
    ]);
  } catch (error) {
    testError = error;
  }

  const cleanupResults = await Promise.allSettled([
    stopResource(clientB),
    stopResource(clientA),
    stopResource(publisher),
  ]);
  const testnetCleanup = testnet ? await Promise.allSettled([testnet.destroy()]) : [];
  const rootCleanup = root
    ? await Promise.allSettled([rm(root, { recursive: true, force: true })])
    : [];
  const cleanupErrors = [...cleanupResults, ...testnetCleanup, ...rootCleanup]
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);

  if (testError && cleanupErrors.length > 0) {
    throw new AggregateError([testError, ...cleanupErrors], "isolated smoke and cleanup failed");
  }
  if (testError) {
    throw testError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "isolated Hypertele smoke cleanup failed");
  }
});
