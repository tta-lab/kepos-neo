# Kepos Neo network transport and compatibility

Status: discussion draft
Date: 2026-07-10
Scope: desktop and headless devices, family trust, and TCP service proxying

The accepted staged MLP scope is recorded in
[mlp-decisions.md](./mlp-decisions.md). This document keeps the broader
research, including the deferred TCP/TLS relay option.

## 1. What this document decides

Kepos Neo should proxy local TCP services between trusted devices. That does
not mean the Internet transport is TCP.

The main Holepunch path uses:

- local TCP on each end;
- Noise SecretStream for peer encryption and identity;
- Protomux for control and tunnel messages;
- UDX reliable streams over UDP for Internet transport;
- HyperDHT and Hyperswarm for discovery, connection setup, and NAT punching.

This gives a good P2P path when UDP works. It does not cover every network.
The current Holepunch blind relay also uses UDX over UDP, so it helps with hard
NAT pairs but not with networks that block or badly shape UDP.

The complete compatibility path is not simply "UDP or TCP". It can be:

1. use UDP-based P2P whenever it is healthy;
2. use a UDP blind relay when direct NAT punching fails;
3. later add an end-to-end encrypted TCP/TLS or WebSocket relay when measured
   UDP coverage proves insufficient;
4. choose paths from measured quality, not only from connection success or a
   fixed country label.

There is no strong public evidence that HyperDHT works reliably across China
Telecom, China Unicom, and China Mobile. That gap must be closed by our own
test matrix before release.

## 2. The four network layers

The word "TCP" can refer to different layers. Mixing them leads to the wrong
compatibility claim.

| Layer | Kepos Neo use | Normal protocol |
| --- | --- | --- |
| Local service | The app being exposed, such as SSH, HTTP, or a database | TCP |
| Tunnel protocol | Open, data, half-close, reset, and flow control | Protomux messages |
| Peer security | Device authentication and encrypted byte stream | Noise SecretStream |
| Internet carrier | Discovery, NAT punching, and peer data | HyperDHT + UDX over UDP |

Normal direct path:

```text
client app
  |
  | loopback TCP
  v
Neo local listener                 first TCP connection ends here
  |
  | OPEN / DATA / FIN / RESET
  v
Protomux tunnel channel
  |
  v
Noise SecretStream
  |
  v
UDX reliable stream
  |
  | UDP datagrams through the Internet and NATs
  v
remote UDX -> Noise -> Protomux
  |
  | new loopback TCP connection
  v
Neo service connector              second TCP connection starts here
  |
  v
local service
```

Kepos Neo does not carry TCP headers or TCP acknowledgements through the
tunnel. Each agent receives payload bytes from its local TCP stack and moves
those bytes through a different reliable stream. The exact term is a
**split TCP byte-stream proxy over UDX**, not an IP-level TCP-over-UDP tunnel.

UDX being UDP-based does not mean application bytes are unreliable. UDX adds
ordering, retransmission, congestion control, and flow control. UDP is the
carrier that lets Holepunch control NAT mappings and change peer paths.

## 3. How a direct connection is made

### 3.1 Discovery

MLP does not publish or discover a shared Family topic. Family is local UI
metadata, not a protocol roster. Each publisher has a stable `homeKey` that a
client pins during out-of-band pairing. The publisher announces that key
through HyperDHT, and the client connects to the pinned key. After authenticating
to Home, the client can learn separately published `serviceKey` values from the
Registry. DHT bootstrap and lookup traffic use UDP.

The default HyperDHT bootstrap set contains a small number of fixed IPv4 UDP
endpoints. A bootstrap node helps a device enter the DHT. It is not a data
relay and gives no availability promise for China.

### 3.2 Handshake and NAT punching

HyperDHT routes initial handshake and hole-punch control messages through DHT
nodes. The peers then send UDP probes to each other's observed public address.
If the NAT mappings are compatible, the peers establish a direct UDX path.

The DHT nodes leave the data path after a direct connection is ready. Peer
data remains encrypted end to end by Noise.

CGNAT alone does not prove that punching will fail. NAT behavior matters more
than the private address range. HyperDHT distinguishes open, consistent, and
randomized mappings. Two randomized NATs are a known failure case; other
pairs may still connect.

