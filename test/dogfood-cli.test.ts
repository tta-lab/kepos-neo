import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { parseDogfoodClientCliOptions } from "../src/dogfood/client.js";
import { parseDogfoodPublisherCliOptions } from "../src/dogfood/publisher.js";

test("publisher CLI selects role-local state", () => {
  assert.deepEqual(parseDogfoodPublisherCliOptions(["--state", "./publisher"]), {
    stateDir: path.resolve("./publisher"),
  });
});

test("subscriber CLI maps several local services onto one publisher connection", () => {
  assert.deepEqual(
    parseDogfoodClientCliOptions([
      "--state",
      "./subscriber",
      "--service",
      "ssh:2222",
      "--service",
      "navidrome:4533",
    ]),
    {
      stateDir: path.resolve("./subscriber"),
      services: [
        { id: "ssh", localPort: 2222 },
        { id: "navidrome", localPort: 4533 },
      ],
    },
  );
});

test("subscriber CLI rejects duplicate service ids", () => {
  assert.throws(
    () =>
      parseDogfoodClientCliOptions([
        "--service",
        "ssh:2222",
        "--service",
        "ssh:2223",
      ]),
    /unique|duplicate/i,
  );
});

test("subscriber CLI rejects the reserved Home service id", () => {
  assert.throws(
    () => parseDogfoodClientCliOptions(["--service", "home:8080"]),
    /reserved|identifier/i,
  );
});
