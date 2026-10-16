# IV-B.0 correctness gate: static Multi-Raft

The gate of [`CLOUDPROOF-PHASE-IV-B.md`](../../../../CLOUDPROOF-PHASE-IV-B.md) §13. It covers three static ranges
(`r1 = ['', 'h')`, `r2 = ['h', 'p')` and `r3 = ['p', +∞)`), all at epoch 1, on three logical nodes on one host. Each range
is an unchanged Phase IV-A `RaftNode` over the HTTP transport, with range-prefixed endpoints. Every report here was
produced from commit `d8edaa0` on a clean tree; each JSON report records its own commit and `dirty: false`.

**Result: every condition passed.**

| file | what it is |
|---|---|
| `simulator.json` / `.txt` | `node sim/multi-raft-search.js --runs 50`: 4 scenarios plus 50 seeded fault campaigns, for each of the engine profiles `baseline`, `optimized-http` and `batched-delay` (162 runs) |
| `live-run-{1,2,3}.json` / `.txt` | `node tools/multi-raft-live-test.js` three times: three real processes on loopback, with fsynced files and the `optimized-http` profile |
| `regression.txt` | `bash tools/regression.sh`: the 34-step Phase IV-A regression on the same commit |
| `failed-before-fix/` | the first live recording, which failed; see Disclosures |

## Conditions

| # | condition (§13) | simulator (all three profiles) | live (three runs) |
|---|---|---|---|
| 1 | concurrent operations on at least three ranges | S1 writers on all three ranges, plus six campaign clients on all 12 keys | six shared clients on all 12 keys plus one writer per range; 5,123–7,653 logical writes per run |
| 2 | the leader of each group killed independently | S1 crashes each range's leader replica in turn, then a whole node | each range's leader replica crashed in turn, then a whole process SIGKILLed |
| 3 | one range keeps committing while another elects | every non-vacuous window: each range led elsewhere committed (7–27 acknowledged writes) | every window: each other range's writer committed (30–301 acknowledged writes, during 586–823 ms leaderless) |
| 4 | wrong or stale `rangeId` / epoch, or a key outside the range, rejected, with no mutation | S3: 36 admission probes refused; 12 raw appends rejected at apply on every replica; state unchanged | 36 mis-addressed writes and 36 reads refused (409); state unchanged |
| 5 | each range's committed state survives restart | S2: every node crashed and restarted; every acknowledged value re-read, and the state is identical | every process SIGKILLed and restarted; the state is identical |
| 6 | logical linearizability, per key, of the combined history | 36,551 operations on 1,800 key histories: 0 violations, 0 inconclusive | 6,256–9,333 operations per run on 12 keys: 0 violations |
| 7 | exactly-once from the application ledgers | 24,297 logical requests (1,929 retried): 0 applied more than once, 0 acknowledged writes missing, 0 stale-epoch writes accepted (376 probes) | 0 applied more than once, 0 missing, 0 stale accepted, in each run |
| 8 | the Phase IV-A regression unchanged | 34/34 steps passed on `d8edaa0`: replica 118/118; Node suites 256 passed, 0 failed, 1 skipped by design (now including the 22 Multi-Raft tests); default fingerprint unchanged (`1f73f666…`); all 14 linearizability searches found 0 violations; fault campaign 0 failures; mutants killed; Python 60 passed | — |

The per-profile totals are in `simulator.json` (`profiles.<name>.campaign.summary`). Because each simulator run is
deterministic, the same seed reproduces the same history and ledgers (checked in `packages/multi-raft/gate.test.js`).

## The gates can fail

`packages/multi-raft/gate.test.js` runs mutants that must turn the gate red:

- **Deduplication disabled** (`_findDuplicate` always misses). A write retried while its first attempt is still in
  flight is applied twice. The exactly-once gate fails. The register checker still accepts the history, because a
  value written twice is the same value. This is why exactly-once is a separate gate (§5.2).
- **Apply-time fence removed.** A mis-addressed write appended to the log changes state, and stale-epoch writes are
  counted as accepted.
- **Log never durable.** Acknowledged writes are lost across a restart.

## Disclosures

Three problems were found in the gate's own code while recording it. All were fixed before anything was pushed. The
reports from before each fix were discarded, except the failed live run, which is kept.

- **The first live recording failed condition 3.** It is kept in `failed-before-fix/live-run-1-shared-clients.*`. In
  its process-kill window, the range led by a surviving node recorded 0 commits.

  The cause was in the workload, not in Multi-Raft. Progress was measured on the six shared clients, and each client
  has one operation in flight at a time on a random key. When a process dies with two of the three leaders, a client
  that picks a key in a leaderless range blocks until re-election. Within a few hundred milliseconds every client can
  be blocked, and no load reaches the healthy range at all.

  The fix measures progress on one dedicated writer per range, as the simulator's S1 always did. The condition is
  unchanged. Every window also reports, for each range, the writer's commits, the shared clients' commits and the
  attempts offered by all clients. Two unrecorded diagnostic runs confirmed the cause before recording. In their
  process-kill windows, the surviving ranges' writers committed 31–53 writes while the shared clients managed 1–6.
- **Scenario conditions were overwritten.** Each simulator scenario spread the common verdict after its own `ok`, so
  the common `ok` replaced the scenario-specific conditions. Those were S1 independent progress, S2 survival, S3
  refusal on every replica, and S4 dedup. The common checks (linearizability, exactly-once, Raft safety per range) were
  always enforced.

  A related flaw: convergence compared applied state but not applied position, and a rejected entry changes no state.
  Both are fixed. Convergence now also requires an equal `lastApplied`, and a test pins each scenario's `ok` to the
  conjunction of its conditions.
- **Oversized report.** A wait helper returned the predicate's value, so S1 windows serialized whole leader objects
  into the report. It now returns a boolean. This affected only the report's size and fields, not any result.
- **The regression runner is now committed.** The Phase IV-A regression (34 steps) was driven by a script that had
  lived only in a scratch directory and had since been deleted. It was recreated with the same steps and commands and
  committed as `tools/regression.sh`, so condition 8 can be rerun.
- **One vacuous window.** In `batched-delay` S1, the node chosen for the whole-node crash led all three ranges at that
  moment. With no range led elsewhere, that window says nothing about independent progress. It is reported as
  `vacuous: true` and not counted as evidence. The three per-range windows of the same run carry condition 3.
- **Scope.** IV-B.0 runs on one physical host with three logical nodes, no splits, fixed descriptors at epoch 1, and
  the HTTP transport only (§13). It measures correctness, not throughput.
