import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { once } from "node:events";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { EventEmitter } from "node:events";

import type { GeoRecord } from "./dht-report.js";

const require = createRequire(import.meta.url);
const HyperDHT = require("hyperdht") as HyperDhtConstructor;

export interface BootstrapDiscovery {
  snapshot: string;
  timestamp: string;
  endpoint: string;
  host: string;
  port: number;
  minimumRttMs: number | null;
}

export interface BootstrapCandidate {
  endpoint: string;
  host: string;
  port: number;
  firstSeen: string;
  lastSeen: string;
  snapshots: number;
  minimumRttMs: number | null;
  countryCode: string;
  country: string;
  city: string;
  asn: number | null;
  organization: string;
  regionTier: number;
}

export interface BootstrapValidation {
  endpoint: string;
  timestamp: string;
  success: boolean;
  bootstrapMs: number | null;
  lookupReplies: number;
  announceConnect: boolean;
  connectMs: number | null;
  localConnection?: boolean;
  error?: string;
}

export interface BootstrapProbeResult {
  bootstrapMs: number;
  lookupReplies: number;
  announceConnect: boolean;
  connectMs: number;
  localConnection: false;
}

export interface RecommendationCriteria {
  minimumSuccessfulValidations: number;
  minimumValidationSpanHours: number;
  maximumRecommendations: number;
  maximumPerAsn: number;
  maximumPerCountry: number;
}

export interface ValidationSelectionCriteria {
  limit: number;
  recheckCutoff: string;
  maximumPerAsn: number;
  maximumPerCountry: number;
}

export interface RecommendedEndpoint {
  endpoint: string;
  host: string;
  port: number;
  countryCode: string;
  country: string;
  city: string;
  asn: number | null;
  organization: string;
  discoverySnapshots: number;
  successfulValidations: number;
  validationSpanHours: number;
  minimumRttMs: number | null;
}

export interface RecommendationPayload {
  generatedAt: string;
  endpoints: RecommendedEndpoint[];
}

export interface SignedRecommendation {
  algorithm: "Ed25519";
  payload: RecommendationPayload;
  signature: string;
}

interface ValidatorOptions {
  inputRoot: string;
  limit: number;
  timeoutMs: number;
  minimumDiscoverySnapshots: number;
  recheckHours: number;
}

interface ProbeSocket extends EventEmitter {
  destroy(error?: Error): void;
}

interface ProbeServer extends EventEmitter {
  listen(keyPair: { publicKey: Buffer; secretKey: Buffer }): Promise<void>;
  close(): Promise<void>;
}

interface ProbeDht extends EventEmitter {
  fullyBootstrapped(): Promise<void>;
  findNode(target: Buffer): AsyncIterable<unknown>;
  createServer(): ProbeServer;
  connect(
    publicKey: Buffer,
    options: { localConnection: boolean },
  ): ProbeSocket;
  destroy(options?: { force?: boolean }): Promise<void>;
}

interface HyperDhtConstructor {
  new (options: { bootstrap: string[] }): ProbeDht;
  keyPair(): { publicKey: Buffer; secretKey: Buffer };
}

