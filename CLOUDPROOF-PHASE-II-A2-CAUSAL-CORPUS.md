# CloudProof Phase II-A.2 — Causal Corpus Repair

**Status:** infrastructure complete (II-A.2) and attribution-hardened (II-A.2.1);
bounded (2 000), intermediate (10 000) and full (50 000) corpora pass every hard gate;
the full corpus is frozen in `CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json` (§10.2); no
learned model has been trained on any of them.

## 0. Why Phase II-A is superseded

The previous apparent GNN gain cannot be attributed to graph topology because the
attribution audit found construction leakage and graph-destruction invariance.
Concretely, Phase II-B.1 ([CLOUDPROOF-PHASE-II-B1-ATTRIBUTION-AUDIT.md](CLOUDPROOF-PHASE-II-B1-ATTRIBUTION-AUDIT.md))
established on the Phase II-A corpus that:

- a topology-blind pooled MLP matched or beat the GNN on test and OOD transition metrics;
- randomizing every eligible graph endpoint left the fixed-budget schedule ranking byte-identical;
- matched topology pairs carried only a weak signal (pair AUROC 0.53);
- SAFE and UNSAFE trajectories differed by construction in length (42.0 vs 6.0 actions), runtime,
  fault presence (0% vs 100%), action support, and state distributions;
- a model trained on permuted labels retained non-chance transition AUROC (0.69);
- K = 10 and K = 20 horizons collapsed because unsafe trajectories were too short.

That result is preserved verbatim in commit `60df8a0` and in the audit files. Phase II-A.2
does not touch the GNN, its hyperparameters, or the training loop, and it does not
delete or regenerate the Phase II-A corpus (`sim/cloud-corpus.js` still produces it and CI
still runs its smoke gate). It replaces the *experiment*: labels must arise only from
deterministic CloudProof execution, and topology must be evaluable as a cause rather
than a correlate.

## 1. Failure analysis — which correlations created shortcuts

Every item below was verified against `sim/cloud-corpus.js`,
`sim/cloud-schedule.js`, and `packages/cloudproof/telemetry.js` at commit
`60df8a0`, not inferred from the audit tables.

| # | Shortcut channel in Phase II-A | Where it came from | Why it leaked into learning inputs |
| --- | --- | --- | --- |
| S1 | **Outcome decided before generation.** `scenarioDescriptor` sets `intendedOutcome = index % 2 === 1`, then picks runtime, scenario family, and traffic from that bit. `generateResearchCorpus` throws if execution disagrees. | `cloud-corpus.js:scenarioDescriptor`, the `expected … but was` guard | Nothing about the label was determined by state or topology; it was a template identifier. Every other channel is a symptom of this one. |
| S2 | **Traffic profile ⇔ label.** Safe scenarios always used `low` traffic (35% CPU); unsafe cycled `low/normal/spike`. | `trafficProfile = unsafe ? … : 'low'` | `HPA.currentMetric` and `hpa.recommendation` are tensorized node features. Any state with CPU ≠ 35 was unsafe. |
| S3 | **Runtime ⇔ label ⇔ fault template.** Safe = `correct` runtime, `safe` action family, zero faults. Unsafe = one of three mutants with a fixed fault prefix (`READINESS_DELAY`, `HPA_STALE_METRIC`, plus `IMAGE_PULL_DELAY`/`ENDPOINT_PROPAGATION_DELAY` for M1). | `unsafeVariants`, `mutantActions`, `augmentFaultCombination` | The candidate action type is one-hot in the action embedding; fault types appeared in 0% of safe rows and 38–62% of unsafe rows. The action-only model reached 0.85 AUROC from this alone. |
| S4 | **Schedule length ⇔ label.** Safe schedules were 1 operation + 8 fixed reconciliation cycles + 0–3 noise actions (41–44 actions, mean 42.00). Mutant probes were 5–7 actions (mean 6.01). | `safeActions` loop, `mutantActions` | `action.atMs` is the schedule index and is tensorized (`atMs / 10000`); timer-fired transitions carry the virtual clock. Position in the schedule and clock value both encode which template produced the row. |
| S5 | **Controller-action support differed by outcome.** `KUBELET` and `PDB` ticks appeared only through safe-schedule noise (13.7%), never in mutant probes. | `addNoise` only reachable from `safeActions`/`flagshipActions` | Same channel as S3: the action type alone separates families. |
| S6 | **Transition label ≈ trajectory outcome ≈ family.** With K = 5 and unsafe trajectories of ~6–10 transitions, nearly every unsafe transition is positive and every safe transition negative. | `TransitionTelemetry.export` window over short traces | The supervised target collapsed to "which template generated this state", so any feature separating templates (S2–S5) separated labels. K = 10 and K = 20 were identical because no unsafe trace had more than ten transitions. |
| S7 | **State repetition.** 4,980 unique state/action fingerprints among 320,256 rows; seeds only changed noise actions. | Fixed topology × fixed template × fixed traffic | Memorisation of ~5k fingerprints is sufficient; the "dataset size" was mostly duplicate rows. |
| S8 | **Post-incident rows.** The runtime keeps executing after the first violation and every later transition whose window still contains a failing state is labelled positive. | `firstFailure` is recorded but rows are not cut | Rows whose *current* state already violates an invariant (visible in `Service.endpointCount < minimumReady`) are trivially positive and inflate both prevalence and apparent skill. |
| S9 | **Counterfactual pairs bypassed the schedule contract.** The II-B.1 pairs mutated `simulation.state` directly and scored one (state, action). | `tools/cloudproof-counterfactuals.js:placePods` | Not replayable through `runCloudSchedule`; no trajectory-level truth; no aggregate matching guarantee beyond the single edge type. |
| S10 | **Held-out slices were examined.** The II-B bounded study reported test and OOD metrics on topologies K–M and OOD-A–D. | Phase II-B protocol | They are no longer untouched holdouts for any later claim. |

