# CloudProof Phase IV-B — Multi-Raft

Phase IV-B partitions CloudProof's key space across independent Raft groups ("ranges"). This document is the
pre-registration. It freezes the architecture, the research questions, the correctness model, the experiment structure
and the stopping rules **before any Multi-Raft code or measurement exists**. A change to anything below is recorded as a
dated amendment with a reason, before the data it governs, as in Phase IV-A.

## Status

_Design and methodology frozen. Nothing implemented, nothing measured. The branch `feature/phase-iv-b-multi-raft` was
cut from `bf521b0`, the merge of Phase IV-A into `main`._

## 0. Starting point and relationship to Phase IV-A

Phase IV-A is immutable. Its engine, artifacts, reports and recorded numbers are not altered by this phase, and no
Phase IV-A number is used as a Multi-Raft baseline without being re-measured on the Phase IV-B harness.

The single-range building block is the Phase IV-A engine (`replica/raft.js`, one `RaftNode` per range) with its
`optimized-binary` profile: group commit, bounded batches and pipelined replication. These were measured in
`CLOUDPROOF-PHASE-IV-A.md` §11–§12. The relevant facts about that engine, read from the code at `bf521b0`:

| fact | consequence for Multi-Raft |
|---|---|
| A `RaftNode` addresses peers by URL and sends `POST ${peerUrl}/append-entries`, `/request-vote` and `/pre-vote`. | With group-scoped member URLs (`http://node1:5001/ranges/r1`), several groups can share one HTTP listener **without changing the engine**. |
| The framed TCP transport maps the URL **path** to an RPC type, one handler set per process. | The binary profile cannot carry group-scoped paths. Multiplexing groups over framed TCP needs a group id in the frame: a **transport** change, with its own codec tests and regression. |
| Client deduplication (`_findDuplicate`) scans the range's **own Raft log** for `clientId` + `seqNo`. | Correct for static ranges, because a key never changes range. After a split, a child range starts without the parent's log, so dedup records must move with the keys they cover (§3.4). |
| Membership change exists: learners, `addServer` with catch-up, `removeServer`. | Replica movement (IV-B.2) can be built on it. |
| There is no leadership-transfer operation. The vote handler accepts a `force` flag (the thesis §4.2.3 bypass a transfer needs), but nothing initiates a transfer. | Leader placement (IV-B.2) needs one. That is an **engine** change, with its own regression and justification (§11). |
| The process has one Node event loop, which was the measured ceiling of the optimized single group (IV-A §12: event-loop utilization ≈ 1.0 at the knee). | Ranges hosted in one process share that ceiling. Topology is an independent variable of every scale experiment (§8.2). |
| `sim/linearizability.js` checks a history against a key-value register model, including timed-out operations that may or may not have happened. | It is the checker for the logical history (§5). |

## 1. Research questions

The phase must answer these with recorded measurements. No positive answer is presupposed, and a negative or
disappointing answer is a result to be reported, not a reason to change the experiment.

- **Q1.** Does partitioning the key space across independent Raft groups increase aggregate write throughput over the
  Phase IV-A single-group engine, on the same machine?
- **Q2.** How close to proportional is scaling as the number of independently active ranges grows, and which resource
  becomes the next bottleneck?
- **Q3.** Under skewed (Zipf) workloads, does one hot range stop cold ranges from making progress, or does Multi-Raft
  isolate the hotspot?
- **Q4.** Can CloudProof split and move a live range without violating linearizability or losing an acknowledged
  write?
- **Q5.** Can stale routers, delayed RPCs and old range leaders be fenced after a split or migration?
- **Q6.** How much unavailability and tail-latency disturbance does a split or a rebalance cause?

One expected limit is recorded now so that it cannot be dropped later. Multi-Raft is likely to scale independent keys,
but it cannot scale **one hot key**: an indivisible key is serialized by the single consensus group that owns it. The
hot-key experiment (§8.1) exists to show that boundary. It will be reported whatever it shows.

## 2. Architecture

### 2.1 Range descriptor

