import b4a from "b4a";
import crypto from "hypercore-crypto";
import HyperDhtModule from "hyperdht";
import sodium from "sodium-universal";

export interface ClientIdentity {
  secretKey: string;
  publicKey: string;
}

interface HyperDhtKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

interface HyperDhtModule {
  keyPair(seed?: Uint8Array): HyperDhtKeyPair;
}

const HyperDHT = HyperDhtModule as HyperDhtModule;
const publicKeyPattern = /^[0-9a-f]{64}$/;
const secretKeyPattern = /^[0-9a-f]{128}$/;

function deriveKeyPair(seed: Uint8Array): HyperDhtKeyPair {
  const pair = HyperDHT.keyPair(seed);
  if (pair.publicKey.length !== 32 || pair.secretKey.length !== 64) {
    throw new Error("HyperDHT returned an invalid keypair");
  }

  return pair;
}

export function generatePublisherSeed(): string {
  return b4a.toString(crypto.randomBytes(32), "hex");
}

export function derivePublisherHomeKey(seed: string): string {
  if (!publicKeyPattern.test(seed)) {
    throw new Error("publisher seed must be 32 bytes of lowercase hex");
  }

  return b4a.toString(deriveKeyPair(b4a.from(seed, "hex")).publicKey, "hex");
}

export function generateClientIdentity(): ClientIdentity {
  const pair = deriveKeyPair(crypto.randomBytes(32));
  return {
    secretKey: b4a.toString(pair.secretKey, "hex"),
    publicKey: b4a.toString(pair.publicKey, "hex"),
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

  const suppliedPublicKey = b4a.from(record.publicKey, "hex");
  const suppliedSecretKey = b4a.from(record.secretKey, "hex");
  const derived = deriveKeyPair(suppliedSecretKey.subarray(0, 32));
  if (
    !sodium.sodium_memcmp(suppliedPublicKey, derived.publicKey) ||
    !sodium.sodium_memcmp(suppliedSecretKey, derived.secretKey)
  ) {
    throw new Error("client identity does not match its secretKey seed");
  }

  return { secretKey: record.secretKey, publicKey: record.publicKey };
}

export function serializeClientIdentity(identity: ClientIdentity): string {
  return `${JSON.stringify(parseClientIdentity(identity), null, 2)}\n`;
}
