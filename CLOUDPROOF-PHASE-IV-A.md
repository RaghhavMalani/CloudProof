# CloudProof Phase IV-A — single-Raft performance engineering

Phase IV-A turns the CloudProof Raft group from a correctness-first prototype into a measured,
instrumented, load-tested consensus system. It does **not** claim CloudProof is faster than etcd.
It asks five questions and answers them with recorded, reproducible measurements:

1. Where does one CloudProof Raft group saturate?
2. What dominates latency before and after saturation?
3. Can group commit, replication pipelining and bounded batching raise throughput without breaking
   durability or linearizability?
4. What gap remains versus etcd under comparable conditions on the same machine?
5. Does every optimization survive the existing deterministic correctness and fault-testing suite?

Every number in the result tables below is generated from the raw trial records by
`node tools/raft-bench-report.js --doc CLOUDPROOF-PHASE-IV-A.md`. Nothing is copied by hand.

## Status

<!-- BEGIN GENERATED:status -->
_Baseline recorded at harness commit `35c8169` (clean tree) and committed as immutable history in
`artifacts/perf/phase-iv-a/{baseline-environment.json, baseline/, profiles/baseline/, baseline-report/}`.
Optimization sweeps pending._
<!-- END GENERATED:status -->

## 1. Environment (Step 0)

The benchmark machine is recorded by `node tools/raft-bench-env.js` into
[`artifacts/perf/phase-iv-a/baseline-environment.json`](artifacts/perf/phase-iv-a/baseline-environment.json)
before the baseline, and again at the end into
[`environment.json`](artifacts/perf/phase-iv-a/environment.json). Each sweep directory also carries the
environment at the moment it started. Captured fields: git SHA and dirty files, Node/V8/libuv versions, OS,
CPU model, physical and logical cores, RAM, data volume file system and disk, Docker availability, AC power
state and power plan, and the heaviest other processes on the machine.

Two properties of this machine matter for every result and are disclosed rather than hidden:

- **It is a Windows 11 laptop running NTFS on an NVMe SSD.** A 4 KiB append + `fsync` costs about 1–2 ms
  here, and the metadata file's write + `fsync` + rename about 2.5–4.5 ms. The deployment target is Linux
  (ext4/xfs), where those costs differ. Docker was not running, so all processes run natively.
- **It is not a quiet benchmark host.** Other interactive applications were open, and Microsoft Defender
  real-time protection was on. Every trial records whole-machine CPU load (`systemCpu`) so a noisy trial is
  visible, and every point is three independent repetitions on fresh clusters.

## 2. Benchmark methodology

The complete, pre-registered methodology is
[`artifacts/perf/phase-iv-a/methodology.json`](artifacts/perf/phase-iv-a/methodology.json). It was committed
before the first recorded baseline trial; any later change is listed under `amendments` with its reason.

**System under test.** Three voting replicas, each `node replica/index.js` (the container entrypoint), on
loopback, each with its own fresh data directory for every trial. Optimizations are selected with
environment variables, so every configuration is the same build.

**Durability contract (unchanged by every optimization).** A write is acknowledged only after it is
committed: stored durably (`fsync`) on a majority of voters, where every copy counted toward that majority is
durable. Group commit changes *when* the fsync happens, never *whether* an acknowledged entry was fsynced.

**Workload.** `PUT /kv/:key` with `{"value": <payload>}` → one Raft entry `{op: "set"}`. Payloads are 64 B,
1 KiB and 16 KiB of ASCII; keys cycle over 1 000 keys. Requests carry no `clientId/seqNo`, which matches etcd
`Put` semantics; the exactly-once path is measured separately (§7).

**Open-loop load, coordinated-omission free.** Arrivals are fixed in advance at constant spacing `1/rate`,
interleaved across four generator processes holding 128 keep-alive connections. Request *k* is intended to
arrive at `start + k/rate` regardless of what happened to request *k − 1*. Four timestamps are kept per
request — `scheduledAt`, `dispatchedAt`, `sentAt`, `completedAt` — and the headline latency is
`completedAt − scheduledAt`, so time a request spends queued in the client because every connection is busy
counts against the system. Service latency (`completedAt − sentAt`) is reported separately, next to it. A
request with no response 10 s after its intended arrival is abandoned and recorded at exactly 10 s. The
generator records its own lag (`dispatchedAt − scheduledAt`); a trial whose p99 lag exceeds 5 ms is flagged.
`packages/raft-bench/raft-bench.test.js` proves the property: a 400 ms server stall at 200 req/s charges
every one of the ~80 delayed arrivals, where a closed-loop client would record about four.

**Histograms.** A log-linear histogram in the HdrHistogram style (`replica/perf-histogram.js`): exact below
2 048 µs, at most 0.1 % relative error above, percentiles reported as the bucket's upper bound. Repetitions
merge by adding counts; no raw sample is discarded.

