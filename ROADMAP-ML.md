# CloudProof → a streaming ML platform with provable correctness

## The thesis

> **Feature pipelines are distributed systems, and nobody tests them like one.**

Every team that ships ML has been burned by the same class of bug: the model scored
0.94 AUC offline and 0.61 in production, and nothing anywhere threw an error. The
usual explanation — "distribution shift" — is often wrong. The real cause is
frequently a *correctness* bug in the pipeline: a window closed before its late data
arrived, a join leaked information from the future, a consumer rebalanced mid-window
and double-counted, or the online feature code and the offline feature code
disagreed by a millisecond of rounding.

Those are not statistics problems. They are the same problems this repository
already has a working checker for.

That is the whole project. The Raft engine, the deterministic simulator, and the
linearizability checker were built first and are now the *instrument*. The
streaming ML platform is what the instrument gets pointed at.

## Why this is one project and not four integrations

A résumé that lists Kafka, Spark, ML, and an LLM invites exactly one interview
question — *"why did you need Kafka here?"* — and "for streaming" ends the
conversation. Everything below has to survive that question.

| Component | Why it is load-bearing | What breaks without it |
| --- | --- | --- |
| Partitioned event log | Ordering is per-partition only, which is *why* windows are hard | No out-of-order data, so watermarks are pointless |
| Watermarks | Decide when a window may close and results may be emitted | Either wait forever or silently drop late events |
| Raft (existing) | Holds the feature registry and model pointer | Two servers disagree on which model version is live |
| Point-in-time join | Prevents features from seeing the future | Label leakage — the offline/online gap this project exists to explain |
| Deterministic simulation | Makes the above reproducible from a seed | Bugs that appear once a week and can never be re-run |
| Drift maths | Distinguishes a real shift from a pipeline bug | Every incident gets blamed on "the data changed" |
| LLM | Reads the causal trace and explains a drift alert | A human reads 4,000 events by hand |
| TLA+ | Proves what the fuzzer can only sample | Confidence proportional to how long the fuzzer ran |

## Stages

Each stage is gated by the one before it. The order is not aesthetic — later
stages are untestable without earlier ones.

### Stage 1 — The event log and event time
*Hand-written, for the same reason `raft.js` was hand-written.*

Partitions, offsets, consumer groups, rebalances, and the difference between
at-least-once and exactly-once delivery. Then the part that actually matters:
**event time**. Watermarks, event-time windows, allowed lateness, and an explicit
policy for data that arrives after its window closed.

Then run real Kafka in Docker, replay one trace through both, and assert the
delivery order and window results match. Until that passes, the hand-written
version is a claim rather than a result.

**Gate:** identical window output from both implementations on the same trace.

### Stage 2 — Features, and the bug this project is about
Online features computed from the stream; offline features computed from batch.

Build the **naive join first, on purpose.** Train a model on it, measure the
offline AUC, deploy against live features, and measure the collapse. Then build
the correct point-in-time join and measure the gap closing. The number produced
by that experiment is the centrepiece of the entire project — it is the
difference between asserting that label leakage matters and demonstrating it.

**Gate:** a measured AUC gap, with the leak identified as its cause.

### Stage 3 — Deterministic simulation of the pipeline
The virtual clock, seeded PRNG, and checker already exist. Point them at the
pipeline and inject: late data past the watermark, partitions delivering
out of order, a consumer rebalance in the middle of an open window, duplicate
delivery, and a broker restart.

Assert: effects apply exactly once; no window emits before its watermark; and for
every entity and timestamp, the online feature equals the offline feature.

This is the stage nobody else has done. Deterministic simulation testing is well
known for databases (FoundationDB, TigerBeetle) and essentially unused on feature
pipelines.

**Gate:** at least one real bug found by the simulator and fixed, with its seed
recorded so it replays exactly.

### Stage 4 — The model and the maths
Logistic regression with SGD, written from scratch — the gradient derivation is
the point, and calling `sklearn` skips it.

Then the statistics that make an alert trustworthy: **PSI**, **KL divergence**,
and the **KS test** for drift, plus **reliability diagrams** and **Brier score**
for calibration. Crucially, the pipeline can now tell two things apart that look
identical from a dashboard: the input distribution genuinely moved, versus the
feature code broke. Stage 3 is what makes that distinction provable.

**Gate:** a drift alert that correctly attributes cause, demonstrated both ways.

### Stage 5 — Retrieval as a feature, and the LLM
The hand-written HNSW, BM25, reciprocal rank fusion, and int8/binary quantization
already in this repository currently run on simulated data. Make embeddings a real
feature type in the pipeline, evaluated honestly — recall@k, nDCG, MRR against a
labelled set built by hand.

The LLM gets exactly two jobs, both things the system genuinely cannot do without
it:

1. **Explain a drift alert** by reading the causal trace and naming the likely
   cause. The trace already exists; it is currently only readable by a human with
   time.
2. **Compile natural language into the scenario DSL**, so "what happens if a
   consumer rebalances while the window is open" becomes a runnable, seeded,
   reproducible experiment.

Note what is *not* here: a chat box.

**Gate:** the LLM's explanation of a seeded, known bug matches the actual cause.

### Stage 6 — Proof
A TLA+ specification of the coordination protocol — the membership change and the
atomic feature/model pointer flip — model-checked for the safety properties the
fuzzer can only sample. The fuzzer says "no violation in 200 runs." TLC says "no
violation exists in this state space." Those are different claims, and knowing
the difference is the point.

Paired with queueing theory: Little's Law and M/M/c explaining the p99 curves
already measured in `tools/`, rather than merely plotting them.

**Gate:** TLC finds no violation, or finds one the fuzzer missed — which would be
the better outcome.

## What each stage buys, per the stated goals

| Stage | Hiring | Learning depth | Research novelty |
| --- | --- | --- | --- |
| 1 · log + event time | High — everyone claims Kafka, few can explain watermarks | High | Low |
| 2 · point-in-time join | **Highest** — a measured number beats any claim | High | Medium |
| 3 · DST on pipeline | High | Medium | **Highest** |
| 4 · model + drift maths | Medium | **Highest** | Medium |
| 5 · retrieval + LLM | High | Medium | Medium |
| 6 · TLA+ | Medium — narrow audience, deep signal | High | High |

## The honest risks

- **Stage 2 is the whole project.** If the AUC gap is not measured and
  attributed, the rest is scaffolding around a claim. It should be built early
  and defended hardest.
- **Hand-writing everything has a limit.** The log and the maths are worth
  writing by hand because the semantics *are* the learning. A production Kafka
  clone is not, which is why Stage 1 ends by deferring to the real one for
  cross-checking rather than trying to replace it.
- **Stage 5's LLM is the easiest thing here to make decorative.** Its gate is
  written as a falsifiable test for that reason: explain a bug whose cause is
  already known, and check the answer.
- **This repository's harness has historically been wrong more often than its
  engine** — the simulator's partition bug, the log-matching invariant, the
  cursor bound found last session. Stage 3 should be assumed guilty until a bug
  it reports is confirmed by hand.
