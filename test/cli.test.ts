import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  runCli,
  type CliDependencies,
} from "../src/cli/main.js";
import { waitForSignal } from "../src/cli/signals.js";
import type { Observation } from "../src/mux/observability.js";

interface Calls {
  setupPublisher: unknown[];
  setupSubscriber: unknown[];
  setSubscriberPublisher: unknown[];
  setPublisherAllowlist: unknown[];
  setPublisherServices: unknown[];
  startPublisher: unknown[];
  startSubscriber: unknown[];
  stopped: string[];
}

function fakeCli(): {
  calls: Calls;
  dependencies: CliDependencies;
  stderr: string[];
  stdout: string[];
} {
  const calls: Calls = {
    setupPublisher: [],
    setupSubscriber: [],
    setSubscriberPublisher: [],
    setPublisherAllowlist: [],
    setPublisherServices: [],
    startPublisher: [],
    startSubscriber: [],
    stopped: [],
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: CliDependencies = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
    setupPublisher: async (options) => {
      calls.setupPublisher.push(options);
      return { created: true, publisherKey: "11".repeat(32) };
    },
    setupSubscriber: async (options) => {
      calls.setupSubscriber.push(options);
      return { created: true, publicKey: "22".repeat(32) };
    },
    setSubscriberPublisher: async (options) => {
      calls.setSubscriberPublisher.push(options);
      return path.join(options.stateDir, "publisher.contact.json");
    },
    setPublisherAllowlist: async (options) => {
      calls.setPublisherAllowlist.push(options);
    },
    setPublisherServices: async (options) => {
      calls.setPublisherServices.push(options);
    },
    startPublisher: async (options) => {
      calls.startPublisher.push(options);
      options.observe?.({
        component: "kepos",
        timestamp: new Date(0).toISOString(),
        elapsedMs: 0,
        event: "outer.connected",
        role: "publisher",
        outerId: "outer-pub",
        attempt: 2,
      });
      return {
        publisherKey: "11".repeat(32),
        home: { url: "http://127.0.0.1:3000" },
        status: () => ({
          role: "publisher" as const,
          state: "running" as const,
          publisherKey: "11".repeat(32),
          homeUrl: "http://127.0.0.1:3000",
          acceptedConnections: 1,
          activeSubscribers: 1,
        }),
        stop: async () => {
          calls.stopped.push("publisher");
        },
      };
    },
    startSubscriber: async (options) => {
      calls.startSubscriber.push(options);
      options.observe?.({
        component: "kepos",
        timestamp: new Date(0).toISOString(),
        elapsedMs: 0,
        event: "outer.connected",
        role: "subscriber",
        route: options.route,
        outerId: "outer-sub",
      } satisfies Observation);
      return {
        publisherKey: "11".repeat(32),
        home: { url: "http://127.0.0.1:4000" },
        services: options.services.map(({ id, localPort }) => ({
          id,
          port: localPort,
        })),
        status: () => ({
          role: "subscriber" as const,
          state: "running" as const,
          connection: "connected" as const,
          publisherKey: "11".repeat(32),
          homeUrl: "http://127.0.0.1:4000",
          services: options.services.map(({ id, localPort }) => ({
            id,
            port: localPort,
          })),
        }),
        stop: async () => {
          calls.stopped.push("subscriber");
        },
      };
    },
    waitForSignal: async (stop) => {
      await stop();
    },
  };
  return { calls, dependencies, stderr, stdout };
}

test("setup publisher parses deny-all state and service targets", async () => {
  const cli = fakeCli();
  await runCli(
    [
      "setup",
      "publisher",
      "--state",
      "./publisher",
      "--display-name",
      "kosmos",
      "--service",
      "ssh:SSH:22",
    ],
    cli.dependencies,
  );

  assert.deepEqual(cli.calls.setupPublisher, [
    {
      stateDir: path.resolve("./publisher"),
      displayName: "kosmos",
      subscriberPublicKeys: [],
      services: [{ id: "ssh", name: "SSH", targetPort: 22 }],
    },
  ]);
  assert.deepEqual(cli.stdout, [`Publisher key: ${"11".repeat(32)}`]);
  assert.equal(cli.stdout.join("\n").includes("seed"), false);
});

test("setup subscriber and set-publisher expose only public state", async () => {
  const cli = fakeCli();
  await runCli(
    ["setup", "subscriber", "--state", "./subscriber"],
    cli.dependencies,
  );
  await runCli(
    [
      "subscriber",
      "set-publisher",
      "--state",
      "./subscriber",
      "--label",
      "kosmos",
      "--publisher-key",
      "11".repeat(32),
    ],
    cli.dependencies,
  );

  assert.deepEqual(cli.calls.setupSubscriber, [
    { stateDir: path.resolve("./subscriber") },
  ]);
  assert.deepEqual(cli.calls.setSubscriberPublisher, [
    {
      stateDir: path.resolve("./subscriber"),
      label: "kosmos",
      publisherKey: "11".repeat(32),
    },
  ]);
  assert.equal(cli.stdout[0], `Subscriber key: ${"22".repeat(32)}`);
});

