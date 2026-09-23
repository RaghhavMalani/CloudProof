# CloudProof Phase II-B.2 — Frozen-Corpus Graph Attribution

## Decision

**Graph attribution PASSED** under the five criteria fixed before training. On the 173
relational-only counterfactual pairs of the frozen causal corpus v2 — pairs whose members have
byte-identical node features, action and flat risk features and differ only in which
resource is related to which — the unchanged Phase II-B heterogeneous GNN ranks the
deterministically riskier member higher in 151/173 cases (tie-aware accuracy 0.873, bootstrap
95 % CI [0.821, 0.919], exact binomial p = 7.4 × 10⁻²⁵), the parameter-matched pooled MLP
ties all 173 pairs (0.500, by construction), removing every edge from the same frozen GNN
also ties all 173 (0.500), resampling the endpoints of every relation drops it to chance
(0.462–0.549 over three seeds), and the effect survives the clock-blind ablation (153/173,
0.884, CI [0.838, 0.931]) and replicates in independently trained K = 1 / 10 / 20 heads
(0.867 – 0.890, while every pooled head ties all 173). The narrow claim this supports:

> Relational topology contributes predictive information for CloudProof's controlled
> Kubernetes topology interventions.

It does not generalize to arbitrary Kubernetes or cloud systems, and it is a claim about
*controlled interventions*, not about the natural corpus distribution: on natural
validation/test/OOD transitions the topology-blind pooled MLP reaches the same AUROC as the
GNN (test 0.787 vs 0.790, OOD 0.712 vs 0.722, overlapping trajectory-bootstrap intervals),
so relational message passing is a real but small part of what the learned prioritizer does
on this corpus. The same code path records a negative verdict if any criterion fails; none
did.

## 1. Question and rules

Phase II-B.2 asks one question on the frozen causal corpus v2:

> Does relational graph structure improve prediction and deterministic verification
> prioritization once schedule-construction shortcuts have been removed?

The corpus is immutable input (`CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json`, generator commit
`42fda40`). Nothing in this phase regenerates, rebalances, prunes or rewrites it; every
command recomputes the six SHA-256 digests first and aborts on any difference. No model was
tuned after test, OOD or pair results were observed: the architecture, recipe, seeds,
edge-destruction modes, clock-blind field list, trajectory rule, tie tolerance, bootstrap
settings and the five attribution criteria are constants in `ml/cloudproof/phase_ii_b2.py`
and are written to `config.json` before training starts. No LLM, RL, simulator feature,
counterexample-guided retraining or pair-specific optimization is involved; the GNN, the
pooled MLP and the training loop are the ones committed in `b8b2b51`/`60df8a0`.

## 2. Frozen data verification

`python -m ml.cloudproof.phase_ii_b2 verify` (`frozen-corpus-verification.json`, 45 s)
recomputed every recorded digest independently of the manifest and compared corpus,
manifest and freeze record with each other:

| File | Bytes | SHA-256 (recomputed = frozen) |
| --- | ---: | --- |
| transitions-train.jsonl | 340 290 752 | `64f41d0de1c0fed9…4597163668d71ddbfbc` |
| transitions-validation.jsonl | 221 125 492 | `4d35134206a5bcb3…4ca1ac277702a67390116c` |
| transitions-test.jsonl | 138 038 411 | `f606dd5cc22c4a91…dada20bdbac6c630741f5f2` |
| transitions-ood.jsonl | 199 800 158 | `5c37b988b5813021…815537b7e270e0e59564d90` |
| counterfactual-pairs.jsonl | 41 802 721 | `547e27db11595417…d2157b405cc79f7e235c22` |
| trajectories.jsonl | 467 763 655 | `9d1b55f606986f6a…920c916abbf03be244ddff` |

Also verified: manifest kind/schema (`cloudproof.causal-corpus-manifest` v3,
`topology-holdout-v2`, outcome-blind generator, acceptance passed); 180 170 rows whose
`split` fields match their file and whose topologies match the catalog (train 8 /
validation 5 / test 3 / OOD 4 topologies, pairwise disjoint); trajectory IDs disjoint across
split files; every row references a selected trajectory; no row carries `nextState`; the
K = 5 label equals `horizons["5"]` on every row; tensorization is a pure function of the row
(200 rows per split tensorized twice); the trajectory pool has 50 000 entries with
4 856 + 4 856 selected and 5 838 held-out schedules containing 2 919 counterexamples; 2 000
pairs (1 944 valid, 344 safe→unsafe, 10 unsafe→safe); and for all 1 111 valid
relational-only pairs the per-type node-feature multisets and action features are identical
at the tensor level (an untrained pooled MLP emits a maximum logit gap of exactly 0.0 across
them). All 173 outcome-flipping relational-only pairs (164 safe→unsafe, 9 unsafe→safe;
node-concentration 86, readiness-wiring 55, readiness-drain 31, capacity-distribution 1;
train 83 / validation 45 / test 20 / OOD 25) have differing relation tensors; their sorted
`pairId:family:change:riskier` list has digest `9ad039a167032d69…daaa7440f2c`.

One corpus fact surfaced by the check is reported rather than hidden: 146 of the 1 111 valid
relational-only pairs (72 readiness-wiring, 73 readiness-drain, 1 node-concentration) are
byte-identical at the intervention row because their starting pods became ready during the
quiet prefix. All 146 are concordant, cannot flip, and play no role in the 173-pair test; the
relation-tensor check is therefore asserted for every discordant pair and counted (965 of
1 111) for the rest.

## 3. Model freeze

The Phase II-B configuration was recovered from `ml/cloudproof/train.py` and
`ml/cloudproof/model.py` at commit `b8b2b51`. The II-B.1 audit commit (`60df8a0`) added
ablation modes and a parameter-matched pooled MLP but left the `full` forward path and the
training loop functionally unchanged (`git diff b8b2b51 60df8a0 -- ml/cloudproof/`).

