# Mac to kosmos SSH dogfood evidence

Date: 2026-07-17

## Path

```text
Mac ssh/scp
  -> 127.0.0.1:2222
  -> Hypertele client service `ssh`
  -> public HyperDHT
  -> kosmos Hypertele publisher service `ssh`
  -> kosmos-wsl 127.0.0.1:22
```

Home stays available through a second Hypertele process. Both Mac processes
use the same client identity. Home and SSH use distinct publisher seeds and
service keys with one shared allowlist.

## Public identifiers

- Mac client key:
  `ce712ee54158ca783ba679763774c5ea4cbea6f18108630af6483c8485c35d71`
- kosmos Home key:
  `6b8da9a3d91aa13f7f6b1ee66b5a15d8adce9cf16936f3dd8be81391b6acfc55`
- kosmos SSH service key:
  `b644a8297cb0762f672baa9967d189b15a94d01180340ef408072a123ada7d15`

No seed or client secret is recorded here.

## Automated proof

`test/dogfood-smoke.test.ts` uses an isolated three-node HyperDHT testnet. It
proved:

- Home HTML and Registry cross the Home tunnel.
- TCP bytes cross the second service tunnel.
- one client identity opens both tunnels;
- publisher state and public keys remain stable across repeated setup;
- all child processes and listeners close cleanly.

## Real kosmos proof

The publisher was copied through the existing `ssh nuc` path and started as
the enabled `kepos-dogfood-publisher.service` user unit. The unit publishes:

- Home from a random loopback HTTP port;
- `ssh` to the existing loopback-only kosmos-wsl sshd on port 22.

The Mac client fetched the Registry through Home and opened SSH at
`127.0.0.1:2222`.

Command-mode SSH returned:

```text
kosmos-wsl
neil
active
```

SCP copied `package.json` through the tunnel. The local and remote SHA-256
values were identical:

```text
a3aab0230bd1d8afa8bf73ac253046caef30062e42bb72623342ec31fe575f2c
```

Restarting the publisher kept the same Home and SSH service keys. The existing
Mac client reconnected and a new SSH command returned:

```text
restart-ok
kosmos-wsl
```

Removing the Mac key from both publisher allowlists and restarting caused SSH
through port 2222 to close. Restoring the key and restarting restored access:

```text
revocation-ok: SSH access denied after allowlist removal
restore-ok
kosmos-wsl
```

The systemd unit uses `KillMode=mixed`. This sends the normal stop signal only
to the supervisor, while still letting systemd kill the whole control group if
the supervisor cannot finish shutdown. The default control-group mode sends
SIGTERM directly to each Hypertele child and bypasses clean shutdown.

## Windows public-path observability spike

A later spike moved the publisher side to Windows on the NUC:

```text
Mac HTTP
  -> 127.0.0.1:17480
  -> Hypertele client with `--route public`
  -> public HyperDHT direct UDP path
  -> Windows Hypertele server
  -> Windows Home on 127.0.0.1
```

The Windows Home key remains
`6b8da9a3d91aa13f7f6b1ee66b5a15d8adce9cf16936f3dd8be81391b6acfc55`.
Its separate Windows SSH key is
`38c63a7d22a6d0531f2a81e4f741c45753a01446c193b558e62606768292cb4c`.
No seed or private key is recorded here.

Hypertele now records connection attempts, DHT and Noise handshake time,
readiness-probe time, first-byte time, transfer time, byte counts, and
effective transfer rate. It retries a failed handshake or readiness probe
before consuming the pending local TCP request. The observed samples all
succeeded on their first application-level attempt, so retry behavior is
proved by automated tests rather than by a forced live failure.

The final samples forced `--route public`. They reached the Windows peer at
public address `125.110.47.243`, and HyperDHT reported zero relay attempts.

| Sample | DHT handshake | Probe | Home first byte after ready | Transfer | Established rate | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| health, cold | 2.37 s | 15 ms | 18 ms | — | — | 2.41 s |
| health, one-second gap | 16 ms | 9 ms | 8 ms | — | — | 34 ms |
| health, four-second gap | 4.19 s | 416 ms | 826 ms | — | — | 5.43 s |
| 16 MiB, cold | 6.59 s | 445 ms | 1.58 s | 4.78 s | 3.51 MB/s | 13.39 s |
| 64 MiB, cold | 5.11 s | 441 ms | 2.42 s | 16.31 s | 4.11 MB/s | 24.28 s |

The aggregate curl rates, which include setup and first-byte delay, were
1.25 MB/s for 16 MiB and 2.76 MB/s for 64 MiB.

HyperDHT keeps a reusable UDP route for three seconds after a connection
closes. This matches the observed 34 ms request after a one-second gap and the
return to multi-second setup after a four-second gap. Its
`connectionKeepAlive` setting applies to a connection that is still open; it
does not extend this route-cache window.

The main delay is public route discovery and hole punching, not steady-state
transfer. Once established, this path moved large responses at roughly
3.5–4.1 MB/s in the final forced-public samples.

## Deployment status

The live kosmos deployment is deliberately transient:

- source: `/home/neil/.local/share/kepos-neo-dogfood`
- publisher state: `/home/neil/.local/state/kepos-neo/publisher`
- user unit: `kepos-dogfood-publisher.service`

FlickNote orientation note `1342` records the exact NixOS and agenix follow-up.
The permanent change needs the authoritative kosmos repo, which is not present
on kosmos-wsl.
