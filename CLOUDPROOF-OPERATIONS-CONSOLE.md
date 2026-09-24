# CloudProof Operations Console

> Verify the cloud change before production does.

The Operations Console is the product face of the Phase III multi-service simulator
(`packages/cloudproof-mesh`). It runs entirely in the browser, on the same code that runs under
Node, and every result it shows comes from executing the simulator. Nothing is mocked, and the
page never computes an outcome itself.

```bash
node tools/build-web.js && npx serve web          # then open the printed URL
node tools/cloudproof-ops.js verify --demo rollout-payment
```

## Modes

| Mode | What it does |
|---|---|
| **Verify Change** (default) | Pick a scenario and a change (rollout, scale, drain node or zone, database failover), a fault model and a budget. CloudProof searches fault schedules, minimizes the first counterexample, replays it step by step, explains it, and re-verifies rule-based fixes against the same faults |
| **Incident Lab** | Replay a recorded outage (four Phase III natural schedules, or an evidence bundle), find the first violated invariant and the recovery point, shrink the recording to its causal core, and replay the same recording against a fix |
| **Architecture** | A Phase III counterfactual pair: two worlds with the same services, capacities, placement and degrees, differing by one relation swap, run under the same fault side by side |
| **Agent Lab** | The existing Agent Reliability Lab and Bug Museum, unchanged (old `?workload=` URLs still open it) |
| **Research** | What the console runs, what a verdict means, the Phase III pilot summary, and links to the preregistered design |

## What a verification is

A **schedule** is the change's controller running on a world while exogenous faults are injected
at chosen times. Controllers (`packages/cloudproof-ops/changes.js`) read state once per 100 ms tick
and emit ordinary mesh actions. A rollout, for example, restarts a pod only when serving capacity
allows it under `maxSurge` and `maxUnavailable`. The mesh engine decides what those actions do.

- **Faults** (`faults.js`): node crash, zone degradation (5 s), traffic spike (×1.3 or ×1.6 for
  6 s), cache flush, consumer stall (2 s or 5 s), primary database crash, and readiness delay (pods
  start 3× slower). Dependency latency is listed but disabled: the mesh has no latency dimension.
- **Fault budget**: N+1 (the default) injects one fault per schedule at any 500 ms step of the
  change, and the whole single-fault space is enumerated when the verification budget allows. N+2
  and N+3 add seeded multi-fault combinations.
- **Invariants** (`invariants.js`) observe state the engine already computes: a route stays
  available, the failing traffic share stays within budget, a service keeps a minimum of healthy
  pods, a queue backlog stays under a limit, and a primary database's write path is restored
  within a deadline. They are checked after every action and every tick.
- **Attribution**: a violation counts against the change only if the same faults *without* the
  change do not violate the same invariant. Violations that happen either way are reported as
  **pre-existing risks**, counted and classified by root cause, but they are not blamed on the change.
- **Verdicts**: `COUNTEREXAMPLE FOUND`, or `VERIFIED WITHIN BOUND`, stated as "No modeled invariant
  violation found across N explored schedules", with the budget, fault set, seed and horizon. It
  is never "safe".

Search order is a seeded enumeration: the change on a quiet world first, then single faults
shuffled by seed, interleaved with seeded combinations above N+1. The same configuration and seed
give the same result however the work is sliced to keep the page responsive. No learned model is
used; Phase III has no trained model yet.

## Counterexamples

The first attributable counterexample is **minimized** (`shrink.js`): whole actions, chunks and
waits are removed while the same invariant still fails and the failure still depends on the change.
The page shows every accepted reduction, for example `9 → 7 → 6 → 3 → 2` actions. The minimal trace
is replayed step by step on the graph, with only the affected elements pulsing.

**Why did this fail?** (`explain.js`) is assembled from the causes the engine records on every
service (`derived.health[id].cause`), pod phases, and the action that took each pod out of
service. It is templated text over simulator state, not generated prose. The same data gives the
root-cause path and the FAILURE PATH graph view.

## Remediation compare

Candidate fixes (`remediation.js`) are data edits chosen by fixed rules from the root cause: reduce
`maxUnavailable`, add a replica, spread replicas across zones, raise per-pod capacity, add
consumers, double a queue, or drain more slowly. Each candidate is checked twice:

1. against the counterexample's **exact** fault schedule (`replayEnvironment`), and
2. through the **same** search: the same seed, budget, fault set and fault budget.

The outcome is reported as it comes out: verified within bound, the same invariant still
violated, or a different violation found.

## Evidence bundles

`EXPORT PROOF BUNDLE` downloads a `cloudproof.ops-evidence` JSON file. It contains the topology,
change, fault model, search configuration and counters, invariants, the original and minimal
traces, the shrink steps, and SHA-256 digests over canonical JSON (`sha256.js`, identical in the
page and in Node). The export time is excluded from the digest.

```bash
node tools/cloudproof-ops.js check cloudproof-evidence-….json --rerun
```

This checks the bundle digest, the topology digest, that both traces replay to their recorded
outcomes, and, with `--rerun`, that the whole search reproduces.

## Real features vs fixtures

| Surface | Source |
|---|---|
| Scenarios (Checkout stack, Async order pipeline) | Hand-authored mesh worlds, validated by `packages/cloudproof-mesh/world.js`; all behaviour is simulated live |
| Verification, shrinking, replay, explanations, remediation compare | Computed live in the page |
| Architecture pairs | Generated live by `packages/cloudproof-mesh/pairs.js`, walking seeds until the simulator finds a decisive pair |
| Incident Lab natural incidents | Identifiers only (template and seed); the world and schedule are regenerated by the Phase III generator |
| Incident Lab evidence bundle | `apps/ops/fixtures/rollout-payment.evidence.json`, exported by the CLI and re-verified (digests and replay) every time it loads |
| Research pilot table | `artifacts/cloudproof/phase-iii-pilot/pilot.json` |

## Limits

- The console verifies the **model**: the CloudProof Mesh world, its controllers and its fault
  vocabulary. There is no latency, no partial failure, no anti-affinity in the scheduler, and no
  PodDisruptionBudget. A pass is a statement about the explored bound only.
- The mesh scheduler places a pod on the least-used node, so a change that adds pods can move where
  *other* rescheduled pods land. Above N+1 this often surfaces co-location counterexamples. They
  are real in the model, and a real scheduler with spread constraints might avoid them.
- Topology import accepts CloudProof JSON only (`cloudproof.topology` v1 or a raw mesh world), not
  Kubernetes manifests.
- In an embedded browser the simulator runs roughly 3–4× slower than under Node; a standard
  single-fault verification takes a few seconds and shows its progress.