**Trials.** 5 s warmup (excluded: generators count only arrivals intended inside the window, and every
replica's `/perf` window is reset at its start), 20 s measurement window, up to 12 s drain, fresh cluster per
trial, three repetitions per point. Point latency is pooled over the merged histograms of all repetitions;
throughput and CPU are the mean with min/max. No trial is ever selected or discarded.

**Stability, knee, stopping.** A trial is *stable* iff OK completions reach ≥ 98 % of offered, errors plus
timeouts are ≤ 0.5 %, end-to-end p99 < 1 s, and the last fifth's median latency is ≤ 2× the first fifth's
(unless ≤ 20 ms). A point is stable when most of its repetitions are. The **knee** is the highest ladder rate
that is stable with every lower rate stable too; max stable throughput is the mean achieved throughput there.
A curve stops after two consecutive unstable rates or one rate below 50 % achieved. After the ladder,
0.5× and 0.8× the knee are run, so "p99 at 50 % / 80 % of saturation" is measured, not interpolated.

**Rate ladder** (identical for every configuration): 100, 200, 300, 500, 750, 1 000, 1 500, 2 000, 3 000,
4 000, 5 000, 6 000, 8 000, 10 000, 12 000, 15 000, 20 000, 25 000, 30 000, 40 000 writes/s.

**Instrumentation.** `replica/raft-perf.js` records per-stage timings on the write path using the host's
monotonic timer — never the Raft clock, so it cannot affect elections, leases or anything the simulator
replays (the simulator never constructs it, and a 60-seed fingerprint of the simulator is identical with and
without it). `replica/perf-service.js` adds process CPU, event-loop utilization, a setImmediate turnaround
probe (Windows timer granularity makes `monitorEventLoopDelay` report ~10 ms on an idle loop), memory, TCP
bytes per socket direction, and V8 CPU profiles on demand. It is mounted only with `RAFT_PERF=1`.

Stages recorded on the leader: `http.arrivalToAdmit` → `leader.admitToFirstSend` → `leader.admitToDurable`
(`log.encode`, `log.write`, `log.fsync`) → `rpc.appendEntriesRtt` (includes the follower's
`follower.append`) → `leader.admitToCommit` → `leader.commitToApply` (includes `meta.persist`) →
`http.admitToResponse` → `http.arrivalToFinish`.

### Reproducing

```bash
node tools/raft-bench-env.js --out artifacts/perf/phase-iv-a/baseline-environment.json
node tools/raft-bench.js --config baseline --rate 500 --duration 20s --warmup 5s --payload 1024 --clients 128
node tools/raft-bench-sweep.js --configs baseline --payloads 64,1024,16384 --repetitions 3 --out artifacts/perf/phase-iv-a/baseline \
  --rates 100,200,300,500,750,1000,1500,2000,3000,4000,5000,6000,8000,10000,12000,15000,20000,25000,30000,40000
node tools/raft-bench-sweep.js --configs baseline --payloads 64,1024,16384 --repetitions 3 --out artifacts/perf/phase-iv-a/baseline --fractions 0.5,0.8
node tools/raft-profile.js --config baseline --payload 1024 --rates <A>,<B>,<C> --labels A-sub-saturation,B-knee,C-overloaded --out artifacts/perf/phase-iv-a/profiles/baseline
node tools/raft-bench-report.js --doc CLOUDPROOF-PHASE-IV-A.md
```

### Amendment 1 (2026-10-03): the comparison design, frozen before any comparison data

Recorded in `methodology.json` under `amendments`, before the first comparison trial and before the
durability and transport gates. The baseline above was recorded under the original methodology and is not
re-analysed under this amendment. Exploratory, uncommitted runs of the optimized engine during development
are not reported anywhere.

- **Nine configurations**, each one `RAFT_PROFILE` on the same build: `baseline`, `group-commit`,
  `pipeline-only`, `batch-only`, `group-batch`, `group-batch-pipeline`, `optimized-http`, `optimized-binary`,
  `transport-only`. Because every optimization is an independent option, single optimizations are measured in
  isolation as well as stacked, so one that only helps on top of another, or one that hurts, is visible.
- **1 KiB is the primary comparison** (all nine configurations, five repetitions per point). 64 B and 16 KiB
  are payload sensitivity for `baseline`, `optimized-http` and `optimized-binary` (three repetitions).
- **Interleaved, deterministic order.** All curves climb the rate ladder together, one rung at a time. Within
  a rung, each round runs every active curve once, in the order of a row of a Williams Latin square: every
  configuration takes every position, and follows every other configuration, equally often. The order is a
  pure function of the frozen plan ([`comparison-plan.json`](artifacts/perf/phase-iv-a/comparison-plan.json),
  SHA-256 in the amendment) and of which curves the unchanged stop rule has retired. The sweep is
  `node tools/raft-bench-interleaved.js --plan artifacts/perf/phase-iv-a/comparison-plan.json --out artifacts/perf/phase-iv-a/comparison`.
- **A disk-state covariate on every trial.** Immediately before each trial, with nothing else of the benchmark
  running, a sentinel appends and fsyncs 1 100-byte records at 300/s for one second in its own file. Every
  trial records `medianFsyncMs`, `p95FsyncMs`, `p99FsyncMs`, `sampleCount` and
  `sampledImmediatelyBeforeTrial`, plus the same probe after the cluster stops. The trial's regime is the bin
  of the pre-trial median: **fast < 0.5 ms ≤ intermediate < 1.5 ms ≤ slow**. The edges sit in the gaps
  between every mode seen on this machine before the comparison: about 0.35 ms, 0.75–1.0 ms (the dominant
  mode on the day the plan was frozen,
  [`fsync-probe-2026-10-03.json`](artifacts/perf/phase-iv-a/fsync-probe-2026-10-03.json)) and 2–3.5 ms.
- **Analysis.** No trial is discarded or re-run because of its disk regime. The overall result uses the
  unchanged stability rule, knee and pooled percentiles over every trial. A sensitivity view regroups the same
  trials by regime: a regime knee (the highest rate whose regime trials are majority-stable, with every lower
  rate that has regime trials also stable), with gaps and trial counts, and throughput and p99 at the overall
  knee per regime. The per-trial covariate is in `trials.csv`, so the bins can be checked against the raw
  medians.
- **Gates before the sweep.** The sweep does not start until (a) a live failpoint test shows zero missing and
  zero duplicated acknowledged writes when the leader is killed inside each of six sensitive windows, and
  (b) a transport-isolation benchmark has measured the HTTP and framed transports outside Raft and the disk.

## 3. Baseline saturation

<!-- BEGIN GENERATED:knee-table -->
| configuration | payload | knee (offered/s) | max stable (achieved/s) | first unstable/s | peak achieved at any rate/s | p50 @knee ms | p99 @knee ms | p99.9 @knee ms |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 64 B | 300 | 300 | 500 | 580 | 44.00 | 95.61 | 103.49 |
| Baseline | 1024 B | 300 | 300 | 500 | 658 | 47.55 | 78.78 | 86.78 |
| Baseline | 16384 B | 300 | 297 | 500 | 442 | 10.16 | 748.54 | 874.50 |
<!-- END GENERATED:knee-table -->

The immutable baseline report — generated at `35c8169` from the 63 recorded trials and never regenerated
afterwards — is [`artifacts/perf/phase-iv-a/baseline-report/REPORT.md`](artifacts/perf/phase-iv-a/baseline-report/REPORT.md),
with its inputs, generator commit and hashes in
[`baseline-report/provenance.json`](artifacts/perf/phase-iv-a/baseline-report/provenance.json).
The tables in this section are regenerated from the same records whenever the report tool runs; the
`baseline-report/` copy is the one frozen before any optimized configuration was swept.

<!-- BEGIN GENERATED:comparison-1024 -->
| configuration | max stable ops/s | p99 @50% ms | p99 @80% ms | p99 @knee ms | leader CPU % @knee | CPU µs/op | fsync+meta per op | AE RPC per op | entries/AE | repl bytes/op |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 300 | 42.56 | 70.14 | 78.78 | 29 | 971 | 2.607 | 0.606 | 5.7 | 2,666 |
<!-- END GENERATED:comparison-1024 -->

### Where the baseline spends its time

<!-- BEGIN GENERATED:profile-table -->
| profile | offered/s | achieved/s | busy % of wall | fs-sync-io | axios | express | node-http | streams-net | json | console-logging | raft-engine | raft-log-store | raft-transport | state-machine | gc | instrumentation |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline 1024 B A-sub-saturation | 150 | 150 | 38.5 | 55.0 | 10.9 | 3.1 | 6.8 | 7.9 | 0.3 | 2.6 | 3.2 | 0.5 | 0.0 | 0.5 | 0.8 | 0.7 |
| baseline 1024 B B-knee | 300 | 300 | 63.4 | 61.6 | 8.6 | 3.5 | 5.3 | 7.0 | 0.3 | 2.1 | 3.4 | 0.7 | 0.0 | 0.5 | 0.5 | 0.3 |
| baseline 1024 B C-overloaded | 500 | 494 | 98.0 | 87.4 | 1.0 | 2.3 | 1.1 | 1.8 | 0.0 | 1.8 | 1.3 | 0.6 | 0.0 | 0.2 | 0.1 | 0.2 |

Category columns are percent of *busy* (non-idle) sampled time on the leader.
<!-- END GENERATED:profile-table -->

The leader saturates on synchronous durability, not on CPU. Every write performs a log append + `fsync`, and
every commit-index advance rewrites the metadata file (write + `fsync` + rename), so the cluster performs
between two and three fsync-class operations per committed write (the `fsync+meta per op` column). These run
on the event loop: in the CPU profiles `fs-sync-io` is already the largest category at half the knee and
dominates the overloaded point, while process CPU stays well below one core and event-loop utilization
approaches 1. The loop is blocked waiting for the disk, not computing.

### Disclosed limitation: two storage regimes

Repetitions of the same point are not exchangeable. At a fixed offered rate, some repetitions run with a
median end-to-end latency of a few milliseconds and others an order of magnitude higher; a few repetitions
above the knee were even stable. The knee is a majority-of-repetitions result and is reported as such. A bare
fsync probe on this machine (outside Raft, added with the methodology amendment) later showed the drive
itself alternates between a fast and a slow fsync regime, which is the most likely cause. The baseline sweep did not record a disk-state covariate,
so its trials cannot be assigned to a regime after the fact. Every later sweep samples one immediately before
each trial (see the methodology amendments).

## 4. Optimizations under test

Every optimization is an independent `RaftNode` option and is **off by default**: with no options the engine
takes exactly the code paths of the baseline measured above, and a 60-seed simulator fingerprint of the
default engine is unchanged. Named combinations live in [`replica/raft-profiles.js`](replica/raft-profiles.js). The
same profile drives the live replica (`RAFT_PROFILE=<name>`) and the deterministic simulator
(`raftProfile` in a schedule, `--raft-profile` on the search CLI), so the configuration that is benchmarked
is the configuration that is fault-tested.

- **Group commit** (`groupCommit`, §5): one write + `fsync` for everything appended in an event-loop turn,
  and a lazily persisted commit index.
- **Pipelined replication** (`pipeline`, §6): up to `maxInflight` AppendEntries outstanding per follower.
- **Bounded batches with a coalesced trigger** (`replicationBatch`): one AppendEntries carries at most
  `maxEntries` entries and about `maxBytes` of encoded entries (always at least one, so an oversized entry
  still moves), in both the stop-and-wait and the pipelined path. With `coalesce`, client writes that arrive
  in the same event-loop turn share one replication round, scheduled before that turn's group-commit flush,
  instead of starting one round per write. Each entry is JSON-encoded at most once per process
  ([`replica/entry-codec.js`](replica/entry-codec.js)); the log record and every follower's request reuse
  the same text. Batching only changes how entries are grouped into requests, never which entries a request
  carries or the consistency check, so it needs no new safety argument; `replica/batching.test.js` checks the
  bounds, coalescing, catch-up and conflict repair under both replication paths.
- **Framed binary TCP transport** (`wire: 'framed-tcp'`, `RAFT_TRANSPORT=tcp`): the three Raft RPCs move off
  HTTP/1.1 + JSON (axios → express) onto one persistent, multiplexed TCP connection per peer on
  `PORT + 1000`, framed as in [`replica/raft-codec.js`](replica/raft-codec.js). AppendEntries and its
  response use fixed-width fields; entries travel as length-prefixed JSON taken from the entry cache, and the
  follower primes its cache with the received text. Client-facing endpoints stay HTTP. The transport changes
  delivery, not semantics: a request either arrives whole or fails as a timeout or connection error, which the
  engine already handles. In the simulator the same profile routes every RPC through the codec
  ([`sim/wire-codec.js`](sim/wire-codec.js)), so every searched schedule round-trips through the binary format.
- **Per-write log lines** (`logHotPath`, `RAFT_LOG_HOT_PATH=0`): the leader's two synchronous stdout lines per
  client write ("Entry persisted/appended", "Commit advanced") can be turned off. They are on by default, as
  in the baseline; elections, step-downs and membership changes are always logged. This is not a consensus
  change. It is listed because the per-write logging is part of the leader's measured CPU cost.

## 5. Group commit: design and durability argument

**What changes.** With group commit on, `_appendToLog` encodes entries into the log store's buffer
(`LogStore.appendBuffered`) and schedules a flush at the end of the current event-loop turn
(`maxDelayMs: 0`), after a bounded delay, or immediately once `maxEntries` are waiting. The flush is one
`writeSync` + one `fsyncSync` for every buffered record, in append order. The commit index, which Raft keeps
in volatile state and which the replica persists only so a restart can replay its committed prefix
promptly, is written at most once per `metaIntervalMs` instead of with a write + `fsync` + rename on every
advance. Term and vote still persist synchronously, and carry the latest commit index with them.

**What does not change.** A write is acknowledged to its client only after it is committed, and an entry
is committed only when a majority of voters hold it *durably*. Three rules enforce that:

1. *A follower never acknowledges a volatile entry.* Its successful AppendEntries response is prepared when
   the RPC is processed but released only when every entry it acknowledges (through `matchIndex`) is
   flushed. Heartbeats are held the same way, because a heartbeat's `prevLogIndex` can name an entry the
   follower has appended but not yet flushed.
2. *A prepared acknowledgement is re-validated when it is released.* If the term moved on, or the log was
   truncated in between (tracked by a log epoch), the "success" describes a log the follower no longer has.
   It is replaced by a rejection that carries the current term, so a deposed leader can never count an entry
   that has since been overwritten.
3. *The leader counts its own copy only once it is durable* (Raft thesis §10.2.1). The leader may send an
   entry to followers before its own `fsync` finishes, which is what hides the leader's disk latency behind
   replication, but `_advanceCommitIndex` counts the leader toward the majority only for indexes below its
   durable length.

A lagging persisted commit index is always safe: a restarted node replays a shorter committed prefix, and
the leader supplies the rest. A crash (`stop()`) deliberately does **not** flush; only graceful shutdown
(`flushDurable()`) does. The simulator models the crash by dropping a node's unflushed buffer, exactly as a
real crash loses a write that was never fsynced.

**Tests.** [`replica/group-commit.test.js`](replica/group-commit.test.js) covers each rule: no ack before
durability; a crash before the grouped flush loses only unacknowledged entries; a crash after the flush
keeps them; an ack prepared in one term is revoked after a term change; a heartbeat naming a buffered index
is held; truncation with a pending buffer writes the retained prefix durably; the leader counts itself only
once durable; appends in one turn share one `fsync` on the real `LogStore`; a lagging persisted commit
index loses nothing on restart; and group commit off keeps the original synchronous contract. The
`group-commit-delay` simulator profile (an 8 ms flush window and a 4-entry cap, strictly more adversarial
than the benchmarked setting) runs through the materialized schedule search.

## 6. Pipelined replication: design and safety argument

**What changes.** The baseline keeps exactly one AppendEntries outstanding per follower and sends the next
only after the previous returns. With `pipeline: { maxInflight }`, each follower has a progress record in one
of two modes. In *probe* mode at most one request is outstanding; that is where every follower starts, and
where it returns after any rejection or error. One success proves where the follower's log matches, and
moves it to *replicate* mode: up to `maxInflight` requests outstanding, each carrying the next unsent
entries, with `nextIndex` advanced optimistically as they are sent. Pipelining alone does not bound a
request's size. Without batching, each send carries everything from `nextIndex` to the end of the log.

**Why it is safe.** The follower side is unchanged: the AppendEntries consistency check is idempotent, so a
duplicated, reordered or retransmitted request is either applied (no-op when already present) or rejected.
On the leader:

1. *`matchIndex` only grows.* It is raised only by a success, to the index the follower itself reports, and a
   late or reordered success can only confirm more. `nextIndex` is never set below `matchIndex + 1`.
2. *A rejection is acted on only if it still matters.* A rejection for a point at or below the follower's
   current `matchIndex` (a request that lost a race the follower has since won) is ignored. Otherwise
   `nextIndex` backs off using the follower's conflict hint, and the follower drops to probe mode.
   Outstanding requests stay outstanding but no longer occupy the window.
3. *Every request is fenced by a leadership epoch.* The epoch is bumped whenever this node gains or loses
   leadership, so a response to a request sent under an earlier leadership never moves the current one's
   progress, even within the same term.
4. *The commit rule is unchanged.* `_advanceCommitIndex` still commits only entries of the current term by
   counting (Raft Figure 8), so pipelined acknowledgements of an older-term entry cannot commit it alone.
5. *Lease freshness uses send time.* An acknowledgement proves the follower accepted this leader no earlier
   than when the request was *sent*. The leader's quorum-contact time is therefore the send time of the
   newest request a quorum has answered, never the arrival time.

An RPC error drops the follower to probing from `matchIndex + 1`, and resending waits for the next
heartbeat rather than spinning against an unreachable peer.

**Tests.** [`replica/pipeline.test.js`](replica/pipeline.test.js) drives a real three-node cluster over a
hand-delivered network ([`sim/manual-network.js`](sim/manual-network.js)), so reordering, duplication, loss
and late replies are explicit test steps. It covers: window size and optimistic `nextIndex`, reordered acks,
a request that overtakes its predecessor, a stale rejection, conflict repair through probing, fencing across
a leadership change, idempotent retransmission, Figure 8, an RPC error, and lease freshness.

## 7. Acknowledged-write durability under leader death (publication gate)

Run by [`tools/raft-durability-gate.js`](tools/raft-durability-gate.js) at `d58d6b9` (clean tree);
raw records in [`durability-gate/results.json`](artifacts/perf/phase-iv-a/durability-gate/results.json). For each
window, five fresh live clusters. Under closed-loop load of unique 1 KiB writes, a test-only failpoint
([`replica/failpoints.js`](replica/failpoints.js)) armed on the current leader terminates it inside the named window, and
writes a marker with its Raft state at that instant. Load continues on the new leader. The dead node then restarts
from its own data directory, the cluster converges, and every node's committed log and state machine are checked.
Every write carries `clientId` + `seqNo`. Half the client lanes retry an in-doubt attempt (timeout, reset, 503)
with the same id against the new leader, the exactly-once path, which is where duplicates would come from. The
other half never retry an in-doubt attempt, so those writes stay unacknowledged, and whether they were committed
anyway is counted.

<!-- BEGIN GENERATED:durability-gate -->
| window | profile | runs (kills in window) | acknowledged | recovered acknowledged | missing acknowledged | duplicate logical writes | in-doubt retried → acked once | unacknowledged recovered / unacknowledged | committed prefixes identical | pass |
|---|---|---:|---:|---:|---:|---:|---:|---:|:---:|:---:|
| before group flush | group-commit | 5 (5) | 28710 | 28710 | 0 | 0 | 60 | 26 / 60 | yes | PASS |
| after flush / before quorum | group-commit | 5 (5) | 21692 | 21692 | 0 | 0 | 60 | 17 / 60 | yes | PASS |
| after commit / before client reply | optimized-http | 5 (5) | 13123 | 13123 | 0 | 0 | 60 | 33 / 60 | yes | PASS |
| during pipelined replication | group-pipeline | 5 (5) | 9955 | 9955 | 0 | 0 | 60 | 39 / 60 | yes | PASS |
| during batched replication | group-batch | 5 (5) | 15705 | 15705 | 0 | 0 | 60 | 24 / 59 | yes | PASS |
| binary transport active | optimized-binary | 5 (5) | 16472 | 16472 | 0 | 0 | 60 | 33 / 60 | yes | PASS |
<!-- END GENERATED:durability-gate -->

**Gate: missing acknowledged writes = 0 and duplicate logical writes = 0 in every window. It passed.** Every kill
landed inside its window, as the markers show: for example, buffered entries pending at `leader.beforeFlush`,
seven requests still in flight at `leader.pipelinedInflight`, and an 11-entry batch answered at
`leader.batchedReplication`. "Unacknowledged recovered" counts writes whose client never got an answer but which
were committed. That is legitimate (the client cannot tell), and it is largest where expected: after commit and
before the reply.

**The gate found a liveness bug, and it is fixed** (`d58d6b9`). In its first run, the pipelined window's
restarted node never caught up. The new leader had never matched it (`matchIndex = -1`), and every failed probe
rewound `nextIndex` to `matchIndex + 1 = 0`, so the next probe carried the whole log (about 3.4 MB). Without
bounded batches that exceeds the follower's 2 MB request limit and the 450 ms RPC timeout, so the probe failed
forever. A failed pipelined request now resends from its own start. The stop-and-wait path never rewound.
A regression test reproduces the old behaviour.

**Scope and remaining limits.** A process kill loses what the leader had not yet written; it does not lose data the
operating system already held, so this gate cannot detect a missing `fsync`. Power loss is covered by the
deterministic simulator's targeted campaign (`sim/perf-faults.js`), which drops every node's unflushed data at
once. Without bounded batches (`baseline`, `pipeline-only`, `group-pipeline`), a follower more than about 2 MB
behind cannot be caught up in one AppendEntries; this limit predates Phase IV-A, and bounded batches remove it.

## 8. Disclosed environment finding: Windows power throttling

Found while validating the transport benchmark, and recorded before any comparison trial. On the benchmark laptop,
Windows 11 throttles every busy process that has no foreground window about **three seconds** after it gets busy,
and keeps it throttled for the rest of its life: the clock drops, and an unpinned process moves to efficiency cores.
Every replica and load generator the harness starts is such a process. The probe
([`power-throttling-probe.json`](artifacts/perf/phase-iv-a/power-throttling-probe.json)) is a pure SHA-256 loop
with no I/O, measured per 500 ms over 8 s:

| condition | first 2.5 s (hashes / 500 ms) | after 3.5 s (hashes / 500 ms) | slowdown |
|---|---:|---:|---:|
| Windows default | 357,440 | 83,875 | 4.3x |
| pinned to P-core (logical CPU 2) | 309,240 | 100,000 | 3.1x |
| pinned to E-core (logical CPU 23) | 169,400 | 81,950 | 2.1x |
| high process priority | 368,920 | 88,675 | 4.2x |
| power throttling opted out | 354,360 | 384,200 | 0.9x |

In an unrecorded spot check, two processes started 1.5 s apart dropped 1.5 s apart, which points to a per-process
mechanism rather than a package power limit (the machine was on AC power, Balanced plan). Opting the process out with `SetProcessInformation(ProcessPowerThrottling)`
(`EXECUTION_SPEED` controlled and off, the per-process switch behind Task Manager's *Efficiency mode*) removes the
cliff entirely. That changes no system setting and affects only the processes it is applied to
([`packages/raft-bench/power-throttling.js`](packages/raft-bench/power-throttling.js)).

**Consequences.** The committed baseline (`d5d7e00`) ran under Windows' default, throttled after the first seconds
of each trial. It stays the historical record and is not re-labelled. It was disk-bound, so throttling mostly
inflates its CPU figures rather than moving its knee, but that is an expectation, not a measurement. A configuration
that saturates on CPU is hit by the throttle far harder than one that saturates on `fsync`, so a comparison run
under the default would partly measure Windows' background scheduling. How the comparison sweep treats it is an
open decision, to be recorded as methodology amendment 2 before the first comparison trial.

## 9. Transport isolation

[`tools/raft-transport-bench.js`](tools/raft-transport-bench.js): AppendEntries of 1 KiB entries, closed loop, between
two fresh processes, with no Raft engine, log or `fsync`. Per trial, *burst* is the first 2 s of load and
*sustained* is a 10 s window after a 5 s warmup; three interleaved repetitions. Transports: `http-plain` (Node's
http client and server, no libraries), `http-json` (axios → express, exactly the replica's default path),
`framed-json` (the framed transport's connection, JSON-encoded body), and `framed-binary` (the transport as the
replica uses it). CPU is µs per message on each side; wire bytes are counted on the server's sockets.

**With power throttling off** (the transport's own cost; 36e1a19, checks: zeroErrors pass, littlesLaw pass, persistentConnections pass, binaryWireBytesMatchFrames pass):

| transport | entries/msg | in flight | burst msg/s (first 2 s) | sustained msg/s | sustained entries/s | p50 RTT ms | p99 RTT ms | client CPU µs/msg | server CPU µs/msg | client CPU % | server CPU % | wire bytes/msg | connections | Little ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| http-plain | 1 | 1 | 10,218 | 11,613 | 11,613 | 0.070 | 0.207 | 60 | 36 | 70 | 42 | 1,585 | 1 | 1.00 |
| http-json | 1 | 1 | 3,592 | 4,745 | 4,745 | 0.184 | 0.452 | 169 | 68 | 80 | 32 | 1,778 | 1 | 1.00 |
| framed-json | 1 | 1 | 20,757 | 22,393 | 22,393 | 0.039 | 0.115 | 27 | 22 | 61 | 49 | 1,329 | 1 | 1.00 |
| framed-binary | 1 | 1 | 21,522 | 22,943 | 22,943 | 0.038 | 0.106 | 25 | 24 | 58 | 55 | 1,257 | 1 | 1.00 |
| http-plain | 1 | 8 | 24,669 | 26,246 | 26,246 | 0.287 | 0.587 | 38 | 28 | 100 | 74 | 1,586 | 8 | 1.00 |
| http-json | 1 | 8 | 6,935 | 8,616 | 8,616 | 0.839 | 3.067 | 127 | 59 | 109 | 51 | 1,779 | 8 | 1.00 |
| framed-json | 1 | 8 | 76,385 | 78,792 | 78,792 | 0.091 | 0.267 | 14 | 12 | 110 | 92 | 1,330 | 1 | 1.00 |
| framed-binary | 1 | 8 | 75,395 | 77,988 | 77,988 | 0.091 | 0.266 | 14 | 12 | 105 | 95 | 1,257 | 1 | 1.00 |
| http-plain | 16 | 1 | 6,509 | 7,502 | 120,025 | 0.115 | 0.306 | 90 | 59 | 67 | 44 | 18,252 | 1 | 1.00 |
| http-json | 16 | 1 | 2,736 | 3,569 | 57,102 | 0.249 | 0.592 | 222 | 94 | 79 | 34 | 18,445 | 1 | 1.00 |
| framed-json | 16 | 1 | 10,625 | 11,129 | 178,067 | 0.078 | 0.247 | 71 | 40 | 78 | 45 | 17,995 | 1 | 1.00 |
| framed-binary | 16 | 1 | 9,237 | 10,483 | 167,725 | 0.079 | 0.268 | 59 | 58 | 62 | 60 | 17,965 | 1 | 1.00 |
| http-plain | 16 | 8 | 15,302 | 16,274 | 260,385 | 0.460 | 1.068 | 62 | 48 | 100 | 78 | 18,254 | 8 | 1.00 |
| http-json | 16 | 8 | 5,383 | 6,603 | 105,644 | 1.093 | 3.794 | 174 | 84 | 115 | 56 | 18,449 | 8 | 1.00 |
| framed-json | 16 | 8 | 21,538 | 22,072 | 353,144 | 0.320 | 1.549 | 53 | 35 | 117 | 78 | 17,996 | 1 | 1.00 |
| framed-binary | 16 | 8 | 19,581 | 22,809 | 364,941 | 0.291 | 1.528 | 39 | 42 | 89 | 96 | 17,965 | 1 | 1.00 |

**Under Windows' default** (same build; checks: zeroErrors pass, littlesLaw pass, persistentConnections pass, binaryWireBytesMatchFrames pass):

| transport | entries/msg | in flight | burst msg/s (first 2 s) | sustained msg/s | sustained entries/s | p50 RTT ms | p99 RTT ms | client CPU µs/msg | server CPU µs/msg | client CPU % | server CPU % | wire bytes/msg | connections | Little ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| http-plain | 1 | 1 | 9,504 | 1,694 | 1,694 | 0.548 | 1.119 | 366 | 215 | 62 | 36 | 1,583 | 1 | 1.00 |
| http-json | 1 | 1 | 3,376 | 783 | 783 | 1.229 | 1.951 | 907 | 402 | 71 | 32 | 1,778 | 1 | 1.00 |
| framed-json | 1 | 1 | 21,145 | 3,401 | 3,401 | 0.266 | 0.610 | 167 | 132 | 57 | 45 | 1,326 | 1 | 1.00 |
| framed-binary | 1 | 1 | 20,694 | 3,405 | 3,405 | 0.265 | 0.622 | 151 | 140 | 51 | 48 | 1,257 | 1 | 1.00 |
| http-plain | 1 | 8 | 24,503 | 2,865 | 2,865 | 2.337 | 11.492 | 297 | 216 | 85 | 62 | 1,584 | 8 | 1.00 |
| http-json | 1 | 8 | 6,977 | 1,010 | 1,010 | 6.846 | 25.834 | 899 | 427 | 91 | 43 | 1,779 | 8 | 1.00 |
| framed-json | 1 | 8 | 74,496 | 10,049 | 10,049 | 0.628 | 2.342 | 90 | 82 | 91 | 82 | 1,329 | 1 | 1.00 |
| framed-binary | 1 | 8 | 74,708 | 10,469 | 10,469 | 0.576 | 2.246 | 84 | 77 | 88 | 80 | 1,257 | 1 | 1.00 |
| http-plain | 16 | 1 | 5,403 | 1,216 | 19,449 | 0.783 | 1.518 | 496 | 304 | 60 | 37 | 18,251 | 1 | 1.00 |
| http-json | 16 | 1 | 2,778 | 651 | 10,421 | 1.480 | 2.511 | 1202 | 577 | 78 | 38 | 18,448 | 1 | 1.00 |
| framed-json | 16 | 1 | 10,293 | 1,858 | 29,734 | 0.480 | 1.287 | 341 | 207 | 63 | 39 | 17,993 | 1 | 1.00 |
| framed-binary | 16 | 1 | 8,653 | 1,700 | 27,201 | 0.515 | 1.426 | 306 | 291 | 52 | 49 | 17,969 | 1 | 1.00 |
| http-plain | 16 | 8 | 14,516 | 1,712 | 27,395 | 3.806 | 18.007 | 460 | 315 | 79 | 54 | 18,259 | 8 | 1.00 |
| http-json | 16 | 8 | 5,704 | 874 | 13,977 | 7.982 | 28.324 | 1052 | 519 | 92 | 45 | 18,465 | 8 | 1.00 |
| framed-json | 16 | 8 | 21,995 | 3,200 | 51,200 | 2.121 | 7.926 | 247 | 195 | 79 | 62 | 18,001 | 1 | 1.00 |
| framed-binary | 16 | 8 | 19,016 | 3,499 | 55,991 | 1.771 | 9.028 | 231 | 225 | 80 | 79 | 17,969 | 1 | 1.00 |

**Reading.** In isolation the framed binary transport moves unbatched AppendEntries at
77,988 messages/s against 8,616 for the replica's HTTP/JSON path
(9.1x), at 14 µs of sender CPU
per message against 127. The binary encoding contributes little: `framed-json`, the
same connection with a JSON body, reaches 78,792 messages/s. Neither is HTTP itself the main cost:
Node's bare http client and server reach 26,246 messages/s, so most of the replica's HTTP
path cost is the axios client and the express stack on top of it. With 16-entry batches the framed/HTTP-JSON gap
narrows to 3.5x, because per-message overhead is amortized. Under
Windows' default throttling every transport runs several times slower in its sustained phase, and its burst phase
is close to the opted-out figures, which is the throttling cliff of §8 seen again from the transport side. Whether this
ceiling matters end to end is what the comparison sweep has to show: the replica's per-write path also includes the
client-facing HTTP request, the log and `fsync`, and the engine itself.
