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
  return sanitizeObservation(stream.toJSON?.() ?? null);
}
