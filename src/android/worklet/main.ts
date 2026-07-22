import { WorkletController } from "@tta-lab/kepos-android-worklet/controller";
import type { RunningSubscriber } from "../../runtime/subscriber.js";
import { startSubscriber } from "../../runtime/subscriber.js";
import {
  setSubscriberPublisher,
  setupSubscriber,
} from "../../state/subscriber.js";

const runtimeId = Bare.argv[0] ?? "runtime-unknown";
const stateDir = Bare.argv[1];
if (!stateDir) throw new Error("Android subscriber state directory is required");

const gatewayPort = 17_480;
const navidromePort = 17_481;
const homeUrl = `http://home.localhost:${gatewayPort}/`;
const navidromeUrl = `http://navidrome.localhost:${gatewayPort}/`;
const setup = await setupSubscriber({ stateDir });
let configured = setup.configured;
let connection: "offline" | "connecting" = "offline";
let running: RunningSubscriber | undefined;
let connectTask: Promise<void> | undefined;

const status = (): Record<string, unknown> => ({
  subscriberPublicKey: setup.publicKey,
  configured,
  connection: running?.status().connection ?? connection,
  homeUrl,
  navidromeUrl,
  navidromeFallbackUrl: `http://127.0.0.1:${navidromePort}/`,
});

const connect = (): void => {
  if (!configured || running || connectTask) return;
  connection = "connecting";
  connectTask = startSubscriber({
    stateDir,
    gatewayPort,
    services: [{ id: "navidrome", localPort: navidromePort }],
    waitForPublisher: false,
  })
    .then((started) => {
      running = started;
    })
    .catch((error) => {
      connection = "offline";
      console.error("Kepos subscriber connection failed", error);
    })
    .finally(() => {
      connectTask = undefined;
    });
};

const controller = new WorkletController({
  runtimeId,
  echoUrl: navidromeUrl,
  status,
  write(frame) {
    BareKit.IPC.write(frame);
  },
  async configurePublisher(publisherKey) {
    await connectTask;
    await running?.stop();
    running = undefined;
    await setSubscriberPublisher({
      stateDir,
      label: "publisher",
      publisherKey,
    });
    configured = true;
    connect();
    return status();
  },
  async stopEcho() {
    clearInterval(statusTimer);
    await connectTask;
    await running?.stop();
    running = undefined;
    connection = "offline";
  },
});

const statusTimer = setInterval(() => controller.publishStatus(), 1_000);

BareKit.IPC.on("data", (data) => {
  void controller.receive(data).catch((error) => {
    console.error("Kepos Worklet control failure", error);
  });
});

controller.start();
connect();
