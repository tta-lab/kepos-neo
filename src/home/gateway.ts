import {
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { Duplex } from "node:stream";

export const DEFAULT_GATEWAY_PORT = 17_480;

const maximumHeaderBytes = 16 * 1024;
const headerTerminator = Buffer.from("\r\n\r\n");
const serviceHostPattern = /^([a-z][a-z0-9-]*)\.localhost(?::\d+)?$/i;

export interface StartHttpGatewayOptions {
  port?: number;
  open(serviceId: string): Promise<Duplex>;
}

export interface RunningHttpGateway {
  port: number;
  server: Server;
  url: string;
}

export async function startHttpGateway(
  options: StartHttpGatewayOptions,
): Promise<RunningHttpGateway> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    routeSocket(socket, options.open);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      options.port ?? DEFAULT_GATEWAY_PORT,
      "127.0.0.1",
      () => {
        server.off("error", reject);
        resolve();
      },
    );
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("HTTP gateway address is unavailable");
  }
  return {
    port: address.port,
    server,
    url: `http://home.localhost:${address.port}`,
  };
}

function routeSocket(
  socket: Socket,
  open: (serviceId: string) => Promise<Duplex>,
): void {
  let buffered = Buffer.alloc(0);
  let tunnel: Duplex | undefined;
  socket.setTimeout(10_000, () => socket.destroy());
  socket.on("error", (error) => tunnel?.destroy(error));
  socket.on("data", onData);

  function onData(chunk: Buffer): void {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > maximumHeaderBytes) {
      replyAndClose(socket, 431, "Request Header Fields Too Large");
      return;
    }
    const headerEnd = buffered.indexOf(headerTerminator);
    if (headerEnd === -1) return;

    socket.pause();
    socket.off("data", onData);
    const serviceId = parseServiceId(
      buffered.subarray(0, headerEnd).toString("latin1"),
    );
    if (!serviceId) {
      replyAndClose(socket, 421, "Misdirected Request");
      return;
    }
    void open(serviceId)
      .then((opened) => {
        tunnel = opened;
        if (socket.destroyed) {
          tunnel.destroy();
          return;
        }
        socket.setTimeout(0);
        tunnel.write(buffered);
        socket.pipe(tunnel);
        tunnel.pipe(socket);
        socket.once("close", () => tunnel?.destroy());
        tunnel.once("close", () => socket.destroy());
        tunnel.once("error", (error) => socket.destroy(error));
        socket.resume();
      })
      .catch(() => replyAndClose(socket, 502, "Bad Gateway"));
  }
}

function parseServiceId(header: string): string | null {
  const hosts = header
    .split("\r\n")
    .slice(1)
    .flatMap((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) return [];
      if (line.slice(0, separator).trim().toLowerCase() !== "host") {
        return [];
      }
      return [line.slice(separator + 1).trim()];
    });
  if (hosts.length !== 1) return null;
  return hosts[0].match(serviceHostPattern)?.[1]?.toLowerCase() ?? null;
}

function replyAndClose(
  socket: Socket,
  status: number,
  reason: string,
): void {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
