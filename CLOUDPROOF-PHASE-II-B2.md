# CloudProof Phase II-B.2 — Frozen-Corpus Graph Attribution

> **Status (2026-09-23).** The primary experiment is complete. **Graph attribution PASSED** on
> the preregistered relational-only test (K = 5, N = 173 decisive pairs). This report was
> restructured after an independent audit. The audit re-derived the 173 pairs from the frozen
> corpus, re-scored them with the frozen weights and reproduced every committed pair statistic
> exactly (`pair-audit.json`). No model was retrained and no threshold or rule changed, so the
> verdict stands. Every numeric table below is rendered from the result JSON by
> `python -m ml.cloudproof.phase_ii_b2_report`, and a unit test fails if the tables and the
> artifacts disagree. Appendix E lists what the audit changed.

## Decision

<!-- generated:headline -->
| Arm (N = 173 decisive pairs) | Correct | Wrong | Ties | Tie-aware accuracy [bootstrap 95 %] | Exact binomial p (ties excluded) | Full GNN minus arm [paired bootstrap 95 %] |
| --- | ---: | ---: | ---: | --- | ---: | --- |
| **Full GNN** | 151 | 22 | 0 | 0.873 [0.821, 0.919] | 7.4 × 10⁻²⁵ | — |
| Pooled MLP | 0 | 0 | 173 | 0.500 [0.500, 0.500] | — | +0.373 [+0.321, +0.419] |
| Full GNN, no edges | 0 | 0 | 173 | 0.500 [0.500, 0.500] | — | +0.373 [+0.321, +0.419] |
| Full GNN, randomized edges @1729 | 111 | 26 | 36 | 0.746 [0.688, 0.801] | 1.0 × 10⁻¹³ | +0.127 [+0.066, +0.191] |
| Full GNN, randomized edges @2729 | 110 | 28 | 35 | 0.737 [0.682, 0.792] | 1.1 × 10⁻¹² | +0.136 [+0.075, +0.197] |
| Full GNN, randomized edges @3729 | 113 | 26 | 34 | 0.751 [0.697, 0.806] | 4.0 × 10⁻¹⁴ | +0.121 [+0.055, +0.188] |
| Full GNN, rewired edges @1729 | 80 | 93 | 0 | 0.462 [0.393, 0.538] | 0.36 | +0.410 [+0.324, +0.497] |
| Full GNN, rewired edges @2729 | 85 | 88 | 0 | 0.491 [0.416, 0.566] | 0.88 | +0.382 [+0.283, +0.474] |
| Full GNN, rewired edges @3729 | 95 | 78 | 0 | 0.549 [0.474, 0.624] | 0.22 | +0.324 [+0.237, +0.410] |
| Clock-blind GNN | 153 | 20 | 0 | 0.884 [0.838, 0.931] | 1.5 × 10⁻²⁶ | −0.012 [−0.035, +0.012] |

Verdict recorded in `statistical-tests.json`: **PASSED**.
<!-- /generated:headline -->

This result supports one claim and nothing broader:

> On controlled CloudProof Kubernetes interventions where pooled features are identical,
> relational message passing provides predictive information about simulator-derived safety
> outcomes.

Deterministic CloudProof remains the verifier. The learned model orders schedules for
verification. It does not prove, certify or guarantee anything about Kubernetes safety.

What the result does **not** show (each point is documented below):

- **Natural data.** On natural validation/test/OOD transitions the topology-blind pooled MLP
  matches the GNN in AUROC (§6). On the fixed-budget pool, deterministic coverage-guided
  search beats every learned prioritizer below budget 5 000 (§10).
- **Degree carries most of the signal.** A degree-preserving edge permutation still leaves
  the model at 0.74–0.75, and only uniform rewiring returns it to chance (§8). On the 45 pairs
  from topologies never used in training or model selection, the full GNN's lead over the
  degree-preserving control cannot be told apart from zero (§11.3, post hoc).
- **A per-family preference, not the causal outcome.** The model ranks the intervened
  arrangement as riskier within each family. All nine unsafe→safe flips are ranked wrong (§7).

## 1. Research question

> Does relational graph structure contribute predictive information?

`config.json` records the question more broadly: *does relational graph structure improve
prediction and deterministic verification prioritization once schedule-construction shortcuts
have been removed?* Prediction is the attribution question (§7). Prioritization is answered
separately and does not count as attribution evidence (§10).

The decisive form of the question was written down before any Phase II-B.2 model existed
(`CLOUDPROOF-PHASE-II-A2-CAUSAL-CORPUS.md`, commit `7dee7eb`, 2026-09-22 09:13 IST): *whether a
GNN ranks the 173 relational-only flips above chance and whether randomizing its edges removes
that ability.*

A relational-only pair has these properties:

- The two members have identical node features (as multisets, per resource type), an
  identical candidate action and identical flat risk features.
- They differ only in which resource is related to which.
- The deterministic simulator says one trajectory stays safe and the other fails.

A model that sees only pooled features must therefore tie every such pair, so any correct
ranking has to come from the edges.

K = 5, the probability of an SLO violation within the next five transitions, is the
preregistered primary target. K = 1, 10 and 20 are secondary and exploratory (Appendix A) and
support no claim here. The natural-data metrics (§6) and the fixed-budget benchmark (§10)
report context and operational usefulness. Neither counts as attribution evidence.

## 2. Why Phase II-B.1 failed

Phase II-B.1 (`CLOUDPROOF-PHASE-II-B1-ATTRIBUTION-AUDIT.md`, commit `60df8a0`) audited the
Phase II-B GNN on the Phase II-A corpus and failed its attribution gate for four reasons:

- **The topology-blind control won.** A parameter-matched pooled MLP (137 665 vs 123 793
  parameters) beat the GNN on test and OOD AUROC (test 0.9887 vs 0.9827). It also matched or
  beat the GNN at fixed budgets 500 and 1 000.
- **Edge destruction had no effect.** Randomizing every relation endpoint left the
  fixed-budget schedule ranking byte-identical. Removing or relabelling edges *improved*
  low-budget discovery.
- **The pair signal was weak.** On 250 hand-built placement pairs the GNN was 66.8 % correct,
  with a mean risk margin of 0.002 and a pair AUROC of 0.53.
- **The corpus leaked the label.** The outcome was fixed before generation. Safe and unsafe
  schedules differed by construction in length (42.0 vs 6.0 actions), runtime, fault presence
  (0 % vs 100 %), action support and traffic. The 320 256 rows held only 4 980 distinct
  state/action fingerprints, and post-incident rows were labelled positive. A model trained on
  permuted labels still reached 0.69 AUROC, and the K = 10 and K = 20 labels were identical.

The corpus made attribution impossible, not the architecture: every learned model could
separate the classes without topology. Phase II-A.2 rebuilt the corpus (§3).

This phase found one more reason. II-B.1's only randomization control was a degree-preserving
target permutation; its other interventions removed or relabelled edges. §8 shows that this
permutation cannot remove a degree effect, and the degree effect is the larger of the two
relational effects on the new corpus.

## 3. Causal Corpus v2 (frozen)

Phase II-A.2 (`CLOUDPROOF-PHASE-II-A2-CAUSAL-CORPUS.md`) replaced the experiment rather than
the model:

- One outcome-blind generator samples runtime, traffic, placement, warm-up, fault hazard and
  actions from a single distribution.
- Labels come only from deterministic execution: the first violating transition fixes the
  trajectory outcome and every horizon label.
- Schedules are 40–140 actions long, with incidents spread across them, and rows stop at the
  first incident.
- Checkpoint selection never reads the label, and the candidate action carries no position or
  clock.
- Safe and unsafe trajectories are matched 1:1 within strata on nuisance features, and a
  `ShortcutProbe` trained on nuisance features alone must stay near chance.
- Splits hold out whole topologies: train 8, validation 5, test 3 and OOD 4, pairwise
  disjoint.

The 50 000-trajectory corpus was frozen in `CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json` (commit
`7dee7eb`) before any Phase II-B.2 training. Nothing in this phase regenerates, rebalances,
prunes or rewrites it. Every command recomputes the six SHA-256 digests first and aborts on
any difference.

`python -m ml.cloudproof.phase_ii_b2 verify` was re-run for this report (44 s) and recomputed
every digest independently of the manifest:

<!-- generated:corpus-files -->
| File | Bytes | SHA-256 (recomputed = frozen) |
| --- | ---: | --- |
| `counterfactual-pairs.jsonl` | 41 802 721 | `547e27db11595417f9fec5e0006edfb963fe27b603d2157b405cc79f7e235c22` |
| `trajectories.jsonl` | 467 763 655 | `9d1b55f606986f6a08af4fea807e829444fe4a5155920c916abbf03be244ddff` |
| `transitions-ood.jsonl` | 199 800 158 | `5c37b988b581302115519e4893a3452df923af10d815537b7e270e0e59564d90` |
| `transitions-test.jsonl` | 138 038 411 | `f606dd5cc22c4a91f5c854409126c46df9a846ce3dada20bdbac6c630741f5f2` |
| `transitions-train.jsonl` | 340 290 752 | `64f41d0de1c0fed9a455bb344bfb273cd54bd9d7930aa4597163668d71ddbfbc` |
| `transitions-validation.jsonl` | 221 125 492 | `4d35134206a5bcb3f5ea30c57155238210526d72634ca1ac277702a67390116c` |

Freeze record `CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json`, generator commit `42fda40`, acceptance passed: yes.
<!-- /generated:corpus-files -->

The same command re-checks split integrity:

- row `split` fields match their file;
- topologies match the catalog;
- trajectory IDs are disjoint across splits;
- no row carries `nextState`;
- the K = 5 label equals `horizons["5"]` on every row;
- tensorization is a pure function of the row.

It also checks the counterfactual pairs:

<!-- generated:corpus-pairs -->
| Quantity | Value |
| --- | --- |
| Rows verified (train / validation / test / OOD files) | 180 170 |
| Counterfactual pairs (valid / invalid) | 2 000 (1 944 / 56) |
| Relational-only valid pairs (pooled inputs identical at tensor level) | 1 111 |
| … of which relation tensors differ | 965 |
| … state-converged, byte-identical members (all concordant; excluded) | 146 (node-concentration 1, readiness-drain 73, readiness-wiring 72) |
| **Decisive pairs: relational-only, outcome-flipping** | **173** |
| … safe→unsafe / unsafe→safe | 164 / 9 |
| … by family | capacity-distribution 1, node-concentration 86, readiness-drain 31, readiness-wiring 55 |
| … by topology split | OOD 25, test 20, train 83, validation 45 |
| … with differing relation tensors | 173 |
| Sorted `pairId:family:change:riskier` digest | `9ad039a167032d697b566c27469138a4d06f16b20da800eb15691daaa7440f2c` |
<!-- /generated:corpus-pairs -->

