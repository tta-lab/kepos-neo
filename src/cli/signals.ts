export async function waitForSignal(
  stop: () => Promise<void>,
): Promise<void> {
  let stopping: Promise<void> | undefined;
  let requestStop!: () => void;
  const stopped = new Promise<void>((resolve, reject) => {
    requestStop = () => {
      stopping ??= stop();
      stopping.then(resolve, reject);
    };
  });
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    await stopped;
  } finally {
    process.off("SIGINT", requestStop);
    process.off("SIGTERM", requestStop);
  }
}
