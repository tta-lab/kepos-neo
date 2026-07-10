import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { serializeClientContact, serializePublisherConfig } from "../src/config.js";
import {
  derivePublisherHomeKey,
  generateClientIdentity,
  generatePublisherSeed,
  serializeClientIdentity,
} from "../src/keys.js";

const execFileAsync = promisify(execFile);
const safeFixtureArguments = ["--address", "127.0.0.1"];

async function loadProcessModule() {
  const subject = await import("../src/p0/hypertele-process.js").catch(() => undefined);
  assert.ok(subject, "Task 4 Hypertele process supervision is not implemented");
  return subject;
}

async function loadPublisherModule() {
  const subject = await import("../src/p0/publisher.js").catch(() => undefined);
  assert.ok(subject, "Task 4 publisher supervision is not implemented");
  return subject;
}

async function loadClientModule() {
  const subject = await import("../src/p0/client.js").catch(() => undefined);
  assert.ok(subject, "Task 4 client supervision is not implemented");
  return subject;
}

async function makeFixtureScript(source: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-process-test-"));
  const scriptPath = path.join(directory, "fixture.cjs");
  await writeFile(scriptPath, source);
  return scriptPath;
}

function gracefulFixture(readyLine: string, delayMs = 0): string {
  return `
process.on("SIGTERM", () => process.exit(130));
setTimeout(() => console.log(${JSON.stringify(readyLine)}), ${delayMs});
setInterval(() => {}, 1000);
`;
}

async function waitForFile(filePath: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

async function waitForProcessExit(pid: number, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 10));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        return;
      }
      throw error;
    }
  }
  throw new Error(`timed out waiting for process ${pid} to exit`);
}

test("resolves the installed Hypertele server and client subpaths", async () => {
  const { resolveHyperteleEntrypoints } = await loadProcessModule();
  const entrypoints = resolveHyperteleEntrypoints();

  assert.equal(path.basename(entrypoints.server), "server.js");
  assert.equal(path.basename(entrypoints.client), "client.js");
  assert.match(entrypoints.server, /hypertele/);
  assert.match(entrypoints.client, /hypertele/);
});

test("builds a loopback-only publisher command with an explicit test bootstrap", async () => {
  const { buildPublisherArguments } = await loadProcessModule();

  assert.deepEqual(
    buildPublisherArguments({ targetPort: 43123, configPath: "/tmp/publisher.json", testBootstrapPort: 49737 }),
    [
      "-l",
      "43123",
      "--address",
      "127.0.0.1",
      "-c",
      "/tmp/publisher.json",
      "--bootstrap",
      "49737",
    ],
  );
});

test("builds a client command that always requests an ephemeral loopback port", async () => {
  const { buildClientArguments } = await loadProcessModule();
  const homeKey = "11".repeat(32);

  assert.deepEqual(
    buildClientArguments({ identityPath: "/tmp/client.json", homeKey }),
    ["-p", "0", "--address", "127.0.0.1", "-i", "/tmp/client.json", "-s", homeKey],
  );
});

test("rejects non-loopback and forbidden Hypertele arguments", async () => {
  const { validateHyperteleArguments } = await loadProcessModule();

  for (const args of [
    ["--address", "0.0.0.0"],
    ["--address", "127.0.0.1", "--seed", "aa".repeat(32)],
    ["--private"],
    ["--compress"],
    ["--cert-skip"],
  ]) {
    assert.throws(() => validateHyperteleArguments(args), /forbidden|loopback/i);
  }
});

test("parses publisher readiness and requires the expected Home key", async () => {
  const { parsePublisherReadyLine } = await loadProcessModule();
  const homeKey = "12".repeat(32);

  assert.equal(parsePublisherReadyLine("unrelated output", homeKey), undefined);
  assert.equal(parsePublisherReadyLine(`hypertele: ${homeKey}`, homeKey), homeKey);
  assert.throws(() => parsePublisherReadyLine(`hypertele: ${"34".repeat(32)}`, homeKey), /Home key/i);
});

