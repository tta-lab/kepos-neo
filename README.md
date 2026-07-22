# Kepos Neo

[![CI](https://github.com/tta-lab/kepos-neo/actions/workflows/check.yml/badge.svg?branch=main&event=push)](https://github.com/tta-lab/kepos-neo/actions/workflows/check.yml)
[![codecov](https://codecov.io/github/tta-lab/kepos-neo/graph/badge.svg?branch=main)](https://app.codecov.io/github/tta-lab/kepos-neo)

Kepos Neo exposes a publisher's local Home page and configured TCP services to
allowlisted subscribers. One persistent encrypted HyperDHT connection carries
independent Protomux channels for Home, SSH, Navidrome, and other services.

## Requirements

- Node.js 22
- npm 10

Install dependencies with `npm ci`. Use the canonical `kepos` CLI below to
create publisher and subscriber state.

Generated keys and configs live under `tmp/`. They are secrets: do not commit,
copy into logs, or share them.

## Experimental Android subscriber

The Android app is a subscriber-only arm64 spike. A Kotlin foreground service
owns one Bare Worklet, and that Worklet runs the same HyperDHT/Protomux
subscriber core as the CLI. It does not install a VPN, TUN interface, or system
DNS service.

Build the debug APK and run its physical-device lifecycle gate:

```sh
npm run android:assemble
npm run android:device-check
```

The app generates its subscriber identity in app-private storage. Add the
displayed public key to the publisher allowlist, paste the publisher public key
into the app, and keep the foreground service running. Navidrome is then
available to Android clients at:

```text
http://navidrome.localhost:17480/
http://127.0.0.1:17481/
```

The second URL is a direct loopback fallback for clients that do not resolve
`*.localhost`. Both use the same publisher connection. This is not yet a Play
Store release, and foreground-service policy remains unresolved.

## Persistent multiplex CLI

The canonical CLI keeps one encrypted subscriber connection open to one
publisher. Home, SSH, Navidrome, and other configured TCP services use
independent Protomux channels on that connection. The publisher accepts
several subscribers through one shared allowlist.

Create the subscriber identity on the subscriber:

```sh
npm run kepos -- setup subscriber \
  --state ~/.local/state/kepos-neo/subscriber
```

Create publisher state using only the subscriber's public key:

```sh
npm run kepos -- setup publisher \
  --state ~/.local/state/kepos-neo/publisher \
  --display-name kosmos \
  --allow <subscriber-public-key> \
  --service ssh:SSH:22 \
  --service navidrome:Navidrome:4533
```

Run the publisher, then pin its one public key on the subscriber:

```sh
npm run kepos -- publisher run \
  --state ~/.local/state/kepos-neo/publisher

npm run kepos -- subscriber set-publisher \
  --state ~/.local/state/kepos-neo/subscriber \
  --label kosmos \
  --publisher-key <publisher-key>
```

Both run commands accept repeated `--bootstrap host:port` options. Omitting
them retains HyperDHT's built-in bootstrap set. An explicit list replaces that
set:

```sh
npm run kepos -- subscriber run \
  --state ~/.local/state/kepos-neo/subscriber \
  --bootstrap 47.94.213.63:49737 \
  --bootstrap 203.91.75.19:49738
```

Bootstrap nodes only help the process enter the public DHT. They do not relay
the established stream, grant access, or change the pinned publisher key.

HyperDHT crawling, geographic reports, candidate validation, and regional
bootstrap benchmarks live in
[`tta-lab/hyperdht-observatory`](https://github.com/tta-lab/hyperdht-observatory).
Kepos does not fetch or trust Observatory output at runtime; operators review
and pass any chosen endpoints explicitly with `--bootstrap`.

Run one local HTTP gateway plus any raw TCP listeners:

```sh
npm run kepos -- subscriber run \
  --state ~/.local/state/kepos-neo/subscriber \
  --service ssh:2222

ssh -p 2222 <user>@127.0.0.1
```

The HTTP gateway listens on `127.0.0.1:17480` by default. Every published HTTP
service is available through the same listener and one persistent publisher
connection:

```text
http://home.localhost:17480/
http://navidrome.localhost:17480/
```

The gateway maps the request hostname to a Protomux service ID. HTTP services
do not need a subscriber `--service` option or a separate local process.
`--service id:local-port` remains for raw TCP services such as SSH. If 17480
is occupied, select another gateway port:

Home treats the reserved `ssh` service as raw TCP. Its local port belongs to
the subscriber configuration, so the publisher Home does not guess or display
an SSH command. Every other published service is presented as an HTTP link on
the current gateway port.

```sh
npm run kepos -- subscriber run \
  --state ~/.local/state/kepos-neo/subscriber \
  --gateway-port 18080 \
  --service ssh:2222
```

Subscriber route mode defaults to `auto`, which permits HyperDHT's LAN-local
shortcut. Add `--route public` to disable only that shortcut when comparing a
non-local DHT path. It does not force a relay, choose a fixed Internet route,
or promise stable latency. Add `--observations ndjson` for structured events;
status remains on stderr so stdout stays valid NDJSON.

Use `outerId` to correlate connection and channel events. Several
`channel.open` events with one `outerId` are several TCP services sharing one
persistent connection, not several DHT handshakes. Transport snapshots are
captured again on `channel.open-ok`, `channel.open-error`, and `channel.close`.
Their `udx` fields include live RTT, congestion window, in-flight packet,
timeout, retransmit, recovery, and byte/packet counters. These are sanitized
diagnostics whose shape may change; do not treat them as a stable API or copy
state files into logs.

The command prints the local Home URL. The gateway and raw TCP listeners remain
stable while the subscriber reconnects in the background after a publisher
restart. Active TCP stream recovery is deferred.

An empty allowlist revokes every subscriber without rotating the publisher
key:

```sh
npm run kepos -- publisher set-allow \
  --state ~/.local/state/kepos-neo/publisher
```

Publisher allowlist and service changes edit stopped state and take effect on
the next `publisher run`. Replace services without rotating the publisher key:

```sh
npm run kepos -- publisher set-services \
  --state ~/.local/state/kepos-neo/publisher \
  --service ssh:SSH:22 \
  --service navidrome:Navidrome:4533
```

Publisher seeds and subscriber secret keys never cross devices. The historical
evidence in `docs/evidence/mac-kosmos-ssh-dogfood.md` records the tested
Mac-to-kosmos path and the commands used at the time.

Home also exposes a bounded download endpoint for transport checks:

```text
GET /.well-known/kepos/benchmark?bytes=16777216
```

`bytes` must be from 1 through 67108864. The response is streamed, is not
cached, and should be used only for diagnostics.
