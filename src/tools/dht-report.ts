import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  summarizeObservations,
  type NodeObservation,
  type NodeSummary,
} from "./dht-crawler.js";

export interface GeoRecord {
  host: string;
  countryCode: string;
  country: string;
  city: string;
  latitude: number;
  longitude: number;
  asn: number | null;
  organization: string;
}

export interface StabilityCriteria {
  minimumSpanHours: number;
  minimumObservations: number;
  minimumDistinctBuckets: number;
  maximumStaleHours: number;
}

export interface ReportRecommendation {
  endpoint: string;
  discoverySnapshots: number;
  successfulValidations: number;
  validationSpanHours: number;
  minimumRttMs: number | null;
}

export const DEFAULT_STABILITY_CRITERIA: StabilityCriteria = {
  minimumSpanHours: 24,
  minimumObservations: 6,
  minimumDistinctBuckets: 3,
  maximumStaleHours: 2,
};

interface ReportPoint extends GeoRecord, NodeSummary {
  spanHours: number;
  distinctBuckets: number;
  staleHours: number;
  stable: boolean;
  recommended: boolean;
  recommendation: ReportRecommendation | null;
}

interface CountrySummary {
  countryCode: string;
  country: string;
  label: string;
  endpoints: number;
  stableEndpoints: number;
  recommendedEndpoints: number;
}

interface AsnSummary {
  asn: number | null;
  organization: string;
  endpoints: number;
  stableEndpoints: number;
}

interface TimelineBucket {
  hour: string;
  observations: number;
  endpoints: number;
}

interface ReportModel {
  generatedAt: string;
  stabilityCriteria: StabilityCriteria;
  totals: {
    observations: number;
    endpoints: number;
    locatedEndpoints: number;
    stableEndpoints: number;
    recommendedEndpoints: number;
    countries: number;
  };
  points: ReportPoint[];
  countries: CountrySummary[];
  asns: AsnSummary[];
  timeline: TimelineBucket[];
}

interface EnrichmentOptions {
  fetchGeo(host: string): Promise<GeoRecord | null>;
  onRecord?(records: Map<string, GeoRecord>): Promise<void>;
  delayMs?: number;
}

interface ReportOptions {
  enrich: boolean;
  inputDir: string;
  outputPath: string;
  cachePath: string;
  recommendationsPath: string;
  stabilityCriteria: StabilityCriteria;
}

export function buildReportModel(
  observations: NodeObservation[],
  summaries: NodeSummary[],
  geos: Map<string, GeoRecord>,
  stabilityCriteria: StabilityCriteria = DEFAULT_STABILITY_CRITERIA,
  recommendations: ReportRecommendation[] = [],
): ReportModel {
  const latestObservation = observations.reduce(
    (latest, observation) =>
      observation.timestamp > latest ? observation.timestamp : latest,
    "",
  );
  const observationsByEndpoint = groupObservationsByEndpoint(observations);
  const recommendationsByEndpoint = new Map(
    recommendations.map((recommendation) => [
      recommendation.endpoint,
      recommendation,
    ]),
  );
  const points = summaries.flatMap((summary): ReportPoint[] => {
    const geo = geos.get(summary.host);
    if (!geo) {
      return [];
    }
    const spanHours =
      (Date.parse(summary.lastSeen) - Date.parse(summary.firstSeen)) /
      (60 * 60 * 1_000);
    const endpointObservations =
      observationsByEndpoint.get(summary.endpoint) ?? [];
    const distinctBuckets = observationBuckets(endpointObservations).size;
    const staleHours =
      (Date.parse(latestObservation) - Date.parse(summary.lastSeen)) /
      (60 * 60 * 1_000);
    const recommendation =
      recommendationsByEndpoint.get(summary.endpoint) ?? null;
    return [
      {
        ...geo,
        ...summary,
        spanHours,
        distinctBuckets,
        staleHours,
        recommended: recommendation !== null,
        recommendation,
        stable: isStableCandidate(
          summary,
          endpointObservations,
          latestObservation,
          stabilityCriteria,
        ),
      },
    ];
  });
  const countries = aggregateCountries(points);
  const asns = aggregateAsns(points);

  return {
    generatedAt: new Date().toISOString(),
    stabilityCriteria,
    totals: {
      observations: observations.length,
      endpoints: summaries.length,
      locatedEndpoints: points.length,
      stableEndpoints: points.filter(({ stable }) => stable).length,
      recommendedEndpoints: points.filter(({ recommended }) => recommended)
        .length,
      countries: countries.length,
    },
    points,
    countries,
    asns,
    timeline: aggregateTimeline(observations),
  };
}

