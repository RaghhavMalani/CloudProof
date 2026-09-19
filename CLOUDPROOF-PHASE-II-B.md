# CloudProof Phase II-B — Heterogeneous Graph Risk Model

Phase II-B tests one research hypothesis:

> Can a learned graph representation of Kubernetes state improve deterministic counterexample discovery under a fixed verification budget?

The neural model is a ranking mechanism only. It predicts `P(SLO violation within the next K transitions)` and exposes ensemble disagreement as uncertainty. The deterministic Node simulator remains the sole authority on whether a schedule is safe or unsafe.

## Frozen data contract

The implementation consumes the unchanged Phase II-A corpus and validates its manifest before training:

- train: topologies A–H, 3–6 replicas;
- validation: topologies I–J;
- test: topologies K–M;
- OOD: topologies OOD-A–OOD-D, 8–12 replicas;
- inputs: current infrastructure graph plus candidate action only;
- excluded: identifiers as features, topology/split labels, next state, future labels, trajectory outcomes, and failure classes.

The full corpus is trajectory-balanced but transition labels are not. The observed positive-label counts are:

| Split | Positive transitions | Total transitions | Positive rate |
| --- | ---: | ---: | ---: |
| Train | 12,358 | 148,732 | 8.31% |
| Validation | 3,087 | 35,549 | 8.68% |
| Test | 4,557 | 55,458 | 8.22% |
| OOD | 6,517 | 80,517 | 8.09% |

Training therefore selects weighted binary cross entropy from the measured train split. This decision is recorded in `config.json`; focal loss is not used.

## Model

`ml/cloudproof/` contains a small PyTorch implementation with no PyTorch Geometric dependency:

1. Per-type encoders for Pod, Node, Deployment, Service, HPA, PDB, and Zone.
2. Two relation-aware message-passing layers for RUNS_ON, OWNS, ROUTES_TO, LOCATED_IN, SELECTS, PROTECTS, and SCALES, including reverse-direction messages.
3. Typed mean graph pooling.
4. A separate action encoder for action type, semantic target type, resolved target-node embedding, and bounded numeric parameters.
5. A compact MLP risk head.
6. Five independently initialized members with fixed seeds. Inference returns mean risk and population standard deviation.

IDs are used transiently to connect edges and resolve an action target. They are never emitted into a feature tensor. ID-bearing graph fields such as `Node.features.zone` and `Service.features.endpointPodIds` are deliberately excluded because the relations already carry that structure.

The canonical transition vocabulary also contains internal simulator outcomes such as `cloud.kubelet.pod-ready`; these are represented by a fixed action vocabulary rather than an unknown-token escape hatch.

## Train and evaluate

Install the isolated ML dependencies:

```bash
python -m pip install -r ml/cloudproof/requirements.txt
```

Train the required five-member ensemble. SHA-256 verification is enabled by default:

```bash
python -m ml.cloudproof.train \
  --dataset artifacts/cloudproof/research-dataset \
  --out artifacts/cloudproof/models/gnn-v1
```

Training uses train only for optimization and validation for early stopping and threshold selection. Final evaluation reads test and OOD only after training:

```bash
python -m ml.cloudproof.evaluate \
  --dataset artifacts/cloudproof/research-dataset \
  --model artifacts/cloudproof/models/gnn-v1
```

The model artifact contains:

```text
artifacts/cloudproof/models/gnn-v1/
├── member-0.pt ... member-4.pt
├── config.json
├── metrics.json
└── manifest.json
```

`manifest.json` binds every member, config, metrics file, and Phase II-A input file to a SHA-256 digest.

## Deterministic fixed-budget benchmark

The Node benchmark deduplicates initial graph/action requests, runs Python inference once, loads an offline synchronous `riskScorer`, replays every held-out schedule through the unchanged deterministic simulator, and compares Random, Coverage, Heuristic, Logistic, and GNN at the same budgets:

```bash
node tools/cloudproof-gnn-benchmark.js \
  --dataset artifacts/cloudproof/research-dataset \
  --model artifacts/cloudproof/models/gnn-v1 \
  --out artifacts/cloudproof/models/gnn-v1/fixed-budget.json \
  --budgets 100,500,1000,5000
```

The scorer interface offers both forms:

```js
scorer.score(state, candidateAction)
scorer.scoreWithUncertainty(state, candidateAction)
// { risk: 0.83, uncertainty: 0.17 }
```

Neither interface can declare a remediation safe.

## Ablations and controlled topology experiment

Run all required five-member variants with the same data boundaries and seeds:

```bash
python -m ml.cloudproof.ablations \
  --dataset artifacts/cloudproof/research-dataset \
  --out artifacts/cloudproof/models/ablations
```

The variants are full hetero GNN, shared edge transform, no action embedding, no zone relation, and flat typed pooled-feature MLP. Evaluation also constructs a controlled pair with six identical pod/resource feature vectors: placement 2/2/2 across three zones versus 4/1/1. Only RUNS_ON endpoints change, and the same zone-failure action is scored for both.

## Bounded research check

A CPU-bounded, non-acceptance study trained five fixed-seed members for three epochs on 10,000 train transitions and selected checkpoints on 5,000 validation transitions. Evaluation used 5,000 records from each split; it did not tune from test or OOD results.

| Split | AUROC | AUPRC | Brier | ECE | NLL |
| --- | ---: | ---: | ---: | ---: | ---: |
| Validation | 0.9665 | 0.8064 | 0.0419 | 0.0470 | 0.1436 |
| Test | 0.9827 | 0.8998 | 0.0306 | 0.0457 | 0.1062 |
| OOD | 0.9841 | 0.8949 | 0.0267 | 0.0197 | 0.0938 |

The exact held-out schedule benchmark still covered all 5,292 validation/test/OOD schedules and all 2,646 deterministic counterexamples:

| Budget | Random | Coverage | Heuristic | Logistic | GNN |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 50 | 53 | 100 | 0 | 100 |
| 500 | 251 | 251 | 346 | 98 | 490 |
| 1,000 | 518 | 479 | 549 | 249 | 929 |
| 5,000 | 2,505 | 2,499 | 2,578 | 2,354 | 2,597 |

The controlled result is negative: the bounded main model ranked 4/1/1 concentration 0.00070 lower than 2/2/2. A one-epoch 2,000-record ablation was mixed; the flat MLP had higher test AUROC than the full model on that small slice, while removing the action embedding produced the largest test degradation. These results do not yet establish that relational topology caused the budget gain.

Machine-readable values and the remaining full-corpus acceptance work are recorded in `CLOUDPROOF-PHASE-II-B-BOUNDED-RESULTS.json`.

## Fast verification gate

```bash
python ml/cloudproof/tests/run_tests.py
node --test packages/cloudproof/gnn-risk-scorer.test.js \
  packages/cloudproof/transition-dataset.test.js sim/cloud-corpus.test.js
```

The local smoke gate generates a small deterministic corpus, trains all five ensemble members for one epoch, evaluates validation/test/OOD, and exercises the offline Node↔Python fixed-budget path. The existing repository CI workflow is unchanged.

No LLM, reinforcement learning, counterexample-guided retraining, Terraform, or simulator rewrite is part of Phase II-B.
