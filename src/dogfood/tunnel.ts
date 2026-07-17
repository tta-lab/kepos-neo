import type { ManagedHyperteleProcess } from "../p0/hypertele-process.js";

export interface RunningTunnel {
  id: string;
  serviceKey: string;
  port: number;
  process: ManagedHyperteleProcess<number | string>;
}

export async function stopTunnels(
  tunnels: readonly Pick<RunningTunnel, "process">[],
): Promise<void> {
  const results = await Promise.allSettled(
    [...tunnels].reverse().map((tunnel) => tunnel.process.stop()),
  );
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason as unknown);
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, "failed to stop Hypertele tunnels");
  }
}
