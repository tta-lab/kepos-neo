# Third-party notices

## Hypertele

Kepos Neo's transport observations and route controls were informed by work
performed in a fork of Hypertele:

- package: `hypertele` 1.1.4;
- upstream repository: <https://github.com/bitfinexcom/hypertele>;
- package metadata author: Paolo Ardoino (`@prdn`);
- package metadata license: MIT;
- Kepos migration source:
  `cdb851bf750369d5b9eaead3975580e8459fe025` on
  `feat/kepos-transport-spike`;
- fork repository: <https://git.guion.io/neil/hypertele>.

The source repository did not contain a standalone `LICENSE` file at the
migration commit. This notice records the package's declared MIT metadata and
upstream provenance without claiming a license text that was not present.

The Kepos implementation adapts the fork's route mapping, connection attempt
and retry timing, sanitized DHT snapshots, first-byte and byte-count metrics,
transfer-rate calculation, and close-source observations.

Kepos does not copy Hypertele's CLI, raw-stream probe protocol, gzip mode, or
one-DHT-connection-per-local-TCP architecture. Kepos uses a persistent
HyperDHT connection with independent Protomux channels and is a
Kepos-specific transport rewrite.
