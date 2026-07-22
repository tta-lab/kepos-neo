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

The following items are not yet evidence-backed and must remain unchecked until
run on the physical device without `adb reverse`, an HTTP proxy, TUN dependency,
or a LAN-only shortcut:

- [ ] Android connects to the allowlisted kosmos-wsl publisher.
- [ ] `http://home.localhost:17480/` loads in an Android browser.
- [ ] Navic logs in and plays through `http://navidrome.localhost:17480/`, or
      the `http://127.0.0.1:17481/` resolver fallback is recorded.
- [ ] Playback continues for 30 minutes with the screen locked.
- [ ] Wi-Fi to cellular to Wi-Fi recovers without changing the configured URL.
- [ ] Restarting the kosmos-wsl publisher recovers without restarting the app.
- [ ] Android process recreation restores the listener and subscriber identity.
- [ ] Idle memory, CPU, and a 30-minute battery sample are recorded.

No private key, Navidrome credential, auth cookie, or raw state file belongs in
this document.