### 3.3 Publisher authentication and authorization

A DHT announcement is discovery, not authorization. Noise authenticates the
connecting `clientKey`, and each publisher checks that public key against its
own static allowlist. In the Hypertele baseline, its firewall performs this
check before exposing Home or another service.

MLP has no owner-signed membership record, synchronized Family roster, or
dynamic revoke protocol. Removing a client key takes effect after the
publisher reloads its allowlist. Bootstrap and relay nodes cannot add a key to
that allowlist or grant access to a published service.

## 4. Three different meanings of relay

These roles must have distinct names in code, logs, UI, and operations.

### 4.1 DHT routing relay

This relays announce, lookup, handshake, and hole-punch control messages. It
does not carry the application byte stream.

### 4.2 Blind UDX data relay

When direct punching fails, current Hyperswarm can use `relayThrough` and the
Holepunch `blind-relay` package:

```text
peer A -- UDX/UDP --> public blind relay <-- UDX/UDP -- peer B
          \________ end-to-end Noise encryption ________/
```

The relay sees endpoint addresses, timing, and byte counts but not service
plaintext. It is useful for double randomized NATs and other punching errors.
It still needs working outbound UDP from both peers.

The current `relayThrough` path is newer than the core direct path. Its API,
authentication, abuse controls, limits, and production behavior need a focused
spike. A normal WSL device behind NAT is not a public blind relay.

### 4.3 TCP/TLS or WebSocket gateway

A restricted device can keep one outbound connection to a public gateway on
TCP/TLS 443 or WSS:

```text
restricted Neo
  |
  | outbound TLS or WSS on TCP/443
  v
Kepos relay gateway
  |
  | HyperDHT / UDX side of the network
  v
remote peer or remote gateway
```

This is the path that can work when UDP is fully blocked. TLS protects the
hop to the gateway, but Kepos still needs inner end-to-end Noise encryption.
The gateway must never own an endpoint secret key.

Holepunch publishes an experimental package for this shape:
`@hyperswarm/dht-relay`. Its protocol covers lookup, announce, connect,
listen, open, data, end, and destroy over TCP or WebSocket. It is useful proof
that a full fallback can fit the ecosystem, but it is not production-ready:

- its README says not to use it in production;
- its default custodial mode sends secret keys to the relay and is forbidden
  for Kepos Neo;
- non-custodial mode keeps signing and Noise at the endpoint, but issue #26
  reports a failing server path and a maintainer says the package is not
  actively maintained;
- issue #25 reports WebSocket and Protomux open/reject failures.

Kepos Neo must treat this package as spike material. We must either prove and
maintain a non-custodial fork or build a small relay transport with the same
security boundary. We must not depend on its default mode.

## 5. UDP and TCP trade-offs

### 5.1 Why keep the UDP path

- NAT punching needs control over UDP mappings.
- UDX gives a reliable stream without placing another Internet TCP connection
  around the proxied service.
- A direct path removes relay bandwidth cost and usually reduces latency.
- UDX can change the remote path, which lets a relayed connection move to a
  direct path when punching later succeeds.

### 5.2 What a TCP fallback fixes

- networks that block all outbound UDP;
- enterprise, hotel, campus, or mobile networks where only common TCP/TLS
  traffic works;
- UDP paths that connect but have severe loss or rate limits;
- cross-border cases where a measured TCP relay path is more stable than a
  direct UDP path.

### 5.3 What a TCP fallback costs

- relay bandwidth, capacity planning, and a public service to operate;
- more buffering and another failure point;
- metadata exposure at the relay;
- head-of-line blocking when many logical tunnels share one ordered TCP
  connection;
- reconnect behavior: active proxied TCP connections must fail and reopen.

This is not the classic IP-level TCP-over-TCP problem because Kepos terminates
the local TCP connections and moves only payload bytes. There is still real
head-of-line blocking: loss of one outer TCP segment stalls every logical
channel behind it. Direct UDX also has cross-channel blocking if all Protomux
channels share one ordered UDX stream. We must measure this rather than claim
that either carrier gives independent streams.

