import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export interface Ipv4Range {
  start: number;
  end: number;
}

export interface NodeObservation {
  timestamp: string;
  host: string;
  port: number;
  source: "lookup" | "routing" | "find-node";
  snapshot?: string;
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

export interface GraphReply {
  from: { host: string; port: number };
  rtt: number;
  closerNodes: Array<{ host: string; port: number }> | null;
}

export interface GraphNode {
  endpoint: string;
  host: string;
  port: number;
  verified: boolean;
  directResponses: number;
  advertisedBy: number;
  minimumRttMs: number | null;
  maximumRttMs: number | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  observations: number;
}

export interface GraphSnapshot {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

interface HyperDhtNode {
  fullyBootstrapped(): Promise<void>;
  findNode(
    target: Buffer,
    options?: { nodes?: Array<{ host: string; port: number }> },
  ): AsyncIterable<GraphReply>;
  destroy(options?: { force?: boolean }): Promise<void>;
}

interface HyperDhtConstructor {
  new (): HyperDhtNode;
}

interface CrawlerOptions {
  targets: number;
  frontier: number;
  outputRoot: string;
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

export function aggregateGraphReplies(replies: GraphReply[]): GraphSnapshot {
  const nodes = new Map<string, GraphNode & { referrers: Set<string> }>();
  const edges = new Map<string, GraphEdge>();

  for (const reply of replies) {
    const source = endpoint(reply.from);
    const sourceNode = graphNode(nodes, reply.from);
    sourceNode.verified = true;
    sourceNode.directResponses += 1;
    sourceNode.minimumRttMs =
      sourceNode.minimumRttMs === null
        ? reply.rtt
        : Math.min(sourceNode.minimumRttMs, reply.rtt);
    sourceNode.maximumRttMs =
      sourceNode.maximumRttMs === null
        ? reply.rtt
        : Math.max(sourceNode.maximumRttMs, reply.rtt);

    for (const neighbor of reply.closerNodes ?? []) {
      const target = endpoint(neighbor);
      if (target === source) {
        continue;
      }
      const targetNode = graphNode(nodes, neighbor);
      targetNode.referrers.add(source);
      const edgeKey = `${source}>${target}`;
      const edge = edges.get(edgeKey) ?? {
        source,
        target,
        observations: 0,
      };
      edge.observations += 1;
      edges.set(edgeKey, edge);
    }
  }

  return {
    nodes: [...nodes.values()]
      .map(({ referrers, ...node }) => ({
        ...node,
        advertisedBy: referrers.size,
      }))
      .sort((left, right) => left.endpoint.localeCompare(right.endpoint)),
    edges: [...edges.values()].sort(
      (left, right) =>
        left.source.localeCompare(right.source) ||
        left.target.localeCompare(right.target),
    ),
  };
}

export function rankFrontier(
  nodes: GraphNode[],
  limit: number,
): GraphNode[] {
  return nodes
    .filter(({ verified }) => !verified)
    .sort(
      (left, right) =>
        right.advertisedBy - left.advertisedBy ||
        left.endpoint.localeCompare(right.endpoint),
    )
    .slice(0, limit);
}

function graphNode(
  nodes: Map<string, GraphNode & { referrers: Set<string> }>,
  address: { host: string; port: number },
): GraphNode & { referrers: Set<string> } {
  const key = endpoint(address);
  const existing = nodes.get(key);
  if (existing) {
    return existing;
  }
  const node = {
    endpoint: key,
    host: address.host,
    port: address.port,
    verified: false,
    directResponses: 0,
    advertisedBy: 0,
    minimumRttMs: null,
    maximumRttMs: null,
    referrers: new Set<string>(),
  };
  nodes.set(key, node);
  return node;
}

function endpoint(address: { host: string; port: number }): string {
  return `${address.host}:${address.port}`;
}

async function runCrawler(options: CrawlerOptions): Promise<void> {
  const startedAt = new Date();
  const snapshot = startedAt.toISOString().replaceAll(":", "-");
  const snapshotDir = path.join(options.outputRoot, "snapshots", snapshot);
  await mkdir(snapshotDir, { recursive: true });
  const ranges = parseCnIpv4Ranges(await loadApnicData(options.outputRoot));
  const dht = new HyperDHT();
  const replies: GraphReply[] = [];
  const queries: Array<Record<string, unknown>> = [];

  await writeJson(path.join(snapshotDir, "run.json"), {
    snapshot,
    startedAt: startedAt.toISOString(),
    targets: options.targets,
    frontier: options.frontier,
    pid: process.pid,
  });

  console.log(`Bootstrapping HyperDHT; snapshot=${snapshot}`);
  await dht.fullyBootstrapped();

  try {
    for (let index = 0; index < options.targets; index += 1) {
      await collectQuery(
        dht,
        randomBytes(32),
        "seed",
        null,
        replies,
        queries,
      );
    }

    const seedGraph = aggregateGraphReplies(replies);
    const frontier = rankFrontier(seedGraph.nodes, options.frontier);
    for (const node of frontier) {
      await collectQuery(
        dht,
        randomBytes(32),
        "frontier",
        { host: node.host, port: node.port },
        replies,
        queries,
      );
    }

    const graph = aggregateGraphReplies(replies);
    const observations: NodeObservation[] = replies.map((reply) => ({
      timestamp: startedAt.toISOString(),
      snapshot,
      host: reply.from.host,
      port: reply.from.port,
      source: "find-node",
    }));
    const cnNodes = graph.nodes.filter((node) => isCnIpv4(node.host, ranges));
    await writeJsonLines(path.join(snapshotDir, "nodes.jsonl"), graph.nodes);
    await writeJsonLines(path.join(snapshotDir, "edges.jsonl"), graph.edges);
    await writeJsonLines(
      path.join(snapshotDir, "observations.jsonl"),
      observations,
    );
    await writeJsonLines(path.join(snapshotDir, "queries.jsonl"), queries);
    await writeJson(path.join(snapshotDir, "summary.json"), {
      snapshot,
      completedAt: new Date().toISOString(),
      queries: queries.length,
      replies: replies.length,
      nodes: graph.nodes.length,
      verifiedNodes: graph.nodes.filter(({ verified }) => verified).length,
      advertisedNodes: graph.nodes.filter(({ verified }) => !verified).length,
      edges: graph.edges.length,
      cnNodes: cnNodes.length,
      cnVerifiedNodes: cnNodes.filter(({ verified }) => verified).length,
    });
    console.log(
      `Completed ${snapshot}: nodes=${graph.nodes.length} verified=${graph.nodes.filter(({ verified }) => verified).length} edges=${graph.edges.length}`,
    );
  } finally {
    await dht.destroy({ force: true });
  }
}

async function collectQuery(
  dht: HyperDhtNode,
  target: Buffer,
  phase: "seed" | "frontier",
  startNode: { host: string; port: number } | null,
  replies: GraphReply[],
  queries: Array<Record<string, unknown>>,
): Promise<void> {
  const startedAt = new Date().toISOString();
  let responseCount = 0;
  let advertisedCount = 0;
  try {
    const query = dht.findNode(
      target,
      startNode ? { nodes: [startNode] } : undefined,
    );
    for await (const raw of query) {
      const from = normalizeEndpoint(raw.from);
      if (!from) {
        continue;
      }
      const closerNodes = (raw.closerNodes ?? [])
        .map(normalizeEndpoint)
        .filter(
          (node): node is { host: string; port: number } => node !== null,
        );
      replies.push({
        from,
        rtt: raw.rtt,
        closerNodes,
      });
      responseCount += 1;
      advertisedCount += closerNodes.length;
    }
    queries.push({
      phase,
      target: target.toString("hex"),
      startNode,
      startedAt,
      completedAt: new Date().toISOString(),
      responses: responseCount,
      advertised: advertisedCount,
    });
  } catch (error) {
    queries.push({
      phase,
      target: target.toString("hex"),
      startNode,
      startedAt,
      completedAt: new Date().toISOString(),
      responses: responseCount,
      advertised: advertisedCount,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function normalizeEndpoint(
  value: { host?: unknown; port?: unknown } | null | undefined,
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

async function writeJsonLines(
  filePath: string,
  values: unknown[],
): Promise<void> {
  await writeFile(
    filePath,
    values.length === 0
      ? ""
      : `${values.map((value) => JSON.stringify(value)).join("\n")}\n`,
    "utf8",
  );
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
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

  const targets = Number(values.get("--targets") ?? 32);
  const frontier = Number(values.get("--frontier") ?? 64);
  const outputRoot = path.resolve(
    values.get("--output") ??
      path.join(os.homedir(), ".local", "state", "kepos-neo", "dht-graph"),
  );
  if (!Number.isInteger(targets) || targets <= 0) {
    throw new Error("--targets must be a positive integer");
  }
  if (!Number.isInteger(frontier) || frontier < 0) {
    throw new Error("--frontier must be a non-negative integer");
  }
  return { targets, frontier, outputRoot };
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
