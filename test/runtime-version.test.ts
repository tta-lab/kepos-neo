import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const checkerPath = path.resolve("scripts/check-runtime.mjs");

async function withProject(
  nodeVersion: string,
  npmVersion: string,
  run: (directory: string) => void,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "kepos-runtime-"));
  try {
    await writeFile(path.join(directory, ".node-version"), `${nodeVersion}\n`);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ packageManager: `npm@${npmVersion}` }),
    );
    run(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

function checkRuntime(directory: string, npmVersion: string) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_user_agent:
        `npm/${npmVersion} node/${process.version} ${process.platform} ${process.arch}`,
    },
  });
}

test("runtime check accepts the project Node and npm versions", async () => {
  await withProject(process.versions.node, "10.9.8", (directory) => {
    const result = checkRuntime(directory, "10.9.8");
    assert.equal(result.status, 0, result.stderr);
  });
});

test("runtime check rejects a different Node version", async () => {
  await withProject("0.0.0", "10.9.8", (directory) => {
    const result = checkRuntime(directory, "10.9.8");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Node 0\.0\.0 required/u);
  });
});

test("runtime check rejects a different npm version", async () => {
  await withProject(process.versions.node, "0.0.0", (directory) => {
    const result = checkRuntime(directory, "10.9.8");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /npm 0\.0\.0 required/u);
  });
});

test("project checks guard the runtime and Lefthook stays offline", async () => {
  const packageJson = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as { scripts?: Record<string, string> };
  assert.match(
    packageJson.scripts?.check ?? "",
    /^node scripts\/check-runtime\.mjs && /u,
  );

  const lefthook = await readFile("lefthook.yml", "utf8");
  assert.match(lefthook, /^lefthook: npm exec --offline -- lefthook$/mu);
});
