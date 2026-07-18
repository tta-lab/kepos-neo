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
- `summary.json`: all mainland China endpoints and candidates seen at least
  three times across at least 24 hours;
- `run.json`: process ID and planned stop time;
- `errors.jsonl`: lookup failures, when present.

China address classification comes from the APNIC delegated address list
cached inside the output directory. An APNIC CN allocation is a useful first
filter, not proof of the machine's physical location.

Do not promote a discovered endpoint directly into Kepos defaults. First start
a clean client with only that endpoint in its bootstrap list and verify DHT
lookup, announce, connect, fixed UDP port, and continued reachability over
multiple days.