test("parses the actual ephemeral port from client readiness", async () => {
  const { parseClientReadyLine } = await loadProcessModule();

  assert.equal(parseClientReadyLine("unrelated output"), undefined);
  assert.equal(parseClientReadyLine("Server ready @127.0.0.1:43123"), 43123);
  assert.throws(() => parseClientReadyLine("Server ready @0.0.0.0:43123"), /loopback/i);
});

test("redacts seed and secret values from command logs", async () => {
  const { formatCommandForLog } = await loadProcessModule();
  const seed = "ab".repeat(32);
  const secret = "cd".repeat(64);
  const formatted = formatCommandForLog("/hypertele/server.js", ["--seed", seed, secret], [seed, secret]);

  assert.equal(formatted.includes(seed), false);
  assert.equal(formatted.includes(secret), false);
  assert.match(formatted, /\[REDACTED\]/);
});

test("reports readiness from a real child and accepts intentional exit code 130", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(gracefulFixture("READY"));
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: safeFixtureArguments,
    label: "fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: () => undefined,
  });

  assert.equal(await managed.ready, "READY");
  await managed.stop();
  await managed.waitForExit();
});

test("parses readiness split across stdout chunks with other lines in the same chunk", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => process.exit(130));
process.stdout.write("before\\nRE");
setTimeout(() => process.stdout.write("ADY\\nafter\\n"), 10);
setInterval(() => {}, 1000);
`);
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: ["--address", "127.0.0.1"],
    label: "chunk fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: () => undefined,
  });

  assert.equal(await managed.ready, "READY");
  await managed.stop();
});

test("rejects intentional code 0 because only Hypertele code 130 is clean", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => process.exit(0));
console.log("READY");
setInterval(() => {}, 1000);
`);
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: ["--address", "127.0.0.1"],
    label: "zero fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: () => undefined,
  });

  await managed.ready;
  await assert.rejects(managed.stop(), /unexpectedly.*0/i);
  await assert.rejects(managed.waitForExit(), /unexpectedly.*0/i);
});

test("rejects a raw SIGTERM exit because Hypertele must complete with code 130", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(`
console.log("READY");
setInterval(() => {}, 1000);
`);
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: ["--address", "127.0.0.1"],
    label: "signal fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: () => undefined,
  });

  await managed.ready;
  await assert.rejects(managed.stop(), /unexpectedly.*SIGTERM/i);
  await assert.rejects(managed.waitForExit(), /unexpectedly.*SIGTERM/i);
});

test("waits for stdio close before resolving intentional shutdown", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const marker = "shutdown-stream-drained";
  const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => {
  process.stderr.write(${JSON.stringify(`${marker}\n`)}, () => process.exit(130));
});
console.log("READY");
setInterval(() => {}, 1000);
`);
  const lines: string[] = [];
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: ["--address", "127.0.0.1"],
    label: "drain fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: (line: string) => lines.push(line),
  });

  await managed.ready;
  await managed.stop();
  assert.match(lines.join("\n"), new RegExp(marker));
});

test("clean shutdown clears the losing long timeout so the supervisor can exit", async () => {
  const entrypoint = await makeFixtureScript(gracefulFixture("READY"));
  const processModuleUrl = pathToFileURL(path.resolve("src/p0/hypertele-process.ts")).href;
  const wrapper = await makeFixtureScript(`
