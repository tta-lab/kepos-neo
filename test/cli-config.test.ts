import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultCliConfigPath,
  loadCliConfig,
  parseCliConfig,
} from "../src/cli/config.js";

test("CLI config parses network bootstrap endpoints", () => {
  assert.deepEqual(
    parseCliConfig(`
[network]
bootstrap = ["47.94.213.63:49737", "dht.example.com:49738"]
`),
    {
      network: {
        bootstrap: [
          { host: "47.94.213.63", port: 49_737 },
          { host: "dht.example.com", port: 49_738 },
        ],
      },
    },
  );
});

test("CLI config parses publisher and subscriber policy", () => {
  const subscriberKey = "11".repeat(32);
  assert.deepEqual(
    parseCliConfig(`
[network]
bootstrap = []

[publisher]
display_name = "kosmos"
allow = ["${subscriberKey}"]

[[publisher.services]]
id = "navidrome"
name = "Navidrome"
target_port = 4533

[subscriber]
gateway_port = 17480
route = "auto"

[[subscriber.services]]
id = "ssh"
local_port = 2222
`),
    {
      network: {},
      publisher: {
        displayName: "kosmos",
        allow: [subscriberKey],
        services: [
          { id: "navidrome", name: "Navidrome", targetPort: 4533 },
        ],
      },
      subscriber: {
        gatewayPort: 17_480,
        route: "auto",
        services: [{ id: "ssh", localPort: 2_222 }],
      },
    },
  );
});

test("CLI config keeps deny-all and Home-only publisher policy explicit", () => {
  assert.deepEqual(
    parseCliConfig(`
[publisher]
display_name = "kosmos"
allow = []
services = []
`),
    {
      publisher: {
        displayName: "kosmos",
        allow: [],
        services: [],
      },
    },
  );
});

test("CLI config rejects incomplete or invalid role policy", () => {
  assert.throws(
    () => parseCliConfig('[publisher]\ndisplay_name = "kosmos"'),
    /publisher\.allow must be an array/,
  );
  assert.throws(
    () =>
      parseCliConfig(
        '[publisher]\ndisplay_name = "kosmos"\nallow = []\nservices = []\nextra = true',
      ),
    /unknown field: publisher\.extra/,
  );
  assert.throws(
    () => parseCliConfig('[subscriber]\ngateway_port = 70000'),
    /subscriber\.gateway_port.*65535/,
  );
});

test("CLI config rejects unknown fields and malformed endpoints", () => {
  assert.throws(
    () => parseCliConfig("[network]\nbootstraps = []"),
    /unknown field: network\.bootstraps/,
  );
  assert.throws(
    () => parseCliConfig('[network]\nbootstrap = ["47.94.213.63"]'),
    /network\.bootstrap.*host:port/,
  );
});

test("CLI config follows XDG and distinguishes default from explicit files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kepos-config-"));
  const configPath = path.join(root, "kepos", "config.toml");
  assert.equal(defaultCliConfigPath({ XDG_CONFIG_HOME: root }), configPath);
  assert.equal(
    await loadCliConfig(undefined, { XDG_CONFIG_HOME: root }),
    undefined,
  );
  await assert.rejects(
    () => loadCliConfig(path.join(root, "missing.toml")),
    /Cannot read Kepos config/,
  );

  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    '[network]\nbootstrap = ["47.94.213.63:49737"]\n',
  );
  assert.deepEqual(await loadCliConfig(undefined, { XDG_CONFIG_HOME: root }), {
    network: { bootstrap: [{ host: "47.94.213.63", port: 49_737 }] },
  });
});