### How each corpus change removes a channel

| Change in Phase II-A.2 | Removes |
| --- | --- |
| **C1 — One outcome-blind generator** (`sim/cloud-causal-generator.js`). Every trajectory samples runtime, traffic, placement, warm-up length, per-trajectory fault hazard, and the action sequence from one distribution. The generator has no `intendedOutcome`, and the pipeline has no expectation guard: a schedule is whatever it executes to. | S1, S2, S3, S5 |
| **C2 — Labels only from deterministic execution.** `runCloudSchedule` runs the whole schedule; the first violating transition `f` (sequence, class, clock) is the only source of the trajectory outcome and of every horizon label `y_K(t) = [f − t < K]`. | S1 |
| **C3 — Longer, hazard-spread schedules.** 40–140 sampled actions, a sampled warm-up before the first fault is permitted, and a sampled per-trajectory fault hazard, so first incidents are distributed across the trajectory rather than at index ≤ 6. | S4, S6 (K = 1/5/10/20 become distinct) |
| **C4 — Pre-incident rows only.** ML rows stop at `f` (inclusive). Post-incident transitions are counted in metadata, replayed for the fingerprint, and never emitted as training rows. | S8 |
| **C5 — Outcome-blind checkpoint selection.** Every exogenous operation/fault row is kept; controller ticks and timer transitions are kept by a seeded coin that never reads labels. The failing transition is *not* force-kept, because doing so would make "timer action ⇒ positive" a new shortcut. | S7 (size), keeps S8 closed |
| **C6 — Position-free candidate action.** The model-input `action` carries only its type and semantic parameters; `id` and `atMs` move to `metadata.action`. The tensorizer is unchanged and reads `atMs` as 0. | S4 |
| **C7 — Post-hoc stratified matching.** Safe and unsafe trajectories are matched 1:1 inside strata (topology, runtime, traffic regime, schedule-length bucket) by nearest neighbour on standardized nuisance vectors (actions, transitions, virtual runtime, fault/operation/tick counts, per-fault-type counts, rollouts started, HPA scale events). Placement is deliberately *not* a matching variable — it is the causal variable under test. | Residual S2–S5 correlations that outcome-blind sampling leaves through genuine hazard effects |
| **C8 — `ShortcutProbe` gate.** A logistic model trained only on nuisance features (schedule length, transitions, virtual runtime, action/fault histograms, seed bucket, scenario family, transition index, clock, runtime id) must score ≤ 0.55 AUROC at both trajectory and transition level on held-out splits, or the corpus is rejected. | Detects anything C1–C7 missed |
| **C9 — Multi-seed label permutation gate.** Five permutation trials train the same baselines on shuffled labels and must land inside a chance band on real held-out labels. | The "0.69 AUROC under permuted labels" failure mode |
| **C10 — Counterfactual pairs through the schedule contract.** Placement becomes `scenarioParameters.placement`, so paired worlds are ordinary replayable schedules that differ in exactly one topology intervention with byte-identical exogenous actions. Pair truth is the trajectory outcome from the simulator, and the metric is pairwise ranking accuracy over discordant pairs. | S9 |
| **C11 — Fresh holdouts.** Topologies K–M move to validation (they were examined), new test topologies N–P and new OOD topologies OOD-E–H are reserved under `topology-holdout-v2`. Seeds start at 90000, disjoint from every earlier corpus. | S10 |
| **C12 — Trajectory identity on every row** plus trajectory-level and transition-level metrics, and per-trajectory difficulty tiers. | S7 (evaluation no longer counts correlated rows as independent evidence) |

