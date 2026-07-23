import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";

import {
  parsePublisherConfig,
  parsePublisherManifest,
} from "../config.js";
import type { DhtAddress } from "../mux/hyperdht.js";
import { parseRoute, type Route } from "../mux/route.js";
import type { PublisherRuntimePolicy } from "../runtime/publisher.js";
import type { SubscriberService } from "../runtime/subscriber.js";
import {
  parseBootstrapValues,
  parseSubscriberService,
} from "./options.js";

export interface CliConfig {
  network?: {
    bootstrap?: DhtAddress[];
  };
  publisher?: PublisherRuntimePolicy;
  subscriber?: {
    gatewayPort?: number;
    route?: Route;
    services?: SubscriberService[];
  };
}

export function defaultCliConfigPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): string {
  const configHome =
    environment.XDG_CONFIG_HOME || path.join(homeDirectory, ".config");
  return path.join(configHome, "kepos", "config.toml");
}

export async function loadCliConfig(
  configPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<CliConfig | undefined> {
  const resolvedPath = configPath ?? defaultCliConfigPath(environment);
  let source: string;
  try {
    source = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (
      configPath === undefined &&
      error instanceof Error &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw new Error(`Cannot read Kepos config: ${resolvedPath}`, {
      cause: error,
    });
  }
  return parseCliConfig(source);
}

export function parseCliConfig(source: string): CliConfig {
  const value: unknown = parse(source);
  const root = requireTable(value, "config");
  rejectUnknownFields(root, [], ["network", "publisher", "subscriber"]);

  const config: CliConfig = {};
  if (root.network !== undefined) config.network = parseNetwork(root.network);
  if (root.publisher !== undefined) {
    config.publisher = parsePublisher(root.publisher);
  }
  if (root.subscriber !== undefined) {
    config.subscriber = parseSubscriber(root.subscriber);
  }
  return config;
}

function parseNetwork(value: unknown): NonNullable<CliConfig["network"]> {
  const network = requireTable(value, "network");
  rejectUnknownFields(network, ["network"], ["bootstrap"]);
  if (network.bootstrap === undefined) return {};
  if (
    !Array.isArray(network.bootstrap) ||
    !network.bootstrap.every((endpoint) => typeof endpoint === "string")
  ) {
    throw new Error("network.bootstrap must be an array of host:port strings");
  }
  if (network.bootstrap.length === 0) return {};
  return {
    bootstrap: parseBootstrapValues(network.bootstrap, "network.bootstrap"),
  };
}

function parsePublisher(value: unknown): PublisherRuntimePolicy {
  const publisher = requireTable(value, "publisher");
  rejectUnknownFields(
    publisher,
    ["publisher"],
    ["display_name", "allow", "services"],
  );
  if (!Array.isArray(publisher.allow)) {
    throw new Error("publisher.allow must be an array");
  }
  if (!Array.isArray(publisher.services)) {
    throw new Error("publisher.services must be an array");
  }

  const services = publisher.services.map((value, index) => {
    const service = requireTable(value, `publisher.services[${index}]`);
    rejectUnknownFields(
      service,
      ["publisher", `services[${index}]`],
      ["id", "name", "target_port"],
    );
    return {
      id: service.id,
      name: service.name,
      kind: "tcp",
      targetPort: service.target_port,
    };
  });
  const manifest = parsePublisherManifest({
    displayName: publisher.display_name,
    publisherConfig: "publisher.json",
    services,
  });
  const allow = parsePublisherConfig({
    seed: "00".repeat(32),
    allow: publisher.allow,
  }).allow;
  return {
    displayName: manifest.displayName,
    allow,
    services: manifest.services.map(({ id, name, targetPort }) => ({
      id,
      name,
      targetPort,
    })),
  };
}

function parseSubscriber(
  value: unknown,
): NonNullable<CliConfig["subscriber"]> {
  const subscriber = requireTable(value, "subscriber");
  rejectUnknownFields(
    subscriber,
    ["subscriber"],
    ["gateway_port", "route", "services"],
  );
  const config: NonNullable<CliConfig["subscriber"]> = {};
  if (subscriber.gateway_port !== undefined) {
    config.gatewayPort = parsePort(
      subscriber.gateway_port,
      "subscriber.gateway_port",
    );
  }
  if (subscriber.route !== undefined) {
    if (typeof subscriber.route !== "string") {
      throw new Error("subscriber.route must be auto or public");
    }
    config.route = parseRoute(subscriber.route);
  }
  if (subscriber.services !== undefined) {
    if (!Array.isArray(subscriber.services)) {
      throw new Error("subscriber.services must be an array");
    }
    config.services = subscriber.services.map((value, index) => {
      const service = requireTable(value, `subscriber.services[${index}]`);
      rejectUnknownFields(
        service,
        ["subscriber", `services[${index}]`],
        ["id", "local_port"],
      );
      if (typeof service.id !== "string") {
        throw new Error(`subscriber.services[${index}].id must be a string`);
      }
      const localPort = parsePort(
        service.local_port,
        `subscriber.services[${index}].local_port`,
        true,
      );
      return parseSubscriberService(`${service.id}:${localPort}`);
    });
    if (
      new Set(config.services.map(({ id }) => id)).size !==
      config.services.length
    ) {
      throw new Error("subscriber services must have unique ids");
    }
  }
  return config;
}

function parsePort(value: unknown, field: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    value > 65_535
  ) {
    throw new Error(
      `${field} must be an integer from ${minimum} through 65535`,
    );
  }
  return value;
}

function requireTable(
  value: unknown,
  name: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a TOML table`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  pathParts: string[],
  allowed: readonly string[],
): void {
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).find((field) => !allowedFields.has(field));
  if (!unknown) return;
  throw new Error(`unknown field: ${[...pathParts, unknown].join(".")}`);
}