export async function enrichHosts(
  hosts: string[],
  cache: Map<string, GeoRecord>,
  options: EnrichmentOptions,
): Promise<Map<string, GeoRecord>> {
  const missing = [...new Set(hosts)].filter((host) => !cache.has(host));

  for (let index = 0; index < missing.length; index += 1) {
    const record = await options.fetchGeo(missing[index]);
    if (record) {
      cache.set(record.host, record);
      await options.onRecord?.(cache);
    }
    if (options.delayMs && index < missing.length - 1) {
      await delay(options.delayMs);
    }
  }

  return cache;
}

export function formatCountryLabel(country: {
  country: string;
  countryCode: string;
}): string {
  return `${country.country} (${country.countryCode})`;
}

export function isStableCandidate(
  summary: NodeSummary,
  observations: NodeObservation[],
  latestObservation: string,
  criteria: StabilityCriteria,
): boolean {
  const spanHours =
    (Date.parse(summary.lastSeen) - Date.parse(summary.firstSeen)) /
    (60 * 60 * 1_000);
  const staleHours =
    (Date.parse(latestObservation) - Date.parse(summary.lastSeen)) /
    (60 * 60 * 1_000);
  return (
    spanHours >= criteria.minimumSpanHours &&
    summary.observations >= criteria.minimumObservations &&
    observationBuckets(observations).size >=
      criteria.minimumDistinctBuckets &&
    staleHours <= criteria.maximumStaleHours
  );
}

