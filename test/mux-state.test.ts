import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parsePublisherConfig,
  parsePublisherManifest,
  parseSubscriberContact,
} from "../src/config.js";
import { createMuxHomeRegistry } from "../src/home/registry.js";
import { setupClient, writePublisherContact } from "../src/dogfood/setup-client.js";
import { setupPublisher } from "../src/dogfood/setup-publisher.js";

async function stateDirectory(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kepos-mux-${name}-`));
  return path.join(root, "state");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

test("publisher state has one key and no per-service config or key", async () => {
  const stateDir = await stateDirectory("publisher");
  const subscriber = await setupClient({
    stateDir: await stateDirectory("subscriber"),
    log: () => undefined,
  });
  const result = await setupPublisher({
    stateDir,
    displayName: "kosmos",
    clientPublicKeys: [subscriber.publicKey],
    services: [
      { id: "navidrome", name: "Navidrome", targetPort: 4533 },
      { id: "ssh", name: "SSH", targetPort: 22 },
    ],
    log: () => undefined,
  });

  assert.deepEqual((await readdir(stateDir)).sort(), [
    "publisher.json",
    "publisher.manifest.json",
  ]);
  const manifest = parsePublisherManifest(
    await readJson(path.join(stateDir, "publisher.manifest.json")),
  );
  const publisher = parsePublisherConfig(
    await readJson(path.join(stateDir, "publisher.json")),
  );
  assert.deepEqual(manifest, {
    displayName: "kosmos",
    publisherConfig: "publisher.json",
    services: [
      {
        id: "navidrome",
        name: "Navidrome",
        kind: "tcp",
        targetPort: 4533,
      },
      {
        id: "ssh",
        name: "SSH",
        kind: "tcp",
        targetPort: 22,
      },
    ],
  });
  assert.deepEqual(publisher.allow, [subscriber.publicKey]);
  assert.equal(result.publisherKey.length, 64);
  assert.equal("homeKey" in result, false);
  assert.equal("services" in result, false);
});

test("subscriber pins one publisher key and Registry contains service ids only", async () => {
  const stateDir = await stateDirectory("subscriber-contact");
  await setupClient({ stateDir, log: () => undefined });
  const publisherKey = "22".repeat(32);
  const contactPath = await writePublisherContact({
    stateDir,
    label: "kosmos",
    publisherKey,
  });

  assert.deepEqual(parseSubscriberContact(await readJson(contactPath)), {
    publisherKey,
    label: "kosmos",
    requestedLocalPort: 0,
  });
  assert.deepEqual(
    createMuxHomeRegistry({
      publisherKey,
      displayName: "kosmos",
      services: [{ id: "navidrome", name: "Navidrome", kind: "tcp" }],
    }),
    {
      schemaVersion: 2,
      revision: 1,
      publisher: {
        displayName: "kosmos",
        publisherKey,
      },
      services: [
        { id: "home", name: "Home", kind: "http" },
        { id: "navidrome", name: "Navidrome", kind: "tcp" },
      ],
    },
  );
});
