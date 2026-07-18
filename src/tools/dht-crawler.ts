import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isIPv4 } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const require = createRequire(import.meta.url);
const HyperDHT = require("hyperdht") as HyperDhtConstructor;

const APNIC_URL =
  "https://ftp.apnic.net/stats/apnic/delegated-apnic-latest";
const DEFAULT_DURATION_HOURS = 72;
const DEFAULT_INTERVAL_SECONDS = 60;

export interface Ipv4Range {
  start: number;
  end: number;
}

export interface NodeObservation {
  timestamp: string;
  host: string;
  port: number;
  source: "lookup" | "routing";
}

export interface NodeSummary {
  endpoint: string;
  host: string;
  port: number;
  firstSeen: string;
  lastSeen: string;
  observations: number;
  sources: Array<NodeObservation["source"]>;
}

interface LookupReply {
  from?: {
    host?: unknown;
    port?: unknown;
  };
}

interface HyperDhtNode {
  fullyBootstrapped(): Promise<void>;
  lookup(target: Buffer): AsyncIterable<LookupReply>;
  toArray(): Array<{ host: string; port: number }>;
  destroy(options?: { force?: boolean }): Promise<void>;
}

interface HyperDhtConstructor {
  new (): HyperDhtNode;
}

interface CrawlerOptions {
  durationHours: number;
  intervalSeconds: number;
  outputDir: string;
}

export function parseCnIpv4Ranges(input: string): Ipv4Range[] {
  const ranges: Ipv4Range[] = [];

  for (const line of input.split("\n")) {
    const [registry, country, type, address, countText] = line.split("|");
    if (registry !== "apnic" || country !== "CN" || type !== "ipv4") {
      continue;
    }

    const start = ipv4ToNumber(address);
    const count = Number(countText);
    if (start === null || !Number.isSafeInteger(count) || count <= 0) {
      continue;
    }

    ranges.push({ start, end: start + count - 1 });
  }

  return ranges.sort((left, right) => left.start - right.start);
}

export function isCnIpv4(host: string, ranges: Ipv4Range[]): boolean {
  const address = ipv4ToNumber(host);
  if (address === null) {
    return false;
  }

  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (address < range.start) {
      high = middle - 1;
      continue;
    }
    if (address > range.end) {
      low = middle + 1;
      continue;
    }
    return true;
  }

  return false;
}

export function summarizeObservations(
  observations: NodeObservation[],
): NodeSummary[] {
  const summaries = new Map<string, NodeSummary>();

  for (const observation of observations) {
    const endpoint = `${observation.host}:${observation.port}`;
    const current = summaries.get(endpoint);
    if (!current) {
      summaries.set(endpoint, {
        endpoint,
        host: observation.host,
        port: observation.port,
        firstSeen: observation.timestamp,
        lastSeen: observation.timestamp,
        observations: 1,
        sources: [observation.source],
      });
      continue;
    }

    current.firstSeen =
      observation.timestamp < current.firstSeen
        ? observation.timestamp
        : current.firstSeen;
    current.lastSeen =
      observation.timestamp > current.lastSeen
        ? observation.timestamp
        : current.lastSeen;
    current.observations += 1;
    if (!current.sources.includes(observation.source)) {
      current.sources.push(observation.source);
      current.sources.sort();
    }
  }

  return [...summaries.values()].sort((left, right) =>
    left.endpoint.localeCompare(right.endpoint),
  );
}

