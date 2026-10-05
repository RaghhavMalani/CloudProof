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
_Phase IV-A (CloudProof side) complete: historical baseline (`d5d7e00`), optimizations, durability gates, the
Windows-default control, the interleaved comparison (801 trials, §11), leader profiles and a green final regression
(§12). Not yet run: etcd._
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

### Amendment 2 (2026-10-03): one verified process power policy

Recorded in `methodology.json` before the opt-out verification, the Windows-default control and any comparison
trial. Windows 11 throttles busy background processes about 3 s after they become busy (§8), which affects the
replicas and load generators and hurts CPU-bound configurations far more than the fsync-bound baseline. Therefore:

- **Primary comparison.** Every replica, load generator and the sweep driver, in every trial of all nine
  configurations, baseline included, opts out of per-process power throttling. The remeasured interleaved baseline
  is the comparator for every effect size. **No system-wide setting is changed**, including the power plan.
- **Verified, or the run stops.** Every trial records `powerThrottling`: requested policy, platform, mechanism, the
  SHA-256 of the helper code, and each process's mask as Windows reports it. A process that cannot be verified stops
  the run, so a mixed environment cannot enter the data.
- **Historical baseline.** `d5d7e00` is preserved exactly and is labelled *historical baseline under Windows' default
  process power policy*. It is never the denominator of a speedup; speedups come only from the matched final
  experiment.
- **Control.** A small paired experiment ([`windows-power-control/plan.json`](artifacts/perf/phase-iv-a/windows-power-control/plan.json)):
  baseline and optimized-binary at 1 KiB and 100/300/1000/2500 writes/s, under both policies, interleaved. It
  quantifies the policy's effect. It is environment analysis, not part of the ranking, and no profile is retuned
  after it.

### Amendment 3 (2026-10-05): interruption for thermal load, resumption in blocks

An operational note; the plan, the harness and the analysis are unchanged. The comparison sweep was interrupted after
367 completed trials because sustained execution materially heated the benchmark host. Completed trials were
retained, and `trials.jsonl` is hashed in the amendment at the moment of interruption. The machine is allowed to
return to a stable thermal state, and the remaining predetermined order is resumed from the same pinned worktree
without rerunning any completed observation. The remainder may run in cool-down blocks, each stopped at a trial
boundary. Thermal state is a third environmental variable, after the disk regime (recorded) and the process power
policy (controlled). It is observed, not controlled: a separate read-only sampler logs processor frequency, %
performance, % performance limit and utilization next to each resumed block. CPU temperature is not exposed on this
machine without elevation and is not recorded. The telemetry is descriptive and never decides which trials count.

### Amendment 4 (2026-10-05): the matched etcd comparison, frozen before any etcd data

Question 4 is answered by a new interleaved sweep of four 1 KiB curves, five repetitions each:

- CloudProof `baseline`, `optimized-http` and `optimized-binary`, re-measured;
- stock etcd v3.7.2 with three members.

The plan is [`etcd-plan.json`](artifacts/perf/phase-iv-a/etcd-plan.json), SHA-256 `2f01e8cc…`, with output in
`etcd/`. CloudProof is re-measured because the harness fixes `d100c2e` and `f5456a9` came after the 801-trial sweep:
etcd is never compared against numbers from the earlier harness.

The trials are matched in everything except the system under test: the open-loop generator, rate ladder, windows,
stability and stop rules, knee fractions, Williams order, disk sentinel, power-policy opt-out for every process,
drive and loopback topology. etcd is the official release, with the archive checksum verified against the release's
`SHA256SUMS` and GitHub's asset digest before extraction. Nothing is installed system-wide, and the harness refuses
any `etcd.exe` but the pinned one. Every etcd flag is at its default except the cluster topology. Clients use etcd's
HTTP/JSON gateway (`POST /v3/kv/put`, base64 key and value).

etcd telemetry comes from each member's `/metrics`, differenced over the window. The mapping is:

| quantity | etcd | CloudProof |
|---|---|---|
| CPU | process CPU | process CPU |
| log syncs | WAL fsyncs | log fsyncs |
| state syncs | bbolt commits | metadata saves |
| other syncs | snapshot fsyncs | none |
| replication bytes | raft message bytes on peer links | TCP payload bytes |

