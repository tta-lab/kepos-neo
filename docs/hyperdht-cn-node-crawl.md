# HyperDHT China node crawl

This crawl checks whether the public HyperDHT contains stable nodes with
mainland China IPv4 addresses that could be tested as bootstrap candidates.
HyperDHT does not mark a node as a bootstrap node: a candidate must still be
tested for stable public UDP reachability and long-term uptime.

Run it for 72 hours so the sample covers daily churn and both workday and
weekend traffic:

```sh
npm run crawl:dht -- \
  --duration-hours 72 \
  --interval-seconds 60 \
  --output ~/.local/state/kepos-neo/dht-crawl
```

The crawler performs one random DHT lookup per minute. It writes:

- `observations.jsonl`: crash-safe endpoint observations;
- `summary.json`: factual endpoint counts and all mainland China endpoints;
- `run.json`: process ID and planned stop time;
- `errors.jsonl`: lookup failures, when present.

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
  --input ~/.local/state/kepos-neo/dht-crawl \
  --enrich \
  --stable-min-hours 24 \
  --stable-min-observations 6 \
  --stable-min-buckets 3 \
  --stable-max-stale-hours 2
```

`--enrich` looks up missing IP locations one at a time and caches them in
`geo-cache.json`. Later report runs reuse the cache and can omit the flag. The
generated `report.html` contains the collected data and uses Plotly from its
CDN to render the world map, country and ASN rankings, hourly reach, and node
stability. Stability thresholds are report-only parameters: they never alter
or filter `observations.jsonl`, so the same crawl can be reprocessed with
different definitions.
