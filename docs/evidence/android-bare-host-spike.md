# Android Bare host spike evidence

Date: 2026-07-21

Device: Pixel 7a (`lynx`), Android 16, arm64-v8a

Bare Kit: 2.3.0

## Build inputs

The Bare Kit release archive is pinned by `scripts/fetch-bare-kit.mjs`:

- Size: `371197422` bytes
- SHA-256: `a386063fa405b0bb4967490e84745075f007f95359c9871c5b7a45c18c2f49e2`

The downloader prefers aria2c with resume and eight connections, falls back to Node, and verifies both values before extraction.

## Real-device result

The debug APK installed on the Pixel 7a. Starting Kepos created one foreground service and one Bare Worklet. A request to the Worklet-owned loopback listener returned:

```text
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8
Content-Length: 16
Connection: close

kepos worklet ok
```

Pressing Back finished `MainActivity`. The foreground service remained active and the same listener continued to return HTTP 200. Reopening the app showed `running` and the same echo URL.

Pressing Stop closed port 17482 and changed the UI to `stopped`. After the Activity unbound, the service record disappeared.

## Failures found by the device gate

The first build called `IPC.read()` before starting the Worklet. Bare Kit aborted through CheckJNI because its native IPC buffer was not ready.

After moving the read, the Worklet reported `TextEncoder is not defined`; Bare is not a browser runtime. The shared protocol and HTTP parser now use `b4a`.

Bare Kit's README shows IPC construction before `worklet.start()`, but its 2.3.0 Android instrumentation tests construct IPC after start. Following the test order fixed the remaining CheckJNI abort:

1. Create `Worklet`.
2. Call `worklet.start()`.
3. Create `IPC(worklet)`.
4. Begin async reads.

Regression checks now enforce this order and exercise the Node/Bare-neutral framing code.
