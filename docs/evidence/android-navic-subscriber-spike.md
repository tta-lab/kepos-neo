# Android Navic subscriber spike evidence

Date: 2026-07-22

Device: Pixel 7a (`lynx`), Android 16, arm64-v8a

Bare Kit: 2.3.0

## Implemented path

```text
Compose Activity
  -> Kotlin foreground service
  -> Bare Kit Worklet
  -> Kepos HyperDHT subscriber
  -> one Protomux publisher connection
  -> 127.0.0.1:17480 hostname gateway
     127.0.0.1:17481 Navidrome fallback
```

The Android app is subscriber-only. Its identity and publisher contact stay in
app-private storage owned by the Worklet. Kotlin receives the subscriber public
key and sanitized status, but never the subscriber secret key.

## Repeatable device result

The following gate passed on the Pixel 7a:

```sh
npm run android:device-check
```

The instrumentation test proved that the real subscriber Worklet:

- creates and preserves one subscriber identity;
- accepts a publisher public key over the framed control channel;
- starts the fixed loopback listeners while that test publisher is unreachable;
- answers control pings before and after Activity recreation;
- keeps the same runtime ID, subscriber key, and Navidrome URLs;
- closes the Worklet and foreground service after explicit Stop.

With notification permission reset on the Pixel 7a, tapping Start displayed
the Android notification permission prompt. After the operator allowed it, the
foreground service started and Android exposed the ongoing Kepos notification
with its Stop action. Denial handling remains part of later ship-UI work; it
does not prevent the subscriber service itself from starting.

The test publisher key is intentionally unreachable. This verifies the offline
side of the lifecycle without treating it as evidence of successful NAT
traversal.

`npm run check` also passed 113 tests with 96.89% line, 83.81% branch, and
92.72% function coverage. `npm run android:check` passed Kotlin/JVM tests, lint,
the Bare bundle, and debug assembly.

The arm64-only debug APK is 89 MiB. Before applying the intended spike ABI
filter, one APK contained four copies of Bare Kit and its addons and was 345
MiB. Emulator/x86 packaging and store-grade ABI splits remain distribution
work.

## Device failures found

The first real subscriber listener used the browser `AbortController` global.
Bare does not provide it. Accepting a local socket raised an uncaught
`ReferenceError`, and Bare Kit aborted the Worklet process with SIGABRT.

Kepos now uses a small runtime-neutral cancellation signal shared by Node and
Bare. Focused tests cover prompt cancellation, client disconnect, and destroying
a tunnel that resolves after cancellation. The device lifecycle gate passed
after this replacement.

## Bounded offline behavior

- One DHT connection candidate times out after 20 seconds and is destroyed.
- Background retry uses the existing capped exponential delay.
- HTTP tunnel acquisition returns `503 Service Unavailable` with
  `Retry-After: 1` after 10 seconds.
- Raw TCP acquisition closes the local socket after 10 seconds.
- Closing a local client cancels its own acquisition without cancelling the
  shared publisher reconnect.
- Listener ports stay fixed while the publisher reconnects.

## Public-path and Navic acceptance

The public-path checks below ran without `adb reverse` or a configured Android
HTTP proxy. The publisher observed the Android peer at public IPv4 address
`124.160.204.171`, rather than through a LAN-only shortcut. No credential or
subscriber secret was collected.

- [x] Android connects to the allowlisted kosmos-wsl publisher. The publisher
      accepted subscriber `80745ccfb5cb1ec8...` and kept one outer connection.
- [x] `http://home.localhost:17480/` loads in Brave on Android and reports the
      `kosmos` Home online.
- [x] Navic logs in and plays through `http://navidrome.localhost:17480/`.
      Navidrome recorded `player="Navic [Navic]"` while playing `自从有了你`,
      and the Android outer connection transferred about 15 MB during the same
      session. This proves the hostname route on the initial cellular path; it
      does not prove that Navic preserves hostname resolution after a network
      change.
- [x] Playback continues with the screen locked. A focused seven-minute spike
      run stayed in `PLAYING`, advanced across three queue items, kept the same
      Kepos PID, and returned HTTP 200 from port 17480 throughout. A 30-minute
      soak is deferred to Stage B2 rather than used as a Stage B1 merge gate.
- [ ] Wi-Fi to cellular to Wi-Fi recovers end to end without changing the
      configured URL. One cellular-to-Wi-Fi switch did prove that Kepos closed
      the old outer connection and opened a new one about eight seconds later.
      Navic playback did not resume because Android then returned
      `UnknownHostException` for `navidrome.localhost`; that client resolver gap
      is separate from Kepos transport recovery.
- [ ] Restarting the kosmos-wsl publisher recovers without restarting the app.
- [x] Android process recreation restores the listener and subscriber identity.
      Killing PID 28338 produced PID 3738 after three seconds. The foreground
      service and port 17480 returned, `/healthz` recovered from 503 to 200,
      and the publisher accepted the same subscriber key on a new outer
      connection without reopening the Activity.
- [ ] Idle memory, CPU, and a 30-minute unplugged battery sample are recorded.

The first idle sample showed 81,219 KiB total PSS, 151,856 KiB total RSS, and
0.0% instantaneous CPU. During the short locked-screen run, total PSS ranged
from 48,105 to 87,036 KiB. The device was connected to AC at 80%, so a real
battery-drain sample remains Stage B2 work. Its purpose is not to prove tunnel
correctness. It is a release-risk check that the foreground service, DHT
keepalive, and reconnect policy do not cause abnormal idle drain. It is not a
Stage B1 merge gate.

No private key, Navidrome credential, auth cookie, or raw state file belongs in
this document.
