import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePublisherConfig } from "../config.js";
import { derivePublisherHomeKey } from "../keys.js";
import {
  createHomeRegistry,
  type CreateHomeRegistryOptions,
  type HomeRegistryService,
} from "./registry.js";

const host = "127.0.0.1" as const;
const registryPath = "/.well-known/kepos/services.json";
const benchmarkPath = "/.well-known/kepos/benchmark";
const benchmarkChunk = Buffer.alloc(64 * 1024);
const maxBenchmarkBytes = 64 * 1024 * 1024;
const defaultHomeDirectory = fileURLToPath(new URL("../../home/", import.meta.url));

export interface RunningHomeServer {
  host: typeof host;
  port: number;
  url: string;
  close: () => Promise<void>;
}

export interface StartHomeServerOptions {
  homeKey: string;
  port?: number;
  displayName?: string;
  services?: HomeRegistryService[];
}

export interface HomeCliOptions {
  publisherPath: string;
  port: number;
}

export function parseHomeCliOptions(arguments_: readonly string[]): HomeCliOptions {
  const publisherPath = path.resolve(arguments_[0] ?? path.join("tmp", "p0", "publisher.json"));
  if (arguments_.length <= 1) return { publisherPath, port: 0 };
  if (arguments_[1] !== "--port" || arguments_.length !== 3) {
    throw new Error("Home CLI accepts only --port after the publisher path");
  }

  const port = Number(arguments_[2]);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("port must be an integer from 0 through 65535");
  }

  return { publisherPath, port };
}

function send(
  response: ServerResponse,
  statusCode: number,
  contentType: string,
  body: string | Buffer,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": contentType,
    ...headers,
  });
  response.end(body);
}

async function sendBenchmark(response: ServerResponse, bytes: number): Promise<void> {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-length": String(bytes),
    "content-type": "application/octet-stream",
    "x-kepos-benchmark-bytes": String(bytes),
  });

  let remaining = bytes;
  while (remaining > 0) {
    const size = Math.min(remaining, benchmarkChunk.byteLength);
    if (!response.write(benchmarkChunk.subarray(0, size))) {
      await once(response, "drain");
    }
    remaining -= size;
  }
  response.end();
}

export async function startHomeServer({
  homeKey,
  port = 0,
  displayName = "Local Publisher",
  services = [],
}: StartHomeServerOptions): Promise<RunningHomeServer> {
  const registryOptions: CreateHomeRegistryOptions = { displayName, services };
  const registry = createHomeRegistry(homeKey, registryOptions);
  const registryEtag = `"${registry.revision}"`;
  const [homeHtml, homeCss] = await Promise.all([
    readFile(path.join(defaultHomeDirectory, "index.html")),
    readFile(path.join(defaultHomeDirectory, "styles.css")),
  ]);

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (request.method !== "GET") {
      send(response, 404, "text/plain; charset=utf-8", "Not Found\n");
      return;
    }
    if (pathname === "/") {
      send(response, 200, "text/html; charset=utf-8", homeHtml);
      return;
    }
    if (pathname === "/styles.css") {
      send(response, 200, "text/css; charset=utf-8", homeCss);
      return;
    }
    if (pathname === registryPath) {
      if (request.headers["if-none-match"] === registryEtag) {
        response.writeHead(304, { etag: registryEtag });
        response.end();
        return;
      }

      send(
        response,
        200,
        "application/json; charset=utf-8",
        `${JSON.stringify(registry, null, 2)}\n`,
        { etag: registryEtag },
      );
      return;
    }
    if (pathname === "/healthz") {
      send(response, 200, "text/plain; charset=utf-8", "ok\n");
      return;
    }
    if (pathname === benchmarkPath) {
      const rawBytes = url.searchParams.get("bytes");
      const bytes = Number(rawBytes);
      if (
        rawBytes === null ||
        !/^\d+$/.test(rawBytes) ||
        !Number.isSafeInteger(bytes) ||
        bytes < 1 ||
        bytes > maxBenchmarkBytes
      ) {
        send(response, 400, "text/plain; charset=utf-8", "bytes must be an integer from 1 through 67108864\n");
        return;
      }

      void sendBenchmark(response, bytes).catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      return;
    }

    send(response, 404, "text/plain; charset=utf-8", "Not Found\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Home server address is unavailable");
  }

  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function runHomeCli(): Promise<void> {
  const { publisherPath, port } = parseHomeCliOptions(process.argv.slice(2));
  const publisher = parsePublisherConfig(JSON.parse(await readFile(publisherPath, "utf8")) as unknown);
  const home = await startHomeServer({ homeKey: derivePublisherHomeKey(publisher.seed), port });
  console.log(`Home ready @${home.url}`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  runHomeCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
