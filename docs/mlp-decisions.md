# Kepos Neo MLP decisions

Status: accepted architecture decisions
Date: 2026-07-10

This is the short decision record for the Kepos Neo plan. The supporting
documents are:

- [User and demand analysis](./user-and-demand-analysis.md)
- [Competitive value analysis](./competitive-value-analysis.md)
- [Game multiplayer scenarios](./game-multiplayer-scenarios.md)
- [Network transport and compatibility](./network-transport-and-compatibility.md)

`P0` names the first single-desktop technical slice inside MLP V0. It verifies
the Hypertele baseline and Home integration, but does not by itself pass the
full MLP V0 product-value gate or enter MLP V1.

## Product boundary

Kepos Neo is a person-first desktop and headless tool for exposing local TCP
services to trusted people in the same family.

The hard product requirements are:

- no external IdP or traditional cloud account;
- no always-on authorization controller;
- long-lived trust represented by persistent peer public keys in an
  owner-managed allowlist;
- one named service may be used concurrently by multiple trusted people;
- authorization stays in the service owner's local configuration;
- DHT, bootstrap, and relay nodes cannot grant access.

- A Person is initially local UI metadata mapped to one or more peer public
  keys.
- A peer public key is the MLP transport identity and allowlist entry.
- Trust is one-way: the service owner allows a peer key to connect.
- Each publisher has an independent directed allowlist. Alice allowing Bob
  does not allow Alice to access Bob's services.
- Family is an MLP UI grouping, not a shared protocol roster and not a synced
  authorization object.
- Adding or removing a trusted key may require restarting the daemon in MLP.
- A trusted peer may access all explicitly published services.
- MLP has no service ACL, user roles, mobile client, UDP service proxy, VPN,
  virtual network interface, chat, content feed, follow graph, or file sync.
- Desktop and WSL/headless use the same daemon and product logic.

Person, Trust, Service, and Session are product objects. Device, IP, port,
transport path, and relay are implementation or diagnostic objects.

The normal long-lived service flow is:

```text
owner trusts Alice and Bob once
  -> a publisher exposes its local Blog as the default home service
  -> Alice and Bob open the Blog
  -> the publisher may also expose Navidrome and other services
  -> both connect from their own authorized devices
  -> no owner login or online controller approves each connection
```

Only explicitly published services are reachable. Family membership does not
create a virtual network or make arbitrary device ports reachable.

### Local HTTP gateway

MLP uses one local HTTP gateway for human-readable HTTP service URLs. It does
not install a system DNS resolver or Android `VpnService`.

Example local URLs:

```text
http://alice-a1b2.kepos.localhost:17480/
http://navidrome.alice-a1b2.kepos.localhost:17480/
```

- `*.localhost` keeps traffic on loopback without a custom DNS service.
- The fixed gateway port is configurable if the default port is occupied.
- The stable suffix contains a short identity-derived value so two people with
  the same display name do not collide.
- The gateway maps the request `Host` to a trusted peer and service ID, then
  forwards the TCP bytes through the P2P tunnel.
- A Blog is an ordinary registered HTTP service. Kepos does not provide a
  Blog engine, CMS, renderer, editor, content store, or content sync.
- The first smoke uses a tiny static Blog fixture as the default `home`
  service. The fixture is test/example content, not a product CMS.
- A Blog may use ordinary links to other registered HTTP services.
- Non-HTTP services such as RetroArch and Terraria still receive a local TCP
  port when the user clicks Connect.
- `127.0.0.1:<port>` remains the compatibility fallback when a third-party
  Android client does not resolve a `*.localhost` subdomain as expected.

The gateway serves plain HTTP on loopback. WAN bytes remain protected by
Noise. MLP does not install a local CA or promise a trusted wildcard HTTPS
certificate. Kepos does not rewrite Host, cookies, redirects, CSP, CORS,
OAuth callbacks, absolute URLs, or application payloads. A service must work
through the local hostname as configured, or it is outside MLP compatibility.

Arbitrary Blog HTML must open in a normal browser or isolated origin, never a
privileged desktop WebView. A normal link may navigate across service origins;
cross-origin JavaScript still follows CORS, CSP, cookie, and Origin rules.

