import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  aggregateGraphReplies,
  isCnIpv4,
  parseCnIpv4Ranges,
  readCrawlerHistory,
  recordGraphNovelty,
  rankFrontier,
  selectTargetPrefixes,
  shouldContinueFrontier,
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

test("target prefixes prefer buckets unused by earlier snapshots", () => {
  const shuffledPrefixes = [
    2, 1, 0, 5, 4, 3, ...Array.from({ length: 250 }, (_, index) => index + 6),
  ];

  assert.deepEqual(
    selectTargetPrefixes(4, [0, 1, 2], shuffledPrefixes),
    [5, 4, 3, 6],
  );
});

test("frontier reserves most queries for endpoints unseen in earlier snapshots", () => {
  const graph = aggregateGraphReplies([
    {
      from: { host: "1.1.1.1", port: 1001 },
      rtt: 40,
      closerNodes: [
        { host: "2.2.2.2", port: 2002 },
        { host: "3.3.3.3", port: 3003 },
        { host: "5.5.5.5", port: 5005 },
      ],
    },
    {
      from: { host: "4.4.4.4", port: 4004 },
      rtt: 80,
      closerNodes: [{ host: "2.2.2.2", port: 2002 }],
    },
  ]);

  assert.deepEqual(
    rankFrontier(
      graph.nodes,
      3,
      new Set(["2.2.2.2:2002"]),
    ).map(({ endpoint }) => endpoint),
    ["3.3.3.3:3003", "5.5.5.5:5005", "2.2.2.2:2002"],
  );
});

test("graph novelty counts only endpoints and edges absent from earlier snapshots", () => {
  const seenNodes = new Set(["1.1.1.1:1001"]);
  const seenEdges = new Set(["1.1.1.1:1001>2.2.2.2:2002"]);

  const novelty = recordGraphNovelty(
    {
      from: { host: "1.1.1.1", port: 1001 },
      rtt: 40,
      closerNodes: [
        { host: "2.2.2.2", port: 2002 },
        { host: "3.3.3.3", port: 3003 },
      ],
    },
    seenNodes,
    seenEdges,
  );

  assert.deepEqual(novelty, { newNodes: 2, newEdges: 1 });
  assert.deepEqual(
    [...seenNodes].sort(),
    ["1.1.1.1:1001", "2.2.2.2:2002", "3.3.3.3:3003"],
  );
});

test("another frontier round requires useful new-node or new-edge yield", () => {
  assert.equal(
    shouldContinueFrontier(
      { queries: 4, newNodes: 0, newEdges: 24 },
      { minimumNewNodesPerQuery: 1, minimumNewEdgesPerQuery: 5 },
    ),
    true,
  );
  assert.equal(
    shouldContinueFrontier(
      { queries: 4, newNodes: 1, newEdges: 4 },
      { minimumNewNodesPerQuery: 1, minimumNewEdgesPerQuery: 5 },
    ),
    false,
  );
});

test("crawler history merges target prefixes, endpoints, and edges across snapshots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-dht-history-"));
  try {
    const first = path.join(root, "snapshots", "first");
    const second = path.join(root, "snapshots", "second");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(
      path.join(first, "run.json"),
      JSON.stringify({ targetPrefixes: [1, 2] }),
    );
    await writeFile(
      path.join(second, "run.json"),
      JSON.stringify({ targetPrefixes: [3] }),
    );
    await writeFile(
      path.join(first, "nodes.jsonl"),
      `${JSON.stringify({ endpoint: "1.1.1.1:1001" })}\n`,
    );
    await writeFile(
      path.join(second, "nodes.jsonl"),
      `${JSON.stringify({ endpoint: "2.2.2.2:2002" })}\n`,
    );
    await writeFile(
      path.join(first, "edges.jsonl"),
      `${JSON.stringify({ source: "1.1.1.1:1001", target: "2.2.2.2:2002" })}\n`,
    );
    await writeFile(path.join(second, "edges.jsonl"), "");

    const history = await readCrawlerHistory(root);

    assert.deepEqual(history.targetPrefixes, [1, 2, 3]);
    assert.deepEqual(
      [...history.endpoints].sort(),
      ["1.1.1.1:1001", "2.2.2.2:2002"],
    );
    assert.deepEqual(
      [...history.edges],
      ["1.1.1.1:1001>2.2.2.2:2002"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
