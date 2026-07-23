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
