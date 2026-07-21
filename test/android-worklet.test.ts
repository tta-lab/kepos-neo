import assert from "node:assert/strict";
import { test } from "node:test";

import { FrameDecoder, encodeFrame } from "../packages/bare-host-protocol/src/framing.js";
import type { HostEnvelope } from "../packages/bare-host-protocol/src/messages.js";
import { WorkletController } from "../packages/kepos-android-worklet/src/controller.js";

test("Android Worklet controller answers ping and status", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async stopEcho() {},
  });

  controller.start();
  await controller.receive(
    encodeFrame({ version: 1, kind: "request", id: 1, method: "ping" }),
  );
  await controller.receive(
    encodeFrame({ version: 1, kind: "request", id: 2, method: "status" }),
  );

  assert.deepEqual(output, [
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: {
        state: "running",
        runtimeId: "runtime-1",
        echoUrl: "http://127.0.0.1:17482/",
      },
    },
    {
      version: 1,
      kind: "response",
      id: 1,
      result: { pong: true, runtimeId: "runtime-1" },
    },
    {
      version: 1,
      kind: "response",
      id: 2,
      result: {
        state: "running",
        runtimeId: "runtime-1",
        echoUrl: "http://127.0.0.1:17482/",
      },
    },
  ]);
});

test("Android Worklet controller closes echo before acknowledging stop", async () => {
  const output: HostEnvelope[] = [];
  const decoder = new FrameDecoder();
  let echoStopped = false;
  const controller = new WorkletController({
    runtimeId: "runtime-1",
    echoUrl: "http://127.0.0.1:17482/",
    write(frame) {
      output.push(...decoder.push(frame));
    },
    async stopEcho() {
      echoStopped = true;
    },
  });
  controller.start();

  await controller.receive(
    encodeFrame({ version: 1, kind: "request", id: 3, method: "stop" }),
  );

  assert.equal(echoStopped, true);
  assert.deepEqual(output.slice(1), [
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: { state: "stopping", runtimeId: "runtime-1" },
    },
    {
      version: 1,
      kind: "event",
      event: "runtime.stateChanged",
      data: { state: "stopped", runtimeId: "runtime-1" },
    },
    {
      version: 1,
      kind: "response",
      id: 3,
      result: { stopped: true, runtimeId: "runtime-1" },
    },
  ]);
});
