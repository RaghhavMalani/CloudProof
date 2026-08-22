# Implementation prompt — Stage 1 of the streaming ML platform

Paste everything below into Codex. It is written to be read cold, with no
knowledge of the conversation that produced it.

---

## Your role

You are implementing Stage 1 of a staged plan inside an existing repository at
`D:\College_Projects\miniRAFT_project` (a hand-written Raft consensus engine that
has grown into a distributed-systems laboratory). The full plan lives in
`ROADMAP-ML.md`. **Read that file first.** This prompt covers Stage 1 only.

Do not start Stages 2–6. They are summarised at the end so you understand what
your code has to support, not so you build them.

## The thesis you are serving

> **Feature pipelines are distributed systems, and nobody tests them like one.**

Teams ship a model that scores 0.94 AUC offline and 0.61 in production, and
nothing throws an error. The usual explanation — "distribution shift" — is
frequently wrong. The real cause is often a *correctness* bug: a window closed
before its late data arrived, a join leaked information from the future, or a
consumer rebalanced mid-window and double-counted.

This repository already contains a deterministic simulator and a linearizability
checker built for consensus. The project points those instruments at a streaming
ML pipeline. Stage 1 builds the substrate that makes the rest testable.

## Ground truth about this repository

Verify each of these before relying on it; do not assume anything not listed.

**Language and runtime**
- Node.js (CI pins Node 24; local dev is on v22). **CommonJS only** —
  `require` / `module.exports`. No ESM, no TypeScript, no transpiler.
- **Zero runtime dependencies** in the simulation and packages layers. `replica/`
  and `serving/` have their own `package.json` and may use deps; the code you
  write must not.
- Tests use the **Node built-in test runner**: `node:test` + `node:assert/strict`.
  No Jest, Mocha, Vitest, or Chai.

**Layout that matters to you**
```
packages/protocol/events.js      canonical event schema + validateEvent()
packages/simulator/              invariant evaluation, flight recorder
packages/scenario-dsl/           text → runnable scenario
packages/workloads/              the ten failure scenarios, one interface each
sim/simulator.js                 Rng, VirtualClock, SimNetwork
sim/cluster.js                   SimCluster
sim/linearizability.js           LinearizabilityChecker, HistoryRecorder
sim/fuzz.js, sim/search.js       campaign runners
replica/raft.js                  the consensus engine
replica/hnsw.js, sparse.js, quantize.js   hand-written vector + BM25 retrieval
tools/build-web.js               40-line dependency-free browser bundler
```

**Test conventions**
- Tests are co-located: `foo.js` is tested by `foo.test.js` beside it.
- CI runs `node --test sim/*.test.js packages/*/*.test.js`. **A new directory
  under `packages/` is picked up by CI automatically** — this is why your code
  belongs at `packages/stream/`, not in a new top-level folder.
- CI also syntax-checks every `.js` under `replica serving tools sim packages apps`,
  and fails if `node tools/build-web.js` produces a diff in `web/`.

**Determinism is enforced, not aspirational**
- `Math.random()` and `Date.now()` are banned in simulation code. Time and
  randomness are injected. `sim/simulator.js` exports `Rng` (seeded),
  `VirtualClock` (`now()`, `setTimeout()`, `advance()`, `drain()`), and
  `SimNetwork` (`partition()`, `heal()`, `forNode()`, `observe()`).
- A previous bug in this repo was exactly this: `Math.random()` inside a timeout
  helper made runs unreproducible. It was fixed by injecting `random`. Do not
  reintroduce it.
- **Reuse `VirtualClock` and `Rng`. Do not write your own.** If they lack
  something you need, extend them and say so.

**Comment style**
Comments in this repository explain *why*, and specifically what bug a piece of
code prevents. Match that. Do not write comments that restate the code.

## Stage 1 — what to build

Two modules and their tests, under a new `packages/stream/`.

### 1. `packages/stream/log.js` — the partitioned event log

