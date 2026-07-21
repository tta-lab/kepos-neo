import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import extractZip from "extract-zip";
import { HttpsProxyAgent } from "https-proxy-agent";

export const BARE_KIT = Object.freeze({
  version: "2.3.0",
  url: "https://github.com/holepunchto/bare-kit/releases/download/v2.3.0/prebuilds.zip",
  size: 371_197_422,
  sha256: "a386063fa405b0bb4967490e84745075f007f95359c9871c5b7a45c18c2f49e2",
});

export function proxyUrlFromEnvironment(environment) {
  return (
    environment.HTTPS_PROXY ||
    environment.https_proxy ||
    environment.HTTP_PROXY ||
    environment.http_proxy ||
    undefined
  );
}

export async function verifyArchive(archivePath, expected = BARE_KIT) {
  const archive = await stat(archivePath);
  if (archive.size !== expected.size) {
    throw new Error(
      `Bare Kit archive size mismatch: expected ${expected.size}, got ${archive.size}`,
    );
  }

  const digest = createHash("sha256");
  for await (const chunk of createReadStream(archivePath)) digest.update(chunk);
  const actual = digest.digest("hex");
  if (actual !== expected.sha256) {
    throw new Error(
      `Bare Kit archive SHA-256 mismatch: expected ${expected.sha256}, got ${actual}`,
    );
  }
}

export async function ensureArchive({
  archivePath,
  expected = BARE_KIT,
  fetchImpl = fetch,
  downloadImpl,
}) {
  try {
    await access(archivePath);
    await verifyArchive(archivePath, expected);
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const parent = path.dirname(archivePath);
  await mkdir(parent, { recursive: true });
  const partialArchive = `${archivePath}.partial`;
  if (!expected.url) throw new Error("Bare Kit release URL is missing");
  if (
    downloadImpl &&
    (await downloadImpl({
      url: expected.url,
      partialArchive,
    }))
  ) {
    await verifyArchive(partialArchive, expected);
    await rename(partialArchive, archivePath);
    return;
  }

  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    let offset = await fileSize(partialArchive);
    if (offset > expected.size) {
      await rm(partialArchive, { force: true });
      offset = 0;
    }
    try {
      const source =
        offset === expected.size
          ? null
          : await fetchDownloadSource(fetchImpl, expected.url, offset);
      if (source) {
        if (offset > 0 && source.status === 200) {
          await rm(partialArchive, { force: true });
          offset = 0;
        } else if (offset > 0 && source.status !== 206) {
          throw new Error(
            `Bare Kit server refused download resume: HTTP ${source.status}`,
          );
        }
        await pipeline(
          source.body,
          createWriteStream(partialArchive, { flags: offset > 0 ? "a" : "w" }),
        );
      }
      await verifyArchive(partialArchive, expected);
      await rename(partialArchive, archivePath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) await delay(attempt * 200);
    }
  }
  throw lastError;
}

export function aria2cArguments({ url, partialArchive, proxyUrl }) {
  const arguments_ = [
    "--continue=true",
    "--file-allocation=none",
    "--max-connection-per-server=8",
    "--min-split-size=1M",
    "--split=8",
  ];
  if (proxyUrl) arguments_.push(`--all-proxy=${proxyUrl}`);
  arguments_.push(
    `--dir=${path.dirname(partialArchive)}`,
    `--out=${path.basename(partialArchive)}`,
    url,
  );
  return arguments_;
}

export async function downloadWithAria2c({
  url,
  partialArchive,
  proxyUrl,
  spawnImpl = spawn,
}) {
  return await new Promise((resolve, reject) => {
    const process = spawnImpl(
      "aria2c",
      aria2cArguments({ url, partialArchive, proxyUrl }),
      { stdio: "inherit" },
    );
    let settled = false;
    process.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        resolve(false);
        return;
      }
      reject(error);
    });
    process.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        resolve(true);
        return;
      }
      reject(
        new Error(
          `aria2c failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}`,
        ),
      );
    });
  });
}

async function fetchDownloadSource(fetchImpl, url, offset) {
  const response = await fetchImpl(url, {
    headers: offset > 0 ? { range: `bytes=${offset}-` } : undefined,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Bare Kit download failed: HTTP ${response.status}`);
  }
  return {
    body:
      response.body instanceof Readable
        ? response.body
        : Readable.fromWeb(response.body),
    status: response.status,
  };
}

async function fileSize(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function installAndroidPrebuild({
  archivePath,
  destination,
  extractImpl = extractZip,
}) {
  if (await isAndroidPrebuild(destination)) return;

  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporaryDirectory = await mkdtemp(path.join(parent, ".extract-"));
  try {
    await extractImpl(archivePath, { dir: temporaryDirectory });
    const source = path.join(temporaryDirectory, "android", "bare-kit");
    if (!(await isAndroidPrebuild(source))) {
      throw new Error("Bare Kit archive has no usable Android prebuild");
    }
    await rename(source, destination);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function isAndroidPrebuild(directory) {
  try {
    await access(path.join(directory, "classes.jar"));
    await access(
      path.join(directory, "jni", "arm64-v8a", "libbare-kit.so"),
    );
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function main() {
  const repository = fileURLToPath(new URL("..", import.meta.url));
  const archivePath = path.join(
    repository,
    ".cache",
    "bare-kit",
    BARE_KIT.version,
    "prebuilds.zip",
  );
  const destination = path.join(
    repository,
    "android",
    "barekit-host",
    "libs",
    "bare-kit",
  );
  const proxyUrl = proxyUrlFromEnvironment(process.env);
  await ensureArchive({
    archivePath,
    downloadImpl: (options) =>
      downloadWithAria2c({ ...options, proxyUrl }),
    fetchImpl: proxyUrl
      ? (url, init) => fetchThroughProxy(url, proxyUrl, init)
      : fetch,
  });
  await installAndroidPrebuild({ archivePath, destination });
  process.stdout.write(`Bare Kit ${BARE_KIT.version} Android prebuild is ready\n`);
}

function fetchThroughProxy(
  input,
  proxyUrl,
  init = {},
  redirectsRemaining = 5,
) {
  const url = new URL(input);
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        agent: new HttpsProxyAgent(proxyUrl),
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          "user-agent": "kepos-bare-kit-fetcher",
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsRemaining === 0) {
            reject(new Error("Bare Kit download followed too many redirects"));
            return;
          }
          resolve(
            fetchThroughProxy(
              new URL(location, url),
              proxyUrl,
              init,
              redirectsRemaining - 1,
            ),
          );
          return;
        }
        resolve({
          ok: status >= 200 && status < 300,
          status,
          body: response,
        });
      },
    );
    request.setTimeout(30_000, () => {
      request.destroy(new Error("Bare Kit download connection timed out"));
    });
    request.once("error", reject);
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
