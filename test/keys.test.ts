import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parsePublisherConfig } from "../src/config.js";
import {
  derivePublisherHomeKey,
  generateClientIdentity,
  generatePublisherSeed,
  parseClientIdentity,
  serializeClientIdentity,
} from "../src/keys.js";
import { setupP0, writeP0StateAtomically, type P0State } from "../src/p0/setup.js";

const expectedFiles = [
  "client-a.contact.json",
  "client-a.identity.json",
  "client-b.contact.json",
  "client-b.identity.json",
  "publisher.json",
];

async function makeRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "kepos-p0-test-"));
}

async function snapshotDirectory(directory: string): Promise<Map<string, Buffer>> {
  const snapshot = new Map<string, Buffer>();
  for (const name of await readdir(directory)) {
    snapshot.set(name, await readFile(path.join(directory, name)));
  }
  return snapshot;
}

function assertSnapshotsEqual(actual: Map<string, Buffer>, expected: Map<string, Buffer>): void {
  assert.deepEqual([...actual.keys()].sort(), [...expected.keys()].sort());
  for (const [name, contents] of expected) {
    assert.deepEqual(actual.get(name), contents, `${name} changed`);
  }
}

test("publisher seed and derived Home public key are exactly 32 bytes", () => {
  const publisherSeed = generatePublisherSeed();
  const homeKey = derivePublisherHomeKey(publisherSeed);

  assert.match(publisherSeed, /^[0-9a-f]{64}$/);
  assert.match(homeKey, /^[0-9a-f]{64}$/);
});

test("generated client identity has a HyperDHT-compatible 32-byte public and 64-byte secret key", () => {
  const identity = generateClientIdentity();

  assert.match(identity.publicKey, /^[0-9a-f]{64}$/);
  assert.match(identity.secretKey, /^[0-9a-f]{128}$/);
  assert.deepEqual(parseClientIdentity(identity), identity);
});

test("client identity round-trips through its native Hypertele JSON shape", () => {
  const identity = generateClientIdentity();

  assert.deepEqual(parseClientIdentity(JSON.parse(serializeClientIdentity(identity))), identity);
  assert.deepEqual(Object.keys(JSON.parse(serializeClientIdentity(identity))).sort(), [
    "publicKey",
    "secretKey",
  ]);
});

test("client identity rejects a public key that does not match the seed portion of its secret key", () => {
  const identity = generateClientIdentity();
  const otherIdentity = generateClientIdentity();

  assert.throws(
    () => parseClientIdentity({ ...identity, publicKey: otherIdentity.publicKey }),
    /publicKey|identity/i,
  );
});

test("client identity rejects a secret key whose trailing bytes do not match the derived keypair", () => {
  const identity = generateClientIdentity();
  const lastByte = identity.secretKey.slice(-2) === "00" ? "01" : "00";

  assert.throws(
    () => parseClientIdentity({ ...identity, secretKey: identity.secretKey.slice(0, -2) + lastByte }),
    /secretKey|identity/i,
  );
});

test("first setup creates the exact P0 state with A allowed and B denied", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  const result = await setupP0({ stateDir, log: () => undefined });

  assert.equal(result.created, true);
  assert.deepEqual((await readdir(stateDir)).sort(), expectedFiles);

  const publisher = parsePublisherConfig(JSON.parse(await readFile(path.join(stateDir, "publisher.json"), "utf8")));
  const clientA = parseClientIdentity(
    JSON.parse(await readFile(path.join(stateDir, "client-a.identity.json"), "utf8")),
  );
  const clientB = parseClientIdentity(
    JSON.parse(await readFile(path.join(stateDir, "client-b.identity.json"), "utf8")),
  );

  assert.deepEqual(publisher.allow, [clientA.publicKey]);
  assert.equal(publisher.allow.includes(clientB.publicKey), false);
  assert.equal(result.homeKey, derivePublisherHomeKey(publisher.seed));
});

test("setup contacts pin the derived Home key and request an ephemeral local port", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  const { homeKey } = await setupP0({ stateDir, log: () => undefined });

  for (const client of ["a", "b"]) {
    const contact = JSON.parse(
      await readFile(path.join(stateDir, `client-${client}.contact.json`), "utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(contact, {
      homeKey,
      label: "Local Publisher",
      requestedLocalPort: 0,
    });
  }
});

test("setup uses owner-only permissions for its directory and secret-bearing files", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  await setupP0({ stateDir, log: () => undefined });

  assert.equal((await stat(stateDir)).mode & 0o777, 0o700);
  for (const name of ["publisher.json", "client-a.identity.json", "client-b.identity.json"]) {
    assert.equal((await stat(path.join(stateDir, name))).mode & 0o777, 0o600, name);
  }
});