| Item | Frozen value |
| --- | --- |
| Architecture | `HeterogeneousRiskGNN`: per-type input encoders (Linear + ReLU) for Pod / Node / Deployment / Service / HPA / PDB / Zone |
| Hidden dimension | 48 |
| Layers | 2 relation layers |
| Relation handling | per-relation forward and reverse `Linear(48, 48, bias=False)` messages for RUNS_ON, OWNS, ROUTES_TO, LOCATED_IN, SELECTS, PROTECTS, SCALES; mean aggregation over incoming messages; per-type self transform; LayerNorm + ReLU + Dropout |
| Action encoder | `Linear(43, 48)` + ReLU + Dropout over the action-type one-hot, target-type one-hot, target-resolved flag and nine scaled parameters; concatenated with the resolved target-node embedding |
| Pooling | typed mean pooling over the seven resource types (7 × 48) |
| Risk head | `Linear(432, 48)` + ReLU + Dropout + `Linear(48, 1)` |
| Parameters | 123 793 (pooled MLP 137 665, 1.11×) |
| Optimizer | AdamW, learning rate 1e-3, weight decay 1e-4 |
| Batch size | 128; bounded-buffer shuffle of 2 048 records seeded per member and epoch |
| Epochs / early stopping | up to 20 epochs; patience 4 on validation NLL; best checkpoint restored |
| Loss | `BCEWithLogitsLoss` with `pos_weight = negatives / positives = 13.335` (train positive rate 6.98 %, outside [0.25, 0.75]) |
| Gradient clipping | global norm 5.0 |
| Ensemble | five members, seeds 1337, 2027, 4099, 7919, 104729; inference returns the member mean and population standard deviation |
| Normalization | fixed feature scales in the tensorizer; LayerNorm per resource type in every relation layer |
| Calibration | none post hoc; validation is used only for early stopping, checkpoint selection and the reported F1 threshold |
| Dropout | 0.1 |
| Determinism | `torch.use_deterministic_algorithms(True)`, one torch thread per member, CPU (`torch 2.7.1+cpu`, Python 3.12.0, NumPy 2.3.4) |

The pooled MLP (`flat-mlp` ablation) is the II-B.1 control unchanged: typed mean / min / max /
sum pools of the same node features plus the same action features, `Linear(187, 288)` + ReLU
+ Dropout + `Linear(288, 288)` + ReLU + Dropout + `Linear(288, 1)`, same recipe. The
randomized-edge, collapsed-edge-type, no-edge and random-relation-label controls are the
II-B.1 inference-time interventions on the frozen full GNN (`ml/cloudproof/perturb.py`).
Action-only and state-only baselines exist in the code base but were not retrained; their
II-B.1 numbers belong to the superseded corpus.

### 3.1 Adapters (the only changes on the model path)

| Change | Why | Effect on the frozen model |
| --- | --- | --- |
| `CausalCorpusManifest` + `open_corpus_manifest` (`dataset.py`) | the loop validated the v1 manifest kind and `topology-holdout-v1` | none; same file interface, adds the v2 contract and freeze verification |
| `label_horizon` on the tensorizer and `label_balance` | K = 1 / 10 / 20 heads read `labels.horizons[K]` | none for K = 5, which still reads `sloViolationWithinKTransitions` (asserted equal to `horizons["5"]`) |
| `clock_blind` mask on the tensorizer | predeclared ablation | zeroes two columns; tensor shapes and parameter count unchanged |
| `tensorizer` argument on `train_member`, `_validation_loader`, `predict_path`, `infer.py` | pass the clock-blind or horizon tensorizer through unchanged code | none when omitted |
| `edge_seed` plumbing and the `rewired-edges` mode (`perturb.py`) | several randomization seeds; a destruction that also removes degree structure | inference-time only |
| `phase_ii_b2.py`, `stats.py`, `tools/cloudproof-phase-ii-b2-benchmark.js` | driver, uncertainty, frozen-pool benchmark | none |

## 4. Training contract

Every member trains on `transitions-train.jsonl` only; `transitions-validation.jsonl` is read
once per epoch for early stopping and checkpoint selection and once at assembly for the
reported validation metrics and F1 threshold. The member process receives no test, OOD, pair
or trajectory path (`train-member` has no such arguments; a unit test asserts it), and the
first test/OOD read of any model happened in `evaluate`, after every checkpoint was frozen on
disk. Counterfactual pair labels and membership never enter training: pair records live in
`counterfactual-pairs.jsonl`, which no training path opens. The tensorizer reads `state` and
`action` only — a unit test tampers with pair labels, family, `relationalOnly`, pair ID,
split and topology and asserts identical tensors — so pair IDs, topology IDs, scenario IDs,
split IDs, trajectory outcome, failure class, transitions-to-failure, other horizon labels
and nuisance/matching metadata are unobservable by construction. Trajectory outcome is read
only by the evaluator, to label trajectories. Members were trained as one process per seed
(15 processes for K = 5, 12 concurrent), which is arithmetically identical to sequential
training because each member depends only on its seed and the data.

| Artifact | Best epoch per member | Epochs run | Member training seconds | Validation AUROC (ensemble) | Validation NLL |
| --- | --- | --- | ---: | ---: | ---: |
| Full GNN (`gnn-full-k5`) | 4, 7, 7, 6, 7 | 8, 11, 11, 10, 11 | 3 779 – 5 107 (23 834 total) | 0.7931 | 0.3101 |
| Pooled MLP (`pooled-mlp-k5`) | 9, 8, 7, 1, 4 | 13, 12, 11, 5, 8 | 1 825 – 5 158 (19 461 total) | 0.7935 | 0.3103 |
| Clock-blind GNN (`gnn-clock-blind-k5`) | 4, 7, 7, 6, 7 | 8, 11, 11, 10, 11 | 3 081 – 5 269 (19 587 total) | 0.7907 | 0.3125 |

Wall time for the K = 5 set was 7 792 s on a 24-thread laptop CPU with no GPU. The
secondary K = 1 / 10 / 20 heads (30 members) were trained in a second invocation that a
session teardown killed after 19 members had written both their weights and their member
record; a resume skipped those 19 and trained the remaining 11 (2 036 s). A member is only
ever skipped when both files exist, the record being written after the weights, so no member
was trained twice or assembled from a partial file. `training-summary.json` lists all three
invocations.

