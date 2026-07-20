import path from "node:path";
import { pathToFileURL } from "node:url";

import type {
  Observation,
  Observe,
} from "../mux/observability.js";
import {
  startPublisher,
  type PublisherRuntimeStatus,
  type StartPublisherOptions,
} from "../runtime/publisher.js";
import {
  startSubscriber,
  type StartSubscriberOptions,
  type SubscriberRuntimeStatus,
} from "../runtime/subscriber.js";
import {
  setPublisherAllowlist,
  setPublisherServices,
  setupPublisher,
  type SetPublisherAllowlistOptions,
  type SetPublisherServicesOptions,
  type SetupPublisherOptions,
  type SetupPublisherResult,
} from "../state/publisher.js";
import {
  setSubscriberPublisher,
  setupSubscriber,
  type SetSubscriberPublisherOptions,
  type SetupSubscriberOptions,
  type SetupSubscriberResult,
} from "../state/subscriber.js";
import {
  observationMode,
  parseBootstrapOptions,
  parseGatewayPortOption,
  parseOptions,
  parsePublisherService,
  parseRouteOption,
  parseSubscriberService,
  repeatedOption,
  requiredOption,
  requiredState,
} from "./options.js";
import { waitForSignal } from "./signals.js";

interface CliPublisher {
  home: { url: string };
  publisherKey: string;
  status: () => PublisherRuntimeStatus;
  stop: () => Promise<void>;
}

interface CliSubscriber {
  home: { url: string };
  publisherKey: string;
  services: Array<{ id: string; port: number }>;
  status: () => SubscriberRuntimeStatus;
  stop: () => Promise<void>;
}

export interface CliDependencies {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  setupPublisher: (
    options: SetupPublisherOptions,
  ) => Promise<SetupPublisherResult>;
  setupSubscriber: (
    options: SetupSubscriberOptions,
  ) => Promise<SetupSubscriberResult>;
  setSubscriberPublisher: (
    options: SetSubscriberPublisherOptions,
  ) => Promise<string>;
  setPublisherAllowlist: (
    options: SetPublisherAllowlistOptions,
  ) => Promise<void>;
  setPublisherServices: (
    options: SetPublisherServicesOptions,
  ) => Promise<void>;
  startPublisher: (
    options: StartPublisherOptions,
  ) => Promise<CliPublisher>;
  startSubscriber: (
    options: StartSubscriberOptions,
  ) => Promise<CliSubscriber>;
  waitForSignal: (stop: () => Promise<void>) => Promise<void>;
}

export function createDefaultCliDependencies(
  output: Partial<
    Pick<CliDependencies, "stdout" | "stderr">
  > = {},
): CliDependencies {
  return {
    stdout: output.stdout ?? console.log,
    stderr: output.stderr ?? console.error,
    setupPublisher,
    setupSubscriber,
    setSubscriberPublisher,
    setPublisherAllowlist,
    setPublisherServices,
    startPublisher,
    startSubscriber,
    waitForSignal,
  };
}

const defaultDependencies = createDefaultCliDependencies();

export async function runCli(
  arguments_: readonly string[],
  dependencies: CliDependencies = defaultDependencies,
): Promise<void> {
  const [group, action, ...rest] = arguments_;
  if (group === "setup" && action === "publisher") {
    await setupPublisherCommand(rest, dependencies);
    return;
  }
  if (group === "setup" && action === "subscriber") {
    await setupSubscriberCommand(rest, dependencies);
    return;
  }
  if (group === "subscriber" && action === "set-publisher") {
    await setSubscriberPublisherCommand(rest, dependencies);
    return;
  }
  if (group === "publisher" && action === "set-allow") {
    await setPublisherAllowlistCommand(rest, dependencies);
    return;
  }
  if (group === "publisher" && action === "set-services") {
    await setPublisherServicesCommand(rest, dependencies);
    return;
  }
  if (group === "publisher" && action === "run") {
    await runPublisherCommand(rest, dependencies);
    return;
  }
  if (group === "subscriber" && action === "run") {
    await runSubscriberCommand(rest, dependencies);
    return;
  }
  throw new Error(`unknown command: ${arguments_.join(" ") || "(none)"}`);
}