Kafka's semantics, hand-written. The point is to understand them, not to clone
Kafka.

Required behaviour:
- **Partitions.** A topic has N partitions. A record is assigned by
  `hash(key) % N`. Ordering is guaranteed **within a partition only** — this is
  the single most important property, because it is why event time is hard.
- **Offsets.** Monotonic per partition, starting at 0. Append returns the
  assigned offset.
- **Consumer groups.** Each group has an independent committed offset per
  partition. Two groups reading the same topic do not affect each other.
- **Rebalance.** Partitions are assigned to consumers in a group. When a consumer
  joins or leaves, reassign. A rebalance must not lose or duplicate a committed
  offset — and the test must prove it, including the case where a rebalance
  happens between processing a record and committing its offset.
- **Delivery semantics.** Support both, and make the difference observable:
  - *at-least-once*: process, then commit. A crash between them redelivers.
  - *exactly-once*: the effect and the offset commit are one atomic unit.
- **Retention** by record count or size, so an old offset can become invalid.
  Reading a truncated offset must fail loudly, not silently return the oldest
  record.

Suggested shape — adapt if you find something better, but keep it injectable:

```js
const log = new EventLog({ partitions: 4, rng, clock });
const { partition, offset } = log.append('transactions', { key, value, eventTimeMs });
const group = log.subscribe('transactions', { groupId: 'features', consumers: 2 });
const batch = group.poll({ maxRecords: 100 });
group.commit(batch);
group.rebalance({ consumers: 3 });
```

### 2. `packages/stream/watermark.js` — event time and windowing

This is where the interesting bugs live and what every later stage depends on.

Required behaviour:
- **Event time vs processing time**, kept strictly separate. A record carries
  `eventTimeMs` (when it happened). The clock reports processing time (when it
  arrived). Conflating them is the bug this module exists to prevent.
- **Watermark generation.** A watermark of T asserts "no record with
  `eventTimeMs < T` will arrive again." Implement bounded-out-of-orderness:
  `watermark = maxSeenEventTime - allowedLatenessMs`. The watermark must be
  **monotonic** — it may never go backwards, even if a much older record arrives.
- **Per-partition watermarks combined by minimum.** The stream watermark is the
  *minimum* across partitions, not the maximum. A single stalled partition must
  hold the whole watermark back. Getting this wrong closes windows early and is a
  classic real-world bug — test it explicitly.
- **Windows.** Tumbling and sliding, assigned by event time. A window may only
  emit once the watermark passes its end.
- **Late data policy**, explicit and configurable:
  - `drop` — discard, but **count it**; silent loss is the failure mode.
  - `side-output` — route to a separate stream for inspection.
  - `update` — re-emit a corrected result, only if the window is still retained.
- **Idle partitions.** A partition that receives nothing must not stall the
  watermark forever. Implement an idleness timeout and test it.

### 3. Tests — `log.test.js` and `watermark.test.js`

Every test must be deterministic from a seed. Cover at minimum:

| Test | The bug it prevents |
| --- | --- |
| Ordering holds within a partition, not across | Assuming global ordering |
| Rebalance between process and commit | Lost or duplicated records |
| At-least-once redelivers; exactly-once does not | Silent double-counting |
| Reading a retention-truncated offset fails loudly | Silent data loss |
| Watermark never decreases when old data arrives | Windows reopening |
| Stream watermark is the min, not the max, of partitions | Windows closing early |
| A window emits only after the watermark passes its end | Incomplete results |
| Late data is counted under every policy | Invisible loss |
| An idle partition does not stall the watermark forever | Pipeline that silently stops |

**Emit events through `packages/protocol/events.js`.** Validate them with
`validateEvent()`. The causal trace is what Stage 5's LLM reads and what the
existing Flight Deck renders — a pipeline that does not emit a conforming trace
is invisible to the rest of the system.

### Acceptance gate for Stage 1

You are done when all of these hold:

