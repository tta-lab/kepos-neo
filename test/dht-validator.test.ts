import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildBootstrapCandidates,
  buildRecommendationPayload,
  connectWithoutLocalShortcut,
  guardProbeSocketErrors,
  readBootstrapDiscoveries,
  selectValidationCandidates,
  signRecommendationPayload,
  validateBootstrapCandidate,
  verifySignedRecommendation,
  type BootstrapDiscovery,
  type BootstrapCandidate,
  type BootstrapValidation,
} from "../src/tools/dht-validator.js";
import type { GeoRecord } from "../src/tools/dht-report.js";

const geos = new Map<string, GeoRecord>([
  [
    "47.94.213.63",
    {
      host: "47.94.213.63",
      countryCode: "CN",
      country: "China",
      city: "Beijing",
      latitude: 39.9,
      longitude: 116.4,
      asn: 37_963,
      organization: "Aliyun",
    },
  ],
  [
    "1.1.1.1",
    {
      host: "1.1.1.1",
      countryCode: "JP",
      country: "Japan",
      city: "Tokyo",
      latitude: 35.7,
      longitude: 139.7,
      asn: 64_500,
      organization: "Nearby Network",
    },
  ],
]);

test("bootstrap candidates prioritize stable mainland endpoints before nearby regions", () => {
  const discoveries: BootstrapDiscovery[] = [
    {
      snapshot: "first",
      timestamp: "2026-07-18T00:00:00.000Z",
      endpoint: "47.94.213.63:49737",
      host: "47.94.213.63",
      port: 49_737,
      minimumRttMs: 80,
    },
    {
      snapshot: "second",
      timestamp: "2026-07-18T12:00:00.000Z",
      endpoint: "47.94.213.63:49737",
      host: "47.94.213.63",
      port: 49_737,
      minimumRttMs: 60,
    },
    {
      snapshot: "second",
      timestamp: "2026-07-18T12:00:00.000Z",
      endpoint: "1.1.1.1:49737",
      host: "1.1.1.1",
      port: 49_737,
      minimumRttMs: 30,
    },
  ];

  const candidates = buildBootstrapCandidates(discoveries, geos);

  assert.deepEqual(
    candidates.map(({ endpoint, snapshots, minimumRttMs, regionTier }) => ({
      endpoint,
      snapshots,
      minimumRttMs,
      regionTier,
    })),
    [
      {
        endpoint: "47.94.213.63:49737",
        snapshots: 2,
        minimumRttMs: 60,
        regionTier: 0,
      },
      {
        endpoint: "1.1.1.1:49737",
        snapshots: 1,
        minimumRttMs: 30,
        regionTier: 1,
      },
    ],
  );
});

test("recommendations require cross-time success and deduplicate IP and ASN", () => {
  const candidates = buildBootstrapCandidates(
    [
      {
        snapshot: "first",
        timestamp: "2026-07-18T00:00:00.000Z",
        endpoint: "47.94.213.63:49737",
        host: "47.94.213.63",
        port: 49_737,
        minimumRttMs: 60,
      },
      {
        snapshot: "second",
        timestamp: "2026-07-18T12:00:00.000Z",
        endpoint: "47.94.213.63:49737",
        host: "47.94.213.63",
        port: 49_737,
        minimumRttMs: 70,
      },
      {
        snapshot: "first",
        timestamp: "2026-07-18T00:00:00.000Z",
        endpoint: "47.94.213.63:50000",
        host: "47.94.213.63",
        port: 50_000,
        minimumRttMs: 50,
      },
      {
        snapshot: "first",
        timestamp: "2026-07-18T00:00:00.000Z",
        endpoint: "1.1.1.1:49737",
        host: "1.1.1.1",
        port: 49_737,
        minimumRttMs: 30,
      },
    ],
    geos,
  );
  const validations: BootstrapValidation[] = [
    ...successfulValidations("47.94.213.63:49737"),
    ...successfulValidations("47.94.213.63:50000"),
    ...successfulValidations("1.1.1.1:49737"),
  ];

  const payload = buildRecommendationPayload(
    candidates,
    validations,
    {
      minimumSuccessfulValidations: 2,
      minimumValidationSpanHours: 12,
      maximumRecommendations: 5,
      maximumPerAsn: 1,
      maximumPerCountry: 2,
    },
    "2026-07-19T00:00:00.000Z",
  );

  assert.deepEqual(
    payload.endpoints.map(({ endpoint }) => endpoint),
    ["47.94.213.63:49737", "1.1.1.1:49737"],
  );
});

test("recommendation payloads are signed and verified with a pinned public key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const payload = {
    generatedAt: "2026-07-19T00:00:00.000Z",
    endpoints: [],
  };

  const envelope = signRecommendationPayload(payload, privateKey);

  assert.equal(verifySignedRecommendation(envelope, publicKey), true);
  assert.equal(
    verifySignedRecommendation(
      {
        ...envelope,
        payload: {
          generatedAt: "2026-07-20T00:00:00.000Z",
          endpoints: [],
        },
      },
      publicKey,
    ),
    false,
  );
});

test("recommendations reject validations that may have used the local shortcut", () => {
  const candidates = buildBootstrapCandidates(
    [
      {
        snapshot: "first",
        timestamp: "2026-07-18T00:00:00.000Z",
        endpoint: "47.94.213.63:49737",
        host: "47.94.213.63",
        port: 49_737,
        minimumRttMs: 60,
      },
    ],
    geos,
  );
  const legacyValidations = successfulValidations(
    "47.94.213.63:49737",
  ).map(({ localConnection: _localConnection, ...validation }) => validation);

  const payload = buildRecommendationPayload(
    candidates,
    legacyValidations,
    {
      minimumSuccessfulValidations: 2,
      minimumValidationSpanHours: 12,
      maximumRecommendations: 5,
      maximumPerAsn: 1,
      maximumPerCountry: 2,
    },
    "2026-07-19T00:00:00.000Z",
  );

  assert.deepEqual(payload.endpoints, []);
});

