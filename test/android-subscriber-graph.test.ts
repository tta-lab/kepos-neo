import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repository = fileURLToPath(new URL("..", import.meta.url));
const importPattern = /(?:import|export)\s+(?:type\s+)?(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g;

test("Android subscriber maps every reachable Node builtin to Bare", async () => {
  const nodeImports = await findNodeImports("src/runtime/subscriber.ts");
  const packageJson = JSON.parse(
    await readFile(path.join(repository, "package.json"), "utf8"),
  ) as {
    imports?: Record<string, { bare?: string; default?: string }>;
  };
  const unmapped = nodeImports.filter(({ specifier }) => {
    const mapping = packageJson.imports?.[specifier];
    return !mapping?.bare || !mapping.default;
  });

  assert.deepEqual(unmapped, []);
});

test("Android subscriber source graph does not require the Node process global", async () => {
  const files = await collectSourceGraph("src/runtime/subscriber.ts");
  const processUsers: string[] = [];
  for (const [relativePath, source] of files) {
    if (/\bprocess\./.test(source)) processUsers.push(relativePath);
  }

  assert.deepEqual(processUsers.sort(), []);
});

async function findNodeImports(entry: string): Promise<Array<{
  file: string;
  specifier: string;
}>> {
  const files = await collectSourceGraph(entry);
  const found = new Map<string, { file: string; specifier: string }>();

  for (const [relativePath, source] of files) {
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      if (specifier.startsWith("node:")) {
        found.set(`${relativePath}: ${specifier}`, {
          file: relativePath,
          specifier,
        });
        continue;
      }
    }
  }

  return [...found.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

async function collectSourceGraph(entry: string): Promise<Map<string, string>> {
  const pending = [entry];
  const files = new Map<string, string>();

  while (pending.length > 0) {
    const relativePath = pending.pop()!;
    if (files.has(relativePath)) continue;
    const source = await readFile(path.join(repository, relativePath), "utf8");
    files.set(relativePath, source);
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      if (!specifier.startsWith(".")) continue;
      pending.push(resolveTypeScriptImport(relativePath, specifier));
    }
  }

  return files;
}

function resolveTypeScriptImport(importer: string, specifier: string): string {
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(importer), specifier),
  );
  return resolved.replace(/\.js$/, ".ts");
}
