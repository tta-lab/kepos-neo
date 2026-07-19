import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";

import {
  buildReportModel,
  enrichHosts,
  formatCountryLabel,
  isStableCandidate,
  observationBucket,
  parseObservationJsonl,
  readInputObservations,
  readReportRecommendations,
  renderReportHtml,
  type GeoRecord,
} from "../src/tools/dht-report.js";
import type {
  NodeObservation,
  NodeSummary,
} from "../src/tools/dht-crawler.js";

const execFileAsync = promisify(execFile);

const reportRecommendation = {
  endpoint: "1.0.1.42:49737",
  discoverySnapshots: 3,
  successfulValidations: 2,
  validationSpanHours: 12,
  minimumRttMs: 42,
};

const signedRecommendationArtifact = {
  algorithm: "Ed25519",
  payload: {
    generatedAt: "2026-07-19T02:25:50.920Z",
    endpoints: [reportRecommendation],
  },
  signature: "signed",
};

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
    timestamp: "2026-07-18T12:05:00.000Z",
    host: "1.0.1.42",
    port: 49_737,
    source: "routing",
  },
  {
    timestamp: "2026-07-19T12:05:00.000Z",
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
    observations: 4,
    endpoints: 2,
    locatedEndpoints: 2,
    stableEndpoints: 1,
    recommendedEndpoints: 0,
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
      label: "China (CN)",
      endpoints: 1,
      stableEndpoints: 1,
      recommendedEndpoints: 0,
    },
    {
      countryCode: "US",
      country: "United States",
      label: "United States (US)",
      endpoints: 1,
      stableEndpoints: 0,
      recommendedEndpoints: 0,
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
    { hour: "2026-07-18T12:00:00.000Z", observations: 1, endpoints: 1 },
    { hour: "2026-07-19T12:00:00.000Z", observations: 1, endpoints: 1 },
  ]);
});

