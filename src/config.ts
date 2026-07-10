export interface PublisherConfig {
  seed: string;
  allow: string[];
}

export interface ClientContact {
  homeKey: string;
  label: string;
  requestedLocalPort: number;
}

const keyHexPattern = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseKeyHex(value: unknown, field: string): string {
  if (typeof value !== "string" || !keyHexPattern.test(value)) {
    throw new Error(`${field} must be 32 bytes of lowercase hex`);
  }

  return value;
}

export function parsePublisherConfig(value: unknown): PublisherConfig {
  if (!isRecord(value)) {
    throw new Error("publisher config must be an object");
  }
  const unknownFields = Object.keys(value).filter((field) => field !== "seed" && field !== "allow");
  if (unknownFields.length > 0) {
    throw new Error(`publisher config has unknown field: ${unknownFields[0]}`);
  }

  const seed = parseKeyHex(value.seed, "seed");
  if (!Array.isArray(value.allow)) {
    throw new Error("allow must be an array, including for deny-all");
  }

  const allow = value.allow.map((entry, index) => parseKeyHex(entry, `allow[${index}]`));
  return { seed, allow };
}

export function serializePublisherConfig(config: PublisherConfig): string {
  return `${JSON.stringify(parsePublisherConfig(config), null, 2)}\n`;
}

export function parseClientContact(value: unknown): ClientContact {
  if (!isRecord(value)) {
    throw new Error("client contact must be an object");
  }

  const homeKey = parseKeyHex(value.homeKey, "homeKey");
  if (typeof value.label !== "string" || value.label.trim().length === 0) {
    throw new Error("label must be a non-empty string");
  }
  if (
    typeof value.requestedLocalPort !== "number" ||
    !Number.isInteger(value.requestedLocalPort) ||
    value.requestedLocalPort < 0 ||
    value.requestedLocalPort > 65_535
  ) {
    throw new Error("requestedLocalPort must be an integer from 0 through 65535");
  }

  return {
    homeKey,
    label: value.label,
    requestedLocalPort: value.requestedLocalPort,
  };
}

export function serializeClientContact(contact: ClientContact): string {
  return `${JSON.stringify(parseClientContact(contact), null, 2)}\n`;
}
