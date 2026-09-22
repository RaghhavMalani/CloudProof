# CloudProof Phase I — Executable Kubernetes World Model

CloudProof tests one claim:

> Given a Kubernetes topology and an operational action, deterministically explore concurrent controller behavior, minimize an SLO-violating interleaving, and replay the prediction on a real kind cluster.

Phase I also emits the supervised graph transitions needed by a future learned world model. It does **not** implement a GNN, an LLM planner, an RL adversary, Terraform, or multi-cloud behavior.

The topology-held-out dataset and fixed-budget baseline stage is documented in [CLOUDPROOF-PHASE-II-A.md](CLOUDPROOF-PHASE-II-A.md). Its corpus was superseded after the Phase II-B.1 attribution audit ([CLOUDPROOF-PHASE-II-B1-ATTRIBUTION-AUDIT.md](CLOUDPROOF-PHASE-II-B1-ATTRIBUTION-AUDIT.md)); the leakage-resistant replacement is documented in [CLOUDPROOF-PHASE-II-A2-CAUSAL-CORPUS.md](CLOUDPROOF-PHASE-II-A2-CAUSAL-CORPUS.md).

## Architecture

```text
seed + topology + plan
          │
          ▼
 concrete cloud schedule ────────────────┐
          │                              │
          ▼                              ▼
 deterministic Kubernetes twin      riskScorer
 Deployment · Scheduler · Kubelet    null / logistic baseline
 Endpoints · HPA · PDB
          │
          ├── structured invariant checks
          ├── exact failure fingerprint
          ├── transition graph JSONL
          └── minimized replay artifact
                         │
                         ▼
                existing kind harness
```

`sim/simulator.js` supplies the seeded `Rng` and `VirtualClock`. Cloud schedule generation uses the domain-separated decision streams in `sim/decision-tape.js`. Failure identity and shrinking follow the exact-fingerprint pattern used by the Stage 5 and Stage 6 searchers.

The CloudProof code is isolated in three layers:

- `packages/cloudproof/`: desired/observed resource state, heterogeneous graph, controllers, scheduler, faults, invariants, telemetry, transition datasets, and `RiskBaseline`.
- `sim/cloud-*.js`: schedule language, materialization, execution, search, replay, coverage, and shrinking.
- `tools/cloudproof*.js` and `k8s/cloudproof/`: command-line and real-cluster adapters.

The existing Raft and agent runtimes are not part of the cloud twin and are not modified.

## Deliberate model boundary

Modeled:

- Node CPU, memory, readiness, zone, taints, and pod tolerations;
- Pod `PENDING → STARTING → RUNNING → READY` lifecycle under virtual time;
- Deployment replica count, rollout version, `maxSurge`, and `maxUnavailable`;
- delayed propagation of ready pods into Service endpoints;
- HPA metric delay, reconciliation, stabilization, and bounded replica recommendation;
- PDB `minAvailable` admission for voluntary node drains;
- rollout, rollback, scale, drain, recovery, time advance, and traffic spike actions;
- node crash/drain, zone degradation, readiness/image-pull delay, stale HPA metrics, endpoint delay, and controller restart faults.

Deliberately omitted:

- ReplicaSets as first-class graph nodes;
- kube-proxy, CNI, DNS, and packet-level dataplane behavior;
- volumes, storage attachment, priority, preemption, and full topology-spread scoring;
- admission controllers, webhooks, custom resources, and arbitrary Kubernetes objects;
- exact metrics-server/KEDA internals and the complete eviction/disruption-controller protocol.

These omissions keep the model small enough for exhaustive schedule work while preserving the concurrency boundaries exercised by the flagship incident.

## Graph and dataset contract

The graph contains only `Node`, `Pod`, `Deployment`, `Service`, `HPA`, `PDB`, and `Zone` nodes. Its edges are `OWNS`, `RUNS_ON`, `ROUTES_TO`, `LOCATED_IN`, `SELECTS`, `PROTECTS`, and `SCALES`.

Every explicit action and virtual-clock callback emits:

```json
{
  "state": { "kind": "cloudproof.infrastructure-graph" },
  "action": { "type": "cloud.action.drain-node" },
  "nextState": { "kind": "cloudproof.infrastructure-graph" },
  "labels": {
    "sloViolationWithin1000ms": true,
    "minReadyReplicas": 4,
    "latencyBucket": "100_TO_499_MS",
    "failureClass": "ROLLOUT_AVAILABILITY_VIOLATION"
  }
}
```

Saved counterexamples place these rows under `artifacts/cloudproof/datasets/transitions-seed-<seed>.jsonl`.

`RiskBaseline` uses eight fixed state features—ready replicas, pending replicas, zone concentration, CPU pressure, rollout active, HPA active, PDB headroom, and degraded-node count—plus a bounded candidate-action risk feature. Training uses deterministic batch gradient descent; evaluation reports AUROC, AUPRC, Brier score, expected calibration error, and five-bin calibration for seeded random, heuristic, and logistic baselines. Search accepts any object implementing `riskScorer.score(state, candidateAction)` and has no ML-framework dependency.

## Run

Find, shrink, save, and export the flagship counterexample:

```bash
node tools/cloudproof.js search --seed 1337 --runs 1
```

Replay the exact graph trace:

```bash
node tools/cloudproof.js replay --file artifacts/cloudproof/failure-1337.json
```

Run the three-mutant, 1,000-corrected-schedule, shrink, replay, and risk-baseline gate:

```bash
node tools/cloudproof.js benchmark --seed 1337 --runs 10 --no-artifacts
```

Bring up the existing four-node cluster and reproduce the minimized operations:

```bash
bash tools/kind-up.sh
node tools/cloudproof-kind-replay.js artifacts/cloudproof/failure-1337.json
```

The replay adapter applies `k8s/cloudproof/flagship.yaml`, waits for 6/6 readiness, performs the minimized rollout/drain operations, samples real Deployment readiness, evaluates the same structured invariant, and compares the predicted and observed failure fingerprints. Controller scheduling steps remain simulation-only; Kubernetes performs those steps in the real replay.

## Injected mutants

| Mutant | Broken behavior | Expected class |
|---|---|---|
| `endpoint-includes-unready` | Publishes a scheduled pod before readiness | `TRAFFIC_TO_UNREADY_POD` |
| `rollout-ignores-terminating` | Counts terminating pods inside availability budget | `ROLLOUT_AVAILABILITY_VIOLATION` |
| `hpa-stale-indefinitely` | Retains a low metric after the fault window expires | `AUTOSCALER_CAPACITY_MISMATCH` |

The corrected model's generated campaign intentionally contains safe scale and rollout schedules. The flagship operational campaign separately demonstrates that individually valid controller semantics do not make every concurrent operational plan safe.