```
RangeDescriptor {
  rangeId      unique, never reused (e.g. "r1", "r2", ...; children of a split get new ids)
  startKey     inclusive
  endKey       exclusive; "" for the start of the space, +inf for the end
  epoch        positive integer, monotonically increasing per ownership change
  replicas[]   node ids hosting a voting replica of this range
  leaderHint   last known leader node id (advisory only, never trusted for correctness)
  state        ACTIVE | SPLITTING | FENCED | RETIRED
}
```

The key space is a sorted, half-open partition: every range owns `[startKey, endKey)`. Every key maps to exactly one
ACTIVE range. Keys compare as UTF-8 byte strings. Benchmark keys are fixed-width (`k00000`–`k99999`), so byte order is
numeric order.

### 2.2 Components

| component | role | introduced in |
|---|---|---|
| `RangeGroup` | One `RaftNode` (the Phase IV-A engine, unchanged) plus the range's state machine, its descriptor and its data directory. | IV-B.0 |
| `MultiRaftNode` | A process hosting replicas of several ranges. It owns one listener and dispatches each RPC to its `RangeGroup` by `rangeId`. Each group has its own log and fsyncs; the event loop is shared. | IV-B.0 |
| `RangeRouter` | Client-side. Resolves `key → (rangeId, epoch, leaderHint)` from a cached descriptor set, and refreshes from a `STALE_RANGE_EPOCH` error or the directory. Retries are bounded. | IV-B.0 (static) |
| `RangeDirectory` | The descriptor store routers read. In IV-B.0, a fixed descriptor set identical on every node. From IV-B.1, derived from the ranges' own committed descriptors (§3.3). It is a **cache, never the authority**. | IV-B.0 / IV-B.1 |
| `PlacementDriver` | Decides splits, replica moves and leader placement deterministically from recorded load. | IV-B.2 / IV-B.3 only |

IV-B.0 implements only `RangeGroup`, `MultiRaftNode`, a static `RangeRouter` and the fixed descriptor set. The
`PlacementDriver` and any auto-split logic are not built until static Multi-Raft correctness is established (§6).

**No Raft correctness logic is forked or rewritten for Multi-Raft.** Each range is an ordinary instance of the Phase
IV-A engine. Anything Multi-Raft-specific sits above it (routing, dispatch, descriptors) or in the replicated state
machine it drives (descriptor state, epoch checks, split application). Where the engine itself must change
(leadership transfer, dedup carry-over), §11 applies.

## 3. Range epochs and fencing

This is the central mechanism of the phase. Splitting a map across several Raft groups is easy. The hard part is
ensuring that an old router plus an old leader can never resurrect ownership after a split.

### 3.1 Epochs

Each range's descriptor carries an `epoch`, initially 1. Every ownership change (split, and in IV-B.2 any change of
the key interval a range answers for) commits a strictly higher epoch. Epochs are never reused, and a `rangeId` is
never reused: children of a split get new ids.

### 3.2 Routed operations and the error

Every routed operation carries `rangeId` and `expectedRangeEpoch`, and the key(s) it touches. A replica rejects the
operation, without mutating anything, when:

- `rangeId` is not hosted on this node, or its state is not `ACTIVE`; **or**
- `expectedRangeEpoch` differs from the range's current epoch; **or**
- a key is outside the range's current `[startKey, endKey)`.

The rejection is an explicit error, `STALE_RANGE_EPOCH`. It carries the replica's current descriptor and, after a split,
the child descriptors, so the router can refresh and retry. The client sees one logical operation. A rejected request
is **definitively not applied**, so retrying it is safe (§3.4 covers the case where an *earlier* attempt was applied).

### 3.3 Where fencing is enforced

The decision is enforced in **two places, and only the second is relied on for safety**:

1. **At admission** (HTTP / RPC edge, on the leader). This is a fast reject, so stale requests do not consume log
   space. It is an optimization only: between admission and commit, the range can change epoch.
2. **At apply, inside the replicated state machine, in log order.** Each write entry records `rangeId` and
   `expectedRangeEpoch`. When it is applied, the range's state machine compares them with the descriptor *as of that
   log position*. A mismatch applies the entry as a deterministic no-op rejection on every replica, and the client is
   answered with `STALE_RANGE_EPOCH`. Because every replica applies the same log in the same order, every replica makes
   the same decision.