**State-converged pairs are a property of the corpus, not a result.** In 146 relational-only
pairs the two members are byte-identical at the intervention row, because their starting pods
became ready during the quiet prefix. All 146 are concordant: they cannot flip and cannot say
anything about topology. They are outside the decisive denominator, which is N = 173
throughout.

The audit corrected one count in the verification record. An invalid pair's outcome change is
the string `invalid`, and the old counter added it to the validity tally a second time, giving
112 invalid pairs instead of 56. The pair set, the digests and every other count are unchanged,
and `verify` now asserts `valid + invalid = total`.

## 4. Frozen evaluation protocol

### 4.1 What was fixed, and when

| Item | First recorded | Time |
| --- | --- | --- |
| The 173-pair relational-only test, the pooled-MLP "≈ 50 % (identical inputs)" expectation, the randomized-edge control, the clock-blind requirement and the key results table | `CLOUDPROOF-PHASE-II-A2-CAUSAL-CORPUS.md`, commit `7dee7eb` | 2026-09-22 09:13 IST, before any II-B.2 training |
| Corpus freeze (six SHA-256 digests) | `CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json`, commit `7dee7eb` | same |
| Recipe, seeds, clock-blind field list, label field and parameter count per model | `models/*/config.json`, written by `train` before any member process starts | K = 5 launch, 2026-09-22 (training finished 14:51 IST) |
| Numeric attribution thresholds, `rewired-edges`, edge seeds, tie tolerance, bootstrap settings and trajectory rule | constants in `ml/cloudproof/phase_ii_b2.py` | in the code of the first K = 5 pair evaluation (`pairs-k5.log`, 2026-09-22); first committed together with the results in `0e4f013` |
| Experiment-level `config.json` | written by `report` from those constants | after all results |

The numeric thresholds are therefore self-attested. They were in the code that produced the
K = 5 pair evaluation. The logs record one such evaluation, and the later run that added the
secondary heads recomputed identical K = 5 numbers. But no commit predates the results. The
preregistered wording asked whether randomizing the edges *removes* the ranking ability; §8
answers that question as asked, next to the coded criteria.

### 4.2 Training contract

Every member trains on `transitions-train.jsonl` only. `transitions-validation.jsonl` is read
once per epoch for early stopping and checkpoint selection, and once at assembly for the
reported validation metrics.

The member process receives no test, OOD, pair or trajectory path. `train-member` has no such
arguments, and a unit test asserts it. The first test/OOD read of any model happened in
`evaluate`, after every checkpoint was frozen on disk. Pair records live in
`counterfactual-pairs.jsonl`, which no training path opens.

The tensorizer reads `state` and `action` only. A unit test tampers with pair labels, family,
`relationalOnly`, pair ID, split and topology and asserts identical tensors. Identifiers,
outcomes, failure classes, other horizons and matching metadata are therefore unobservable by
construction.

Each member trains as its own process, one per seed. That is arithmetically identical to
sequential training, because each member depends only on its seed and the data.

### 4.3 Attribution criteria (fixed in code)

1. Full GNN tie-aware accuracy ≥ 0.60 on the 173 pairs, bootstrap 95 % lower bound > 0.5,
   and exact binomial p (ties excluded) < 0.01.
2. Pooled MLP tie-aware accuracy within [0.40, 0.60].
3. At least one destroyed-edge control loses ≥ 0.10 tie-aware accuracy, with a
   paired-bootstrap interval excluding zero.
4. The clock-blind GNN meets criterion 1's accuracy and interval conditions.
5. The full-GNN interval excludes 0.5 and lies entirely above the pooled-MLP interval, and at
   least one destroyed-control difference interval excludes zero.

On this corpus, criteria 2, 3 and 5 cannot fail once criterion 1 passes:

- Pooled inputs are identical within every pair, so the pooled MLP and the no-edge GNN tie all
  173 pairs by construction (`pair-audit` asserts this).
- The no-edge control's paired difference is then the full GNN's own bootstrap shifted by 0.5.

These three criteria check the construction, not the model. The independent evidence is
criterion 1, criterion 4 and the *randomization* controls. The audit therefore also applies a
stricter reading of criterion 3, labelled 3′: every seeded randomization control must
individually lose ≥ 0.10 with an interval excluding zero. §7.1 reports it next to the coded
verdict.

## 5. Exact model configuration

The Phase II-B configuration was recovered from `ml/cloudproof/train.py` and
`ml/cloudproof/model.py` at commit `b8b2b51`. The II-B.1 audit commit (`60df8a0`) added
ablation modes and the pooled MLP, but left the `full` forward path and the training loop
functionally unchanged.

The GNN is a `HeterogeneousRiskGNN`:

- per-type input encoders for Pod, Node, Deployment, Service, HPA, PDB and Zone;
- two relation layers, each with per-relation forward and reverse `Linear(48, 48, bias=False)`
  messages for RUNS_ON, OWNS, ROUTES_TO, LOCATED_IN, SELECTS, PROTECTS and SCALES, mean
  aggregation, a per-type self transform, and LayerNorm + ReLU + Dropout;
- an action encoder `Linear(43, 48)`, concatenated with the resolved target-node embedding;
- typed mean pooling (7 × 48);
- a risk head `Linear(432, 48)` + ReLU + Dropout + `Linear(48, 1)`.

The pooled MLP is the unchanged II-B.1 `flat-mlp` control, trained with the same recipe. It
sees typed mean, min, max and sum pools of the same node features, plus the same action
features, through `Linear(187, 288)` + ReLU + Dropout + `Linear(288, 288)` + ReLU + Dropout +
`Linear(288, 1)`.

Values as recorded in the artifacts:

<!-- generated:model-config -->
| Item | Frozen value (`config.json`, `models/*/config.json`) |
| --- | --- |
| architecture | HeterogeneousRiskGNN |
| hiddenDim | `48` |
| layers | `2` |
| relationHandling | per-relation forward and reverse linear messages, mean aggregation, LayerNorm + ReLU |
| actionEncoder | Linear(ACTION_FEATURE_DIM, 48) + ReLU + Dropout, concatenated with the resolved target-node embedding |
| pooling | typed mean pooling over the seven resource types |
| riskHead | Linear(9*48, 48) + ReLU + Dropout + Linear(48, 1) |
| dropout | `0.1` |
| optimizer | AdamW |
| learningRate | `0.001` |
| weightDecay | `0.0001` |
| batchSize | `128` |
| shuffleBuffer | `2048` |
| epochs | `20` |
| patience | `4` |
| earlyStoppingMetric | validation NLL (best checkpoint restored) |
| loss | BCEWithLogits; pos_weight = negatives/positives when the train positive rate is outside [0.25, 0.75] |
| gradientClipNorm | `5.0` |
| normalization | fixed feature scales inside the tensorizer; LayerNorm per resource type in every relation layer |
| calibration | none post hoc; validation is used only for early stopping, checkpoint selection and the F1 threshold report |
| ensembleSeeds | `[1337, 2027, 4099, 7919, 104729]` |
| torchThreads | `1` |
| device | cpu |
| deterministicAlgorithms | `true` |
| Full GNN (`gnn-full-k5`) | 123 793 parameters; loss `weighted-bce`, pos_weight 13.335 (train positive rate 6.98 %); masked fields: none |
| Pooled MLP (`pooled-mlp-k5`) | 137 665 parameters; loss `weighted-bce`, pos_weight 13.335 (train positive rate 6.98 %); masked fields: none |
| Clock-blind GNN (`gnn-clock-blind-k5`) | 123 793 parameters; loss `weighted-bce`, pos_weight 13.335 (train positive rate 6.98 %); masked fields: `HPA.sampled_at`, `action.atMs` |
<!-- /generated:model-config -->

### 5.1 Adapters (the only changes on the model path)

| Change | Why | Effect on the frozen model |
| --- | --- | --- |
| `CausalCorpusManifest` + `open_corpus_manifest` (`dataset.py`) | the loop validated the v1 manifest kind and `topology-holdout-v1` | none; same file interface, adds the v2 contract and freeze verification |
| `label_horizon` on the tensorizer and `label_balance` | K = 1 / 10 / 20 heads read `labels.horizons[K]` | none for K = 5, which still reads `sloViolationWithinKTransitions` (asserted equal to `horizons["5"]`) |
| `clock_blind` mask on the tensorizer | predeclared ablation | zeroes two columns; tensor shapes and parameter count unchanged |
| `tensorizer` argument on `train_member`, `_validation_loader`, `predict_path`, `infer.py` | pass the clock-blind or horizon tensorizer through unchanged code | none when omitted |
| `edge_seed` plumbing and the `rewired-edges` mode (`perturb.py`) | several randomization seeds; a destruction that also removes degree structure | inference-time only |
| `phase_ii_b2.py`, `phase_ii_b2_report.py`, `stats.py`, `tools/cloudproof-phase-ii-b2-benchmark.js` | driver, per-pair audit, table rendering, uncertainty, frozen-pool benchmark | none |

### 5.2 Training runs and compute

Hardware and software: one laptop CPU (24 logical processors, Intel family 6 model 183), no
GPU; `torch 2.7.1+cpu`, Python 3.12.0, NumPy 2.3.4; one torch thread per member;
`torch.use_deterministic_algorithms(True)`.

<!-- generated:training -->
| Artifact | Best epoch per member | Epochs run | Member training seconds | Seconds per epoch | Validation AUROC (ensemble) | Validation NLL |
| --- | --- | --- | --- | --- | ---: | ---: |
| Full GNN (`gnn-full-k5`) | 4, 7, 7, 6, 7 | 8, 11, 11, 10, 11 | 3 779 – 5 107 (23 834 total) | 463 – 476 | 0.7931 | 0.3101 |
| Pooled MLP (`pooled-mlp-k5`) | 9, 8, 7, 1, 4 | 13, 12, 11, 5, 8 | 1 825 – 5 158 (19 461 total) | 365 – 408 | 0.7935 | 0.3103 |
| Clock-blind GNN (`gnn-clock-blind-k5`) | 4, 7, 7, 6, 7 | 8, 11, 11, 10, 11 | 3 081 – 5 269 (19 587 total) | 303 – 497 | 0.7907 | 0.3125 |
<!-- /generated:training -->

