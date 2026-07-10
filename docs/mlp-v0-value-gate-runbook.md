# MLP V0 target-user value gate runbook

Status: ready for field execution; no participant result recorded

This runbook closes the part of MLP V0 that P0 cannot prove: whether target
users need repeated, controllerless, one-to-many service sharing enough to
justify building Kepos beyond direct Hypertele. P0 proves the technical
single-desktop baseline only. It is not user-value evidence.

Sources of truth:

- [User and demand analysis](./user-and-demand-analysis.md), especially
  “Most promising users,” “Jobs to be done,” “Validation metrics,” and “Stop
  conditions”
- [Competitive value analysis](./competitive-value-analysis.md), especially
  “Use / fork / build,” “Product propositions to validate,” and “Kill criteria”
- [MLP decisions](./mlp-decisions.md), especially “Network stages”
- [P0 plan](./mlp-v0-hypertele-home-plan.md), sections 1–3 and 12

## Evidence boundary

The study may produce four evidence modes. Report them separately:

1. `hands-on`: the participant operates the product and target service.
2. `observed-pair`: owner and recipient perform the workflow together.
3. `moderated-walkthrough`: the participant reacts to a concrete flow but does
   not operate it.
4. `technical`: an automated or moderator-run probe, such as revocation.

Only `hands-on` and `observed-pair` sessions enter task-success, elapsed-time,
first-connection, and assistance-rate denominators. Walkthroughs may answer
mental-model and preference questions, but must not be counted as completed
product tasks. P0 results remain technical evidence.

The cohort size is not set by this document. Declare it before the first
session and report raw numerators, denominators, exclusions, and missing data.
Never present a percentage without its `n/N`.

## Eligible participants and jobs

Recruit people who match at least one accepted target group:

- owner of WSL, NAS, a home server, or another headless local service;
- member of a small, stable family with a clear service owner;
- trusted friend with a repeated shared activity or local-service need.

Record which job is real for the participant:

- Job A: reach their own headless service from another device.
- Job A2: let two people use one long-lived family service concurrently.
- Job B: give a local service to a trusted person without teaching networking.
- Job C: start a named game session. This is optional in V0 unless the
  participant already has that need.

Do not recruit enterprise SSO/RBAC, public anonymous access, whole-subnet VPN,
or arbitrary-game compatibility needs as if they were Kepos target jobs.

## Comparison set

Use the same job statement for each applicable alternative:

| Alternative | Question for V0 | Accepted role |
| --- | --- | --- |
| Direct Hypertele | Is a pinned key plus one localhost proxy already enough? | Technical and manual-key baseline |
| `fowl` | Is a one-code, durable two-peer session enough, making persistent person trust unnecessary? | Identity-less session baseline |
| Tailscale Sharing/Serve | Does a mature account/controller and network-first flow already solve the job acceptably? | Mature hosted baseline |
| Headscale + Tailscale | If self-hosting is acceptable, does a controller-based tailnet remove the need for Kepos? | Self-hosted controller baseline |

Do not claim feature parity from a walkthrough. Record product version, setup
mode, prior familiarity, account/controller prerequisites, and whether the
task was hands-on. Follow official product instructions used on the test date;
store their URLs in the session record.

## Privacy and safety

Before starting, obtain separate consent to record the session and to publish
redacted evidence in this public repository. If publication consent is absent,
keep the session record outside the repository and publish only anonymous
aggregate counts that cannot identify the participant. Use a study ID instead
of a real name in the repository.

Never collect or attach:

- publisher seeds, client secret keys, identity JSON, auth tokens, recovery
  codes, private hostnames, or private service content;
- unredacted terminal history or screenshots containing those values.

Public peer keys may be recorded only when needed for a revocation result.
Prefer a one-way study-local label. Delete temporary credentials after the
session according to the participant’s normal product cleanup flow.

## Preparation

For every session:

1. Copy [the session template](./evidence/mlp-v0-session-template.md).
2. Assign a study ID and declare evidence mode for each task.
3. Record participant job, prior tool familiarity, devices, service kind, and
   whether owner and recipient are different people.
4. Prepare the same benign local HTTP fixture or participant-owned service for
   comparable hands-on tasks. Do not use private content as proof.
5. Verify the moderator can stop every process and remove temporary access.
6. Write the task prompt before showing any product UI or commands.
7. Set and record a counterbalanced comparison order. Do not show every
   participant the alternatives in the same order.

## Immediate session protocol

### 1. Baseline interview

Ask without naming Kepos:

- What local service or shared activity do you actually want to reach?
- Who should use it, from which devices, and how often?
- How do you solve it today? What failed or felt costly?
- Would a cloud account, online authorization controller, or one-time code be
  acceptable? Why?

Record facts and direct quotes separately from moderator interpretation.

### 2. Job A or A2 hands-on task

Give only the outcome:

> Make the named local service open from the recipient device. For A2, both
> recipients must open it concurrently. Access must still work after the owner
> UI is closed, unless the tested product explicitly requires it.

Start the clock when the participant receives install/setup instructions. Stop
when the recipient receives expected service content. Record every account,
code, peer-key, device, network, port, ACL, and approval concept the participant
must handle.

“Without assistance” means the moderator does not type, click, choose a policy,
edit a network/Clash rule, explain a product-specific concept, or diagnose an
error. Reading the fixed task prompt and asking the participant to think aloud
do not count as assistance. Record each intervention verbatim.

### 3. Job B workflow comparison