## 5. Clock-blind ablation

Declared before evaluation (`ml/cloudproof/constants.py`):

| Field | Encoded column | Treatment |
| --- | --- | --- |
| `HPA.features.sampledAtMs` | `HPA.sampled_at` | zeroed — the one absolute clock a scorer can read from the state graph (II-A.2.1 audit) |
| candidate action `atMs` | action parameter `atMs` | zeroed — absolute schedule time; already stripped from every v2 row, masked so the declaration is complete |
| `state.atMs` | — | never encoded by the tensorizer |
| `ms`, `delayMs`, `durationMs` | action parameters | kept — durations, not clocks |
| version numbers, readiness, replica counts, rollout/HPA activity | node features | kept — causal state variables that merely correlate with time |

The same architecture, recipe and seeds were trained on the masked representation; the
parameter count is identical. Results are in §8.

## 6. Edge destruction

All interventions act at inference on the frozen GNN, preserve node features, node counts,
action features, the action target and the per-relation edge count, and are seeded from the
record ID so a record always receives the same destroyed graph:

| Mode | What is destroyed | Seeds |
| --- | --- | --- |
| `randomized-edges` | target column of every relation permuted (II-B.1 control; per-node degree multisets preserved) | 1729, 2729, 3729 |
| `rewired-edges` | both endpoints resampled uniformly among type-compatible nodes; if the resampled multiset equals the original the targets are rolled, so the original graph is never reconstructed | 1729, 2729, 3729 |
| `no-edges` | every relation removed | — |
| `collapsed-edge-types` | every relation transform averaged (relation identity lost, wiring kept) | — |
| `random-relation-labels` | each relation routed through a fixed wrong relation transform (wiring kept) | — |

`rewired-edges` was added because the II-B.1 permutation keeps each node's degree, and the
node-concentration family differs from its control precisely by the degree of the crashing
node. The last two modes keep the wiring and are reported as diagnostics, not as
connectivity destruction.

## 7. Statistics

Pairwise accuracy is reported tie-aware (`(correct + 0.5·ties) / pairs`, ties at
`|margin| ≤ 1e-6` on the ensemble-mean risk) and strict, with a percentile bootstrap over
pairs (10 000 resamples, seed 20260922), a Wilson interval, and an exact two-sided binomial
test against 0.5 both with ties excluded and with ties counted as wrong. Model comparisons use
a paired bootstrap of the accuracy difference over the same pairs plus an exact McNemar test
on strict outcomes. Transition AUROC intervals resample trajectories, not rows (1 000
resamples), because rows of one trajectory are not independent. Trajectory-level scores use
the predeclared rule *maximum ensemble-mean risk over the trajectory's emitted rows (rows end
at the first incident); label = trajectory outcome* — the rule the corpus evaluation applies
to the heuristic and logistic baselines. Fixed-budget rankings are deterministic given the
scores; only the random baseline carries a seed (1337), and no repeated random trials are
claimed.

The attribution criteria, fixed in code before training:

1. full GNN tie-aware accuracy ≥ 0.60 on the 173 pairs, bootstrap 95 % lower bound > 0.5,
   binomial p (ties excluded) < 0.01;
2. pooled MLP tie-aware accuracy within [0.40, 0.60];
3. at least one destroyed-edge control loses ≥ 0.10 tie-aware accuracy with a
   paired-bootstrap interval excluding zero;
4. the clock-blind GNN satisfies criterion 1's accuracy and interval conditions;
5. the full-GNN interval excludes 0.5, lies entirely above the pooled-MLP interval, and at
   least one destroyed-control difference interval excludes zero.

## 8. Results

### 8.1 Relational-only outcome-flipping pairs — the attribution test (N = 173)

| Model / mode | Correct | Ties | Wrong | Tie-aware | Bootstrap 95 % | Wilson 95 % | Binomial p (ties excl.) | Mean margin | Median margin |
| --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |
| **Full GNN** | 151 | 0 | 22 | **0.873** | [0.821, 0.919] | [0.815, 0.915] | 7.4 × 10⁻²⁵ | 0.0730 | 0.0647 |
| **Pooled MLP** | 0 | 173 | 0 | **0.500** | [0.500, 0.500] | [0.426, 0.574] | — (all ties; p = 1.7 × 10⁻⁵² with ties as wrong) | 0.0000 | 0.0000 |
| **Clock-blind GNN** | 153 | 0 | 20 | **0.884** | [0.838, 0.931] | [0.828, 0.924] | 1.5 × 10⁻²⁶ | 0.0881 | 0.0651 |
| Full GNN, no-edges | 0 | 173 | 0 | 0.500 | [0.500, 0.500] | [0.426, 0.574] | — (all ties) | 0.0000 | 0.0000 |
| Full GNN, rewired-edges @1729 / @2729 / @3729 | 80 / 85 / 95 | 0 | 93 / 88 / 78 | 0.462 / 0.491 / 0.549 | [0.393, 0.538] / [0.416, 0.566] / [0.474, 0.624] | — | 0.36 / 0.88 / 0.22 | −0.0174 / −0.0146 / 0.0298 | — |
| Full GNN, randomized-edges @1729 / @2729 / @3729 | 111 / 110 / 113 | 36 / 35 / 34 | 26 / 28 / 26 | 0.746 / 0.737 / 0.751 | [0.688, 0.801] / [0.682, 0.792] / [0.697, 0.806] | — | < 10⁻⁶ | 0.0669 / 0.0668 / 0.0666 | — |
| Full GNN, collapsed-edge-types | 128 | 0 | 45 | 0.740 | [0.671, 0.804] | [0.670, 0.800] | 3 × 10⁻¹⁰ | 0.0081 | 0.0028 |
| Full GNN, random-relation-labels | 157 | 0 | 16 | 0.908 | [0.861, 0.948] | [0.855, 0.942] | < 10⁻²⁵ | 0.0140 | 0.0146 |
| Clock-blind, no-edges | 0 | 173 | 0 | 0.500 | [0.500, 0.500] | — | — | 0.0000 | 0.0000 |
| Clock-blind, rewired-edges @1729 / @2729 / @3729 | 81 / 88 / 98 | 0 | 92 / 85 / 75 | 0.468 / 0.509 / 0.566 | [0.399, 0.543] / [0.434, 0.584] / [0.491, 0.642] | — | 0.45 / 0.88 / 0.09 | — | — |
| Clock-blind, randomized-edges @1729 / @2729 / @3729 | 110 / 110 / 112 | 36 / 35 / 34 | 27 / 28 / 27 | 0.740 / 0.737 / 0.746 | [0.682, 0.798] / [0.682, 0.792] / [0.691, 0.801] | — | < 10⁻⁶ | — | — |
| Clock-blind, collapsed-edge-types | 123 | 0 | 50 | 0.711 | [0.642, 0.775] | — | 3 × 10⁻⁸ | 0.0076 | 0.0023 |
| Clock-blind, random-relation-labels | 50 | 0 | 123 | 0.289 | [0.225, 0.358] | — | < 10⁻⁷ (below chance) | −0.0062 | −0.0048 |

