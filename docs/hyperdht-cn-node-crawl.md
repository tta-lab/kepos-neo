# HyperDHT graph snapshots

This tool explores adjacency in the public HyperDHT and saves a bounded graph
snapshot. It checks whether the network contains stable nodes with mainland
China IPv4 addresses that may be worth testing as bootstrap candidates.
HyperDHT does not mark a node as a bootstrap node: a candidate must still be
tested for stable public UDP reachability and long-term uptime.

Run one snapshot:

```sh
npm run crawl:dht -- \
  --targets 32 \
  --frontier 64 \
  --frontier-rounds 3 \
  --output ~/.local/state/kepos-neo/dht-graph
```

The crawler divides the DHT target space into 256 prefix buckets and prefers
buckets unused by earlier snapshots. It records every responding node and
advertised neighbor, then spends most frontier queries on endpoints not seen
in earlier snapshots while retaining some well-referred candidates for
reliable traversal. Another frontier round runs only while new-node or
new-edge yield remains useful. Each run is written under
`snapshots/<timestamp>/`:

- `nodes.jsonl`: verified responders and advertised nodes;
- `edges.jsonl`: directed adjacency observations;
- `observations.jsonl`: verified endpoint observations used by the report;
- `queries.jsonl`: query targets, starting nodes, reply counts, and errors;
- `summary.json`: graph size, marginal new nodes and edges, frontier yield, and
  mainland China endpoint counts;
- `run.json`: the exact limits and timestamps for the run.

This is a one-shot command, not a daemon. Run it again about every 12 hours to
measure churn and stability without sending constant traffic. Each snapshot is
kept separate, so later analysis can compare the graph over time.

The crawler is deliberately geography-neutral. Kademlia XOR distance is not
physical distance, so biasing traversal toward known Chinese nodes would
reduce graph coverage without reliably finding more Chinese nodes.

China address classification comes from the APNIC delegated address list
cached inside the output directory. An APNIC CN allocation is a useful first
filter, not proof of the machine's physical location.

Do not promote a discovered endpoint directly into Kepos defaults. First start
a clean client with only that endpoint in its bootstrap list and verify DHT
lookup, announce, connect, fixed UDP port, and continued reachability over
multiple days.

Generate the geographic report after or during a crawl:

```sh
npm run report:dht -- \
  --input ~/.local/state/kepos-neo/dht-graph \
  --enrich \
  --stable-min-hours 24 \
  --stable-min-observations 6 \
  --stable-min-buckets 3 \
  --stable-max-stale-hours 2
```

`--enrich` looks up missing IP locations one at a time and caches them in
`geo-cache.json`. Later report runs reuse the cache and can omit the flag. The
generated `report.html` merges all snapshots and uses Plotly from its CDN to
render the world map, country and ASN rankings, hourly reach, and node
stability. A stability bucket is one snapshot, not one reply or wall-clock
hour. Stability thresholds are report-only parameters: they never alter or
filter raw snapshot data, so the same crawl can be reprocessed with different
definitions.

When `bootstrap-recommendations.json` exists in the input directory, the report
also reads its validated endpoints. Ordinary observations remain translucent
blue, discovery-stable endpoints are green, and recommended bootstrap endpoints
are drawn last as larger amber diamonds. Recommendation and discovery stability
are separate states. The country chart includes every observed country and
overlays the same amber recommendation count, so low-count regions such as CN
are not hidden by a top-N cutoff. Use `--recommendations <path>` to read a
recommendation artifact from another location.

## Validate bootstrap candidates

The validator is a separate stage. It reads verified responders from graph
snapshots, prioritizes mainland China and nearby regions, and requires an
endpoint to appear in at least two discovery snapshots before probing it:

```sh
npm run validate:dht -- \
  --input ~/.local/state/kepos-neo/dht-graph \
  --limit 3 \
  --timeout-ms 60000 \
  --min-discovery-snapshots 2 \
  --recheck-hours 12
```

Each validation batch skips every port on a host tested within the recheck
window, selects at most one endpoint per ASN, and caps each country at two
endpoints. This spends active probes on independent networks instead of
retesting NAT or process churn behind one public IP.

