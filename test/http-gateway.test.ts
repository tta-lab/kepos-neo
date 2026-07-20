import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_GATEWAY_PORT } from "../src/home/gateway.js";

test("HTTP gateway has a fixed default port", () => {
  assert.equal(DEFAULT_GATEWAY_PORT, 17_480);
});