test("keeps validated recommendations separate from discovery stability", () => {
  const model = buildReportModel(
    observations,
    summaries,
    geos,
    {
      minimumSpanHours: 48,
      minimumObservations: 20,
      minimumDistinctBuckets: 4,
      maximumStaleHours: 2,
    },
    [reportRecommendation],
  );

  assert.equal(model.points[0].stable, false);
  assert.equal(model.points[0].recommended, true);
  assert.equal(model.points[1].recommended, false);
  assert.equal(model.totals.stableEndpoints, 0);
  assert.equal(model.totals.recommendedEndpoints, 1);
  assert.equal(model.countries[0].recommendedEndpoints, 1);
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

test("renders validated recommendations as prominent map markers", () => {
  const model = buildReportModel(
    observations,
    summaries,
    geos,
    undefined,
    [reportRecommendation],
  );
  const html = renderReportHtml(model);

  assert.match(html, /Recommended bootstrap/);
  assert.match(html, /#ffb547/);
  assert.match(html, /symbol: "diamond"/);
  assert.doesNotMatch(html, /report\.countries\.slice\(0, 20\)/);
});

test("ignores a partial final JSONL record while the crawler is writing", () => {
  const complete = JSON.stringify(observations[0]);
  const parsed = parseObservationJsonl(`${complete}\n{"timestamp":"partial`);

  assert.deepEqual(parsed, [observations[0]]);
});

test("country charts show the full name with the ISO code", () => {
  assert.equal(
    formatCountryLabel({ country: "China", countryCode: "CN" }),
    "China (CN)",
  );
});

test("stable candidates use post-processing span, bucket, count, and recency thresholds", () => {
  const summary: NodeSummary = {
    ...summaries[0],
    lastSeen: "2026-07-19T00:05:00.000Z",
  };
  const endpointObservations: NodeObservation[] = [
    {
      timestamp: "2026-07-18T00:05:00.000Z",
      host: "1.0.1.42",
      port: 49_737,
      source: "lookup",
    },
    {
      timestamp: "2026-07-18T12:05:00.000Z",
      host: "1.0.1.42",
      port: 49_737,
      source: "lookup",
    },
    {
      timestamp: "2026-07-19T00:05:00.000Z",
      host: "1.0.1.42",
      port: 49_737,
      source: "lookup",
    },
  ];

  assert.equal(
    isStableCandidate(
      summary,
      endpointObservations,
      "2026-07-19T01:00:00.000Z",
      {
        minimumSpanHours: 24,
        minimumObservations: 3,
        minimumDistinctBuckets: 3,
        maximumStaleHours: 2,
      },
    ),
    true,
  );
  assert.equal(
    isStableCandidate(
      summary,
      endpointObservations,
      "2026-07-19T03:00:00.000Z",
      {
        minimumSpanHours: 24,
        minimumObservations: 3,
        minimumDistinctBuckets: 3,
        maximumStaleHours: 2,
      },
    ),
    false,
  );
});

test("snapshot IDs replace clock hours as cross-run stability buckets", () => {
  assert.equal(
    observationBucket({
      timestamp: "2026-07-18T00:05:00.000Z",
      snapshot: "snapshot-a",
      host: "1.0.1.42",
      port: 49_737,
      source: "find-node",
    }),
    "snapshot-a",
  );
});

test("reads observations from all graph snapshots in timestamp order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-dht-report-"));
  try {
    const first = path.join(root, "snapshots", "2026-07-18T00-00-00.000Z");
    const second = path.join(root, "snapshots", "2026-07-18T12-00-00.000Z");
    await mkdir(first, { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(
      path.join(first, "observations.jsonl"),
      `${JSON.stringify({ ...observations[0], snapshot: "first" })}\n`,
    );
    await writeFile(
      path.join(second, "observations.jsonl"),
      `${JSON.stringify({ ...observations[1], snapshot: "second" })}\n`,
    );

    const loaded = await readInputObservations(root);

    assert.deepEqual(
      loaded.map(({ snapshot }) => snapshot),
      ["first", "second"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads validated endpoints from the signed recommendation artifact", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-dht-report-"));
  try {
    const recommendationPath = path.join(
      root,
      "bootstrap-recommendations.json",
    );
    await writeFile(
      recommendationPath,
      JSON.stringify(signedRecommendationArtifact),
    );
    assert.deepEqual(await readReportRecommendations(recommendationPath), [
      reportRecommendation,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("treats a missing recommendation artifact as no recommendations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-dht-report-"));
  try {
    assert.deepEqual(
      await readReportRecommendations(
        path.join(root, "bootstrap-recommendations.json"),
      ),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a malformed recommendation artifact with its path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-dht-report-"));
  try {
    const recommendationPath = path.join(
      root,
      "bootstrap-recommendations.json",
    );
    await writeFile(recommendationPath, "{broken");

    await assert.rejects(
      readReportRecommendations(recommendationPath),
      new RegExp(`Invalid recommendation artifact: ${recommendationPath}`),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the report CLI includes recommendations from the input directory", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-dht-report-"));
  try {
    await writeFile(
      path.join(root, "observations.jsonl"),
      `${JSON.stringify(observations[0])}\n`,
    );
    await writeFile(
      path.join(root, "geo-cache.json"),
      JSON.stringify([geos.get("1.0.1.42")]),
    );
    await writeFile(
      path.join(root, "bootstrap-recommendations.json"),
      JSON.stringify(signedRecommendationArtifact),
    );

    await execFileAsync(
      process.execPath,
      [
        "--import",
        "tsx",
        path.resolve("src/tools/dht-report.ts"),
        "--input",
        root,
      ],
      { cwd: path.resolve(".") },
    );

    const html = await readFile(path.join(root, "report.html"), "utf8");
    assert.match(html, /"recommendedEndpoints":1/);
    assert.match(html, /"recommended":true/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
