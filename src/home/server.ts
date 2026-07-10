import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parsePublisherConfig } from "../config.js";
import { derivePublisherHomeKey } from "../keys.js";
import { createHomeRegistry } from "./registry.js";

const host = "127.0.0.1" as const;
const registryPath = "/.well-known/kepos/services.json";
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

export async function startHomeServer({
  homeKey,
  port = 0,
}: StartHomeServerOptions): Promise<RunningHomeServer> {
  const registry = createHomeRegistry(homeKey);
  const registryEtag = `"${registry.revision}"`;
  const [homeHtml, homeCss] = await Promise.all([
    readFile(path.join(defaultHomeDirectory, "index.html")),
    readFile(path.join(defaultHomeDirectory, "styles.css")),
  ]);

  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

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
  const publisherPath = path.resolve(process.argv[2] ?? path.join("tmp", "p0", "publisher.json"));
  const publisher = parsePublisherConfig(JSON.parse(await readFile(publisherPath, "utf8")) as unknown);
  const home = await startHomeServer({ homeKey: derivePublisherHomeKey(publisher.seed) });
  console.log(`Home ready @${home.url}`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(path.resolve(invokedPath)).href) {
  runHomeCli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