### Publisher allowlist and process model

Each publisher owns one allowlist. Every service explicitly published by that
publisher uses the same trusted peer-key set.

P0 allowed one Hypertele process and one service key per published service.
Public-path dogfood then measured multi-second cold connection setup and showed
that a route is reusable for only a short window after each connection closes.
The next transport shape is therefore:

- one publisher daemon instead of one Hypertele child per service;
- one subscriber daemon instead of one Hypertele child per local endpoint;
- one persistent authenticated connection between a subscriber and publisher;
- one Protomux instance on that connection;
- one logical channel per proxied TCP connection, with `serviceId` selecting
  Home, Navidrome, SSH, or another configured service;
- background keepalive and reconnect owned by the daemon, independent of
  browser, player, or SSH socket lifetimes.

A subscriber defaults to one configured publisher in the first version. A
publisher may accept multiple subscribers concurrently, with one independent
persistent connection per subscriber. The protocol may support multiple
publishers later, but the first client does not manage them.

Remote peers cannot select an arbitrary target host or port. A `serviceId`
resolves only through publisher-local configuration.

### Runtime and package management

- Node.js is the runtime.
- New source is TypeScript.
- npm manages dependencies and scripts.
- P0 invokes the pinned Hypertele CLI from Node rather than requiring a global
  user installation.
- The multiplex daemon is run manually during the first spike. launchd,
  Windows Service integration, scheduled tasks, login startup, and desktop
  lifecycle UI are deployment work, not transport requirements.
- Desktop framework and Android packaging are deferred until the network and
  service model pass P0.

### MLP identity boundary

MLP deliberately does not introduce a separate Person root key:

```text
local Person label
  -> one or more persistent peer public keys
  -> owner-managed allowlist
```

HyperDHT and Noise prove possession of the peer secret key. The service owner
checks the corresponding public key against the allowlist.

- A friend with two devices has two keys, which the UI may group under one
  local Person label.
- WSL/headless has its own key and may be locally grouped with its owner.
- Removing a key and restarting the daemon closes existing sessions and blocks
  future connections.
- Person root keys, signed membership records, dynamic revoke, recovery, and
  cross-device identity are deferred until real use proves they are needed.

### MLP key model

The persistent multiplex model has two key roles and no separate key per
service:

| Key | Held or learned by | Purpose |
| --- | --- | --- |
| `subscriberKey` | Generated and held by the connecting subscriber | Proves the subscriber identity checked by a publisher allowlist |
| `publisherKey` | Held by the publisher and pinned by each subscriber | Stable publisher identity, DHT entry point, and Registry trust anchor |

Out-of-band pairing exchanges only two public values:

```text
subscriber -> publisher: subscriberPublicKey
publisher -> subscriber: publisherPublicKey
```

The subscriber stores its own secret key locally and binds a local Person label
such as Alice to `publisherKey`. After authentication, Registry entries name
services by `serviceId`; they do not contain service keys. Opening a service is
an authenticated multiplex operation on the existing publisher connection.

The dogfood daemon now uses `publisherKey` and one persistent multiplex
connection. The older P0 `homeKey`, per-service keys, and Hypertele child
processes remain only as P0 test fixtures; they are not part of this protocol.

Rotating `publisherKey` requires re-pairing. A later Person root could sign a
replacement publisher key, but that recovery layer is explicitly deferred.

### Deferred from the first multiplex version

- one subscriber maintaining connections to multiple publishers;
- per-service allowlists, roles, or grants;
- one key or DHT announcement per service;
- launchd, Windows Service, scheduled-task, login-startup, or desktop UI work;
- mobile background lifecycle and battery policy;
- relay operation or TCP/WSS fallback;
- multiple outer connections per subscriber for traffic classes;
- transparent recovery of an active TCP stream after the outer connection
  drops;
- arbitrary remote target hosts or ports.

The first version must still support multiple subscribers per publisher,
multiple published services, and multiple concurrent logical TCP channels on
each subscriber connection.

## Network stages

