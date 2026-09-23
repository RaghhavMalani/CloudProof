# CloudProof Phase II-B.1 — Attribution & Leakage Audit

## Decision

The attribution gate failed. The bounded learned prioritizer remains practically useful, but the current evidence does **not** support the claim that correct relational graph structure caused its gain. Full-corpus acceptance, commit, push, and PR creation are intentionally withheld until the corpus is repaired.

The most defensible current hypothesis is:

> Learned nonlinear state/action scoring guides deterministic verification well on this corpus, but correct dependency topology is not responsible for the headline result.

## Protocol

All learned controls use the same first 10,000 training transitions, 5,000 validation transitions, three epochs, five seeds (`1337, 2027, 4099, 7919, 104729`), and 5,000 records per reported evaluation split. Fixed-budget evaluation replays all 5,292 validation/test/OOD schedules, containing 2,646 deterministic counterexamples. Generated model and raw audit artifacts remain under ignored `artifacts/cloudproof/` paths.

The pooled MLP uses typed mean/min/max/sum pooling plus action features. It has 137,665 parameters versus 123,793 for the GNN (1.11×), removing the earlier underpowered-flat-baseline confound.

## Fixed-budget attribution

Failures found by verification budget:

| Prioritizer | 100 | 500 | 1,000 | 5,000 |
| --- | ---: | ---: | ---: | ---: |
| Random | 50 | 251 | 518 | 2,505 |
| Logistic | 0 | 98 | 249 | 2,354 |
| Heuristic | 100 | 346 | 549 | 2,578 |
| Full GNN | 100 | 490 | 929 | 2,597 |
| Action-only | 100 | **500** | **1,000** | 2,540 |
| State-only | 100 | **500** | **1,000** | 2,570 |
| Pooled MLP | 100 | **500** | 931 | 2,548 |
| Permuted-label GNN | 100 | 245 | 470 | 2,354 |

Both input halves independently expose strong shortcuts. The topology-blind pooled MLP matches or exceeds the GNN at budgets 500 and 1,000.

## Transition-level comparison

| Model | Parameters | Test AUROC | Test AUPRC | OOD AUROC | OOD AUPRC |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full GNN | 123,793 | 0.9827 | 0.8998 | 0.9841 | 0.8949 |
| Action-only | 13,633 | 0.8527 | 0.5476 | 0.8560 | 0.5566 |
| State-only | 119,185 | 0.9420 | 0.7136 | 0.9735 | 0.8176 |
| Pooled MLP | 137,665 | **0.9887** | **0.9268** | **0.9871** | **0.9000** |
| Permuted labels | 123,793 | 0.6923 | 0.1472 | 0.7388 | 0.1767 |