## 2. Outcome-blind generation

`sim/cloud-causal-generator.js` has one code path. For a seed and a catalog entry it samples,
from one distribution: runtime (default `correct` only; mutants are an optional stratified
mix), initial traffic relative to the topology's HPA target, node placement per zone
(balanced / random / concentrated) and an optional spare node, a per-trajectory fault
hazard and operation rate, a short warm-up, and then an action sequence of 40–140 actions
mixing controller ticks, reconcile cycles, time advances, operations (scale, roll-out,
roll-back, drain, recover, traffic change) and faults (node crash, zone degraded,
readiness/image-pull/endpoint-propagation delays, stale HPA metric, controller restart).

The API is `sampleWorld → sampleActions → buildSchedule`; execution lives in
`sim/cloud-causal-corpus.js` (`executeCausalTrajectory`) and calls the unchanged
`runCloudSchedule`. The generator never imports the runtime, has no expectation guard, and
rejects any parameter or option it does not know, so `desiredOutcome`-style flags cannot
reach it. `sim/cloud-causal-corpus.test.js` checks this structurally (source scan plus
rejected flags) and behaviourally (safe and unsafe trajectories are produced by the same
`scenario: 'causal'` path).

Labels are derived only after execution: the first failing transition `f` of the full trace
gives the outcome, the violation class, `transitionsToIncident = f − t`, and
`horizons[K] = (f − t < K)` for K ∈ {1, 5, 10, 20}. `sloViolationWithinKTransitions` is kept
equal to the K = 5 label so the existing tensorizer reads v2 rows unchanged.

## 3. Post-hoc balancing

Generation is never adjusted toward a target balance. The pipeline runs two passes over one
index space: pass 1 executes every trajectory and keeps only a nuisance summary; matching and
pruning select trajectories; pass 2 re-executes the selected ones, asserts the replay
fingerprint is unchanged, and only then emits rows. The manifest reports the raw pool
(`counts.pool*`, `distributions.*.safe/unsafe`) next to the matched corpus
(`counts.selected*`), and `trajectories.jsonl` keeps every raw trajectory with its schedule,
outcome, `selected` flag and `matchId`.

## 4. Nuisance matching and shortcut pruning

`packages/cloudproof/nuisance.js` summarises each trajectory by schedule length, transition
count, virtual runtime, warm-up, hazards, fault/operation counts and per-type histograms,
initial CPU, initial ready/pending replicas, initial PDB headroom, replica/zone/node counts,
and controller-activity *rates* over the research window (timer fraction, HPA scale events per
100 transitions, rollout-active fraction, PDB decisions per 100). Rates are used instead of
counts because counts over the full trace carry the post-incident cascade and counts over the
window carry its length — both are the outcome. State summaries (degraded-node transitions,
meaningful-transition counts) are reported per outcome but excluded from matching and probing.

Matching is greedy 1:1 nearest neighbour inside hierarchical strata (topology, runtime, traffic
regime, capacity-loss count, fault count, roll-outs, length quartile; coarsened level by
level, the last level still pinned to the split), with a weighted standardized caliper.
Placement is deliberately not matched: it is the causal variable under test. Matching is a
pure function of the summaries and the pipeline asserts a second call reproduces the pair list.

Pruning (`pruneShortcutPairs`, AFLite-style) then fits the nuisance-only probe with 4-fold
cross-fitting and drops the 10% most nuisance-predictable pairs per round until the cross-fit
AUROC ≤ 0.55 or 40% of the pairs remain. Every dropped pair is counted, every round is
recorded, and both the pre-matching and post-matching standardized mean differences are
kept as the "before" columns.

## 5. ShortcutProbe

A logistic model on nuisance only (schedule and activity summaries, runtime, traffic regime,
seed bucket, scenario family; at transition level also sequence, relative sequence, clock
and relative clock). It never sees the graph, resource features, placement, the candidate
action, labels, failure classes or outcomes. It is trained on the train split and reported
per held-out split with AUROC, AUPRC, Brier and ECE, plus a pooled held-out estimate.
Gate bands: target ≈ 0.5, warning above 0.55, hard failure at ≥ 0.65. A split enters the
hard gate on its own only when it is large enough for an AUROC to mean something
(≥ 100 trajectories or ≥ 2 000 rows); smaller splits count through the pooled estimate.
Two decompositions are reported at transition level: trajectory-nuisance-only and
position-only.

## 6. Label-permutation sanity test

