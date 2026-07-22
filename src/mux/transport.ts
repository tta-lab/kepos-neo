import compactModule from "compact-encoding";
import b4a from "b4a";
import crypto from "hypercore-crypto";
import { Duplex } from "node:stream";
import ProtomuxModule from "protomux";

import {
  createObservationId,
  createObservationEmitter,
  type EmitObservation,
  type ObservationDirection,
  type ObservationFields,
  type ObservationRole,
  type Observe,
} from "./observability.js";

const Protomux = ProtomuxModule as ProtomuxConstructor;
const compact = compactModule as CompactEncoding;

const protocol = "kepos/tcp/1";

interface Encoding<T> {
  decode: (state: unknown) => T;
  encode: (state: unknown, value: T) => void;
  preencode: (state: unknown, value: T) => void;
}

interface CompactEncoding {
  buffer: Encoding<Uint8Array>;
  none: Encoding<null>;
  string: Encoding<string>;
}

interface OuterStream extends NodeJS.ReadWriteStream {
  destroy: (error?: Error) => void;
  destroyed?: boolean;
  userData?: unknown;
}

interface MuxMessage<T> {
  send: (value: T) => boolean;
}

interface MuxChannel {
  addMessage: <T>(options: {
    encoding: Encoding<T>;
    onmessage: (message: T) => void;
  }) => MuxMessage<T>;
  close: () => void;
  open: (handshake: string) => void;
}

interface MuxInstance {
  createChannel: (options: {
    protocol: string;
    id: Uint8Array;
    handshake: Encoding<string>;
    onopen?: (handshake: string) => void | Promise<void>;
    onclose?: () => void;
    ondrain?: () => void;
  }) => MuxChannel | null;
  pair: (
    options: { protocol: string },
    callback: (id: Uint8Array) => void | Promise<void>,
  ) => void;
  unpair: (options: { protocol: string }) => void;
}

interface ProtomuxConstructor {
  new (stream: OuterStream): MuxInstance;
}

interface TunnelMessages {
  data: MuxMessage<Uint8Array>;
  fin: MuxMessage<null>;
  pause: MuxMessage<null>;
  reset: MuxMessage<string>;
  resume: MuxMessage<null>;
  status: MuxMessage<string>;
}

export interface MuxPublisherOptions {
  connect: (serviceId: string) => Promise<Duplex>;
  now?: () => number;
  observe?: Observe;
  outerId?: string;
  transportSnapshot?: () => unknown;
}

export interface MuxSubscriberOptions {
  now?: () => number;
  observe?: Observe;
  outerId?: string;
  transportSnapshot?: () => unknown;
}

export interface RunningMuxPublisher {
  close: () => void;
}

export interface RunningMuxSubscriber {
  close: () => void;
  open: (serviceId: string) => Promise<Duplex>;
}

class MuxTunnel extends Duplex {
  readonly ready: Promise<void>;

  private channel?: MuxChannel;
  private messages?: TunnelMessages;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readyState: "pending" | "ready" | "failed" = "pending";
  private localPaused = false;
  private remotePaused = false;
  private pendingWrite?: {
    chunk: Uint8Array;
    callback: (error?: Error | null) => void;
  };
  private pendingDrain?: (error?: Error | null) => void;
  private remoteClosing = false;
  private closeTrigger = "local.close";
  private readonly openedAt: number;
  private readonly metrics: Record<
    ObservationDirection,
    {
      bytes: number;
      firstByteAt?: number;
      lastByteAt?: number;
    }
  > = {
    "subscriber-to-publisher": { bytes: 0 },
    "publisher-to-subscriber": { bytes: 0 },
  };