A split is itself an entry in the parent's log (§7.1). Every write ordered after it in the parent's log is therefore
rejected at apply. That is how **parent fencing (I8)** is guaranteed by construction, including for an old parent
leader that admitted a write before learning of the split.

An old leader that has been deposed cannot commit at all: that is Raft's own guarantee, unchanged. Reads take the same
check on the range's read path. Both lease reads and ReadIndex reads consult the descriptor of the range serving them,
and a `FENCED` or `RETIRED` range answers `STALE_RANGE_EPOCH`.

### 3.4 Deduplication across ownership changes

A retried write (same `clientId`, `seqNo`) must not apply twice, even when the retry reaches a different range than
the attempt that was applied. The case that forces this:

1. A write to key `k` is applied in parent P.
2. Its response is lost.
3. P splits.
4. The client retries; the router now sends it to child L.

L's log has never contained the write. The current dedup, which scans the log (§0), would apply it again. Dedup is
group-local today. Once ranges move, exactly-once retry safety is state that must migrate with the keys, not an
implementation detail of the old log. Its identity is frozen as:

```
LogicalRequestId = (clientId, seqNo)

DedupRecord {
  clientId
  seqNo
  key                 the key the request wrote
  operationDigest     SHA-256 of the canonical operation (op, key, value, expected values)
  result              the result returned to the client when it was applied
  appliedAtLogIndex   the index in the applying range's log
}
```

- **The dedup records are part of the range's replicated state.** They are written at apply, in log order, on every
  replica.
- **A retry with a known `LogicalRequestId` is not applied again.** It returns the recorded `result`. A request that
  reuses a `LogicalRequestId` with a different `operationDigest` is rejected as a client error. It is never answered
  with another operation's result.
- **On a split P → L, R, every retained record moves to the child that owns its `key`.** No record is dropped,
  duplicated or kept in both children.
- **No dedup garbage collection in Phase IV-B.** Every record is retained. A safe GC horizon is a separate design,
  made later.
- **Until IV-B.1, the existing log-scan dedup is unchanged.** In static ranges a key never changes range, so a retry
  always reaches the range that holds the original.

This is a change to the state machine and the dedup path, so §11 applies to it.

## 4. Correctness invariants

These are frozen. None is weakened for performance.

| id | name | statement |
|---|---|---|
| I1 | Unique key ownership | For every logical key and every committed descriptor state, exactly one ACTIVE range owns the key. |
| I2 | No key-space gap | The ACTIVE descriptors cover the configured key space continuously. |
| I3 | No key-space overlap | No two ACTIVE descriptors own the same key at the same time. |
| I4 | Monotonic range epoch | A range's epoch never decreases. Neither an epoch value nor a `rangeId` is ever reused. |
| I5 | Stale-owner fencing | A request addressed with an obsolete `(rangeId, epoch)` cannot mutate state. |
| I6 | Acknowledged-write durability | Every acknowledged write is present exactly once after leader failure, restart, split or migration. |
| I7 | Split conservation | For a parent P split into L and R: `keys(P) = keys(L) ∪ keys(R)` and `keys(L) ∩ keys(R) = ∅`, and every value committed in P before the split is preserved in exactly one child. |
| I8 | Parent fencing | Once the children are authoritative, P never accepts a new write. |
| I9 | Linearizability across range transitions | Operations on a key are linearizable even when the key's ownership moves between range groups. |
| I10 | Router staleness safety | A stale router may cause retries. It may never cause an incorrect commit. |

I1–I4 are checked on every simulator step from the omniscient view of all committed descriptors. They are also checked
at the end of every live run, from each node's applied descriptors. I5–I8 and I10 are checked by targeted fault
campaigns (§7) and by counters every trial records (stale writes accepted, gaps, overlaps). I9 is checked on the
logical client history (§5.1). I6 is checked twice. Its "present" half comes from the recovered state against the
acknowledged writes. Its "exactly once" half comes from the application ledger (§5.2), never from the linearizability
checker.

## 5. Checking the logical API: two independent gates

Two different properties are checked by two different mechanisms. Neither stands in for the other:

```
LOGICAL API CORRECTNESS   the combined-history linearizability checker (§5.1)
EXACTLY-ONCE APPLICATION  every LogicalRequestId has applicationCount <= 1 (§5.2)
```

### 5.1 Linearizability of the logical history

