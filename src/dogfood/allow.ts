import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parsePublisherConfig,
  parsePublisherManifest,
  serializePublisherConfig,
} from "../config.js";
import { takeOptionValue } from "./cli.js";
import {
  readStateJson,
  validateStateDirectory,
  writeStateFileAtomically,
} from "./state.js";

export interface UpdatePublisherAllowlistOptions {
  stateDir: string;
  clientPublicKeys: string[];
}

export async function updatePublisherAllowlist(
  options: UpdatePublisherAllowlistOptions,
): Promise<void> {
  const stateDir = path.resolve(options.stateDir);
  const manifest = parsePublisherManifest(
    await readStateJson(path.join(stateDir, "publisher.manifest.json")),
  );
  const configNames = [
    manifest.homeConfig,
    ...manifest.services.map((service) => service.config),
  ];
  const expectedNames = ["publisher.manifest.json", ...configNames];
  await validateStateDirectory(stateDir, expectedNames);
  const allow = parsePublisherConfig({
    seed: "00".repeat(32),
    allow: options.clientPublicKeys,
  }).allow;

  for (const configName of configNames) {
    const config = parsePublisherConfig(
      await readStateJson(path.join(stateDir, configName)),
    );
    await writeStateFileAtomically(
      stateDir,
      configName,
      serializePublisherConfig({ seed: config.seed, allow }),
    );
  }
  await validateStateDirectory(stateDir, expectedNames);
}

function parseAllowCliOptions(arguments_: readonly string[]): UpdatePublisherAllowlistOptions {
  const options: UpdatePublisherAllowlistOptions = {
    stateDir: path.resolve("tmp", "dogfood", "publisher"),
    clientPublicKeys: [],
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "option";
    const value = takeOptionValue(arguments_, index, option);
    if (option === "--state") {
      options.stateDir = path.resolve(value);
      continue;
    }
    if (option === "--allow") {
      options.clientPublicKeys.push(value);
      continue;
    }
    throw new Error(`unknown publisher allowlist option: ${option}`);
  }
  return options;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  updatePublisherAllowlist(parseAllowCliOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