test("second setup validates and preserves every generated file byte-for-byte", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  const first = await setupP0({ stateDir, log: () => undefined });
  const before = await snapshotDirectory(stateDir);
  const second = await setupP0({ stateDir, log: () => undefined });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.homeKey, first.homeKey);
  assertSnapshotsEqual(await snapshotDirectory(stateDir), before);
});

test("partial existing state is rejected without overwriting any file", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  await setupP0({ stateDir, log: () => undefined });
  await rm(path.join(stateDir, "client-b.contact.json"));
  const before = await snapshotDirectory(stateDir);

  await assert.rejects(() => setupP0({ stateDir, log: () => undefined }), /invalid|partial|contact/i);
  assertSnapshotsEqual(await snapshotDirectory(stateDir), before);
});

test("invalid existing state is rejected without regenerating any key", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  await setupP0({ stateDir, log: () => undefined });
  const publisherPath = path.join(stateDir, "publisher.json");
  const publisher = JSON.parse(await readFile(publisherPath, "utf8")) as Record<string, unknown>;
  await writeFile(publisherPath, `${JSON.stringify({ ...publisher, allow: null }, null, 2)}\n`);
  const before = await snapshotDirectory(stateDir);

  await assert.rejects(() => setupP0({ stateDir, log: () => undefined }), /allow|invalid/i);
  assertSnapshotsEqual(await snapshotDirectory(stateDir), before);
});

test("setup rejects reused secret files that are readable by other users", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  await setupP0({ stateDir, log: () => undefined });
  const publisherPath = path.join(stateDir, "publisher.json");
  await chmod(publisherPath, 0o644);

  await assert.rejects(() => setupP0({ stateDir, log: () => undefined }), /mode|permission|owner/i);
  assert.equal((await stat(publisherPath)).mode & 0o777, 0o644);
});

test("setup rejects symlinks in reused state", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  await setupP0({ stateDir, log: () => undefined });
  const identityPath = path.join(stateDir, "client-a.identity.json");
  const outsidePath = path.join(root, "outside.identity.json");
  await writeFile(outsidePath, await readFile(identityPath));
  await rm(identityPath);
  await symlink(outsidePath, identityPath);

  await assert.rejects(() => setupP0({ stateDir, log: () => undefined }), /regular|symlink|state/i);
});

test("setup rejects copied client identities instead of treating one key as two clients", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  await setupP0({ stateDir, log: () => undefined });
  const clientAPath = path.join(stateDir, "client-a.identity.json");
  const clientBPath = path.join(stateDir, "client-b.identity.json");
  await writeFile(clientBPath, await readFile(clientAPath), { mode: 0o600 });
  const before = await snapshotDirectory(stateDir);

  await assert.rejects(() => setupP0({ stateDir, log: () => undefined }), /distinct|independent/i);
  assertSnapshotsEqual(await snapshotDirectory(stateDir), before);
});

test("atomic writer validates the complete state before creating the final directory", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  const invalidState = {
    publisher: { seed: "00".repeat(32), allow: null },
  } as unknown as P0State;

  await assert.rejects(() => writeP0StateAtomically(stateDir, invalidState), /allow|invalid/i);
  await assert.rejects(() => stat(stateDir), { code: "ENOENT" });
  const tmpParent = path.dirname(stateDir);
  assert.deepEqual(await readdir(tmpParent).catch(() => []), []);
});

test("setup logs public keys and paths but never seeds or client secrets", async () => {
  const root = await makeRoot();
  const stateDir = path.join(root, "tmp", "p0");
  const lines: string[] = [];
  const result = await setupP0({ stateDir, log: (line) => lines.push(line) });
  const publisher = parsePublisherConfig(JSON.parse(await readFile(path.join(stateDir, "publisher.json"), "utf8")));
  const clientA = parseClientIdentity(
    JSON.parse(await readFile(path.join(stateDir, "client-a.identity.json"), "utf8")),
  );
  const clientB = parseClientIdentity(
    JSON.parse(await readFile(path.join(stateDir, "client-b.identity.json"), "utf8")),
  );
  const output = lines.join("\n");

  assert.match(output, new RegExp(result.homeKey));
  assert.match(output, new RegExp(clientA.publicKey));
  assert.match(output, new RegExp(clientB.publicKey));
  assert.match(output, new RegExp(stateDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(output.includes(publisher.seed), false);
  assert.equal(output.includes(clientA.secretKey), false);
  assert.equal(output.includes(clientB.secretKey), false);
});
