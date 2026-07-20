import { createRequire } from "node:module";
import { Duplex } from "node:stream";

import { sanitizeObservation } from "./observability.js";

const require = createRequire(import.meta.url);
const HyperDHT = require("hyperdht") as HyperDhtConstructor;

export interface DhtAddress {
  host: string;
  port: number;
}

export interface DhtKeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}

export interface DhtStream extends Duplex {
  connected?: boolean;
  rawStream?: unknown;
  remotePublicKey: Buffer;
  setKeepAlive?: (intervalMs: number) => void;
  toJSON?: () => unknown;
}

export interface DhtServer {
  close: () => Promise<void>;
  listen: (keyPair: DhtKeyPair) => Promise<void>;
}

export interface DhtNode {
  connect: (
    publicKey: Buffer,
    options: {
      keyPair: DhtKeyPair;
      localConnection: boolean;
      reusableSocket: true;
    },
  ) => DhtStream;
  createServer: (
    options: {
      firewall: (remotePublicKey: Buffer) => boolean;
      reusableSocket: true;
    },
    onConnection: (stream: DhtStream) => void,
  ) => DhtServer;
  destroy: (options?: { force?: boolean }) => Promise<void>;
}

interface HyperDhtConstructor {
  new (options: {
    bootstrap?: DhtAddress[];
    connectionKeepAlive: number;
    keyPair?: DhtKeyPair;
  }): DhtNode;
  keyPair: (seed?: Buffer) => DhtKeyPair;
}

export function createDht(options: {
  bootstrap?: DhtAddress[];
  keyPair?: DhtKeyPair;
}): DhtNode {
  return new HyperDHT({
    ...options,
    connectionKeepAlive: 10_000,
  });
}

export function keyPairFromSeed(seed: string): DhtKeyPair {
  return HyperDHT.keyPair(Buffer.from(seed, "hex"));
}

export function keyPairFromSecretKey(secretKey: string): DhtKeyPair {
  return HyperDHT.keyPair(Buffer.from(secretKey.slice(0, 64), "hex"));
}

export function dhtStreamSnapshot(stream: DhtStream): unknown {
  const snapshot = stream.toJSON?.();
  const base =
    snapshot !== null && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? snapshot
      : {};
  const udx = udxStreamSnapshot(stream.rawStream);

  return sanitizeObservation({
    ...base,
    ...(udx ? { udx } : {}),
  });
}

function udxStreamSnapshot(rawStream: unknown): Record<string, number> | undefined {
  if (rawStream === null || typeof rawStream !== "object") return undefined;

  const raw = rawStream as Record<string, unknown>;
  const socket =
    raw.socket !== null && typeof raw.socket === "object"
      ? (raw.socket as Record<string, unknown>)
      : undefined;
  const snapshot = {
    ...numericFields(raw, [
      "rtt",
      "cwnd",
      "inflight",
      "rtoCount",
      "retransmits",
      "fastRecoveries",
      "bbrState",
      "bbrBandwidth",
      "bytesTransmitted",
      "packetsTransmitted",
      "bytesReceived",
      "packetsReceived",
    ]),
    ...(socket
      ? numericFields(socket, ["packetsDroppedByKernel"])
      : {}),
  };

  return Object.keys(snapshot).length > 0 ? snapshot : undefined;
}

function numericFields(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, number> {
  const fields: Record<string, number> = {};
  for (const key of keys) {
    const value = readProperty(source, key);
    if (typeof value === "number" && Number.isFinite(value)) {
      fields[key] = value;
    }
  }
  return fields;
}

function readProperty(source: Record<string, unknown>, key: string): unknown {
  try {
    return source[key];
  } catch {
    return undefined;
  }
}
