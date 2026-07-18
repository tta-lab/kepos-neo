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

For each selected endpoint, the validator creates two clean HyperDHT clients
whose only initial bootstrap is that endpoint. It requires bootstrap, a
successful `findNode` lookup, server announce, and an encrypted connection
between the two clients. Results are appended to `validations.jsonl`.

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
