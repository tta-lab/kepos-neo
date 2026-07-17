import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseClientContact,
  serializeClientContact,
  type ClientContact,
} from "../config.js";
import {
  generateClientIdentity,
  parseClientIdentity,
  serializeClientIdentity,
} from "../keys.js";
import {
  pathExists,
  readStateJson,
  validateStateDirectory,
  writeStateDirectoryAtomically,
  writeStateFileAtomically,
} from "./state.js";
import { takeOptionValue } from "./cli.js";

const identityFileName = "client.identity.json";
const contactFileName = "publisher.contact.json";

export interface SetupClientOptions {
  stateDir?: string;
  log?: (line: string) => void;
}

export interface SetupClientResult {
  created: boolean;
  publicKey: string;
}

export interface WritePublisherContactOptions {
  stateDir?: string;
  label: string;
  homeKey: string;
}

export interface SetupClientCliOptions {
  stateDir: string;
}

export function parseSetupClientCliOptions(arguments_: readonly string[]): SetupClientCliOptions {
  let stateDir = path.resolve("tmp", "dogfood", "client");
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "option";
    const value = takeOptionValue(arguments_, index, option);
    if (option !== "--state") {
      throw new Error(`unknown setup client option: ${option}`);
    }
    stateDir = path.resolve(value);
  }
  return { stateDir };
}

async function readClientIdentity(stateDir: string) {
  const names = (await pathExists(path.join(stateDir, contactFileName)))
    ? [identityFileName, contactFileName]
    : [identityFileName];
  await validateStateDirectory(stateDir, names);
  return parseClientIdentity(await readStateJson(path.join(stateDir, identityFileName)));
}

export async function setupClient(options: SetupClientOptions = {}): Promise<SetupClientResult> {
  const stateDir = path.resolve(options.stateDir ?? path.join("tmp", "dogfood", "client"));
  const log = options.log ?? console.log;

  if (await pathExists(stateDir)) {
    const identity = await readClientIdentity(stateDir);
    log(`Client public key: ${identity.publicKey}`);
    return { created: false, publicKey: identity.publicKey };
  }

  const identity = generateClientIdentity();
  await writeStateDirectoryAtomically(
    stateDir,
    new Map([[identityFileName, serializeClientIdentity(identity)]]),
  );
  log(`Client public key: ${identity.publicKey}`);
  return { created: true, publicKey: identity.publicKey };
}

export async function writePublisherContact(
  options: WritePublisherContactOptions,
): Promise<string> {
  const stateDir = path.resolve(options.stateDir ?? path.join("tmp", "dogfood", "client"));
  await readClientIdentity(stateDir);
  const contact: ClientContact = parseClientContact({
    homeKey: options.homeKey,
    label: options.label,
    requestedLocalPort: 0,
  });
  return writeStateFileAtomically(
    stateDir,
    contactFileName,
    serializeClientContact(contact),
  );
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  setupClient(parseSetupClientCliOptions(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
