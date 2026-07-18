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
  --output ~/.local/state/kepos-neo/dht-graph
```

The crawler starts with random `findNode` queries, records every responding
node and advertised neighbor, then validates a bounded frontier ranked by how
many independent nodes advertised it. It writes each run under
`snapshots/<timestamp>/`:

- `nodes.jsonl`: verified responders and advertised nodes;
- `edges.jsonl`: directed adjacency observations;
- `observations.jsonl`: verified endpoint observations used by the report;
- `queries.jsonl`: query targets, starting nodes, reply counts, and errors;
- `summary.json`: graph size and mainland China endpoint counts;
- `run.json`: the exact limits and timestamps for the run.

This is a one-shot command, not a daemon. Run it again about every 12 hours to
measure churn and stability without sending constant traffic. Each snapshot is
kept separate, so later analysis can compare the graph over time.

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