<!-- generated:training-runs -->
| Run | Models | Horizons | Member processes | Concurrency | Wall seconds | Completed | Note |
| --- | --- | --- | ---: | ---: | ---: | --- | --- |
| 1 | gnn-full, pooled-mlp, gnn-clock-blind | 5 | 15 | 12 | 7 792 | yes | — |
| 2 | gnn-full, pooled-mlp | 1, 10, 20 | 30 | 10 | not recorded | no | orchestrator killed by a session teardown after 19 members had written weights and records; wall time not recorded |
| 3 | gnn-full, pooled-mlp | 1, 10, 20 | 11 | 11 | 2 036 | yes | resume: the 19 finished members were skipped (weights and member record both present) |

Primary K = 5 run: 62 882 member-seconds in 7 792 wall seconds, i.e. on average 8.1 members' worth of progress at once with 12 processes launched concurrently. Secondary heads: 30 members, 32 401 member-seconds.
<!-- /generated:training-runs -->

Twelve concurrent single-thread members oversubscribed the machine:

- GNN members that trained under full 12-way load took 463–497 s per epoch.
- Clock-blind members 2–4 started only as earlier members finished, and took 303–357 s per
  epoch on the same code and data.

Concurrency changes wall-clock scheduling only, not the arithmetic, so no result depends on
it. Any new ensemble should still first benchmark one epoch at 4–6-way concurrency.

The secondary heads were trained as full five-seed ensembles (30 members) in a second
invocation. A session teardown killed it after 19 members, and a resume completed the other
11. A member is skipped only when both its weights and its record exist, so no member was
trained twice or assembled from a partial file.

## 6. Natural test/OOD results (K = 5)

These are transition-level metrics on every validation/test/OOD row. AUROC intervals resample
whole trajectories (1 000 resamples), because rows of one trajectory are not independent. The
edge-destroyed rows are the frozen full GNN scored under the §8 interventions.

<!-- generated:natural-transition -->
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
| Full GNN, randomized edges (mean of 3 seeds) | validation | 0.7926 | 0.3624 | 0.0889 | 0.1371 | 0.3109 |
| Full GNN, randomized edges (mean of 3 seeds) | test | 0.7874 | 0.3636 | 0.0716 | 0.1036 | 0.2641 |
| Full GNN, randomized edges (mean of 3 seeds) | OOD | 0.7224 | 0.2320 | 0.1524 | 0.2603 | 0.4812 |
| Full GNN, rewired edges (mean of 3 seeds) | validation | 0.7507 | 0.2253 | 0.1565 | 0.2472 | 0.5054 |
| Full GNN, rewired edges (mean of 3 seeds) | test | 0.7433 | 0.2149 | 0.1302 | 0.2033 | 0.4322 |
| Full GNN, rewired edges (mean of 3 seeds) | OOD | 0.7072 | 0.2012 | 0.2351 | 0.3743 | 0.6915 |
| Full GNN, no edges | validation | 0.6932 | 0.1776 | 0.1589 | 0.2792 | 0.4980 |
| Full GNN, no edges | test | 0.7346 | 0.2183 | 0.1193 | 0.2171 | 0.4041 |
| Full GNN, no edges | OOD | 0.7301 | 0.2195 | 0.1965 | 0.3445 | 0.5849 |

Rows 48 337 / 28 142 / 29 909; positive rate 7.3 % / 7.0 % / 7.1 % (validation / test / OOD).

| Corpus baseline (same rows) | validation AUROC / AUPRC | test | OOD |
| --- | ---: | ---: | ---: |
| heuristic | 0.595 / 0.116 | 0.584 / 0.107 | 0.551 / 0.088 |
| logistic | 0.642 / 0.142 | 0.610 / 0.140 | 0.542 / 0.103 |
| random | 0.492 / 0.071 | 0.502 / 0.071 | 0.501 / 0.072 |
<!-- /generated:natural-transition -->

Trajectory-level metrics use the predeclared rule: trajectory risk is the maximum
ensemble-mean risk over the trajectory's emitted rows, and the label is the deterministic
trajectory outcome. This is the rule the corpus evaluation already applied to its heuristic
and logistic baselines, and the evaluator implements no other.

<!-- generated:trajectory -->
| Model | Split | Trajectories (unsafe) | AUROC [95 % bootstrap] | AUPRC | Brier |
| --- | --- | ---: | ---: | ---: | ---: |
| Full GNN | validation | 2 720 (1 360) | 0.7116 [0.6925, 0.7313] | 0.7202 | 0.2329 |
| Full GNN | test | 1 510 (755) | 0.7708 [0.7471, 0.7946] | 0.7727 | 0.2049 |
| Full GNN | OOD | 1 608 (804) | 0.6479 [0.6204, 0.6738] | 0.6098 | 0.3189 |
| Pooled MLP | validation | 2 720 (1 360) | 0.7299 [0.7124, 0.7489] | 0.7202 | 0.2323 |
| Pooled MLP | test | 1 510 (755) | 0.7625 [0.7399, 0.7861] | 0.7459 | 0.2139 |
| Pooled MLP | OOD | 1 608 (804) | 0.6277 [0.6001, 0.6546] | 0.6346 | 0.3709 |
| Clock-blind GNN | validation | 2 720 (1 360) | 0.7100 [0.6907, 0.7293] | 0.7215 | 0.2353 |
| Clock-blind GNN | test | 1 510 (755) | 0.7713 [0.7472, 0.7934] | 0.7760 | 0.2035 |
| Clock-blind GNN | OOD | 1 608 (804) | 0.6454 [0.6180, 0.6709] | 0.5955 | 0.3252 |
| Corpus heuristic (same rule) | validation | 2 720 | 0.5124 | 0.5150 | — |
| Corpus heuristic (same rule) | test | 1 510 | 0.4683 | 0.4859 | — |
| Corpus heuristic (same rule) | OOD | 1 608 | 0.5033 | 0.4974 | — |
| Corpus logistic (same rule) | validation | 2 720 | 0.5308 | 0.5435 | — |
| Corpus logistic (same rule) | test | 1 510 | 0.5397 | 0.5551 | — |
| Corpus logistic (same rule) | OOD | 1 608 | 0.4920 | 0.5164 | — |

Rule: trajectory risk = maximum ensemble-mean risk over the trajectory's emitted rows (rows end at the first incident); label = deterministic trajectory outcome.
<!-- /generated:trajectory -->

How to read these numbers:

- The Phase II-B numbers from the leaky corpus (test and OOD AUROC ≈ 0.98) are gone, as a
  repaired corpus predicts.
- The GNN and the topology-blind pooled MLP are statistically indistinguishable in transition
  AUROC on every split (the trajectory-bootstrap intervals overlap).
- The GNN has slightly higher AUPRC everywhere and is much better calibrated on OOD (NLL,
  Brier, ECE).
- At trajectory level the ordering flips between validation and the held-out topologies, with
  overlapping intervals.
- The degree-preserving randomized-edge GNN is indistinguishable from the intact GNN on
  natural data. Rewiring or removing the edges costs AUROC on validation and test.

The GNN therefore does use its edges on natural data, but the pooled MLP reaches the same
AUROC without them. On OOD (8–12 replicas), removing edges leaves transition AUROC flat or
slightly higher while NLL and trajectory ranking degrade: the mean-aggregating layers
extrapolate poorly to larger graphs.

## 7. Relational-only attribution (primary; N = 173)

The truth for each pair is the deterministic trajectory outcome: the riskier member is the one
whose trajectory fails. Using the ensemble-mean risk of each member:

- a pair is **correct** when the riskier member's risk exceeds the other's by more than 10⁻⁶;
- a pair is a **tie** when the two risks are within ±10⁻⁶;
- otherwise the pair is **wrong**.

Tie-aware accuracy is (correct + ½·ties) / 173. In the tables, c/t/w stands for correct /
ties / wrong.