1. `node --test packages/stream/*.test.js` passes.
2. `node --test sim/*.test.js packages/*/*.test.js` passes — **nothing else in
   the repo regressed.**
3. Running the same seed twice produces byte-identical event traces. Add a
   `--digest` style check if one does not already fit; `sim/fuzz.js` has the
   existing pattern for this.
4. Every event validates against `packages/protocol/events.js`.
5. `find replica serving tools sim packages apps -name '*.js' -not -path '*/node_modules/*' -print0 | xargs -0 -n1 node --check` passes.

## The domain

Unless told otherwise, model the stream as **card transactions for fraud
detection**. This is not decoration — it is chosen because:

- It is the canonical point-in-time-correctness example (Stage 2 depends on it).
- **Labels arrive late and irregularly.** A chargeback lands weeks after the
  transaction, which is *itself* a watermark problem — the label stream and the
  feature stream have wildly different lateness characteristics.
- The severe class imbalance makes Stage 4's calibration maths genuinely
  necessary rather than ornamental.

A transaction record: `{ cardId, merchantId, amountCents, eventTimeMs, mcc, country }`.
A label record: `{ transactionId, isFraud, eventTimeMs }` arriving days later.

## How this fails — read before writing code

These are the specific ways this work goes wrong.

- **Cloning Kafka instead of learning it.** You are not building a broker. Stop
  at the semantics that make windowing testable. Stage 1 deliberately ends by
  cross-checking against real Kafka in Docker rather than replacing it.
- **Conflating event time and processing time.** If any window boundary,
  watermark, or aggregation reads the wall clock, the module is wrong. This is
  the single most common real-world bug in this area.
- **Watermark as maximum across partitions.** It is the minimum. Writing `max`
  produces a pipeline that looks faster and is quietly incorrect.
- **Silent drops.** Every discarded record must be counted and surfaced. The
  failure mode this whole project exists to expose is loss that reports success.
- **Reintroducing nondeterminism.** No `Math.random()`, no `Date.now()`, no bare
  `setTimeout`. Route everything through the injected `clock` and `rng`.
- **Trusting your own harness.** In this repository the *test harness* has
  historically been wrong more often than the engine — a simulator partition bug,
  an incorrect log-matching invariant, and a UI cursor bound were all harness
  faults that produced confident false failures. When a test fails, confirm the
  bug by hand before changing engine code.

## What comes later (context only — do not build)

- **Stage 2 — the point of the project.** Online features from the stream,
  offline from batch. Build the *naive* join first on purpose, measure the AUC
  collapse caused by label leakage, then build the correct point-in-time join and
  measure the gap closing. Your watermark and window code is what makes a correct
  point-in-time join expressible.
- **Stage 3.** Point the existing deterministic simulator at the pipeline: late
  data past the watermark, rebalance mid-window, duplicate delivery, broker
  restart. Assert exactly-once effects and online/offline feature agreement.
- **Stage 4.** Logistic regression with SGD from scratch, then PSI, KL
  divergence, KS tests, reliability diagrams, Brier score.
- **Stage 5.** The existing HNSW/BM25/RRF engine becomes an embedding feature
  type. The LLM gets exactly two jobs: explain a drift alert from the causal
  trace, and compile English into the scenario DSL. **No chat box.**
- **Stage 6.** TLA+ spec of the membership change and the atomic model-pointer
  flip, model-checked.

Design Stage 1 so Stage 3 can inject faults into it. Concretely: every source of
time, randomness, and network behaviour must be constructor-injected, exactly as
`replica/raft.js` does it. Read that file for the pattern before you start.

## Deliverables

1. `packages/stream/log.js`
2. `packages/stream/watermark.js`
3. `packages/stream/log.test.js`
4. `packages/stream/watermark.test.js`
5. A short `packages/stream/README.md` stating which Kafka semantics are
   implemented, which are deliberately omitted, and why.

Report at the end: what you built, which tests cover which property, anything in
the acceptance gate you could not satisfy, and any place where you disagreed with
this prompt and did something else instead.