import(${JSON.stringify(processModuleUrl)}).then(async ({ spawnManagedHypertele }) => {
  const managed = spawnManagedHypertele({
    entrypoint: ${JSON.stringify(entrypoint)},
    arguments: ["--address", "127.0.0.1"],
    label: "timer fixture",
    parseReady: (line) => line === "READY" ? line : undefined,
    readinessTimeoutMs: 1000,
    shutdownTimeoutMs: 5000,
    log: () => undefined,
  });
  await managed.ready;
  await managed.stop();
});
`);

  await execFileAsync("node", ["--import", "tsx", wrapper], { timeout: 1_000 });
});

test(
  "isolates the child process group so terminal SIGINT cannot race intentional shutdown",
  { skip: process.platform === "win32" },
  async () => {
    const { spawnManagedHypertele } = await loadProcessModule();
    const entrypoint = await makeFixtureScript(gracefulFixture("READY"));
    const managed = spawnManagedHypertele({
      entrypoint,
      arguments: safeFixtureArguments,
      label: "group fixture",
      parseReady: (line: string) => (line === "READY" ? line : undefined),
      readinessTimeoutMs: 1_000,
      shutdownTimeoutMs: 100,
      log: () => undefined,
    });

    await managed.ready;
    assert.ok(managed.pid);
    const [{ stdout: parentGroup }, { stdout: childGroup }] = await Promise.all([
      execFileAsync("ps", ["-o", "pgid=", "-p", String(process.pid)]),
      execFileAsync("ps", ["-o", "pgid=", "-p", String(managed.pid)]),
    ]);
    assert.notEqual(childGroup.trim(), parentGroup.trim());
    await managed.stop();
  },
);

test("uses a 30-second readiness default and permits a 10-second test override", async () => {
  const { DEFAULT_READINESS_TIMEOUT_MS, TEST_READINESS_TIMEOUT_MS, normalizeReadinessTimeout } =
    await loadProcessModule();

  assert.equal(DEFAULT_READINESS_TIMEOUT_MS, 30_000);
  assert.equal(TEST_READINESS_TIMEOUT_MS, 10_000);
  assert.equal(normalizeReadinessTimeout(undefined), 30_000);
  assert.equal(normalizeReadinessTimeout(10_000), 10_000);
});

test("rejects readiness timeout and still permits awaited cleanup", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(gracefulFixture("NEVER_READY"));
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: safeFixtureArguments,
    label: "timeout fixture",
    parseReady: () => undefined,
    readinessTimeoutMs: 200,
    shutdownTimeoutMs: 100,
    log: (line: string) => {
      if (line.includes("NEVER_READY")) {
        markStarted();
      }
    },
  });

  await started;
  await assert.rejects(managed.ready, /readiness timeout/i);
  await managed.stop();
  await managed.waitForExit();
});

test("an abort signal stops a child that is still waiting for readiness", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => process.exit(130));
console.log("BOOTED");
setTimeout(() => console.log("READY"), 1_000);
setInterval(() => {}, 1000);
`);
  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: ["--address", "127.0.0.1"],
    label: "startup fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 500,
    shutdownTimeoutMs: 100,
    signal: controller.signal,
    log: (line: string) => {
      if (line.includes("BOOTED")) {
        markStarted();
      }
    },
  });

  await started;
  controller.abort();
  try {
    await assert.rejects(managed.ready, /aborted/i);
    await managed.waitForExit();
  } finally {
    await managed.stop().catch(() => undefined);
  }
});

test("treats unsolicited exit code 130 as fatal", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(`
console.log("READY");
setTimeout(() => process.exit(130), 30);
`);
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: safeFixtureArguments,
    label: "unsolicited fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: () => undefined,
  });

  await managed.ready;
  await assert.rejects(managed.waitForExit(), /unexpectedly.*130/i);
});

test("classifies unsolicited code 130 at exit time even when stdio closes later", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(`
require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 200)"], {
  stdio: ["ignore", "inherit", "inherit"],
});
console.log("READY");
setTimeout(() => process.exit(130), 20);
`);
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: ["--address", "127.0.0.1"],
    label: "draining fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 500,
    log: () => undefined,
  });

  await managed.ready;
  assert.ok(managed.pid);
  await waitForProcessExit(managed.pid);
  await assert.rejects(managed.stop(), /unexpectedly.*130/i);
  await assert.rejects(managed.waitForExit(), /unexpectedly.*130/i);
});