<!-- generated:pairs-primary -->
| Model | Edges | Correct | Wrong | Ties | Tie-aware [bootstrap 95 %] | Wilson 95 % | Binomial p (ties excl.) | safe→unsafe (c/t/w) | unsafe→safe (c/t/w) | Mean margin [95 %] | Median margin |
| --- | --- | ---: | ---: | ---: | --- | --- | ---: | --- | --- | --- | --- |
| Pooled MLP | intact | 0 | 0 | 173 | 0.500 [0.500, 0.500] | [0.426, 0.574] | — | 0.500 (0/164/0) | 0.500 (0/9/0) | +0.0000 [+0.0000, +0.0000] | +0.0000 |
| Full GNN | intact | 151 | 22 | 0 | 0.873 [0.821, 0.919] | [0.815, 0.915] | 7.4 × 10⁻²⁵ | 0.921 (151/0/13) | 0.000 (0/0/9) | +0.0730 [+0.0601, +0.0855] | +0.0647 |
| Full GNN | randomized edges @1729 | 111 | 26 | 36 | 0.746 [0.688, 0.801] | [0.676, 0.805] | 1.0 × 10⁻¹³ | 0.759 (107/35/22) | 0.500 (4/1/4) | +0.0669 [+0.0536, +0.0803] | +0.0405 |
| Full GNN | randomized edges @2729 | 110 | 28 | 35 | 0.737 [0.682, 0.792] | [0.667, 0.797] | 1.1 × 10⁻¹² | 0.762 (109/32/23) | 0.278 (1/3/5) | +0.0668 [+0.0544, +0.0793] | +0.0388 |
| Full GNN | randomized edges @3729 | 113 | 26 | 34 | 0.751 [0.697, 0.806] | [0.682, 0.810] | 4.0 × 10⁻¹⁴ | 0.762 (109/32/23) | 0.556 (4/2/3) | +0.0666 [+0.0547, +0.0787] | +0.0367 |
| Full GNN | rewired edges @1729 | 80 | 93 | 0 | 0.462 [0.393, 0.538] | [0.390, 0.537] | 0.36 | 0.463 (76/0/88) | 0.444 (4/0/5) | −0.0174 [−0.0510, +0.0172] | −0.0073 |
| Full GNN | rewired edges @2729 | 85 | 88 | 0 | 0.491 [0.416, 0.566] | [0.418, 0.565] | 0.88 | 0.482 (79/0/85) | 0.667 (6/0/3) | −0.0146 [−0.0498, +0.0209] | −0.0028 |
| Full GNN | rewired edges @3729 | 95 | 78 | 0 | 0.549 [0.474, 0.624] | [0.475, 0.621] | 0.22 | 0.555 (91/0/73) | 0.444 (4/0/5) | +0.0298 [−0.0104, +0.0705] | +0.0168 |
| Full GNN | no edges | 0 | 0 | 173 | 0.500 [0.500, 0.500] | [0.426, 0.574] | — | 0.500 (0/164/0) | 0.500 (0/9/0) | +0.0000 [+0.0000, +0.0000] | +0.0000 |
| Full GNN | collapsed edge types | 128 | 45 | 0 | 0.740 [0.671, 0.803] | [0.670, 0.800] | 2.0 × 10⁻¹⁰ | 0.780 (128/0/36) | 0.000 (0/0/9) | +0.0081 [+0.0057, +0.0103] | +0.0028 |
| Full GNN | random relation labels | 157 | 16 | 0 | 0.908 [0.861, 0.948] | [0.855, 0.942] | 2.8 × 10⁻³⁰ | 0.945 (155/0/9) | 0.222 (2/0/7) | +0.0140 [+0.0119, +0.0159] | +0.0146 |
| Clock-blind GNN | intact | 153 | 20 | 0 | 0.884 [0.838, 0.931] | [0.828, 0.924] | 1.5 × 10⁻²⁶ | 0.933 (153/0/11) | 0.000 (0/0/9) | +0.0881 [+0.0743, +0.1019] | +0.0651 |
| Clock-blind GNN | randomized edges @1729 | 110 | 27 | 36 | 0.740 [0.682, 0.798] | [0.670, 0.800] | 4.4 × 10⁻¹³ | 0.747 (105/35/24) | 0.611 (5/1/3) | +0.0766 [+0.0612, +0.0921] | +0.0470 |
| Clock-blind GNN | randomized edges @2729 | 110 | 28 | 35 | 0.737 [0.682, 0.792] | [0.667, 0.797] | 1.1 × 10⁻¹² | 0.762 (109/32/23) | 0.278 (1/3/5) | +0.0772 [+0.0631, +0.0916] | +0.0470 |
| Clock-blind GNN | randomized edges @3729 | 112 | 27 | 34 | 0.746 [0.691, 0.801] | [0.676, 0.805] | 1.7 × 10⁻¹³ | 0.756 (108/32/24) | 0.556 (4/2/3) | +0.0770 [+0.0632, +0.0909] | +0.0467 |
| Clock-blind GNN | rewired edges @1729 | 81 | 92 | 0 | 0.468 [0.399, 0.543] | [0.395, 0.542] | 0.45 | 0.470 (77/0/87) | 0.444 (4/0/5) | −0.0122 [−0.0474, +0.0241] | −0.0097 |
| Clock-blind GNN | rewired edges @2729 | 88 | 85 | 0 | 0.509 [0.434, 0.584] | [0.435, 0.582] | 0.88 | 0.500 (82/0/82) | 0.667 (6/0/3) | −0.0130 [−0.0505, +0.0248] | +0.0025 |
| Clock-blind GNN | rewired edges @3729 | 98 | 75 | 0 | 0.566 [0.491, 0.642] | [0.492, 0.638] | 0.09 | 0.567 (93/0/71) | 0.556 (5/0/4) | +0.0315 [−0.0121, +0.0753] | +0.0120 |
| Clock-blind GNN | no edges | 0 | 0 | 173 | 0.500 [0.500, 0.500] | [0.426, 0.574] | — | 0.500 (0/164/0) | 0.500 (0/9/0) | +0.0000 [+0.0000, +0.0000] | +0.0000 |
| Clock-blind GNN | collapsed edge types | 123 | 50 | 0 | 0.711 [0.642, 0.775] | [0.639, 0.773] | 2.8 × 10⁻⁸ | 0.750 (123/0/41) | 0.000 (0/0/9) | +0.0076 [+0.0056, +0.0094] | +0.0023 |
| Clock-blind GNN | random relation labels | 50 | 123 | 0 | 0.289 [0.225, 0.358] | [0.227, 0.361] | 2.8 × 10⁻⁸ | 0.250 (41/0/123) | 1.000 (9/0/0) | −0.0062 [−0.0094, −0.0029] | −0.0048 |
<!-- /generated:pairs-primary -->

<!-- generated:pairs-breakdown -->
| Subset | Pairs | Full GNN: tie-aware (c/t/w) | Clock-blind GNN | Pooled MLP |
| --- | ---: | --- | --- | --- |
| safe→unsafe | 164 | 0.921 (151/0/13) | 0.933 (153/0/11) | 0.500 (0/164/0) |
| unsafe→safe | 9 | 0.000 (0/0/9) | 0.000 (0/0/9) | 0.500 (0/9/0) |
| family: node-concentration | 86 | 0.965 (83/0/3) | 0.965 (83/0/3) | 0.500 (0/86/0) |
| family: readiness-wiring | 55 | 0.927 (51/0/4) | 0.982 (54/0/1) | 0.500 (0/55/0) |
| family: readiness-drain | 31 | 0.548 (17/0/14) | 0.516 (16/0/15) | 0.500 (0/31/0) |
| family: capacity-distribution | 1 | 0.000 (0/0/1) | 0.000 (0/0/1) | 0.500 (0/1/0) |
| topology split: train | 83 | 0.928 (77/0/6) | 0.928 (77/0/6) | 0.500 (0/83/0) |
| topology split: validation | 45 | 0.867 (39/0/6) | 0.844 (38/0/7) | 0.500 (0/45/0) |
| topology split: test | 20 | 0.600 (12/0/8) | 0.750 (15/0/5) | 0.500 (0/20/0) |
| topology split: OOD | 25 | 0.920 (23/0/2) | 0.920 (23/0/2) | 0.500 (0/25/0) |
| held-out topologies (validation + test + OOD) | 90 | 0.822 (74/0/16) [0.744, 0.900], p = 4.4 × 10⁻¹⁰ | 0.844 (76/0/14) [0.767, 0.911], p = 1.8 × 10⁻¹¹ | 0.500 (0/90/0) [0.500, 0.500], p = — |
| relational-only, horizon-5 truth | 232 | 0.927 (215/0/17) [0.892, 0.957], p = 7.9 × 10⁻⁴⁵ | 0.927 (215/0/17) [0.892, 0.957], p = 7.9 × 10⁻⁴⁵ | 0.500 (0/232/0) [0.500, 0.500], p = — |
| placement families (flat-visible) | 181 | 0.994 (180/0/1) [0.983, 1.000], p = 1.2 × 10⁻⁵² | 0.994 (180/0/1) [0.983, 1.000], p = 1.2 × 10⁻⁵² | 0.500 (0/181/0) [0.500, 0.500], p = — |
| all valid discordant pairs | 354 | 0.935 (331/0/23) [0.910, 0.958], p = 4.6 × 10⁻⁷¹ | 0.941 (333/0/21) [0.915, 0.963], p = 2.1 × 10⁻⁷³ | 0.500 (0/354/0) [0.500, 0.500], p = — |
<!-- /generated:pairs-breakdown -->

### 7.1 Verdict

<!-- generated:attribution-criteria -->
| # | Criterion | Measured (N = 173) | Passed |
| --- | --- | --- | --- |
| 1 | Full GNN tie-aware ≥ 0.60, bootstrap lower bound > 0.5, binomial p (ties excluded) < 0.01 | 0.873 [0.821, 0.919], p = 7.4 × 10⁻²⁵ | yes |
| 2 | Pooled MLP tie-aware within [0.40, 0.60] | 0.500 (173 ties) | yes |
| 3 | At least one destroyed-edge control loses ≥ 0.10 with a paired interval excluding 0 | 8 of 9 controls qualify (not: random-relation-labels) | yes |
| 4 | Clock-blind GNN tie-aware ≥ 0.60, bootstrap lower bound > 0.5 | 0.884 [0.838, 0.931] | yes |
| 5 | Full-GNN interval excludes 0.5 and lies above the pooled-MLP interval; a destroyed-control difference excludes 0 | [0.821, 0.919] vs pooled upper bound; difference excludes 0: yes | yes |
| 3′ (audit) | Stricter reading added after the verdict: *every* seeded randomization control (3 randomized + 3 rewired) individually loses ≥ 0.10 with a paired interval excluding 0 | 6 of 6 | yes |

**Graph attribution: PASSED.**
<!-- /generated:attribution-criteria -->

The pooled MLP and the no-edge GNN tie every pair *exactly*, because relational-only members
present them with identical tensors. `pair-audit` asserts this on the trained models: the
largest |margin| is 1.2 × 10⁻⁷, float32 noise inside the tolerance. Any score difference in
the intact GNN can therefore only come from the edges, and 151 of the 173 differences point
the right way.

### 7.2 Limits visible in the breakdown

- **Every unsafe→safe flip is ranked wrong** (0/9). The exact two-sided p is 0.0039 against
  chance, so the model is systematically wrong here, not noisy. Eight of the nine are
  readiness-drain pairs, a family on which the GNN is at chance (17/31). Within each family the
  model has learned a fixed relational preference: the intervened arrangement reads as riskier.
  That preference is right for the majority direction and wrong for the minority one. The
  model is not reading the fine-grained causal outcome.
- **The test split's 0.600 is a family-mix effect at n = 20.** Eight of its 20 flips are
  readiness-drain pairs, against 14 of 83 in train. Quote the pooled held-out estimate (n = 90)
  instead; §11.3 splits it further.
- **Training topologies score highest** (0.928 on 83 pairs, against 0.822 held out). Pair
  records never enter training, but these topologies do.

## 8. Edge-destruction control

All interventions act at inference on the frozen weights (`perturb.py`). They preserve node
features, node counts, action features, the action target and the per-relation edge count.
The seeded modes take their seed from the edge seed and the record ID, so each pair member
receives its own destroyed graph, and the same record always receives the same one.

