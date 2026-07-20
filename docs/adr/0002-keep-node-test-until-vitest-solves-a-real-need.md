# ADR 0002: Keep Node test until Vitest solves a real need

Status: Accepted

Date: 2026-07-20

## Context

Kepos currently runs its TypeScript tests with Node's built-in test runner:

```sh
node --import tsx --test
```

The test suite mainly covers Node behavior: CLI parsing, state files, HTTP and
TCP servers, streams, HyperDHT connections, Protomux channels, reconnects, and
shutdown. Tests use `node:test` and `node:assert/strict` directly.

Vitest would add a separate test framework and migration work. Its main
benefits—browser or DOM testing, richer mocks, snapshots, watch workflows, and
the `expect` assertion API—do not solve a current project problem.

## Decision

Kepos keeps `node:test` as its test runner for now.

New tests should continue to use:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
```

The project will not add Vitest only for assertion syntax or framework
familiarity. Avoiding an extra layer keeps the test command close to the Node
runtime used in production and reduces dependencies and configuration.

Reconsider Vitest when one or more concrete needs appear:

- browser, DOM, or component tests need jsdom or browser execution;
- extensive mocking, fake timers, or snapshots make `node:test` cumbersome;
- watch mode and focused interactive runs become important to daily work;
- coverage reporting or CI integration cannot be met cleanly by Node tools;
- a broader frontend test suite benefits from sharing one Vitest setup.

Any later migration should be based on those needs and may cover only the
affected test layer instead of replacing every Node integration test.

## Consequences

- Existing tests and CI keep using `npm test`.
- The project avoids a migration with no current product or reliability gain.
- Tests stay aligned with Node's native modules and runtime behavior.
- Contributors use Node assertions rather than Vitest's `expect` API.
- Vitest remains an option when frontend or testing requirements justify it.