**What is checked is the logical key-value API that clients see, not physical Raft groups.** Splits and migrations are
implementation details. Checking each Raft group's history on its own is insufficient, because a key's history would be
cut in two at the split.

Linearizability is local: a history is linearizable if and only if each per-object sub-history is (Herlihy & Wing). In
scope, every operation touches one key (§12), so the logical history is checked **per logical key** with the existing
register model in `sim/linearizability.js`, wherever the operation was served.

- **Static ranges (IV-B.0):** the per-range checks used today, plus the combined client history across all ranges,
  partitioned by key. A combined history across ranges is required. It is what catches a router that sends one key to
  two ranges.
- **Split and migration (IV-B.1 onwards):** one logical history per key spans the old and new range ids. A request
  retried after `STALE_RANGE_EPOCH` is one logical operation: invocation at its first send, response at its final
  answer. A request that timed out is "may or may not have happened", as the checker already supports.

Every recorded operation keeps:

- request id, `clientId`, `seqNo`
- key, value, operation
- invocation and completion times and order
- the outcome, or the timeout
- every attempt's `rangeId` and `expectedRangeEpoch`
- router retries and the `STALE_RANGE_EPOCH` responses that caused them
- the physical group that finally served it

Histories behind any reported violation are kept, shrunk where the search supports it, and replayable from their seed.

### 5.2 Exactly-once application

**Linearizability does not prove "no duplicate logical write".** Suppose `SET x = 7` is applied once in the parent and
again in a child. A register checker can accept that history, because applying the same `SET` twice leaves the same
state and the same observations. A clean linearizability result therefore says nothing about duplicate application.

Exactly-once is checked from an **application ledger**. Every range's replicated state machine records, at apply, each
`LogicalRequestId` it applied successfully, with its range, epoch and log index. A request rejected at apply (stale
epoch, duplicate) is recorded as a rejection, not an application. After a run, the committed ledgers of all ranges are
joined on `LogicalRequestId`. Every split and failure run records, for every logical request:

```
logicalRequestId
attemptCount
rangeIdsAttempted
epochsAttempted
committedRangeId
committedEpoch
applicationCount     applications of this id across the ledgers of all ranges
resultReturned
```

The gate is `applicationCount <= 1` for every logical request, and `applicationCount = 1` for every acknowledged
write. The counters `duplicate logical writes` and `logical requests applied more than once` are computed from this
ledger. They are not inferred from the register checker.

## 6. Phase structure and gates

The order is frozen. Each stage starts only after the previous stage's gate is green, and a failed gate stops the phase
at that stage until it is fixed and the whole gate re-run.

**IV-B.0 — Static Multi-Raft**
- fixed descriptors, at least 2 independent groups (3 for the gate);
- deterministic router;
- no split, no rebalance, no cross-range transaction.

Gate (§13): correctness first, no benchmark.

**IV-B.1 — Live range split**
- one parent → two children: the descriptor epoch transition, parent fencing, stale-router retries, dedup carry-over
  (§3.4);
- crash injection at every transition boundary (§7);
- counterexamples shrunk.

Gate: every hard publication gate in §7 at zero.

**IV-B.2 — Placement and scale-out**
- multiple ranges per node, leader placement (requires leadership transfer, §11), replica movement and rebalance;
- 3 logical nodes as the baseline, and more logical nodes on the same benchmark host where it permits (§9);
- deterministic placement decisions.

Gate: the movement fault campaign at zero violations, before the scale experiments are reported.

**IV-B.3 — Hot-range auto-split**
- load- and size-based split trigger, deterministic split proposal;
- verify the resulting placement;
- measure hotspot relief under Zipf.

Gate: same as IV-B.1, for automatically triggered splits.

Range merge is not implemented in Phase IV-B unless every earlier gate has passed. Distributed transactions are not
implemented in Phase IV-B.

## 7. Live split protocol and failure windows

### 7.1 Protocol (to be implemented in IV-B.1)

The split's commit point is a single entry in the parent's own log. There is no cross-range transaction.

1. **Intent.** A split of P (epoch `e`) at `splitKey` is proposed to P's leader as one entry:
   `{op: 'range.split', rangeId: P, expectedRangeEpoch: e, splitKey, left: {id: L}, right: {id: R}}`. It is subject to
   the same apply-time epoch check as any write.