| Mode | What is destroyed | What survives | Seeds |
| --- | --- | --- | --- |
| `randomized-edges` | which source connects to which target (the target column of every relation is permuted; this is the II-B.1 control) | every node's in- and out-degree | 1729, 2729, 3729 |
| `rewired-edges` | both endpoints, resampled uniformly among type-compatible nodes; if the resample reproduces the original multiset, the targets are rolled | relation-type edge counts only | 1729, 2729, 3729 |
| `no-edges` | every relation | nothing relational | — |
| `collapsed-edge-types` | relation identity (all relation transforms averaged) | the wiring | — |
| `random-relation-labels` | relation identity (each relation routed through a fixed wrong transform) | the wiring | — |

The last two modes keep the wiring. They are diagnostics, not connectivity destruction.

<!-- generated:pairs-comparisons -->
| Comparison (same 173 pairs) | Δ tie-aware accuracy | Paired bootstrap 95 % | McNemar left-only / right-only | McNemar p |
| --- | ---: | --- | ---: | ---: |
| Full GNN vs Pooled MLP | +0.373 | [+0.321, +0.419] | 151 / 0 | 7.0 × 10⁻⁴⁶ |
| Full GNN vs Full GNN, no edges | +0.373 | [+0.321, +0.419] | 151 / 0 | 7.0 × 10⁻⁴⁶ |
| Full GNN vs Full GNN, randomized edges @1729 | +0.127 | [+0.066, +0.191] | 47 / 7 | 2.3 × 10⁻⁸ |
| Full GNN vs Full GNN, randomized edges @2729 | +0.136 | [+0.075, +0.197] | 47 / 6 | 5.8 × 10⁻⁹ |
| Full GNN vs Full GNN, randomized edges @3729 | +0.121 | [+0.055, +0.188] | 46 / 8 | 1.4 × 10⁻⁷ |
| Full GNN vs Full GNN, rewired edges @1729 | +0.410 | [+0.324, +0.497] | 79 / 8 | 8.4 × 10⁻¹⁶ |
| Full GNN vs Full GNN, rewired edges @2729 | +0.382 | [+0.283, +0.474] | 79 / 13 | 1.1 × 10⁻¹² |
| Full GNN vs Full GNN, rewired edges @3729 | +0.324 | [+0.237, +0.410] | 66 / 10 | 3.0 × 10⁻¹¹ |
| Full GNN vs Full GNN, collapsed edge types | +0.133 | [+0.064, +0.202] | 32 / 9 | 4.3 × 10⁻⁴ |
| Full GNN vs Full GNN, random relation labels | −0.035 | [−0.087, +0.017] | 8 / 14 | 0.29 |
| Full GNN vs Clock-blind GNN | −0.012 | [−0.035, +0.012] | 1 / 3 | 0.62 |
<!-- /generated:pairs-comparisons -->

**The preregistered question was whether randomizing the edges removes the ability. It
removes part of it.**

- The degree-preserving randomization (the preregistered II-B.1 control) lowers the full GNN
  from 0.873 to 0.737–0.751. The paired differences are +0.12 to +0.14, and every interval
  excludes zero. The model nevertheless stays far above chance.
- Uniform rewiring, which also destroys degree, removes the ability (0.462–0.549, binomial
  p ≥ 0.22). So does removing the edges.

The random-edge model is therefore clearly *not* nearly identical to the full GNN on the
decisive pairs, and every destroyed-connectivity control individually passes the ≥ 0.10 rule
(criterion 3′). But what survives a degree-preserving permutation is itself relational
information, as the family split shows:

<!-- generated:pairs-family -->
| Model | Edges | node-concentration (n = 86) | readiness-wiring (n = 55) | readiness-drain (n = 31) | capacity-distribution (n = 1) | overall (n = 173) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Full GNN | intact | 0.965 | 0.927 | 0.548 | 0.000 | 0.873 |
| Full GNN | randomized edges @1729 | 0.965 | 0.555 | 0.500 | 0.000 | 0.746 |
| Full GNN | randomized edges @2729 | 0.953 | 0.545 | 0.500 | 0.000 | 0.737 |
| Full GNN | randomized edges @3729 | 0.965 | 0.509 | 0.613 | 0.000 | 0.751 |
| Full GNN | rewired edges @1729 | 0.465 | 0.436 | 0.516 | 0.000 | 0.462 |
| Full GNN | rewired edges @2729 | 0.512 | 0.509 | 0.419 | 0.000 | 0.491 |
| Full GNN | rewired edges @3729 | 0.523 | 0.582 | 0.581 | 0.000 | 0.549 |
| Full GNN | no edges | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 |
| Full GNN | collapsed edge types | 0.953 | 0.418 | 0.742 | 0.000 | 0.740 |
| Full GNN | random relation labels | 0.988 | 0.927 | 0.677 | 0.000 | 0.908 |
| Clock-blind GNN | intact | 0.965 | 0.982 | 0.516 | 0.000 | 0.884 |
| Clock-blind GNN | randomized edges @1729 | 0.965 | 0.536 | 0.500 | 0.000 | 0.740 |
| Clock-blind GNN | randomized edges @2729 | 0.953 | 0.564 | 0.468 | 0.000 | 0.737 |
| Clock-blind GNN | randomized edges @3729 | 0.965 | 0.509 | 0.581 | 0.000 | 0.746 |
| Clock-blind GNN | rewired edges @1729 | 0.477 | 0.455 | 0.484 | 0.000 | 0.468 |
| Clock-blind GNN | rewired edges @2729 | 0.547 | 0.491 | 0.419 | 1.000 | 0.509 |
| Clock-blind GNN | rewired edges @3729 | 0.558 | 0.564 | 0.613 | 0.000 | 0.566 |
| Clock-blind GNN | no edges | 0.500 | 0.500 | 0.500 | 0.500 | 0.500 |
| Clock-blind GNN | collapsed edge types | 0.988 | 0.291 | 0.710 | 0.000 | 0.711 |
| Clock-blind GNN | random relation labels | 0.035 | 0.582 | 0.452 | 1.000 | 0.289 |
<!-- /generated:pairs-family -->

- **Node-concentration is a degree effect.** The two members differ in how many pods sit on the
  node that then crashes. A degree-preserving permutation leaves that intact (0.95–0.97), and
  only uniform rewiring destroys it (0.47–0.52).
- **Readiness-wiring is an endpoint-identity effect.** Which zone the unready pods are related
  to cannot survive a permutation, so accuracy collapses from 0.927 to 0.51–0.56, while the
  edges still have to exist.
- **The wiring-preserving diagnostics agree from the other side.** Averaging or mislabelling
  the relation transforms leaves the degree-driven family at 0.95–0.99 and perturbs the
  identity-driven one.
- **Relation labels are not used stably.** Random relation labels *raise* the full GNN to
  0.908 but drop the clock-blind GNN to 0.289, inverting its node-concentration ranking. The
  two models share architecture, recipe and seeds, so disagreeing this sharply under the same
  intervention shows that their use of relation *types* is unstable, even where their use of
  wiring is not.

### 8.1 Edge destruction on natural data

<!-- generated:edge-natural -->
| Frozen full GNN, edges | Δ AUROC validation / test / OOD | Δ AUPRC test / OOD | Δ NLL test / OOD | Trajectory AUROC test / OOD |
| --- | ---: | ---: | ---: | ---: |
| intact (absolute values) | 0.7931 / 0.7904 / 0.7221 | 0.3711 / 0.2328 | 0.2622 / 0.4829 | 0.7708 / 0.6479 |
| randomized edges @1729 | −0.0003 / −0.0026 / +0.0001 | −0.0072 / −0.0010 | +0.0018 / −0.0018 | 0.7582 / 0.6432 |
| randomized edges @2729 | −0.0008 / −0.0028 / +0.0006 | −0.0069 / −0.0012 | +0.0018 / −0.0017 | 0.7546 / 0.6409 |
| randomized edges @3729 | −0.0002 / −0.0035 / +0.0003 | −0.0082 / −0.0002 | +0.0020 / −0.0016 | 0.7498 / 0.6442 |
| rewired edges @1729 | −0.0428 / −0.0493 / −0.0162 | −0.1563 / −0.0311 | +0.1720 / +0.2093 | 0.6106 / 0.6141 |
| rewired edges @2729 | −0.0408 / −0.0471 / −0.0156 | −0.1608 / −0.0292 | +0.1715 / +0.2078 | 0.6217 / 0.6358 |
| rewired edges @3729 | −0.0437 / −0.0448 / −0.0129 | −0.1513 / −0.0347 | +0.1665 / +0.2086 | 0.6064 / 0.6126 |
| no edges | −0.0999 / −0.0558 / +0.0080 | −0.1528 / −0.0133 | +0.1419 / +0.1021 | 0.5897 / 0.6044 |
| collapsed edge types | −0.0545 / −0.0375 / +0.0196 | −0.1128 / +0.0105 | +0.0679 / −0.0129 | 0.6349 / 0.6328 |
| random relation labels | −0.0895 / −0.0451 / +0.0057 | −0.1419 / −0.0104 | +0.0203 / −0.0973 | 0.5931 / 0.6218 |
<!-- /generated:edge-natural -->

As in II-B.1, the degree-preserving permutation has essentially no effect on natural data.
Unlike II-B.1, rewiring or removing edges now costs 0.04–0.10 transition AUROC on
validation/test and drops trajectory-level test AUROC from 0.77 to 0.59–0.62.

## 9. Clock-blind control

Clock-like leakage was an explicit concern, because the II-A.2 audit found `HPA.sampledAtMs` to
be a clock readable from the state graph. The masked field list was written into every
clock-blind model's `config.json` (`featureTransform.maskedFields`) before training. The
clock-blind GNN was then retrained with the identical architecture, optimizer, seeds, epochs,
patience, loss, normalization, split and model-selection procedure.

| Field | Encoded as | Treatment |
| --- | --- | --- |
| `HPA.features.sampledAtMs` | node feature `HPA.sampled_at` | zeroed; the only absolute clock among the encoded node features |
| candidate action `atMs` | action parameter `atMs` | zeroed; absolute schedule time (already stripped from every v2 row, masked so the declaration is complete) |
| `state.atMs` | — | never encoded |
| any other timestamp in the raw state (for example scale, reconcile, creation, readiness or termination times) | — | never encoded; the tensorizer's closed node-feature vocabulary (`NODE_FEATURE_NAMES` in `constants.py`) has no timestamp column besides `HPA.sampled_at` |
| `ms`, `delayMs`, `durationMs` | action parameters | kept; durations, not clocks |
| version numbers, readiness, phases, replica counts, rollout/HPA activity | node features | kept; causal state that merely correlates with time |

