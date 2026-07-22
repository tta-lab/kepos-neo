import assert from "node:assert/strict";
import { test } from "node:test";

import { CancellationController } from "../src/runtime/cancellation.js";

test("cancellation controller notifies current listeners once", () => {
  const controller = new CancellationController();
  let calls = 0;
  const listener = (): void => {
    calls++;
  };
  controller.signal.addEventListener("abort", listener);

  controller.abort();
  controller.abort();

  assert.equal(controller.signal.aborted, true);
  assert.equal(calls, 1);
});

test("cancellation listener can be removed", () => {
  const controller = new CancellationController();
  let called = false;
  const listener = (): void => {
    called = true;
  };
  controller.signal.addEventListener("abort", listener);
  controller.signal.removeEventListener("abort", listener);
  controller.abort();

  assert.equal(called, false);
});
