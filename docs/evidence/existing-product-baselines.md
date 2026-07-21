# Existing-product technical baselines

Status: historical technical evidence, not a current product gate

Evidence date: 2026-07-10

Reviewed: 2026-07-21

## Why this remains

This document preserves the parts of the original MLP V0 work that came from
an actual probe or establish a durable authority distinction. It does not
claim that the named versions remain current, that a technical result proves
user demand, or that Kepos must stop until a formal study is complete.

The current Kepos implementation has moved beyond the direct Hypertele P0: it
owns its HyperDHT and Protomux runtime, keeps one persistent publisher
connection, multiplexes Home and TCP services, and has real Mac-to-kosmos-wsl
dogfood evidence. See [Hypertele provenance](../hypertele-provenance.md) and
[Mac-to-kosmos evidence](./mac-kosmos-ssh-dogfood.md).

## Comparable authority models

| Baseline | Service path | Authority and duration | Durable reading |
| --- | --- | --- | --- |
| Direct Hypertele 1.1.4 | Pinned peer key to one localhost TCP service | Persistent client key in a publisher-local allowlist | Historical implementation baseline; superseded inside Kepos by its mux runtime |
| `fowl` 25.10.0 | Named localhost TCP streams through one Magic Wormhole session | One-time code creates an identity-less two-peer session | Strong fit for a bounded two-person activity, not unattended durable membership |
| Tailscale Sharing and Serve | Local services exposed through a tailnet and machine sharing | Accounts, tailnets, policy, and an online control plane govern durable access | Mature default when hosted coordination and a device-network model are acceptable |
| Headscale with Tailscale clients | Local services reached through a self-hosted tailnet | A self-hosted controller registers nodes and applies policy | Removes the Tailscale-operated controller, not the controller or network-first model |
| Kepos | Explicit localhost services over a pinned publisher connection | Publisher-local peer-key allowlist; no online authorization decision | Smaller authority and routing boundary, with weaker platform and hard-NAT coverage |

These products can all move bytes. The useful comparison is what must remain
online, which entity grants access, whether trust survives a session, and
whether the user is joining a network or opening an explicit service.

## Recorded `fowl` probe

The original probe used `uvx` without changing this repository:

```text
fowl: 25.10.0
magic-wormhole: 0.24.0
mailbox: public default
topology: two local fowl processes and one benign loopback HTTP fixture
```

Sanitized command shape:

```sh
python3 -m http.server 18080 --bind 127.0.0.1 --directory docs
uvx --from 'fowl==25.10.0' fowl --no-logo --clearnet \
  --remote home:18080:listen=18081
uvx --from 'fowl==25.10.0' fowl --no-logo --clearnet \
  --local home:18081:remote-connect=18080 <one-time-code>
curl --fail http://127.0.0.1:18081/mlp-decisions.md
```

The commands pin the top-level `fowl` release. The original resolver lock was
not retained, so they do not guarantee the exact recorded
`magic-wormhole==0.24.0` transitive environment. Reproducing that environment
exactly would require a preserved `uv.lock` or equivalent constraint set.

The invite side allowed a named `home` service. The join side consumed the
generated code and exposed the paired loopback listener. The request returned
the expected fixture. Stopping the join process removed the listener. No code,
verifier, peer address, or debug log was retained.

Verified result: `fowl` can carry several named streams in one live two-peer
session, and Magic Wormhole Dilation can keep that session usable across a
temporary path change. The one-time code does not create durable person or
device membership after the session ends.

## Tailscale and Headscale facts retained

The evidence-date documentation established:

- Tailscale machine sharing grants another Tailscale user access to a shared
  machine rather than their whole tailnet.
- Tailscale policy can narrow access by user, machine, service, and port.
- Tailscale Serve can proxy a localhost HTTP or TCP service into a tailnet.
- Headscale can use local users and pre-authenticated keys; an external IdP is
  optional.
- Headscale still operates an authorization controller and clients still
  register with it.

These are not current-version claims. Recheck official documentation before
using them in a product comparison or publication.

## What technical evidence cannot answer

No probe here establishes:

- that users prefer manual peer keys to an account or one-time code;
- that controllerless authority is worth weaker network coverage;
- that users understand offline service versus revoked trust;
- that they return after the first successful connection;
- that they need a second service or another subscriber;
- that Kepos is easier than Tailscale, Headscale, `fowl`, or FRP.

Those questions require observed use. The compact protocol for collecting that
evidence lives in [Kepos field validation](../kepos-field-validation.md).

## Sources

- [Hypertele 1.1.4](https://www.npmjs.com/package/hypertele/v/1.1.4)
- [`fowl` README](https://fowl.readthedocs.io/en/stable/README.html)
- [`fowl` CLI usage](https://fowl.readthedocs.io/en/latest/usage.html)
- [Tailscale machine sharing](https://tailscale.com/kb/1084/sharing)
- [Tailscale Serve](https://tailscale.com/kb/1312/serve)
- [Headscale features](https://headscale.net/stable/about/features/)
- [Headscale getting started](https://headscale.net/stable/usage/getting-started/)
