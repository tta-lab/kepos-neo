import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  parsePublisherConfig,
  parsePublisherManifest,
  parseSubscriberContact,
} from "../src/config.js";
import { parseClientIdentity } from "../src/keys.js";
import { updatePublisherAllowlist } from "../src/dogfood/allow.js";
import {
  parseSetupClientCliOptions,
  setupClient,
  writePublisherContact,
} from "../src/dogfood/setup-client.js";
import {
  parseSetupPublisherCliOptions,
  setupPublisher,
} from "../src/dogfood/setup-publisher.js";

async function temporaryState(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `kepos-${name}-`));
  return path.join(root, "state");
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

test("subscriber setup creates and preserves one owner-only identity", async () => {
  const stateDir = await temporaryState("subscriber");
  const first = await setupClient({ stateDir, log: () => undefined });
  const identityPath = path.join(stateDir, "client.identity.json");
  const identity = parseClientIdentity(await readJson(identityPath));

  assert.equal(first.created, true);
  assert.equal(first.publicKey, identity.publicKey);
  assert.deepEqual(await readdir(stateDir), ["client.identity.json"]);
  if (process.platform !== "win32") {
    assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
    assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
  }

  assert.deepEqual(await setupClient({ stateDir, log: () => undefined }), {
    created: false,
    publicKey: identity.publicKey,
  });
});

test("publisher setup creates one key and one shared allowlist", async () => {
  const subscriberState = await temporaryState("subscriber");
  const publisherState = await temporaryState("publisher");
  const subscriber = await setupClient({
    stateDir: subscriberState,
    log: () => undefined,
  });
  const result = await setupPublisher({
    stateDir: publisherState,
    displayName: "kosmos",
    clientPublicKeys: [subscriber.publicKey],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    log: () => undefined,
  });

  assert.deepEqual(await readdir(publisherState), [
    "publisher.json",
    "publisher.manifest.json",
  ]);
  assert.deepEqual(
    parsePublisherManifest(
      await readJson(path.join(publisherState, "publisher.manifest.json")),
    ),
    {
      displayName: "kosmos",
      publisherConfig: "publisher.json",
      services: [
        { id: "ssh", name: "SSH", kind: "tcp", targetPort: 22 },
      ],
    },
  );
  const config = parsePublisherConfig(
    await readJson(path.join(publisherState, "publisher.json")),
  );
  assert.deepEqual(config.allow, [subscriber.publicKey]);
  assert.match(result.publisherKey, /^[0-9a-f]{64}$/);
  assert.equal("homeKey" in result, false);
});

test("publisher setup preserves valid state and rejects changed topology", async () => {
  const stateDir = await temporaryState("publisher");
  const options = {
    stateDir,
    displayName: "kosmos",
    clientPublicKeys: ["11".repeat(32)],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    log: () => undefined,
  };
  const first = await setupPublisher(options);
  assert.deepEqual(await setupPublisher(options), { ...first, created: false });
  await assert.rejects(
    () =>
      setupPublisher({
        ...options,
        services: [{ id: "ssh", name: "SSH", targetPort: 2222 }],
      }),
    /existing|manifest|topology|targetPort/i,
  );
});

test("subscriber contact contains one public publisher key", async () => {
  const stateDir = await temporaryState("subscriber-contact");
  await setupClient({ stateDir, log: () => undefined });
  const contactPath = await writePublisherContact({
    stateDir,
    label: "kosmos",
    publisherKey: "22".repeat(32),
  });

  assert.deepEqual(parseSubscriberContact(await readJson(contactPath)), {
    publisherKey: "22".repeat(32),
    label: "kosmos",
    requestedLocalPort: 0,
  });
  assert.equal((await readFile(contactPath, "utf8")).includes("secret"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(contactPath)).mode & 0o777, 0o600);
  }
});

test("role-separated setup rejects partial or unsafe existing state", async () => {
  const subscriberDir = await temporaryState("unsafe-subscriber");
  await setupClient({ stateDir: subscriberDir, log: () => undefined });
  await writeFile(path.join(subscriberDir, "unexpected.json"), "{}\n");
  await assert.rejects(
    () => setupClient({ stateDir: subscriberDir, log: () => undefined }),
    /partial|invalid|unexpected/i,
  );

  const publisherDir = await temporaryState("unsafe-publisher");
  await setupPublisher({
    stateDir: publisherDir,
    displayName: "kosmos",
    clientPublicKeys: ["33".repeat(32)],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    log: () => undefined,
  });
  const configPath = path.join(publisherDir, "publisher.json");
  if (process.platform !== "win32") {
    await chmod(configPath, 0o644);
    await assert.rejects(
      () =>
        setupPublisher({
          stateDir: publisherDir,
          displayName: "kosmos",
          clientPublicKeys: ["33".repeat(32)],
          services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
          log: () => undefined,
        }),
      /mode|permission|owner/i,
    );
    await chmod(configPath, 0o600);
  }
  await rm(configPath);
  await assert.rejects(
    () =>
      setupPublisher({
        stateDir: publisherDir,
        displayName: "kosmos",
        clientPublicKeys: ["33".repeat(32)],
        services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
        log: () => undefined,
      }),
    /partial|invalid|publisher/i,
  );
});

test("setup CLIs and allowlist update use the shared publisher config", async () => {
  assert.deepEqual(parseSetupClientCliOptions(["--state", "./client"]), {
    stateDir: path.resolve("./client"),
  });
  assert.deepEqual(
    parseSetupPublisherCliOptions([
      "--state",
      "./publisher",
      "--display-name",
      "kosmos",
      "--allow",
      "11".repeat(32),
      "--service",
      "ssh:SSH:22",
    ]),
    {
      stateDir: path.resolve("./publisher"),
      displayName: "kosmos",
      clientPublicKeys: ["11".repeat(32)],
      services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    },
  );

  const stateDir = await temporaryState("publisher-revoke");
  await setupPublisher({
    stateDir,
    displayName: "kosmos",
    clientPublicKeys: ["11".repeat(32)],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    log: () => undefined,
  });
  const configPath = path.join(stateDir, "publisher.json");
  const original = parsePublisherConfig(await readJson(configPath));
  await updatePublisherAllowlist({ stateDir, clientPublicKeys: [] });
  assert.deepEqual(parsePublisherConfig(await readJson(configPath)), {
    seed: original.seed,
    allow: [],
  });
});
