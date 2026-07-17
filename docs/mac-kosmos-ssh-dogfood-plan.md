# Plan: Mac to kosmos SSH dogfood

Status: approved and in progress
Date: 2026-07-17
Branch: `feat/mac-kosmos-ssh-dogfood`
Depends on: P0 implementation in PR #2

## Goal

Keep one user-facing kosmos Home while publishing a configurable `ssh` TCP
service at the same time. Use one Hypertele server process per service, one
shared publisher allowlist, and one persistent Mac client identity.

The first real path is:

```text
Mac ssh client
  -> 127.0.0.1:2222
  -> Hypertele client for Registry service `ssh`
  -> public HyperDHT / Noise / UDX
  -> kosmos Hypertele server for `ssh`
  -> 127.0.0.1:22
  -> kosmos-wsl sshd
```

## Exit criteria

- Publisher and client state are generated separately on their owning device.
- Publisher setup accepts one or more client public keys and configurable
  loopback TCP targets.
- One publisher command keeps Home and every configured TCP service running.
- Home Registry lists stable service keys without exposing seeds.
- One Mac client command keeps Home and the selected TCP service available
  concurrently.
- The same client identity can access Home and SSH through separate Hypertele
  processes.
- Automated isolated-DHT coverage proves Home, Registry, TCP bytes, cleanup,
  shared allowlist, and restart-stable keys.
- A real public-DHT smoke reaches kosmos-wsl sshd from the Mac and preserves
  normal SSH host-key and user authentication.
- All listeners bind to loopback, targets are fixed publisher configuration,
  and no secret enters Git or logs.

## Anti-goals

- True wire-level multiplex or Protomux.
- Relay, Android, GUI, QR pairing, dynamic trust, service ACLs, or arbitrary
  remote target selection.
- Replacing SSH authentication with Kepos authentication.
- Making the transient dogfood deployment the final kosmos NixOS module.

## Task 1: Generalize config and Registry with tests first

Files:

- `src/config.ts`
- `src/home/registry.ts`
- `src/home/server.ts`
- `src/p0/hypertele-process.ts`
- `test/config.test.ts`
- `test/home.test.ts`
- `test/hypertele-process.test.ts`

Add strict publisher manifest and TCP service parsing. Generalize the Home
Registry to list Home plus configured services. Allow a Hypertele client to
request an explicit loopback port while retaining ephemeral port support.

Verification:

```sh
npm test -- test/config.test.ts test/home.test.ts test/hypertele-process.test.ts
```

Commit: `feat(services): add configurable publisher services`

## Task 2: Add role-separated setup with tests first

Files:

- `src/dogfood/setup-client.ts`
- `src/dogfood/setup-publisher.ts`
- `src/dogfood/contact.ts`
- `src/dogfood/state.ts`
- `test/dogfood-state.test.ts`
- `package.json`

Generate the client identity only on the client. Generate Home and service
seeds only on the publisher. Persist owner-only files atomically, preserve
valid existing identities, reject partial or unsafe state, and print public
values only.

Verification:

```sh
npm test -- test/dogfood-state.test.ts
```

Commit: `feat(dogfood): add role-separated state setup`

## Task 3: Supervise Home and TCP services with tests first

Files:

- `src/dogfood/publisher.ts`
- `src/dogfood/client.ts`
- `src/dogfood/tunnel.ts`
- `test/dogfood-runtime.test.ts`
- `package.json`

Start one Home Hypertele server and one server for each configured TCP target.
On the client, open Home, fetch and validate Registry, then keep Home and the
selected service tunnel alive together. If any startup fails, stop every
process and listener.

Verification:

```sh
npm test -- test/dogfood-runtime.test.ts
npm run typecheck
```

Commit: `feat(dogfood): run Home and TCP services together`

## Task 4: Prove the isolated multi-service path

Files:

- `test/dogfood-smoke.test.ts`
- `docs/evidence/mac-kosmos-ssh-dogfood.md`

Use an isolated HyperDHT bootstrap, a benign TCP fixture, one publisher, and
one client identity. Prove Home and Registry remain available while TCP bytes
cross the second service tunnel, then prove clean shutdown and stable keys.

Verification:

```sh
npm test -- test/dogfood-smoke.test.ts
npm test
```

Commit: `test(dogfood): verify concurrent Home and TCP access`

## Task 5: Deploy through SSH and run the real dogfood

Copy the reviewed branch to kosmos over the existing `ssh nuc` path, install
with the existing Node/Bun environment, generate publisher state with the Mac
public key, and run it as a user service. Save the public Home key on the Mac,
start the `ssh` service at `127.0.0.1:2222`, then verify SSH, SCP, restart, and
revocation.

If the permanent NixOS declaration cannot be completed through SSH because the
authoritative kosmos repository or Forge credentials are absent, record exact
module, secret, service, and deployment work in FlickNote project
`orientation`. Do not put publisher seeds or client secret keys in the note.

Commit: `test(dogfood): record the Mac to kosmos SSH smoke`
