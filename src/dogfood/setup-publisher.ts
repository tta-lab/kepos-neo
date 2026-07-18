import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parsePublisherConfig,
  parsePublisherManifest,
  serializePublisherConfig,
  serializePublisherManifest,
  type PublisherManifest,
  type PublisherService,
} from "../config.js";
import { derivePublisherHomeKey, generatePublisherSeed } from "../keys.js";
import {
  pathExists,
  readStateJson,
  validateStateDirectory,
  writeStateDirectoryAtomically,
} from "../state/files.js";
import { parseTcpPort, takeOptionValue } from "./cli.js";

const manifestFileName = "publisher.manifest.json";

export interface SetupPublisherService {
  id: string;
  name: string;
  targetPort: number;
}

export interface SetupPublisherOptions {
  stateDir?: string;
  displayName: string;
  clientPublicKeys: string[];
  services: SetupPublisherService[];
  log?: (line: string) => void;
}

export interface SetupPublisherResult {
  created: boolean;
  publisherKey: string;
}

export type SetupPublisherCliOptions = Omit<SetupPublisherOptions, "log">;

function parseService(value: string): SetupPublisherService {
  const [id, name, port, ...extra] = value.split(":");
  if (!id || !name || !port || extra.length > 0) {
    throw new Error("--service must use id:name:port");
  }
  return { id, name, targetPort: parseTcpPort(port, "--service port") };
}

export function parseSetupPublisherCliOptions(
  arguments_: readonly string[],
): SetupPublisherCliOptions {
  const options: SetupPublisherCliOptions = {
    stateDir: path.resolve("tmp", "dogfood", "publisher"),
    displayName: "",
    clientPublicKeys: [],
    services: [],
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "option";
    const value = takeOptionValue(arguments_, index, option);
    if (option === "--state") {
      options.stateDir = path.resolve(value);
      continue;
    }
    if (option === "--display-name") {
      options.displayName = value;
      continue;
    }
    if (option === "--allow") {
      options.clientPublicKeys.push(value);
      continue;
    }
    if (option === "--service") {
      options.services.push(parseService(value));
      continue;
    }
    throw new Error(`unknown setup publisher option: ${option}`);
  }
  if (!options.displayName) {
    throw new Error("--display-name is required");
  }
  if (options.clientPublicKeys.length === 0) {
    throw new Error("at least one --allow client public key is required");
  }
  return options;
}

function createManifest(options: SetupPublisherOptions): PublisherManifest {
  return parsePublisherManifest({
    displayName: options.displayName,
    publisherConfig: "publisher.json",
    services: options.services.map(
      (service): PublisherService => ({
        ...service,
        kind: "tcp",
      }),
    ),
  });
}

function expectedNames(manifest: PublisherManifest): string[] {
  return [manifestFileName, manifest.publisherConfig];
}

async function readPublisherResult(
  stateDir: string,
  expectedManifest: PublisherManifest,
  expectedAllow: readonly string[],
  created: boolean,
): Promise<SetupPublisherResult> {
  const storedManifest = parsePublisherManifest(
    await readStateJson(path.join(stateDir, manifestFileName)),
  );
  await validateStateDirectory(stateDir, expectedNames(storedManifest));
  if (serializePublisherManifest(storedManifest) !== serializePublisherManifest(expectedManifest)) {
    throw new Error("existing publisher manifest does not match requested topology");
  }

  const publisher = parsePublisherConfig(
    await readStateJson(path.join(stateDir, storedManifest.publisherConfig)),
  );
  if (
    publisher.allow.length !== expectedAllow.length ||
    publisher.allow.some((key, index) => key !== expectedAllow[index])
  ) {
    throw new Error("existing publisher allowlist does not match requested subscribers");
  }

  return {
    created,
    publisherKey: derivePublisherHomeKey(publisher.seed),
  };
}

export async function setupPublisher(
  options: SetupPublisherOptions,
): Promise<SetupPublisherResult> {
  const stateDir = path.resolve(options.stateDir ?? path.join("tmp", "dogfood", "publisher"));
  const log = options.log ?? console.log;
  const manifest = createManifest(options);
  const allow = parsePublisherConfig({
    seed: "00".repeat(32),
    allow: options.clientPublicKeys,
  }).allow;

  let result: SetupPublisherResult;
  if (await pathExists(stateDir)) {
    result = await readPublisherResult(stateDir, manifest, allow, false);
  } else {
    const files = new Map<string, string>([
      [manifestFileName, serializePublisherManifest(manifest)],
      [
        manifest.publisherConfig,
        serializePublisherConfig({ seed: generatePublisherSeed(), allow }),
      ],
    ]);
    await writeStateDirectoryAtomically(stateDir, files);
    result = await readPublisherResult(stateDir, manifest, allow, true);
  }

  log(`Publisher public key: ${result.publisherKey}`);
  return result;
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  setupPublisher(parseSetupPublisherCliOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