<!-- generated:clock-blind -->
Masked columns: `HPA.sampled_at`, `action.atMs`; identical architecture: yes.

| Metric | Full GNN | Clock-blind GNN | Clock-blind minus full |
| --- | ---: | ---: | ---: |
| transition AUROC, validation | 0.7931 | 0.7907 | −0.0024 |
| transition AUROC, test | 0.7904 | 0.7869 | −0.0035 |
| transition AUROC, OOD | 0.7221 | 0.7113 | −0.0108 |
| transition AUPRC, validation | 0.3641 | 0.3610 | −0.0031 |
| transition AUPRC, test | 0.3711 | 0.3682 | −0.0029 |
| transition AUPRC, OOD | 0.2328 | 0.2254 | −0.0075 |
| transition NLL, validation | 0.3101 | 0.3125 | +0.0023 |
| transition NLL, test | 0.2622 | 0.2593 | −0.0029 |
| transition NLL, OOD | 0.4829 | 0.4961 | +0.0132 |
| transition ECE, validation | 0.1371 | 0.1367 | −0.0005 |
| transition ECE, test | 0.1040 | 0.1005 | −0.0035 |
| transition ECE, OOD | 0.2619 | 0.2669 | +0.0049 |
| trajectory AUROC, validation | 0.7116 | 0.7100 | −0.0017 |
| trajectory AUROC, test | 0.7708 | 0.7713 | +0.0004 |
| trajectory AUROC, OOD | 0.6479 | 0.6454 | −0.0025 |
| 173 pairs, tie-aware, intact | 0.873 | 0.884 | +0.012 |
| 173 pairs, tie-aware, randomized edges @1729 | 0.746 | 0.740 | −0.006 |
| 173 pairs, tie-aware, randomized edges @2729 | 0.737 | 0.737 | +0.000 |
| 173 pairs, tie-aware, randomized edges @3729 | 0.751 | 0.746 | −0.006 |
| 173 pairs, tie-aware, rewired edges @1729 | 0.462 | 0.468 | +0.006 |
| 173 pairs, tie-aware, rewired edges @2729 | 0.491 | 0.509 | +0.017 |
| 173 pairs, tie-aware, rewired edges @3729 | 0.549 | 0.566 | +0.017 |
| 173 pairs, tie-aware, no edges | 0.500 | 0.500 | +0.000 |
| 173 pairs, tie-aware, collapsed edge types | 0.740 | 0.711 | −0.029 |
| 173 pairs, tie-aware, random relation labels | 0.908 | 0.289 | −0.618 |
| fixed budget 100: counterexamples | 62 | 51 | −11 |
| fixed budget 500: counterexamples | 277 | 297 | +20 |
| fixed budget 1 000: counterexamples | 582 | 566 | −16 |
| fixed budget 5 000: counterexamples | 2564 | 2580 | +16 |
<!-- /generated:clock-blind -->

Masking the clock changes nothing material:

- transition AUROC moves by at most 0.011;
- the relational-only accuracy difference is small (full minus clock-blind −0.012, paired
  interval [−0.035, +0.012]);
- every edge-destruction control moves the same way.

Timing is not what carries the relational result.

## 10. Fixed-budget verification

The pool is every selected validation/test/OOD trajectory of the frozen corpus: 5 838
schedules containing 2 919 counterexamples. That is exactly half, because the corpus is
outcome-matched. Every prioritizer orders the same pool, and the deterministic Node verifier
replays schedules in that order and counts the counterexamples found within each budget. All
replay fingerprints matched the frozen record, and the Phase I flagship artifact replayed
byte-identically inside the same run.

<!-- generated:fixed-budget -->
| Prioritizer | CEs @100 | @500 | @1 000 | @5 000 | Recall @1 000 / @5 000 | Schedules to first CE | Failure classes @100 / @1 000 | Action targets · transition types @100 | Controller states @1 000 / @5 000 | Verification wall s @5 000 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Random (seed 1337) | 50 | 254 | 487 | 2 493 | 0.167 / 0.854 | 6 | 5 / 5 | 20/22 · 24 | 1 914 / 3 220 | 701 |
| Coverage-guided | **73** | **302** | **608** | 2 603 | 0.208 / 0.892 | 1 | 4 / 5 | 20/22 · 24 | 1 969 / 3 220 | 729 |
| Heuristic | 42 | 237 | 495 | 2 536 | 0.170 / 0.869 | 3 | 5 / 5 | 20/22 · 24 | 913 / 3 231 | 698 |
| Logistic | 30 | 242 | 488 | 2 514 | 0.167 / 0.861 | 2 | 3 / 5 | 20/22 · 24 | 1 379 / 3 248 | 715 |
| Pooled MLP | 50 | 280 | 523 | 2 508 | 0.179 / 0.859 | 1 | 5 / 5 | 20/22 · 24 | 1 368 / 3 274 | 725 |
| Full GNN | 62 | 277 | 582 | 2 564 | 0.199 / 0.878 | 2 | 5 / 5 | 20/22 · 24 | 1 583 / 3 273 | 725 |
| GNN, randomized edges @1729 | 62 | 276 | 579 | 2 556 | 0.198 / 0.876 | 2 | 5 / 5 | 20/22 · 24 | 1 584 / 3 279 | 725 |
| GNN, rewired edges @1729 | 53 | 258 | 529 | 2 547 | 0.181 / 0.873 | 4 | 5 / 5 | 20/22 · 24 | 2 120 / 3 283 | 727 |
| GNN, no edges | 61 | 241 | 503 | **2 604** | 0.172 / 0.892 | 1 | 5 / 5 | 20/22 · 24 | 1 915 / 3 299 | 727 |
| Clock-blind GNN | 51 | 297 | 566 | 2 580 | 0.194 / 0.884 | 2 | 5 / 5 | 20/22 · 24 | 1 466 / 3 280 | 726 |

Pool: 5 838 held-out schedules, 2 919 counterexamples; replay fingerprints verified: yes; 62 039 unique inference requests; Phase I replay byte-identical: yes (ROLLOUT_AVAILABILITY_VIOLATION); safety authority: `deterministic-node-verifier`.
<!-- /generated:fixed-budget -->

Rankings are deterministic given the scores, and only the random baseline carries a seed, so
there are no repeated trials. For scale, an uninformative ranking of this pool is a
hypergeometric draw:

<!-- generated:fixed-budget-chance -->
| z against a hypergeometric draw | @100 | @500 | @1 000 | @5 000 |
| --- | ---: | ---: | ---: | ---: |
| uninformative ranking: mean ± SD | 50.0 ± 4.96 | 250.0 ± 10.69 | 500.0 ± 14.39 | 2500.0 ± 13.40 |
| Random (seed 1337) | +0.0 | +0.4 | −0.9 | −0.5 |
| Coverage-guided | +4.6 | +4.9 | +7.5 | +7.7 |
| Heuristic | −1.6 | −1.2 | −0.3 | +2.7 |
| Logistic | −4.0 | −0.7 | −0.8 | +1.0 |
| Pooled MLP | +0.0 | +2.8 | +1.6 | +0.6 |
| Full GNN | +2.4 | +2.5 | +5.7 | +4.8 |
| GNN, randomized edges @1729 | +2.4 | +2.4 | +5.5 | +4.2 |
| GNN, rewired edges @1729 | +0.6 | +0.7 | +2.0 | +3.5 |
| GNN, no edges | +2.2 | −0.8 | +0.2 | +7.8 |
| Clock-blind GNN | +0.2 | +4.4 | +4.6 | +6.0 |
<!-- /generated:fixed-budget-chance -->

Three readings:

- **The learned prioritizers no longer dominate.** Deterministic coverage-guided search is the
  best method at every budget below 5 000. The heuristic and logistic baselines are at or below
  chance at small budgets.
- **The GNN is the best learned ranker at budget 1 000** (582 against 523 for the pooled MLP).
  Its margin over its own randomized-edge control, however, is three counterexamples (582 vs
  579). §8 predicts this: the degree-preserving permutation keeps the dominant
  node-concentration signal.
- **Destroying the graph more thoroughly costs budget performance** (rewired 529 and no edges
  503 at budget 1 000). Yet the no-edge model is the best method at 5 000, so this is an
  ordering effect at small budgets, not a uniform capability gap.

As the protocol requires, none of this counts as attribution evidence. It measures operational
usefulness on a 50/50 pool of whole schedules.

## 11. Statistical uncertainty

### 11.1 Methods

- **Pairwise accuracy** is tie-aware, with a percentile bootstrap over pairs (10 000
  resamples, seed 20260922) and a Wilson interval. Exact two-sided binomial tests against 0.5
  exclude ties; the JSON also reports them with ties counted as wrong.
- **Model comparisons on the same pairs** use a paired bootstrap of the tie-aware accuracy
  difference, resampling pair IDs with the same seed, plus an exact McNemar test on strict
  outcomes.
- **Transition AUROC** intervals come from a percentile bootstrap that resamples whole
  trajectories (1 000 resamples).
- **The fixed-budget benchmark** is deterministic and uses a hypergeometric reference only
  (§10).
- **Implementation.** All statistics are implemented without SciPy (`stats.py`). The audit
  recomputed every binomial p-value with `scipy.stats.binomtest`, and they agree.

### 11.2 Effect sizes on the decisive pairs

All differences below are full GNN minus control, in tie-aware accuracy, with paired
intervals (§8):

| Control | Difference |
| --- | --- |
| pooled MLP | +0.373 [+0.321, +0.419] |
| degree-preserving randomization | +0.12 to +0.14 |
| uniform rewiring | +0.32 to +0.41 |
| clock-blind GNN | −0.012 [−0.035, +0.012] |

The mean risk margin of the intact GNN is +0.073 [+0.060, +0.086] on a 0–1 risk scale, so the
model separates pair members by about seven points of predicted risk. The effect is decisive
in direction but modest in size.

### 11.3 Post-hoc robustness: held-out and unseen topologies

*The audit added this analysis after the verdict. It is descriptive only and is not an
attribution criterion.*