A quantity etcd does not export (AppendEntries, event loop, stage histograms) is recorded as null. Payload
sensitivity for etcd is not measured; that was the user's decision, and it is disclosed.

The mismatches recorded in the amendment are:

- Go against Node;
- grpc-gateway and rafthttp against express and HTTP/framed TCP;
- WAL and bbolt MVCC against a line log and an in-memory state machine;
- when state reaches disk;
- built-in proposal batching;
- base64 request bodies;
- other applications left running on the host.

The run uses amendment 3's cool-down blocks of about 60 minutes.

## 3. Historical baseline — Windows default process power policy

_Recorded at `35c8169` under Windows' default process power policy, before power throttling was identified (§8).
It is preserved exactly as recorded. The primary comparison remeasures baseline, interleaved, with power throttling
disabled (amendment 2); speedups are computed only from that matched experiment._

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
of each trial. It stays the historical record, labelled as such. A configuration that saturates on CPU is hit by the
throttle far harder than one that saturates on `fsync`, so a comparison run under the default would partly measure
Windows' background scheduling. Amendment 2 therefore puts every benchmark-owned process of the comparison under
one verified policy, throttling disabled, and adds a small paired control to measure the policy's effect.

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

## 10. Windows-default power-policy control (environment analysis)

The control from amendment 2 ([`windows-power-control/`](artifacts/perf/phase-iv-a/windows-power-control/REPORT.md)).
It ran baseline and optimized-binary at 1 KiB and 100, 300, 1,000 and 2,500 writes/s, under Windows' default process
policy and with throttling disabled, with all four arms interleaved: 3 repetitions, 48 trials. Run at
`1b55e36`. It is not part of the optimization ranking. Every process of every trial was verified in
its requested state: system-managed in the default arm, opted out in the other.

| config | policy | offered/s | stable | achieved/s | p50 ms | p99 ms | leader CPU % | CPU µs/op | ELU | loop lag p99 ms | send lag p99 ms | client queue p99 ms | disk regimes |
|---|---|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| baseline | os-default | 100 | 3/3 | 100 | 13.87 | 29.86 | 51 | 5128 | 0.65 | 7.40 | 0.67 | 0.96 | intermediate 1, fast 2 |
| baseline | disabled | 100 | 3/3 | 100 | 4.00 | 13.69 | 19 | 1875 | 0.25 | 0.30 | 0.04 | 0.20 | fast 2, intermediate 1 |
| baseline | os-default | 300 | 3/3 | 303 | 64.80 | 508.93 | 60 | 1975 | 1.00 | 122.07 | 0.49 | 36.67 | fast 1, slow 2 |
| baseline | disabled | 300 | 3/3 | 300 | 7.12 | 147.33 | 31 | 1050 | 0.75 | 28.74 | 0.05 | 0.14 | intermediate 1, fast 1, slow 1 |
| baseline | os-default | 1,000 | 0/3 | 363 | 9338.88 | 10002.43 | 55 | 1863 | 1.00 | 169.45 | 13.32 | 9912.32 | intermediate 1, fast 1, slow 1 |
| baseline | disabled | 1,000 | 0/3 | 905 | 15.45 | 9781.25 | 42 | 476 | 1.00 | 110.68 | 0.06 | 7193.94 | fast 2, slow 1 |
| baseline | os-default | 2,500 | 0/3 | 80 | 9904.13 | 10002.43 | 77 | 3257 | 1.00 | 96.00 | 29.76 | 10002.43 | fast 1, slow 2 |
| baseline | disabled | 2,500 | 0/3 | 1,479 | 8404.99 | 10002.43 | 44 | 312 | 1.00 | 33.75 | 0.76 | 9961.47 | slow 3 |
| optimized-binary | os-default | 100 | 3/3 | 100 | 3.79 | 8.37 | 25 | 2513 | 0.34 | 1.98 | 0.40 | 0.80 | intermediate 1, fast 2 |
| optimized-binary | disabled | 100 | 3/3 | 100 | 1.46 | 2.77 | 10 | 961 | 0.12 | 0.37 | 0.04 | 0.21 | fast 2, intermediate 1 |
| optimized-binary | os-default | 300 | 3/3 | 300 | 8.96 | 21.28 | 50 | 1667 | 0.92 | 6.88 | 0.45 | 0.55 | slow 2, fast 1 |
| optimized-binary | disabled | 300 | 3/3 | 300 | 1.16 | 2.17 | 18 | 586 | 0.26 | 0.23 | 0.03 | 0.13 | intermediate 3 |
| optimized-binary | os-default | 1,000 | 3/3 | 1,000 | 13.56 | 30.80 | 72 | 715 | 1.00 | 12.78 | 0.52 | 0.37 | slow 2, fast 1 |
| optimized-binary | disabled | 1,000 | 3/3 | 1,000 | 1.03 | 11.46 | 42 | 416 | 0.76 | 0.72 | 0.04 | 0.10 | slow 1, intermediate 2 |
| optimized-binary | os-default | 2,500 | 0/3 | 2,183 | 2736.13 | 5046.27 | 90 | 411 | 0.99 | 40.59 | 1.45 | 4568.40 | slow 3 |
| optimized-binary | disabled | 2,500 | 3/3 | 2,501 | 8.54 | 16.48 | 42 | 166 | 1.00 | 5.79 | 0.10 | 0.10 | slow 2, intermediate 1 |