async function runCrawler(options: CrawlerOptions): Promise<void> {
  await mkdir(options.outputDir, { recursive: true });
  const observationsPath = path.join(options.outputDir, "observations.jsonl");
  const errorsPath = path.join(options.outputDir, "errors.jsonl");
  const summaryPath = path.join(options.outputDir, "summary.json");
  const ranges = parseCnIpv4Ranges(await loadApnicData(options.outputDir));
  const observations = await readObservations(observationsPath);
  const summaries = new Map(
    summarizeObservations(observations).map((summary) => [
      summary.endpoint,
      summary,
    ]),
  );
  const startedAt = new Date();
  const stopAt = new Date(
    startedAt.getTime() + options.durationHours * 60 * 60 * 1_000,
  );
  const dht = new HyperDHT();
  let stopping = false;

  const stop = (): void => {
    stopping = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await writeJson(path.join(options.outputDir, "run.json"), {
    startedAt: startedAt.toISOString(),
    stopAt: stopAt.toISOString(),
    durationHours: options.durationHours,
    intervalSeconds: options.intervalSeconds,
    pid: process.pid,
  });

  console.log(`Bootstrapping HyperDHT; output=${options.outputDir}`);
  await dht.fullyBootstrapped();
  console.log(`Sampling until ${stopAt.toISOString()}`);

  try {
    while (!stopping && Date.now() < stopAt.getTime()) {
      const timestamp = new Date().toISOString();
      const batch: NodeObservation[] = [];

      try {
        for await (const reply of dht.lookup(randomBytes(32))) {
          const endpoint = normalizeEndpoint(reply.from);
          if (endpoint) {
            batch.push({ timestamp, ...endpoint, source: "lookup" });
          }
        }
      } catch (error) {
        await appendJsonLine(errorsPath, {
          timestamp,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      for (const node of dht.toArray()) {
        const endpoint = normalizeEndpoint(node);
        if (endpoint) {
          batch.push({ timestamp, ...endpoint, source: "routing" });
        }
      }

      const uniqueBatch = uniqueObservations(batch);
      observations.push(...uniqueBatch);
      updateSummaries(summaries, uniqueBatch);
      await appendJsonLines(observationsPath, uniqueBatch);
      await writeSummary(
        summaryPath,
        observations.length,
        [...summaries.values()],
        ranges,
        startedAt,
        stopAt,
      );

      const cnCount = new Set(
        [...summaries.values()]
          .filter((summary) => isCnIpv4(summary.host, ranges))
          .map((summary) => summary.endpoint),
      ).size;
      console.log(
        `${timestamp} sampled=${uniqueBatch.length} total=${observations.length} cnEndpoints=${cnCount}`,
      );

      await delay(options.intervalSeconds * 1_000);
    }
  } finally {
    await writeSummary(
      summaryPath,
      observations.length,
      [...summaries.values()],
      ranges,
      startedAt,
      stopAt,
    );
    await dht.destroy({ force: true });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function normalizeEndpoint(
  value: LookupReply["from"],
): { host: string; port: number } | null {
  if (!value || typeof value.host !== "string") {
    return null;
  }
  if (
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    return null;
  }
  if (!isPublicIpv4(value.host)) {
    return null;
  }
  return { host: value.host, port: value.port };
}

function isPublicIpv4(host: string): boolean {
  if (!isIPv4(host)) {
    return false;
  }
  const [first, second] = host.split(".").map(Number);
  if (first === 0 || first === 10 || first === 127 || first >= 224) {
    return false;
  }
  if (first === 100 && second >= 64 && second <= 127) {
    return false;
  }
  if (first === 169 && second === 254) {
    return false;
  }
  if (first === 172 && second >= 16 && second <= 31) {
    return false;
  }
  if (first === 192 && second === 168) {
    return false;
  }
  return true;
}

function ipv4ToNumber(host: string): number | null {
  if (!isIPv4(host)) {
    return null;
  }
  return host
    .split(".")
    .map(Number)
    .reduce((value, octet) => value * 256 + octet, 0);
}

function uniqueObservations(
  observations: NodeObservation[],
): NodeObservation[] {
  const unique = new Map<string, NodeObservation>();
  for (const observation of observations) {
    unique.set(
      `${observation.source}:${observation.host}:${observation.port}`,
      observation,
    );
  }
  return [...unique.values()];
}

function updateSummaries(
  summaries: Map<string, NodeSummary>,
  observations: NodeObservation[],
): void {
  for (const update of summarizeObservations(observations)) {
    const current = summaries.get(update.endpoint);
    if (!current) {
      summaries.set(update.endpoint, update);
      continue;
    }

    current.firstSeen =
      update.firstSeen < current.firstSeen ? update.firstSeen : current.firstSeen;
    current.lastSeen =
      update.lastSeen > current.lastSeen ? update.lastSeen : current.lastSeen;
    current.observations += update.observations;
    current.sources = [...new Set([...current.sources, ...update.sources])].sort();
  }
}

async function loadApnicData(outputDir: string): Promise<string> {
  const cachePath = path.join(outputDir, "delegated-apnic-latest");
  try {
    return await readFile(cachePath, "utf8");
  } catch {
    const response = await fetch(APNIC_URL);
    if (!response.ok) {
      throw new Error(`APNIC download failed: HTTP ${response.status}`);
    }
    const body = await response.text();
    await writeFile(cachePath, body, "utf8");
    return body;
  }
}

async function readObservations(
  observationsPath: string,
): Promise<NodeObservation[]> {
  let input: string;
  try {
    input = await readFile(observationsPath, "utf8");
  } catch {
    return [];
  }

  const observations: NodeObservation[] = [];
  for (const line of input.split("\n")) {
    if (!line) {
      continue;
    }
    observations.push(JSON.parse(line) as NodeObservation);
  }
  return observations;
}

async function appendJsonLines(
  filePath: string,
  values: unknown[],
): Promise<void> {
  if (values.length === 0) {
    return;
  }
  await appendFile(
    filePath,
    `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8",
  );
}

async function appendJsonLine(
  filePath: string,
  value: unknown,
): Promise<void> {
  await appendJsonLines(filePath, [value]);
}

async function writeSummary(
  summaryPath: string,
  observationCount: number,
  summaries: NodeSummary[],
  ranges: Ipv4Range[],
  startedAt: Date,
  stopAt: Date,
): Promise<void> {
  const nodes = summaries.sort((left, right) =>
    left.endpoint.localeCompare(right.endpoint),
  );
  const cnNodes = nodes.filter((node) => isCnIpv4(node.host, ranges));
  await writeJson(summaryPath, {
    updatedAt: new Date().toISOString(),
    startedAt: startedAt.toISOString(),
    stopAt: stopAt.toISOString(),
    observationCount,
    endpointCount: nodes.length,
    cnEndpointCount: cnNodes.length,
    cnNodes,
  });
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseOptions(argv: string[]): CrawlerOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value, received: ${name ?? ""}`);
    }
    values.set(name, value);
  }

  const durationHours = Number(
    values.get("--duration-hours") ?? DEFAULT_DURATION_HOURS,
  );
  const intervalSeconds = Number(
    values.get("--interval-seconds") ?? DEFAULT_INTERVAL_SECONDS,
  );
  const outputDir = path.resolve(
    values.get("--output") ??
      path.join(os.homedir(), ".local", "state", "kepos-neo", "dht-crawl"),
  );
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    throw new Error("--duration-hours must be greater than zero");
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
    throw new Error("--interval-seconds must be at least one");
  }
  return { durationHours, intervalSeconds, outputDir };
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entrypoint) {
  runCrawler(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