The 173 pairs come from all four topology splits. Validation topologies influenced early
stopping, through natural rows rather than pairs. Test and OOD topologies were never used for
training or model selection. `pair-audit.json` stores every per-pair margin, so these subsets
are computed from the same scores as §7:

<!-- generated:held-out-audit -->
| Subset (post hoc) | Pairs | nc / rw / rd / cd | Full GNN tie-aware [95 %], p | Clock-blind GNN |
| --- | ---: | ---: | --- | --- |
| all decisive pairs | 173 | 86 / 55 / 31 / 1 | 0.873 [0.821, 0.919], p = 7.4 × 10⁻²⁵ | 0.884 [0.838, 0.931], p = 1.5 × 10⁻²⁶ |
| train topologies | 83 | 47 / 22 / 14 / 0 | 0.928 [0.867, 0.976], p = 8.4 × 10⁻¹⁷ | 0.928 [0.867, 0.976], p = 8.4 × 10⁻¹⁷ |
| held-out topologies (validation + test + OOD) | 90 | 39 / 33 / 17 / 1 | 0.822 [0.744, 0.900], p = 4.4 × 10⁻¹⁰ | 0.844 [0.767, 0.911], p = 1.8 × 10⁻¹¹ |
| unseen topologies (test + OOD) | 45 | 20 / 14 / 11 / 0 | 0.778 [0.644, 0.889], p = 2.5 × 10⁻⁴ | 0.844 [0.733, 0.933], p = 3.1 × 10⁻⁶ |

| Subset (post hoc) | Model | minus randomized @1729 | minus randomized @2729 | minus randomized @3729 | minus rewired @1729 | minus rewired @2729 | minus rewired @3729 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all decisive pairs | Full GNN | +0.127 [+0.066, +0.191] | +0.136 [+0.075, +0.197] | +0.121 [+0.055, +0.188] | +0.410 [+0.324, +0.497] | +0.382 [+0.283, +0.474] | +0.324 [+0.237, +0.410] |
| all decisive pairs | Clock-blind GNN | +0.145 [+0.081, +0.208] | +0.147 [+0.092, +0.205] | +0.139 [+0.075, +0.205] | +0.416 [+0.335, +0.497] | +0.376 [+0.283, +0.468] | +0.318 [+0.231, +0.405] |
| train topologies | Full GNN | +0.151 [+0.066, +0.235] | +0.175 [+0.096, +0.253] | +0.127 [+0.048, +0.205] | +0.422 [+0.313, +0.530] | +0.506 [+0.386, +0.627] | +0.398 [+0.277, +0.518] |
| train topologies | Clock-blind GNN | +0.151 [+0.066, +0.235] | +0.163 [+0.090, +0.241] | +0.127 [+0.048, +0.205] | +0.410 [+0.301, +0.518] | +0.494 [+0.373, +0.614] | +0.373 [+0.253, +0.494] |
| held-out topologies (validation + test + OOD) | Full GNN | +0.106 [+0.011, +0.200] | +0.100 [+0.011, +0.189] | +0.117 [+0.017, +0.222] | +0.400 [+0.267, +0.533] | +0.267 [+0.133, +0.400] | +0.256 [+0.133, +0.378] |
| held-out topologies (validation + test + OOD) | Clock-blind GNN | +0.139 [+0.044, +0.233] | +0.133 [+0.050, +0.217] | +0.150 [+0.050, +0.250] | +0.422 [+0.289, +0.544] | +0.267 [+0.133, +0.400] | +0.267 [+0.144, +0.389] |
| unseen topologies (test + OOD) | Full GNN | +0.078 [−0.056, +0.222] | +0.067 [−0.078, +0.211] | +0.022 [−0.122, +0.167] | +0.400 [+0.200, +0.578] | +0.133 [−0.067, +0.333] | +0.267 [+0.067, +0.467] |
| unseen topologies (test + OOD) | Clock-blind GNN | +0.144 [+0.000, +0.289] | +0.133 [+0.011, +0.267] | +0.133 [−0.011, +0.278] | +0.489 [+0.311, +0.644] | +0.200 [+0.022, +0.378] | +0.378 [+0.178, +0.556] |

Families: nc node-concentration, rw readiness-wiring, rd readiness-drain, cd capacity-distribution. Re-scoring reproduced all 21 committed arms; the three arms with identical inputs by construction tie every pair (largest |margin| 1.2e-07, tolerance 1e-06).
<!-- /generated:held-out-audit -->

What these subsets show:

- **Relational information transfers to new topologies.** On unseen topologies the full GNN
  is still far above chance (0.778, p = 2.5 × 10⁻⁴) and beats uniform rewiring in two of the
  three seeds.
- **The lead over the degree-preserving control shrinks.** For the full GNN it falls to +0.02
  to +0.08, and every interval includes zero. The clock-blind model keeps +0.13 to +0.14, with
  one of three intervals excluding zero.

With 45 pairs the intervals are about ±0.14 wide, so this is inconclusive rather than
negative. Still, the evidence that the model uses relational information *beyond degree* rests
mainly on training and validation topologies.

### 11.4 Multiplicity

This report gives many arms, subsets and p-values. The verdict rests only on the five
predeclared criteria; every other interval and p-value is descriptive.

## 12. Negative findings

- **Natural data.** The pooled MLP matches the GNN in transition AUROC on every split at
  K = 5, and neither is consistently ahead at the secondary horizons. Relational message
  passing is not what drives natural-corpus prediction quality (§6, Appendix A).
- **Fixed budget.**
  - Coverage-guided search beats every learned prioritizer below budget 5 000.
  - The GNN's advantage over its own degree-preserving randomized-edge control is three
    counterexamples at budget 1 000.
  - The no-edge GNN is the best method at 5 000 (§10).
- **Causal direction.** All nine unsafe→safe flips are ranked wrong, below chance
  (p = 0.0039), and the GNN is at chance on readiness-drain (§7.2).
- **Beyond degree.** On unseen topologies the full GNN's lead over the degree-preserving
  control is not distinguishable from zero (§11.3).
- **Relation types.** Random relation labels move the two GNNs in opposite directions (0.908
  vs 0.289), so their use of relation types is unstable (§8).
- **Sparse families.** Capacity-distribution contributes one pair, which both GNNs rank
  wrong. The PDB and capacity families almost never flip on this corpus (§3).
- **Provenance defects found by the audit, now fixed (Appendix E):**
  - the double-counted invalid pairs;
  - manifest hashes that depended on the checkout's line endings;
  - an earlier sentence in this report that called the 582-vs-579 margin "a single
    counterexample".

## 13. Limitations

- **One simplified world.** The twin is a single-service Kubernetes control plane. The four
  intervention families are synthetic, and 173 decisive pairs come from them. Pair truth is
  simulator truth, not universal Kubernetes truth.
- **Degree dominates.** The largest family (node-concentration, 86 pairs) is decided by node
  degree. A flat model given per-node degree statistics was not part of the protocol, so
  "relational" here includes simple counting.
- **Self-attested thresholds.** The numeric thresholds and the `rewired-edges` mode were
  committed together with the results (§4.1). The coded criteria 2, 3 and 5 are implied by
  criterion 1 on this corpus (§4.3).
- **Validation topologies are not fully held out.** They influenced early stopping, and only
  45 decisive pairs come from test and OOD topologies.
- **Limited trials.** The fixed-budget random baseline has a single seed, and no repeated
  trials exist for any method.
- **Unrecorded compute details.** Per-epoch timings were not recorded; seconds per epoch are
  total seconds divided by epochs run. Wall time for the interrupted secondary run is unknown.
- **Secondary horizons.** These were trained as full ensembles although the protocol treated
  them as optional. They are exploratory and outside the claim (Appendix A).

## 14. Scientific conclusion

**GRAPH ATTRIBUTION: PASSED.**

The 173 decisive relational-only pairs of the frozen causal corpus v2 give any pooled model
identical inputs. On them:

- the unchanged Phase II-B GNN ranks the riskier member correctly in 151 cases (0.873, 95 % CI
  0.821–0.919, p = 7.4 × 10⁻²⁵);
- the pooled MLP ties every pair;
- destroying the wiring lowers accuracy (degree-preserving randomization, 0.74–0.75) or returns
  it to chance (uniform rewiring, 0.46–0.55; no edges, 0.50);
- the result survives the clock-blind ablation (0.884).

This supports exactly one claim:

> On controlled CloudProof Kubernetes interventions where pooled features are identical,
> relational message passing provides predictive information about simulator-derived safety
> outcomes.

It does not show any of the following:

- that relational message passing drives prioritization on the natural corpus (the pooled MLP
  matches the GNN there);
- that the model reads the causal outcome rather than a per-family structural preference (all
  nine unsafe→safe flips are wrong);
- that the effect beyond node degree transfers to unseen topologies (inconclusive at n = 45);
- anything about Kubernetes clusters in general.

Deterministic CloudProof remains the verifier; no neural model here certifies safety.

## 15. Next research stage

**Multi-service dependency topology.** The pass is narrow for a structural reason the II-A.2
corpus report already named: a single-service twin has little relational structure to
exploit. The decisive signal here is mostly how many pods sit on the crashing node, and on the
natural distribution a pooled model does as well.

The next stage should build worlds where predicting safety *requires* reasoning over
dependencies, so that the same failure in a different place has different consequences. That
means frontend → checkout → payment → database chains, with caches, queues, replicas, service
routing, zone placement and storage dependencies.

Its protocol should be committed before training, and should:

1. make uniform rewiring the primary destruction control, and report the degree-preserving
   permutation alongside it to separate degree from endpoint identity;
2. add a flat baseline given per-node degree and co-location statistics, so that "relational"
   means more than counting;
3. size the decisive pair set on unseen topologies so that a 0.10 lead over the
   degree-preserving control is detectable: roughly 350 pairs, eight times the 45 here, for
   intervals of about ±0.05;
4. include both directions of every intervention family in balanced numbers, so a fixed
   per-family preference cannot score well;
5. keep K = 5, the frozen-corpus rules and the deterministic verifier as the safety authority.

## Appendix A. Secondary exploratory horizon analysis

*Secondary exploratory horizon analysis. It is not part of the primary claim.*

For K = 1, 10 and 20 the unchanged architecture and recipe were trained as independent heads
that read `labels.horizons[K]`. `pos_weight` is recomputed from each horizon's training
prevalence, as the frozen rule prescribes.

