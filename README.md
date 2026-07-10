# Kepos Neo P0

This slice checks one small path: an allowlisted Hypertele client can open a
publisher's local Home page, while an unknown client cannot.

P0 runs one publisher and two client identities on one desktop. It does not
prove cross-device access, NAT traversal, relay support, mobile support, or the
full Kepos product idea.

## Requirements

- Node.js 22
- Bun 1.3 or later

Install dependencies with `bun install`. Generate local P0 state with
`bun run p0:setup`.

Generated keys and configs live under `tmp/`. They are secrets: do not commit,
copy into logs, or share them.