## 6. Domestic and international network evidence

### 6.1 What is well supported

Evidence level A means a standard, official document, source code, or project
maintainer statement.

- RFC 9308 summarizes measurements where roughly 3% to 5% of networks block
  all UDP. This is global data, not a China-specific rate. It also notes that
  UDP NAT state can expire quickly, so keepalive and recovery matter.
- HyperDHT, UDX, and blind relay source confirm that the current main path and
  relay path use UDP.
- Tailscale falls back from UDP direct paths to HTTPS DERP relay. NetBird uses
  WebSocket relay on TCP/443 when its UDP path is unavailable. ZeroTier has a
  separate TCP relay rather than treating a Moon as TCP fallback.
- Microsoft and Alibaba Cloud warn that public Internet paths between mainland
  China and overseas regions can have congestion, latency, and packet loss.
  There is no stable number that applies to every carrier or city.
- China cloud security groups generally support both TCP and UDP. A public UDP
  service still needs a public IP, security group rule, host firewall rule,
  and a provider/network that permits the path.

### 6.2 What is not proven

- There is no reliable public test matrix for HyperDHT, Hyperswarm, Pear, or
  Keet across China Telecom, China Unicom, and China Mobile.
- Absence of Holepunch China issues is not evidence of compatibility.
- The 2025 measurement of targeted QUIC Initial/SNI blocking in China does not
  prove that arbitrary UDX is blocked, and does not prove that it is safe.
- No reliable source gives one China-wide UDP shaping rule.
- IPv6 cannot be treated as the MLP escape path. Residential IPv6 firewalls
  still block unsolicited inbound traffic, and the currently used HyperDHT
  code does not put IPv6 candidates into its normal connect handshake.

### 6.3 Project issues from China

Evidence level B means a reproducible project issue or maintainer discussion,
but not a broad measurement.

| Project | Report | What it tells us |
| --- | --- | --- |
| Tailscale #10634 | A China user reports direct UDP being rate-limited and asks to force a private DERP | Direct can be worse than relay; manual relay mode matters |
| Tailscale #11879 | Mainland users report high latency on overseas DERP and inconsistent private DERP use | A relay must be tested from the target carrier; low probe RTT alone is not enough |
| Tailscale #2270 | Long-running reports say some mobile networks allow UDP but make it much slower than DERP | Fallback must react to quality, not only total failure |
| ZeroTier #2196 | For a China P2P problem, a maintainer points to forced TCP relay and says Moon is not the answer | Discovery infrastructure and data fallback are separate |
| NetBird #4739 | China peers can choose a Japan relay and get poor throughput or latency | First relay to answer is not necessarily the best relay |

These reports identify failure modes. They do not establish an operator-wide
rate, policy, or success percentage.

### 6.4 Small mainland tests and community reports

Evidence level C means a single test or small community sample. These results
are useful for building a test matrix, not for making a national claim.

- A Headscale/Tailscale test reported that a campus network and China Telecom
  5G could connect directly, while a harder campus/industrial NAT pair used a
  relay. The author's NAT labels were informal.
- A June 2026 Shandong report measured a Tailscale direct path between China
  Unicom and China Mobile as stable below about 2 Mbps, then losing packets at
  higher rates. It is one person's test on one night.
- Several ZeroTier reports describe same-city or same-carrier pairs that were
  slow or could not punch, even when ordinary public throughput was healthy.
- Community reports on randomized NAT punching conflict by carrier, city, and
  time. Some also suggest that opening many UDP mappings can trigger CGN limits
  or loss. HyperDHT's birthday-punch settings therefore need bounds and tests.

The common signal is not "UDP is blocked in China". It is:

> A UDP path may connect and still be too poor for sustained service traffic.

## 7. Compatibility by network shape