For each of five fixed seeds the train labels are shuffled, the same trajectory probe,
transition probe and class-balanced logistic baseline are refitted, and untouched
validation labels are scored. Mean, standard deviation, minimum and maximum are reported per
family. Gate: each family's mean within max(0.03, 2.5 SE) of 0.5 and every trial within
max(0.15, 3 SD). On a bounded corpus a permuted logistic model is a random direction in an
informative 9-feature space and legitimately scatters by several hundredths; the allowance
widens with the observed spread and collapses at full scale. Trials outside ±0.05 are
counted as warnings, never hidden.

## 7. Counterfactual topology pairs

`packages/cloudproof/counterfactual-pairs.js` builds pairs through the ordinary schedule
contract: placement became `scenarioParameters.placement`, so both members are replayable
schedules sharing seed, runtime, traffic, a quiet reconcile prefix, one intervention and one
sampled continuation. Families: zone-placement (2/2/2 vs 6/0/0 then `ZONE_DEGRADED`),
node-placement (same placements then `NODE_CRASH` of the concentrated zone's node),
pdb-placement (same then `DRAIN_NODE` under the PDB), capacity-distribution (identical pods;
the one spare node outside vs inside the zone that degrades). Every pair records `pairId`,
`baseScenarioId`, `interventionType`, control/treated topology, `sharedExogenousScheduleDigest`
(re-derived from each executed schedule and asserted equal), control/treated outcome and
failure class, `outcomeChange` (`same`, `safe->unsafe`, `unsafe->safe`), an aggregate-feature
delta (per-type node-feature multisets) and a structural delta (relation types that differ).
Pair truth is simulator output; a deterministic sample is re-executed and fingerprints compared.
`pairwiseRanking` scores discordant pairs only.

### 7.1 Relational-only families (Phase II-A.2.1)

The bounded run showed that the heuristic and the logistic baseline ranked every flipping
placement pair correctly: the intervention was visible through the flat `zoneConcentration`
feature, so those pairs could not isolate graph structure. Three further families keep
**every per-type node-feature multiset, every per-zone pod count, the endpoint count, the
zone-concentration statistic and the intervention identical** between members; only which
resource is related to which differs:

| Family | Shared | Differs | Intervention |
| --- | --- | --- | --- |
| `node-concentration` | identical nodes (target zone has two), identical pods per zone | target zone's pods spread over its two nodes vs stacked on the first (`podsPerNode`) | `NODE_CRASH` of that first node |
| `readiness-wiring` | identical pods per zone, k pods start not-ready in both | the k unready pods sit inside the target zone vs outside it (`startingPerZone`) | `ZONE_DEGRADED` of the target zone |
| `readiness-drain` | as above | as above | `DRAIN_NODE` of the target zone's node |
| `capacity-distribution` | identical pods and node multiset | the spare node's zone (`LOCATED_IN`) | `ZONE_DEGRADED` |

`placement.podsPerNode` and `placement.startingPerZone` extend the schedule contract
(default path byte-identical). Every pair records `pooledInputsIdentical` (per-type
node-feature multisets equal, hence identical inputs to the pooled MLP's typed
mean/min/max/sum) and `flatSummaryIdentical` (the nine flat risk features equal); both are a
hard gate for relational-only families, and `ml/cloudproof/tests/test_relational_pairs.py`
tensorizes the committed fixture (`artifacts/cloudproof/datasets/relational-pairs-95000.jsonl`)
and proves the untrained pooled MLP emits identical logits for both members while the relation
tensors differ. Half of all generated pairs belong to relational-only families.

## 8. Horizons and meaningful transitions

Trajectories run 40–140 actions (median 118 raw transitions in the bounded pool); K = 1, 5,
10 and 20 are distinct label vectors and their positive rates rise monotonically. ML rows stop
at the first incident (inclusive); the raw trace is never truncated. Research rows are every
exogenous action, every transition whose observable controller state changed
(`meaningfulSignature`: readiness/pending/terminating, endpoint count, desired replicas and
version, node readiness/draining, rollout/HPA activity, PDB headroom), and a seeded 15% / 10%
of the remaining uneventful ticks / timers. Each row records `rawTransitionCount` and
`researchTransitionCount`, the checkpoint reason, and `replayDigest`.

### 8.1 Row cap and position balancing (Phase II-A.2.1)

Two row-level shortcuts survived trajectory-level matching in the 10 000-trajectory run:
(a) safe trajectories run to the end of their schedule while unsafe ones stop at the
incident, so long schedules flood the negatives and "long schedule" predicts the row label
(nuisance-only transition probe 0.567 pooled, 0.606 on test); (b) rows are truncated at the
incident and incidents are not exponentially timed, so the row index alone predicted the
label (position-only probe 0.637 pooled). Both are handled post-hoc and label-blind:

- **Row cap.** Each trajectory contributes at most the split's median research-row count;
  longer trajectories keep a seeded uniform sample of their rows. The label is never read.
- **Position balancing.** Rows are binned into (absolute-sequence × relative-position) cells;
  in cells below a row-weighted 75th-percentile target rate, negatives are dropped by a seeded
  coin until the cell reaches the target (never below 25% of its negatives, never a positive).
  Selection inside a cell is independent of state, so P(label | state, cell) is unchanged;
  only the mixture over cells is reweighted. Every cell's before/after rate is in the manifest.

The HPA's `sampledAtMs` is the one clock a scorer can read from the state graph, so it is
included in the position-only probe. Rows first land in staging files; the final split files
are streamed from staging with only the surviving record IDs.

### 8.2 Incident-class cap (Phase II-A.2.1)

`SERVICE_CAPACITY_COLLAPSE` supplied ~50% of unsafe trajectories in the raw pool and
`TRAFFIC_TO_UNREADY_POD` (the endpoint-propagation race) ~24%. After pruning, pairs of any
class above 40% of the matched unsafe set are dropped worst-match first until the cap holds.
The raw class distribution stays in the manifest; simulator semantics are untouched.

## 9. Split and OOD contract

`topology-holdout-v2`: train A–H (3–6 replicas), validation I–M (K–M demoted because Phase II-B
examined them), test N–P (new, 3–6 replicas), OOD OOD-E–H (new, 8–12 replicas). Every row
inherits its trajectory's split; pairs live in one topology and therefore one split.
`splitIntegrity` asserts pairwise emptiness of topology IDs, trajectory IDs, row trajectory
IDs and pair topology IDs across all six split pairs, and it is a hard gate. Seeds start at
90 000 (pairs at 95 000), disjoint from every earlier corpus; the bounded run below used
61 000.

## 10. Bounded results (`causal-corpus-bounded`, 2 000 trajectories, seed 61 000)

```bash
node tools/cloudproof-causal-corpus.js --simulations 2000 --seed 61000 \
  --minimum-trajectories 2000 --minimum-matched-pairs 100 --minimum-discordant-pairs 5 \
  --pairs 200 --budgets 10,50,100,500 --out artifacts/cloudproof/causal-corpus-bounded
```

This is a validation run of the infrastructure, not the research corpus.

| Quantity | Value |
| --- | ---: |
| Raw pool | 2 000 trajectories, 853 safe / 1 147 unsafe, 236 796 raw transitions |
| Matched pairs | 245 before pruning → 199 after (398 trajectories, 199 safe / 199 unsafe) |
| Research rows | 12 373 (train 5 505, validation 2 867, test 1 821, OOD 2 180); 10 201 post-incident transitions dropped |
| Raw transitions per selected trajectory | safe p10/p50/p90 = 63/107/160; unsafe 72/115/163 |
| First incident (unsafe) | sequence p10/p50/p90 = 23/62/115; relative position 0.22/0.55/0.90 |
| Horizon positive rates K=1/5/10/20 | 1.6% / 4.5% / 7.8% / 14.0% (distinct, strictly increasing) |
| Difficulty tiers (unsafe, selected) | T1 10, T2 75, T3 17, T4 18, T5 79 |
| Incident classes | capacity collapse 89, survivability 58, unready endpoint 39, rollout floor 9, autoscaler 4 |
| Max abs SMD | 0.89 raw → 0.30 after matching → 0.20 after pruning (effective gate 0.30 at 199 pairs) |
| ShortcutProbe, trajectory | pooled held-out AUROC 0.546 (AUPRC 0.533, Brier 0.299); validation 0.514, test 0.645 (54 traj.), OOD 0.512 |
| ShortcutProbe, transition K=5 | pooled 0.548; nuisance-only 0.536; position-only 0.553 (warning region) |
| Permutation (5 seeds, validation) | trajectory probe 0.513 ± 0.029; transition probe 0.524 ± 0.033; logistic 0.521 ± 0.100 (min 0.385, max 0.655) |
| Counterfactual pairs | 200 built, 195 valid; 47 flipped (all safe→unsafe), 148 unchanged; aggregate features matched in 200/200 |
| Flips by family | zone-placement 22/79, node-placement 25/78, pdb-placement 0/18, capacity-distribution 0/20 |
| Pair ranking (discordant) | heuristic 47/47, logistic 47/47 (both carry a zone-concentration feature) |
| Baselines K=5, held-out AUROC | heuristic 0.57/0.61/0.61; logistic 0.64/0.61/0.51 (val/test/OOD); trajectory-level ≈ 0.5 |
| Fixed-budget prioritization (222 held-out, 111 counterexamples) | random 62, coverage 57, heuristic 52, logistic 51 at budget 100 — no method beats random on a 50/50 matched set |
| Replay | 398/398 re-executions fingerprint-identical; 10/10 sampled pairs identical; Phase I `failure-1337` byte-identical |

All hard gates pass. Warnings recorded: the position-only probe sits at 0.55–0.60 and seven
permutation trials fall outside ±0.05.

What the bounded run says, honestly: outcome-blind generation plus matching and pruning brings
nuisance predictability from the Phase II-A regime (length alone separated the classes) to
≈ 0.55; the remaining transition-level signal is position (rows are truncated at the first
incident, and incidents are not exponentially distributed), which the model does not receive
(`atMs` is stripped from the candidate action). Topology flips outcomes in 47/195 valid pairs,
all in the placement families; the PDB and capacity families never flipped at this scale and
are reported as such. The linear baselines are near chance at trajectory level and cannot
prioritize this balanced held-out set — which is the point: a matched corpus removes the free
lunch the old corpus handed every method.

## 10.1 Intermediate results (`causal-corpus-10k`, 10 000 trajectories, seed 70 000)

```bash
node tools/cloudproof-causal-corpus.js --simulations 10000 --seed 70000 --pair-seed 75000 \
  --minimum-trajectories 10000 --minimum-matched-pairs 500 --minimum-discordant-pairs 50 \
  --pairs 800 --budgets 50,100,500,1000 --out artifacts/cloudproof/causal-corpus-10k
```

| Quantity | Value |
| --- | ---: |
| Raw pool | 10 000 trajectories, 4 254 safe / 5 746 unsafe, 1 191 407 raw transitions |
| Matched | 1 732 pairs → 1 138 after pruning → 1 040 after the class cap (2 080 trajectories, 1 040 / 1 040) |
| Class cap | capacity collapse 514 → 416 (40%); unready endpoint 244; survivability 291; rollout floor 62; autoscaler 27 |
| Research rows | 70 191 → 49 135 after the row cap (median cap 27–36 rows) → **33 408** after position balancing (train 13 112 / val 7 911 / test 5 118 / OOD 7 267) |
| Horizon positives K=1/5/10/20 | 955 / 2 640 / 4 183 / 6 922 rows (2.9% / 7.9% / 12.5% / 20.7%) |
| Max abs SMD after matching | 0.143 (`transitions` 0.14, `zones` −0.13 are the only features above 0.10) |
| ShortcutProbe, trajectory | pooled 0.524 (AUPRC 0.543, Brier 0.280); val 0.523 / test 0.555 / OOD 0.516 |
| ShortcutProbe, transition K=5 (with position) | pooled 0.527; val 0.537 / test 0.570 / OOD 0.516 |
| — trajectory-nuisance-only | pooled 0.510; val 0.521 / test 0.554 / OOD 0.495 |
| — position-only | pooled 0.574; val 0.582 / test 0.589 / OOD 0.553 (warning region) |
| — K=1 with position | pooled 0.572; test 0.619 (warning region; K=1 positives are the incident row itself) |
| Permutation (12 seeds) | trajectory probe 0.491 ± 0.028, transition probe 0.501 ± 0.014, logistic 0.516 ± 0.051; every 95% interval contains 0.50 |
| Counterfactual pairs | 800 built, 775 valid, 126 flipped (122 safe→unsafe, 4 unsafe→safe), 649 unchanged |
| Relational-only pairs | 438 valid, **72 flipped**; pooled inputs identical 438/438; flat risk features identical 438/438 |
| Flips by family | node-concentration 35/123, readiness-wiring 24/140, readiness-drain 12/117, capacity 1/58; node-placement 32/139, zone-placement 19/138, pdb 3/60 |
| Heuristic / logistic on relational-only flips | **0 correct, 71/71 ties** (both tie by construction); on placement flips 51/51 correct |
| Baselines K=5 (val/test/OOD AUROC) | heuristic 0.57/0.60/0.56; logistic 0.63/0.63/0.54; trajectory-level ≈ 0.5 |
| Fixed-budget prioritization (1 250 held-out, 625 counterexamples) | random 240 / coverage 295 / heuristic 239 / logistic 256 at budget 500 |
| Replay | 2 080/2 080 fingerprint-identical; 20/20 sampled pairs identical; Phase I byte-identical |

All hard gates pass under the full-scale defaults (split ceiling 0.60, hard 0.65, SMD 0.20,
class cap 0.40, 12 permutation seeds). Warnings: every probe variant sits in the 0.55–0.60
warning region on at least one split, and position-only remains the strongest residual.

## 10.2 Frozen corpus (`causal-corpus-v2`, 50 000 trajectories, seeds 90 000 / 95 000)

Generated by the command in §12 with the CLI defaults (all full-scale gates on); 991 s on
14 worker threads; freeze record `CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json` (generator commit
`42fda40`, SHA-256 per file). The corpus directory itself is gitignored (1.4 GB).

| Quantity | Value |
| --- | ---: |
| Raw pool | 50 000 trajectories, 21 524 safe / 28 476 unsafe, 5 934 217 raw transitions |
| Matched | 9 996 pairs → 5 315 after pruning (7 rounds, cross-fit probe 0.739 → 0.535) → **4 856** after the class cap (9 712 trajectories, 4 856 / 4 856) |
| Matching levels | 4 565 / 999 / 670 / 618 / 3 144 pairs at strata levels 0–4 |
| Class cap | capacity collapse 2 401 → 1 942 (40%); survivability 1 329; unready endpoint 1 074; rollout floor 333; autoscaler 178 |
| Research rows | 351 287 → 250 496 after the row cap (median 29–38 rows) → **180 170** after position balancing (train 73 782 / val 48 337 / test 28 142 / OOD 29 909); 231 041 post-incident transitions dropped |
| Trajectory length (selected) | raw transitions p10/p50/p90 = 64/112/165 (safe), 69/118/169 (unsafe); first incident at sequence 28/66/122 |
| Horizon positives K=1/5/10/20 | 4 406 / 12 799 / 20 784 / 34 621 rows (2.4% / 7.1% / 11.5% / 19.2%) |
| Difficulty tiers (unsafe) | T1 249, T2 1 869, T3 292, T4 691, T5 1 755 |
| Max abs SMD after matching | **0.122** (`transitions`; no other feature above 0.10) |
| ShortcutProbe, trajectory | pooled 0.529 (AUPRC 0.533, Brier 0.259); val 0.541 / test 0.567 / OOD 0.508 |
| ShortcutProbe, transition K=5 (with position) | pooled 0.542; val 0.553 / test 0.579 / OOD 0.513 |
| — trajectory-nuisance-only | pooled 0.525; val 0.542 / test 0.568 / OOD 0.484 |
| — position-only | pooled 0.562; val 0.553 / test 0.565 / OOD 0.569 |
| — K=1 with position | pooled 0.581; val 0.596 / test 0.600 / OOD 0.555 |
| Permutation (12 seeds, validation) | trajectory probe 0.509 ± 0.018 [0.499, 0.520]; transition probe 0.495 ± 0.021 [0.483, 0.507]; logistic 0.503 ± 0.078 [0.459, 0.547]; no family with every trial above 0.53 |
| Counterfactual pairs | 2 000 built, 1 944 valid, **354 flipped** (344 safe→unsafe, 10 unsafe→safe), 1 590 unchanged |
| Relational-only pairs | 1 111 valid, **173 flipped**; pooled inputs identical 1 111 / 1 111; flat risk features identical 1 111 / 1 111; 34 infeasible |
| Flips by family | node-concentration 86/302, readiness-wiring 55/337, readiness-drain 31/316, capacity 1/156; node-placement 92/339, zone-placement 82/334, pdb 7/160 |
| Heuristic on relational-only flips | 0 correct, 172/173 ties (1 capacity pair scored); on placement flips 174/174 correct |
| Logistic on relational-only flips | 0 correct, 172/173 ties; on placement flips **0/174 correct** (its zone-concentration weight is negative on the matched corpus) |
| Baselines K=5 (val/test/OOD AUROC) | heuristic 0.60/0.58/0.55; logistic 0.64/0.61/0.54; trajectory-level 0.51/0.47/0.50 (heuristic), 0.53/0.54/0.49 (logistic) |
| Fixed-budget prioritization (5 838 held-out, 2 919 counterexamples) | budget 500: random 254, coverage 302, heuristic 237, logistic 242; budget 1 000: 487 / 608 / 495 / 488 |
| Replay | 9 712/9 712 re-executions fingerprint-identical; 20/20 sampled pairs identical; Phase I `failure-1337` byte-identical |

Warnings recorded in the freeze: all four probe variants sit in the 0.55–0.60 region on at
least one held-out split (test is consistently the highest, 0.57–0.58); nine of 36
permutation trials fall outside ±0.05 (all inside their family's 95% interval); and
`transitions` retains |SMD| = 0.12.

Reading: at 50 000 trajectories the trajectory-level ShortcutProbe is at 0.53 pooled against
the Phase II-A regime where schedule length alone separated the classes; the linear baselines
tie by construction on every relational-only pair while ranking the flat-visible placement
pairs perfectly (heuristic) or perfectly wrongly (logistic); the pooled MLP cannot separate any
relational-only pair by construction (identical inputs). The corpus therefore supports the
Phase II-B.2 question — whether a GNN ranks the 173 relational-only flips above chance and
whether randomizing its edges removes that ability — without handing any model a free lunch.

## 11. Limitations

- The cloud twin is still a simplified single-service Kubernetes control plane; a graph model
  has limited relational structure to exploit until multi-service dependencies exist.
- Topology interventions are synthetic; counterfactual pairs establish simulator-level
  causality, not universal Kubernetes causality.
- The `TRAFFIC_TO_UNREADY_POD` race between endpoint reconciliation and propagation is a
  property of the twin's correct model under discrete schedules; the generator settles after
  endpoint reconciles more often to avoid manufacturing it, but it remains common.
- Nuisance matching and pruning cannot prove the absence of every shortcut; the probe is
  linear and the nuisance set is enumerated by hand.
- Pruning is post-hoc selection on the label. It is allowed because generation never saw the
  label, but it shifts the corpus toward outcomes that nuisance cannot explain and every
  dropped pair is recorded for that reason.
- Position remains weakly informative at transition level after balancing (position-only
  probe ≈ 0.57 pooled, K=1 up to 0.62 on one split); the model does not receive position, but
  `HPA.sampledAtMs` is a clock inside the state and Phase II-B.2 must include a clock-blind
  ablation.
- The row cap and position balancing reweight which rows a trajectory contributes; they never
  consult the label or the state, but the emitted rows are a subsample, and the raw trace is
  the only complete record (`rawTransitionCount` vs `researchTransitionCount`).
- The PDB and capacity-distribution families almost never flip under the current invariants;
  they are kept and reported, not counted as evidence.
- No learned model has been retrained on the repaired corpus; no claim of GNN superiority
  survives from Phase II-B.
- Sim-to-real evidence still comes from the Phase I flagship scenario, not from this corpus.
- The bounded run's per-split estimates on test (54 trajectories) and OOD (62) are noisy;
  the full corpus is required before any per-split number is quoted.

## 12. Full-corpus generation and freeze

```bash
node tools/cloudproof-causal-corpus.js \
  --simulations 50000 --seed 90000 \
  --pairs 2000 --pair-seed 95000 \
  --budgets 100,500,1000,5000 \
  --out artifacts/cloudproof/causal-corpus-v2
node tools/cloudproof-corpus-freeze.js artifacts/cloudproof/causal-corpus-v2 \
  CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json
```

Full-scale acceptance (all enforced by the CLI defaults unless noted):

```text
ShortcutProbe   pooled held-out AUROC ≤ 0.55 preferred (warning above); every size-gated
                split < 0.60; no probe variant ≥ 0.65
Permutation     12 seeds; each family's 95% interval contains 0.50; no family with every
                trial above 0.50 + 0.03
Matching        max |SMD| ≤ 0.20 (finite-sample floor 3·sqrt(2/pairs)); every feature above
                0.10 listed in the acceptance record
Horizons        K1 < K5 < K10 < K20 positive prevalence, each with ≥ 20 positives
Counterfactuals ≥ 2 relational-only families with ≥ 1 flipping pair; pooled inputs and flat
                risk features identical in every valid relational-only pair
Incident classes no class above 40% of matched unsafe trajectories
Integrity       outcome-blind generator, labels from execution, deterministic matching,
                split integrity, replay fingerprints, Phase I byte-identity, SHA-256 per file
```

The freeze record (`CLOUDPROOF-PHASE-II-A2-CORPUS-FREEZE.json`) is committed; the corpus
directory is not. Only after the freeze exists may Phase II-B.2 retrain anything, and its key
table must be:

| Model | Natural trajectories | OOD | Relational-only pairs |
| --- | ---: | ---: | ---: |
| Heuristic | | | ties by construction |
| Logistic | | | ties by construction |
| Pooled MLP | | | ≈ 50% expected (identical inputs) |
| GNN | | | ? |
| GNN, randomized edges | | | ? |

The claim worth making is not "higher AUROC"; it is that on pairs where all pooled features
are identical and only resource relations change, the GNN ranks the riskier topology correctly
while the pooled MLP cannot, and destroying the graph edges removes the advantage.

## 13. Files

```
artifacts/cloudproof/causal-corpus-<name>/
  manifest.json              corpus schema 3, generator provenance, raw vs matched counts,
                             nuisance and matching reports, gates, SHA-256 per file
  trajectories.jsonl         every raw trajectory: schedule, world, outcome, incident,
                             nuisance summary, tier, selected flag, matchId, replay digest
  transitions-{train,validation,test,ood}.jsonl   research rows (state + position-free action,
                             horizon labels, metadata; no nextState)
  counterfactual-pairs.jsonl two records per pair with the shared exogenous digest
  evaluation.json            baselines, probes, permutation, pairs, prioritization, acceptance
  sanity-report.json         probes, permutation, horizons, split integrity, replay, gates
  nuisance-report.json       distributions and matching balance
```