test("treats any other unsolicited child exit as fatal", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(`
console.log("READY");
setTimeout(() => process.exit(2), 30);
`);
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: safeFixtureArguments,
    label: "failed fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: () => undefined,
  });

  await managed.ready;
  await assert.rejects(managed.waitForExit(), /unexpectedly.*2/i);
});

test("escalates an ignored SIGTERM to SIGKILL, awaits exit, logs, and fails", async () => {
  const { spawnManagedHypertele } = await loadProcessModule();
  const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => {});
console.log("READY");
setInterval(() => {}, 1000);
`);
  const lines: string[] = [];
  const managed = spawnManagedHypertele({
    entrypoint,
    arguments: safeFixtureArguments,
    label: "stuck fixture",
    parseReady: (line: string) => (line === "READY" ? line : undefined),
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 30,
    log: (line: string) => lines.push(line),
  });

  await managed.ready;
  await assert.rejects(managed.stop(), /forced shutdown/i);
  await assert.rejects(managed.waitForExit(), /forced shutdown/i);
  assert.match(lines.join("\n"), /forced shutdown/i);
});

test("publisher starts Home on a random port, verifies its key, and closes everything", async () => {
  const { startPublisher } = await loadPublisherModule();
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-publisher-test-"));
  const seed = generatePublisherSeed();
  const homeKey = derivePublisherHomeKey(seed);
  const configPath = path.join(directory, "publisher.json");
  await writeFile(configPath, serializePublisherConfig({ seed, allow: [] }));
  const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => process.exit(130));
console.log(${JSON.stringify(seed)});
console.log(${JSON.stringify(`hypertele: ${homeKey}`)});
setInterval(() => {}, 1000);
`);
  const lines: string[] = [];
  const publisher = await startPublisher({
    configPath,
    serverEntrypoint: entrypoint,
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: (line: string) => lines.push(line),
  });

  assert.notEqual(publisher.home.port, 0);
  assert.equal(publisher.process.arguments[publisher.process.arguments.indexOf("-l") + 1], String(publisher.home.port));
  assert.equal((await fetch(`${publisher.home.url}/healthz`)).status, 200);
  const loggedSeed = lines.join("\n").includes(seed);
  const homeUrl = publisher.home.url;
  await publisher.stop();
  await assert.rejects(fetch(`${homeUrl}/healthz`));
  assert.equal(loggedSeed, false);
});

test("publisher rejects a Hypertele key different from its derived Home key", async () => {
  const { startPublisher } = await loadPublisherModule();
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-publisher-test-"));
  const seed = generatePublisherSeed();
  const configPath = path.join(directory, "publisher.json");
  await writeFile(configPath, serializePublisherConfig({ seed, allow: [] }));
  const wrongKey = derivePublisherHomeKey(generatePublisherSeed());
  const entrypoint = await makeFixtureScript(gracefulFixture(`hypertele: ${wrongKey}`));

  await assert.rejects(
    startPublisher({
      configPath,
      serverEntrypoint: entrypoint,
      readinessTimeoutMs: 1_000,
      shutdownTimeoutMs: 100,
      log: () => undefined,
    }),
    /Home key/i,
  );
});

test("publisher closes Home when synchronous process setup fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-publisher-test-"));
  const seed = generatePublisherSeed();
  const configPath = path.join(directory, "publisher.json");
  await writeFile(configPath, serializePublisherConfig({ seed, allow: [] }));
  const entrypoint = await makeFixtureScript(gracefulFixture("unused"));
  const publisherModuleUrl = pathToFileURL(path.resolve("src/p0/publisher.ts")).href;
  const wrapper = await makeFixtureScript(`
import(${JSON.stringify(publisherModuleUrl)}).then(async ({ startPublisher }) => {
  await startPublisher({
    configPath: ${JSON.stringify(configPath)},
    serverEntrypoint: ${JSON.stringify(entrypoint)},
    shutdownTimeoutMs: 0,
    log: () => undefined,
  }).then(
    () => { throw new Error("expected publisher setup to fail"); },
    () => undefined,
  );
});
`);

  await execFileAsync("node", ["--import", "tsx", wrapper], { timeout: 1_000 });
});

