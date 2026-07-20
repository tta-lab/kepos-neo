import { readFile } from "node:fs/promises";

const expectedNode = (await readFile(".node-version", "utf8")).trim();
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const expectedNpm = /^npm@(.+)$/u.exec(packageJson.packageManager)?.[1];
const actualNpm = /^npm\/(\S+)/u.exec(
  process.env.npm_config_user_agent ?? "",
)?.[1];

const errors = [];
if (process.versions.node !== expectedNode) {
  errors.push(
    `Node ${expectedNode} required, found ${process.versions.node}`,
  );
}
if (!expectedNpm) {
  errors.push("packageManager must pin an npm version");
} else if (actualNpm !== expectedNpm) {
  errors.push(`npm ${expectedNpm} required, found ${actualNpm ?? "unknown"}`);
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
}