Reading the controls: the pooled MLP and the no-edge GNN tie every pair *exactly* (margin
0.0), because relational-only pair members have identical node sets and identical action, so
their inputs are literally the same tensors — any score difference in the full GNN can only
come from the edges. Uniform rewiring, which destroys degree structure as well as endpoint
identity, removes the effect entirely.

Decomposing the destroyed modes by family (full GNN, tie-aware accuracy) shows the two
surviving families rest on *different* graph properties:

| Mode | node-concentration (n = 86) | readiness-wiring (n = 55) | readiness-drain (n = 31) | overall |
| --- | ---: | ---: | ---: | ---: |
| full | 0.965 | 0.927 | 0.548 | 0.873 |
| randomized-edges @1729 / @2729 / @3729 | 0.965 / 0.953 / 0.965 | 0.555 / 0.545 / 0.509 | 0.500 / 0.500 / 0.613 | 0.746 / 0.737 / 0.751 |
| rewired-edges @1729 | 0.465 | 0.436 | 0.516 | 0.462 |
| no-edges | 0.500 | 0.500 | 0.500 | 0.500 |
| collapsed-edge-types | 0.953 | 0.418 | 0.742 | 0.740 |
| random-relation-labels | 0.988 | 0.927 | 0.677 | 0.908 |

The node-concentration signal is a **degree** effect: the pair differs in how many pods sit on
the node that then crashes, so a degree-preserving target permutation leaves it untouched
(0.965 under every seed) and only uniform rewiring destroys it (0.465). The readiness-wiring
signal is an **endpoint-identity** effect: which zone the unready pods are related to cannot
survive a permutation, and it collapses from 0.927 to 0.51–0.56 (with 25 pairs becoming ties)
while still needing the edges to exist at all. This is why the II-B.1 permutation control —
the only edge destruction that phase ran — was too weak to detect either: it removes one of
the two effects and leaves the larger one intact, and on natural data it is invisible
altogether (§8.5). The two wiring-preserving diagnostics confirm the reading from the other
side: keeping the wiring but averaging (collapsed types) or mislabelling (random relation
labels) the relation transforms leaves the degree-driven family at 0.95–0.99 and perturbs the
identity-driven one, and for the clock-blind model random relation labels invert it
(node-concentration 0.035, overall 0.289) — a mis-routed graph, not an absent one.

Breakdown of the intact models:

| | Full GNN | Clock-blind GNN |
| --- | --- | --- |
| safe→unsafe (n = 164) | 151 correct (0.921) | 153 correct (0.933) |
| unsafe→safe (n = 9) | 0 correct (0.000) | 0 correct (0.000) |
| node-concentration (n = 86) | 0.965 | 0.965 |
| readiness-wiring (n = 55) | 0.927 | 0.982 |
| readiness-drain (n = 31) | 0.548 | 0.516 |
| capacity-distribution (n = 1) | 0/1 | 0/1 |
| train topologies (n = 83) | 0.928 | 0.928 |
| validation topologies (n = 45) | 0.867 | 0.844 |
| test topologies (n = 20) | 0.600 | 0.750 |
| OOD topologies (n = 25) | 0.920 | 0.920 |
| held-out topologies together (n = 90) | 0.822 [0.744, 0.900], p = 4.4 × 10⁻¹⁰ | 0.844 [0.767, 0.911], p = 1.8 × 10⁻¹¹ |
| relational-only, horizon-5 truth (n = 232) | 0.927 [0.892, 0.957] | 0.927 [0.892, 0.957] |
| placement families, flat-visible (n = 181) | 0.994 [0.983, 1.000] | 0.994 [0.983, 1.000] |
| all valid discordant pairs (n = 354) | 0.935 [0.910, 0.958] | 0.941 [0.915, 0.963] |

Two honest limits of the effect. First, every one of the nine unsafe→safe flips is ranked
wrong: eight are readiness-drain pairs, and on that family the GNN is at chance (17/31). The
model has learned a fixed relational preference per family — unready pods *outside* the
drained node read as riskier — which is right for the 23 majority-direction pairs and wrong
for the 8 minority ones; it is not reading the fine-grained causal outcome. Second, the test
split's 0.60 is a family-mix effect (8 of its 20 flips are readiness-drain versus 14 of 83 in
train) at n = 20; the pooled held-out estimate of 0.82 is the number to quote. The placement
families (zone / node / PDB placement), which the heuristic ranks perfectly through its
`zoneConcentration` feature and the pooled MLP cannot see at all, are ranked 180/181 by the
GNN.

### 8.2 Paired comparisons on the 173 pairs

