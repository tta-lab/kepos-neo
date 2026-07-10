import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  parseClientContact,
  parsePublisherConfig,
  serializeClientContact,
  serializePublisherConfig,
  type ClientContact,
  type PublisherConfig,
} from "../config.js";
import {
  derivePublisherHomeKey,
  generateClientIdentity,
  generatePublisherSeed,
  parseClientIdentity,
  serializeClientIdentity,
  type ClientIdentity,
} from "../keys.js";

export interface P0State {
  publisher: PublisherConfig;
  clientAIdentity: ClientIdentity;
  clientBIdentity: ClientIdentity;
  clientAContact: ClientContact;
  clientBContact: ClientContact;
}

export interface SetupP0Options {
  stateDir?: string;
  log?: (line: string) => void;
}

export interface SetupP0Result {
  created: boolean;
  homeKey: string;
}

const fileNames = {
  publisher: "publisher.json",
  clientAIdentity: "client-a.identity.json",
  clientBIdentity: "client-b.identity.json",
  clientAContact: "client-a.contact.json",
  clientBContact: "client-b.contact.json",
} as const;

const expectedFileNames = Object.values(fileNames).sort();

function validateState(state: P0State): P0State {
  const publisher = parsePublisherConfig(state.publisher);
  const clientAIdentity = parseClientIdentity(state.clientAIdentity);
  const clientBIdentity = parseClientIdentity(state.clientBIdentity);
  const clientAContact = parseClientContact(state.clientAContact);
  const clientBContact = parseClientContact(state.clientBContact);
  const homeKey = derivePublisherHomeKey(publisher.seed);

  if (clientAIdentity.publicKey === clientBIdentity.publicKey) {
    throw new Error("client A and client B identities must be distinct");
  }
  if (clientAContact.homeKey !== homeKey || clientBContact.homeKey !== homeKey) {
    throw new Error("client contact homeKey does not match the publisher seed");
  }

  return { publisher, clientAIdentity, clientBIdentity, clientAContact, clientBContact };
}

async function validateStateFiles(stateDir: string): Promise<void> {
  const directory = await lstat(stateDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(`P0 state path must be a regular directory: ${stateDir}`);
  }
  if (process.platform !== "win32" && (directory.mode & 0o777) !== 0o700) {
    throw new Error(`P0 state directory must have owner-only permissions: ${stateDir}`);
  }

  for (const name of expectedFileNames) {
    const filePath = path.join(stateDir, name);
    const file = await lstat(filePath);
    if (!file.isFile() || file.isSymbolicLink()) {
      throw new Error(`P0 state entry must be a regular file: ${filePath}`);
    }
    if (process.platform !== "win32" && (file.mode & 0o777) !== 0o600) {
      throw new Error(`P0 state file must have owner-only permissions: ${filePath}`);
    }
  }
}

async function readJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`invalid P0 state file ${filePath}`, { cause: error });
  }
}

async function readP0State(stateDir: string): Promise<P0State> {
  await validateStateFiles(stateDir);
  const names = (await readdir(stateDir)).sort();
  if (
    names.length !== expectedFileNames.length ||
    names.some((name, index) => name !== expectedFileNames[index])
  ) {
    throw new Error(`partial or invalid P0 state in ${stateDir}`);
  }

  return validateState({
    publisher: (await readJson(path.join(stateDir, fileNames.publisher))) as PublisherConfig,
    clientAIdentity: (await readJson(
      path.join(stateDir, fileNames.clientAIdentity),
    )) as ClientIdentity,
    clientBIdentity: (await readJson(
      path.join(stateDir, fileNames.clientBIdentity),
    )) as ClientIdentity,
    clientAContact: (await readJson(path.join(stateDir, fileNames.clientAContact))) as ClientContact,
    clientBContact: (await readJson(path.join(stateDir, fileNames.clientBContact))) as ClientContact,
  });
}

async function writeStateFiles(directory: string, state: P0State): Promise<void> {
  await writeFile(
    path.join(directory, fileNames.publisher),
    serializePublisherConfig(state.publisher),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, fileNames.clientAIdentity),
    serializeClientIdentity(state.clientAIdentity),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, fileNames.clientBIdentity),
    serializeClientIdentity(state.clientBIdentity),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, fileNames.clientAContact),
    serializeClientContact(state.clientAContact),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, fileNames.clientBContact),
    serializeClientContact(state.clientBContact),
    { mode: 0o600 },
  );
}

export async function writeP0StateAtomically(stateDir: string, state: P0State): Promise<void> {
  const validState = validateState(state);
  const parentDir = path.dirname(stateDir);
  await mkdir(parentDir, { recursive: true, mode: 0o700 });
  const temporaryDir = await mkdtemp(`${stateDir}.tmp-`);
  await chmod(temporaryDir, 0o700);

  try {
    await writeStateFiles(temporaryDir, validState);
    await readP0State(temporaryDir);
    await rename(temporaryDir, stateDir);
  } catch (error) {
    await rm(temporaryDir, { recursive: true, force: true });
    throw error;
  }
}

function createInitialState(): P0State {
  const publisherSeed = generatePublisherSeed();
  const homeKey = derivePublisherHomeKey(publisherSeed);
  const clientAIdentity = generateClientIdentity();
  const clientBIdentity = generateClientIdentity();
  const contact = {
    homeKey,
    label: "Local Publisher",
    requestedLocalPort: 0,
  };

  return {
    publisher: { seed: publisherSeed, allow: [clientAIdentity.publicKey] },
    clientAIdentity,
    clientBIdentity,
    clientAContact: contact,
    clientBContact: contact,
  };
}

function logState(stateDir: string, state: P0State, log: (line: string) => void): void {
  const homeKey = derivePublisherHomeKey(state.publisher.seed);
  log(`P0 state: ${stateDir}`);
  log(`Home public key: ${homeKey}`);
  log(`Client A public key: ${state.clientAIdentity.publicKey}`);
  log(`Client B public key: ${state.clientBIdentity.publicKey}`);
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function setupP0(options: SetupP0Options = {}): Promise<SetupP0Result> {
  const stateDir = path.resolve(options.stateDir ?? path.join("tmp", "p0"));
  const log = options.log ?? console.log;

  if (await directoryExists(stateDir)) {
    const state = await readP0State(stateDir);
    logState(stateDir, state, log);
    return { created: false, homeKey: derivePublisherHomeKey(state.publisher.seed) };
  }

  const state = createInitialState();
  await writeP0StateAtomically(stateDir, state);
  logState(stateDir, state, log);
  return { created: true, homeKey: derivePublisherHomeKey(state.publisher.seed) };
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  setupP0().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
