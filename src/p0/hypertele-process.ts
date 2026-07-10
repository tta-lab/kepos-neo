import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

export const DEFAULT_READINESS_TIMEOUT_MS = 30_000;
export const TEST_READINESS_TIMEOUT_MS = 10_000;
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export class StartupAbortedError extends Error {
  override name = "StartupAbortedError";
}

const loopbackAddress = "127.0.0.1";
const forbiddenFlags = ["--seed", "--private", "--compress", "--cert-skip"];
const publicKeyPattern = /^[0-9a-f]{64}$/;

export interface HyperteleEntrypoints {
  server: string;
  client: string;
}

export interface PublisherArgumentsOptions {
  targetPort: number;
  configPath: string;
  testBootstrapPort?: number;
}

export interface ClientArgumentsOptions {
  identityPath: string;
  homeKey: string;
  testBootstrapPort?: number;
}

export interface SpawnManagedHyperteleOptions<T> {
  entrypoint: string;
  arguments: string[];
  label: string;
  parseReady: (line: string) => T | undefined;
  readinessTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  sensitiveValues?: string[];
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface ManagedHyperteleProcess<T> {
  arguments: readonly string[];
  pid: number | undefined;
  ready: Promise<T>;
  stop: () => Promise<void>;
  waitForExit: () => Promise<void>;
}

interface ChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stopping: boolean;
  forced: boolean;
}

const require = createRequire(import.meta.url);

export function resolveHyperteleEntrypoints(): HyperteleEntrypoints {
  return {
    server: require.resolve("hypertele/server.js"),
    client: require.resolve("hypertele/client.js"),
  };
}

function parsePort(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${field} must be an integer from 1 through 65535`);
  }
  return value;
}

function appendTestBootstrap(arguments_: string[], testBootstrapPort?: number): void {
  if (testBootstrapPort === undefined) {
    return;
  }
  arguments_.push("--bootstrap", String(parsePort(testBootstrapPort, "testBootstrapPort")));
}

export function validateHyperteleArguments(arguments_: readonly string[]): void {
  for (const forbidden of forbiddenFlags) {
    if (arguments_.some((argument) => argument === forbidden || argument.startsWith(`${forbidden}=`))) {
      throw new Error(`forbidden Hypertele flag: ${forbidden}`);
    }
  }

  const addressIndex = arguments_.indexOf("--address");
  if (addressIndex < 0 || arguments_[addressIndex + 1] !== loopbackAddress) {
    throw new Error("Hypertele must bind only to loopback 127.0.0.1");
  }
}

export function buildPublisherArguments(options: PublisherArgumentsOptions): string[] {
  const arguments_ = [
    "-l",
    String(parsePort(options.targetPort, "targetPort")),
    "--address",
    loopbackAddress,
    "-c",
    options.configPath,
  ];
  appendTestBootstrap(arguments_, options.testBootstrapPort);
  validateHyperteleArguments(arguments_);
  return arguments_;
}

export function buildClientArguments(options: ClientArgumentsOptions): string[] {
  if (!publicKeyPattern.test(options.homeKey)) {
    throw new Error("homeKey must be 32 bytes of lowercase hex");
  }

  const arguments_ = [
    "-p",
    "0",
    "--address",
    loopbackAddress,
    "-i",
    options.identityPath,
    "-s",
    options.homeKey,
  ];
  appendTestBootstrap(arguments_, options.testBootstrapPort);
  validateHyperteleArguments(arguments_);
  return arguments_;
}

export function parsePublisherReadyLine(line: string, expectedHomeKey: string): string | undefined {
  const match = /^hypertele:\s*([0-9a-f]{64})\s*$/.exec(line);
  if (!match) {
    return undefined;
  }
  if (match[1] !== expectedHomeKey) {
    throw new Error(`Hypertele emitted a Home key different from the configured Home key`);
  }
  return match[1];
}

export function parseClientReadyLine(line: string): number | undefined {
  if (line.startsWith("Server ready @") && !line.startsWith(`Server ready @${loopbackAddress}:`)) {
    throw new Error("Hypertele client did not bind to loopback");
  }

  const match = /^Server ready @127\.0\.0\.1:(\d{1,5})\s*$/.exec(line);
  if (!match) {
    return undefined;
  }
  return parsePort(Number(match[1]), "ready port");
}

export function normalizeReadinessTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_READINESS_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error("readiness timeout must be a positive integer");
  }
  return timeout;
}

function redactText(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues.reduce(
    (redacted, sensitive) => (sensitive ? redacted.replaceAll(sensitive, "[REDACTED]") : redacted),
    value,
  );
}

export function formatCommandForLog(
  entrypoint: string,
  arguments_: readonly string[],
  sensitiveValues: readonly string[] = [],
): string {
  const command = [process.execPath, entrypoint, ...arguments_]
    .map((argument) => JSON.stringify(argument))
    .join(" ");
  return redactText(command, sensitiveValues);
}

function unexpectedExitError(label: string, exit: ChildExit): Error {
  if (exit.error) {
    return new Error(`${label} child error: ${exit.error.message}`, { cause: exit.error });
  }
  const result = exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`;
  return new Error(`${label} exited unexpectedly with ${result}`);
}

