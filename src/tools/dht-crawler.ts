import {
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { isIPv4 } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomBytes, randomInt } from "node:crypto";

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

export interface QueryNovelty {
  newNodes: number;
  newEdges: number;
}

export interface FrontierYield extends QueryNovelty {
  queries: number;
}

export interface FrontierThresholds {
  minimumNewNodesPerQuery: number;
  minimumNewEdgesPerQuery: number;
}

export interface CrawlerHistory {
  targetPrefixes: number[];
  endpoints: Set<string>;
  edges: Set<string>;
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
  frontierRounds: number;
  frontierThresholds: FrontierThresholds;
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
  previouslySeen = new Set<string>(),
): GraphNode[] {
  const candidates = nodes.filter(({ verified }) => !verified);
  const compare = (left: GraphNode, right: GraphNode): number =>
    right.advertisedBy - left.advertisedBy ||
    left.endpoint.localeCompare(right.endpoint);
  const novel = candidates
    .filter(({ endpoint }) => !previouslySeen.has(endpoint))
    .sort(compare);
  const reliable = candidates.sort(compare);
  const selected = novel.slice(0, Math.ceil(limit * 0.7));
  const selectedEndpoints = new Set(selected.map(({ endpoint }) => endpoint));
  for (const candidate of reliable) {
    if (selected.length >= limit) {
      break;
    }
    if (selectedEndpoints.has(candidate.endpoint)) {
      continue;
    }
    selected.push(candidate);
    selectedEndpoints.add(candidate.endpoint);
  }
  return selected;
}

export function selectTargetPrefixes(
  count: number,
  previousPrefixes: number[],
  shuffledPrefixes: number[],
): number[] {
  const uses = new Array<number>(256).fill(0);
  for (const prefix of previousPrefixes) {
    if (Number.isInteger(prefix) && prefix >= 0 && prefix <= 255) {
      uses[prefix] += 1;
    }
  }
  const order = new Map(
    shuffledPrefixes.map((prefix, index) => [prefix, index]),
  );
  return Array.from({ length: 256 }, (_, prefix) => prefix)
    .sort(
      (left, right) =>
        uses[left] - uses[right] ||
        (order.get(left) ?? left) - (order.get(right) ?? right),
    )
    .slice(0, Math.min(count, 256));
}

export function recordGraphNovelty(
  reply: GraphReply,
  seenNodes: Set<string>,
  seenEdges: Set<string>,
): QueryNovelty {
  let newNodes = addNovelNode(reply.from, seenNodes);
  let newEdges = 0;
  const source = endpoint(reply.from);
  for (const neighbor of reply.closerNodes ?? []) {
    newNodes += addNovelNode(neighbor, seenNodes);
    const edge = `${source}>${endpoint(neighbor)}`;
    if (!seenEdges.has(edge)) {
      seenEdges.add(edge);
      newEdges += 1;
    }
  }
  return { newNodes, newEdges };
}

export function shouldContinueFrontier(
  frontierYield: FrontierYield,
  thresholds: FrontierThresholds,
): boolean {
  if (frontierYield.queries === 0) {
    return false;
  }
  return (
    frontierYield.newNodes / frontierYield.queries >=
      thresholds.minimumNewNodesPerQuery ||
    frontierYield.newEdges / frontierYield.queries >=
      thresholds.minimumNewEdgesPerQuery
  );
}

export async function readCrawlerHistory(
  outputRoot: string,
): Promise<CrawlerHistory> {
  const history: CrawlerHistory = {
    targetPrefixes: [],
    endpoints: new Set(),
    edges: new Set(),
  };
  let entries;
  try {
    entries = await readdir(path.join(outputRoot, "snapshots"), {
      withFileTypes: true,
    });
  } catch (error) {
    if (isMissingFile(error)) {
      return history;
    }
    throw error;
  }

  for (const entry of entries.filter((candidate) => candidate.isDirectory())) {
    const snapshotDir = path.join(outputRoot, "snapshots", entry.name);
    const run = await readOptionalJson(path.join(snapshotDir, "run.json"));
    if (run && Array.isArray(run.targetPrefixes)) {
      history.targetPrefixes.push(
        ...run.targetPrefixes.filter(
          (prefix): prefix is number =>
            Number.isInteger(prefix) && prefix >= 0 && prefix <= 255,
        ),
      );
    }
    for (const node of await readOptionalJsonLines(
      path.join(snapshotDir, "nodes.jsonl"),
    )) {
      if (typeof node.endpoint === "string") {
        history.endpoints.add(node.endpoint);
      }
    }
    for (const edge of await readOptionalJsonLines(
      path.join(snapshotDir, "edges.jsonl"),
    )) {
      if (typeof edge.source === "string" && typeof edge.target === "string") {
        history.edges.add(`${edge.source}>${edge.target}`);
      }
    }
  }
  return history;
}