**Policy effect** (ratios of the arms above):

| config | offered/s | achieved: disabled ÷ default | p99: default ÷ disabled | leader CPU µs/op: default ÷ disabled | loop lag p99: default ÷ disabled | stable (default / disabled) |
|---|---:|---:|---:|---:|---:|---|
| baseline | 100 | 1.00 | 2.18 | 2.73 | 24.72 | 3/3 / 3/3 |
| baseline | 300 | 0.99 | 3.45 | 1.88 | 4.25 | 3/3 / 3/3 |
| baseline | 1,000 | 2.49 | 1.02 | 3.91 | 1.53 | 0/3 / 0/3 |
| baseline | 2,500 | 18.47 | 1.00 | 10.45 | 2.84 | 0/3 / 0/3 |
| optimized-binary | 100 | 1.00 | 3.02 | 2.62 | 5.35 | 3/3 / 3/3 |
| optimized-binary | 300 | 1.00 | 9.79 | 2.84 | 30.32 | 3/3 / 3/3 |
| optimized-binary | 1,000 | 1.00 | 2.69 | 1.72 | 17.85 | 3/3 / 3/3 |
| optimized-binary | 2,500 | 1.15 | 306.22 | 2.48 | 7.01 | 0/3 / 3/3 |

**Reading.**

- **Below the knee** (100 and 300/s), both arms carry the offered load (open loop). The default policy costs latency and
  CPU: baseline p99 is 2.2–3.5x higher and optimized-binary
  3.0–9.8x. Leader CPU per operation is
  1.9–2.7x (baseline) and 2.6–2.8x
  (optimized-binary) higher, and leader event-loop lag up to 30x.
- **The policy alone moves the optimized engine's saturation point.** At 2,500/s optimized-binary is stable in
  3/3 repetitions with throttling disabled (p99 16.5 ms). It is stable in
  0/3 under the default (achieved 2,183/s, p99 5.0 s).
- **The fsync-bound baseline is less sensitive.** Its knee on this grid is 300/s in both arms, and it is unstable at
  1,000/s and above in both. Disabling throttling raised its overloaded throughput at 1,000/s
  (905 vs 363/s) without making it stable.
- **Consequence.** Comparing the historical, throttled baseline with an unthrottled optimized system would overstate
  the optimizations. That is why the primary comparison holds the policy fixed (amendment 2).
