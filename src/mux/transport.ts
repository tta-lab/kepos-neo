import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";

const require = createRequire(import.meta.url);
const Protomux = require("protomux") as ProtomuxConstructor;
const compact = require("compact-encoding") as CompactEncoding;

const protocol = "kepos/tcp/1";

interface Encoding<T> {
  decode: (state: unknown) => T;
  encode: (state: unknown, value: T) => void;
  preencode: (state: unknown, value: T) => void;
}

interface CompactEncoding {
  buffer: Encoding<Buffer>;
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
    id: Buffer;
    handshake: Encoding<string>;
    onopen?: (handshake: string) => void | Promise<void>;
    onclose?: () => void;
    ondrain?: () => void;
  }) => MuxChannel | null;
  pair: (
    options: { protocol: string },
    callback: (id: Buffer) => void | Promise<void>,
  ) => void;
  unpair: (options: { protocol: string }) => void;
}

interface ProtomuxConstructor {
  new (stream: OuterStream): MuxInstance;
}

interface TunnelMessages {
  data: MuxMessage<Buffer>;
  fin: MuxMessage<null>;
  pause: MuxMessage<null>;
  reset: MuxMessage<string>;
  resume: MuxMessage<null>;
  status: MuxMessage<string>;
}

export interface MuxPublisherOptions {
  connect: (serviceId: string) => Promise<Duplex>;
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
    chunk: Buffer;
    callback: (error?: Error | null) => void;
  };
  private pendingDrain?: (error?: Error | null) => void;
  private remoteClosing = false;

  constructor() {
    super({ allowHalfOpen: true });
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
    this.destroy();
  }

  receive(chunk: Buffer): void {
    if (this.destroyed) return;
    if (!this.push(Buffer.from(chunk)) && !this.localPaused) {
      this.localPaused = true;
      this.messages?.pause.send(null);
    }
  }

  receiveFin(): void {
    if (!this.destroyed) this.push(null);
  }

  receivePause(): void {
    this.remotePaused = true;
  }

  receiveResume(): void {
    this.remotePaused = false;
    this.flushPendingWrite();
  }

  receiveReset(message: string): void {
    this.remoteClosing = true;
    this.destroy(new Error(message || "Remote tunnel reset"));
  }

  remoteClose(): void {
    this.remoteClosing = true;
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

  override _read(): void {
    if (!this.localPaused) return;
    this.localPaused = false;
    this.messages?.resume.send(null);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const copy = Buffer.from(chunk);
    if (this.remotePaused) {
      this.pendingWrite = { chunk: copy, callback };
      return;
    }
    this.sendData(copy, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
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
      this.messages?.reset.send(error.message);
    }
    this.channel?.close();
    callback(error);
  }

  private sendData(
    chunk: Buffer,
    callback: (error?: Error | null) => void,
  ): void {
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
}

export function createMuxSubscriber(
  outer: OuterStream,
): RunningMuxSubscriber {
  const mux = new Protomux(outer);

  return {
    async open(serviceId: string): Promise<Duplex> {
      const tunnel = createTunnel(mux, randomBytes(16), (status) => {
        if (status === "") tunnel.stream.accept();
        else tunnel.stream.reject(status);
      });
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

  mux.pair({ protocol }, (id) => {
    const tunnel = createTunnel(mux, id, () => undefined, async (serviceId) => {
      try {
        const target = await options.connect(serviceId);
        tunnel.stream.accept();
        tunnel.messages.status.send("");
        bridge(tunnel.stream, target);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        tunnel.stream.accept();
        tunnel.messages.status.send(message);
        queueMicrotask(() => tunnel.channel.close());
      }
    });
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
  id: Buffer,
  onStatus: (status: string) => void,
  onOpen?: (serviceId: string) => void | Promise<void>,
): { channel: MuxChannel; messages: TunnelMessages; stream: MuxTunnel } {
  const stream = new MuxTunnel();
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

function bridge(tunnel: MuxTunnel, target: Duplex): void {
  tunnel.pipe(target);
  target.pipe(tunnel);
  tunnel.once("error", (error) => target.destroy(error));
  target.once("error", (error) => tunnel.destroy(error));
  tunnel.once("close", () => target.destroy());
  target.once("close", () => tunnel.destroy());
}
