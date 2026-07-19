import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import {
  buildBootstrapGroups,
  buildTrialSchedule,
  runBootstrapBenchmark,
  runBootstrapProbe,
  summarizeBenchmark,
  type BootstrapBenchmarkResult,
} from "../src/tools/bootstrap-benchmark.js";

const recommendations = {
  algorithm: "Ed25519",
  payload: {
    generatedAt: "2026-07-19T00:00:00.000Z",
    endpoints: [
      {
        endpoint: "47.94.213.63:49737",
        host: "47.94.213.63",
        port: 49737,
        countryCode: "CN",
      },
      {
        endpoint: "203.91.75.19:49738",
        host: "203.91.75.19",
        port: 49738,
        countryCode: "HK",
      },
      {
        endpoint: "34.143.181.65:49738",
        host: "34.143.181.65",
        port: 49738,
        countryCode: "SG",
      },
      {
        endpoint: "134.209.3.19:49739",
        host: "134.209.3.19",
        port: 49739,
        countryCode: "US",
      },
    ],
  },
  signature: "unused by group construction",
};

test("bootstrap benchmark builds the four requested groups", () => {
  const groups = buildBootstrapGroups(recommendations);

  assert.deepEqual(
    groups.map(({ name }) => name),
    ["default", "cn-hk", "cn-hk-sg", "recommended-plus-default"],
  );
  assert.equal(groups[0]?.bootstrap, undefined);
  assert.deepEqual(groups[1]?.bootstrap, [
    "47.94.213.63:49737",
    "203.91.75.19:49738",
  ]);
  assert.deepEqual(groups[2]?.bootstrap, [
    "47.94.213.63:49737",
    "203.91.75.19:49738",
    "34.143.181.65:49738",
  ]);
  assert.deepEqual(groups[3]?.bootstrap, [
    "47.94.213.63:49737",
    "203.91.75.19:49738",
    "34.143.181.65:49738",
    "134.209.3.19:49739",
    "88.99.3.86@node1.hyperdht.org:49737",
    "142.93.90.113@node2.hyperdht.org:49737",
    "138.68.147.8@node3.hyperdht.org:49737",
  ]);
});

test("bootstrap benchmark alternates groups with fresh sequence numbers", () => {
  const schedule = buildTrialSchedule(
    buildBootstrapGroups(recommendations),
    2,
  );

  assert.deepEqual(
    schedule.map(({ group, trial, sequence }) => ({
      group: group.name,
      trial,
      sequence,
    })),
    [
      { group: "default", trial: 1, sequence: 1 },
      { group: "cn-hk", trial: 1, sequence: 2 },
      { group: "cn-hk-sg", trial: 1, sequence: 3 },
      { group: "recommended-plus-default", trial: 1, sequence: 4 },
      { group: "default", trial: 2, sequence: 5 },
      { group: "cn-hk", trial: 2, sequence: 6 },
      { group: "cn-hk-sg", trial: 2, sequence: 7 },
      { group: "recommended-plus-default", trial: 2, sequence: 8 },
    ],
  );
});

test("bootstrap benchmark reports nearest-rank latency and outer failure rate", () => {
  const results: BootstrapBenchmarkResult[] = [
    result("default", 1, 100, 250),
    result("default", 2, 200, 350),
    result("default", 3, 300, 450),
    result("default", 4, null, null, "bootstrap timeout"),
    result("cn-hk", 5, 50, 150),
    result("cn-hk", 6, 70, null, "outer timeout"),
  ];

  assert.deepEqual(summarizeBenchmark(results), [
    {
      group: "default",
      attempts: 4,
      successes: 3,
      failures: 1,
      failureRate: 0.25,
      bootstrapMs: { samples: 3, p50: 200, p90: 300 },
      outerMs: { samples: 3, p50: 350, p90: 450 },
    },
    {
      group: "cn-hk",
      attempts: 2,
      successes: 1,
      failures: 1,
      failureRate: 0.5,
      bootstrapMs: { samples: 2, p50: 50, p90: 70 },
      outerMs: { samples: 1, p50: 150, p90: 150 },
    },
  ]);
});

