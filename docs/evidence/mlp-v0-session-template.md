# MLP V0 session record: STUDY-ID

Status: draft | immediate complete | follow-up complete

Copy this file per participant or observed owner/recipient pair. Do not put
real names, secret keys, identity JSON, auth tokens, recovery codes, private
hostnames, or private service content in the repository.

## Consent and identity

- Study ID:
- Session date and timezone:
- Moderator:
- Consent to record task events, timings, answers, and quotes: yes | no
- Consent to publish redacted session evidence in this public repo: yes | no
- Participant/pair type: headless owner | family pair | trusted friends
- Real job: A | A2 | B | C
- Evidence mode used: hands-on | observed-pair | moderated-walkthrough | technical
- Owner and recipient are different people: yes | no

## Context

- Real service/activity and frequency:
- Devices and operating systems:
- Network shape relevant to the task:
- Current solution:
- Prior familiarity with Hypertele:
- Prior familiarity with fowl:
- Prior familiarity with Tailscale/Headscale:
- Account/controller acceptable before test: yes | no | conditional
- One-time code acceptable before test: yes | no | conditional
- Long-lived trust acceptable before test: yes | no | conditional
- Always-on headless install accepted: yes | no | not applicable
- Refusal reason:

## Product and source record

| Alternative | Version/date | Official instructions URL | Evidence mode | Prior familiarity |
| --- | --- | --- | --- | --- |
| Direct Hypertele | | | | |
| fowl | | | | |
| Tailscale Sharing/Serve | | | | |
| Headscale + Tailscale | | | | |
| Proposed Kepos flow | concept revision | local docs | | |

- Counterbalanced comparison order:

## Task observations

Record facts during the task. Put interpretation in the later section.

| Task/alternative | Start | End | Elapsed | Success | Assistance | Network/Clash edit | Steps/concepts handled | Evidence link |
| --- | --- | --- | ---: | --- | --- | --- | --- | --- |
| Job A/A2 | | | | | | | | |
| Job B — Hypertele | | | | | | | | |
| Job B — fowl | | | | | | | | |
| Job B — Tailscale | | | | | | | | |
| Job B — Headscale | | | | | | | | |
| Job B — proposed Kepos | | | | | | | | |

### Moderator interventions

List each intervention verbatim with timestamp and reason. Write `none` only if
the moderator did not type, click, choose policy, edit networking, explain a
product concept, or diagnose an error.

-

### A2 concurrency result

- Recipient A received expected content: yes | no | not run
- Recipient B received expected content concurrently: yes | no | not run
- Owner UI/controller required to stay open:

## Comprehension answers

Record the participant’s first answer before correction.

1. Who can open which service now?
   - Answer:
   - Expected state:
   - Correct: yes | no
2. If the service is offline, has trust been revoked?
   - Answer:
3. If a key is removed, when should it be rejected?
   - Answer:
4. Who decides access while owner UI/cloud services are offline?
   - Answer:
5. Preferred model and why: long-lived trust | one-time code | managed network
   - Answer:
6. Is publisher-wide family trust acceptable for this person?
   - Answer:
7. Named sessions or long-lived services?
   - Answer:
8. Is no authorization controller worth manual key exchange?
   - Answer:

## Technical revocation probe

- Run: yes | no
- Public client label (not secret material):
- Publisher restarted after removal: yes | no
- New connection produced no HTTP response/reset: yes | no
- Exact non-secret outcome:
- Evidence link:

## Immediate debrief — verbatim

- “Describe this product to a friend”:
- Harder than current method:
- Reason not to trust a real person:
- Second service/session they would publish:
- Alternative chosen today and reason:

## Thirty-day follow-up

- Follow-up requested date:
- Follow-up completed date:
- Missing follow-up reason, if known:
- Distinct use days:
- Completed uses:
- At least three uses: yes | no | missing
- Recipients:
- Own devices only: yes | no | missing
- Second service/session actually published: yes | no | missing
- Second publication date and service/session:
- Chosen before moderator suggestion: yes | no | missing
- Network/Clash edits since immediate session:
- Relay/failure/help events:
- Still installed/wanted: yes | no | missing

## Raw metric contribution

Use `eligible`, `not eligible`, or `missing`; do not infer missing results.

| Metric | Eligibility | Raw result |
| --- | --- | --- |
| Install-to-first-service elapsed | | |
| First success without network edit/help | | |
| Correct access comprehension | | |
| Revocation after restart | | |
| Three uses in 30 days | | |
| Published second service/session | | |
| Refused always-on headless install | | |
| Game starts in one invite | | |
| Game completes 30 minutes | | |
| Full-family trust refusal | | |
| Own-device-only use | | |
| Product described as VPN/port mapping | | |
| Product feels harder than Tailscale/frp | | |
| User still handles devices/ports/relay/networking | | |
| Relay is the long-term path | | |
| Central account or chat/feed/complex permission demand | | |

## Moderator interpretation

Write this only after observations and quotes are complete.

- Job strength:
- Existing product that best fits and why:
- Gap that remains, if any:
- Person-first flow shorter or clearer: supported | contradicted | unknown
- Controllerless value: supported | contradicted | unknown
- Family-wide trust boundary: supported | contradicted | unknown
- Named-session need: supported | contradicted | unknown
- Possible kill criterion:
- Follow-up needed:

## Redaction and completion check

- [ ] No real name or private service content
- [ ] Public evidence has publication consent; otherwise only safe aggregate
      counts are committed
- [ ] No seed, secret key, identity JSON, token, or recovery code
- [ ] Evidence modes and denominators are explicit
- [ ] Observations are separate from interpretation
- [ ] Missing data remains marked missing
- [ ] Evidence links open and contain only redacted material