export function buildBootstrapCandidates(
  discoveries: BootstrapDiscovery[],
  geos: Map<string, GeoRecord>,
): BootstrapCandidate[] {
  const grouped = new Map<
    string,
    {
      discovery: BootstrapDiscovery;
      snapshots: Set<string>;
      firstSeen: string;
      lastSeen: string;
      minimumRttMs: number | null;
    }
  >();

  for (const discovery of discoveries) {
    const current = grouped.get(discovery.endpoint);
    if (!current) {
      grouped.set(discovery.endpoint, {
        discovery,
        snapshots: new Set([discovery.snapshot]),
        firstSeen: discovery.timestamp,
        lastSeen: discovery.timestamp,
        minimumRttMs: discovery.minimumRttMs,
      });
      continue;
    }
    current.snapshots.add(discovery.snapshot);
    current.firstSeen =
      discovery.timestamp < current.firstSeen
        ? discovery.timestamp
        : current.firstSeen;
    current.lastSeen =
      discovery.timestamp > current.lastSeen
        ? discovery.timestamp
        : current.lastSeen;
    current.minimumRttMs = minimumNullable(
      current.minimumRttMs,
      discovery.minimumRttMs,
    );
  }

  return [...grouped.values()]
    .map(
      ({
        discovery,
        snapshots,
        firstSeen,
        lastSeen,
        minimumRttMs,
      }): BootstrapCandidate => {
        const geo = geos.get(discovery.host);
        return {
          endpoint: discovery.endpoint,
          host: discovery.host,
          port: discovery.port,
          firstSeen,
          lastSeen,
          snapshots: snapshots.size,
          minimumRttMs,
          countryCode: geo?.countryCode ?? "",
          country: geo?.country ?? "",
          city: geo?.city ?? "",
          asn: geo?.asn ?? null,
          organization: geo?.organization ?? "",
          regionTier: regionTier(geo?.countryCode ?? ""),
        };
      },
    )
    .sort(compareCandidates);
}

export function buildRecommendationPayload(
  candidates: BootstrapCandidate[],
  validations: BootstrapValidation[],
  criteria: RecommendationCriteria,
  generatedAt: string,
): RecommendationPayload {
  const validationsByEndpoint = new Map<string, BootstrapValidation[]>();
  for (const validation of validations) {
    if (
      !validation.success ||
      !validation.announceConnect ||
      validation.localConnection !== false
    ) {
      continue;
    }
    const current = validationsByEndpoint.get(validation.endpoint) ?? [];
    current.push(validation);
    validationsByEndpoint.set(validation.endpoint, current);
  }

  const endpoints: RecommendedEndpoint[] = [];
  const hosts = new Set<string>();
  const asnCounts = new Map<number, number>();
  const countryCounts = new Map<string, number>();
  for (const candidate of candidates) {
    const successful = (
      validationsByEndpoint.get(candidate.endpoint) ?? []
    ).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
    const validationSpanHours =
      successful.length < 2
        ? 0
        : (Date.parse(successful.at(-1)!.timestamp) -
            Date.parse(successful[0].timestamp)) /
          (60 * 60 * 1_000);
    if (
      successful.length < criteria.minimumSuccessfulValidations ||
      validationSpanHours < criteria.minimumValidationSpanHours ||
      hosts.has(candidate.host)
    ) {
      continue;
    }
    if (
      candidate.asn !== null &&
      (asnCounts.get(candidate.asn) ?? 0) >= criteria.maximumPerAsn
    ) {
      continue;
    }
    if (
      (countryCounts.get(candidate.countryCode) ?? 0) >=
      criteria.maximumPerCountry
    ) {
      continue;
    }
    endpoints.push({
      endpoint: candidate.endpoint,
      host: candidate.host,
      port: candidate.port,
      countryCode: candidate.countryCode,
      country: candidate.country,
      city: candidate.city,
      asn: candidate.asn,
      organization: candidate.organization,
      discoverySnapshots: candidate.snapshots,
      successfulValidations: successful.length,
      validationSpanHours,
      minimumRttMs: candidate.minimumRttMs,
    });
    hosts.add(candidate.host);
    if (candidate.asn !== null) {
      asnCounts.set(candidate.asn, (asnCounts.get(candidate.asn) ?? 0) + 1);
    }
    countryCounts.set(
      candidate.countryCode,
      (countryCounts.get(candidate.countryCode) ?? 0) + 1,
    );
    if (endpoints.length >= criteria.maximumRecommendations) {
      break;
    }
  }
  return { generatedAt, endpoints };
}

