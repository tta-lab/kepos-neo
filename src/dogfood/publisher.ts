import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  startMuxPublisher,
  type RunningMuxPublisherDaemon,
  type StartMuxPublisherOptions,
} from "../mux/publisher.js";
import { parseTcpPort, takeOptionValue, waitForSignal } from "./cli.js";

export interface DogfoodPublisherOptions extends StartMuxPublisherOptions {
  testBootstrapPort?: number;
}

export interface RunningDogfoodPublisher
  extends RunningMuxPublisherDaemon {
  waitForExit: () => Promise<void>;
}

export type DogfoodPublisherCliOptions = Pick<
  DogfoodPublisherOptions,
  "stateDir" | "testBootstrapPort"
>;

export function parseDogfoodPublisherCliOptions(
  arguments_: readonly string[],
): DogfoodPublisherCliOptions {
  const options: DogfoodPublisherCliOptions = {
    stateDir: path.resolve("tmp", "dogfood", "publisher"),
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "option";
    const value = takeOptionValue(arguments_, index, option);
    if (option === "--state") {
      options.stateDir = path.resolve(value);
      continue;
    }
    if (option === "--test-bootstrap") {
      options.testBootstrapPort = parseTcpPort(value, option);
      continue;
    }
    throw new Error(`unknown dogfood publisher option: ${option}`);
  }
  return options;
}

export async function startDogfoodPublisher(
  options: DogfoodPublisherOptions = {},
): Promise<RunningDogfoodPublisher> {
  const running = await startMuxPublisher({
    stateDir: options.stateDir,
    bootstrap:
      options.bootstrap ??
      (options.testBootstrapPort === undefined
        ? undefined
        : [{ host: "127.0.0.1", port: options.testBootstrapPort }]),
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
  const options = parseDogfoodPublisherCliOptions(process.argv.slice(2));
  startDogfoodPublisher(options)
    .then((running) => waitForSignal(running.stop, running.waitForExit))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