async function setupPublisherCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--display-name",
    "--allow",
    "--service",
  ]);
  const result = await dependencies.setupPublisher({
    stateDir: requiredState(options),
    displayName: requiredOption(options, "--display-name"),
    subscriberPublicKeys: repeatedOption(options, "--allow"),
    services: repeatedOption(options, "--service").map(
      parsePublisherService,
    ),
  });
  dependencies.stdout(`Publisher key: ${result.publisherKey}`);
}

async function setupSubscriberCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, ["--state"]);
  const result = await dependencies.setupSubscriber({
    stateDir: requiredState(options),
  });
  dependencies.stdout(`Subscriber key: ${result.publicKey}`);
}

async function setSubscriberPublisherCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--label",
    "--publisher-key",
  ]);
  await dependencies.setSubscriberPublisher({
    stateDir: requiredState(options),
    label: requiredOption(options, "--label"),
    publisherKey: requiredOption(options, "--publisher-key"),
  });
  dependencies.stdout("Publisher contact updated");
}

async function setPublisherAllowlistCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, ["--state", "--allow"]);
  await dependencies.setPublisherAllowlist({
    stateDir: requiredState(options),
    subscriberPublicKeys: repeatedOption(options, "--allow"),
  });
  dependencies.stdout("Publisher allowlist updated");
}

async function setPublisherServicesCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, ["--state", "--service"]);
  await dependencies.setPublisherServices({
    stateDir: requiredState(options),
    services: repeatedOption(options, "--service").map(
      parsePublisherService,
    ),
  });
  dependencies.stdout("Publisher services updated");
}

async function runPublisherCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--observations",
    "--bootstrap",
  ]);
  const mode = observationMode(options);
  const running = await dependencies.startPublisher({
    stateDir: requiredState(options),
    bootstrap: parseBootstrapOptions(options),
    observe: observationWriter(mode, dependencies),
  });
  statusWriter(mode, dependencies)(
    `Publisher running: key=${running.publisherKey} home=${running.home.url}`,
  );
  await dependencies.waitForSignal(running.stop);
}

async function runSubscriberCommand(
  arguments_: readonly string[],
  dependencies: CliDependencies,
): Promise<void> {
  const options = parseOptions(arguments_, [
    "--state",
    "--service",
    "--gateway-port",
    "--route",
    "--observations",
    "--bootstrap",
  ]);
  const mode = observationMode(options);
  const services = repeatedOption(options, "--service").map(
    parseSubscriberService,
  );
  if (new Set(services.map(({ id }) => id)).size !== services.length) {
    throw new Error("subscriber services must have unique ids");
  }
  const running = await dependencies.startSubscriber({
    stateDir: requiredState(options),
    bootstrap: parseBootstrapOptions(options),
    gatewayPort: parseGatewayPortOption(options),
    services,
    route: parseRouteOption(options),
    observe: observationWriter(mode, dependencies),
  });
  statusWriter(mode, dependencies)(
    `Subscriber running: publisher=${running.publisherKey} home=${running.home.url}`,
  );
  for (const service of running.services) {
    statusWriter(mode, dependencies)(
      `Local service: ${service.id}=127.0.0.1:${service.port}`,
    );
  }
  await dependencies.waitForSignal(running.stop);
}

function observationWriter(
  mode: "human" | "ndjson",
  dependencies: CliDependencies,
): Observe {
  if (mode === "ndjson") {
    return (observation) =>
      dependencies.stdout(JSON.stringify(observation));
  }
  return (observation) =>
    dependencies.stdout(formatObservation(observation));
}

function statusWriter(
  mode: "human" | "ndjson",
  dependencies: CliDependencies,
): (line: string) => void {
  return mode === "ndjson" ? dependencies.stderr : dependencies.stdout;
}

function formatObservation(observation: Observation): string {
  const {
    component: _component,
    event,
    timestamp: _timestamp,
    ...fields
  } = observation;
  const details = Object.entries(fields)
    .map(([key, value]) => `${key}=${formatObservationValue(value)}`)
    .join(" ");
  return `${event}${details ? ` ${details}` : ""}`;
}

function formatObservationValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return String(value);
  }
  return JSON.stringify(value);
}

const invokedPath = process.argv[1];
if (
  invokedPath &&
  import.meta.url === pathToFileURL(path.resolve(invokedPath)).href
) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
