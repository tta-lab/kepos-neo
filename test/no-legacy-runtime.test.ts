import assert from "node:assert/strict";
import {
  access,
  readFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? sourceFiles(entryPath)
        : Promise.resolve(entry.name.endsWith(".ts") ? [entryPath] : []);
    }),
  );
  return files.flat();
}

test("production runtime has no P0, dogfood, or Hypertele path", async () => {
  for (const legacyPath of ["src/p0", "src/dogfood"]) {
    await assert.rejects(
      () => access(legacyPath),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT",
      legacyPath,
    );
  }

  const packageJson = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as {
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  assert.equal(packageJson.dependencies?.hypertele, undefined);
  assert.equal(
    Object.keys(packageJson.scripts ?? {}).some(
      (name) => name.startsWith("p0:") || name.startsWith("dogfood:"),
    ),
    false,
  );
  assert.doesNotMatch(
    await readFile("package-lock.json", "utf8"),
    /"hypertele"/iu,
  );

  for (const filePath of await sourceFiles("src")) {
    const source = await readFile(filePath, "utf8");
    assert.doesNotMatch(source, /hypertele|src\/p0|src\/dogfood/iu, filePath);
  }
});

test("dogfood publisher unit requires separately initialized multiplex state", async () => {
  const service = await readFile(
    "deploy/kepos-dogfood-publisher.service",
    "utf8",
  );
  const evidence = await readFile(
    "docs/evidence/mac-kosmos-ssh-dogfood.md",
    "utf8",
  );
  const stateDir = "/home/neil/.local/state/kepos-neo/mux-publisher";

  assert.match(
    service,
    new RegExp(
      `ConditionPathExists=${stateDir}/publisher\\.manifest\\.json`,
    ),
  );
  assert.match(
    service,
    new RegExp(`ConditionPathExists=${stateDir}/publisher\\.json`),
  );
  assert.match(
    service,
    new RegExp(
      `ExecStart=.*npm run kepos -- publisher run --state ${stateDir}`,
    ),
  );
  assert.doesNotMatch(service, /dogfood:publisher/);
  assert.match(
    evidence,
    /setup publisher[\s\S]*--state ~\/\.local\/state\/kepos-neo\/mux-publisher/,
  );
  assert.match(evidence, /legacy state.*not compatible/i);
});

test("network research tools live outside the Kepos product repository", async () => {
  for (const extractedPath of [
    "src/tools",
    "test/bootstrap-benchmark.test.ts",
    "test/dht-crawler.test.ts",
    "test/dht-report.test.ts",
    "test/dht-validator.test.ts",
  ]) {
    await assert.rejects(
      () => access(extractedPath),
      (error: unknown) =>
        (error as NodeJS.ErrnoException).code === "ENOENT",
      extractedPath,
    );
  }

  const packageJson = JSON.parse(
    await readFile("package.json", "utf8"),
  ) as { scripts?: Record<string, string> };
  for (const script of [
    "crawl:dht",
    "report:dht",
    "validate:dht",
    "benchmark:bootstrap",
  ]) {
    assert.equal(packageJson.scripts?.[script], undefined, script);
  }
});
