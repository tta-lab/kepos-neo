# Kepos field validation

Status: optional protocol for external dogfood; not an engineering gate

## Purpose

Automated tests and operator-run probes show whether Kepos works. They do not
show whether another person can install it, understand its trust boundary, or
still want it after the first successful connection.

Use this protocol when testing with someone outside the implementation team.
The current Android and Navic spike should proceed on its technical acceptance
criteria; it does not need a fabricated user-study ledger first.

## Evidence classes

Keep these classes separate:

1. `hands-on`: the participant operates the product.
2. `observed-pair`: an owner and recipient perform the workflow together.
3. `moderated-walkthrough`: the participant reacts to a concrete flow but
   does not operate it.
4. `technical`: an automated or operator-run network, revocation, recovery, or
   performance probe.

Only hands-on and observed-pair results count toward setup time, unassisted
success, and continued-use rates. A walkthrough can reveal a confused mental
model but cannot be reported as a completed task. A technical pass cannot be
reported as user adoption.

## Minimal session record

Write a short record with:

- anonymous study ID, date, evidence class, device, OS, and network shape;
- the participant's real service and current solution;
- product version or commit and the exact task prompt;
- start time, first usable service time, result, and every intervention;
- whether router, port, proxy, Clash, DNS, or firewall changes were required;
- the participant's first explanation of who has access and what must remain
  online;
- the localhost URL or service kind, but no private hostname or content;
- failures and recovery time after one real network change;
- direct quotes kept separate from moderator interpretation.

“Without assistance” means the moderator did not type, click, choose a policy,
edit networking, explain a product-specific concept, or diagnose a failure.
Record the intervention rather than quietly counting the run as unassisted.

## Current Android/Navic task

The first external mobile task should state only the outcome:

> Connect Navic to the named self-hosted Navidrome service, start playback,
> close the Kepos UI, lock the phone, and move between Wi-Fi and cellular
> without changing the Navic server URL.

Record separately:

- pairing and allowlist work performed by the publisher operator;
- time until Navic receives its first playable response;
- whether `navidrome.localhost` works or a numeric loopback fallback is used;
- foreground notification comprehension;
- locked-screen playback duration;
- reconnect time and whether playback resumes after network change;
- whether the participant knows how to stop Kepos and remove access.

This task proves the subscriber product. It does not prove family sharing,
multi-subscriber demand, or a general replacement for Tailscale.

## Immediate questions

Ask neutrally, before correcting the participant:

1. Where is Navidrome running, and which part is Kepos providing?
2. Who can connect to this publisher now?
3. If Navidrome is offline, has access been revoked?
4. What needs to keep running on the phone and publisher?
5. What was harder than the participant's current method?
6. Would they use the same setup for another service? Which one?
7. Describe Kepos to a friend in one sentence.

Do not ask whether the UI is attractive before the participant explains the
system in their own words.

## Follow-up

For a participant who keeps the app installed, collect at day 30:

- distinct use days and completed uses;
- whether at least three real uses occurred;
- which publishers and services were used;
- whether another service was added without moderator suggestion;
- network, proxy, battery, background-service, or reconnection failures;
- whether manual help was required after the initial session;
- whether the participant still wants the software installed.

A missing follow-up is missing data, not proof of zero use. Report response
rate and raw counts. Never publish a percentage without its numerator and
denominator.

## Metrics retained as hypotheses

Earlier product work proposed these targets:

- median install-to-first-service below 10 minutes;
- at least 80% first success without network edits or human help;
- at least 90% correct understanding of the access boundary;
- at least 70% of enrolled headless owners using Kepos three times in 30 days;
- at least half adding a second real service or session.

They remain hypotheses, not claims. Declare the cohort and eligibility rules
before collecting data; do not tune the denominator after seeing results.

## Privacy and redaction

Obtain separate consent to observe the session and to publish redacted
evidence. If publication consent is absent, keep the raw record outside this
public repository and publish only safe aggregate counts.

Never collect or commit:

- publisher seeds or subscriber secret keys;
- identity JSON, tokens, recovery codes, cookies, or Navidrome credentials;
- private service content, private hostnames, or unredacted terminal history;
- a real name when an anonymous study ID is enough.

Public peer keys should also be omitted unless a revocation result requires a
stable public label. Prefer a one-way study-local label.

## Interpretation rules

- Keep facts, quotes, and interpretation in separate fields.
- Mark excluded, ineligible, and missing observations explicitly.
- Do not compare setup times from hands-on use with walkthrough estimates.
- Do not claim a product winner from one network or one technically skilled
  participant.
- Recheck competitor versions and official instructions before a comparison.
- Treat repeated own-device use as valid evidence for the Android subscriber;
  it no longer automatically fails a person-first positioning gate.
- Treat demand for a controller, network-wide access, RBAC, or public sharing
  as evidence that another product may fit better, not as an automatic Kepos
  feature request.

## Decision output

After a declared cohort, report one of:

- `Pending evidence`: required sessions or follow-ups are missing.
- `Continue`: the task works, people return, and no stop condition fires.
- `Revise`: the service-access job is real but setup, trust, recovery, or
  platform behavior fails.
- `Use an existing product`: the actual need is a managed private network, a
  one-time two-peer session, public ingress, or mature relay coverage.

List raw observations and limits. A passing CI suite cannot override failed
field use, and a difficult field network cannot by itself prove a code defect.
