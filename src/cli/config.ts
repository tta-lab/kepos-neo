import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { parse } from "smol-toml";

import type { DhtAddress } from "../mux/hyperdht.js";
import { parseBootstrapValues } from "./options.js";

export interface CliConfig {
  network?: {
    bootstrap?: DhtAddress[];
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
  rejectUnknownFields(root, [], ["network"]);
  if (root.network === undefined) return {};

  const network = requireTable(root.network, "network");
  rejectUnknownFields(network, ["network"], ["bootstrap"]);
  if (network.bootstrap === undefined) return { network: {} };
  if (
    !Array.isArray(network.bootstrap) ||
    !network.bootstrap.every((endpoint) => typeof endpoint === "string")
  ) {
    throw new Error("network.bootstrap must be an array of host:port strings");
  }
  return {
    network: {
      bootstrap: parseBootstrapValues(
        network.bootstrap,
        "network.bootstrap",
      ),
    },
  };
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
