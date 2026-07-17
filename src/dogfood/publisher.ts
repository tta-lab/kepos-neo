import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parsePublisherConfig, parsePublisherManifest } from "../config.js";
import { startHomeServer, type RunningHomeServer } from "../home/server.js";
import { derivePublisherHomeKey } from "../keys.js";
import {
  buildPublisherArguments,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  parsePublisherReadyLine,
  resolveHyperteleEntrypoints,
  spawnManagedHypertele,
  type ManagedHyperteleProcess,
} from "../p0/hypertele-process.js";
import { stopTunnels, type RunningTunnel } from "./tunnel.js";
import { parseTcpPort, takeOptionValue, waitForSignal } from "./cli.js";

export interface DogfoodPublisherOptions {
  stateDir?: string;
  testBootstrapPort?: number;
  serverEntrypoint?: string;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface RunningDogfoodPublisher {
  home: RunningHomeServer;
  tunnels: RunningTunnel[];
  stop: () => Promise<void>;
  waitForExit: () => Promise<void>;
}

export type DogfoodPublisherCliOptions = Pick<
  DogfoodPublisherOptions,
  "stateDir" | "testBootstrapPort"
>;

export function parseDogfoodPublisherCliOptions(
  arguments_: readonly string[],
): DogfoodPublisherCliOptions {
  const options: DogfoodPublisherCliOptions = {
    stateDir: path.resolve("tmp", "dogfood", "publisher"),
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "option";
    const value = takeOptionValue(arguments_, index, option);
    if (option === "--state") {
      options.stateDir = path.resolve(value);
      continue;
    }
    if (option === "--test-bootstrap") {
      options.testBootstrapPort = parseTcpPort(value, option);
      continue;
    }
    throw new Error(`unknown dogfood publisher option: ${option}`);
  }
  return options;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

export async function startDogfoodPublisher(
  options: DogfoodPublisherOptions = {},
): Promise<RunningDogfoodPublisher> {
  const stateDir = path.resolve(options.stateDir ?? path.join("tmp", "dogfood", "publisher"));
  const manifest = parsePublisherManifest(
    await readJson(path.join(stateDir, "publisher.manifest.json")),
  );
  const entries = [
    { id: "home", name: "Home", targetPort: 0, config: manifest.homeConfig },
    ...manifest.services,
  ];
  const configs = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      publisher: parsePublisherConfig(await readJson(path.join(stateDir, entry.config))),
    })),
  );
  const homeConfig = configs[0];
  const homeKey = derivePublisherHomeKey(homeConfig.publisher.seed);
  const services = configs.slice(1).map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: "tcp" as const,
    serviceKey: derivePublisherHomeKey(entry.publisher.seed),
  }));
  const home = await startHomeServer({
    homeKey,
    displayName: manifest.displayName,
    services,
  });
  const tunnels: RunningTunnel[] = [];
  let closeHomePromise: Promise<void> | undefined;
  const closeHome = (): Promise<void> => {
    closeHomePromise ??= home.close();
    return closeHomePromise;
  };

  try {
    for (const entry of configs) {
      const serviceKey = derivePublisherHomeKey(entry.publisher.seed);
      const targetPort = entry.id === "home" ? home.port : entry.targetPort;
      const process = spawnManagedHypertele({
        entrypoint: options.serverEntrypoint ?? resolveHyperteleEntrypoints().server,
        arguments: buildPublisherArguments({
          targetPort,
          configPath: path.join(stateDir, entry.config),
          testBootstrapPort: options.testBootstrapPort,
        }),
        label: `Hypertele publisher ${entry.id}`,
        parseReady: (line) => parsePublisherReadyLine(line, serviceKey),
        readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
        shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
        sensitiveValues: [entry.publisher.seed],
        signal: options.signal,
        log: options.log,
      });
      tunnels.push({ id: entry.id, serviceKey, port: targetPort, process });
      await process.ready;
    }
  } catch (error) {
    const cleanup = await Promise.allSettled([stopTunnels(tunnels), closeHome()]);
    const cleanupErrors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "publisher startup and cleanup failed");
    }
    throw error;
  }

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      try {
        await stopTunnels(tunnels);
      } finally {
        await closeHome();
      }
    })();
    return stopPromise;
  };
  const waitForExit = async (): Promise<void> => {
    try {
      await Promise.race(tunnels.map((tunnel) => tunnel.process.waitForExit()));
    } finally {
      await stop();
    }
  };

  return { home, tunnels, stop, waitForExit };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const options = parseDogfoodPublisherCliOptions(process.argv.slice(2));
  startDogfoodPublisher(options)
    .then((running) => waitForSignal(running.stop, running.waitForExit))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
