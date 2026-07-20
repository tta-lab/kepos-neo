import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { test } from "node:test";

test("package metadata owns the supported development runtime range", async () => {
  const packageJson = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as {
    devEngines?: unknown;
    engines?: unknown;
    scripts?: Record<string, string>;
  };
  assert.deepEqual(packageJson.engines, {
    node: ">=22 <23",
    npm: ">=10 <11",
  });
  assert.deepEqual(packageJson.devEngines, {
    runtime: {
      name: "node",
      version: ">=22 <23",
      onFail: "error",
    },
    packageManager: {
      name: "npm",
      version: ">=10 <11",
      onFail: "error",
    },
  });
  assert.equal(
    packageJson.scripts?.check,
    "npm run typecheck && npm test && npm run check:home",
  );
  await assert.rejects(
    () => access("scripts/check-runtime.mjs"),
    (error: unknown) =>
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );

  const lefthook = await readFile("lefthook.yml", "utf8");
  assert.match(lefthook, /^lefthook: npm exec --offline -- lefthook$/mu);
});
