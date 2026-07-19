import { once, type EventEmitter } from "node:events";

export interface SignedBootstrapRecommendations {
  algorithm: string;
  payload: {
    generatedAt: string;
    endpoints: Array<{
      endpoint: string;
      host: string;
      port: number;
      countryCode: string;
    }>;
  };
  signature: string;
}

export interface BootstrapBenchmarkGroup {
  name:
    | "default"
    | "cn-hk"
    | "cn-hk-sg"
    | "recommended-plus-default";
  bootstrap?: string[];
}

export interface BootstrapBenchmarkTrial {
  group: BootstrapBenchmarkGroup;
  trial: number;
  sequence: number;
}

export interface BootstrapBenchmarkResult {
  group: string;
  trial: number;
  sequence: number;
  timestamp: string;
  bootstrapMs: number | null;
  outerMs: number | null;
  connectMs: number | null;
  success: boolean;
  error?: string;
}

export interface BootstrapBenchmarkSummary {
  group: string;
  attempts: number;
  successes: number;
  failures: number;
  failureRate: number;
  bootstrapMs: LatencySummary;
  outerMs: LatencySummary;
}

interface LatencySummary {
  samples: number;
  p50: number | null;
  p90: number | null;
}

interface BenchmarkKeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}

interface BenchmarkSocket extends EventEmitter {
  destroy: () => void;
}

interface BenchmarkDht {
  fullyBootstrapped: () => Promise<void>;
  connect: (
    publicKey: Buffer,
    options: {
      keyPair: BenchmarkKeyPair;
      localConnection: false;
      reusableSocket: true;
    },
  ) => BenchmarkSocket;
  destroy: (options?: { force?: boolean }) => Promise<void>;
}

export interface RunBootstrapProbeOptions {
  group: BootstrapBenchmarkGroup;
  trial: number;
  sequence: number;
  publisherKey: Buffer;
  keyPair: BenchmarkKeyPair;
  timeoutMs: number;
  createDht: (options: {
    bootstrap?: string[];
    keyPair: BenchmarkKeyPair;
  }) => BenchmarkDht;
  now?: () => number;
  timestamp?: () => string;
}

export interface RunBootstrapBenchmarkOptions {
  groups: BootstrapBenchmarkGroup[];
  trialsPerGroup: number;
  runTrial: (
    trial: BootstrapBenchmarkTrial,
  ) => Promise<BootstrapBenchmarkResult>;
  persist: (result: BootstrapBenchmarkResult) => Promise<void>;
}

const officialBootstrap = [
  "88.99.3.86@node1.hyperdht.org:49737",
  "142.93.90.113@node2.hyperdht.org:49737",
  "138.68.147.8@node3.hyperdht.org:49737",
];

export function buildBootstrapGroups(
  recommendations: SignedBootstrapRecommendations,
): BootstrapBenchmarkGroup[] {
  const endpoints = recommendations.payload.endpoints;
  const regional = (countryCodes: Set<string>) =>
    endpoints
      .filter(({ countryCode }) => countryCodes.has(countryCode))
      .map(({ endpoint }) => endpoint);

  return [
    { name: "default" },
    {
      name: "cn-hk",
      bootstrap: regional(new Set(["CN", "HK"])),
    },
    {
      name: "cn-hk-sg",
      bootstrap: regional(new Set(["CN", "HK", "SG"])),
    },
    {
      name: "recommended-plus-default",
      bootstrap: [
        ...new Set([
          ...endpoints.map(({ endpoint }) => endpoint),
          ...officialBootstrap,
        ]),
      ],
    },
  ];
}

export function buildTrialSchedule(
  groups: BootstrapBenchmarkGroup[],
  trialsPerGroup: number,
): BootstrapBenchmarkTrial[] {
  const schedule: BootstrapBenchmarkTrial[] = [];
  for (let trial = 1; trial <= trialsPerGroup; trial++) {
    for (const group of groups) {
      schedule.push({
        group,
        trial,
        sequence: schedule.length + 1,
      });
    }
  }
  return schedule;
}

export function summarizeBenchmark(
  results: BootstrapBenchmarkResult[],
): BootstrapBenchmarkSummary[] {
  const grouped = new Map<string, BootstrapBenchmarkResult[]>();
  for (const result of results) {
    const current = grouped.get(result.group) ?? [];
    current.push(result);
    grouped.set(result.group, current);
  }

  return [...grouped].map(([group, samples]) => {
    const successes = samples.filter(({ success }) => success).length;
    return {
      group,
      attempts: samples.length,
      successes,
      failures: samples.length - successes,
      failureRate: (samples.length - successes) / samples.length,
      bootstrapMs: summarizeLatency(
        samples.flatMap(({ bootstrapMs }) =>
          bootstrapMs === null ? [] : [bootstrapMs],
        ),
      ),
      outerMs: summarizeLatency(
        samples.flatMap(({ outerMs }) =>
          outerMs === null ? [] : [outerMs],
        ),
      ),
    };
  });
}

export async function runBootstrapBenchmark(
  options: RunBootstrapBenchmarkOptions,
): Promise<BootstrapBenchmarkResult[]> {
  const results: BootstrapBenchmarkResult[] = [];
  const schedule = buildTrialSchedule(
    options.groups,
    options.trialsPerGroup,
  );
  for (const trial of schedule) {
    const result = await options.runTrial(trial);
    results.push(result);
    await options.persist(result);
  }
  return results;
}

export async function runBootstrapProbe(
  options: RunBootstrapProbeOptions,
): Promise<BootstrapBenchmarkResult> {
  const now = options.now ?? Date.now;
  const timestamp =
    options.timestamp ?? (() => new Date().toISOString());
  const startedAt = now();
  const dht = options.createDht({
    bootstrap: options.group.bootstrap,
    keyPair: options.keyPair,
  });
  let socket: BenchmarkSocket | undefined;
  let bootstrapMs: number | null = null;
  try {
    await withTimeout(
      dht.fullyBootstrapped(),
      options.timeoutMs,
      "bootstrap",
    );
    const bootstrappedAt = now();
    bootstrapMs = bootstrappedAt - startedAt;
    socket = dht.connect(options.publisherKey, {
      keyPair: options.keyPair,
      localConnection: false,
      reusableSocket: true,
    });
    await withTimeout(
      once(socket, "open").then(() => undefined),
      options.timeoutMs,
      "outer connection",
    );
    const connectedAt = now();
    return {
      group: options.group.name,
      trial: options.trial,
      sequence: options.sequence,
      timestamp: timestamp(),
      bootstrapMs,
      outerMs: connectedAt - startedAt,
      connectMs: connectedAt - bootstrappedAt,
      success: true,
    };
  } catch (error) {
    return {
      group: options.group.name,
      trial: options.trial,
      sequence: options.sequence,
      timestamp: timestamp(),
      bootstrapMs,
      outerMs: null,
      connectMs: null,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    socket?.destroy();
    await dht.destroy({ force: true }).catch(() => undefined);
  }
}

function summarizeLatency(samples: number[]): LatencySummary {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50: nearestRank(sorted, 0.5),
    p90: nearestRank(sorted, 0.9),
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function nearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(sorted.length * percentile) - 1] ?? null;
}