| Network shape | Direct UDX | Blind UDX relay | TCP/TLS relay | Main risk |
| --- | --- | --- | --- | --- |
| Public IPv4 or friendly home NAT | Usually the best path | Backup | Backup | Normal loss and churn |
| One hard NAT, one friendly NAT | Often possible | Useful | Backup | Punch time and mapping changes |
| Two randomized or hard CGNATs | Often fails | Designed for this case | Strong backup | Relay availability |
| Mobile hotspot or 5G on both ends | Uncertain | May work | Needed for coverage | CGNAT and UDP shaping |
| Campus, hotel, or enterprise Wi-Fi | Uncertain | Fails if UDP is blocked | Most compatible | TLS proxy and idle timeout |
| Mainland to mainland, same carrier | Must measure | Regional relay may help | Regional relay may help | UDP shaping can still occur |
| Mainland across carriers | Must measure | Regional relay may help | Often more predictable | Interconnect loss and relay choice |
| Mainland to overseas | Must measure | Overseas-only relay may be poor | Measure both sides | Cross-border congestion |
| Overseas residential networks | Usually good but not guaranteed | Useful | Covers UDP-blocked tail | Hard NAT and enterprise policy |
| WSL2 default NAT | Extra NAT layer | Useful | Useful | Windows firewall and WSL mode |

"Regional relay may help" is not a promise. Hong Kong, Japan, Singapore, and
mainland candidates must be measured from both peers. Physical distance alone
does not pick the best path.

## 8. Future full-compatibility path model

This section describes the possible end state after MLP V2. TCP relay and the
three-mode selector are not committed MLP V1 or V2 scope.

### 8.1 Product modes

- `auto`: use a healthy direct path; otherwise use the best relay path.
- `direct-only`: diagnostic and privacy-sensitive mode; fail if direct is not
  usable.
- `relay-only`: compatibility and support mode; do not rely on users blocking
  UDP by hand to force this behavior.

### 8.2 Path states

The daemon needs more detail than `direct` and `relay`:

```text
offline
  -> discovering
  -> direct_probing
  -> direct_healthy
  -> direct_degraded
  -> relay_udp
  -> relay_tcp

separate failure labels:
  bootstrap_unreachable
  udp_unavailable
  punch_failed
  relay_unreachable
  publisher_auth_failed
```

### 8.3 Selection behavior

1. Keep a TCP/TLS or WSS relay session warm enough to avoid a long failure
   delay on the first user connection.
2. Probe direct UDX and configured relays.
3. Score paths from reachability, RTT, loss, sustained throughput, recent
   failures, and region constraints.
4. Start a new service connection on a stable path. Do not move an active TCP
   byte stream during MLP.
5. Continue low-cost probes. A better path applies to later connections.
6. Use hysteresis so a path does not switch on every small measurement change.
7. Let the user or operator pin allowed relays for a publisher.

The exact quality thresholds must come from tests. Hard-coding a country rule
before measurement would hide failures rather than solve them.

## 9. Architecture boundary for a deferred fallback

The publisher trust, service, and tunnel protocols must depend on a small peer
transport interface, not directly on Hyperswarm internals:

```text
PeerTransport
  connect(serviceKey) -> encrypted Duplex
  listen(onPeer)
  pathInfo() -> kind, relay, RTT, health

implementations
  HolepunchDirectOrBlindRelay
  TcpTlsRelay
```

This boundary is not for speculative portability. It isolates a known product
risk: the mature Holepunch path is UDP-only, while reliable use in restricted
networks needs another carrier.

The end-to-end publisher authentication and tunnel protocol must be identical
on both transports. A relay cannot edit a publisher allowlist, authorize a
service, learn local target addresses, or terminate peer Noise.

## 10. Tunnel flow control

Each proxied TCP connection should have these messages:

- `OPEN`, with service ID and connection ID;
- `OPEN_OK` or `OPEN_ERROR`;
- bounded `DATA` chunks;
- `FIN`, preserving TCP half-close;
- `RESET`, for failure and cancellation.

Protomux gives message framing, not independent reliable streams or per-tunnel
flow control. The daemon must:

- pause the source TCP socket when the peer stream applies backpressure;
- resume it only after drain;
- bound per-peer and per-tunnel queued bytes;
- set open, idle, and shutdown timeouts;
- prevent a large tunnel from starving publisher and service control messages;
- test 1, 10, and 100 concurrent connections.

If one outer TCP/WSS connection carries many tunnels, packet loss can stall
all of them. The MLP can use one outer connection per peer or publisher and
accept that limit, but it must measure the effect before setting concurrency
claims.

