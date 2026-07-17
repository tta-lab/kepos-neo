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

## Home plus TCP dogfood

The dogfood path keeps Home and a selected TCP service available at the same
time. It uses one Hypertele process per service and one shared publisher
allowlist.

Create the client identity on the client:

```sh
npm run dogfood:setup-client -- --state tmp/dogfood/client
```

Create publisher state on the publisher, using only the client's public key:

```sh
npm run dogfood:setup-publisher -- \
  --state ~/.local/state/kepos-neo/publisher \
  --display-name kosmos \
  --allow <client-public-key> \
  --service ssh:SSH:22
```

Run the publisher, then save its public Home key on the client:

```sh
npm run dogfood:publisher -- \
  --state ~/.local/state/kepos-neo/publisher

npm run dogfood:add-publisher -- \
  --state tmp/dogfood/client \
  --label kosmos \
  --home-key <publisher-home-key>
```

Open Home and SSH together on the client:

```sh
npm run dogfood:client -- \
  --state tmp/dogfood/client \
  --service ssh \
  --port 2222

ssh -p 2222 <user>@127.0.0.1
```

An empty allowlist revokes every client without rotating service keys:

```sh
npm run dogfood:set-allow -- \
  --state ~/.local/state/kepos-neo/publisher
```

Publisher seeds and client secret keys never cross devices. See
`docs/evidence/mac-kosmos-ssh-dogfood.md` for the tested Mac-to-kosmos path.

Home also exposes a bounded download endpoint for transport checks:

```text
GET /.well-known/kepos/benchmark?bytes=16777216
```

`bytes` must be from 1 through 67108864. The response is streamed, is not
cached, and should be used only for diagnostics.
