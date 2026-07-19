import { spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import {
  appendFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseClientIdentity } from "../keys.js";
import { keyPairFromSecretKey } from "../mux/hyperdht.js";
import {
  buildBootstrapGroups,
  runBootstrapBenchmark,
  runBootstrapProbe,
  summarizeBenchmark,
  type BootstrapBenchmarkGroup,
  type BootstrapBenchmarkResult,
  type BootstrapBenchmarkTrial,
  type SignedBootstrapRecommendations,
} from "./bootstrap-benchmark.js";

const require = createRequire(import.meta.url);
const HyperDHT = require("hyperdht") as HyperDhtConstructor;

interface HyperDhtConstructor {
  new (options: {
    bootstrap?: string[];
    keyPair: {
      publicKey: Buffer;
      secretKey: Buffer;
    };
  }): {
    fullyBootstrapped: () => Promise<void>;
    connect: (
      publicKey: Buffer,
      options: {
        keyPair: {
          publicKey: Buffer;
          secretKey: Buffer;
        };
        localConnection: false;
        reusableSocket: true;
      },
    ) => EventEmitter & { destroy: () => void };
    destroy: (options?: { force?: boolean }) => Promise<void>;
  };
}

interface ParentOptions {
  recommendations: string;
  identity: string;
  publisherKey: string;
  output: string;
  trials: number;
  timeoutMs: number;
}

interface ProbeOptions {
  group: string;
  trial: number;
  sequence: number;
  identity: string;
  publisherKey: string;
  timeoutMs: number;
  bootstrap?: string[];
}

async function main(arguments_: string[]): Promise<void> {
  if (arguments_[0] === "--probe") {
    const result = await executeProbe(parseProbeOptions(arguments_.slice(1)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const options = parseParentOptions(arguments_);
  await mkdir(options.output, { recursive: true });
  const resultsPath = path.join(options.output, "results.jsonl");
  const summaryPath = path.join(options.output, "summary.json");
  await writeFile(resultsPath, "", "utf8");
  const recommendations = JSON.parse(
    await readFile(options.recommendations, "utf8"),
  ) as SignedBootstrapRecommendations;
  const groups = buildBootstrapGroups(recommendations);

  const results = await runBootstrapBenchmark({
    groups,
    trialsPerGroup: options.trials,
    runTrial: (trial) => runFreshProcess(trial, options),
    persist: async (result) => {
      await appendFile(resultsPath, `${JSON.stringify(result)}\n`, "utf8");
      const outcome = result.success
        ? `bootstrap=${result.bootstrapMs}ms outer=${result.outerMs}ms`
        : `failed=${result.error}`;
      console.log(
        `[${result.sequence}/${groups.length * options.trials}] ${result.group} trial=${result.trial} ${outcome}`,
      );
    },
  });
  const artifact = {
    generatedAt: new Date().toISOString(),
    trialsPerGroup: options.trials,
    timeoutMs: options.timeoutMs,
    publisherKey: truncateKey(options.publisherKey),
    recommendations: path.resolve(options.recommendations),
    groups,
    summaries: summarizeBenchmark(results),
  };
  await writeFile(summaryPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote ${results.length} trials to ${options.output}`);
  console.table(artifact.summaries);
}

async function runFreshProcess(
  trial: BootstrapBenchmarkTrial,
  options: ParentOptions,
): Promise<BootstrapBenchmarkResult> {
  const arguments_ = [
    "--import",
    "tsx",
    path.resolve(import.meta.dirname, "bootstrap-benchmark-cli.ts"),
    "--probe",
    "--group",
    trial.group.name,
    "--trial",
    String(trial.trial),
    "--sequence",
    String(trial.sequence),
    "--identity",
    path.resolve(options.identity),
    "--publisher-key",
    options.publisherKey,
    "--timeout-ms",
    String(options.timeoutMs),
  ];
  const child = spawn(process.execPath, arguments_, {
    env: {
      ...process.env,
      KEPOS_BOOTSTRAP_BENCHMARK_GROUP: JSON.stringify(
        trial.group.bootstrap,
      ),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const output = Buffer.concat(stdout).toString("utf8").trim();
  if (exitCode !== 0) {
    throw new Error(
      `benchmark child exited ${exitCode}: ${Buffer.concat(stderr).toString("utf8").trim()}`,
    );
  }
  return JSON.parse(output) as BootstrapBenchmarkResult;
}

async function executeProbe(
  options: ProbeOptions,
): Promise<BootstrapBenchmarkResult> {
  const identity = parseClientIdentity(
    JSON.parse(await readFile(options.identity, "utf8")),
  );
  const keyPair = keyPairFromSecretKey(identity.secretKey);
  const publisherKey = parsePublicKey(options.publisherKey);
  return runBootstrapProbe({
    group: {
      name: options.group as BootstrapBenchmarkGroup["name"],
      bootstrap: options.bootstrap,
    },
    trial: options.trial,
    sequence: options.sequence,
    publisherKey,
    keyPair,
    timeoutMs: options.timeoutMs,
    createDht: (dhtOptions) => new HyperDHT(dhtOptions),
  });
}

function parseParentOptions(arguments_: string[]): ParentOptions {
  const options = parsePairs(arguments_);
  return {
    recommendations: required(options, "--recommendations"),
    identity: required(options, "--identity"),
    publisherKey: required(options, "--publisher-key"),
    output: path.resolve(required(options, "--output")),
    trials: positiveInteger(options.get("--trials") ?? "20", "--trials"),
    timeoutMs: positiveInteger(
      options.get("--timeout-ms") ?? "30000",
      "--timeout-ms",
    ),
  };
}

function parseProbeOptions(arguments_: string[]): ProbeOptions {
  const options = parsePairs(arguments_);
  const bootstrap = JSON.parse(
    process.env.KEPOS_BOOTSTRAP_BENCHMARK_GROUP ?? "null",
  ) as string[] | null;
  return {
    group: required(options, "--group"),
    trial: positiveInteger(required(options, "--trial"), "--trial"),
    sequence: positiveInteger(
      required(options, "--sequence"),
      "--sequence",
    ),
    identity: required(options, "--identity"),
    publisherKey: required(options, "--publisher-key"),
    timeoutMs: positiveInteger(
      required(options, "--timeout-ms"),
      "--timeout-ms",
    ),
    ...(bootstrap ? { bootstrap } : {}),
  };
}

function parsePairs(arguments_: string[]): Map<string, string> {
  if (arguments_.length % 2 !== 0) {
    throw new Error(`option requires a value: ${arguments_.at(-1)}`);
  }
  const parsed = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index] ?? "";
    const value = arguments_[index + 1] ?? "";
    if (!name.startsWith("--") || !value) {
      throw new Error(`invalid option pair: ${name} ${value}`);
    }
    if (parsed.has(name)) throw new Error(`${name} may be used only once`);
    parsed.set(name, value);
  }
  return parsed;
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parsePublicKey(value: string): Buffer {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("--publisher-key must be 64 lowercase hex characters");
  }
  return Buffer.from(value, "hex");
}

function truncateKey(value: string): string {
  return `${value.slice(0, 12)}…${value.slice(-12)}`;
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
