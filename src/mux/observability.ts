export type ObservationRole = "publisher" | "subscriber";
export type ObservationDirection =
  | "subscriber-to-publisher"
  | "publisher-to-subscriber";
export type ObservationName =
  | "outer.attempt"
  | "outer.handshake"
  | "outer.connected"
  | "outer.retry"
  | "outer.restored"
  | "outer.closed"
  | "outer.accepted"
  | "outer.rejected"
  | "channel.open"
  | "channel.open-ok"
  | "channel.open-error"
  | "channel.first-byte"
  | "channel.fin"
  | "channel.reset"
  | "channel.pause"
  | "channel.resume"
  | "channel.close";

export interface Observation {
  component: "kepos";
  timestamp: string;
  elapsedMs: number;
  event: ObservationName;
  role: ObservationRole;
  route?: string;
  outerId?: string;
  channelId?: string;
  serviceId?: string;
  direction?: ObservationDirection;
  bytes?: number;
  error?: string;
  trigger?: string;
  [field: string]: unknown;
}

export type Observe = (observation: Observation) => void;
export type ObservationFields = Record<string, unknown>;
export type EmitObservation = (
  event: ObservationName,
  fields?: ObservationFields,
) => void;

export interface ObserverOptions {
  enabled: boolean;
  role: ObservationRole;
  route?: string;
  outerId?: string;
  now?: () => number;
  write?: (line: string) => void;
}

export interface ObservationEmitterOptions {
  observe?: Observe;
  role: ObservationRole;
  route?: string;
  outerId?: string;
  channelId?: string;
  serviceId?: string;
  now?: () => number;
  startedAt?: number;
}

export function createObserver(options: ObserverOptions): EmitObservation {
  if (!options.enabled) return () => undefined;

  const write = options.write ?? console.log;
  return createObservationEmitter({
    ...options,
    observe: (observation) => write(JSON.stringify(observation)),
  });
}

export function createObservationEmitter(
  options: ObservationEmitterOptions,
): EmitObservation {
  if (!options.observe) return () => undefined;

  const now = options.now ?? Date.now;
  const startedAt = options.startedAt ?? now();

  return (event, fields = {}) => {
    const sanitized = sanitizeObservation(fields);
    const safeFields =
      sanitized !== null &&
      typeof sanitized === "object" &&
      !Array.isArray(sanitized)
        ? sanitized
        : {};
    const observedAt = now();
    options.observe?.({
      ...safeFields,
      component: "kepos",
      timestamp: new Date(observedAt).toISOString(),
      elapsedMs: observedAt - startedAt,
      role: options.role,
      ...(options.route ? { route: options.route } : {}),
      ...(options.outerId ? { outerId: options.outerId } : {}),
      ...(options.channelId ? { channelId: options.channelId } : {}),
      ...(options.serviceId ? { serviceId: options.serviceId } : {}),
      event,
    });
  };
}

export function sanitizeObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeObservation);
  if (Buffer.isBuffer(value)) return value.toString("hex");
  if (value === null || typeof value !== "object") return value;

  const sanitized: ObservationFields = {};
  for (const [key, field] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (normalizedKey.includes("secret") || normalizedKey.includes("seed")) {
      continue;
    }
    if (
      (normalizedKey === "publickey" ||
        normalizedKey === "remotepublickey") &&
      (typeof field === "string" || Buffer.isBuffer(field))
    ) {
      const keyHex = Buffer.isBuffer(field) ? field.toString("hex") : field;
      sanitized[key] = keyHex.slice(0, 16);
      continue;
    }
    sanitized[key] = sanitizeObservation(field);
  }
  return sanitized;
}

export function createObservationId(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}
import { randomBytes } from "node:crypto";
