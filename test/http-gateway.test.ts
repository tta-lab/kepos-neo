import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_GATEWAY_PORT,
  startHttpGateway,
} from "../src/home/gateway.js";

test("HTTP gateway has a fixed default port", () => {
  assert.equal(DEFAULT_GATEWAY_PORT, 17_480);
});

test("HTTP gateway reports unavailable when tunnel acquisition times out", async () => {
  const gateway = await startHttpGateway({
    port: 0,
    acquisitionTimeoutMs: 5,
    open: async () => new Promise<never>(() => undefined),
  });

  try {
    const response = await fetch(
      `http://navidrome.localhost:${gateway.port}/rest/ping`,
    );
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "1");
  } finally {
    await new Promise<void>((resolve, reject) => {
      gateway.server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