test("bootstrap probe measures full bootstrap and first public outer open", async () => {
  const socket = new EventEmitter() as EventEmitter & {
    destroy: () => void;
  };
  socket.destroy = () => undefined;
  const calls: unknown[] = [];
  const clock = [1_000, 1_200, 1_500];

  const resultPromise = runBootstrapProbe({
    group: {
      name: "cn-hk",
      bootstrap: [
        "47.94.213.63:49737",
        "203.91.75.19:49738",
      ],
    },
    trial: 3,
    sequence: 10,
    publisherKey: Buffer.alloc(32, 1),
    keyPair: {
      publicKey: Buffer.alloc(32, 2),
      secretKey: Buffer.alloc(64, 3),
    },
    timeoutMs: 1_000,
    timestamp: () => "2026-07-19T00:00:00.000Z",
    now: () => clock.shift() ?? 1_500,
    createDht: (options) => {
      calls.push(options);
      return {
        fullyBootstrapped: async () => undefined,
        connect: (publicKey, connectionOptions) => {
          calls.push({ publicKey, connectionOptions });
          queueMicrotask(() => socket.emit("open"));
          return socket;
        },
        destroy: async () => undefined,
      };
    },
  });

  assert.deepEqual(await resultPromise, {
    group: "cn-hk",
    trial: 3,
    sequence: 10,
    timestamp: "2026-07-19T00:00:00.000Z",
    bootstrapMs: 200,
    outerMs: 500,
    connectMs: 300,
    success: true,
  });
  assert.deepEqual(calls, [
    {
      bootstrap: [
        "47.94.213.63:49737",
        "203.91.75.19:49738",
      ],
      keyPair: {
        publicKey: Buffer.alloc(32, 2),
        secretKey: Buffer.alloc(64, 3),
      },
    },
    {
      publicKey: Buffer.alloc(32, 1),
      connectionOptions: {
        keyPair: {
          publicKey: Buffer.alloc(32, 2),
          secretKey: Buffer.alloc(64, 3),
        },
        localConnection: false,
        reusableSocket: true,
      },
    },
  ]);
});

test("bootstrap benchmark runs trials in alternating order and persists each result", async () => {
  const groups = buildBootstrapGroups(recommendations);
  const invoked: string[] = [];
  const persisted: BootstrapBenchmarkResult[] = [];

  const completed = await runBootstrapBenchmark({
    groups,
    trialsPerGroup: 2,
    runTrial: async ({ group, trial, sequence }) => {
      invoked.push(`${sequence}:${group.name}:${trial}`);
      return result(group.name, sequence, 100 + sequence, 200 + sequence);
    },
    persist: async (benchmarkResult) => {
      persisted.push(benchmarkResult);
    },
  });

  assert.deepEqual(invoked, [
    "1:default:1",
    "2:cn-hk:1",
    "3:cn-hk-sg:1",
    "4:recommended-plus-default:1",
    "5:default:2",
    "6:cn-hk:2",
    "7:cn-hk-sg:2",
    "8:recommended-plus-default:2",
  ]);
  assert.deepEqual(persisted, completed);
});

function result(
  group: string,
  sequence: number,
  bootstrapMs: number | null,
  outerMs: number | null,
  error?: string,
): BootstrapBenchmarkResult {
  return {
    group,
    trial: sequence,
    sequence,
    timestamp: new Date(sequence * 1_000).toISOString(),
    bootstrapMs,
    outerMs,
    connectMs:
      bootstrapMs !== null && outerMs !== null
        ? outerMs - bootstrapMs
        : null,
    success: error === undefined,
    ...(error ? { error } : {}),
  };
}