| Comparison | Δ tie-aware accuracy | Paired bootstrap 95 % | McNemar (left-only / right-only) | McNemar p |
| --- | ---: | --- | --- | ---: |
| Full GNN vs pooled MLP | +0.373 | [0.321, 0.419] | 151 / 0 | 7.0 × 10⁻⁴⁶ |
| Full GNN vs no-edges | +0.373 | [0.321, 0.419] | 151 / 0 | 7.0 × 10⁻⁴⁶ |
| Full GNN vs rewired-edges @1729 / @2729 / @3729 | +0.410 / +0.382 / +0.324 | [0.324, 0.497] / [0.283, 0.474] / [0.237, 0.410] | 79/8, 79/13, 66/10 | 8 × 10⁻¹⁶, 1 × 10⁻¹², 3 × 10⁻¹¹ |
| Full GNN vs randomized-edges @1729 / @2729 / @3729 | +0.127 / +0.136 / +0.121 | [0.066, 0.191] / [0.075, 0.197] / [0.055, 0.188] | 47/7, 47/6, 46/8 | 2 × 10⁻⁸, 6 × 10⁻⁹, 1 × 10⁻⁷ |
| Full GNN vs collapsed-edge-types | +0.133 | [0.064, 0.202] | 32 / 9 | 4.3 × 10⁻⁴ |
| Full GNN vs random-relation-labels | −0.035 | [−0.087, 0.017] | 8 / 14 | 0.29 |
| Full GNN vs clock-blind GNN | −0.012 | [−0.035, 0.012] | 1 / 3 | 0.63 |

Verdict (`statistical-tests.json → attribution`): criterion 1 passed (0.873, CI lower 0.821,
p = 7.4 × 10⁻²⁵); 2 passed (0.500); 3 passed (no-edges, all rewired seeds, all randomized
seeds and collapsed types each drop ≥ 0.10 with intervals excluding zero; random-relation-
labels does not, as expected of a wiring-preserving mode); 4 passed (0.884, CI lower 0.838);
5 passed (full-GNN interval [0.821, 0.919] excludes 0.5 and lies above the pooled interval
[0.500, 0.500]; destroyed-control differences exclude zero). **PASSED.**

### 8.3 Transition-level metrics on natural data (K = 5)

| Model | Split | AUROC [95 % trajectory bootstrap] | AUPRC | Brier | ECE | NLL |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Full GNN | validation | 0.7931 [0.7823, 0.8034] | 0.3641 | 0.0886 | 0.1371 | 0.3101 |
| Full GNN | test | 0.7904 [0.7766, 0.8036] | 0.3711 | 0.0707 | 0.1040 | 0.2622 |
| Full GNN | OOD | 0.7221 [0.7084, 0.7356] | 0.2328 | 0.1530 | 0.2619 | 0.4829 |
| Pooled MLP | validation | 0.7935 [0.7827, 0.8037] | 0.3345 | 0.0896 | 0.1420 | 0.3103 |
| Pooled MLP | test | 0.7873 [0.7725, 0.8014] | 0.3373 | 0.0756 | 0.1085 | 0.2715 |
| Pooled MLP | OOD | 0.7122 [0.6959, 0.7275] | 0.2143 | 0.2411 | 0.3527 | 0.7134 |
| Clock-blind GNN | validation | 0.7907 [0.7801, 0.8010] | 0.3610 | 0.0891 | 0.1367 | 0.3125 |
| Clock-blind GNN | test | 0.7869 [0.7726, 0.8005] | 0.3682 | 0.0694 | 0.1005 | 0.2593 |
| Clock-blind GNN | OOD | 0.7113 [0.6972, 0.7251] | 0.2254 | 0.1572 | 0.2669 | 0.4961 |

Positive rates: validation 7.3 %, test 7.0 %, OOD 7.1 %. The corpus's own linear baselines
on the same rows are heuristic 0.60 / 0.58 / 0.55 and logistic 0.64 / 0.61 / 0.54 AUROC
(validation / test / OOD), and the frozen ShortcutProbe sits at 0.55 / 0.58 / 0.51. The
Phase II-B numbers on the superseded corpus (test 0.98, OOD 0.98) are gone, as a repaired
corpus predicts. The GNN and the pooled MLP are statistically indistinguishable in AUROC
(test +0.003, OOD +0.010, overlapping intervals); the GNN has a slightly higher AUPRC on
every split and is markedly better calibrated on OOD (NLL 0.48 vs 0.71, Brier 0.15 vs 0.24).
The clock-blind GNN matches the full GNN within 0.004 test / 0.011 OOD AUROC: `HPA.sampledAtMs`
carries almost nothing.

### 8.4 Trajectory-level metrics (maximum risk over emitted rows)

| Model | Split | Trajectories (unsafe) | AUROC [95 %] | AUPRC | Brier |
| --- | --- | ---: | ---: | ---: | ---: |
| Full GNN | validation | 2 720 (1 360) | 0.7116 [0.6925, 0.7313] | 0.7202 | 0.2329 |
| Full GNN | test | 1 510 (755) | 0.7708 [0.7471, 0.7946] | 0.7727 | 0.2049 |
| Full GNN | OOD | 1 608 (804) | 0.6479 [0.6204, 0.6738] | 0.6098 | 0.3189 |
| Pooled MLP | validation | 2 720 | 0.7299 [0.7124, 0.7489] | 0.7202 | 0.2323 |
| Pooled MLP | test | 1 510 | 0.7625 [0.7399, 0.7861] | 0.7459 | 0.2139 |
| Pooled MLP | OOD | 1 608 | 0.6277 [0.6001, 0.6546] | 0.6346 | 0.3709 |
| Clock-blind GNN | validation | 2 720 | 0.7100 [0.6907, 0.7293] | 0.7215 | 0.2353 |
| Clock-blind GNN | test | 1 510 | 0.7713 [0.7472, 0.7934] | 0.7760 | 0.2035 |
| Clock-blind GNN | OOD | 1 608 | 0.6454 [0.6180, 0.6709] | 0.5955 | 0.3252 |
| corpus heuristic (same rule) | validation / test / OOD | | 0.512 / 0.468 / 0.503 | | |
| corpus logistic (same rule) | validation / test / OOD | | 0.531 / 0.540 / 0.492 | | |

All three learned ensembles separate whole trajectories far above the linear baselines, which
are at chance at this level; among them the ordering flips between validation (pooled MLP
ahead by 0.018) and the held-out topologies (GNN ahead by 0.008 test / 0.020 OOD) with
overlapping intervals.