For each selected endpoint, the validator creates two clean HyperDHT clients
whose only initial bootstrap is that endpoint. It requires bootstrap, a
successful `findNode` lookup, server announce, and an encrypted connection
between the two clients. The connector sets `localConnection: false`, so a
same-machine or LAN shortcut cannot satisfy the connection check. Results are
appended to `validations.jsonl`; only records that explicitly prove the local
shortcut was disabled count toward recommendations.

An endpoint enters `bootstrap-recommendations.json` only after two successful
validations spanning at least 12 hours. Recommendations are deduplicated by
IP, ASN, and country, then signed with Ed25519. The first run creates:

- `bootstrap-recommendations-private.pem`: local signing key, mode `0600`;
- `bootstrap-recommendations-public.pem`: public key for clients to pin;
- `bootstrap-recommendations.json`: signed, locally cached recommendation
  payload.

An empty recommendation list before the second cross-time validation is
expected. Kepos clients must retain built-in fallback endpoints and their last
valid signed list; this artifact must not become a required single point of
failure.

## Benchmark cold bootstrap choices

The benchmark alternates four bootstrap groups while keeping the client
network and publisher fixed:

1. HyperDHT's built-in bootstrap set;
2. recommended mainland China and Hong Kong endpoints;
3. recommended mainland China, Hong Kong, and Singapore endpoints;
4. every recommendation followed by HyperDHT's built-in endpoints.

Each trial starts a fresh Node process and a fresh HyperDHT instance. It first
measures `fullyBootstrapped()`, then opens a stream to one pinned publisher
with `localConnection: false`. `outerMs` is measured from process-local DHT
creation through the first stream `open`; `connectMs` is the part after
bootstrap. The publisher remains running between trials, which models the
planned persistent publisher and isolates subscriber cold start.

```sh
npm run benchmark:bootstrap -- \
  --recommendations ~/.local/state/kepos-neo/dht-graph/bootstrap-recommendations.json \
  --identity ~/.local/state/kepos-neo/subscriber/client.identity.json \
  --publisher-key <publisher-key> \
  --output ~/.local/state/kepos-neo/bootstrap-benchmark \
  --trials 25 \
  --timeout-ms 30000
```

The command writes every completed trial to `results.jsonl` before starting
the next process, then writes group percentiles and failure rates to
`summary.json`.

### 2026-07-19 Mac-to-NUC sample

The Mac client and persistent NUC publisher stayed on the same network for all
100 alternating trials. The benchmark disabled HyperDHT's LAN shortcut, so
the measured stream used the public DHT/hole-punch path. Each group ran 25
fresh subscriber processes.

| Bootstrap group | Bootstrap p50 | Bootstrap p90 | Outer p50 | Outer p90 | Outer failures |
| --- | ---: | ---: | ---: | ---: | ---: |
| Built-in default | 8,101 ms | 10,141 ms | 11,885 ms | 14,426 ms | 6/25 (24%) |
| CN + HK | 5,064 ms | 6,875 ms | 7,654 ms | 11,313 ms | 3/25 (12%) |
| CN + HK + SG | 5,612 ms | 7,664 ms | 7,837 ms | 12,344 ms | 1/25 (4%) |
| Recommendations + default | 7,563 ms | 10,111 ms | 11,691 ms | 14,366 ms | 3/25 (12%) |

Against the built-in set, CN + HK reduced bootstrap p50 by 37.5% and cold
outer p50 by 35.6%. CN + HK + SG reduced them by 30.7% and 34.1% and had the
lowest observed outer failure rate. All failed outer attempts ended with
`HOLEPUNCH_ABORTED`; no trial failed to bootstrap. Successful post-bootstrap
connect p50 stayed near 2.1–2.4 seconds in every group.

The result supports an ordered regional bootstrap policy, not concatenating
every known endpoint. More initial nodes did not make startup faster. This is
one network and one publisher, so it does not prove the same failure-rate
difference across Chinese carriers; repeat the same alternating experiment
from other networks before making a global default.