test("publisher closes Home when Hypertele exits after readiness", async () => {
  const { startPublisher } = await loadPublisherModule();
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-publisher-test-"));
  const seed = generatePublisherSeed();
  const homeKey = derivePublisherHomeKey(seed);
  const configPath = path.join(directory, "publisher.json");
  await writeFile(configPath, serializePublisherConfig({ seed, allow: [] }));
  const entrypoint = await makeFixtureScript(`
console.log(${JSON.stringify(`hypertele: ${homeKey}`)});
setTimeout(() => process.exit(2), 30);
`);
  const publisher = await startPublisher({
    configPath,
    serverEntrypoint: entrypoint,
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: () => undefined,
  });
  const homeUrl = publisher.home.url;

  await assert.rejects(publisher.waitForExit(), /unexpectedly.*2/i);
  await assert.rejects(fetch(`${homeUrl}/healthz`));
});

test(
  "publisher lifecycle handles process-group SIGINT during startup without orphaning its child",
  { skip: process.platform === "win32" },
  async () => {
    const { runPublisher } = await loadPublisherModule();
    assert.equal(typeof runPublisher, "function", "publisher startup lifecycle is not implemented");
    const directory = await mkdtemp(path.join(tmpdir(), "kepos-signal-test-"));
    const seed = generatePublisherSeed();
    const homeKey = derivePublisherHomeKey(seed);
    const configPath = path.join(directory, "publisher.json");
    const childPidPath = path.join(directory, "child.pid");
    await writeFile(configPath, serializePublisherConfig({ seed, allow: [] }));
    const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => process.exit(130));
require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
setTimeout(() => console.log(${JSON.stringify(`hypertele: ${homeKey}`)}), 10_000);
setInterval(() => {}, 1000);
`);
    const publisherModuleUrl = pathToFileURL(path.resolve("src/p0/publisher.ts")).href;
    const wrapper = await makeFixtureScript(`
import(${JSON.stringify(publisherModuleUrl)})
  .then(({ runPublisher }) => runPublisher({
    configPath: ${JSON.stringify(configPath)},
    serverEntrypoint: ${JSON.stringify(entrypoint)},
    readinessTimeoutMs: 20_000,
    shutdownTimeoutMs: 500,
    log: () => undefined,
  }))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
`);
    const supervisor = spawn("node", ["--import", "tsx", wrapper], {
      detached: true,
      stdio: "ignore",
    });
    let childPid: number | undefined;

    try {
      childPid = Number((await waitForFile(childPidPath)).trim());
      assert.equal(Number.isInteger(childPid), true);
      process.kill(-supervisor.pid!, "SIGINT");
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("supervisor did not exit after SIGINT")), 2_000);
          supervisor.once("close", (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal });
          });
        },
      );
      assert.deepEqual(exit, { code: 0, signal: null });
      assert.throws(
        () => process.kill(childPid!, 0),
        (error: NodeJS.ErrnoException) => error.code === "ESRCH",
      );
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        process.kill(-supervisor.pid!, "SIGKILL");
      }
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  },
);

test(
  "publisher lifecycle exits nonzero when signalled shutdown requires SIGKILL",
  { skip: process.platform === "win32" },
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "kepos-forced-signal-test-"));
    const seed = generatePublisherSeed();
    const homeKey = derivePublisherHomeKey(seed);
    const configPath = path.join(directory, "publisher.json");
    const childPidPath = path.join(directory, "child.pid");
    await writeFile(configPath, serializePublisherConfig({ seed, allow: [] }));
    const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => {});
require("node:fs").writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
setTimeout(() => console.log(${JSON.stringify(`hypertele: ${homeKey}`)}), 10_000);
setInterval(() => {}, 1000);
`);
    const publisherModuleUrl = pathToFileURL(path.resolve("src/p0/publisher.ts")).href;
    const wrapper = await makeFixtureScript(`
import(${JSON.stringify(publisherModuleUrl)})
  .then(({ runPublisher }) => runPublisher({
    configPath: ${JSON.stringify(configPath)},
    serverEntrypoint: ${JSON.stringify(entrypoint)},
    readinessTimeoutMs: 1000,
    shutdownTimeoutMs: 50,
    log: () => undefined,
  }))
  .catch(() => { process.exitCode = 1; });
`);
    const supervisor = spawn("node", ["--import", "tsx", wrapper], {
      detached: true,
      stdio: "ignore",
    });
    let childPid: number | undefined;

    try {
      childPid = Number((await waitForFile(childPidPath)).trim());
      await new Promise((resolve) => setTimeout(resolve, 50));
      process.kill(-supervisor.pid!, "SIGINT");
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("forced supervisor did not exit")), 2_000);
        supervisor.once("close", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(exitCode, 1);
      assert.throws(
        () => process.kill(childPid!, 0),
        (error: NodeJS.ErrnoException) => error.code === "ESRCH",
      );
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        process.kill(-supervisor.pid!, "SIGKILL");
      }
      if (childPid) {
        try {
          process.kill(childPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  },
);

test("client prints its loopback Home URL only after Hypertele reports ready", async () => {
  const { startClient } = await loadClientModule();
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-client-test-"));
  const identity = generateClientIdentity();
  const homeKey = derivePublisherHomeKey(generatePublisherSeed());
  const identityPath = path.join(directory, "client.identity.json");
  const contactPath = path.join(directory, "client.contact.json");
  await writeFile(identityPath, serializeClientIdentity(identity));
  await writeFile(
    contactPath,
    serializeClientContact({ homeKey, label: "Publisher", requestedLocalPort: 0 }),
  );
  const entrypoint = await makeFixtureScript(`
process.on("SIGTERM", () => process.exit(130));
console.log(${JSON.stringify(identity.secretKey)});
setTimeout(() => console.log("Server ready @127.0.0.1:43124"), 50);
setInterval(() => {}, 1000);
`);
  const lines: string[] = [];
  const starting = startClient({
    identityPath,
    contactPath,
    clientEntrypoint: entrypoint,
    readinessTimeoutMs: 1_000,
    shutdownTimeoutMs: 100,
    log: (line: string) => lines.push(line),
  });

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(lines.some((line) => line.includes("http://127.0.0.1:43124")), false);
  const client = await starting;
  assert.equal(client.url, "http://127.0.0.1:43124");
  assert.match(lines.at(-1) ?? "", /http:\/\/127\.0\.0\.1:43124/);
  const output = lines.join("\n");
  assert.deepEqual(client.process.arguments.slice(0, 2), ["-p", "0"]);
  await client.stop();
  assert.equal(output.includes(identity.secretKey), false);
  assert.equal(output.includes(identity.secretKey.slice(0, 64)), false);
});

test("CLI defaults use tmp/p0 and expose bootstrap only as an explicit test option", async () => {
  const { parsePublisherCliOptions } = await loadPublisherModule();
  const { parseClientCliOptions } = await loadClientModule();
  const publisherDefault = parsePublisherCliOptions([]);
  const clientDefault = parseClientCliOptions([]);

  assert.equal(publisherDefault.configPath, path.resolve("tmp/p0/publisher.json"));
  assert.equal(clientDefault.identityPath, path.resolve("tmp/p0/client-a.identity.json"));
  assert.equal(clientDefault.contactPath, path.resolve("tmp/p0/client-a.contact.json"));
  assert.equal(parsePublisherCliOptions(["--test-bootstrap", "49737"]).testBootstrapPort, 49737);
  assert.equal(parseClientCliOptions(["--test-bootstrap", "49737"]).testBootstrapPort, 49737);
  assert.throws(() => parsePublisherCliOptions(["--bootstrap", "49737"]), /unknown|test/i);
  assert.throws(() => parseClientCliOptions(["--bootstrap", "49737"]), /unknown|test/i);
});