### 8.5 Edge destruction on natural data (frozen full GNN)

| Mode | Δ AUROC validation / test / OOD | Δ NLL test / OOD | Trajectory AUROC test / OOD |
| --- | ---: | ---: | ---: |
| full (absolute) | 0.7931 / 0.7904 / 0.7221 | 0.2622 / 0.4829 | 0.7708 / 0.6479 |
| randomized-edges (mean of 3 seeds) | −0.0005 / −0.0030 / +0.0003 | +0.002 / −0.002 | 0.754 / 0.643 |
| rewired-edges (mean of 3 seeds) | −0.0424 / −0.0471 / −0.0149 | +0.170 / +0.209 | 0.613 / 0.621 |
| no-edges | −0.0999 / −0.0558 / +0.0080 | +0.142 / +0.102 | 0.590 / 0.604 |
| collapsed-edge-types | −0.0545 / −0.0375 / +0.0196 | +0.068 / −0.013 | 0.635 / 0.633 |
| random-relation-labels | −0.0895 / −0.0451 / +0.0057 | +0.020 / −0.097 | 0.593 / 0.622 |

The clock-blind GNN behaves the same way (`ablations.json`). As in II-B.1, the degree-
preserving permutation is functionally invisible on natural data; unlike II-B.1, rewiring or
removing edges now costs 0.04–0.10 transition AUROC on validation/test and drops trajectory-
level test AUROC from 0.77 to about 0.60. The GNN therefore *uses* its edges on natural data,
but the pooled MLP reaches the same natural-data AUROC without them, so on the natural
distribution the edges are one route to a signal that is also available through pooled
features. On OOD (8–12 replicas) transition AUROC is flat or slightly higher without edges
while NLL and trajectory ranking still degrade; the mean-aggregating layers extrapolate
poorly to larger graphs.

### 8.6 Fixed-budget verification on the frozen held-out pool

The pool is every selected validation/test/OOD trajectory of the frozen corpus: 5 838
schedules (validation 2 720, test 1 510, OOD 1 608) containing 2 919 counterexamples — exactly
50 %, because the corpus is outcome-matched. All 5 838 replay fingerprints matched the frozen
record, the run produced 62 039 unique state/action inference requests, and the Phase I
flagship artifact replayed byte-identically inside the same run. Counterexamples found:

| Prioritizer | 100 | 500 | 1 000 | 5 000 | Schedules to first CE | Failure classes @1 000 | Mean CE length @1 000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Random (seed 1337) | 50 | 254 | 487 | 2 493 | 6 | 5 | 89.3 |
| Coverage-guided | **73** | **302** | **608** | 2 603 | 1 | 5 | 89.3 |
| Heuristic | 42 | 237 | 495 | 2 536 | 3 | 5 | 90.5 |
| Logistic | 30 | 242 | 488 | 2 514 | 2 | 5 | 91.8 |
| Pooled MLP | 50 | 280 | 523 | 2 508 | 1 | 5 | 89.4 |
| Full GNN | 62 | 277 | 582 | 2 564 | 2 | 5 | 91.1 |
| GNN, randomized edges | 62 | 276 | 579 | 2 556 | 2 | 5 | 91.2 |
| GNN, rewired edges | 53 | 258 | 529 | 2 547 | 4 | 5 | 93.7 |
| GNN, no edges | 61 | 241 | 503 | **2 604** | 1 | 5 | 91.7 |
| Clock-blind GNN | 51 | 297 | 566 | 2 580 | 2 | 5 | 90.6 |

Every method finds all five failure classes by budget 1 000, and verification wall time is
essentially identical across methods (698 – 729 s for 5 000 schedules) because the same
deterministic verifier replays the same schedules in a different order.

The ranking given the scores is deterministic; only the random baseline is seeded, so there
are no repeated random trials to average. To give the comparison a scale anyway, an
*uninformative* ranking of this pool follows a hypergeometric distribution (N = 5 838,
K = 2 919), whose standard deviation is 4.96 / 10.69 / 14.39 / 13.40 counterexamples at the
four budgets. In those units the full GNN sits at z = +2.4 / +2.5 / **+5.7** / +4.8 and
coverage-guided at +4.6 / +4.9 / **+7.5** / +7.7, while random is at 0.0 / +0.4 / −0.9 / −0.5
and the two linear baselines are at or below chance at the small budgets (logistic z = −4.0 at
budget 100).

Three honest readings. First, **the learned prioritizers no longer dominate**: on the matched
corpus the non-learned coverage-guided strategy is the best method at every budget below
5 000, and the heuristic and logistic baselines are at or below chance — the free lunch the
Phase II-A corpus handed every method is gone. Second, **the GNN is genuinely above chance and
above the pooled MLP** at budget 1 000 (582 vs 523, z = +5.7 vs +1.6), so the graph model is
the better learned ranker here, but the margin over its own randomized-edge control is a
single counterexample (582 vs 579) — exactly the invariance Phase II-B.1 reported, and exactly
what §8.1 predicts, since the degree-preserving permutation leaves the dominant
node-concentration signal intact. Third, **destroying the graph more thoroughly does cost
budget performance** (rewired 529, no-edges 503 at budget 1 000), but the no-edge model is the
best method of all at budget 5 000, so the effect is an ordering effect at small budgets, not
a uniform capability gap.

As the brief requires: no topology attribution is claimed from these numbers. The
relational-only pair experiment (§8.1) is the attribution test; this table measures a
different thing — how well each score orders a 50/50 pool of whole schedules — and its main
message is that a matched corpus makes deterministic coverage competitive with everything
learned.

### 8.7 Secondary horizons

K = 5 stays the primary target. For K = 1, 10 and 20 the *unchanged* architecture and recipe
were trained as independent heads (five seeds each) that read `labels.horizons[K]` instead of
the K = 5 label; nothing else differs, and `pos_weight` is recomputed from each horizon's train
prevalence as the frozen rule prescribes. The frozen K = 5 GNN scored against the other
horizon labels is shown alongside. Transition metrics on each head's own label:

