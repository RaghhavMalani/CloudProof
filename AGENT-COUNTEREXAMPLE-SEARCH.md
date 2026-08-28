# Autonomous Counterexample Discovery

Stage 5 turns the Stage 4 Raft-backed agent runtime into a system that searches
for unsafe executions instead of replaying one hand-authored failure story.

The boundary is deliberate:

```text
seed -> materialized agent schedule -> deterministic execution
     -> generic safety invariants -> exact failure fingerprint
     -> agent-aware shrinking -> byte-identical replay artifact
```

Generation is the only randomized step. Once a schedule exists, execution,
invariant evaluation, shrinking, and replay consume concrete actions and never
sample new randomness.

## Run the searcher

Search the correct Stage 4 runtime:

```bash
node sim/agent-search.js --workflow refund --runs 10000 --seed 1337
```

Search a deliberately broken runtime and emit a minimized artifact:

```bash
node sim/agent-search.js \
  --workflow refund \
  --runs 10000 \
  --seed 1337 \
  --mutant blind-retry
```

Replay the emitted artifact without generating any new choices:

```bash
node sim/agent-search.js --replay artifacts/failures/refund-1337.json
```

Compare random and coverage-guided discovery across all mutants:

```bash
node sim/agent-search.js --benchmark --runs 100 --seed 1337
```

## Search language

The initial language intentionally contains seven logical actions and eight
faults. This is large enough to cross the dangerous durability boundaries and
small enough to shrink into useful counterexamples.

| Logical action | Meaning |
|---|---|
| `agent.advance` | Advance the durable workflow cursor with an expected-step fence |
| `agent.effect.authorize` | Commit the effect identity and semantic snapshot before I/O |
| `agent.effect.dispatch` | Commit dispatch authorization, then call the provider |
| `agent.effect.reconcile` | Query an ambiguous provider operation instead of retrying it |
| `agent.effect.result` | Persist the provider result |
| `agent.effect.commit` | Mark the recorded result as committed |
| `agent.snapshot.approve` | Authorize a semantic snapshot transition |

| Fault | Meaning |
|---|---|
| `fault.worker.crash` | Lose worker-local state and resume from durable state |
| `fault.leader.crash` | Replace the leader while retaining committed evidence |
| `fault.tool.response.drop` | Lose a response after the provider mutation is observable |
| `fault.tool.response.delay` | Defer response delivery |
| `fault.worker.race` | Start a second worker with the same expected step |
| `fault.policy.deploy` | Make a new semantic policy snapshot available |
| `fault.quorum.lose` | Prevent new Raft commands from committing |
| `fault.quorum.restore` | Restore the commit path |

## Reusable safety invariants

`packages/simulator/agent-invariants.js` evaluates workflow, schedule, and
safety specification independently. The current refund specification uses:

- `atMostOnceObservableEffect(effectId)`;
- `noMutationWithoutAuthorizedSnapshot(executionId)`;
- `semanticConflictBlocksMutation(executionId)`;
- `staleWorkerCannotAdvance(executionId)`;
- `unfinishedEffectSurvivesRecovery(effectId)`;
- `causalEffectOrder(['payment.refund', 'crm.refunded', 'email.confirmation'])`.

A failure is not identified by a Boolean. Its fingerprint contains the
invariant, violation class, execution, and relevant effect, worker, or semantic
resource. The shrinker accepts a candidate only when `sameFailure` matches that
meaningful identity.

## Mutant benchmark

The benchmark injects five explicit runtime defects:

| Mutant | Expected failure class |
|---|---|
| `blind-retry` | `DUPLICATE_OBSERVABLE_EFFECT` |
| `dispatch-before-intent` | `UNTRACKED_EXTERNAL_EFFECT` |
| `no-worker-fence` | `CONCURRENT_EXECUTION_RACE` |
| `volatile-semantic-conflict` | `SEMANTIC_ISOLATION_VIOLATION` |
| `result-forgotten-on-resume` | `UNNECESSARY_RECONCILIATION` |

Measured locally with seed `1337` and a maximum of 100 schedules per mutant:

| Mutant | Random schedules | Coverage-guided schedules | Minimized actions |
|---|---:|---:|---:|
| Blind retry | 1 | 1 | 5 |
| Dispatch before intent | 1 | 1 | 1 |
| Missing worker fence | 4 | 4 | 3 |
| Volatile semantic conflict | 1 | 1 | 3 |
| Result forgotten on resume | 5 | 5 | 4 |

Both strategies killed and correctly classified all five mutants. The same
coverage-guided campaign evaluated 100 schedules against the correct runtime,
covered all 15 action/fault types, and found zero safety violations. Wall-clock
figures are emitted by the benchmark but are not checked into this table because
they depend on the machine running it.

An additional 1,000-schedule coverage-guided acceptance run covered all 15
action/fault types and found zero violations in the correct runtime.

## Shrinking and artifacts

The agent-aware shrinker combines delta debugging with semantic passes that
remove unrelated effects and workers, policy deployments unrelated to the
failure, redundant recovery faults, delay noise, retry noise, and completed
workflow prefixes. It reports action/event reduction and evaluation cost.

Each failure artifact contains:

- the materialized minimized schedule;
- the exact expected fingerprint;
- the original and minimized action/event counts;
- the full deterministic trace and final state;
- a replay fingerprint over the failure, state, and trace;
- a generated Node regression test.

For blind retry at seed `1337`, shrinking reduced 16 actions / 38 events to
5 actions / 15 events. Replaying the emitted artifact reproduced byte-identically
with digest `d93205655e7a354507f6974be2bd21098e088442b12648ea364331adc57313b5`.

CI runs the correct-runtime search and the mutant benchmark. Live Compose
remains outside the high-volume inner loop. Its separate `agent-raft-compose`
gate promotes the five-action blind-retry counterexample to a real three-node
Raft log and refund-provider boundary, requires the exact structured failure
fingerprint, and verifies both the durable execution and duplicate observations
survive a full cluster restart. The production-safe A-E boundaries remain green.
