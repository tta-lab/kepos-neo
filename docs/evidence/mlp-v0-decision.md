# MLP V0 value-gate decision

Status: Pending evidence

Decision date: 2026-07-10

MLP V0 is not cleared to enter V1. The P0 technical baseline passed, but no
eligible target-user session or 30-day follow-up has been recorded. A technical
pass cannot answer whether Kepos is needed beyond direct Hypertele, `fowl`,
Tailscale, or Headscale.

Use the [value-gate runbook](../mlp-v0-value-gate-runbook.md) and copy the
[session template](./mlp-v0-session-template.md) for each participant or pair.

## Evidence on hand

- P0 shows that the single-desktop Hypertele baseline can persist one Home
  identity, allow A, deny B, keep B denied after an on-disk allowlist change,
  load that change on restart without changing the Home key, and serve A/B
  concurrently.
- P0 implementation and evidence are under review in
  [PR #2](https://git.guion.io/neil/kepos-neo/pulls/2).
- The [existing-product technical baselines](./mlp-v0-existing-product-baselines.md)
  verify current direct Hypertele and fowl behavior and the documented
  Tailscale and Headscale authority models. They contain no participant result.
- The accepted user, demand, and competitor documents state hypotheses and
  thresholds. They are not participant results.
- Eligible immediate sessions: `0`.
- Eligible 30-day follow-ups: `0`.

## Gate ledger

`n/N` is `missing` where no eligible denominator exists.

| Accepted metric or risk | State | Raw result |
| --- | --- | --- |
| Median install-to-first-service under 10 minutes | missing | `0` eligible times |
| At least 80% first success without port mapping, Clash, or help | missing | `0/0` |
| At least 90% correctly understand access | missing | `0/0` |
| Removed key rejected after publisher restart | pass, technical only | P0 probe; `0` participant runs |
| At least 70% of headless owners use three times in 30 days | missing | `0/0` |
| At least half publish a second service/session | missing | `0/0` |
| More than 20% require network/Clash edits | missing | `0/0` |
| Headless 30-day actual use below 30% | missing | `0/0` |
| Users refuse an always-on headless install | missing | `0/0` |
| Full-family trust blocks real relationships | missing | `0/0` |
| Use is only own-device connectivity | missing | `0/0` |
| Person-first flow is not shorter than Tailscale | missing | no paired tasks |
| Product is described as VPN/port mapping | missing | no verbatim descriptions |
| Product feels harder than Tailscale/frp | missing | no participant comparisons |
| Users still handle devices, ports, relays, or networking | missing | no participant tasks |
| Relay is the long-term path for most connections | missing | no field connections |
| The model demands central accounts or chat/feed/complex permissions | missing | no participant requests |

The optional game gates are not evaluated because no recruited Job C need has
been recorded.

## Existing-product verdict

No participant comparison has been run. Technical checks confirm each
product's test role, not a winner:

- direct Hypertele is the pinned-key localhost-proxy baseline;
- `fowl` is the one-code, durable two-peer session baseline;
- Tailscale is the mature hosted network baseline;
- Headscale plus Tailscale is the self-hosted controller baseline.

Choosing Kepos over any of them now would be a claim without user evidence.

## Next decision point

Keep this status until immediate sessions and required 30-day follow-ups have
raw records. Then replace each `missing` entry with its numerator, denominator,
and evidence links, and choose one outcome defined by the runbook. Do not start
MLP V1 while this record says `Pending evidence`.