| K | Positive rate val / test / OOD | Model | AUROC val / test / OOD | AUPRC val / test / OOD | NLL test / OOD | Best epochs |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 2.5 % / 2.5 % / 2.4 % | GNN head | 0.9665 / 0.9803 / 0.9663 | 0.5104 / 0.5944 / 0.4365 | 0.0853 / 0.1298 | 5, 6, 7, 5, 2 |
| 1 | 2.5 % / 2.5 % / 2.4 % | Pooled MLP head | 0.9691 / 0.9737 / 0.9619 | 0.4644 / 0.5065 / 0.3867 | 0.0966 / 0.1545 | 3, 3, 3, 4, 2 |
| 1 | | frozen K = 5 GNN, scored at K = 1 | 0.9278 / 0.9479 / 0.9369 | 0.3548 / 0.5108 / 0.3262 | 0.2095 / 0.4590 | — |
| 5 | 7.3 % / 7.0 % / 7.1 % | GNN head | 0.7931 / 0.7904 / 0.7221 | 0.3641 / 0.3711 / 0.2328 | 0.2622 / 0.4829 | 4, 7, 7, 6, 7 |
| 5 | 7.3 % / 7.0 % / 7.1 % | Pooled MLP head | 0.7935 / 0.7873 / 0.7122 | 0.3345 / 0.3373 / 0.2143 | 0.2715 / 0.7134 | 9, 8, 7, 1, 4 |
| 10 | 11.9 % / 11.3 % / 11.7 % | GNN head | 0.7150 / 0.7108 / 0.6268 | 0.3355 / 0.3408 / 0.2217 | 0.3443 / 0.5716 | 6, 3, 3, 6, 7 |
| 10 | 11.9 % / 11.3 % / 11.7 % | Pooled MLP head | 0.7382 / 0.7232 / 0.6277 | 0.3503 / 0.3323 / 0.2110 | 0.3508 / 0.9177 | 6, 8, 6, 1, 4 |
| 10 | | frozen K = 5 GNN, scored at K = 10 | 0.7172 / 0.7139 / 0.6339 | 0.3551 / 0.3490 / 0.2317 | 0.3347 / 0.5253 | — |
| 20 | 19.7 % / 18.7 % / 19.5 % | GNN head | 0.6717 / 0.6708 / 0.6041 | 0.3773 / 0.3620 / 0.2810 | 0.4564 / 0.6473 | 2, 5, 3, 4, 2 |
| 20 | 19.7 % / 18.7 % / 19.5 % | Pooled MLP head | 0.6935 / 0.6798 / 0.5926 | 0.4044 / 0.3647 / 0.2783 | 0.4549 / 1.1001 | 2, 5, 6, 6, 7 |
| 20 | | frozen K = 5 GNN, scored at K = 20 | 0.6617 / 0.6656 / 0.5884 | 0.3864 / 0.3775 / 0.2822 | 0.4663 / 0.5939 | — |

Relational-only pairs (trajectory-outcome truth, N = 173) under each independently trained head:

| K | GNN head: correct / ties / tie-aware [95 % CI] | Pooled MLP head |
| ---: | --- | --- |
| 1 | 154 / 0 / 0.890 [0.844, 0.936] | 0 / 173 / 0.500 |
| 5 | 151 / 0 / 0.873 [0.821, 0.919] | 0 / 173 / 0.500 |
| 10 | 154 / 0 / 0.890 [0.844, 0.936] | 0 / 173 / 0.500 |
| 20 | 150 / 0 / 0.867 [0.815, 0.913] | 0 / 173 / 0.500 |

Three readings. First, **the topology result replicates at every horizon**: each
independently trained GNN head ranks the 173 relational-only flips at 0.867 – 0.890 with
intervals well above chance, and each pooled-MLP head ties all 173 (by construction), so the
§8.1 finding is not an artefact of the K = 5 label or of one training run. Second, **on
natural data neither model is consistently ahead in AUROC**: GNN − pooled differences range
from −0.023 to +0.012 over the twelve horizon × split cells; the pooled MLP leads on validation
at K = 10 and 20 (by 0.023 and 0.022), the GNN leads on test at K = 1 (by 0.007, the only
cell whose trajectory-bootstrap intervals do not overlap), and every other cell is within
±0.012 with overlapping intervals (marginal intervals, not a paired test). The GNN is
consistently better calibrated out of distribution (OOD NLL 0.130 vs 0.155, 0.572 vs 0.918,
0.647 vs 1.100 at K = 1 / 10 / 20). Third, the task gets harder
with horizon, as it should on a corpus without construction shortcuts: K = 1 is easy
(AUROC ≈ 0.97, because the imminent incident is usually visible in the current state), and
AUROC falls to ≈ 0.67 at K = 20. A dedicated head beats the frozen K = 5 model scored at the
same horizon only at K = 1 (AUPRC 0.59 vs 0.51 on test); at K = 10 and 20 the K = 5 model is
as good as a head trained for that horizon.

### 8.8 Clock-blind summary

`clock-blind.json` places the two GNNs side by side. Masking the clock changes nothing
material: transition AUROC −0.002 / −0.004 / −0.011 (validation / test / OOD), trajectory
AUROC within 0.003, relational-only pair accuracy +0.012 (paired interval [−0.035, 0.012]),
and every edge-destruction control moves the same way. Timing is not carrying the prediction.

## 9. Scientific conclusion

Graph attribution **PASSED**. On the frozen causal corpus v2, where node features, action and
flat risk features are identical within each relational-only pair by construction, the
unchanged Phase II-B heterogeneous GNN ranks the deterministically riskier topology correctly
in 87 % of the 173 outcome-flipping pairs (95 % CI 82–92 %, 82 % on the 90 pairs from
held-out topologies), the topology-blind pooled MLP ties every pair, removing or uniformly
rewiring the edges of the very same frozen GNN returns it to chance, and the effect survives
the clock-blind ablation (88 %) and replicates in heads trained independently for K = 1, 10
and 20 (87 – 89 %). This supports the narrow claim that relational topology
contributes predictive information for CloudProof's controlled Kubernetes topology
interventions.

