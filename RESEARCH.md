# Research evaluation

## Question

Can deterministic simulation and automated failure reduction make distributed-system correctness bugs reproducible and understandable?

## Current answer

**Reproducible: yes, for the bounded campaign measured here.** All 20 sampled schedules replayed with the same domain-separated decision tape and the same pass/failure signature. The campaign reached all 16 declared transition targets, and the Bug Museum rediscovered all 10 seeded defects. This is evidence for the implementation and campaign—not a general proof that every distributed execution is deterministic.

**Understandable: partially supported, not yet established for users.** Failure reduction removed a median 84% of schedule actions and the Flight Deck derives causal “Why?” explanations from trace structure. Those are useful mechanism-level results. Diagnosis-time improvement still needs a paired user study, so that field is recorded as `not-collected` instead of being inferred from the interface.

The linearizability checker follows the same model-based philosophy described by [Jepsen's checker documentation](https://jepsen-io.github.io/jepsen/jepsen.checker.html): validate an observed history against an explicit correctness model. This project does not claim to be Jepsen or to cover Jepsen's full fault surface.

## Measured run

The checked-in [metrics artifact](artifacts/research-metrics.json) was produced on Node 24.14.1, Windows x64, on 2026-08-19.

| Measure | Result |
|---|---:|
| Schedules explored per second | 23.1 |
| Virtual time per real second | 321,579× |
| Target transition coverage | 16 / 16 |
| Seeded bugs rediscovered | 10 / 10 |
| Median shrink ratio | 84% |
| Shrink execution time | 9.8 ms |
| Deterministic replay success | 100% |
| Recorder overhead | 1.56× median runtime |
| Invariant-check cost | 2.17 μs/check |
| Simulated watch recovery | 244 ms virtual |
| Docker watch recovery | 938 ms wall clock |
| Diagnosis time with/without Flight Deck | Not collected |

The deployed number comes from the same resumable-watch scenario running against three Docker replica processes. The envelope is identical, while wall-clock execution includes scheduling, sockets, fsync, container startup, DNS, and readiness propagation.

## Reproduce

Run the deterministic campaign and update the artifact:

```bash
node tools/research-benchmark.js
```

Run the one simulator-versus-reality integration demonstration:

```bash
docker compose --profile research up --build \
  --abort-on-container-exit --exit-code-from reality-harness reality-harness
docker compose --profile research down
```

The Docker harness writes `web/reality-run.json`, which the Flight Deck aligns with the virtual trace by semantic event type and causal envelope.

To measure diagnosis time, run a paired study over the same minimized failures and pass comma-separated millisecond observations:

```bash
DIAGNOSIS_WITHOUT_MS=120000,98000,141000 \
DIAGNOSIS_WITH_MS=51000,44000,62000 \
node tools/research-benchmark.js
```

The benchmark reports medians and reduction only when both sample lists are present and have equal length.

## Interpretation limits

- Schedules per second is hardware- and workload-dependent; compare campaigns on the same machine and configuration.
- The mutant suite measures known defect classes, not an estimate of production defect prevalence.
- A 100% replay rate over 20 schedules is a regression target, not a completeness claim.
- The deterministic simulator tests protocol behavior. The Docker harness tests packaging, DNS, persistence, and readiness integration.
- “PASS FOR THIS EXECUTION” means exactly that. It is not a formal proof of the implementation over all executions.
