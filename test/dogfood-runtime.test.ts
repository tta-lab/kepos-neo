import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parsePublisherConfig, parsePublisherManifest } from "../src/config.js";
import { derivePublisherHomeKey } from "../src/keys.js";
import {
  parseDogfoodClientCliOptions,
  startDogfoodClient,
} from "../src/dogfood/client.js";
import {
  parseDogfoodPublisherCliOptions,
  startDogfoodPublisher,
} from "../src/dogfood/publisher.js";
import { setupClient, writePublisherContact } from "../src/dogfood/setup-client.js";
import { setupPublisher } from "../src/dogfood/setup-publisher.js";

async function fixtureScript(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-dogfood-runtime-"));
  const filePath = path.join(directory, "fixture.cjs");
  await writeFile(filePath, source);
  return filePath;
}

const gracefulServerFixture = `
const fs = require("node:fs");
const HyperDHT = require(process.cwd() + "/node_modules/hyperdht");
const configPath = process.argv[process.argv.indexOf("-c") + 1];
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const key = HyperDHT.keyPair(Buffer.from(config.seed, "hex")).publicKey.toString("hex");
process.on("SIGTERM", () => process.exit(130));
console.log("hypertele: " + key);
setInterval(() => {}, 1000);
`;

const gracefulClientFixture = `
const requestedPort = Number(process.argv[process.argv.indexOf("-p") + 1]);
process.on("SIGTERM", () => process.exit(130));
console.log("Server ready @127.0.0.1:" + (requestedPort || 43199));
setInterval(() => {}, 1000);
`;

test("publisher keeps Home and configured TCP service tunnels alive together", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-dogfood-publisher-"));
  const stateDir = path.join(root, "publisher");
  await setupPublisher({
    stateDir,
    displayName: "kosmos",
    clientPublicKeys: ["11".repeat(32)],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    log: () => undefined,
  });
  const serverEntrypoint = await fixtureScript(gracefulServerFixture);
  const running = await startDogfoodPublisher({
    stateDir,
    serverEntrypoint,
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: () => undefined,
  });

  try {
    const manifest = parsePublisherManifest(
      JSON.parse(await readFile(path.join(stateDir, "publisher.manifest.json"), "utf8")),
    );
    const homeConfig = parsePublisherConfig(
      JSON.parse(await readFile(path.join(stateDir, manifest.homeConfig), "utf8")),
    );
    const sshConfig = parsePublisherConfig(
      JSON.parse(await readFile(path.join(stateDir, manifest.services[0].config), "utf8")),
    );
    const registry = await fetch(`${running.home.url}/.well-known/kepos/services.json`);

    assert.deepEqual(await registry.json(), {
      schemaVersion: 1,
      revision: 1,
      publisher: { displayName: "kosmos" },
      services: [
        {
          id: "home",
          name: "Home",
          kind: "http",
          serviceKey: derivePublisherHomeKey(homeConfig.seed),
        },
        {
          id: "ssh",
          name: "SSH",
          kind: "tcp",
          serviceKey: derivePublisherHomeKey(sshConfig.seed),
        },
      ],
    });
    assert.equal(running.tunnels.length, 2);
    assert.equal(
      running.tunnels.find((tunnel) => tunnel.id === "home")?.process.arguments[1],
      String(running.home.port),
    );
    assert.equal(
      running.tunnels.find((tunnel) => tunnel.id === "ssh")?.process.arguments[1],
      "22",
    );
  } finally {
    await running.stop();
  }
});

