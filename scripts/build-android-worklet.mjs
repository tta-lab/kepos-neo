import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repository = fileURLToPath(new URL("..", import.meta.url));
const assets = path.join(repository, "android", "app", "src", "main", "assets");
const addons = path.join(repository, "android", "app", "src", "main", "addons");
const bundle = path.join(assets, "kepos.bundle");
const entry = path.join(
  repository,
  "packages",
  "kepos-android-worklet",
  "dist",
  "main.js",
);

await rm(bundle, { force: true });
await rm(addons, { force: true, recursive: true });
await mkdir(assets, { recursive: true });
await mkdir(addons, { recursive: true });

await run("bare-pack", [
  "--preset",
  "android",
  "--linked",
  "--out",
  bundle,
  entry,
]);
await run("bare-link", [
  "--preset",
  "android",
  "--out",
  addons,
  path.join(repository, "packages", "kepos-android-worklet"),
]);

process.stdout.write("Android Worklet bundle and linked addons are ready\n");

async function run(command, arguments_) {
  const executable = path.join(repository, "node_modules", ".bin", command);
  await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      cwd: repository,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} failed${signal ? ` with signal ${signal}` : ` with code ${code}`}`,
        ),
      );
    });
  });
}
