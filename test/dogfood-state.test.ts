import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseClientContact, parsePublisherConfig, parsePublisherManifest } from "../src/config.js";
import { derivePublisherHomeKey, parseClientIdentity } from "../src/keys.js";
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

test("client setup creates and preserves one owner-only identity", async () => {
  const stateDir = await temporaryState("client");
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

  const second = await setupClient({ stateDir, log: () => undefined });
  assert.deepEqual(second, { created: false, publicKey: identity.publicKey });
  assert.deepEqual(parseClientIdentity(await readJson(identityPath)), identity);
});

test("publisher setup creates Home and TCP seeds locally with one shared allowlist", async () => {
  const clientStateDir = await temporaryState("client");
  const publisherStateDir = await temporaryState("publisher");
  const client = await setupClient({ stateDir: clientStateDir, log: () => undefined });
  const result = await setupPublisher({
    stateDir: publisherStateDir,
    displayName: "kosmos",
    clientPublicKeys: [client.publicKey],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    log: () => undefined,
  });

  const manifest = parsePublisherManifest(
    await readJson(path.join(publisherStateDir, "publisher.manifest.json")),
  );
  const home = parsePublisherConfig(
    await readJson(path.join(publisherStateDir, "home.publisher.json")),
  );
  const ssh = parsePublisherConfig(
    await readJson(path.join(publisherStateDir, "ssh.publisher.json")),
  );

  assert.deepEqual(manifest, {
    displayName: "kosmos",
    homeConfig: "home.publisher.json",
    services: [
      {
        id: "ssh",
        name: "SSH",
        kind: "tcp",
        targetPort: 22,
        config: "ssh.publisher.json",
      },
    ],
  });
  assert.deepEqual(home.allow, [client.publicKey]);
  assert.deepEqual(ssh.allow, [client.publicKey]);
  assert.notEqual(home.seed, ssh.seed);
  assert.deepEqual(result, {
    created: true,
    homeKey: derivePublisherHomeKey(home.seed),
    services: [{ id: "ssh", serviceKey: derivePublisherHomeKey(ssh.seed) }],
  });

  const serializedState = (
    await Promise.all(
      (await readdir(publisherStateDir)).map((name) =>
        readFile(path.join(publisherStateDir, name), "utf8"),
      ),
    )
  ).join("");
  assert.equal(serializedState.includes("secretKey"), false);
});

test("publisher setup preserves valid state and rejects changed topology", async () => {
  const stateDir = await temporaryState("publisher");
  const clientKey = "11".repeat(32);
  const options = {
    stateDir,
    displayName: "kosmos",
    clientPublicKeys: [clientKey],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    log: () => undefined,
  };
  const first = await setupPublisher(options);
  const second = await setupPublisher(options);

  assert.equal(first.created, true);
  assert.deepEqual(second, { ...first, created: false });
  await assert.rejects(
    () =>
      setupPublisher({
        ...options,
        services: [{ id: "ssh", name: "SSH", targetPort: 2222 }],
      }),
    /existing|manifest|topology|targetPort/i,
  );
});

test("client contact contains public publisher data only", async () => {
  const stateDir = await temporaryState("client-contact");
  await setupClient({ stateDir, log: () => undefined });
  const contactPath = await writePublisherContact({
    stateDir,
    label: "kosmos",
    homeKey: "22".repeat(32),
  });

  assert.equal(contactPath, path.join(stateDir, "publisher.contact.json"));
  assert.deepEqual(parseClientContact(await readJson(contactPath)), {
    homeKey: "22".repeat(32),
    label: "kosmos",
    requestedLocalPort: 0,
  });
  assert.equal((await readFile(contactPath, "utf8")).includes("secret"), false);
  if (process.platform !== "win32") {
    assert.equal((await stat(contactPath)).mode & 0o777, 0o600);
  }
});

test("role-separated setup rejects partial or unsafe existing state", async () => {
  const clientDir = await temporaryState("unsafe-client");
  await setupClient({ stateDir: clientDir, log: () => undefined });
  await writeFile(path.join(clientDir, "unexpected.json"), "{}\n");
  await assert.rejects(
    () => setupClient({ stateDir: clientDir, log: () => undefined }),
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
  const homeConfig = path.join(publisherDir, "home.publisher.json");
  if (process.platform !== "win32") {
    await chmod(homeConfig, 0o644);
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
    await chmod(homeConfig, 0o600);
  }

  await rm(path.join(publisherDir, "ssh.publisher.json"));
  await assert.rejects(
    () =>
      setupPublisher({
        stateDir: publisherDir,
        displayName: "kosmos",
        clientPublicKeys: ["33".repeat(32)],
        services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
        log: () => undefined,
      }),
    /partial|invalid|ssh/i,
  );
});

test("setup CLIs parse explicit role-local state and public configuration", () => {
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
});

test("publisher allowlist update applies revocation to every service without rotating seeds", async () => {
  const stateDir = await temporaryState("publisher-revoke");
  await setupPublisher({
    stateDir,
    displayName: "kosmos",
    clientPublicKeys: ["11".repeat(32)],
    services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    log: () => undefined,
  });
  const homePath = path.join(stateDir, "home.publisher.json");
  const sshPath = path.join(stateDir, "ssh.publisher.json");
  const originalHome = parsePublisherConfig(await readJson(homePath));
  const originalSsh = parsePublisherConfig(await readJson(sshPath));

  await updatePublisherAllowlist({ stateDir, clientPublicKeys: [] });

  assert.deepEqual(parsePublisherConfig(await readJson(homePath)), {
    seed: originalHome.seed,
    allow: [],
  });
  assert.deepEqual(parsePublisherConfig(await readJson(sshPath)), {
    seed: originalSsh.seed,
    allow: [],
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(homePath)).mode & 0o777, 0o600);
    assert.equal((await stat(sshPath)).mode & 0o777, 0o600);
  }
});