## 11. Infrastructure roles

These roles may share a binary, but they are not the same service:

| Role | Needs public ingress | Carries data | Trust authority |
| --- | --- | --- | --- |
| Persistent DHT/bootstrap node | UDP | Control only | No |
| Blind data relay | UDP | Noise ciphertext | No |
| TCP/TLS relay gateway | TCP/443, optional WSS | Noise ciphertext | No |
| Service publisher | No | Publishes configured services | Yes, for its own allowlist |
| WSL/headless peer | No | May publish or consume services | Only for services it publishes |

A WSL headless device is a normal trusted device by default. WSL2 commonly
adds its own NAT and Windows firewall boundary. It can expose a local service,
but it is not a reliable public relay unless it has separately proven public
reachability and an operations configuration.

For a product beta, candidates should span at least two failure domains. A
single overseas relay is not enough evidence for mainland use. A mainland
public service also brings ICP, provider, abuse, metadata, and data protection
questions that need a separate deployment and legal review.

## 12. Full network test matrix

### 12.1 Endpoints

- China Telecom, China Unicom, and China Mobile home broadband;
- hotspots on all three mobile networks;
- at least one campus, hotel, or enterprise network;
- one network with all UDP blocked;
- overseas home networks in Asia and Europe or North America;
- public IPv4 VPS endpoints;
- WSL2 in default NAT and mirrored networking modes.

### 12.2 Pairs

- mainland same carrier and cross-carrier;
- mainland fixed to mobile;
- mainland to Hong Kong, Singapore, Japan, and at least one farther region;
- overseas to overseas;
- two CGNAT/mobile endpoints;
- WSL to each important class.

### 12.3 Measurements

For each pair and each candidate relay:

- bootstrap reachability and announce/lookup time;
- observed NAT class and address mapping behavior;
- 30 cold-start direct attempts and exact HyperDHT error codes;
- direct and relay connection p50/p95 time;
- direct, blind UDP relay, and TCP relay path chosen;
- RTT, jitter, loss, throughput, and reconnect count;
- sustained 2, 5, 20, and 50 Mbps traffic for 10 to 30 minutes;
- idle survival at 30 seconds, 2 minutes, and 10 minutes;
- TCP half-close, reset, backpressure, large transfer, and concurrent tunnels;
- network changes, relay restart, gateway restart, and allowlist removal after
  publisher reload.

Testing only ping, SSH login, or hole-punch success is not enough. The main
China risk in public reports is often a path that connects but degrades under
sustained traffic.

## 13. Release gates

MLP V1 direct networking is ready only when:

1. the direct UDX path works end to end with publisher allowlist authentication;
2. path diagnostics distinguish discovery, punching, transport, and
   publisher-auth failures;
3. the mainland/overseas direct-path matrix has recorded results, not
   assumptions;
4. sustained-traffic tests meet an agreed success and performance bar.

The V1 release claim must explicitly say:

> Kepos Neo MLP V1 requires usable outbound UDP and a NAT pair that HyperDHT
> can punch successfully.

MLP V2 is ready only when blind relay is tested under known hard NAT pairs,
relay selection and failure behavior are deterministic, and resource limits,
abuse controls, metadata retention, and deployment responsibilities are
written down. V2 still requires usable outbound UDP.

## 14. Current staged decision

Build and verify in this order:

1. Keep the MLP V1 product protocol transport-independent when code moves
   beyond the direct Hypertele P0 baseline.
2. Build MLP V1 with direct HyperDHT/UDX only.
3. Test V1 across the mainland and overseas matrix.
4. Build MLP V2 with a private, authenticated blind UDX relay.
5. Use measured V1 and V2 results to decide whether to build TCP/443 relay.

TCP/TLS or WSS relay remains an explicit future option. It is not part of MLP
V1 or V2.

## 15. Sources

### Holepunch and protocol sources

