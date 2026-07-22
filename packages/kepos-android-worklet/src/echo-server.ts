import * as b4a from "b4a";
import { createServer, type NetServer } from "bare-net";

const maximumHeaderBytes = 16 * 1024;
const response =
  "HTTP/1.1 200 OK\r\n" +
  "Content-Type: text/plain; charset=utf-8\r\n" +
  "Content-Length: 16\r\n" +
  "Connection: close\r\n" +
  "\r\n" +
  "kepos worklet ok\n";

export interface RunningEchoServer {
  close(): Promise<void>;
  url: string;
}

export async function startEchoServer(port = 17_482): Promise<RunningEchoServer> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let header = "";
    socket.on("data", (chunk) => {
      if (!(chunk instanceof Uint8Array)) {
        socket.destroy(new Error("HTTP request chunk is not binary data"));
        return;
      }
      header += b4a.toString(chunk, "latin1");
      if (header.length > maximumHeaderBytes) {
        socket.destroy(new Error("HTTP request header is too large"));
        return;
      }
      if (!header.includes("\r\n\r\n")) return;
      socket.end(response);
    });
  });
  await listen(server, port);
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => close(server),
  };
}

async function listen(server: NetServer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function close(server: NetServer): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