  constructor(
    private readonly options: {
      emit: EmitObservation;
      incomingDirection: ObservationDirection;
      measure: boolean;
      now: () => number;
      outgoingDirection: ObservationDirection;
      transportSnapshot?: () => unknown;
    },
  ) {
    super({ allowHalfOpen: true });
    this.openedAt = options.now();
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  attach(channel: MuxChannel, messages: TunnelMessages): void {
    this.channel = channel;
    this.messages = messages;
  }

  accept(): void {
    if (this.readyState !== "pending") return;
    this.readyState = "ready";
    this.readyResolve();
  }

  reject(message: string): void {
    if (this.readyState !== "pending") return;
    this.readyState = "failed";
    const error = new Error(message);
    this.readyReject(error);
    this.remoteClosing = true;
    this.closeTrigger = "remote.open-error";
    this.destroy();
  }

  receive(chunk: Uint8Array): void {
    if (this.destroyed) return;
    this.observeBytes(this.options.incomingDirection, chunk);
    if (!this.push(b4a.from(chunk)) && !this.localPaused) {
      this.localPaused = true;
      this.options.emit("channel.pause", {
        direction: this.options.incomingDirection,
        source: "local",
      });
      this.messages?.pause.send(null);
    }
  }

  receiveFin(): void {
    this.options.emit("channel.fin", {
      direction: this.options.incomingDirection,
      source: "remote",
    });
    if (!this.destroyed) this.push(null);
  }

  receivePause(): void {
    this.remotePaused = true;
    this.options.emit("channel.pause", {
      direction: this.options.outgoingDirection,
      source: "remote",
    });
  }

  receiveResume(): void {
    this.remotePaused = false;
    this.options.emit("channel.resume", {
      direction: this.options.outgoingDirection,
      source: "remote",
    });
    this.flushPendingWrite();
  }

  receiveReset(message: string): void {
    this.remoteClosing = true;
    this.closeTrigger = "remote.reset";
    this.options.emit("channel.reset", {
      direction: this.options.incomingDirection,
      error: message || "Remote tunnel reset",
      source: "remote",
    });
    this.destroy(new Error(message || "Remote tunnel reset"));
  }

  remoteClose(): void {
    this.remoteClosing = true;
    this.closeTrigger = "remote.close";
    if (this.readyState === "pending") {
      this.reject("Remote closed the tunnel before it opened");
      return;
    }
    this.destroy();
  }

  outerDrain(): void {
    const callback = this.pendingDrain;
    this.pendingDrain = undefined;
    callback?.();
  }

  closeFrom(trigger: string, error?: Error): void {
    if (this.destroyed) return;
    this.closeTrigger = trigger;
    this.destroy(error);
  }

  override _read(): void {
    if (!this.localPaused) return;
    this.localPaused = false;
    this.options.emit("channel.resume", {
      direction: this.options.incomingDirection,
      source: "local",
    });
    this.messages?.resume.send(null);
  }

  override _write(
    data: Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const copy = b4a.from(data as Uint8Array);
    if (this.remotePaused) {
      this.pendingWrite = { chunk: copy, callback };
      return;
    }
    this.sendData(copy, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.options.emit("channel.fin", {
      direction: this.options.outgoingDirection,
      source: "local",
    });
    this.messages?.fin.send(null);
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.readyState === "pending") {
      this.readyState = "failed";
      this.readyReject(error ?? new Error("Tunnel closed before it opened"));
    }
    if (!this.remoteClosing && error) {
      if (this.closeTrigger === "local.close") {
        this.closeTrigger = "local.error";
      }
      this.options.emit("channel.reset", {
        direction: this.options.outgoingDirection,
        error: error.message,
        source: "local",
      });
      this.messages?.reset.send(error.message);
    }
    this.options.emit("channel.close", {
      trigger: this.closeTrigger,
      ...(error ? { error: error.message } : {}),
      durationMs: this.options.now() - this.openedAt,
      ...this.transferFields(),
      ...transportFields(this.options.transportSnapshot),
    });
    this.channel?.close();
    callback(error);
  }

  private sendData(
    chunk: Uint8Array,
    callback: (error?: Error | null) => void,
  ): void {
    this.observeBytes(this.options.outgoingDirection, chunk);
    if (!this.messages?.data.send(chunk)) {
      this.pendingDrain = callback;
      return;
    }
    callback();
  }

  private flushPendingWrite(): void {
    const pending = this.pendingWrite;
    if (!pending) return;
    this.pendingWrite = undefined;
    this.sendData(pending.chunk, pending.callback);
  }

  private observeBytes(
    direction: ObservationDirection,
    chunk: Uint8Array,
  ): void {
    if (!this.options.measure) return;
    const observedAt = this.options.now();
    const metric = this.metrics[direction];
    metric.bytes += chunk.byteLength;
    metric.lastByteAt = observedAt;
    if (metric.firstByteAt !== undefined) return;
    metric.firstByteAt = observedAt;
    this.options.emit("channel.first-byte", {
      direction,
      bytes: chunk.byteLength,
    });
  }

  private transferFields(): ObservationFields {
    return {
      ...directionFields(
        "subscriberToPublisher",
        this.openedAt,
        this.metrics["subscriber-to-publisher"],
      ),
      ...directionFields(
        "publisherToSubscriber",
        this.openedAt,
        this.metrics["publisher-to-subscriber"],
      ),
    };
  }
}

export function createMuxSubscriber(
  outer: OuterStream,
  options: MuxSubscriberOptions = {},
): RunningMuxSubscriber {
  const mux = new Protomux(outer);
  const now = options.now ?? Date.now;
  const outerId = options.outerId ?? createObservationId("outer");

  return {
    async open(serviceId: string): Promise<Duplex> {
      const id = crypto.randomBytes(16);
      const emit = createObservationEmitter({
        observe: options.observe,
        role: "subscriber",
        outerId,
        channelId: b4a.toString(id, "hex"),
        serviceId,
        now,
      });
      const tunnel = createTunnel(
        mux,
        id,
        "subscriber",
        emit,
        options.observe !== undefined,
        now,
        options.transportSnapshot,
        (status) => {
          if (status === "") {
            tunnel.stream.accept();
            emit("channel.open-ok", transportFields(options.transportSnapshot));
          } else {
            emit("channel.open-error", {
              error: status,
              ...transportFields(options.transportSnapshot),
            });
            tunnel.stream.reject(status);
          }
        },
      );
      emit("channel.open");
      tunnel.channel.open(serviceId);
      await tunnel.stream.ready;
      return tunnel.stream;
    },
    close(): void {
      outer.destroy();
    },
  };
}

export function createMuxPublisher(
  outer: OuterStream,
  options: MuxPublisherOptions,
): RunningMuxPublisher {
  const mux = new Protomux(outer);
  const now = options.now ?? Date.now;
  const outerId = options.outerId ?? createObservationId("outer");

  mux.pair({ protocol }, (id) => {
    let serviceId: string | undefined;
    const emitBase = createObservationEmitter({
      observe: options.observe,
      role: "publisher",
      outerId,
      channelId: b4a.toString(id, "hex"),
      now,
    });
    const emit: EmitObservation = (event, fields = {}) =>
      emitBase(event, {
        ...(serviceId ? { serviceId } : {}),
        ...fields,
      });
    const tunnel = createTunnel(
      mux,
      id,
      "publisher",
      emit,
      options.observe !== undefined,
      now,
      options.transportSnapshot,
      () => undefined,
      async (openedServiceId) => {
        serviceId = openedServiceId;
        emit("channel.open");
        try {
          const target = await options.connect(openedServiceId);
          tunnel.stream.accept();
          tunnel.messages.status.send("");
          emit("channel.open-ok", transportFields(options.transportSnapshot));
          bridge(tunnel.stream, target);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          tunnel.stream.accept();
          tunnel.messages.status.send(message);
          emit("channel.open-error", {
            error: message,
            ...transportFields(options.transportSnapshot),
          });
          queueMicrotask(() => tunnel.channel.close());
        }
      },
    );
    tunnel.channel.open("");
  });

  return {
    close(): void {
      mux.unpair({ protocol });
      outer.destroy();
    },
  };
}

function createTunnel(
  mux: MuxInstance,
  id: Uint8Array,
  role: ObservationRole,
  emit: EmitObservation,
  measure: boolean,
  now: () => number,
  transportSnapshot: (() => unknown) | undefined,
  onStatus: (status: string) => void,
  onOpen?: (serviceId: string) => void | Promise<void>,
): { channel: MuxChannel; messages: TunnelMessages; stream: MuxTunnel } {
  const stream = new MuxTunnel({
    emit,
    measure,
    now,
    incomingDirection:
      role === "subscriber"
        ? "publisher-to-subscriber"
        : "subscriber-to-publisher",
    outgoingDirection:
      role === "subscriber"
        ? "subscriber-to-publisher"
        : "publisher-to-subscriber",
    transportSnapshot,
  });
  const channel = mux.createChannel({
    protocol,
    id,
    handshake: compact.string,
    onopen: onOpen,
    onclose: () => stream.remoteClose(),
    ondrain: () => stream.outerDrain(),
  });
  if (!channel) {
    throw new Error("Unable to create multiplex channel");
  }

  const messages: TunnelMessages = {
    status: channel.addMessage({
      encoding: compact.string,
      onmessage: onStatus,
    }),
    data: channel.addMessage({
      encoding: compact.buffer,
      onmessage: (chunk) => stream.receive(chunk),
    }),
    fin: channel.addMessage({
      encoding: compact.none,
      onmessage: () => stream.receiveFin(),
    }),
    reset: channel.addMessage({
      encoding: compact.string,
      onmessage: (message) => stream.receiveReset(message),
    }),
    pause: channel.addMessage({
      encoding: compact.none,
      onmessage: () => stream.receivePause(),
    }),
    resume: channel.addMessage({
      encoding: compact.none,
      onmessage: () => stream.receiveResume(),
    }),
  };
  stream.attach(channel, messages);
  return { channel, messages, stream };
}

function transportFields(
  snapshot: (() => unknown) | undefined,
): ObservationFields {
  if (!snapshot) return {};
  try {
    const transport = snapshot();
    return transport === undefined ? {} : { transport };
  } catch {
    return {};
  }
}

function bridge(tunnel: MuxTunnel, target: Duplex): void {
  tunnel.pipe(target);
  target.pipe(tunnel);
  tunnel.once("error", (error) => target.destroy(error));
  target.once("error", (error) => tunnel.closeFrom("target.error", error));
  tunnel.once("close", () => target.destroy());
  target.once("close", () => tunnel.closeFrom("target.close"));
}

function directionFields(
  prefix: "subscriberToPublisher" | "publisherToSubscriber",
  openedAt: number,
  metric: {
    bytes: number;
    firstByteAt?: number;
    lastByteAt?: number;
  },
): ObservationFields {
  const fields: ObservationFields = {
    [`${prefix}Bytes`]: metric.bytes,
  };
  if (
    metric.firstByteAt === undefined ||
    metric.lastByteAt === undefined
  ) {
    return fields;
  }
  const transferMs = metric.lastByteAt - metric.firstByteAt;
  return {
    ...fields,
    [`${prefix}FirstByteMs`]: metric.firstByteAt - openedAt,
    [`${prefix}TransferMs`]: transferMs,
    [`${prefix}BytesPerSecond`]: Math.round(
      (metric.bytes * 1_000) / Math.max(1, transferMs),
    ),
  };
}
