import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { createHomeRegistry } from "../src/home/registry.js";
import * as homeServerModule from "../src/home/server.js";

const { startHomeServer } = homeServerModule;

const homeKey = "ab".repeat(32);
const sshKey = "cd".repeat(32);

test("Home CLI accepts a fixed loopback port", () => {
  const parseHomeCliOptions = (
    homeServerModule as typeof homeServerModule & {
      parseHomeCliOptions?: (arguments_: readonly string[]) => {
        publisherPath: string;
        port: number;
      };
    }
  ).parseHomeCliOptions;
  assert.equal(typeof parseHomeCliOptions, "function");
  assert.deepEqual(parseHomeCliOptions?.(["publisher.json", "--port", "18080"]), {
    publisherPath: path.resolve("publisher.json"),
    port: 18080,
  });
});

test("Home CLI rejects an invalid fixed port", () => {
  assert.throws(
    () => homeServerModule.parseHomeCliOptions(["publisher.json", "--port", "not-a-port"]),
    /port/i,
  );
});

test("Home Registry has the P0 schema and binds its service to the Home key", () => {
  const registry = createHomeRegistry(homeKey);

  assert.deepEqual(registry, {
    schemaVersion: 1,
    revision: 1,
    publisher: {
      displayName: "Local Publisher",
    },
    services: [
      {
        id: "home",
        name: "Home",
        kind: "http",
        serviceKey: homeKey,
      },
    ],
  });

  const serialized = JSON.stringify(registry);
  for (const forbiddenField of ["target", "host", "port", "command", "script", "clientKey", "seed", "secret"]) {
    assert.equal(serialized.includes(`\"${forbiddenField}\"`), false, forbiddenField);
  }
});

test("Home Registry rejects a malformed Home key", () => {
  assert.throws(() => createHomeRegistry("not-a-home-key"), /home key/i);
});

test("Home Registry lists configured TCP services without publisher-local targets", () => {
  const registry = createHomeRegistry(homeKey, {
    displayName: "kosmos",
    services: [{ id: "ssh", name: "SSH", kind: "tcp", serviceKey: sshKey }],
  });

  assert.deepEqual(registry, {
    schemaVersion: 1,
    revision: 1,
    publisher: { displayName: "kosmos" },
    services: [
      { id: "home", name: "Home", kind: "http", serviceKey: homeKey },
      { id: "ssh", name: "SSH", kind: "tcp", serviceKey: sshKey },
    ],
  });
  const serialized = JSON.stringify(registry);
  for (const forbidden of ["targetPort", "targetHost", "config", "seed", "secret"]) {
    assert.equal(serialized.includes(`"${forbidden}"`), false, forbidden);
  }
});

test("Home Registry rejects duplicate, reserved, or malformed public services", () => {
  const ssh = { id: "ssh", name: "SSH", kind: "tcp" as const, serviceKey: sshKey };

  assert.throws(
    () => createHomeRegistry(homeKey, { displayName: "kosmos", services: [ssh, ssh] }),
    /duplicate|service/i,
  );
  assert.throws(
    () =>
      createHomeRegistry(homeKey, {
        displayName: "kosmos",
        services: [{ ...ssh, id: "home" }],
      }),
    /reserved|service/i,
  );
  assert.throws(
    () =>
      createHomeRegistry(homeKey, {
        displayName: "kosmos",
        services: [{ ...ssh, serviceKey: "bad" }],
      }),
    /serviceKey|key/i,
  );
});

test("Home server exposes the configured Registry", async () => {
  const home = await startHomeServer({
    homeKey,
    displayName: "kosmos",
    services: [{ id: "ssh", name: "SSH", kind: "tcp", serviceKey: sshKey }],
  });
  try {
    const response = await fetch(`${home.url}/.well-known/kepos/services.json`);
    assert.deepEqual(
      await response.json(),
      createHomeRegistry(homeKey, {
        displayName: "kosmos",
        services: [{ id: "ssh", name: "SSH", kind: "tcp", serviceKey: sshKey }],
      }),
    );
  } finally {
    await home.close();
  }
});

async function withHome(run: (home: Awaited<ReturnType<typeof startHomeServer>>) => Promise<void>): Promise<void> {
  const home = await startHomeServer({ homeKey });
  try {
    await run(home);
  } finally {
    await home.close();
  }
}

test("Home server binds only to an ephemeral loopback port", async () => {
  await withHome(async (home) => {
    assert.equal(home.host, "127.0.0.1");
    assert.equal(Number.isInteger(home.port), true);
    assert.equal(home.port > 0, true);
    assert.equal(home.url, `http://127.0.0.1:${home.port}`);
  });
});

test("Home server serves the default Home HTML", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(body, /Local Publisher/);
    assert.match(body, /Home/);
    assert.match(body, /\.well-known\/kepos\/services\.json/);
  });
});

test("Home server serves the local compiled stylesheet", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/styles.css`);
    const body = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
    assert.equal(body.length > 100, true);
  });
});

test("Home server serves the Registry with its revision ETag", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/.well-known/kepos/services.json`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("etag"), '"1"');
    assert.deepEqual(await response.json(), createHomeRegistry(homeKey));
  });
});

test("Home server returns an empty 304 for a matching Registry ETag", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/.well-known/kepos/services.json`, {
      headers: { "if-none-match": '"1"' },
    });

    assert.equal(response.status, 304);
    assert.equal(response.headers.get("etag"), '"1"');
    assert.equal(await response.text(), "");
  });
});

test("Home server serves the health check as plain text", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/healthz`);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "ok\n");
  });
});

test("Home server returns plain-text 404 for every other path", async () => {
  await withHome(async (home) => {
    const response = await fetch(`${home.url}/missing`);

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(await response.text(), "Not Found\n");
  });
});

test("default Home source stays local, semantic, and responsive", async () => {
  const html = await readFile(new URL("../home/index.html", import.meta.url), "utf8");
  const inputCss = await readFile(new URL("../home/styles.input.css", import.meta.url), "utf8");

  for (const component of ["navbar", "list", "link", "status"]) {
    assert.match(html, new RegExp(`class=[\"'][^\"']*\\b${component}\\b`), component);
  }
  for (const semanticColor of ["bg-base-100", "text-base-content", "border-base-300"]) {
    assert.match(html, new RegExp(`\\b${semanticColor}\\b`), semanticColor);
  }
  assert.match(html, /max-w-/);
  assert.match(html, /sm:/);
  assert.match(html, /class=["'][^"']*whitespace-nowrap[^"']*["'][^>]*>Available</i);
  assert.doesNotMatch(html, /<script\b|https?:\/\/|data-theme=|gradient|\bcard\b/i);

  assert.match(inputCss, /@import\s+["']tailwindcss["'];/);
  assert.match(inputCss, /@plugin\s+["']daisyui["'];/);
  assert.match(inputCss, /@source\s+["']\.\/index\.html["'];/);
  assert.doesNotMatch(inputCss, /daisyui\/theme|gradient/i);
});
