import { createRequire } from "node:module";
import { randomBytes, timingSafeEqual } from "node:crypto";

export interface ClientIdentity {
  secretKey: string;
  publicKey: string;
}

interface HyperDhtKeyPair {
  publicKey: Buffer;
  secretKey: Buffer;
}

interface HyperDhtModule {
  keyPair(seed?: Buffer): HyperDhtKeyPair;
}

const require = createRequire(import.meta.url);
const HyperDHT = require("hyperdht") as HyperDhtModule;
const publicKeyPattern = /^[0-9a-f]{64}$/;
const secretKeyPattern = /^[0-9a-f]{128}$/;

function deriveKeyPair(seed: Buffer): HyperDhtKeyPair {
  const pair = HyperDHT.keyPair(seed);
  if (pair.publicKey.length !== 32 || pair.secretKey.length !== 64) {
    throw new Error("HyperDHT returned an invalid keypair");
  }

  return pair;
}

export function generatePublisherSeed(): string {
  return randomBytes(32).toString("hex");
}

export function derivePublisherHomeKey(seed: string): string {
  if (!publicKeyPattern.test(seed)) {
    throw new Error("publisher seed must be 32 bytes of lowercase hex");
  }

  return deriveKeyPair(Buffer.from(seed, "hex")).publicKey.toString("hex");
}

export function generateClientIdentity(): ClientIdentity {
  const pair = deriveKeyPair(randomBytes(32));
  return {
    secretKey: pair.secretKey.toString("hex"),
    publicKey: pair.publicKey.toString("hex"),
  };
}

export function parseClientIdentity(value: unknown): ClientIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("client identity must be an object");
  }

  const record = value as Record<string, unknown>;
  if (typeof record.publicKey !== "string" || !publicKeyPattern.test(record.publicKey)) {
    throw new Error("client identity publicKey must be 32 bytes of lowercase hex");
  }
  if (typeof record.secretKey !== "string" || !secretKeyPattern.test(record.secretKey)) {
    throw new Error("client identity secretKey must be 64 bytes of lowercase hex");
  }

  const suppliedPublicKey = Buffer.from(record.publicKey, "hex");
  const suppliedSecretKey = Buffer.from(record.secretKey, "hex");
  const derived = deriveKeyPair(suppliedSecretKey.subarray(0, 32));
  if (
    !timingSafeEqual(suppliedPublicKey, derived.publicKey) ||
    !timingSafeEqual(suppliedSecretKey, derived.secretKey)
  ) {
    throw new Error("client identity does not match its secretKey seed");
  }

  return { secretKey: record.secretKey, publicKey: record.publicKey };
}

export function serializeClientIdentity(identity: ClientIdentity): string {
  return `${JSON.stringify(parseClientIdentity(identity), null, 2)}\n`;
}