test("publisher set commands replace allowlist and services", async () => {
  const cli = fakeCli();
  await runCli(
    ["publisher", "set-allow", "--state", "./publisher"],
    cli.dependencies,
  );
  await runCli(
    [
      "publisher",
      "set-services",
      "--state",
      "./publisher",
      "--service",
      "navidrome:Navidrome:4533",
    ],
    cli.dependencies,
  );

  assert.deepEqual(cli.calls.setPublisherAllowlist, [
    {
      stateDir: path.resolve("./publisher"),
      subscriberPublicKeys: [],
    },
  ]);
  assert.deepEqual(cli.calls.setPublisherServices, [
    {
      stateDir: path.resolve("./publisher"),
      services: [
        { id: "navidrome", name: "Navidrome", targetPort: 4533 },
      ],
    },
  ]);
});

test("publisher run prints human status and awaits signal-safe stop", async () => {
  const cli = fakeCli();
  await runCli(
    [
      "publisher",
      "run",
      "--state",
      "./publisher",
      "--bootstrap",
      "47.94.213.63:49737",
      "--bootstrap",
      "203.91.75.19:49738",
    ],
    cli.dependencies,
  );

  assert.equal(cli.calls.startPublisher.length, 1);
  const [options] = cli.calls.startPublisher as Array<{
    stateDir: string;
    bootstrap: Array<{ host: string; port: number }>;
  }>;
  assert.equal(options.stateDir, path.resolve("./publisher"));
  assert.deepEqual(options.bootstrap, [
    { host: "47.94.213.63", port: 49737 },
    { host: "203.91.75.19", port: 49738 },
  ]);
  assert.deepEqual(cli.calls.stopped, ["publisher"]);
  assert.match(cli.stdout.join("\n"), /Publisher running/);
  assert.match(cli.stdout.join("\n"), /outer\.connected/);
  assert.match(cli.stdout.join("\n"), /attempt=2/);
});

test("subscriber run maps services and writes NDJSON observations", async () => {
  const cli = fakeCli();
  await runCli(
    [
      "subscriber",
      "run",
      "--state",
      "./subscriber",
      "--service",
      "ssh:2222",
      "--gateway-port",
      "18080",
      "--route",
      "public",
      "--bootstrap",
      "34.143.181.65:49738",
      "--observations",
      "ndjson",
    ],
    cli.dependencies,
  );

  const [options] = cli.calls.startSubscriber as Array<{
    stateDir: string;
    services: Array<{ id: string; localPort: number }>;
    gatewayPort: number;
    route: string;
    bootstrap: Array<{ host: string; port: number }>;
  }>;
  assert.equal(options.stateDir, path.resolve("./subscriber"));
  assert.deepEqual(options.services, [{ id: "ssh", localPort: 2222 }]);
  assert.equal(options.gatewayPort, 18_080);
  assert.equal(options.route, "public");
  assert.deepEqual(options.bootstrap, [
    { host: "34.143.181.65", port: 49738 },
  ]);
  assert.deepEqual(cli.calls.stopped, ["subscriber"]);
  assert.equal(cli.stdout.length, 1);
  assert.equal(JSON.parse(cli.stdout[0] ?? "").event, "outer.connected");
  assert.match(cli.stderr.join("\n"), /Subscriber running/);
});

test("run commands reject malformed bootstrap endpoints", async () => {
  const cli = fakeCli();

  await assert.rejects(
    () =>
      runCli(
        [
          "subscriber",
          "run",
          "--state",
          "./subscriber",
          "--bootstrap",
          "47.94.213.63",
        ],
        cli.dependencies,
      ),
    /bootstrap.*host:port/i,
  );
  await assert.rejects(
    () =>
      runCli(
        [
          "publisher",
          "run",
          "--state",
          "./publisher",
          "--bootstrap",
          "47.94.213.63:70000",
        ],
        cli.dependencies,
      ),
    /bootstrap.*port/i,
  );
});

test("canonical commands require explicit state and reject standalone status", async () => {
  const cli = fakeCli();
  await assert.rejects(
    () => runCli(["setup", "subscriber"], cli.dependencies),
    /--state is required/,
  );
  await assert.rejects(
    () => runCli(["status"], cli.dependencies),
    /unknown command|usage/i,
  );
});

test("empty arguments and help print CLI usage", async () => {
  const empty = fakeCli();
  const help = fakeCli();

  await runCli([], empty.dependencies);
  await runCli(["--help"], help.dependencies);

  assert.match(empty.stdout.join("\n"), /usage: kepos/i);
  assert.equal(help.stdout.join("\n"), empty.stdout.join("\n"));
});

test("partial commands report valid CLI usage", async () => {
  const cli = fakeCli();

  await assert.rejects(
    () => runCli(["publisher"], cli.dependencies),
    /unknown command: publisher[\s\S]*usage: kepos/i,
  );
});

test("signal wait removes handlers after one awaited stop", async () => {
  const beforeInt = process.listenerCount("SIGINT");
  const beforeTerm = process.listenerCount("SIGTERM");
  let stopped = 0;
  const waiting = waitForSignal(async () => {
    stopped++;
  });

  process.emit("SIGTERM", "SIGTERM");
  await waiting;

  assert.equal(stopped, 1);
  assert.equal(process.listenerCount("SIGINT"), beforeInt);
  assert.equal(process.listenerCount("SIGTERM"), beforeTerm);
});