- [Hyperswarm](https://github.com/holepunchto/hyperswarm)
- [Hyperswarm discovery lifecycle](https://github.com/holepunchto/hyperswarm/blob/main/lib/peer-discovery.js)
- [HyperDHT](https://github.com/holepunchto/hyperdht)
- [HyperDHT connect path](https://github.com/holepunchto/hyperdht/blob/main/lib/connect.js)
- [HyperDHT routed handshake and punching](https://github.com/holepunchto/hyperdht/blob/main/lib/router.js)
- [HyperDHT announce records](https://github.com/holepunchto/hyperdht/blob/main/lib/announcer.js)
- [HyperDHT blind relay example](https://github.com/holepunchto/hyperdht/blob/main/examples/connection-relaying/relay.js)
- [UDX](https://github.com/holepunchto/udx-native)
- [SecretStream](https://github.com/holepunchto/hyperswarm-secret-stream)
- [Protomux](https://github.com/holepunchto/protomux)
- [Blind relay](https://github.com/holepunchto/blind-relay)
- [Experimental DHT relay](https://github.com/holepunchto/hyperswarm-dht-relay)
- [DHT relay non-custodial issue #26](https://github.com/holepunchto/hyperswarm-dht-relay/issues/26)
- [DHT relay WebSocket issue #25](https://github.com/holepunchto/hyperswarm-dht-relay/issues/25)

### Standards and measurement

- [RFC 4787: UDP NAT behavior](https://datatracker.ietf.org/doc/html/rfc4787)
- [RFC 6888: CGN requirements](https://datatracker.ietf.org/doc/html/rfc6888)
- [RFC 9308: Applicability of the QUIC transport protocol](https://datatracker.ietf.org/doc/html/rfc9308)
- [RFC 6092: IPv6 residential CPE filtering](https://datatracker.ietf.org/doc/html/rfc6092)
- [RFC 9000 section 2: QUIC streams](https://www.rfc-editor.org/rfc/rfc9000.html#section-2)
- [USENIX Security 2025: QUIC censorship measurement in China](https://gfw.report/publications/usenixsecurity25/en/)

### Comparable systems

- [Tailscale connection types](https://tailscale.com/kb/1257/connection-types)
- [Tailscale DERP](https://tailscale.com/kb/1232/derp-servers)
- [Tailscale NAT traversal](https://tailscale.com/blog/nat-traversal-improvements-pt-1)
- [Tailscale mobile UDP issue #2270](https://github.com/tailscale/tailscale/issues/2270)
- [Tailscale China UDP report #10634](https://github.com/tailscale/tailscale/issues/10634)
- [Tailscale mainland DERP report #11879](https://github.com/tailscale/tailscale/issues/11879)
- [NetBird architecture](https://docs.netbird.io/about-netbird/how-netbird-works)
- [NetBird NAT and relay](https://docs.netbird.io/about-netbird/understanding-nat-and-connectivity)
- [NetBird China relay selection issue #4739](https://github.com/netbirdio/netbird/issues/4739)
- [ZeroTier roots and Moons](https://docs.zerotier.com/roots/)
- [ZeroTier TCP relay](https://docs.zerotier.com/relay/)
- [ZeroTier China maintainer reply #2196](https://github.com/zerotier/ZeroTierOne/issues/2196#issuecomment-1933230046)
- [frp XTCP fallback](https://gofrp.org/en/docs/features/xtcp/)
- [rathole out of scope](https://github.com/rathole-org/rathole/blob/main/docs/out-of-scope.md)

### Mainland network and deployment context

- [Microsoft networking guidance for China](https://learn.microsoft.com/en-us/microsoft-365/enterprise/microsoft-365-networking-china?view=o365-worldwide)
- [Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking)
- [Alibaba Cloud regions and network quality](https://help.aliyun.com/zh/ecs/user-guide/regions-and-zones)
- [Alibaba Cloud ICP filing overview](https://help.aliyun.com/zh/icp-filing/basic-icp-service/user-guide/icp-filing-application-overview)
- [China cross-border data rules, 2024](https://www.cac.gov.cn/2024-03/22/c_1712776611775634.htm)
- [Small Headscale/Tailscale mainland test](https://cloud.tencent.com/developer/article/2457464)
- [Small Shandong Tailscale UDP test](https://www.v2ex.com/t/1222087)
- [Mainland NAT community discussion](https://www.v2ex.com/t/1046044)