Use an actual hands-on flow when available; otherwise mark it as walkthrough.
Present the same outcome for direct Hypertele, `fowl`, Tailscale, Headscale,
and the proposed Kepos person-first flow, using the recorded comparison order:

> Give this service to this trusted person so they can reopen it later without
> learning the remote IP, port, or router configuration.

For each alternative record:

- steps the participant believes are necessary;
- time and assistance for hands-on evidence;
- whether they can name who has access and what must remain online;
- whether long-lived trust, a one-time code, or account/controller membership
  matches their real need;
- whether publisher-wide family access feels acceptable or too broad.

Do not ask “which UI do you like?” before the participant explains the access
model in their own words.

### 4. Comprehension and proposition questions

Ask in neutral wording and record the answer before correcting it:

1. Who can open the service now? Which other services can they open?
2. If the service is offline, has trust been revoked?
3. If a key is removed, when should the running publisher reject it?
4. Who decides access when the owner UI and any cloud service are offline?
5. Would you rather keep a long-lived trusted relationship, issue a new
   one-time code, or add devices to a managed network for this job?
6. Is publisher-wide family trust acceptable for this person?
7. Do named sessions matter, or are long-lived named services enough?
8. Does removing an authorization controller justify manual key exchange?

Score access comprehension only from question 1 using the expected access
state recorded before the task. Keep the other answers qualitative.

### 5. Revocation probe

For a hands-on Kepos/Hypertele run, the moderator removes the tested client
public key, restarts the publisher, and attempts a new connection. Record the
result as technical evidence. Do not expose or record a secret key. A local
listener becoming ready is not proof that the remote publisher authorized it.

### 6. Immediate debrief

Ask:

- Describe this product to a friend in one sentence.
- What was harder than your current method?
- What would stop you from trusting a real family member or friend?
- What second service or session would you publish, if any?
- Which alternative would you choose today, and why?

Do not convert hypothetical intent into a completed-task or 30-day-use result.

## Thirty-day follow-up

For participants who installed a headless owner, collect at day 30:

- number of distinct days and completed uses;
- whether at least three uses occurred;
- number of recipients and whether use was only between the owner’s devices;
- whether and when a second service or session was actually published, and
  whether the participant chose it before the moderator suggested one;
- manual network/Clash changes, relays, failures, and moderator help since the
  immediate session;
- whether the participant still wants the software installed.

Missing follow-up is missing data, not “did not use.” The accepted headless-use
gate applies to all enrolled owners who installed it, so report confirmed uses
over that denominator, follow-up response rate, and the responding-only result.
Do not declare the gate passed while missing data could change the outcome.

## Evidence ledger and accepted gates

Aggregate only compatible evidence modes. The ledger must show:

| Accepted metric or risk | Raw evidence required |
| --- | --- |
| Median install-to-first-service under 10 minutes | Every eligible elapsed time, exclusions, median, `N` |
| At least 80% first success without port mapping, Clash, or help | unassisted successes / eligible first attempts |
| At least 90% correctly understand access | correct question-1 answers / participants asked |
| Removed key rejected after publisher restart | attempts, expected key label, observed no-response/reset outcome |
| At least 70% of headless owners use three times in 30 days | confirmed qualifying owners / enrolled owners who installed it, plus follow-up response rate and responding-only result |
| At least half proactively publish a second service/session after the demo | unsolicited actual second publications / eligible participants, with date |
| Optional game: 8/10 start in one invite | one-invite starts / attempts |
| Optional game: 95% complete 30 minutes | completed sessions / started sessions |
| More than 20% require network/Clash edits | edited first connections / eligible first connections |
| Headless 30-day actual use below 30% | active owners / enrolled headless owners, with missing follow-up shown |
| Users refuse an always-on headless install | refusals / eligible owners offered the install, with reasons |
| Full-family trust blocks real relationships | refusals and reasons / participants offered a real relationship |
| Use is only own-device connectivity | own-device-only users / followed participants |
| Person-first flow is not shorter | paired steps/times and participant explanation against Tailscale |
| Product is described as VPN/port mapping | verbatim descriptions coded after collection |
| Product feels harder than Tailscale/frp | verbatim comparison and chosen alternative |
| Users still handle devices, ports, relays, or networking | concepts handled and comprehension answers |
| Relay is the long-term path for most connections | relay connections / observed connections, duration, and cost estimate |
| The model demands central accounts or chat/feed/complex permissions | requests and the job that caused each request |

Also record controller/account acceptance, preference for one-time versus
long-lived trust, need for named sessions, relay dependence, and demands for
chat/feed/RBAC. These are decision inputs, not invented numeric gates.

## Decision output

The decision record must be one of:

- `Pending evidence`: required immediate or 30-day fields are missing.
- `Go to MLP V1`: accepted value metrics pass, no kill criterion fires, target
  users need a gap not already met by the comparison set, and controllerless
  long-lived trust remains part of the product.
- `No-go — use Headscale/Tailscale`: the durable need is device-network access
  or an authorization controller is acceptable.
- `No-go — use fowl`: the need is an identity-less two-peer session rather
  than persistent person membership or one-to-many trust.
- `No-go — direct Hypertele is enough`: manual pinned-key localhost proxies
  satisfy the target users without a person/service product layer.
- `Revise and repeat V0`: evidence supports the job but rejects the proposed
  family-wide trust or workflow boundary.

List every metric with `pass`, `fail`, or `missing`, its raw `n/N`, and a link
to session records. A technical P0 pass cannot override a missing or failed
value gate. Do not enter MLP V1 while the decision remains pending.
