# MLP V0 existing-product technical baselines

Status: technical evidence only; no target-user result

Evidence date: 2026-07-10

## Question and value stance

This check calibrates the V0 decision; it does not copy competitor features.
The question is whether an existing product already meets repeated,
controllerless, one-to-many service sharing closely enough that Kepos should
stop. Technical evidence can define each baseline, but only target users can
decide whether its account, controller, key, and trust costs are acceptable.

## Comparable result

| Baseline | Verified service path | Authority and duration | Current V0 reading |
| --- | --- | --- | --- |
| Direct Hypertele 1.1.4 | Pinned Home key to a localhost HTTP service | Persistent client key in the publisher-local allowlist | Closest controllerless long-lived baseline; P0 shows manual keys and one process can work, but not that users need a product layer |
| fowl 25.10.0 | Named localhost TCP service through a two-peer wormhole session | One-time pairing code creates an identity-less session; Dilation can survive network changes while that session is active | Stronger than a one-request tunnel, but not persistent person membership or one-to-many trust |
| Tailscale Sharing + Serve | A shared machine can expose a localhost service through Serve | Tailscale accounts, tailnets, admin action, control plane, and policy govern durable access | Already solves much of Job B when a hosted controller and network membership are acceptable |
| Headscale 0.29.2 + Tailscale | Registered tailnet nodes can reach services under self-hosted policy | An internet-reachable Headscale service registers nodes and remains the coordination controller | Removes the Tailscale-operated control service, not the controller or network-first model |

These readings are interpretations of the verified facts below. They are not
task-time, comprehension, preference, or 30-day-use results.

## Direct Hypertele

🔍 Verified: [P0 PR #2](https://git.guion.io/neil/kepos-neo/pulls/2) uses
Hypertele 1.1.4 and proves, on one desktop, a stable Home identity, persistent
client identities, allow/deny, restart-time revocation, and two allowed clients
opening the same Home concurrently.

💭 Interpretation: direct Hypertele is enough if target users accept manual
key exchange, one localhost proxy per service, and no person/service UI. P0
does not answer that question.

## fowl

### Reproducible probe

The probe used `uvx` without changing this repository:

```text
fowl: 25.10.0
magic-wormhole: 0.24.0
mailbox: public default
topology: two local fowl processes and one benign loopback HTTP fixture
```

Sanitized command shape:

```sh
python3 -m http.server 18080 --bind 127.0.0.1 --directory docs
uvx --from fowl fowl --no-logo --clearnet \
  --remote home:18080:listen=18081
uvx --from fowl fowl --no-logo --clearnet \
  --local home:18081:remote-connect=18080 <one-time-code>
curl --fail http://127.0.0.1:18081/mlp-decisions.md
```

The invite side allowed a named `home` service at the fixture port. The join
side consumed the generated code and exposed the paired loopback listener.
A request through that listener returned the expected fixture content. After
the join process stopped, the listener no longer accepted connections. All
processes and fixture listeners were then stopped; no code, verifier, address,
or debug log was retained.

🔍 Verified: current fowl successfully forwards a named localhost HTTP service
through a live wormhole session. Its official docs say the code is one-time,
the connection is identity-less and between two peers, Dilation can survive
network changes or outages, and one session can carry multiple named streams.

💭 Interpretation: fowl is a fair baseline for an ongoing two-person activity,
not merely a one-request tunnel. It does not itself provide a stable person
identity, an owner allowlist shared by multiple recipients, or unattended
re-pairing after the session ends.

## Tailscale Sharing and Serve

🔍 Verified from current official docs:

- Sharing grants one external Tailscale user access to a shared machine, not
  the rest of the recipient's tailnet. The recipient accepts through their own
  Tailscale account and tailnet.
- Owner, Admin, or IT admin action is required to share and accept a machine.
  Access policy can further restrict the shared machine by user and port.
- Serve proxies a localhost HTTP or TCP service into the tailnet. Enabling the
  default HTTPS flow may require a web consent step and tailnet certificates.
- The installed macOS CLI is 1.90.8. Its local help accepts a port or localhost
  URL and supports HTTP, HTTPS, and raw TCP forwarding. The local Tailscale
  backend was stopped, so no account or network state was changed for this
  check.

💭 Interpretation: Tailscale is the strongest existing-product baseline. It
can provide durable user sharing and a localhost service proxy, with a mature
client. Its difference from Kepos is authority and product shape, not a lack
of working service access. V0 must ask whether users value removing the hosted
account/controller enough to accept manual long-lived keys.

## Headscale and Tailscale

🔍 Verified from current official docs and release metadata:

- Headscale 0.29.2 is the latest release on the evidence date.
- Headscale describes itself as a self-hosted open-source alternative to the
  Tailscale control server for self-hosters and hobbyists.
- The documented setup requires an installed service, adjusted configuration,
  an internet-reachable Headscale endpoint, and Tailscale clients.
- A node must register with the controller. Manual browser registration or a
  pre-authenticated key can assign it to a Headscale user; an external IdP is
  optional, not required.
- The current feature matrix does not mark HTTPS Tailscale Serve as supported.
  Plain HTTP Serve may work, but the normal certificate-backed Serve flow is
  not a safe parity claim.

💭 Interpretation: Headscale is the right no-go choice when users accept
operating an authorization controller and actually want a private device
network. It does not satisfy Kepos's controllerless authority requirement.

## Recommendation

Keep the V0 decision `Pending evidence`.

- Do not build V1 merely because the four products differ on paper.
- Test direct Hypertele and fowl as the controllerless choices.
- Test Tailscale first as the mature default; add Headscale when self-hosting a
  controller is acceptable to the participant.
- Treat “Tailscale already solves this” as a no-go unless participants show a
  repeated need for controllerless, long-lived, one-to-many service trust.

## Unknown until field sessions

- Whether manual long-lived key exchange is acceptable.
- Whether a hosted or self-hosted authorization controller is acceptable.
- Whether fowl's two-peer session is enough for the real job.
- Whether the person-first path is shorter or clearer than Tailscale.
- Whether users return, add a real recipient, or publish another service.

## Sources

- [Hypertele 1.1.4](https://www.npmjs.com/package/hypertele/v/1.1.4) — MIT
  package metadata — P0 dependency and direct baseline
- [fowl README](https://fowl.readthedocs.io/en/stable/README.html) — MIT —
  identity-less two-peer model, Dilation, code, relay, and localhost streams
- [fowl CLI usage](https://fowl.readthedocs.io/en/latest/usage.html) — MIT —
  paired named services and human versus machine interfaces
- [Tailscale machine sharing](https://tailscale.com/kb/1084/sharing) — product
  docs — account, invite, machine, policy, and revocation behavior
- [Tailscale Serve](https://tailscale.com/kb/1312/serve) — product docs —
  localhost proxy, consent, certificates, identity, and limitations
- [Tailscale client license](https://github.com/tailscale/tailscale/blob/main/LICENSE)
  — BSD-3; the hosted coordination service is a separate product
- [Headscale features](https://headscale.net/stable/about/features/) — BSD-3 —
  project stance and compatibility matrix
- [Headscale getting started](https://headscale.net/stable/usage/getting-started/)
  — BSD-3 — service prerequisites, users, and node registration
- [Headscale 0.29.2](https://github.com/juanfont/headscale/releases/tag/v0.29.2)
  — BSD-3 — current release metadata
