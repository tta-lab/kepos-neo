import assert from "node:assert/strict";
import { test } from "node:test";

import {
  candidateNodes,
  isCnIpv4,
  parseCnIpv4Ranges,
  summarizeObservations,
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

test("selects only repeatedly observed CN endpoints with enough time span", () => {
  const ranges = parseCnIpv4Ranges(delegatedApnic);
  const summaries = summarizeObservations([
    {
      timestamp: "2026-07-18T00:00:00.000Z",
      host: "1.0.1.42",
      port: 49_737,
      source: "lookup",
    },
    {
      timestamp: "2026-07-19T00:00:00.000Z",
      host: "1.0.1.42",
      port: 49_737,
      source: "lookup",
    },
    {
      timestamp: "2026-07-18T00:00:00.000Z",
      host: "1.0.0.42",
      port: 49_737,
      source: "lookup",
    },
    {
      timestamp: "2026-07-19T00:00:00.000Z",
      host: "1.0.0.42",
      port: 49_737,
      source: "lookup",
    },
  ]);

  assert.deepEqual(
    candidateNodes(summaries, ranges, {
      minimumObservations: 2,
      minimumSpanMs: 24 * 60 * 60 * 1_000,
    }).map(({ endpoint }) => endpoint),
    ["1.0.1.42:49737"],
  );
});