2. **Commit point.** The entry commits in P's log by ordinary Raft. Before it commits, nothing has changed. After it
   commits, the split will happen on every replica of P (Leader Completeness). Its log position is recorded as
   **`(splitIndex, splitTerm)`**, the cutover boundary:
   - the child snapshots are exactly P's state **through `splitIndex`**, including its dedup records;
   - a write ordered before the split entry has committed before it can commit, so it is in the snapshot;
   - a write ordered after it is fenced at apply (§3.3).
3. **Apply,** on each replica of P, in log order:
   - P's state machine moves to `FENCED` at epoch `e+1`;
   - P's key-value state and dedup records through `splitIndex` are partitioned at `splitKey`;
   - L and R are created locally on the same replica set, each at epoch `e+1`, `ACTIVE`, with the partitioned state as
     their initial snapshot.

   The child state is a deterministic function of P's state at the split index. A replica that crashes during apply
   re-creates identical children when it replays P's log.
4. **Child elections.** L and R elect leaders as new Raft groups. They cannot commit before a quorum of P's replicas
   has applied the split and persisted the child state. This is the window measured for Q6.
5. **Routing.** Writes still addressed to P are rejected at apply (§3.3), with the child descriptors attached. Routers
   refresh from those errors, or from the directory, which learns the new descriptors from the ranges themselves.
6. **Retirement.** Once both children are durable on a quorum, P is `RETIRED`: it keeps answering
   `STALE_RANGE_EPOCH` and never applies a write again.

Fencing and activation happen in the same apply step on any one replica. So the state "children active while the
parent still accepts writes" cannot arise on a single replica. Across replicas, a lagging replica of P may still believe
P is ACTIVE, but it cannot commit a write after the split: any such write is ordered after the split entry in P's log
and is rejected at apply. The failure windows below test exactly these claims rather than assuming them.

### 7.2 Pre-registered failure windows

Each window is a named failpoint in the style of the Phase IV-A durability gate, where the process dies inside the
window. Every window is also driven in the deterministic simulator, with crashes and partitions aimed at it.

| window | where |
|---|---|
| A | before the split intent is durable on P's leader |
| B | intent durable, before the child snapshots are written |
| C | one child's state durable, the other's not |
| D | both children durable, before the descriptor activates (P not yet `FENCED`) |
| E | children activated on one replica while another replica of P has not applied the split |
| F | P fenced, before any router has refreshed |
| G | immediately after activation (first child leader election) |
| H | an old leader of P receives a delayed write admitted under epoch `e` |
| I | a stale router sends a request with the old `(P, e)` |
| J | a child leader crashes immediately after activation |

For every window, each run records:

- acknowledged before the crash
- recovered acknowledged
- missing acknowledged
- duplicate logical writes and logical requests applied more than once, both from the application ledger (§5.2)
- stale-epoch writes accepted
- descriptor gaps
- descriptor overlaps
- the per-request ledger rows of §5.2
- the logical-history linearizability result (§5.1), reported separately

**Hard publication gates.** A single nonzero value in any run fails the gate:

- missing acknowledged writes = 0
- duplicate logical writes = 0 (application ledger)
- logical requests applied more than once = 0 (application ledger)
- stale-epoch writes accepted = 0
- key-space gaps = 0
- key-space overlaps = 0

The logical-history linearizability check (§5.1) must also find no violation. It is a separate condition, and it does
not substitute for the ledger counts.

## 8. Benchmark design

The measurement principles are Phase IV-A's, unchanged:

- open-loop arrivals at constant spacing, latency from the intended send time (no coordinated omission);
- warmup excluded, 20 s windows, 10 s timeout;
- the stability rule v1, the stop rule v1 and the knee definition;
- the disk sentinel and its regime bins;
- the Williams Latin-square order;
- the per-process power-policy opt-out, verified per process;
- fresh clusters per trial, nothing discarded or selected.

The primary payload is **1 KiB**. The generator becomes router-aware: it resolves each key's range and sends to that
range's leader. Router retries are recorded and charged to latency.

The concrete plan files (ladders, repetitions, process counts) are frozen in a methodology file and plan files under
`artifacts/perf/phase-iv-b/`, committed before the first trial of each experiment. They follow this section and do not
change it.