test("candidate validation records isolated bootstrap probe evidence", async () => {
  const [candidate] = buildBootstrapCandidates(
    [
      {
        snapshot: "first",
        timestamp: "2026-07-18T00:00:00.000Z",
        endpoint: "47.94.213.63:49737",
        host: "47.94.213.63",
        port: 49_737,
        minimumRttMs: 60,
      },
    ],
    geos,
  );

  const validation = await validateBootstrapCandidate(
    candidate,
    async () => ({
      bootstrapMs: 450,
      lookupReplies: 12,
      announceConnect: true,
      connectMs: 700,
      localConnection: false,
    }),
    "2026-07-19T00:00:00.000Z",
  );

  assert.deepEqual(validation, {
    endpoint: "47.94.213.63:49737",
    timestamp: "2026-07-19T00:00:00.000Z",
    success: true,
    bootstrapMs: 450,
    lookupReplies: 12,
    announceConnect: true,
    connectMs: 700,
    localConnection: false,
  });
});

test("discovery loader keeps only verified responders from graph snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-validator-"));
  try {
    const snapshot = path.join(root, "snapshots", "snapshot-a");
    await mkdir(snapshot, { recursive: true });
    await writeFile(
      path.join(snapshot, "run.json"),
      JSON.stringify({ startedAt: "2026-07-18T00:00:00.000Z" }),
    );
    await writeFile(
      path.join(snapshot, "nodes.jsonl"),
      [
        JSON.stringify({
          endpoint: "47.94.213.63:49737",
          host: "47.94.213.63",
          port: 49_737,
          verified: true,
          minimumRttMs: 60,
        }),
        JSON.stringify({
          endpoint: "1.1.1.1:49737",
          host: "1.1.1.1",
          port: 49_737,
          verified: false,
          minimumRttMs: null,
        }),
      ].join("\n"),
    );

    const discoveries = await readBootstrapDiscoveries(root);

    assert.deepEqual(discoveries, [
      {
        snapshot: "snapshot-a",
        timestamp: "2026-07-18T00:00:00.000Z",
        endpoint: "47.94.213.63:49737",
        host: "47.94.213.63",
        port: 49_737,
        minimumRttMs: 60,
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("probe sockets keep reset errors from terminating the validator", () => {
  const socket = new EventEmitter();

  guardProbeSocketErrors(socket);

  assert.doesNotThrow(() => socket.emit("error", new Error("reset")));
});

test("validation batches skip recent hosts and spread work across ASN and country", () => {
  const candidates = [
    candidate("1.1.1.1:49737", "1.1.1.1", "CN", 100),
    candidate("1.1.1.1:50000", "1.1.1.1", "CN", 100),
    candidate("2.2.2.2:49737", "2.2.2.2", "CN", 100),
    candidate("3.3.3.3:49737", "3.3.3.3", "CN", 200),
    candidate("4.4.4.4:49737", "4.4.4.4", "HK", 300),
  ];
  const validations: BootstrapValidation[] = [
    {
      endpoint: "1.1.1.1:49737",
      timestamp: "2026-07-18T12:00:00.000Z",
      success: true,
      bootstrapMs: 500,
      lookupReplies: 10,
      announceConnect: true,
      connectMs: 700,
    },
  ];

  const selected = selectValidationCandidates(candidates, validations, {
    limit: 3,
    recheckCutoff: "2026-07-18T00:00:00.000Z",
    maximumPerAsn: 1,
    maximumPerCountry: 2,
  });

  assert.deepEqual(
    selected.map(({ endpoint }) => endpoint),
    ["2.2.2.2:49737", "3.3.3.3:49737", "4.4.4.4:49737"],
  );
});

test("isolated probes disable the HyperDHT local connection shortcut", () => {
  let options: { localConnection: boolean } | undefined;
  const socket = new EventEmitter();

  const connected = connectWithoutLocalShortcut(
    {
      connect(_publicKey, receivedOptions) {
        options = receivedOptions;
        return socket;
      },
    },
    Buffer.alloc(32),
  );

  assert.equal(connected, socket);
  assert.deepEqual(options, { localConnection: false });
});

function successfulValidations(endpoint: string): BootstrapValidation[] {
  return [
    {
      endpoint,
      timestamp: "2026-07-18T00:00:00.000Z",
      success: true,
      bootstrapMs: 500,
      lookupReplies: 10,
      announceConnect: true,
      connectMs: 800,
      localConnection: false,
    },
    {
      endpoint,
      timestamp: "2026-07-18T12:00:00.000Z",
      success: true,
      bootstrapMs: 400,
      lookupReplies: 12,
      announceConnect: true,
      connectMs: 700,
      localConnection: false,
    },
  ];
}

function candidate(
  endpoint: string,
  host: string,
  countryCode: string,
  asn: number,
): BootstrapCandidate {
  return {
    endpoint,
    host,
    port: Number(endpoint.split(":").at(-1)),
    firstSeen: "2026-07-18T00:00:00.000Z",
    lastSeen: "2026-07-18T12:00:00.000Z",
    snapshots: 2,
    minimumRttMs: 50,
    countryCode,
    country: countryCode,
    city: "",
    asn,
    organization: `AS${asn}`,
    regionTier: countryCode === "CN" ? 0 : 1,
  };
}