export function observationBucket(observation: NodeObservation): string {
  if (observation.snapshot) {
    return observation.snapshot;
  }
  const date = new Date(observation.timestamp);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

export function renderReportHtml(model: ReportModel): string {
  const data = JSON.stringify(model).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HyperDHT geography</title>
  <script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0b1020; color: #e7ecf5; }
    main { max-width: 1440px; margin: 0 auto; padding: 32px; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    .muted { color: #91a0bb; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 24px 0; }
    .card, .panel { background: #121a2d; border: 1px solid #24304a; border-radius: 14px; }
    .card { padding: 18px; }
    .card strong { display: block; margin-top: 8px; font-size: 26px; }
    .grid { display: grid; grid-template-columns: 2fr 1fr; gap: 16px; }
    .panel { min-height: 360px; padding: 12px; }
    #map { min-height: 620px; }
    @media (max-width: 900px) { main { padding: 18px; } .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <h1>HyperDHT geography</h1>
    <div class="muted">IP-derived locations. Stable candidate: ≥${model.stabilityCriteria.minimumObservations} observations across ≥${model.stabilityCriteria.minimumDistinctBuckets} crawl snapshots, spanning ≥${model.stabilityCriteria.minimumSpanHours}h, seen within the latest ${model.stabilityCriteria.maximumStaleHours}h.</div>
    <section class="cards" id="cards"></section>
    <section class="panel"><div id="map"></div></section>
    <section class="grid">
      <div class="panel"><div id="countries"></div></div>
      <div class="panel"><div id="asns"></div></div>
      <div class="panel"><div id="timeline"></div></div>
      <div class="panel"><div id="stability"></div></div>
    </section>
  </main>
  <script>
    const report = ${data};
    const plot = { paper_bgcolor: "#121a2d", plot_bgcolor: "#121a2d", font: { color: "#dfe7f4" } };
    const cards = [
      ["Observations", report.totals.observations],
      ["Endpoints", report.totals.endpoints],
      ["Located", report.totals.locatedEndpoints],
      ["Stable", report.totals.stableEndpoints],
      ["Recommended", report.totals.recommendedEndpoints],
      ["Countries", report.totals.countries],
    ];
    document.querySelector("#cards").innerHTML = cards
      .map(([label, value]) => \`<div class="card"><span class="muted">\${label}</span><strong>\${value}</strong></div>\`)
      .join("");

    const pointTrace = (stable) => {
      const points = report.points.filter((point) =>
        point.stable === stable && !point.recommended
      );
      return {
        type: "scattergeo",
        mode: "markers",
        name: stable ? "Discovery stable" : "Observed",
        lat: points.map((point) => point.latitude),
        lon: points.map((point) => point.longitude),
        text: points.map((point) =>
          \`\${point.endpoint}<br>\${point.city}, \${point.country}<br>AS\${point.asn ?? "?"} \${point.organization}<br>\${point.observations} observations · \${point.distinctBuckets} snapshots · \${point.spanHours.toFixed(1)}h span · \${point.staleHours.toFixed(1)}h stale\`
        ),
        hoverinfo: "text",
        marker: {
          color: stable ? "#53e6a1" : "#6fa8ff",
          opacity: stable ? 0.9 : 0.45,
          size: points.map((point) => 5 + Math.min(15, Math.log2(point.observations + 1) * 2)),
          line: { color: "#0b1020", width: 0.5 },
        },
      };
    };
    const recommendedPoints = report.points.filter((point) => point.recommended);
    const recommendationTrace = {
      type: "scattergeo",
      mode: "markers",
      name: "Recommended bootstrap",
      lat: recommendedPoints.map((point) => point.latitude),
      lon: recommendedPoints.map((point) => point.longitude),
      text: recommendedPoints.map((point) =>
        \`\${point.endpoint}<br>\${point.city}, \${point.country}<br>AS\${point.asn ?? "?"} \${point.organization}<br>Recommended bootstrap · \${point.recommendation.successfulValidations} validations over \${point.recommendation.validationSpanHours.toFixed(1)}h · \${point.recommendation.discoverySnapshots} discovery snapshots · \${point.recommendation.minimumRttMs ?? "?"}ms minimum RTT<br>Discovery stable: \${point.stable ? "yes" : "no"}\`
      ),
      hoverinfo: "text",
      marker: {
        color: "#ffb547",
        opacity: 1,
        size: 16,
        symbol: "diamond",
        line: { color: "#fff2d0", width: 1.5 },
      },
    };
    Plotly.newPlot("map", [pointTrace(false), pointTrace(true), recommendationTrace], {
      ...plot,
      title: "Observed endpoints",
      margin: { l: 0, r: 0, t: 48, b: 0 },
      geo: {
        projection: { type: "natural earth" },
        bgcolor: "#121a2d",
        showland: true,
        landcolor: "#202a3e",
        showocean: true,
        oceancolor: "#0d1528",
        showcountries: true,
        countrycolor: "#34425f",
      },
    }, { responsive: true });

    const countries = report.countries.slice().reverse();
    Plotly.newPlot("countries", [{
      type: "bar",
      orientation: "h",
      y: countries.map((row) => row.label),
      x: countries.map((row) => row.endpoints),
      customdata: countries.map((row) => [row.country, row.countryCode, row.stableEndpoints, row.recommendedEndpoints]),
      hovertemplate: "%{customdata[0]} (%{customdata[1]})<br>%{x} endpoints<br>%{customdata[2]} stable<br>%{customdata[3]} recommended<extra></extra>",
      marker: { color: "#6fa8ff" },
      name: "Endpoints",
    }, {
      type: "bar",
      orientation: "h",
      y: countries.map((row) => row.label),
      x: countries.map((row) => row.stableEndpoints),
      customdata: countries.map((row) => [row.country, row.countryCode, row.endpoints]),
      hovertemplate: "%{customdata[0]} (%{customdata[1]})<br>%{x} stable endpoints<br>%{customdata[2]} total<extra></extra>",
      marker: { color: "#53e6a1" },
      name: "Stable",
    }, {
      type: "bar",
      orientation: "h",
      y: countries.map((row) => row.label),
      x: countries.map((row) => row.recommendedEndpoints),
      customdata: countries.map((row) => [row.country, row.countryCode, row.endpoints]),
      hovertemplate: "%{customdata[0]} (%{customdata[1]})<br>%{x} recommended bootstrap endpoints<br>%{customdata[2]} total<extra></extra>",
      marker: { color: "#ffb547" },
      name: "Recommended",
    }], { ...plot, title: "Countries", height: Math.max(360, countries.length * 24), barmode: "overlay", margin: { l: 140, r: 20, t: 48, b: 40 } }, { responsive: true });

    const topAsns = report.asns.slice(0, 15).reverse();
    Plotly.newPlot("asns", [{
      type: "bar",
      orientation: "h",
      y: topAsns.map((row) => \`AS\${row.asn ?? "?"} \${row.organization}\`),
      x: topAsns.map((row) => row.endpoints),
      marker: { color: "#b68cff" },
    }], { ...plot, title: "Top networks", margin: { l: 150, r: 20, t: 48, b: 40 } }, { responsive: true });

    Plotly.newPlot("timeline", [{
      type: "scatter",
      mode: "lines",
      x: report.timeline.map((row) => row.hour),
      y: report.timeline.map((row) => row.endpoints),
      line: { color: "#6fa8ff", width: 2 },
      name: "Unique endpoints",
    }], { ...plot, title: "Hourly reach", margin: { l: 55, r: 20, t: 48, b: 65 } }, { responsive: true });

    Plotly.newPlot("stability", [{
      type: "scatter",
      mode: "markers",
      x: report.points.map((point) => point.spanHours),
      y: report.points.map((point) => point.observations),
      text: report.points.map((point) => point.endpoint),
      hoverinfo: "text+x+y",
      marker: {
        color: report.points.map((point) =>
          point.recommended ? "#ffb547" : point.stable ? "#53e6a1" : "#6fa8ff"
        ),
        symbol: report.points.map((point) => point.recommended ? "diamond" : "circle"),
        opacity: 0.65,
      },
    }], {
      ...plot,
      title: "Stability",
      xaxis: { title: "Observed span (hours)" },
      yaxis: { title: "Observations", type: "log" },
      margin: { l: 65, r: 20, t: 48, b: 55 },
    }, { responsive: true });
  </script>
</body>
</html>
`;
}

export function parseObservationJsonl(input: string): NodeObservation[] {
  const lines = input.split("\n");
  const observations: NodeObservation[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) {
      continue;
    }
    try {
      observations.push(JSON.parse(line) as NodeObservation);
    } catch (error) {
      const isPartialFinalLine =
        index === lines.length - 1 && !input.endsWith("\n");
      if (isPartialFinalLine) {
        continue;
      }
      throw error;
    }
  }
  return observations;
}

export async function readReportRecommendations(
  filePath: string,
): Promise<ReportRecommendation[]> {
  let input: string;
  try {
    input = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch {
    throw new Error(`Invalid recommendation artifact: ${filePath}`);
  }
  if (
    !isRecord(value) ||
    value.algorithm !== "Ed25519" ||
    typeof value.signature !== "string" ||
    !isRecord(value.payload) ||
    !Array.isArray(value.payload.endpoints)
  ) {
    throw new Error(`Invalid recommendation artifact: ${filePath}`);
  }
  return value.payload.endpoints.map((endpoint) =>
    parseReportRecommendation(endpoint, filePath),
  );
}

async function runReport(options: ReportOptions): Promise<void> {
  const observations = await readInputObservations(options.inputDir);
  const summaries = summarizeObservations(observations);
  const geos = await readGeoCache(options.cachePath);
  const recommendations = await readReportRecommendations(
    options.recommendationsPath,
  );

  if (options.enrich) {
    console.log(`Enriching ${new Set(summaries.map(({ host }) => host)).size} hosts`);
    await enrichHosts(
      summaries.map(({ host }) => host),
      geos,
      {
        fetchGeo: fetchGeoRecord,
        delayMs: 1_100,
        onRecord: (records) => writeGeoCache(options.cachePath, records),
      },
    );
  }

  const model = buildReportModel(
    observations,
    summaries,
    geos,
    options.stabilityCriteria,
    recommendations,
  );
  await writeFile(options.outputPath, renderReportHtml(model), "utf8");
  console.log(
    `Wrote ${options.outputPath}: ${model.totals.locatedEndpoints}/${model.totals.endpoints} endpoints located`,
  );
}

function aggregateCountries(points: ReportPoint[]): CountrySummary[] {
  const countries = new Map<string, CountrySummary>();
  for (const point of points) {
    const current = countries.get(point.countryCode) ?? {
      countryCode: point.countryCode,
      country: point.country,
      label: formatCountryLabel(point),
      endpoints: 0,
      stableEndpoints: 0,
      recommendedEndpoints: 0,
    };
    current.endpoints += 1;
    current.stableEndpoints += point.stable ? 1 : 0;
    current.recommendedEndpoints += point.recommended ? 1 : 0;
    countries.set(point.countryCode, current);
  }
  return [...countries.values()].sort(compareAggregates);
}

function aggregateAsns(points: ReportPoint[]): AsnSummary[] {
  const asns = new Map<string, AsnSummary>();
  for (const point of points) {
    const key = `${point.asn ?? "unknown"}:${point.organization}`;
    const current = asns.get(key) ?? {
      asn: point.asn,
      organization: point.organization || "Unknown network",
      endpoints: 0,
      stableEndpoints: 0,
    };
    current.endpoints += 1;
    current.stableEndpoints += point.stable ? 1 : 0;
    asns.set(key, current);
  }
  return [...asns.values()].sort(compareAggregates);
}

function compareAggregates(
  left: { endpoints: number; stableEndpoints: number },
  right: { endpoints: number; stableEndpoints: number },
): number {
  return (
    right.stableEndpoints - left.stableEndpoints ||
    right.endpoints - left.endpoints
  );
}

function aggregateTimeline(
  observations: NodeObservation[],
): TimelineBucket[] {
  const buckets = new Map<
    string,
    { observations: number; endpoints: Set<string> }
  >();
  for (const observation of observations) {
    const date = new Date(observation.timestamp);
    date.setUTCMinutes(0, 0, 0);
    const hour = date.toISOString();
    const current = buckets.get(hour) ?? {
      observations: 0,
      endpoints: new Set<string>(),
    };
    current.observations += 1;
    current.endpoints.add(`${observation.host}:${observation.port}`);
    buckets.set(hour, current);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hour, bucket]) => ({
      hour,
      observations: bucket.observations,
      endpoints: bucket.endpoints.size,
    }));
}

function groupObservationsByEndpoint(
  observations: NodeObservation[],
): Map<string, NodeObservation[]> {
  const groups = new Map<string, NodeObservation[]>();
  for (const observation of observations) {
    const endpoint = `${observation.host}:${observation.port}`;
    const group = groups.get(endpoint) ?? [];
    group.push(observation);
    groups.set(endpoint, group);
  }
  return groups;
}

function observationBuckets(observations: NodeObservation[]): Set<string> {
  return new Set(observations.map(observationBucket));
}

function parseReportRecommendation(
  value: unknown,
  filePath: string,
): ReportRecommendation {
  if (
    !isRecord(value) ||
    typeof value.endpoint !== "string" ||
    typeof value.discoverySnapshots !== "number" ||
    typeof value.successfulValidations !== "number" ||
    typeof value.validationSpanHours !== "number" ||
    !(
      value.minimumRttMs === null ||
      typeof value.minimumRttMs === "number"
    )
  ) {
    throw new Error(`Invalid recommendation endpoint in: ${filePath}`);
  }
  return {
    endpoint: value.endpoint,
    discoverySnapshots: value.discoverySnapshots,
    successfulValidations: value.successfulValidations,
    validationSpanHours: value.validationSpanHours,
    minimumRttMs: value.minimumRttMs,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isErrorCode(error: unknown, code: string): boolean {
  return (
    isRecord(error) &&
    "code" in error &&
    error.code === code
  );
}

async function fetchGeoRecord(host: string): Promise<GeoRecord | null> {
  try {
    const response = await fetch(`https://ipwho.is/${encodeURIComponent(host)}`);
    if (!response.ok) {
      console.warn(`${host}: HTTP ${response.status}`);
      return null;
    }
    const value = (await response.json()) as {
      success?: boolean;
      country_code?: unknown;
      country?: unknown;
      city?: unknown;
      latitude?: unknown;
      longitude?: unknown;
      connection?: { asn?: unknown; org?: unknown; isp?: unknown };
    };
    if (
      value.success !== true ||
      typeof value.country_code !== "string" ||
      typeof value.country !== "string" ||
      typeof value.latitude !== "number" ||
      typeof value.longitude !== "number"
    ) {
      console.warn(`${host}: no geolocation result`);
      return null;
    }
    return {
      host,
      countryCode: value.country_code,
      country: value.country,
      city: typeof value.city === "string" ? value.city : "",
      latitude: value.latitude,
      longitude: value.longitude,
      asn:
        typeof value.connection?.asn === "number"
          ? value.connection.asn
          : null,
      organization:
        typeof value.connection?.org === "string"
          ? value.connection.org
          : typeof value.connection?.isp === "string"
            ? value.connection.isp
            : "",
    };
  } catch (error) {
    console.warn(
      `${host}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

async function readObservations(filePath: string): Promise<NodeObservation[]> {
  return parseObservationJsonl(await readFile(filePath, "utf8"));
}

export async function readInputObservations(
  inputDir: string,
): Promise<NodeObservation[]> {
  try {
    return await readObservations(path.join(inputDir, "observations.jsonl"));
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
    const snapshotsDir = path.join(inputDir, "snapshots");
    const entries = await readdir(snapshotsDir, { withFileTypes: true });
    const observations: NodeObservation[] = [];
    for (const entry of entries
      .filter((candidate) => candidate.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      observations.push(
        ...(await readObservations(
          path.join(snapshotsDir, entry.name, "observations.jsonl"),
        )),
      );
    }
    return observations;
  }
}

async function readGeoCache(filePath: string): Promise<Map<string, GeoRecord>> {
  try {
    const records = JSON.parse(await readFile(filePath, "utf8")) as GeoRecord[];
    return new Map(records.map((record) => [record.host, record]));
  } catch {
    return new Map();
  }
}

async function writeGeoCache(
  filePath: string,
  records: Map<string, GeoRecord>,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify([...records.values()], null, 2)}\n`,
    "utf8",
  );
  await rename(temporaryPath, filePath);
}

function parseOptions(argv: string[]): ReportOptions {
  let enrich = false;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--enrich") {
      enrich = true;
      continue;
    }
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value, received: ${name ?? ""}`);
    }
    values.set(name, value);
    index += 1;
  }

  const inputDir = path.resolve(
    values.get("--input") ??
      path.join(os.homedir(), ".local", "state", "kepos-neo", "dht-graph"),
  );
  return {
    enrich,
    inputDir,
    outputPath: path.resolve(
      values.get("--output") ?? path.join(inputDir, "report.html"),
    ),
    cachePath: path.resolve(
      values.get("--geo-cache") ?? path.join(inputDir, "geo-cache.json"),
    ),
    recommendationsPath: path.resolve(
      values.get("--recommendations") ??
        path.join(inputDir, "bootstrap-recommendations.json"),
    ),
    stabilityCriteria: {
      minimumSpanHours: positiveNumber(
        values.get("--stable-min-hours"),
        DEFAULT_STABILITY_CRITERIA.minimumSpanHours,
      ),
      minimumObservations: positiveNumber(
        values.get("--stable-min-observations"),
        DEFAULT_STABILITY_CRITERIA.minimumObservations,
      ),
      minimumDistinctBuckets: positiveNumber(
        values.get("--stable-min-buckets"),
        DEFAULT_STABILITY_CRITERIA.minimumDistinctBuckets,
      ),
      maximumStaleHours: positiveNumber(
        values.get("--stable-max-stale-hours"),
        DEFAULT_STABILITY_CRITERIA.maximumStaleHours,
      ),
    },
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Expected a number greater than zero, received: ${value}`);
  }
  return number;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entrypoint) {
  runReport(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