### 8.1 Workloads

| workload | definition |
|---|---|
| UNIFORM | Keys drawn uniformly from `k00000`–`k99999`; ranges own equal key intervals, so offered load per range is equal in expectation. |
| ZIPF | Keys drawn from a Zipf distribution over the same 100,000 keys at **s = 0.99 and s = 1.2**. These two values are frozen; key rank order is fixed by a recorded seed. |
| SINGLE HOT RANGE | 80% of arrivals to keys of one range, 20% spread uniformly over the others. |
| SINGLE HOT KEY | 100% of arrivals to one key. This shows the serialization boundary Multi-Raft cannot remove. |

### 8.2 Topologies

Every topology runs on **one physical benchmark host**. A "node" here is a logical node: one operating-system process
hosting replicas. Each topology is a separate, labelled experiment, because they answer different questions:

| id | topology | what it isolates |
|---|---|---|
| T0 | 1 range, 3 logical nodes | the single-range baseline, re-measured on the IV-B harness |
| T1 | N ranges, one process per (logical node, range) | independent groups that share no event loop: an upper bound for N ranges on this host |
| T2 | N ranges per `MultiRaftNode`, all leaders on one logical node | the shared event loop on the leader node |
| T3 | N ranges per `MultiRaftNode`, leaders spread across logical nodes | the intended Multi-Raft deployment |
| T4 | more than 3 logical nodes on the same host | whether more processes use more of the one machine; the limit is stated with the result |

N takes the values 1, 2, 4 and 8, as far as the machine sustains them. The plan file freezes the exact set before the
first trial.

### 8.3 Metrics

Every trial records, at least:

- **load:** offered and achieved writes/s; p50, p99 and p99.9; send (queue) delay;
- **CPU:** per-node and per-range CPU, and event-loop utilization per process;
- **disk and replication:** durable fsyncs per write, entries per fsync, RPCs per write;
- **range state:** active range count, per-range throughput and queue depth, leader placement;
- **routing:** router retries and stale-epoch retries;
- **split and migration (IV-B.1 onwards):** split duration, migration bytes, and write unavailability during the split
  (the longest gap between successful writes to the affected keys).

**Fairness.** Aggregate throughput must not hide a starved range. Every trial reports:

- Jain's fairness index over the ranges' achieved/offered ratios;
- the minimum per-range achieved/offered ratio;
- p99 latency on the cold ranges separately from the hot ones.

A configuration is not called stable if any range fails the stability rule on its own sub-history.

## 9. Scale claim rule

"Linear scaling" is not used casually. Scaling is reported as measured efficiency:

```
scaling efficiency(N) = throughput(N ranges) / (N × throughput(1 range))
```

It is computed only where the resource topology makes the comparison meaningful: the same nodes, process model and
power policy, and the T0 baseline measured in the same interleaved sweep. Every efficiency figure is reported with the
resource that stops further scaling (event loop, CPU, disk fsync, generator, or another one identified), and with its
p99. If throughput rises while p99 explodes, the report says so.

**Host scope.** Phase IV-B measures logical nodes, processes and Raft groups on one physical host. What it can show is
whether Multi-Raft uses more of one machine, and whether independent groups escape the single-event-loop ceiling. It
cannot show horizontal scale-out across machines. Every scale statement is therefore worded at host scope, for
example: "we increased the number of logical Raft nodes / groups on one physical benchmark host". No result is written
as "CloudProof scales from 3 to 9 nodes" without that qualifier. A genuine multi-host experiment is a separate,
later experiment, reported separately.

## 10. Stopping rules

- **Benchmark:** the Phase IV-A stop rule per curve: two consecutive majority-unstable rates, or a mean
  achieved/offered ratio below 0.5.
- **Stage gates:** a failed gate stops the phase at that stage (§6). A fix is followed by the complete gate, never a
  partial re-run.
- **No retuning after results:** no profile, timeout or placement parameter is tuned after seeing a measurement it
  would affect. Changes go through an amendment, recorded before new data.
- **Thermal and environment:** Phase IV-A amendment 3 applies. Long runs go in cool-down blocks, nothing completed is
  rerun, and host load is recorded and disclosed.

