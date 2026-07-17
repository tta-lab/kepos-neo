import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseClientContact } from "../config.js";
import { type HomeRegistry, type HomeRegistryService } from "../home/registry.js";
import { parseClientIdentity } from "../keys.js";
import {
  buildClientArguments,
  DEFAULT_READINESS_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  parseClientReadyLine,
  resolveHyperteleEntrypoints,
  spawnManagedHypertele,
} from "../p0/hypertele-process.js";
import { stopTunnels, type RunningTunnel } from "./tunnel.js";
import { parseTcpPort, takeOptionValue, waitForSignal } from "./cli.js";

export interface DogfoodClientOptions {
  stateDir?: string;
  serviceId: string;
  localPort: number;
  testBootstrapPort?: number;
  clientEntrypoint?: string;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signal?: AbortSignal;
  fetchRegistry?: (url: string) => Promise<unknown>;
  log?: (line: string) => void;
}

export interface RunningDogfoodClient {
  home: {
    port: number;
    url: string;
    process: RunningTunnel["process"];
  };
  service: RunningTunnel;
  stop: () => Promise<void>;
  waitForExit: () => Promise<void>;
}

export type DogfoodClientCliOptions = Pick<
  DogfoodClientOptions,
  "stateDir" | "serviceId" | "localPort" | "testBootstrapPort"
>;

export function parseDogfoodClientCliOptions(
  arguments_: readonly string[],
): DogfoodClientCliOptions {
  const options: DogfoodClientCliOptions = {
    stateDir: path.resolve("tmp", "dogfood", "client"),
    serviceId: "",
    localPort: 0,
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "option";
    const value = takeOptionValue(arguments_, index, option);
    if (option === "--state") {
      options.stateDir = path.resolve(value);
      continue;
    }
    if (option === "--service") {
      options.serviceId = value;
      continue;
    }
    if (option === "--port") {
      options.localPort = parseTcpPort(value, option, true);
      continue;
    }
    if (option === "--test-bootstrap") {
      options.testBootstrapPort = parseTcpPort(value, option);
      continue;
    }
    throw new Error(`unknown dogfood client option: ${option}`);
  }
  if (!options.serviceId) {
    throw new Error("--service is required");
  }
  return options;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRegistryService(value: unknown, index: number): HomeRegistryService {
  if (!isRecord(value)) {
    throw new Error(`Registry service ${index} must be an object`);
  }
  if (
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    (value.kind !== "http" && value.kind !== "tcp") ||
    typeof value.serviceKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.serviceKey)
  ) {
    throw new Error(`Registry service ${index} is invalid`);
  }
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    serviceKey: value.serviceKey,
  };
}

function parseHomeRegistry(value: unknown, expectedHomeKey: string): HomeRegistry {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.revision !== 1) {
    throw new Error("Home Registry version is invalid");
  }
  if (!isRecord(value.publisher) || typeof value.publisher.displayName !== "string") {
    throw new Error("Home Registry publisher is invalid");
  }
  if (!Array.isArray(value.services)) {
    throw new Error("Home Registry services must be an array");
  }
  const services = value.services.map(parseRegistryService);
  const home = services.find((service) => service.id === "home");
  if (!home || home.kind !== "http" || home.serviceKey !== expectedHomeKey) {
    throw new Error("Home Registry does not match the pinned Home key");
  }
  if (new Set(services.map((service) => service.id)).size !== services.length) {
    throw new Error("Home Registry has duplicate service ids");
  }
  return {
    schemaVersion: 1,
    revision: 1,
    publisher: { displayName: value.publisher.displayName },
    services,
  };
}

async function defaultFetchRegistry(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Home Registry request failed with HTTP ${response.status}`);
  }
  return response.json() as Promise<unknown>;
}

export async function startDogfoodClient(
  options: DogfoodClientOptions,
): Promise<RunningDogfoodClient> {
  const stateDir = path.resolve(options.stateDir ?? path.join("tmp", "dogfood", "client"));
  const identityPath = path.join(stateDir, "client.identity.json");
  const contactPath = path.join(stateDir, "publisher.contact.json");
  const identity = parseClientIdentity(
    JSON.parse(await readFile(identityPath, "utf8")) as unknown,
  );
  const contact = parseClientContact(
    JSON.parse(await readFile(contactPath, "utf8")) as unknown,
  );
  const tunnels: RunningTunnel[] = [];
  const spawnClient = async (
    id: string,
    serviceKey: string,
    localPort: number,
  ): Promise<RunningTunnel> => {
    const process = spawnManagedHypertele({
      entrypoint: options.clientEntrypoint ?? resolveHyperteleEntrypoints().client,
      arguments: buildClientArguments({
        identityPath,
        homeKey: serviceKey,
        localPort,
        testBootstrapPort: options.testBootstrapPort,
      }),
      label: `Hypertele client ${id}`,
      parseReady: parseClientReadyLine,
      readinessTimeoutMs: options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
      shutdownTimeoutMs: options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      sensitiveValues: [identity.secretKey, identity.secretKey.slice(0, 64)],
      signal: options.signal,
      log: options.log,
    });
    const tunnel = { id, serviceKey, port: localPort, process };
    tunnels.push(tunnel);
    tunnel.port = await process.ready;
    return tunnel;
  };

  try {
    const home = await spawnClient("home", contact.homeKey, contact.requestedLocalPort);
    const homeUrl = `http://127.0.0.1:${home.port}`;
    const registry = parseHomeRegistry(
      await (options.fetchRegistry ?? defaultFetchRegistry)(
        `${homeUrl}/.well-known/kepos/services.json`,
      ),
      contact.homeKey,
    );
    const service = registry.services.find((entry) => entry.id === options.serviceId);
    if (!service || service.kind !== "tcp") {
      throw new Error(`TCP service not found in Home Registry: ${options.serviceId}`);
    }
    const serviceTunnel = await spawnClient(service.id, service.serviceKey, options.localPort);
    options.log?.(`Local Home ready @${homeUrl}`);
    options.log?.(`Local ${service.name} ready @127.0.0.1:${serviceTunnel.port}`);

    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopPromise ??= stopTunnels(tunnels);
      return stopPromise;
    };
    const waitForExit = async (): Promise<void> => {
      try {
        await Promise.race(tunnels.map((tunnel) => tunnel.process.waitForExit()));
      } finally {
        await stop();
      }
    };
    return {
      home: { port: home.port, url: homeUrl, process: home.process },
      service: serviceTunnel,
      stop,
      waitForExit,
    };
  } catch (error) {
    const cleanup = await Promise.allSettled([stopTunnels(tunnels)]);
    const cleanupErrors = cleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason as unknown);
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "client startup and cleanup failed");
    }
    throw error;
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  const options = parseDogfoodClientCliOptions(process.argv.slice(2));
  startDogfoodClient(options)
    .then((running) => waitForSignal(running.stop, running.waitForExit))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