- **Recorded failures.** Two of the 48 trials (baseline, Windows default, 2,500/s, about 8x that arm's knee) are
  recorded as failed: the harness could not reach the saturated leader to collect its window. The replicas were
  healthy. The harness now retries those post-window requests and records the retries (`659c649`). Disk regimes
  varied across trials and are listed per row.

## 11. Comparison results (interleaved, power throttling disabled)

801 trials in five blocks (amendment 3), from the pinned worktree `0b2d2b9`, every process verified opted out of power
throttling. Generated report: [`comparison-report/REPORT.md`](artifacts/perf/phase-iv-a/comparison-report/REPORT.md),
from [`comparison/trials.jsonl`](artifacts/perf/phase-iv-a/comparison/trials.jsonl) only. **Every speedup below is
relative to the baseline measured in this same sweep**, never to the historical baseline of §3.

### Headline — 1 KiB (primary)

| profile | stable throughput (ops/s) | vs interleaved baseline | knee (offered/s, stable reps) | knee p99 ms | knee p99.9 ms | p99 @ 0.8x knee ms | CPU µs/op | fsync+meta / op | entries / fsync | AppendEntries / op | entries / AppendEntries |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 502 | 1.0x | 500 (3/5) | 1768.45 | 1874.94 | 277.76 | 723 | 2.688 | 1.0 | 0.649 | 3.7 |
| Group commit | 5,999 | 12.0x | 6,000 (5/5) | 28.91 | 34.53 | 1007.10 | 114 | 0.096 | 29.1 | 0.049 | 49.0 |
| Pipeline only | 200 | 0.4x | 200 (5/5) | 498.94 | 522.24 | 432.64 | 1151 | 3.673 | 1.0 | 1.058 | 3.2 |
| Batch only | 502 | 1.0x | 500 (4/5) | 973.31 | 1007.62 | 121.53 | 459 | 1.599 | 1.0 | 0.231 | 29.3 |
| Group + batch | 6,000 | 12.0x | 6,000 (5/5) | 20.94 | 25.25 | 24.14 | 123 | 0.170 | 15.5 | 0.083 | 30.6 |
| Group + batch + pipeline | 6,000 | 12.0x | 6,000 (5/5) | 31.09 | 40.35 | 35.36 | 150 | 0.198 | 54.9 | 0.184 | 12.0 |
| Optimized HTTP | 6,001 | 12.0x | 6,000 (5/5) | 27.95 | 32.99 | 42.37 | 125 | 0.147 | 48.3 | 0.146 | 14.9 |
| Optimized binary | 10,600 | 21.1x | 12,000 (3/5) | 9625.60 | 9666.56 | 3004.41 | 76 | 0.091 | 50.8 | 0.069 | 40.0 |
| Baseline + framed TCP only | 300 | 0.6x | 300 (5/5) | 99.26 | 155.90 | 69.69 | 693 | 2.598 | 1.0 | 0.597 | 6.4 |

"Stable throughput" is the mean achieved rate at the knee: the highest ladder rate that is majority-stable with
every lower rate majority-stable (pre-registered). The knee columns pool every repetition at that rate, stable or
not, which is why a marginal knee (optimized binary, 3/5) shows a multi-second pooled p99. The 0.8x-knee column is
measured separately, at the end of the sweep (block 5).

### Payload sensitivity — 64 B and 16 KiB

| profile | stable throughput (ops/s) | vs interleaved baseline | knee (offered/s, stable reps) | knee p99 ms | knee p99.9 ms | p99 @ 0.8x knee ms | CPU µs/op | fsync+meta / op | entries / fsync | AppendEntries / op | entries / AppendEntries |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 299 | 1.0x | 300 (3/3) | 99.58 | 106.69 | 69.76 | 1111 | 3.437 | 1.0 | 0.954 | 4.7 |
| Optimized HTTP | 6,000 | 20.0x | 6,000 (3/3) | 25.14 | 31.15 | 48.32 | 143 | 0.264 | 47.3 | 0.253 | 8.1 |
| Optimized binary | 9,995 | 33.4x | 10,000 (3/3) | 40.64 | 48.35 | 154.37 | 71 | 0.105 | 48.9 | 0.083 | 35.0 |

| profile | stable throughput (ops/s) | vs interleaved baseline | knee (offered/s, stable reps) | knee p99 ms | knee p99.9 ms | p99 @ 0.8x knee ms | CPU µs/op | fsync+meta / op | entries / fsync | AppendEntries / op | entries / AppendEntries |
|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Baseline | 300 | 1.0x | 300 (3/3) | 117.31 | 131.71 | 60.09 | 1223 | 2.954 | 1.0 | 0.755 | 5.7 |
| Optimized HTTP | 3,013 | 10.0x | 3,000 (3/3) | 170.88 | 259.33 | 57.38 | 316 | 0.167 | 46.8 | 0.165 | 14.8 |
| Optimized binary | 3,003 | 10.0x | 3,000 (3/3) | 43.49 | 57.41 | 29.17 | 250 | 0.273 | 16.8 | 0.228 | 9.8 |

### Disk-regime sensitivity — 1 KiB

| configuration | disk regime | trials | sentinel median fsync ms | regime knee (offered/s) | achieved @ regime knee | gaps below knee | achieved @ overall knee (n) | p99 @ overall knee ms |
|---|---|---:|---:|---:|---:|---|---:|---:|
| Baseline | fast | 19 | 0.33 | 300 | 300 (5) | — | 492 (2) | 419.84 |
| Baseline | slow | 11 | 1.72 | 500 | 508 (3) | 100, 300 | 508 (3) | 1801.21 |
| Group commit | fast | 25 | 0.33 | 6,000 | 5,998 (2) | 1000 | 5,998 (2) | 26.72 |
| Group commit | slow | 45 | 1.74 | 6,000 | 6,000 (3) | — | 6,000 (3) | 29.68 |
| Pipeline only | fast | 11 | 0.35 | 200 | 200 (2) | — | 200 (2) | 6.61 |
| Pipeline only | slow | 9 | 1.71 | 200 | 199 (3) | 100 | 199 (3) | 504.06 |
| Batch only | fast | 11 | 0.31 | 200 | 200 (3) | — | 498 (2) | 241.66 |
| Batch only | slow | 19 | 1.67 | 500 | 505 (3) | — | 505 (3) | 984.06 |
| Group + batch | fast | 41 | 0.33 | 6,000 | 6,001 (2) | — | 6,001 (2) | 9.10 |
| Group + batch | slow | 39 | 1.74 | 6,000 | 6,000 (3) | 100 | 6,000 (3) | 21.81 |
| Group + batch + pipeline | fast | 37 | 0.34 | 8,000 | 8,003 (1) | 1000 | 6,000 (2) | 31.95 |
| Group + batch + pipeline | slow | 33 | 1.78 | 6,000 | 6,000 (3) | 100 | 6,000 (3) | 30.77 |
| Optimized HTTP | fast | 37 | 0.33 | 6,000 | 6,000 (1) | 750 | 6,000 (1) | 28.51 |
| Optimized HTTP | slow | 33 | 1.71 | 6,000 | 6,001 (4) | 100, 200, 4000 | 6,001 (4) | 27.79 |
| Optimized binary | fast | 43 | 0.32 | 12,000 | 12,023 (3) | 1000 | 12,023 (3) | 109.18 |
| Optimized binary | slow | 42 | 1.72 | 10,000 | 10,066 (2) | 100 | 8,466 (2) | 9641.98 |
| Baseline + framed TCP only | fast | 16 | 0.34 | 300 | 300 (3) | — | 300 (3) | 103.74 |
| Baseline + framed TCP only | slow | 9 | 1.66 | 300 | 300 (2) | 100 | 300 (2) | 70.33 |

### What the numbers say

1. **The baseline saturates on synchronous durability.** Each committed write costs about 2.7 fsync-class operations
   (log append plus metadata rewrite), one entry per fsync, at about 36% of one leader core at its knee. The re-measured
   baseline knee is **500 writes/s** at 1 KiB. The historical 300/s of §3 was measured under Windows' default process
   policy and is not the denominator for anything here.
2. **Group commit removes that bound: about 6,000 writes/s, 12x.** fsync and metadata operations per write fall from
   2.69 to 0.10, with 29 entries per fsync. Stop-and-wait replication already batches what accumulates while a request is
   in flight (49 entries per AppendEntries), so the engine moves from storage-bound towards CPU-bound (68% of a core).
   It reaches 6,000/s in both the fast and the slow fsync regime.
3. **Batching alone does not help.** Batch-only cuts AppendEntries per write from 0.65 to 0.23 (29 entries per request)
   and fsyncs per write to 1.6, but the leader still fsyncs every write before acknowledging, so the knee stays at
   500/s. On top of group commit, explicit bounded batches do not raise the knee on this ladder (6,000/s either way).
4. **Pipelining alone regresses, to 200 writes/s (0.4x).** It sends a request per write while earlier ones are still in
   flight: AppendEntries per write rise from 0.65 to 1.06, entries per request fall to 3.2, and every request costs a
   follower its own synchronous fsync (3.67 fsync-class operations per write) plus an HTTP round trip on the
   axios/express path (1,151 µs of leader CPU per write). This is small-request amplification. Pipelining helps nothing
   until group commit and batching make each request carry many entries.
5. **With every engine optimization the leader becomes CPU-bound, and the transport becomes the ceiling.** Group + batch
   + pipeline and optimized-HTTP sit at the same 6,000/s rung. The framed transport (optimized binary) raises the knee to
   **12,000/s (10,600 achieved, 21x)**, at 76 µs of leader CPU per write and about 90% of a core. That knee is marginal
   and storage-sensitive: 3 of 5 repetitions are stable at 12,000/s. All three ran in the fast fsync regime, and both
   unstable ones in the slow regime; the regime knees are 12,000/s (fast) and 10,000/s (slow). All 5 repetitions are
   stable at 10,000/s (about 20x).
6. **Most of the transport gain is the connection and framing, not the binary encoding.** In isolation (§9), framed
   JSON and framed binary move the same number of AppendEntries. The Raft sweep compared HTTP with framed binary only, so
   this split rests on the isolation benchmark.
7. **The transport alone does not help a storage-bound engine.** Transport-only reached 300 writes/s against the
   baseline's 500; why it measured lower is not established here.
8. **Payload.** At 64 B the optimized engine reaches 6,000/s over HTTP (20x) and 10,000/s framed (33x, all repetitions
   stable). At 16 KiB both optimized variants stop at 3,000/s (10x), where bytes per write dominate.

### Measurement notes

- **Ladder resolution.** The rate ladder steps 6,000 → 8,000/s, so configurations that tie at 6,000 may differ by up to
  a third.
- **Harness failures.** 8 trials failed: local ephemeral ports were exhausted on the harness's own post-window requests
  at 15,000–20,000/s. All replicas were alive, and every failure sits above its curve's first unstable rung, so no knee
  is affected. The 64 B optimized-binary ladder ended at 20,000/s because of them.
- **Generator.** Generator lag p99 stayed below 0.4 ms (median) in every load band. 7 trials exceeded the 5 ms flag;
  none is a stable repetition a knee depends on, and one (optimized HTTP at 1,000/s) had a 3 s machine-wide stall.
- **Two cells disagree with the ladder.** Group commit's p99 at 0.8x knee (1.0 s) comes from one slow-regime repetition
  with a 55x latency blow-up within its window; the other four are 12–36 ms. Optimized binary is unstable at 0.8x knee
  (9,600/s) in its three slow-regime repetitions. Both are the disk regime, and neither changes a pre-registered
  result.
- **Thermal state** was observed in blocks 2–5 (`host-telemetry-block*.jsonl`), not controlled, and decides nothing.

### Where the leader spends its time (step 8)

Leader CPU profiles at the pre-registered points, one trial each, power throttling disabled:
[`comparison-profiles/`](artifacts/perf/phase-iv-a/comparison-profiles/). Columns are shares of *busy* leader time.

| profile | offered/s | achieved/s | busy % of wall | fs-sync-io | axios | express | node-http | streams-net | json | console-logging | raft-engine | raft-log-store | raft-transport | state-machine | gc | instrumentation |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| baseline 1024 B A-sub-saturation | 250 | 250 | 65.7 | 59.2 | 8.7 | 3.9 | 5.5 | 7.5 | 0.3 | 2.5 | 3.8 | 0.7 | 0.0 | 0.5 | 0.5 | 0.3 |
| baseline 1024 B B-knee | 500 | 441 | 96.6 | 79.3 | 2.6 | 3.1 | 2.2 | 3.5 | 0.1 | 2.0 | 1.9 | 0.8 | 0.0 | 0.3 | 0.3 | 0.3 |
| baseline 1024 B C-overloaded | 750 | 828 | 98.2 | 80.5 | 0.9 | 3.8 | 1.6 | 3.1 | 0.0 | 2.3 | 1.9 | 1.0 | 0.0 | 0.3 | 0.4 | 0.2 |
| optimized-binary 1024 B A-sub-saturation | 6,000 | 5,997 | 94.6 | 33.2 | 0.0 | 13.3 | 4.8 | 20.7 | 0.5 | 0.0 | 4.3 | 2.5 | 1.2 | 2.4 | 1.3 | 0.7 |
| optimized-binary 1024 B B-knee | 12,000 | 8,456 | 90.3 | 31.9 | 0.0 | 12.3 | 4.7 | 22.2 | 0.1 | 0.0 | 4.3 | 3.6 | 0.5 | 2.3 | 2.0 | 0.6 |
| optimized-binary 1024 B C-overloaded | 15,000 | 10,564 | 91.0 | 17.3 | 0.0 | 15.7 | 6.1 | 26.2 | 0.2 | 0.0 | 5.3 | 3.7 | 0.6 | 3.0 | 2.3 | 0.9 |

The baseline leader is a storage loop. Synchronous fsync is 59% of busy time at half the knee and about 80% at and past
it. The HTTP stack on both sides (axios, express, node-http, streams) shrinks as fsync grows. The optimized leader has a
different shape: synchronous fsync is 17–33%, because group commit amortizes it but the flush still runs on the event
loop. Socket I/O is 21–26% and the client-facing express and node-http request path 17–22%, while the Raft engine, log
store and framed transport together are under 10%. With the engine optimized, the leader's time goes to serving
requests and to the remaining synchronous flush, not to consensus logic. Both knee profiles came out unstable in their
single trial (baseline 88%, optimized-binary 71% achieved), consistent with their 3/5 knees.

## 12. Final correctness regression (step 9)

Run at `dd0ab9d` on a clean tree, after the sweep and the profiles
([`final-regression.txt`](artifacts/perf/phase-iv-a/final-regression.txt)). Every step passed:

- replica suite 118/118. Node suites (simulator, packages, refund-provider, tools): 215 passed, 0 failed, and 1 skipped
  by design (the off-Windows power-policy branch). Syntax check of every module; web bundle current.
- Default-engine 60-seed simulator fingerprint unchanged (`1f73f666…`).
- Linearizability: the default 100-schedule search, and 200-schedule searches for all nine sweep profiles,
  `group-pipeline` and the four stress profiles, found 0 violations.
- Targeted fault campaign: 900 runs over baseline and the four stress profiles, 0 failures, windows hit. Mutants: 5/5
  killed.
- Agent and multi-agent campaigns (1,000 schedules each) found no violation, and their mutant benchmarks killed every
  mutant. The Phase I replay of `failure-1337` reproduced byte-identically, and the Phase I acceptance gate and the
  Phase II-A / II-A.2 smoke gates passed. Python (`ml/cloudproof`): 44 passed.
- Live durability gate under the comparison's power policy (`1b55e36`): 30 forced leader deaths, 157,788 acknowledged
  writes, 0 missing, 0 duplicates.

## 13. Known limitations and follow-ups

- **Harness under extreme overload.** At 15,000–20,000/s the load generators' reconnect storm and the harness's
  per-request connections can exhaust local ports. Eight trials failed this way, all above their curves' first
  unstable rung. Follow-ups: keep-alive connections for the harness's own requests, reconnect backoff in the
  generator, and a guard in `stop-sweep.ps1` against a reused PID.
- **Ladder resolution** at 6,000 → 8,000/s hides differences among the configurations that tie at 6,000/s.
- **Optimized-binary's knee is marginal and storage-sensitive** (fast regime 12,000/s, slow 10,000/s). The robust
  statement is 10,000/s, stable in 5/5 repetitions.
- **Transport-only measured below baseline** (300 vs 500/s); the cause is not established.
- **The group-commit flush is still a synchronous fsync on the leader's event loop**, 17–33% of its busy time in the
  optimized profile: the obvious next candidate, outside Phase IV-A's scope.
- **Windows-specific environment.** The fsync regimes, power throttling and thermal behaviour are properties of this
  laptop. The production target (Linux, ext4/xfs) differs, and nothing here is a claim about it.
- **Pre-existing, untouched.** `_scheduleCommitBroadcast` in `replica/raft.js` clears `_noopIndex` inside its timer.
  This predates Phase IV-A and was left alone.
- **etcd** has not been run. Per the methodology, it comes only after this report.
