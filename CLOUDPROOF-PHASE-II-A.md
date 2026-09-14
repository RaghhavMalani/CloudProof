# CloudProof Phase II-A — Research Dataset and Evaluation Infrastructure

Phase II-A turns the deterministic Kubernetes twin into a reproducible research instrument. It deliberately stops before GNN, LLM, reinforcement-learning, or counterexample-guided retraining work.

## Generate and evaluate the research corpus

```bash
node tools/cloudproof-dataset.js \
  --simulations 10000 \
  --seed 20000 \
  --out artifacts/cloudproof/research-dataset \
  --budgets 100,500,1000,5000
```

The default command enforces the 10,000-simulation acceptance gate. Generated corpus files are ignored by Git because they are research outputs rather than source fixtures. The output directory contains canonical JSONL transition files for `train`, `validation`, `test`, and `ood`, a replayable `schedules.jsonl`, `manifest.json`, and `evaluation.json`.

For a quick development gate:

```bash
node tools/cloudproof-dataset.js \
  --simulations 34 \
  --minimum-simulations 34 \
  --budgets 2,4,8 \
  --iterations 10 \
  --out artifacts/cloudproof/research-smoke
```

## Split contract

Rows are never randomly split. Every transition from a scenario inherits the split assigned to its complete topology.

| Split | Fixed topology labels | Replica regime |
| --- | --- | --- |
| Train | A–H | 3–6 |
| Validation | I–J | 3–6 |
| Test | K–M | 3–6, entirely unseen during fitting |
| OOD | OOD-A–OOD-D | 8–12 |

The catalog crosses two and three zones, `maxUnavailable` and `maxSurge` values from 0–2, PDB thresholds, HPA targets from 50–85%, low/normal/spike traffic, safe schedules, three injected controller mutants, and supported fault combinations. Seeds are sequential and unique. The scenario recipe alternates actual safe and unsafe outcomes, so a 10,000-run corpus contains exactly 5,000 of each.

## Record and leakage contract

Each canonical JSONL row contains:

```json
{
  "recordId": "scenario-…:transition-1",
  "scenarioId": "scenario-…",
  "topologyId": "topology-…",
  "split": "train",
  "state": { "kind": "cloudproof.infrastructure-graph" },
  "action": { "type": "cloud.action.scale" },
  "nextState": { "kind": "cloudproof.infrastructure-graph" },
  "labels": {
    "sloViolationWithinKTransitions": false,
    "labelHorizonTransitions": 5
  },
  "metadata": {
    "trajectoryOutcome": "safe",
    "featureBoundary": "state-and-candidate-action-only"
  }
}
```

`nextState`, labels, trajectory outcome, and failure class are training targets or audit metadata. Scorers receive only `G_t` and the candidate action. Tests mutate future state and labels and prove that model inputs and features remain byte-identical.

The manifest records the generator commit SHA, every simulator schema version, seed range, topology catalog, scenario parameters, traffic profiles, supported faults, class balance, split counts, file sizes, and SHA-256 hashes.

## Baselines and evaluation

Phase II-A evaluates three leakage-safe transition scorers:

- seeded random;
- a fixed heuristic risk score;
- deterministic batch-gradient logistic regression.

Each reports AUROC, AUPRC, Brier score, expected calibration error, and five-bin calibration on validation, test, and OOD transitions.

The primary experiment treats risk as a schedule prioritizer. Random, coverage-guided, heuristic, and logistic rankings receive the same fixed budgets of 100, 500, 1,000, and 5,000 schedules. For every checkpoint the report includes:

- schedules and wall time to the first counterexample;
- failure recall;
- counterexamples and unique violation classes found;
- action, transition, and controller-state coverage;
- minimum and mean counterexample length;
- total deterministic-verification wall time.

Wall-clock measurements are observational and may vary between machines. Dataset rows, schedules, replay fingerprints, manifests apart from the generator SHA, and file hashes are deterministic for the same code and arguments.

## Acceptance gate

The command exits unsuccessfully unless all of these hold:

- requested corpus size is met (10,000 by default);
- safe/unsafe trajectory counts differ by at most one;
- topology partitions are disjoint and validation/test are held out;
- training is restricted to 3–6 replicas and OOD to 8–12;
- the `state + candidate action` feature boundary is declared;
- random, heuristic, and logistic ML metrics are present;
- random, coverage-guided, heuristic, and logistic fixed-budget results are present.

Do not begin the GNN stage until the full 10,000-run command passes.
