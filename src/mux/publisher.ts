import { readFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import path from "node:path";

import {
  parsePublisherConfig,
  parsePublisherManifest,
} from "../config.js";
import { startMuxHomeServer, type RunningHomeServer } from "../home/server.js";
import { createMuxPublisher, type RunningMuxPublisher } from "./transport.js";
import {
  createDht,
  keyPairFromSeed,
  type DhtAddress,
  type DhtStream,
} from "./hyperdht.js";

export interface StartMuxPublisherOptions {
  stateDir?: string;
  bootstrap?: DhtAddress[];
  log?: (line: string) => void;
}

export interface RunningMuxPublisherDaemon {
  publisherKey: string;
  home: RunningHomeServer;
  acceptedConnections: () => number;
  activeSubscribers: () => number;
  stop: () => Promise<void>;
}

export async function startMuxPublisher(
  options: StartMuxPublisherOptions = {},
): Promise<RunningMuxPublisherDaemon> {
  const stateDir = path.resolve(
    options.stateDir ?? path.join("tmp", "dogfood", "publisher"),
  );
  const manifest = parsePublisherManifest(
    JSON.parse(
      await readFile(path.join(stateDir, "publisher.manifest.json"), "utf8"),
    ) as unknown,
  );
  const config = parsePublisherConfig(
    JSON.parse(
      await readFile(path.join(stateDir, manifest.publisherConfig), "utf8"),
    ) as unknown,
  );
  const keyPair = keyPairFromSeed(config.seed);
  const publisherKey = keyPair.publicKey.toString("hex");
  const home = await startMuxHomeServer({
    publisherKey,
    displayName: manifest.displayName,
    services: manifest.services.map(({ id, name, kind }) => ({
      id,
      name,
      kind,
    })),
  });
  const targets = new Map<string, number>([
    ["home", home.port],
    ...manifest.services.map(
      (service): [string, number] => [service.id, service.targetPort],
    ),
  ]);
  const allow = new Set(config.allow);
  const dht = createDht({ bootstrap: options.bootstrap, keyPair });
  const streams = new Set<DhtStream>();
  const muxes = new Map<DhtStream, RunningMuxPublisher>();
  let accepted = 0;
  let stopped = false;

  const server = dht.createServer(
    {
      firewall: (remotePublicKey) =>
        !allow.has(remotePublicKey.toString("hex")),
      reusableSocket: true,
    },
    (stream) => {
      accepted++;
      streams.add(stream);
      stream.setKeepAlive?.(10_000);
      const mux = createMuxPublisher(stream, {
        connect: async (serviceId) => {
          const targetPort = targets.get(serviceId);
          if (targetPort === undefined) {
            throw new Error(`Service is not published: ${serviceId}`);
          }
          return connectLoopback(targetPort);
        },
      });
      muxes.set(stream, mux);
      stream.once("close", () => {
        streams.delete(stream);
        muxes.delete(stream);
      });
    },
  );

  try {
    await server.listen(keyPair);
  } catch (error) {
    await Promise.allSettled([home.close(), dht.destroy({ force: true })]);
    throw error;
  }

  options.log?.(`Publisher ready: ${publisherKey}`);

  return {
    publisherKey,
    home,
    acceptedConnections: () => accepted,
    activeSubscribers: () => streams.size,
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const mux of muxes.values()) mux.close();
      await Promise.allSettled([
        server.close(),
        home.close(),
        dht.destroy({ force: true }),
      ]);
    },
  };
}

async function connectLoopback(port: number): Promise<Socket> {
  const socket = createConnection({
    host: "127.0.0.1",
    port,
    allowHalfOpen: true,
  });
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      socket.off("error", onError);
      resolve();
    };
    const onError = (error: Error): void => {
      socket.off("connect", onConnect);
      reject(error);
    };
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
  return socket;
}
