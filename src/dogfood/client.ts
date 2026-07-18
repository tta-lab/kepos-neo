import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  startMuxSubscriber,
  type MuxSubscriberService,
  type RunningMuxSubscriberDaemon,
  type StartMuxSubscriberOptions,
} from "../mux/subscriber.js";
import { parseTcpPort, takeOptionValue, waitForSignal } from "./cli.js";

export interface DogfoodClientOptions
  extends Omit<StartMuxSubscriberOptions, "services"> {
  services: MuxSubscriberService[];
  testBootstrapPort?: number;
}

export interface RunningDogfoodClient
  extends RunningMuxSubscriberDaemon {
  waitForExit: () => Promise<void>;
}

export type DogfoodClientCliOptions = Pick<
  DogfoodClientOptions,
  "stateDir" | "services" | "testBootstrapPort"
>;

function parseLocalService(value: string): MuxSubscriberService {
  const [id, port, ...extra] = value.split(":");
  if (!id || !port || extra.length > 0) {
    throw new Error("--service must use id:local-port");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id) || id === "home") {
    throw new Error("--service id must be a non-reserved lowercase identifier");
  }
  return {
    id,
    localPort: parseTcpPort(port, "--service local port", true),
  };
}

export function parseDogfoodClientCliOptions(
  arguments_: readonly string[],
): DogfoodClientCliOptions {
  const options: DogfoodClientCliOptions = {
    stateDir: path.resolve("tmp", "dogfood", "client"),
    services: [],
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "option";
    const value = takeOptionValue(arguments_, index, option);
    if (option === "--state") {
      options.stateDir = path.resolve(value);
      continue;
    }
    if (option === "--service") {
      options.services.push(parseLocalService(value));
      continue;
    }
    if (option === "--test-bootstrap") {
      options.testBootstrapPort = parseTcpPort(value, option);
      continue;
    }
    throw new Error(`unknown dogfood subscriber option: ${option}`);
  }
  if (new Set(options.services.map(({ id }) => id)).size !== options.services.length) {
    throw new Error("subscriber services must have unique ids");
  }
  return options;
}

export async function startDogfoodClient(
  options: DogfoodClientOptions,
): Promise<RunningDogfoodClient> {
  const running = await startMuxSubscriber({
    stateDir: options.stateDir,
    bootstrap:
      options.bootstrap ??
      (options.testBootstrapPort === undefined
        ? undefined
        : [{ host: "127.0.0.1", port: options.testBootstrapPort }]),
    services: options.services,
    log: options.log,
  });
  return {
    ...running,
    waitForExit: waitForever,
  };
}

async function waitForever(): Promise<void> {
  await new Promise<void>(() => undefined);
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  const options = parseDogfoodClientCliOptions(process.argv.slice(2));
  startDogfoodClient(options)
    .then((running) => waitForSignal(running.stop, running.waitForExit))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