export function selectValidationCandidates(
  candidates: BootstrapCandidate[],
  validations: BootstrapValidation[],
  criteria: ValidationSelectionCriteria,
): BootstrapCandidate[] {
  const candidateByEndpoint = new Map(
    candidates.map((candidate) => [candidate.endpoint, candidate]),
  );
  const recentHosts = new Set(
    validations
      .filter(
        ({ timestamp }) =>
          timestamp.localeCompare(criteria.recheckCutoff) >= 0,
      )
      .flatMap(({ endpoint }) => {
        const candidate = candidateByEndpoint.get(endpoint);
        return candidate ? [candidate.host] : [];
      }),
  );
  const selected: BootstrapCandidate[] = [];
  const selectedHosts = new Set<string>();
  const asnCounts = new Map<number, number>();
  const countryCounts = new Map<string, number>();
  for (const candidate of candidates) {
    if (
      recentHosts.has(candidate.host) ||
      selectedHosts.has(candidate.host)
    ) {
      continue;
    }
    if (
      candidate.asn !== null &&
      (asnCounts.get(candidate.asn) ?? 0) >= criteria.maximumPerAsn
    ) {
      continue;
    }
    if (
      (countryCounts.get(candidate.countryCode) ?? 0) >=
      criteria.maximumPerCountry
    ) {
      continue;
    }
    selected.push(candidate);
    selectedHosts.add(candidate.host);
    if (candidate.asn !== null) {
      asnCounts.set(candidate.asn, (asnCounts.get(candidate.asn) ?? 0) + 1);
    }
    countryCounts.set(
      candidate.countryCode,
      (countryCounts.get(candidate.countryCode) ?? 0) + 1,
    );
    if (selected.length >= criteria.limit) {
      break;
    }
  }
  return selected;
}