The pooled MLP beats the GNN on both test and OOD transition metrics. The permutation control is approximately random at the schedule objective (245 failures at budget 500 versus random's 251), but its near-constant scores retain non-chance AUROC. This is consistent with residual construction/inductive-prior ordering and is not a clean sanity result.

## Edge destruction

| Frozen GNN intervention | 100 | 500 | 1,000 | 5,000 |
| --- | ---: | ---: | ---: | ---: |
| Full | 100 | 490 | 929 | 2,597 |
| Randomized endpoints | 100 | 490 | 929 | 2,597 |
| Collapsed edge types | 100 | **500** | **1,000** | 2,597 |
| No edges | 100 | **500** | **1,000** | 2,551 |
| Permuted relation labels | 100 | **500** | **1,000** | 2,597 |

Randomizing every eligible relation endpoint leaves the exact schedule ranking result unchanged. The graph has many symmetric resource features and star-shaped relations, so endpoint permutation is often functionally invisible to mean aggregation. Removing or relabelling structure improves low-budget discovery. Correct graph wiring therefore does not explain `490 > 346`.

On 5,000 transition slices, randomized endpoints also change AUROC by at most `0.00010`. Removing all edges lowers AUROC by 0.0171 validation, 0.0085 test, and 0.0286 OOD, while sharply worsening calibration. The network uses message presence/volume, but not the correct topology required by the causal claim.

## Matched topology counterfactuals

The generator creates 250 deterministic pairs. Each pair has the same topology parameters, node/resource features, action, traffic, and non-placement relations. Only `RUNS_ON` differs: `2/2/2` pod placement is safe under loss of the target zone, while `4/1/1` is unsafe.

| Model | Correct | Ties | Pairwise accuracy | Mean risk margin | Pair AUROC |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full GNN | 167/250 | 0 | 66.8% | 0.00203 | 0.5282 |
| Pooled MLP | 0/250 | 250 | 0% strict / 50% tie-aware | 0 | 0.5000 |

The GNN contains a small topology signal, but the tiny margin and near-random pair AUROC cannot explain the fixed-budget gain. The earlier single-pair negative result (`-0.00070`) remains reported rather than discarded.

## Scenario-construction leakage

The complete 10,000-schedule / 320,256-transition corpus was audited.

| Property | SAFE | UNSAFE |
| --- | ---: | ---: |
| Mean schedule length | **42.00** | **6.01** |
| Runtime | 100% `correct` | 100% mutant runtimes |
| No injected fault combination | 100% | 0% |
| `TRAFFIC_SPIKE` present | 0% | 38.26% |
| `READINESS_DELAY` present | 0% | 61.74% |
| `HPA_STALE_METRIC` present | 0% | 38.26% |
| `IMAGE_PULL_DELAY` present | 0% | 38.22% |
| `ENDPOINT_PROPAGATION_DELAY` present | 0% | 38.22% |
| `KUBELET` controller action present | 13.66% | 0% |
| `PDB` controller action present | 13.64% | 0% |

Selected transition-weighted state means also differ: desired replicas `6.21` vs `5.84`, pending pods `0.14` vs `0.29`, rollout-active `0.39` vs `0.13`, and HPA-active `0.001` vs `0.060` for SAFE vs UNSAFE trajectories.

Only 4,980 unique state/action fingerprints occur among 320,256 transitions; 4,747 fingerprints are duplicated, accounting for 315,276 duplicate occurrences. No fingerprint crosses topology splits, but five fingerprints have conflicting labels. This is not direct test leakage, yet it demonstrates how repetitive and construction-driven the supervised problem is.

## Horizon analysis

The complete validation schedule set was replayed with deterministic labels at K = 1, 3, 5, 10, and 20. The same frozen model was evaluated on 5,000 aligned transitions.

| K | Positive rate | AUROC | AUPRC |
| ---: | ---: | ---: | ---: |
| 1 | 2.34% | 0.9361 | 0.2066 |
| 3 | 5.62% | 0.9471 | 0.4537 |
| 5 | 8.64% | **0.9665** | **0.8068** |
| 10 | 10.74% | 0.9449 | 0.7577 |
| 20 | 10.74% | 0.9449 | 0.7577 |

The model is strongest at its trained K=5. K=10 and K=20 coincide because these short unsafe trajectories contain no additional future failures beyond ten transitions. At K=1, AUROC stays high but AUPRC falls sharply with prevalence; this does not demonstrate long-range prediction.

## Acceptance and next step

Full-corpus acceptance was not run. The brief explicitly made it conditional on passing attribution and leakage checks, and those checks failed. Training on all 148,732 train transitions would make the estimates more precise without making the corpus causally suitable for graph attribution.

The test and OOD slices were already examined in the earlier bounded Phase II-B study, so they also cannot honestly be called untouched final holdouts now.

Before acceptance:

1. Match SAFE/UNSAFE schedule-length distributions and action support.
2. Exercise each runtime/fault family in both safe and unsafe outcomes, with outcome determined by state/topology rather than family identity.
3. Deduplicate or group state/action fingerprints before splitting and weighting.
4. Build structurally rich tasks whose truth changes under dependency rewiring.
5. Freeze a new protocol and reserve new, unobserved test/OOD topologies.

No commit, push, or PR was created because the requested pre-push acceptance gate was not reached.