What the decomposition (§8.1) adds is *which* relational property is being used: the
node-concentration family is a degree effect (how many pods the crashing node carries), which
survives a degree-preserving permutation untouched at 0.965 and dies only under uniform
rewiring; the readiness-wiring family is an endpoint-identity effect (which zone the unready
pods sit in), which the permutation already destroys, dropping it from 0.927 to about 0.53.
Both need the edges to exist — with no edges the model cannot separate any pair, because the
inputs are then literally identical. This also explains why Phase II-B.1 concluded the
opposite from the same architecture: its only edge destruction was the degree-preserving
permutation, which removes one of the two effects and leaves the larger one intact, and on
natural data it is invisible altogether.

Three limits bound the claim. It does not show that relational message passing drives the
natural-corpus prioritization gain — on natural transitions and trajectories the pooled MLP is
statistically indistinguishable from the GNN in AUROC, the GNN's advantage being confined to
AUPRC and OOD calibration. It is a fixed per-family preference rather than a read of the
causal outcome: all nine unsafe→safe flips are ranked wrong, and readiness-drain sits at
chance. And it rests on 173 pairs from four synthetic intervention families in one
single-service twin, so it does not generalize to arbitrary Kubernetes or cloud systems.

## 10. Regression

| Suite | Command | Result |
| --- | --- | --- |
| Python (`ml/cloudproof`) | `python ml/cloudproof/tests/run_tests.py` | 39 / 39 pass (21 existing + 18 new) |
| Node (CI command) | `node --test sim/*.test.js packages/*/*.test.js refund-provider/*.test.js tools/*.test.js` | 157 / 157 pass |
| Replica | `cd replica && npm test` | 69 / 69 pass |
| Phase I byte-identical replay | `node tools/cloudproof.js replay --file artifacts/cloudproof/failure-1337.json`; also recorded by the benchmark (`phaseOneReplay.byteIdentical`) | `REPRODUCED BYTE-IDENTICALLY: ROLLOUT_AVAILABILITY_VIOLATION` |
| `git diff --check` | | clean |

New tests: `ml/cloudproof/tests/test_phase_ii_b2.py` (frozen hash verification and freeze
drift, v2 manifest contract, clock-blind field list and invariance, edge-destruction
preservation/change/seeding, horizon label selection, pair labels never entering features,
relational pair checks on the committed fixture, the pairwise metric and verdict logic, exact
binomial / Wilson / McNemar / bootstraps / vectorized AUROC, seed-deterministic member
training on train + validation only, and the `train-member` CLI having no test/OOD inputs)
and `tools/cloudproof-phase-ii-b2-benchmark.test.js` (scorer specs, replayed candidates equal
to the pipeline's own `compactCandidate`, fingerprint/outcome drift rejection, request
deduplication, coverage compaction that changes no metric, flat-feature identity on the
fixture, frozen-file verification).

## 11. Reproduction

```bash
python -m ml.cloudproof.phase_ii_b2 verify
python -m ml.cloudproof.phase_ii_b2 train --models gnn-full,pooled-mlp,gnn-clock-blind --horizons 5 --concurrency 12
python -m ml.cloudproof.phase_ii_b2 evaluate --concurrency 8
python -m ml.cloudproof.phase_ii_b2 pairs
node tools/cloudproof-phase-ii-b2-benchmark.js \
  --scorer gnn=artifacts/cloudproof/phase-ii-b2/models/gnn-full-k5 \
  --scorer gnnRandomizedEdges=artifacts/cloudproof/phase-ii-b2/models/gnn-full-k5:randomized-edges:1729 \
  --scorer gnnRewiredEdges=artifacts/cloudproof/phase-ii-b2/models/gnn-full-k5:rewired-edges:1729 \
  --scorer gnnNoEdges=artifacts/cloudproof/phase-ii-b2/models/gnn-full-k5:no-edges \
  --scorer pooledMlp=artifacts/cloudproof/phase-ii-b2/models/pooled-mlp-k5 \
  --scorer gnnClockBlind=artifacts/cloudproof/phase-ii-b2/models/gnn-clock-blind-k5
python -m ml.cloudproof.phase_ii_b2 train --models gnn-full,pooled-mlp --horizons 1,10,20 --concurrency 15
python -m ml.cloudproof.phase_ii_b2 evaluate --concurrency 8
python -m ml.cloudproof.phase_ii_b2 pairs
python -m ml.cloudproof.phase_ii_b2 report
```

All commands default to `--corpus artifacts/cloudproof/causal-corpus-v2 --freeze
CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json --out artifacts/cloudproof/phase-ii-b2` and abort
on any digest mismatch. `train` and `evaluate` are resumable (finished members and prediction
files are skipped).

## 12. Files

```
CLOUDPROOF-PHASE-II-B2.md                       this report
artifacts/cloudproof/phase-ii-b2/
  config.json                                   frozen recipe, models, criteria, field lists, trained artifacts
  frozen-corpus-verification.json               recomputed digests, counts, split integrity, pair checks
  metrics.json                                  transition metrics per artifact/split with trajectory-bootstrap AUROC intervals; secondary-horizon scoring
  trajectory-metrics.json                       maximum-risk trajectory metrics with intervals; corpus baselines
  counterfactual-ranking.json                   every model × mode × seed on every pair set
  statistical-tests.json                        primary pair statistics, paired comparisons, attribution verdict
  ablations.json                                edge destruction on natural data
  clock-blind.json                              full vs clock-blind GNN side by side
  fixed-budget.json                             frozen-pool verification benchmark, Phase I replay, flat-feature identity
                                                (controller-state signature lists replaced by count + SHA-256;
                                                the full 9.7 MB export stays local in raw/fixed-budget-full.json)
  training-summary.json                         epochs, seconds, validation metrics per artifact
  manifest.json                                 git state, environment, SHA-256 of every artifact file and model weight
  models/<artifact>/{config,metrics,manifest,member-i}.json   per-model provenance (weights *.pt are gitignored, hashed in manifest.json)
```
