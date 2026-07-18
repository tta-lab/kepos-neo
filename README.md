# Kepos Neo P0

This slice checks one small path: an allowlisted Hypertele client can open a
publisher's local Home page, while an unknown client cannot.

P0 runs one publisher and two client identities on one desktop. It does not
prove cross-device access, NAT traversal, relay support, mobile support, or the
full Kepos product idea.

## Requirements

- Node.js 22
- npm 10

Install dependencies with `npm ci`. Generate local P0 state with
`npm run p0:setup`.

Generated keys and configs live under `tmp/`. They are secrets: do not commit,
copy into logs, or share them.

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

Open Home and any configured TCP services together:

```sh
npm run kepos -- subscriber run \
  --state ~/.local/state/kepos-neo/subscriber \
  --service ssh:2222 \
  --service navidrome:4533

ssh -p 2222 <user>@127.0.0.1
```

Subscriber route mode defaults to `auto`, which permits HyperDHT's LAN-local
shortcut. Add `--route public` to disable only that shortcut when comparing a
non-local DHT path. It does not force a relay, choose a fixed Internet route,
or promise stable latency. Add `--observations ndjson` for structured events;
status remains on stderr so stdout stays valid NDJSON.

Use `outerId` to correlate connection and channel events. Several
`channel.open` events with one `outerId` are several TCP services sharing one
persistent connection, not several DHT handshakes. Transport snapshots are
sanitized diagnostics whose shape may change; do not treat them as a stable
API or copy state files into logs.

The command prints the local Home URL. The local listeners remain stable while
the subscriber reconnects in the background after a publisher restart. Active
TCP stream recovery is deferred.

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

Publisher seeds and subscriber secret keys never cross devices. See
`docs/evidence/mac-kosmos-ssh-dogfood.md` for the tested Mac-to-kosmos path.

Home also exposes a bounded download endpoint for transport checks:

```text
GET /.well-known/kepos/benchmark?bytes=16777216
```

`bytes` must be from 1 through 67108864. The response is streamed, is not
cached, and should be used only for diagnostics.