## 11. Changes to the Raft engine

The Phase IV-A engine interface is used as-is wherever it suffices. Where Multi-Raft needs a change inside the engine
or its state-machine contract, the change gets:

- a written reason why the interface was insufficient;
- its own correctness regression: the full Phase IV-A regression suite (34 steps), plus targeted tests and simulator
  campaigns for the new behaviour.

The engine already takes its state machine as a constructor option (`stateMachine`). It applies each committed entry
through `stateMachine.apply(entry)` before releasing commit waiters, and it answers clients with
`stateMachine.resultFor(index)`. A per-range state machine passed through that option can therefore reject at apply
and report why, without touching `replica/raft.js`.

The changes known at freeze time:

| change | where it lives | why the interface is insufficient | stage |
|---|---|---|---|
| Apply-time range epoch check and descriptor state | per-range state machine (injected; engine unchanged) | Fencing must be decided in log order on every replica (§3.3). | IV-B.0 (static epochs); exercised in IV-B.1 |
| Application ledger | per-range state machine (injected; engine unchanged) | Exactly-once must be counted from what each range applied, not inferred from the client history (§5.2). | IV-B.0 |
| Replicated `DedupRecord`s, moved with their keys on split, never garbage-collected in IV-B | state machine **and** the engine's dedup path (`_findDuplicate` in `clientAppend`) | Log-scan dedup cannot see writes applied in a parent range (§3.4). | IV-B.1 |
| Group id in framed-TCP frames, and per-group server dispatch | transport | Framed TCP routes by path and has one handler set per process. | after IV-B.0, which uses HTTP only |
| Leadership transfer | engine | The engine has no operation to move leadership; only the vote-side `force` bypass exists. | IV-B.2 |

The first two rows change no engine code. They still get their own tests, and the IV-A regression is rerun with them in
the tree.

## 12. Out of scope

- cross-range atomic transactions
- multi-key operations that span ranges
- distributed SQL
- range or consensus-group merge (unless every earlier gate has passed)
- geo-replication
- Byzantine faults
- replacing the deterministic verifier
- UI work: every CloudProof UI surface is frozen

## 13. First implementation gate (IV-B.0)

The first milestone is **not a benchmark**. IV-B.0 is deliberately minimal: it proves that several independent copies
of the already-tested engine can coexist correctly, and nothing more.

**Scope of IV-B.0:**

- three static ranges with **immutable descriptors**, loaded from deterministic configuration;
- every descriptor at epoch 1. `RangeDirectory` needs no consensus, because the metadata never changes in this
  milestone.
- the **HTTP transport only**, with range-prefixed group endpoints (`/ranges/<rangeId>/append-entries` and the other
  RPCs on each node's single listener);
- the engine itself unchanged.

**Not in IV-B.0:** live splitting, binary-transport multiplexing, leadership transfer, placement or balancing, and a
metadata Raft group.

**Routing.** The router does nothing more than:

```
descriptor = directory.lookup(key)
request = { rangeId: descriptor.rangeId, expectedRangeEpoch: descriptor.epoch,
            clientId, seqNo, key, op, value }
```

**The gate requires all of the following, together, in one recorded run per condition:**

1. **Concurrency:** concurrent operations on at least three ranges.
2. **Independent leader failure:** the leader of each group is killed independently.
3. **Independent progress:** one range keeps committing while another elects a new leader.
4. **Fencing:** a request with a wrong or stale `rangeId` or epoch is rejected and mutates nothing. A key outside the
   addressed range's interval is rejected too.
5. **Durability:** each range's committed state survives restart.
6. **Logical linearizability:** the combined client history, checked per logical key, has no violation (§5.1).
7. **Exactly-once:** every logical request has `applicationCount <= 1` in the application ledger, and every
   acknowledged write has exactly 1 (§5.2).
8. **No regression:** the entire Phase IV-A single-group regression suite (34 steps) passes unchanged.

Conditions 1–7 are shown in the deterministic simulator and in a live multi-process run.

**Commit structure.** The routing, group-hosting and correctness-test work land as separate commits after this design
commit, never as one large Multi-Raft drop. The gate's result is reported for review before IV-B.1 begins. Live
splitting does not start until this gate is green.
