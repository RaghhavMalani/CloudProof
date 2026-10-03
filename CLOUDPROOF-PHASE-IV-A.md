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
