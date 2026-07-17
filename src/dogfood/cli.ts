export function takeOptionValue(
  arguments_: readonly string[],
  index: number,
  option: string,
): string {
  const value = arguments_[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseTcpPort(value: string, option: string, allowZero = false): number {
  const port = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`${option} must be an integer from ${minimum} through 65535`);
  }
  return port;
}

export async function waitForSignal(
  stop: () => Promise<void>,
  waitForExit: () => Promise<void>,
): Promise<void> {
  let requestStop!: () => void;
  const stopped = new Promise<void>((resolve, reject) => {
    requestStop = () => stop().then(resolve, reject);
  });
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    await Promise.race([stopped, waitForExit()]);
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}
