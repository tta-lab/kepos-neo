import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parsePublisherConfig } from "../config.js";
import { startHomeServer, type RunningHomeServer } from "../home/server.js";
import { derivePublisherHomeKey } from "../keys.js";
import {
  buildPublisherArguments,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  parsePublisherReadyLine,
  resolveHyperteleEntrypoints,
  spawnManagedHypertele,
  StartupAbortedError,
  TEST_READINESS_TIMEOUT_MS,
  type ManagedHyperteleProcess,
} from "./hypertele-process.js";

export interface PublisherOptions {
  configPath?: string;
  testBootstrapPort?: number;
  serverEntrypoint?: string;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface PublisherCliOptions {
  configPath: string;
  testBootstrapPort?: number;
}

export interface RunningPublisher {
  home: RunningHomeServer;
  process: ManagedHyperteleProcess<string>;
  stop: () => Promise<void>;
  waitForExit: () => Promise<void>;
}

function parsePort(value: string, option: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${option} must be a port from 1 through 65535`);
  }
  return port;
}

function takeValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parsePublisherCliOptions(arguments_: readonly string[]): PublisherCliOptions {
  const options: PublisherCliOptions = {
    configPath: path.resolve("tmp", "p0", "publisher.json"),
  };

  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = takeValue(arguments_, index, option ?? "option");
    if (option === "--config") {
      options.configPath = path.resolve(value);
      continue;
    }
    if (option === "--test-bootstrap") {
      options.testBootstrapPort = parsePort(value, option);
      continue;
    }
    throw new Error(`unknown publisher option: ${option}`);
  }
  return options;
}

export async function startPublisher(options: PublisherOptions = {}): Promise<RunningPublisher> {
  const configPath = path.resolve(options.configPath ?? path.join("tmp", "p0", "publisher.json"));
  const publisher = parsePublisherConfig(JSON.parse(await readFile(configPath, "utf8")) as unknown);
  const homeKey = derivePublisherHomeKey(publisher.seed);
  const home = await startHomeServer({ homeKey, port: 0 });
  let closeHomePromise: Promise<void> | undefined;
  const closeHome = (): Promise<void> => {
    closeHomePromise ??= home.close();
    return closeHomePromise;
  };
  let childProcess: ManagedHyperteleProcess<string> | undefined;

  try {
    const arguments_ = buildPublisherArguments({
      targetPort: home.port,
      configPath,
      testBootstrapPort: options.testBootstrapPort,
    });
    childProcess = spawnManagedHypertele({
      entrypoint: options.serverEntrypoint ?? resolveHyperteleEntrypoints().server,
      arguments: arguments_,
      label: "Hypertele publisher",
      parseReady: (line) => parsePublisherReadyLine(line, homeKey),
      readinessTimeoutMs:
        options.readinessTimeoutMs ??
        (options.testBootstrapPort === undefined
          ? DEFAULT_READINESS_TIMEOUT_MS
          : TEST_READINESS_TIMEOUT_MS),
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      sensitiveValues: [publisher.seed],
      signal: options.signal,
      log: options.log,
    });
    await childProcess.ready;
  } catch (error) {
    let cleanupError: unknown;
    try {
      await childProcess?.stop();
    } catch (caught) {
      cleanupError = caught;
    }
    await closeHome();
    if (error instanceof StartupAbortedError && cleanupError) {
      throw cleanupError;
    }
    throw error;
  }

  const process = childProcess;
  const completion = process.waitForExit().finally(closeHome);
  void completion.catch(() => undefined);
  let stopPromise: Promise<void> | undefined;
  return {
    home,
    process,
    waitForExit: () => completion,
    stop: () => {
      stopPromise ??= (async () => {
        try {
          await process.stop();
        } finally {
          await closeHome();
        }
      })();
      return stopPromise;
    },
  };
}

async function runPublisherCli(): Promise<void> {
  await runPublisher(parsePublisherCliOptions(process.argv.slice(2)));
}

export async function runPublisher(options: PublisherOptions = {}): Promise<void> {
  const controller = new AbortController();
  const requestShutdown = (): void => controller.abort();
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
  try {
    const running = await startPublisher({ ...options, signal: controller.signal });
    await waitForShutdown(running, controller.signal);
  } catch (error) {
    if (!(error instanceof StartupAbortedError)) {
      throw error;
    }
  } finally {
    process.off("SIGINT", requestShutdown);
    process.off("SIGTERM", requestShutdown);
  }
}

async function waitForShutdown(running: RunningPublisher, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    await running.stop();
    return;
  }

  let requestStop!: () => void;
  const stopped = new Promise<void>((resolve, reject) => {
    requestStop = () => running.stop().then(resolve, reject);
  });
  signal.addEventListener("abort", requestStop, { once: true });
  try {
    await Promise.race([stopped, running.waitForExit()]);
  } finally {
    signal.removeEventListener("abort", requestStop);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  runPublisherCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
