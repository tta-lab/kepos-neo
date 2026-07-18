import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";

import {
  createDht,
  dhtStreamSnapshot,
  keyPairFromSecretKey,
  type DhtAddress,
  type DhtStream,
} from "../mux/hyperdht.js";
import {
  createObservationEmitter,
  createObservationId,
  type EmitObservation,
  type Observe,
} from "../mux/observability.js";
import {
  connectionOptionsForRoute,
  type Route,
} from "../mux/route.js";
import {
  createMuxSubscriber,
  type RunningMuxSubscriber,
} from "../mux/transport.js";
import { loadSubscriberState } from "../state/subscriber.js";

export interface SubscriberService {
  id: string;
  localPort: number;
}

export interface RunningSubscriberService {
  id: string;
  port: number;
}

export interface StartSubscriberOptions {
  stateDir: string;
  bootstrap?: DhtAddress[];
  services: SubscriberService[];
  log?: (line: string) => void;
  now?: () => number;
  observe?: Observe;
  route?: Route;
  sleep?: (delayMs: number) => Promise<void>;
}

export type SubscriberConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "stopped";

export interface SubscriberRuntimeStatus {
  role: "subscriber";
  state: "running" | "stopped";
  connection: SubscriberConnectionStatus;
  publisherKey: string;
  homeUrl: string;
  services: RunningSubscriberService[];
}

export interface RunningSubscriber {
  publisherKey: string;
  home: {
    port: number;
    url: string;
  };
  services: RunningSubscriberService[];
  status: () => SubscriberRuntimeStatus;
  stop: () => Promise<void>;
}

interface ServiceOpener {
  open: (serviceId: string) => Promise<Duplex>;
}

export async function startSubscriber(
  options: StartSubscriberOptions,
): Promise<RunningSubscriber> {
  const { contact, identity } = await loadSubscriberState(options.stateDir);
  const keyPair = keyPairFromSecretKey(identity.secretKey);
  const dht = createDht({ bootstrap: options.bootstrap, keyPair });
  const now = options.now ?? Date.now;
  const route = options.route ?? "auto";
  const connection = createPublisherConnection({
    connect: () =>
      dht.connect(Buffer.from(contact.publisherKey, "hex"), {
        keyPair,
        ...connectionOptionsForRoute(route),
      }),
    log: options.log,
    now,
    observe: options.observe,
    route,
    sleep: options.sleep ?? delay,
  });
  const servers: Server[] = [];
  let stopped = false;

  try {
    await connection.start();

    const homeServer = await listenService(
      "home",
      contact.requestedLocalPort,
      connection,
    );
    servers.push(homeServer.server);
    const services: RunningSubscriberService[] = [];
    for (const service of options.services) {
      const listener = await listenService(
        service.id,
        service.localPort,
        connection,
      );
      servers.push(listener.server);
      services.push({ id: service.id, port: listener.port });
    }

    options.log?.(`Local Home ready @http://127.0.0.1:${homeServer.port}`);
    for (const service of services) {
      options.log?.(`Local ${service.id} ready @127.0.0.1:${service.port}`);
    }

    return {
      publisherKey: contact.publisherKey,
      home: {
        port: homeServer.port,
        url: `http://127.0.0.1:${homeServer.port}`,
      },
      services,
      status: () => ({
        role: "subscriber",
        state: stopped ? "stopped" : "running",
        connection: connection.status(),
        publisherKey: contact.publisherKey,
        homeUrl: `http://127.0.0.1:${homeServer.port}`,
        services: services.map((service) => ({ ...service })),
      }),
      async stop(): Promise<void> {
        if (stopped) return;
        stopped = true;
        await Promise.allSettled(servers.map(closeServer));
        await connection.stop();
        await dht.destroy({ force: true });
      },
    };
  } catch (error) {
    await connection.stop();
    await Promise.allSettled([
      ...servers.map(closeServer),
      dht.destroy({ force: true }),
    ]);
    throw error;
  }
}

async function listenService(
  serviceId: string,
  port: number,
  connection: ServiceOpener,
): Promise<{ port: number; server: Server }> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.pause();
    void openAndBridge(socket, connection, serviceId);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error(`Local ${serviceId} listener address is unavailable`);
  }
  return { port: address.port, server };
}

async function openAndBridge(
  socket: Socket,
  connection: ServiceOpener,
  serviceId: string,
): Promise<void> {
  try {
    const tunnel = await connection.open(serviceId);
    if (socket.destroyed) {
      tunnel.destroy();
      return;
    }
    socket.pipe(tunnel);
    tunnel.pipe(socket);
    socket.once("error", (error) => tunnel.destroy(error));
    tunnel.once("error", (error) => socket.destroy(error));
    socket.once("close", () => tunnel.destroy());
    tunnel.once("close", () => socket.destroy());
    socket.resume();
  } catch {
    socket.destroy();
  }
}