| Version | Purpose | Question it must answer | Not its purpose |
| --- | --- | --- | --- |
| MLP V0 | Existing-product and value gate | Does any existing controllerless tool already satisfy repeated one-to-many family service sharing, and do target users need the remaining difference? | Building a new network stack |
| MLP V1 | Technical and product spike for the core proxy | Can static trusted keys, a publisher service registry, and the local HTTP gateway provide concurrent direct P2P services to multiple family members without an authorization controller? | Broad network coverage, relay operations, dynamic trust, mandatory multiplex, or a polished desktop product |
| MLP V2 | Feasibility spike for a private UDP blind relay | Can the same trust and tunnel protocol work through hard NAT pairs with an operable, bounded, non-custodial relay? | Networks that block or badly shape UDP, public relay service, or commercial deployment |
| Later, only if justified | Restricted-network compatibility | Do measured failures justify building and operating a non-custodial TCP/443 relay? | A committed MLP milestone |

### MLP V1: direct UDX

MLP V1 uses the stable Holepunch main path:

```text
local TCP
  -> Kepos tunnel protocol
  -> Noise encryption
  -> HyperDHT + UDX/UDP direct path
  -> remote local TCP
```

V1 is a spike, not a release candidate. Its purpose is to prove the smallest
complete value loop:

```text
owner adds a friend's persistent peer key
  -> devices find and authenticate each other
  -> owner publishes a Blog and named TCP services
  -> trusted friends open those services
```

V1 validates:

- persistent peer transport keys;
- static allowlist authorization loaded at daemon startup;
- pinned publisher discovery and peer authentication;
- TCP service publish, discover, connect, close, and backpressure;
- desktop and headless parity;
- at least two member people concurrently using one named TCP service;
- local authorization without an online controller decision;
- one publisher allowlist shared by every published service;
- multiple services, with separate Hypertele processes accepted initially;
- one local HTTP gateway routing the default Blog and later HTTP services by
  `*.kepos.localhost`;
- compatibility fallback to `127.0.0.1:<port>`;
- real direct connections across representative networks.

V1 succeeds only if it proves both sides of the idea:

- **protocol feasibility:** key allowlist, peer identity, tunnel framing,
  backpressure, half-close, reset, and cleanup are correct;
- **user value:** a person can trust another person and use a named remote
  service or session without entering an IP address, opening a router port,
  or managing a separate VPN.

The V1 UI may be minimal. It only needs to make the complete loop observable
and testable. UI polish must not hide missing network or protocol evidence.

V1 does not provide a data relay. Its explicit limitation is:

> Kepos Neo MLP V1 requires usable outbound UDP and a NAT pair that HyperDHT
> can punch successfully.

### MLP V2: blind UDX relay

V2 adds Holepunch `relayThrough` and a Kepos-operated blind relay:

```text
device A -> UDX/UDP blind relay -> device B
```

V2 is an operational feasibility spike. Its purpose is to learn whether a
private blind relay can turn known hard-NAT failures into usable connections
without becoming a trust authority or an unsafe open proxy.

V2 handles hard NAT pairs that cannot establish a direct path. Peer Noise
encryption remains end to end, so the relay cannot read service plaintext.

V2 must prove:

- relay admission is explicit and bounded without granting service access;
- the relay never receives a device secret or service plaintext;
- quotas, backpressure, timeout, restart, and failure behavior are bounded;
- operators can distinguish direct, punch failure, and relayed paths;
- sustained traffic remains usable through representative hard NAT pairs;
- relay bandwidth and operating cost can be measured.

V2 still requires outbound UDP from both devices. It does not solve networks
that block or severely shape UDP.

### Deferred: TCP/TLS or WSS relay

TCP/443 relay is not part of MLP V1 or V2. It will be reconsidered only after
the direct and blind-relay test matrix shows that UDP coverage is not enough
for the intended users.

Holepunch's `@hyperswarm/dht-relay` is reference material only. It is marked
experimental, its default custodial mode exposes device secrets to the
gateway, and its non-custodial path has known failures. Kepos must not use its
default mode in production.

The publisher trust, service, and tunnel protocols must not depend on
Hyperswarm internals. This keeps a later non-custodial TCP relay possible
without rewriting trust or service semantics.

## What CGNAT means

