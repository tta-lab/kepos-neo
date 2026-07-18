import assert from "node:assert/strict";
import { test } from "node:test";

import {
  aggregateGraphReplies,
  isCnIpv4,
  parseCnIpv4Ranges,
  rankFrontier,
  summarizeObservations,
  type GraphReply,
  type NodeObservation,
} from "../src/tools/dht-crawler.js";

const delegatedApnic = [
  "# comment",
  "apnic|AU|ipv4|1.0.0.0|256|20110811|allocated",
  "apnic|CN|ipv4|1.0.1.0|256|20110414|allocated",
  "apnic|CN|ipv4|1.0.2.0|512|20110414|allocated",
  "apnic|CN|ipv6|2001:250::|32|19990804|allocated",
].join("\n");

test("parses mainland China IPv4 allocations from APNIC data", () => {
  const ranges = parseCnIpv4Ranges(delegatedApnic);

  assert.deepEqual(ranges, [
    { start: 16_777_472, end: 16_777_727 },
    { start: 16_777_728, end: 16_778_239 },
  ]);
  assert.equal(isCnIpv4("1.0.1.42", ranges), true);
  assert.equal(isCnIpv4("1.0.4.1", ranges), false);
  assert.equal(isCnIpv4("not-an-ip", ranges), false);
});

test("summarizes observations by stable IP and UDP port", () => {
  const observations: NodeObservation[] = [
    {
      timestamp: "2026-07-18T00:00:00.000Z",
      host: "1.0.1.42",
      port: 49_737,
      source: "lookup",
    },
    {
      timestamp: "2026-07-18T12:00:00.000Z",
      host: "1.0.1.42",
      port: 49_737,
      source: "routing",
    },
    {
      timestamp: "2026-07-18T12:00:00.000Z",
      host: "1.0.1.42",
      port: 50_000,
      source: "lookup",
    },
  ];

  assert.deepEqual(summarizeObservations(observations), [
    {
      endpoint: "1.0.1.42:49737",
      host: "1.0.1.42",
      port: 49_737,
      firstSeen: "2026-07-18T00:00:00.000Z",
      lastSeen: "2026-07-18T12:00:00.000Z",
      observations: 2,
      sources: ["lookup", "routing"],
    },
    {
      endpoint: "1.0.1.42:50000",
      host: "1.0.1.42",
      port: 50_000,
      firstSeen: "2026-07-18T12:00:00.000Z",
      lastSeen: "2026-07-18T12:00:00.000Z",
      observations: 1,
      sources: ["lookup"],
    },
  ]);
});

test("aggregates verified responders and advertised adjacency edges", () => {
  const replies: GraphReply[] = [
    {
      from: { host: "1.1.1.1", port: 1001 },
      rtt: 40,
      closerNodes: [
        { host: "2.2.2.2", port: 2002 },
        { host: "3.3.3.3", port: 3003 },
      ],
    },
    {
      from: { host: "4.4.4.4", port: 4004 },
      rtt: 80,
      closerNodes: [{ host: "2.2.2.2", port: 2002 }],
    },
  ];

  const graph = aggregateGraphReplies(replies);

  assert.deepEqual(
    graph.nodes.map(({ endpoint, verified, advertisedBy }) => ({
      endpoint,
      verified,
      advertisedBy,
    })),
    [
      { endpoint: "1.1.1.1:1001", verified: true, advertisedBy: 0 },
      { endpoint: "2.2.2.2:2002", verified: false, advertisedBy: 2 },
      { endpoint: "3.3.3.3:3003", verified: false, advertisedBy: 1 },
      { endpoint: "4.4.4.4:4004", verified: true, advertisedBy: 0 },
    ],
  );
  assert.deepEqual(
    graph.edges.map(({ source, target, observations }) => ({
      source,
      target,
      observations,
    })),
    [
      {
        source: "1.1.1.1:1001",
        target: "2.2.2.2:2002",
        observations: 1,
      },
      {
        source: "1.1.1.1:1001",
        target: "3.3.3.3:3003",
        observations: 1,
      },
      {
        source: "4.4.4.4:4004",
        target: "2.2.2.2:2002",
        observations: 1,
      },
    ],
  );
});

test("frontier prefers unverified nodes advertised by independent responders", () => {
  const graph = aggregateGraphReplies([
    {
      from: { host: "1.1.1.1", port: 1001 },
      rtt: 40,
      closerNodes: [
        { host: "2.2.2.2", port: 2002 },
        { host: "3.3.3.3", port: 3003 },
      ],
    },
    {
      from: { host: "4.4.4.4", port: 4004 },
      rtt: 80,
      closerNodes: [{ host: "2.2.2.2", port: 2002 }],
    },
  ]);

  assert.deepEqual(
    rankFrontier(graph.nodes, 2).map(({ endpoint }) => endpoint),
    ["2.2.2.2:2002", "3.3.3.3:3003"],
  );
});