function validIntentionalExit(exit: ChildExit): boolean {
  return exit.code === 130 && exit.signal === null;
}

export function spawnManagedHypertele<T>(
  options: SpawnManagedHyperteleOptions<T>,
): ManagedHyperteleProcess<T> {
  validateHyperteleArguments(options.arguments);
  const log = options.log ?? console.log;
  const sensitiveValues = options.sensitiveValues ?? [];
  const readinessTimeoutMs = normalizeReadinessTimeout(options.readinessTimeoutMs);
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 1) {
    throw new Error("shutdown timeout must be a positive integer");
  }

  log(`Starting ${options.label}: ${formatCommandForLog(options.entrypoint, options.arguments, sensitiveValues)}`);
  const child = spawn(process.execPath, [options.entrypoint, ...options.arguments], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stopping = false;
  let forced = false;
  let readySettled = false;
  let exitSettled = false;
  let resolveReady!: (value: T) => void;
  let rejectReady!: (error: Error) => void;
  let resolveExit!: (exit: ChildExit) => void;
  const ready = new Promise<T>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const exited = new Promise<ChildExit>((resolve) => {
    resolveExit = resolve;
  });
  let observedExit: ChildExit | undefined;
  let childError: Error | undefined;

  const settleReadyError = (error: Error): void => {
    if (readySettled) {
      return;
    }
    readySettled = true;
    rejectReady(error);
  };
  const settleExit = (exit: ChildExit): void => {
    if (exitSettled) {
      return;
    }
    exitSettled = true;
    resolveExit(exit);
  };

  const readinessTimer = setTimeout(() => {
    settleReadyError(new Error(`${options.label} readiness timeout after ${readinessTimeoutMs}ms`));
  }, readinessTimeoutMs);

  const stdout = createInterface({ input: child.stdout });
  const stderr = createInterface({ input: child.stderr });
  stdout.on("line", (line) => {
    log(`${options.label} stdout: ${redactText(line, sensitiveValues)}`);
    if (readySettled) {
      return;
    }
    try {
      const value = options.parseReady(line);
      if (value !== undefined) {
        readySettled = true;
        clearTimeout(readinessTimer);
        options.signal?.removeEventListener("abort", abort);
        resolveReady(value);
      }
    } catch (error) {
      clearTimeout(readinessTimer);
      settleReadyError(error instanceof Error ? error : new Error(String(error)));
    }
  });
  stderr.on("line", (line) => {
    log(`${options.label} stderr: ${redactText(line, sensitiveValues)}`);
  });

  child.once("error", (error) => {
    clearTimeout(readinessTimer);
    childError = error;
    settleReadyError(new Error(`${options.label} child error: ${error.message}`, { cause: error }));
  });
  child.once("exit", (code, signal) => {
    clearTimeout(readinessTimer);
    settleReadyError(new Error(`${options.label} exited before readiness`));
    observedExit = { code, signal, stopping, forced };
  });
  child.once("close", (code, signal) => {
    settleExit(
      observedExit ?? { code, signal, error: childError, stopping, forced },
    );
  });

  const waitForExit = async (): Promise<void> => {
    const exit = await exited;
    if (exit.forced) {
      throw new Error(`${options.label} forced shutdown after ${shutdownTimeoutMs}ms`);
    }
    if (!exit.stopping || !validIntentionalExit(exit)) {
      throw unexpectedExitError(options.label, exit);
    }
  };

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      if (!exitSettled) {
        child.kill("SIGTERM");
      }

      let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
      const didTimeout = await Promise.race([
        exited.then(() => false),
        new Promise<true>((resolve) => {
          shutdownTimer = setTimeout(() => resolve(true), shutdownTimeoutMs);
        }),
      ]);
      if (shutdownTimer) {
        clearTimeout(shutdownTimer);
      }
      if (didTimeout) {
        forced = true;
        child.kill("SIGKILL");
        await exited;
        log(`${options.label} forced shutdown after ${shutdownTimeoutMs}ms`);
        throw new Error(`${options.label} forced shutdown after ${shutdownTimeoutMs}ms`);
      }
      await waitForExit();
    })();
    return stopPromise;
  };

  const abort = (): void => {
    clearTimeout(readinessTimer);
    settleReadyError(new StartupAbortedError(`${options.label} startup aborted`));
    void stop().catch(() => undefined);
  };
  if (options.signal?.aborted) {
    queueMicrotask(abort);
  } else {
    options.signal?.addEventListener("abort", abort, { once: true });
  }
  void exited.then(() => options.signal?.removeEventListener("abort", abort));

  return {
    arguments: [...options.arguments],
    pid: child.pid,
    ready,
    stop,
    waitForExit,
  };
}