function addNovelNode(
  address: { host: string; port: number },
  seenNodes: Set<string>,
): number {
  const key = endpoint(address);
  if (seenNodes.has(key)) {
    return 0;
  }
  seenNodes.add(key);
  return 1;
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
  const history = await readCrawlerHistory(options.outputRoot);
  const previouslySeenEndpoints = new Set(history.endpoints);
  const seenNodes = new Set(history.endpoints);
  const seenEdges = new Set(history.edges);
  const startedAt = new Date();
  const snapshot = startedAt.toISOString().replaceAll(":", "-");
  const snapshotDir = path.join(options.outputRoot, "snapshots", snapshot);
  await mkdir(snapshotDir, { recursive: true });
  const ranges = parseCnIpv4Ranges(await loadApnicData(options.outputRoot));
  const dht = new HyperDHT();
  const replies: GraphReply[] = [];
  const queries: Array<Record<string, unknown>> = [];
  const targetPrefixes: number[] = [];
  const attemptedFrontier = new Set<string>();

  await writeJson(path.join(snapshotDir, "run.json"), {
    snapshot,
    startedAt: startedAt.toISOString(),
    targets: options.targets,
    frontierPerRound: options.frontier,
    maximumFrontierRounds: options.frontierRounds,
    frontierThresholds: options.frontierThresholds,
    targetPrefixes,
    pid: process.pid,
  });

  console.log(`Bootstrapping HyperDHT; snapshot=${snapshot}`);
  await dht.fullyBootstrapped();

  try {
    for (let index = 0; index < options.targets; index += 1) {
      const target = nextStratifiedTarget(
        history.targetPrefixes,
        targetPrefixes,
      );
      await collectQuery(
        dht,
        target,
        "seed",
        0,
        null,
        replies,
        queries,
        seenNodes,
        seenEdges,
      );
    }

    const frontierYields: FrontierYield[] = [];
    for (let round = 1; round <= options.frontierRounds; round += 1) {
      const graph = aggregateGraphReplies(replies);
      const candidates = rankFrontier(
        graph.nodes.filter(
          ({ endpoint }) => !attemptedFrontier.has(endpoint),
        ),
        options.frontier,
        previouslySeenEndpoints,
      );
      if (candidates.length === 0) {
        break;
      }

      const frontierYield: FrontierYield = {
        queries: 0,
        newNodes: 0,
        newEdges: 0,
      };
      for (const node of candidates) {
        attemptedFrontier.add(node.endpoint);
        const target = nextStratifiedTarget(
          history.targetPrefixes,
          targetPrefixes,
        );
        const novelty = await collectQuery(
          dht,
          target,
          "frontier",
          round,
          { host: node.host, port: node.port },
          replies,
          queries,
          seenNodes,
          seenEdges,
        );
        frontierYield.queries += 1;
        frontierYield.newNodes += novelty.newNodes;
        frontierYield.newEdges += novelty.newEdges;
      }
      frontierYields.push(frontierYield);
      console.log(
        `Frontier ${round}: queries=${frontierYield.queries} newNodes=${frontierYield.newNodes} newEdges=${frontierYield.newEdges}`,
      );
      if (
        !shouldContinueFrontier(
          frontierYield,
          options.frontierThresholds,
        )
      ) {
        break;
      }
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
    await writeJson(path.join(snapshotDir, "run.json"), {
      snapshot,
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      targets: options.targets,
      frontierPerRound: options.frontier,
      maximumFrontierRounds: options.frontierRounds,
      frontierThresholds: options.frontierThresholds,
      targetPrefixes,
      pid: process.pid,
    });
    await writeJson(path.join(snapshotDir, "summary.json"), {
      snapshot,
      completedAt: new Date().toISOString(),
      queries: queries.length,
      replies: replies.length,
      nodes: graph.nodes.length,
      verifiedNodes: graph.nodes.filter(({ verified }) => verified).length,
      advertisedNodes: graph.nodes.filter(({ verified }) => !verified).length,
      edges: graph.edges.length,
      newNodes: seenNodes.size - history.endpoints.size,
      newEdges: seenEdges.size - history.edges.size,
      frontierRounds: frontierYields,
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
  round: number,
  startNode: { host: string; port: number } | null,
  replies: GraphReply[],
  queries: Array<Record<string, unknown>>,
  seenNodes: Set<string>,
  seenEdges: Set<string>,
): Promise<QueryNovelty> {
  const startedAt = new Date().toISOString();
  let responseCount = 0;
  let advertisedCount = 0;
  const novelty: QueryNovelty = { newNodes: 0, newEdges: 0 };
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
      const reply = {
        from,
        rtt: raw.rtt,
        closerNodes,
      };
      replies.push(reply);
      const update = recordGraphNovelty(reply, seenNodes, seenEdges);
      novelty.newNodes += update.newNodes;
      novelty.newEdges += update.newEdges;
      responseCount += 1;
      advertisedCount += closerNodes.length;
    }
    queries.push({
      phase,
      round,
      target: target.toString("hex"),
      startNode,
      startedAt,
      completedAt: new Date().toISOString(),
      responses: responseCount,
      advertised: advertisedCount,
      ...novelty,
    });
  } catch (error) {
    queries.push({
      phase,
      round,
      target: target.toString("hex"),
      startNode,
      startedAt,
      completedAt: new Date().toISOString(),
      responses: responseCount,
      advertised: advertisedCount,
      ...novelty,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return novelty;
}

function nextStratifiedTarget(
  historicalPrefixes: number[],
  currentPrefixes: number[],
): Buffer {
  const prefix = selectTargetPrefixes(
    1,
    [...historicalPrefixes, ...currentPrefixes],
    shuffledPrefixes(),
  )[0];
  const target = randomBytes(32);
  target[0] = prefix;
  currentPrefixes.push(prefix);
  return target;
}

function shuffledPrefixes(): number[] {
  const prefixes = Array.from({ length: 256 }, (_, prefix) => prefix);
  for (let index = prefixes.length - 1; index > 0; index -= 1) {
    const swap = randomInt(index + 1);
    [prefixes[index], prefixes[swap]] = [prefixes[swap], prefixes[index]];
  }
  return prefixes;
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

async function readOptionalJson(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }
    throw error;
  }
}

async function readOptionalJsonLines(
  filePath: string,
): Promise<Array<Record<string, unknown>>> {
  try {
    const input = await readFile(filePath, "utf8");
    return input
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
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
  const frontierRounds = Number(values.get("--frontier-rounds") ?? 3);
  const minimumNewNodesPerQuery = Number(
    values.get("--min-new-nodes-per-query") ?? 1,
  );
  const minimumNewEdgesPerQuery = Number(
    values.get("--min-new-edges-per-query") ?? 5,
  );
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
  if (!Number.isInteger(frontierRounds) || frontierRounds < 0) {
    throw new Error("--frontier-rounds must be a non-negative integer");
  }
  if (
    !Number.isFinite(minimumNewNodesPerQuery) ||
    minimumNewNodesPerQuery < 0
  ) {
    throw new Error("--min-new-nodes-per-query must be non-negative");
  }
  if (
    !Number.isFinite(minimumNewEdgesPerQuery) ||
    minimumNewEdgesPerQuery < 0
  ) {
    throw new Error("--min-new-edges-per-query must be non-negative");
  }
  return {
    targets,
    frontier,
    frontierRounds,
    frontierThresholds: {
      minimumNewNodesPerQuery,
      minimumNewEdgesPerQuery,
    },
    outputRoot,
  };
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
