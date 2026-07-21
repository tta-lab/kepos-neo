import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

async function readProjectFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(new URL(`../${filePath}`, import.meta.url), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

test("Android host boundaries are explicit extraction seams", async () => {
  const rootPackage = JSON.parse(
    (await readProjectFile("package.json"))!,
  ) as { scripts?: Record<string, string>; workspaces?: string[] };
  const protocolPackage = await readProjectFile(
    "packages/bare-host-protocol/package.json",
  );
  const workletPackage = await readProjectFile(
    "packages/kepos-android-worklet/package.json",
  );
  const settings = await readProjectFile("android/settings.gradle.kts");
  const appBuild = await readProjectFile("android/app/build.gradle.kts");
  const appManifest = await readProjectFile("android/app/src/main/AndroidManifest.xml");
  const foregroundService = await readProjectFile(
    "android/app/src/main/java/io/github/ttalab/kepos/KeposForegroundService.kt",
  );
  const bareKitSession = await readProjectFile(
    "android/barekit-host/src/main/java/io/github/ttalab/barekit/host/BareKitRuntimeSession.kt",
  );
  const hostBuild = await readProjectFile(
    "android/barekit-host/build.gradle.kts",
  );

  assert.deepEqual(rootPackage.workspaces, ["packages/*"]);
  assert.equal(
    rootPackage.scripts?.["android:fetch-bare-kit"],
    "node scripts/fetch-bare-kit.mjs",
  );
  assert.equal(
    rootPackage.scripts?.["android:assemble"],
    "npm run android:fetch-bare-kit && npm run android:bundle && ./android/gradlew -p android assembleDebug",
  );
  assert.equal(
    rootPackage.scripts?.["android:check"],
    "npm run android:fetch-bare-kit && npm run android:bundle && ./android/gradlew -p android testDebugUnitTest lintDebug assembleDebug",
  );
  assert.notEqual(protocolPackage, null, "missing pure host protocol package");
  assert.notEqual(workletPackage, null, "missing product Worklet package");
  assert.match(settings!, /include\(":app", ":barekit-host"\)/);
  assert.match(appBuild!, /implementation\(project\(":barekit-host"\)\)/);
  assert.doesNotMatch(appBuild!, /bare-kit\/classes\.jar/);
  assert.match(hostBuild!, /bare-kit\/classes\.jar/);
  assert.match(hostBuild!, /libs\/bare-kit\/jni/);
  assert.match(appManifest!, /foregroundServiceType="specialUse"/);
  assert.match(foregroundService!, /private val runtime = BareRuntime/);
  assert.match(foregroundService!, /START_STICKY/);
  assert.ok(
    bareKitSession!.indexOf("worklet.start") < bareKitSession!.indexOf("armRead()"),
    "Bare Kit IPC reads must begin after the Worklet starts",
  );
  assert.ok(
    bareKitSession!.indexOf("worklet.start") < bareKitSession!.indexOf("IPC(worklet)"),
    "Bare Kit IPC must be created after the Worklet starts",
  );
});
