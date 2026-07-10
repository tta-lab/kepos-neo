import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseClientContact } from "../config.js";
import { parseClientIdentity } from "../keys.js";
import {
  buildClientArguments,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  parseClientReadyLine,
  resolveHyperteleEntrypoints,
  spawnManagedHypertele,
  StartupAbortedError,
  TEST_READINESS_TIMEOUT_MS,
  type ManagedHyperteleProcess,
} from "./hypertele-process.js";

export interface ClientOptions {
  identityPath?: string;
  contactPath?: string;
  testBootstrapPort?: number;
  clientEntrypoint?: string;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface ClientCliOptions {
  identityPath: string;
  contactPath: string;
  testBootstrapPort?: number;
}

export interface RunningClient {
  port: number;
  url: string;
  process: ManagedHyperteleProcess<number>;
  stop: () => Promise<void>;
}

function takeValue(arguments_: readonly string[], index: number, option: string): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function parsePort(value: string, option: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${option} must be a port from 1 through 65535`);
  }
  return port;
}

export function parseClientCliOptions(arguments_: readonly string[]): ClientCliOptions {
  const options: ClientCliOptions = {
    identityPath: path.resolve("tmp", "p0", "client-a.identity.json"),
    contactPath: path.resolve("tmp", "p0", "client-a.contact.json"),
  };

  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index];
    const value = takeValue(arguments_, index, option ?? "option");
    if (option === "--identity") {
      options.identityPath = path.resolve(value);
      continue;
    }
    if (option === "--contact") {
      options.contactPath = path.resolve(value);
      continue;
    }
    if (option === "--test-bootstrap") {
      options.testBootstrapPort = parsePort(value, option);
      continue;
    }
    throw new Error(`unknown client option: ${option}`);
  }
  return options;
}

export async function startClient(options: ClientOptions = {}): Promise<RunningClient> {
  const identityPath = path.resolve(
    options.identityPath ?? path.join("tmp", "p0", "client-a.identity.json"),
  );
  const contactPath = path.resolve(
    options.contactPath ?? path.join("tmp", "p0", "client-a.contact.json"),
  );
  const identity = parseClientIdentity(JSON.parse(await readFile(identityPath, "utf8")) as unknown);
  const contact = parseClientContact(JSON.parse(await readFile(contactPath, "utf8")) as unknown);
  if (contact.requestedLocalPort !== 0) {
    throw new Error("P0 client contact must request ephemeral local port 0");
  }

  const arguments_ = buildClientArguments({
    identityPath,
    homeKey: contact.homeKey,
    testBootstrapPort: options.testBootstrapPort,
  });
  const log = options.log ?? console.log;
  const process = spawnManagedHypertele({
    entrypoint: options.clientEntrypoint ?? resolveHyperteleEntrypoints().client,
    arguments: arguments_,
    label: "Hypertele client",
    parseReady: parseClientReadyLine,
    readinessTimeoutMs:
      options.readinessTimeoutMs ??
      (options.testBootstrapPort === undefined
        ? DEFAULT_READINESS_TIMEOUT_MS
        : TEST_READINESS_TIMEOUT_MS),
    shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    sensitiveValues: [identity.secretKey, identity.secretKey.slice(0, 64)],
    signal: options.signal,
    log,
  });

  try {
    const port = await process.ready;
    const url = `http://127.0.0.1:${port}`;
    log(`Local Home ready @${url}`);
    return { port, url, process, stop: process.stop };
  } catch (error) {
    let cleanupError: unknown;
    try {
      await process.stop();
    } catch (caught) {
      cleanupError = caught;
    }
    if (error instanceof StartupAbortedError && cleanupError) {
      throw cleanupError;
    }
    throw error;
  }
}

async function runClientCli(): Promise<void> {
  await runClient(parseClientCliOptions(process.argv.slice(2)));
}

export async function runClient(options: ClientOptions = {}): Promise<void> {
  const controller = new AbortController();
  const requestShutdown = (): void => controller.abort();
  process.on("SIGINT", requestShutdown);
  process.on("SIGTERM", requestShutdown);
  try {
    const running = await startClient({ ...options, signal: controller.signal });
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

async function waitForShutdown(running: RunningClient, signal: AbortSignal): Promise<void> {
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
    await Promise.race([stopped, running.process.waitForExit()]);
  } finally {
    signal.removeEventListener("abort", requestStop);
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  runClientCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
