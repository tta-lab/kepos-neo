import { WorkletController } from "./controller.js";
import { startEchoServer } from "./echo-server.js";

const echo = await startEchoServer();
const controller = new WorkletController({
  runtimeId: Bare.argv[0] ?? "runtime-unknown",
  echoUrl: echo.url,
  write(frame) {
    BareKit.IPC.write(frame);
  },
  stopEcho: () => echo.close(),
});

BareKit.IPC.on("data", (data) => {
  void controller.receive(data).catch((error) => {
    console.error("Kepos Worklet control failure", error);
  });
});

controller.start();
