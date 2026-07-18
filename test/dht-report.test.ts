import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildReportModel,
  enrichHosts,
  parseObservationJsonl,
  renderReportHtml,
  type GeoRecord,
} from "../src/tools/dht-report.js";
import type {
  NodeObservation,
  NodeSummary,
} from "../src/tools/dht-crawler.js";

const summaries: NodeSummary[] = [
  {
    endpoint: "1.0.1.42:49737",
    host: "1.0.1.42",
    port: 49_737,
    firstSeen: "2026-07-18T00:00:00.000Z",
    lastSeen: "2026-07-19T12:00:00.000Z",
    observations: 10,
    sources: ["lookup", "routing"],
  },
  {
    endpoint: "8.8.8.8:40000",
    host: "8.8.8.8",
    port: 40_000,
    firstSeen: "2026-07-18T01:00:00.000Z",
    lastSeen: "2026-07-18T02:00:00.000Z",
    observations: 2,
    sources: ["lookup"],
  },
];

const observations: NodeObservation[] = [
  {
    timestamp: "2026-07-18T00:05:00.000Z",
    host: "1.0.1.42",
    port: 49_737,
    source: "lookup",
  },
  {
    timestamp: "2026-07-18T01:05:00.000Z",
    host: "8.8.8.8",
    port: 40_000,
    source: "lookup",
  },
];

const geos = new Map<string, GeoRecord>([
  [
    "1.0.1.42",
    {
      host: "1.0.1.42",
      countryCode: "CN",
      country: "China",
      city: "Shanghai",
      latitude: 31.23,
      longitude: 121.47,
      asn: 4_809,
      organization: "China Telecom",
    },
  ],
  [
    "8.8.8.8",
    {
      host: "8.8.8.8",
      countryCode: "US",
      country: "United States",
      city: "Mountain View",
      latitude: 37.4,
      longitude: -122.1,
      asn: 15_169,
      organization: "Google <script>alert(1)</script>",
    },
  ],
]);

test("builds geographic, country, ASN, and hourly report data", () => {
  const model = buildReportModel(observations, summaries, geos);

  assert.deepEqual(model.totals, {
    observations: 2,
    endpoints: 2,
    locatedEndpoints: 2,
    stableEndpoints: 1,
    countries: 2,
  });
  assert.deepEqual(
    model.points.map(({ endpoint, stable }) => ({ endpoint, stable })),
    [
      { endpoint: "1.0.1.42:49737", stable: true },
      { endpoint: "8.8.8.8:40000", stable: false },
    ],
  );
  assert.deepEqual(model.countries, [
    {
      countryCode: "CN",
      country: "China",
      endpoints: 1,
      stableEndpoints: 1,
    },
    {
      countryCode: "US",
      country: "United States",
      endpoints: 1,
      stableEndpoints: 0,
    },
  ]);
  assert.deepEqual(model.asns[0], {
    asn: 4_809,
    organization: "China Telecom",
    endpoints: 1,
    stableEndpoints: 1,
  });
  assert.deepEqual(model.timeline, [
    { hour: "2026-07-18T00:00:00.000Z", observations: 1, endpoints: 1 },
    { hour: "2026-07-18T01:00:00.000Z", observations: 1, endpoints: 1 },
  ]);
});

test("enrichment reuses cache and fetches only missing public hosts", async () => {
  const cache = new Map<string, GeoRecord>([["1.0.1.42", geos.get("1.0.1.42")!]]);
  const requested: string[] = [];

  const enriched = await enrichHosts(["1.0.1.42", "8.8.8.8"], cache, {
    fetchGeo: async (host) => {
      requested.push(host);
      return geos.get(host) ?? null;
    },
  });

  assert.deepEqual(requested, ["8.8.8.8"]);
  assert.equal(enriched.get("1.0.1.42")?.countryCode, "CN");
  assert.equal(enriched.get("8.8.8.8")?.countryCode, "US");
});

test("renders a self-contained data report without script injection", () => {
  const html = renderReportHtml(buildReportModel(observations, summaries, geos));

  assert.match(html, /HyperDHT geography/);
  assert.match(html, /Plotly\.newPlot/);
  assert.match(html, /China Telecom/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /\\u003cscript>alert\(1\)\\u003c\/script>/);
});

test("ignores a partial final JSONL record while the crawler is writing", () => {
  const complete = JSON.stringify(observations[0]);
  const parsed = parseObservationJsonl(`${complete}\n{"timestamp":"partial`);

  assert.deepEqual(parsed, [observations[0]]);
});