The protocol treated these horizons as optional and preferred a reduced run with one seed per
model family. They were instead trained as full five-seed ensembles (30 members, see §5.2).
That adds precision, but no weight to the claim.

<!-- generated:secondary-transition -->
| K | Positive rate val / test / OOD | Model | AUROC val / test / OOD | AUPRC val / test / OOD | NLL test / OOD | Best epochs |
| ---: | --- | --- | --- | --- | --- | --- |
| 1 | 2.5 % / 2.5 % / 2.4 % | GNN head | 0.9665 / 0.9803 / 0.9663 | 0.5104 / 0.5944 / 0.4365 | 0.0853 / 0.1298 | 5, 6, 7, 5, 2 |
| 1 | 2.5 % / 2.5 % / 2.4 % | Pooled MLP head | 0.9691 / 0.9737 / 0.9619 | 0.4644 / 0.5065 / 0.3867 | 0.0966 / 0.1545 | 3, 3, 3, 4, 2 |
| 1 |  | frozen K = 5 GNN scored at K = 1 | 0.9278 / 0.9479 / 0.9369 | 0.3548 / 0.5108 / 0.3262 | 0.2095 / 0.4590 | — |
| 5 | 7.3 % / 7.0 % / 7.1 % | GNN head | 0.7931 / 0.7904 / 0.7221 | 0.3641 / 0.3711 / 0.2328 | 0.2622 / 0.4829 | 4, 7, 7, 6, 7 |
| 5 | 7.3 % / 7.0 % / 7.1 % | Pooled MLP head | 0.7935 / 0.7873 / 0.7122 | 0.3345 / 0.3373 / 0.2143 | 0.2715 / 0.7134 | 9, 8, 7, 1, 4 |
| 10 | 11.9 % / 11.3 % / 11.7 % | GNN head | 0.7150 / 0.7108 / 0.6268 | 0.3355 / 0.3408 / 0.2217 | 0.3443 / 0.5716 | 6, 3, 3, 6, 7 |
| 10 | 11.9 % / 11.3 % / 11.7 % | Pooled MLP head | 0.7382 / 0.7232 / 0.6277 | 0.3503 / 0.3323 / 0.2110 | 0.3508 / 0.9177 | 6, 8, 6, 1, 4 |
| 10 |  | frozen K = 5 GNN scored at K = 10 | 0.7172 / 0.7139 / 0.6339 | 0.3551 / 0.3490 / 0.2317 | 0.3347 / 0.5253 | — |
| 20 | 19.7 % / 18.7 % / 19.5 % | GNN head | 0.6717 / 0.6708 / 0.6041 | 0.3773 / 0.3620 / 0.2810 | 0.4564 / 0.6473 | 2, 5, 3, 4, 2 |
| 20 | 19.7 % / 18.7 % / 19.5 % | Pooled MLP head | 0.6935 / 0.6798 / 0.5926 | 0.4044 / 0.3647 / 0.2783 | 0.4549 / 1.1001 | 2, 5, 6, 6, 7 |
| 20 |  | frozen K = 5 GNN scored at K = 20 | 0.6617 / 0.6656 / 0.5884 | 0.3864 / 0.3775 / 0.2822 | 0.4663 / 0.5939 | — |
<!-- /generated:secondary-transition -->

<!-- generated:secondary-pairs -->
| K | GNN head: correct / ties / tie-aware [95 %] | Pooled MLP head: correct / ties / tie-aware |
| ---: | --- | --- |
| 1 | 154 / 0 / 0.890 [0.844, 0.936] | 0 / 173 / 0.500 |
| 5 | 151 / 0 / 0.873 [0.821, 0.919] | 0 / 173 / 0.500 |
| 10 | 154 / 0 / 0.890 [0.844, 0.936] | 0 / 173 / 0.500 |
| 20 | 150 / 0 / 0.867 [0.815, 0.913] | 0 / 173 / 0.500 |
<!-- /generated:secondary-pairs -->

What the secondary heads show:

- Every GNN head ranks the decisive pairs at 0.867–0.890, and every pooled head ties them. The
  K = 5 pair result is therefore not specific to one label or one training run.
- On natural data neither model family is consistently ahead in AUROC (the pooled MLP leads
  on validation at K = 10 and 20). The GNN is consistently better calibrated on OOD.
- The task gets harder as the horizon grows, as it should on a corpus without construction
  shortcuts.

## Appendix B. Regression

Audit run of 2026-09-23 on the final tree:

| Suite | Command | Result |
| --- | --- | --- |
| Python (`ml/cloudproof`) | `python ml/cloudproof/tests/run_tests.py` | 44 / 44 pass (39 existing + 5 new) |
| Node (CI command) | `node --test sim/*.test.js packages/*/*.test.js refund-provider/*.test.js tools/*.test.js` | 157 / 157 pass |
| Replica | `cd replica && npm test` | 69 / 69 pass |
| Phase I byte-identical replay | `node tools/cloudproof.js replay --file artifacts/cloudproof/failure-1337.json` | `REPRODUCED BYTE-IDENTICALLY: ROLLOUT_AVAILABILITY_VIOLATION` |
| Corpus SHA-256 and 173-pair verification | `python -m ml.cloudproof.phase_ii_b2 verify` | passed; 180 170 rows, six digests equal to the freeze, 173 decisive pairs with the frozen digest; identical to the committed record apart from timing |
| Per-pair reproduction | `python -m ml.cloudproof.phase_ii_b2 pair-audit` | 21 / 21 arms reproduce `counterfactual-ranking.json`; the tie assertions hold |
| Report tables vs artifacts | `python -m ml.cloudproof.phase_ii_b2_report --check` | 20 / 20 tables match |
| Manifests vs committed bytes | SHA-256 recomputed from the staged git blobs | 83 / 83 committed entries, 9 / 9 per-model manifests and the freeze digest match; 45 / 45 weight hashes unchanged |
| Syntax and modules | `python -m py_compile ml/cloudproof/*.py ml/cloudproof/tests/*.py`; `node --check` on the benchmark and replay tools | clean |
| `git diff --check` | | clean |

## Appendix C. Reproduction

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
python -m ml.cloudproof.phase_ii_b2 train --models gnn-full,pooled-mlp --horizons 1,10,20 --concurrency 6
python -m ml.cloudproof.phase_ii_b2 evaluate --concurrency 8
python -m ml.cloudproof.phase_ii_b2 pairs
python -m ml.cloudproof.phase_ii_b2 pair-audit
python -m ml.cloudproof.phase_ii_b2 report
python -m ml.cloudproof.phase_ii_b2_report
```

All `phase_ii_b2` commands default to `--corpus artifacts/cloudproof/causal-corpus-v2 --freeze
CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json --out artifacts/cloudproof/phase-ii-b2` and abort on
any digest mismatch. `train` and `evaluate` are resumable: finished members and prediction
files are skipped. The logged runs used concurrency 12, 10 and 11. Concurrency affects wall
time only, and 4–6 is the better default on this machine (§5.2).

## Appendix D. Files

```
CLOUDPROOF-PHASE-II-B2.md                       this report (tables generated by ml/cloudproof/phase_ii_b2_report.py)
artifacts/cloudproof/phase-ii-b2/
  config.json                                   frozen recipe, models, criteria, field lists, trained artifacts
  frozen-corpus-verification.json               recomputed digests, counts, split integrity, pair checks
  metrics.json                                  transition metrics per artifact/split with trajectory-bootstrap AUROC intervals; secondary-horizon scoring
  trajectory-metrics.json                       maximum-risk trajectory metrics with intervals; corpus baselines
  counterfactual-ranking.json                   every model × mode × seed on every pair set
  statistical-tests.json                        primary pair statistics, paired comparisons, attribution verdict
  pair-audit.json                               per-pair margins (173 pairs × 21 arms), reproduction check, tie assertions, post-hoc subsets
  ablations.json                                edge destruction on natural data
  clock-blind.json                              full vs clock-blind GNN side by side
  fixed-budget.json                             frozen-pool verification benchmark, Phase I replay, flat-feature identity
                                                (controller-state signature lists replaced by count + SHA-256;
                                                the full 9.7 MB export stays local in raw/fixed-budget-full.json)
  training-summary.json                         epochs, seconds, validation metrics per artifact and run
  manifest.json                                 git state, environment, SHA-256 of every artifact file and model weight
  models/<artifact>/{config,metrics,manifest,member-i}.json   per-model provenance (weights *.pt are gitignored, hashed in manifest.json)
```

Logs, per-row predictions and weights are not committed. Every committed JSON is written with LF
line endings and checked out with LF on every platform (`.gitattributes`), so the SHA-256 values
in `manifest.json` match the committed bytes everywhere.

## Appendix E. Audit record (2026-09-23)

The audit ran after the results were committed (`0e4f013`) and pushed. It changed no model, no
threshold and no rule. It made the following changes:

- **Independent re-derivation of the primary test.** The audit rebuilt the 173 decisive pairs
  from the raw pair file. Their digest equals the frozen one. It re-scored all 21 K = 5 arms
  with the frozen weights, and every count, interval, p-value (also checked with SciPy) and
  paired difference equals the committed JSON. `pair-audit` records this, exports per-pair
  margins and asserts the ties that construction implies.
- **Post-hoc subsets (§11.3)**, labelled as such, with the stricter reading 3′ of criterion 3.
- **Corrected invalid-pair count** in `frozen-corpus-verification.json` (112 → 56), with a
  self-check in `verify`.
- **Line-ending provenance fix.** `json_dump` wrote CRLF on Windows, so `manifest.json` and the
  per-model manifests hashed CRLF bytes that no LF checkout reproduces. The Node-written
  `fixed-budget.json` and the freeze record failed the opposite way on Windows. `json_dump` now
  writes LF, and `.gitattributes` pins LF for these files. Every committed JSON was shown to
  differ from its blob only in line endings before being restored, and the manifests were
  re-recorded over the committed bytes. Weight hashes are unchanged.
- **This report was restructured** to the protocol's 15 sections, with every numeric table
  generated from the JSON. The secondary horizons moved out of the primary claim into
  Appendix A. The allowed claim now uses the protocol's exact wording. The claim that II-B.1
  "ran only" the degree-preserving permutation, and the 582-vs-579 "single counterexample",
  were corrected.
