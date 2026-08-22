# Deterministic stream substrate

This package implements only the Kafka-like semantics needed to make event-time
correctness testable:

- stable key hashing into fixed topic partitions;
- monotonically increasing per-partition offsets and per-partition ordering;
- independent committed **next offsets** for consumer groups;
- deterministic round-robin rebalances that restart fetch positions from the
  committed offsets;
- observable at-least-once process/commit failures and an exactly-once in-memory
  transaction that publishes its effect map and offsets together;
- per-partition count or byte retention with loud `OFFSET_OUT_OF_RANGE` errors;
- bounded-out-of-orderness watermarks, combined as the minimum of active
  partitions;
- tumbling and sliding event-time windows, idle partition detection, and
  `drop`, `side-output`, or retained-window `update` policies for late data.

`EventLog` and `EventTimeWindowProcessor` require the repository's injected
clock and accept its seeded RNG and `FlightRecorder`. When no recorder is
provided they still produce local causal events through
`packages/protocol/events.js`; every emitted envelope is validated immediately.
No window boundary reads processing time.

Exactly-once here is deliberately narrow: handlers synchronously mutate the
consumer group's modeled effect `Map`, and a private copy becomes visible in the
same operation as its offsets. It is not a transaction coordinator for an
external database. At-least-once uses the live map before committing, so
`crashBeforeCommit` exposes the double-effect failure mode directly.

Deliberately omitted are replication, persistence, broker discovery, dynamic
partition counts, leader election, network protocols, producer idempotence,
compaction, ACLs, and a general external-storage transaction protocol. Those
features would turn this learning substrate into an incomplete broker without
making watermark or window tests more truthful. A real Kafka deployment remains
the authority for an integration cross-check; it is not a runtime dependency of
this zero-dependency simulation layer.