test("client keeps Home and selected TCP service on explicit loopback ports", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-dogfood-client-"));
  const stateDir = path.join(root, "client");
  const client = await setupClient({ stateDir, log: () => undefined });
  const homeKey = "22".repeat(32);
  const sshKey = "33".repeat(32);
  await writePublisherContact({ stateDir, label: "kosmos", homeKey });
  const clientEntrypoint = await fixtureScript(gracefulClientFixture);
  const running = await startDogfoodClient({
    stateDir,
    serviceId: "ssh",
    localPort: 2222,
    clientEntrypoint,
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    fetchRegistry: async () => ({
      schemaVersion: 1,
      revision: 1,
      publisher: { displayName: "kosmos" },
      services: [
        { id: "home", name: "Home", kind: "http", serviceKey: homeKey },
        { id: "ssh", name: "SSH", kind: "tcp", serviceKey: sshKey },
      ],
    }),
    log: () => undefined,
  });

  try {
    assert.equal(client.publicKey.length, 64);
    assert.equal(running.home.port, 43199);
    assert.equal(running.home.url, "http://127.0.0.1:43199");
    assert.equal(running.service.id, "ssh");
    assert.equal(running.service.port, 2222);
    assert.equal(running.home.process.arguments.at(-1), homeKey);
    assert.equal(running.service.process.arguments.at(-1), sshKey);
  } finally {
    await running.stop();
  }
});

test("client rejects missing or wrong-kind services and cleans up Home", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-dogfood-client-fail-"));
  const stateDir = path.join(root, "client");
  await setupClient({ stateDir, log: () => undefined });
  const homeKey = "44".repeat(32);
  await writePublisherContact({ stateDir, label: "kosmos", homeKey });
  const stoppedFile = path.join(root, "stopped");
  const clientEntrypoint = await fixtureScript(`
const fs = require("node:fs");
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(stoppedFile)}, "yes");
  process.exit(130);
});
console.log("Server ready @127.0.0.1:43200");
setInterval(() => {}, 1000);
`);

  await assert.rejects(
    () =>
      startDogfoodClient({
        stateDir,
        serviceId: "ssh",
        localPort: 2222,
        clientEntrypoint,
        readinessTimeoutMs: 1_000,
        shutdownTimeoutMs: 100,
        fetchRegistry: async () => ({
          schemaVersion: 1,
          revision: 1,
          publisher: { displayName: "kosmos" },
          services: [{ id: "home", name: "Home", kind: "http", serviceKey: homeKey }],
        }),
        log: () => undefined,
      }),
    /ssh|service/i,
  );
  assert.equal(await readFile(stoppedFile, "utf8"), "yes");
});

test("client stops a selected service process that times out before readiness", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kepos-dogfood-client-timeout-"));
  const stateDir = path.join(root, "client");
  await setupClient({ stateDir, log: () => undefined });
  const homeKey = "55".repeat(32);
  const sshKey = "66".repeat(32);
  await writePublisherContact({ stateDir, label: "kosmos", homeKey });
  const stoppedFile = path.join(root, "service-stopped");
  const clientEntrypoint = await fixtureScript(`
const fs = require("node:fs");
const port = Number(process.argv[process.argv.indexOf("-p") + 1]);
process.on("SIGTERM", () => {
  if (port === 2222) fs.writeFileSync(${JSON.stringify(stoppedFile)}, "yes");
  process.exit(130);
});
if (port === 0) console.log("Server ready @127.0.0.1:43201");
setInterval(() => {}, 1000);
`);

  await assert.rejects(
    () =>
      startDogfoodClient({
        stateDir,
        serviceId: "ssh",
        localPort: 2222,
        clientEntrypoint,
        readinessTimeoutMs: 50,
        shutdownTimeoutMs: 100,
        fetchRegistry: async () => ({
          schemaVersion: 1,
          revision: 1,
          publisher: { displayName: "kosmos" },
          services: [
            { id: "home", name: "Home", kind: "http", serviceKey: homeKey },
            { id: "ssh", name: "SSH", kind: "tcp", serviceKey: sshKey },
          ],
        }),
        log: () => undefined,
      }),
    /readiness timeout/i,
  );
  assert.equal(await readFile(stoppedFile, "utf8"), "yes");
});

test("runtime CLIs parse publisher state and one selected local service", () => {
  assert.deepEqual(parseDogfoodPublisherCliOptions(["--state", "./publisher"]), {
    stateDir: path.resolve("./publisher"),
  });
  assert.deepEqual(
    parseDogfoodClientCliOptions([
      "--state",
      "./client",
      "--service",
      "ssh",
      "--port",
      "2222",
    ]),
    {
      stateDir: path.resolve("./client"),
      serviceId: "ssh",
      localPort: 2222,
    },
  );
});