export function createPublisherConnection(options: {
  connect: () => DhtStream;
  log?: (line: string) => void;
  now: () => number;
  observe?: Observe;
  route: Route;
  sleep: (delayMs: number) => Promise<void>;
}): ServiceOpener & {
  start: () => Promise<void>;
  status: () => SubscriberConnectionStatus;
  stop: () => Promise<void>;
} {
  let current:
    | { mux: RunningMuxSubscriber; outer: DhtStream }
    | undefined;
  let reconnecting: Promise<RunningMuxSubscriber> | undefined;
  let connectingOuter: DhtStream | undefined;
  let stopped = false;
  let connectionAttempt = 0;

  const install = (
    outer: DhtStream,
    mux: RunningMuxSubscriber,
    observe: EmitObservation,
  ): RunningMuxSubscriber => {
    current = { outer, mux };
    let streamError: string | undefined;
    outer.once("error", (error) => {
      streamError = error.message;
    });
    outer.once("close", () => {
      if (current?.outer !== outer) return;
      current = undefined;
      observe("outer.closed", {
        trigger: stopped
          ? "local.stop"
          : streamError
            ? "stream.error"
            : "stream.close",
        ...(streamError ? { error: streamError } : {}),
      });
      if (!stopped) {
        options.log?.("Publisher connection closed; reconnecting");
        void reconnect().catch(() => undefined);
      }
    });
    return mux;
  };

  const connectOnce = async (
    onFailure?: (observe: EmitObservation) => void,
  ): Promise<{
    mux: RunningMuxSubscriber;
    observe: EmitObservation;
  }> => {
    const attempt = ++connectionAttempt;
    const attemptStartedAt = options.now();
    const outerId = createObservationId("outer");
    const observe = createObservationEmitter({
      observe: options.observe,
      role: "subscriber",
      outerId,
      now: options.now,
      route: options.route,
    });
    observe("outer.attempt", { attempt });
    const outer = options.connect();
    connectingOuter = outer;
    const reportHandshake = observeHandshake(
      outer,
      observe,
      attempt,
      attemptStartedAt,
      options.now,
    );
    try {
      await waitForConnect(outer);
      if (stopped) {
        outer.destroy();
        throw new Error("Subscriber stopped");
      }
      outer.setKeepAlive?.(10_000);
      reportHandshake();
      observe("outer.connected", {
        attempt,
        attemptElapsedMs: options.now() - attemptStartedAt,
        transport: dhtStreamSnapshot(outer),
      });
      return {
        observe,
        mux: install(
          outer,
          createMuxSubscriber(outer, {
            outerId,
            now: options.now,
            observe: options.observe,
            transportSnapshot: () => dhtStreamSnapshot(outer),
          }),
          observe,
        ),
      };
    } catch (error) {
      const failure = stopped
        ? new Error("Subscriber stopped")
        : error instanceof Error
          ? error
          : new Error(String(error));
      observe("outer.closed", {
        trigger: "connect.error",
        error: failure.message,
        attempt,
        attemptElapsedMs: options.now() - attemptStartedAt,
      });
      onFailure?.(observe);
      outer.destroy();
      throw failure;
    } finally {
      if (connectingOuter === outer) connectingOuter = undefined;
    }
  };

  const reconnect = (): Promise<RunningMuxSubscriber> => {
    if (current) return Promise.resolve(current.mux);
    if (reconnecting) return reconnecting;
    reconnecting = (async () => {
      let delayMs = 100;
      const recoveryStartedAt = options.now();
      let recoveryAttempt = 0;
      while (!stopped) {
        recoveryAttempt++;
        let failedAttemptObserve: EmitObservation | undefined;
        try {
          const { mux, observe } = await connectOnce((failedObserve) => {
            failedAttemptObserve = failedObserve;
          });
          options.log?.("Publisher connection restored");
          observe("outer.restored", {
            recoveryAttempt,
            recoveryElapsedMs: options.now() - recoveryStartedAt,
          });
          return mux;
        } catch (error) {
          if (stopped) throw error;
          const message =
            error instanceof Error ? error.message : String(error);
          failedAttemptObserve?.("outer.retry", {
            recoveryAttempt,
            delayMs,
            error: message,
            recoveryElapsedMs: options.now() - recoveryStartedAt,
          });
          options.log?.(
            `Publisher reconnect failed; retrying: ${message}`,
          );
          await options.sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 2_000);
        }
      }
      throw new Error("Subscriber stopped");
    })().finally(() => {
      reconnecting = undefined;
    });
    return reconnecting;
  };

  return {
    async start(): Promise<void> {
      await connectOnce();
    },
    async open(serviceId: string): Promise<Duplex> {
      while (!stopped) {
        const activeConnection = current;
        const active = activeConnection?.mux ?? (await reconnect());
        try {
          return await active.open(serviceId);
        } catch (error) {
          if (
            current?.mux === active &&
            !activeConnection?.outer.destroyed
          ) {
            throw error;
          }
        }
      }
      throw new Error("Subscriber stopped");
    },
    status(): SubscriberConnectionStatus {
      if (stopped) return "stopped";
      if (current) return "connected";
      if (reconnecting) return "reconnecting";
      return "connecting";
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      connectingOuter?.destroy();
      current?.mux.close();
      current = undefined;
      await reconnecting?.catch(() => undefined);
    },
  };
}

function observeHandshake(
  stream: DhtStream,
  observe: EmitObservation,
  attempt: number,
  attemptStartedAt: number,
  now: () => number,
): () => void {
  let reported = false;
  const report = (): void => {
    if (reported) return;
    reported = true;
    observe("outer.handshake", {
      attempt,
      attemptElapsedMs: now() - attemptStartedAt,
      transport: dhtStreamSnapshot(stream),
    });
  };
  if (stream.connected) {
    report();
    return report;
  }
  stream.once("handshake", report);
  return report;
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForConnect(stream: DhtStream): Promise<void> {
  if (stream.connected) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      stream.off("connect", onConnect);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Publisher connection closed before handshake"));
    };
    stream.once("connect", onConnect);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