export async function validateBootstrapCandidate(
  candidate: BootstrapCandidate,
  probe: (
    candidate: BootstrapCandidate,
  ) => Promise<BootstrapProbeResult>,
  timestamp: string,
): Promise<BootstrapValidation> {
  try {
    const result = await probe(candidate);
    return {
      endpoint: candidate.endpoint,
      timestamp,
      success: result.lookupReplies > 0 && result.announceConnect,
      ...result,
    };
  } catch (error) {
    return {
      endpoint: candidate.endpoint,
      timestamp,
      success: false,
      bootstrapMs: null,
      lookupReplies: 0,
      announceConnect: false,
      connectMs: null,
      localConnection: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function readBootstrapDiscoveries(
  inputRoot: string,
): Promise<BootstrapDiscovery[]> {
  const snapshotsRoot = path.join(inputRoot, "snapshots");
  const entries = await readdir(snapshotsRoot, { withFileTypes: true });
  const discoveries: BootstrapDiscovery[] = [];
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const snapshotDir = path.join(snapshotsRoot, entry.name);
    const run = JSON.parse(
      await readFile(path.join(snapshotDir, "run.json"), "utf8"),
    ) as { startedAt?: unknown };
    if (typeof run.startedAt !== "string") {
      continue;
    }
    const nodes = parseJsonLines(
      await readFile(path.join(snapshotDir, "nodes.jsonl"), "utf8"),
    );
    for (const node of nodes) {
      if (
        node.verified !== true ||
        typeof node.endpoint !== "string" ||
        typeof node.host !== "string" ||
        typeof node.port !== "number"
      ) {
        continue;
      }
      discoveries.push({
        snapshot: entry.name,
        timestamp: run.startedAt,
        endpoint: node.endpoint,
        host: node.host,
        port: node.port,
        minimumRttMs:
          typeof node.minimumRttMs === "number"
            ? node.minimumRttMs
            : null,
      });
    }
  }
  return discoveries;
}

export async function runIsolatedBootstrapProbe(
  candidate: BootstrapCandidate,
  timeoutMs: number,
): Promise<BootstrapProbeResult> {
  const bootstrap = [`${candidate.host}:${candidate.port}`];
  const publisher = new HyperDHT({ bootstrap });
  const subscriber = new HyperDHT({ bootstrap });
  let server: ProbeServer | null = null;
  let socket: ProbeSocket | null = null;
  try {
    const bootstrapStartedAt = Date.now();
    await withTimeout(
      Promise.all([
        publisher.fullyBootstrapped(),
        subscriber.fullyBootstrapped(),
      ]),
      timeoutMs,
      "bootstrap",
    );
    const bootstrapMs = Date.now() - bootstrapStartedAt;

    let lookupReplies = 0;
    await withTimeout(
      (async () => {
        for await (const _reply of publisher.findNode(randomBytes(32))) {
          lookupReplies += 1;
        }
      })(),
      timeoutMs,
      "lookup",
    );
    if (lookupReplies === 0) {
      throw new Error("lookup returned no DHT replies");
    }

    const keyPair = HyperDHT.keyPair();
    server = publisher.createServer();
    server.on("connection", (connection: ProbeSocket) => {
      guardProbeSocketErrors(connection);
    });
    await withTimeout(server.listen(keyPair), timeoutMs, "announce");
    const connectStartedAt = Date.now();
    const accepted = once(server, "connection");
    socket = connectWithoutLocalShortcut(subscriber, keyPair.publicKey);
    guardProbeSocketErrors(socket);
    await withTimeout(
      Promise.all([once(socket, "open"), accepted]),
      timeoutMs,
      "connect",
    );
    return {
      bootstrapMs,
      lookupReplies,
      announceConnect: true,
      connectMs: Date.now() - connectStartedAt,
      localConnection: false,
    };
  } finally {
    socket?.destroy();
    await server?.close().catch(() => undefined);
    await Promise.all([
      publisher.destroy({ force: true }),
      subscriber.destroy({ force: true }),
    ]);
  }
}

export function guardProbeSocketErrors(
  socket: Pick<EventEmitter, "on">,
): void {
  socket.on("error", () => undefined);
}

export function connectWithoutLocalShortcut<T>(
  dht: {
    connect(
      publicKey: Buffer,
      options: { localConnection: boolean },
    ): T;
  },
  publicKey: Buffer,
): T {
  return dht.connect(publicKey, { localConnection: false });
}

export function signRecommendationPayload(
  payload: RecommendationPayload,
  privateKey: KeyObject,
): SignedRecommendation {
  return {
    algorithm: "Ed25519",
    payload,
    signature: sign(
      null,
      Buffer.from(JSON.stringify(payload)),
      privateKey,
    ).toString("base64"),
  };
}

export function verifySignedRecommendation(
  envelope: SignedRecommendation,
  publicKey: KeyObject,
): boolean {
  return verify(
    null,
    Buffer.from(JSON.stringify(envelope.payload)),
    publicKey,
    Buffer.from(envelope.signature, "base64"),
  );
}

function compareCandidates(
  left: BootstrapCandidate,
  right: BootstrapCandidate,
): number {
  return (
    left.regionTier - right.regionTier ||
    right.snapshots - left.snapshots ||
    compareNullableNumbers(left.minimumRttMs, right.minimumRttMs) ||
    left.endpoint.localeCompare(right.endpoint)
  );
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
): number {
  if (left === null) {
    return right === null ? 0 : 1;
  }
  if (right === null) {
    return -1;
  }
  return left - right;
}

function minimumNullable(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return Math.min(left, right);
}

function regionTier(countryCode: string): number {
  if (countryCode === "CN") {
    return 0;
  }
  if (["HK", "JP", "KR", "MO", "SG", "TW"].includes(countryCode)) {
    return 1;
  }
  return countryCode ? 2 : 3;
}

async function runValidator(options: ValidatorOptions): Promise<void> {
  await mkdir(options.inputRoot, { recursive: true });
  const discoveries = await readBootstrapDiscoveries(options.inputRoot);
  const geos = await readGeoCache(path.join(options.inputRoot, "geo-cache.json"));
  const candidates = buildBootstrapCandidates(discoveries, geos).filter(
    ({ snapshots }) => snapshots >= options.minimumDiscoverySnapshots,
  );
  const validationsPath = path.join(options.inputRoot, "validations.jsonl");
  const validations = await readValidations(validationsPath);
  const recheckCutoff =
    Date.now() - options.recheckHours * 60 * 60 * 1_000;
  const selected = selectValidationCandidates(candidates, validations, {
    limit: options.limit,
    recheckCutoff: new Date(recheckCutoff).toISOString(),
    maximumPerAsn: 1,
    maximumPerCountry: 2,
  });

  console.log(
    `Validating ${selected.length}/${candidates.length} stable discovery candidates`,
  );
  for (const candidate of selected) {
    const validation = await validateBootstrapCandidate(
      candidate,
      (current) => runIsolatedBootstrapProbe(current, options.timeoutMs),
      new Date().toISOString(),
    );
    validations.push(validation);
    await appendFile(
      validationsPath,
      `${JSON.stringify(validation)}\n`,
      "utf8",
    );
    console.log(
      `${candidate.endpoint} ${validation.success ? "passed" : `failed: ${validation.error ?? "unknown error"}`}`,
    );
  }

  const payload = buildRecommendationPayload(
    candidates,
    validations,
    {
      minimumSuccessfulValidations: 2,
      minimumValidationSpanHours: 12,
      maximumRecommendations: 8,
      maximumPerAsn: 1,
      maximumPerCountry: 2,
    },
    new Date().toISOString(),
  );
  const { privateKey, publicKey } = await loadSigningKeys(options.inputRoot);
  const envelope = signRecommendationPayload(payload, privateKey);
  await writeJsonAtomic(
    path.join(options.inputRoot, "bootstrap-recommendations.json"),
    envelope,
  );
  console.log(
    `Wrote ${payload.endpoints.length} signed recommendations from ${validations.length} validations`,
  );
  console.log(
    `Pinned public key: ${path.join(options.inputRoot, "bootstrap-recommendations-public.pem")}`,
  );
  void publicKey;
}

async function readGeoCache(filePath: string): Promise<Map<string, GeoRecord>> {
  const records = JSON.parse(await readFile(filePath, "utf8")) as GeoRecord[];
  return new Map(records.map((record) => [record.host, record]));
}

async function readValidations(
  filePath: string,
): Promise<BootstrapValidation[]> {
  try {
    return parseJsonLines(
      await readFile(filePath, "utf8"),
    ) as unknown as BootstrapValidation[];
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }
    throw error;
  }
}

function parseJsonLines(input: string): Array<Record<string, unknown>> {
  return input
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function loadSigningKeys(
  inputRoot: string,
): Promise<{ privateKey: KeyObject; publicKey: KeyObject }> {
  const privatePath = path.join(
    inputRoot,
    "bootstrap-recommendations-private.pem",
  );
  const publicPath = path.join(
    inputRoot,
    "bootstrap-recommendations-public.pem",
  );
  try {
    const privateKey = createPrivateKey(
      await readFile(privatePath, "utf8"),
    );
    const publicKey = createPublicKey(await readFile(publicPath, "utf8"));
    return { privateKey, publicKey };
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  await writeFile(
    privatePath,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  await writeFile(
    publicPath,
    publicKey.export({ type: "spki", format: "pem" }),
    "utf8",
  );
  return { privateKey, publicKey };
}

async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  name: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${name} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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

function parseOptions(argv: string[]): ValidatorOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Expected --name value, received: ${name ?? ""}`);
    }
    values.set(name, value);
  }
  const positiveInteger = (name: string, fallback: number): number => {
    const value = Number(values.get(name) ?? fallback);
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
    return value;
  };
  return {
    inputRoot: path.resolve(
      values.get("--input") ??
        path.join(os.homedir(), ".local", "state", "kepos-neo", "dht-graph"),
    ),
    limit: positiveInteger("--limit", 3),
    timeoutMs: positiveInteger("--timeout-ms", 45_000),
    minimumDiscoverySnapshots: positiveInteger(
      "--min-discovery-snapshots",
      2,
    ),
    recheckHours: positiveInteger("--recheck-hours", 12),
  };
}

const entrypoint = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : "";
if (import.meta.url === entrypoint) {
  runValidator(parseOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
