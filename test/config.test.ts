import assert from "node:assert/strict";
import { test } from "node:test";

import {
  parseClientContact,
  parsePublisherConfig,
  serializeClientContact,
  serializePublisherConfig,
} from "../src/config.js";

const publicKey = "11".repeat(32);
const otherPublicKey = "22".repeat(32);
const seed = "33".repeat(32);

test("publisher config accepts an empty allowlist as deny-all", () => {
  assert.deepEqual(parsePublisherConfig({ seed, allow: [] }), { seed, allow: [] });
});

test("publisher config round-trips Hypertele native seed and allow fields", () => {
  const config = { seed, allow: [publicKey, otherPublicKey] };

  assert.deepEqual(parsePublisherConfig(JSON.parse(serializePublisherConfig(config))), config);
});

for (const [name, value] of [
  ["missing", { seed }],
  ["null", { seed, allow: null }],
  ["non-array", { seed, allow: publicKey }],
] as const) {
  test(`publisher config rejects ${name} allow instead of passing fail-open state to Hypertele`, () => {
    assert.throws(() => parsePublisherConfig(value), /allow/i);
  });
}

for (const malformed of ["", "0", "gg".repeat(32), "aa".repeat(31), "AA".repeat(32)]) {
  test(`publisher config rejects malformed allow entry ${JSON.stringify(malformed)}`, () => {
    assert.throws(() => parsePublisherConfig({ seed, allow: [malformed] }), /allow/i);
  });
}

test("publisher config rejects malformed publisher seeds", () => {
  assert.throws(() => parsePublisherConfig({ seed: "ff".repeat(31), allow: [] }), /seed/i);
});

test("publisher config contains no separate publisher or person identity key", () => {
  const serialized = JSON.parse(serializePublisherConfig({ seed, allow: [publicKey] })) as Record<
    string,
    unknown
  >;

  assert.deepEqual(Object.keys(serialized).sort(), ["allow", "seed"]);
  assert.equal("publisherKey" in serialized, false);
  assert.equal("personKey" in serialized, false);
});

test("publisher config rejects fields outside the native seed and allow shape", () => {
  assert.throws(
    () => parsePublisherConfig({ seed, allow: [publicKey], secretKey: "ff".repeat(64) }),
    /field|property|shape/i,
  );
});

test("client contact round-trips a pinned Home key, local label, and ephemeral port request", () => {
  const contact = {
    homeKey: publicKey,
    label: "Local Publisher",
    requestedLocalPort: 0,
  };

  assert.deepEqual(parseClientContact(JSON.parse(serializeClientContact(contact))), contact);
});

test("client contact rejects an invalid Home key", () => {
  assert.throws(
    () =>
      parseClientContact({
        homeKey: "ff",
        label: "Local Publisher",
        requestedLocalPort: 0,
      }),
    /homeKey/i,
  );
});

test("client contact rejects a blank label", () => {
  assert.throws(
    () => parseClientContact({ homeKey: publicKey, label: "  ", requestedLocalPort: 0 }),
    /label/i,
  );
});

test("client contact rejects an invalid requested local port", () => {
  assert.throws(
    () => parseClientContact({ homeKey: publicKey, label: "Publisher", requestedLocalPort: -1 }),
    /requestedLocalPort/i,
  );
});