CGNAT is NAT operated by an Internet provider. Many homes or mobile devices
share one public IPv4 address:

```text
device
  -> home router NAT
  -> provider CGNAT
  -> shared public IPv4
  -> Internet
```

A user behind CGNAT normally cannot configure public port forwarding.
HyperDHT tries to create usable outbound UDP mappings on both sides and punch
between them.

CGNAT does not always prevent a direct connection. Stable or predictable NAT
mappings may work. Two strict or randomized NATs are much more likely to need
a relay.

## Experimental mainland relay deployment

The first relay experiment is private and closed:

- fixed public IP and a public UDP port;
- no website, public API, public registration, or payment;
- only peer keys in a private relay-operator allowlist may use it;
- relay admission is separate from publisher service authorization and cannot
  add a peer to any publisher allowlist;
- not an open proxy;
- no service plaintext at the relay;
- explicit connection, bandwidth, and traffic limits.

For this private non-Web shape, normal website ICP filing is unlikely to be
the immediate path. This is not a legal exemption. Before deployment, the
chosen cloud provider must confirm in writing that the exact UDP service is
allowed.

An IP-only website or API is still a website for filing purposes. A future
WSS service on a mainland server should be planned as a Web service and should
not rely on using port 443 or omitting a public page to avoid filing.

Operating a public or paid family relay in mainland China is a different
case. It may require analysis beyond ICP filing, including whether the service
falls under a value-added telecom category such as a domestic IP-VPN service.
That decision is outside MLP.

## Relay operating risks

A long-running relay may be limited, blocked, attacked, or suspended. This is
a risk, not an assumption that blocking will happen.

V2 must include:

- authenticated relay admission before carrying data;
- per-device connection, bandwidth, and byte limits;
- rate limiting and abuse controls;
- bounded queues and timeouts;
- health, traffic, failure, and saturation metrics;
- pinned relay public keys;
- more than one configurable relay candidate;
- separate bootstrap and data-relay roles;
- clear logs for direct, punch failure, and relay paths.

Relay selection must consider reachability, RTT, loss, sustained throughput,
load, and recent failures. Country or physical distance alone is not enough.

## Clash is not a product dependency

Kepos Neo is designed and tested as if Clash is not installed.

- A system HTTP proxy does not carry arbitrary HyperDHT UDP traffic.
- Clash/Mihomo TUN or TProxy mode may carry UDP only when routing rules select
  the proxy and the chosen proxy node and server support UDP.
- Some configurations send the traffic directly even while Clash is running.
- TCP/TLS or WSS relay would benefit more consistently from a proxy, but that
  relay is deferred.

Clash may improve a user's path, but Kepos must neither detect it as a trust
signal nor require users to configure it.

## Current implementation order

1. Run MLP V0 Hello World on the available single desktop: one publisher
   process, one trusted client identity, and a tiny local static Blog.
2. Add a second local client identity/process and verify both can open the same
   Blog. This proves configuration and one-to-many semantics, not independent
   devices or NAT traversal.
3. Add a publisher service registry and the local HTTP gateway, initially
   allowing one Hypertele process per service.
4. Build the separate Android client-only spike after the desktop path works.
5. Run the first real cross-device/cross-network smoke with the desktop on
   broadband and Android on cellular data, first against Blog and then Navic +
   Navidrome.
6. Measure locked-screen streaming, network switching, repeated connection
   setup, memory, and backpressure.
7. Decide whether measured process or connection cost justifies multiplex.
8. Run the broader mainland and overseas direct-path matrix when more devices
   or testers are available.
9. Build MLP V2 blind UDX relay with limits and diagnostics.
10. Run hard-NAT, sustained-throughput, and relay-failure tests.
11. Use measured results to decide whether a TCP/443 relay is needed.

The single-desktop smoke must not claim evidence for public-DHT reachability,
NAT punching, CGNAT, cross-carrier quality, mobile lifecycle, or relay need.

MLP V0 uses the npm package under its declared MIT metadata and does not wait
for an upstream LICENSE-file change. If source is later copied or forked, the
fork must retain upstream provenance and record that the source package
declared MIT while omitting the full LICENSE text.
