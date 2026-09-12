# Stage 6 — Multi-Agent Race Detection

Stage 6 tests one thesis:

> Two individually correct agents can still produce a globally incorrect result when they act concurrently.

It deliberately does not add a general multi-agent framework or real model calls. Three frozen, deterministic workflows independently reason about the same order:

```text
Refund Agent             Fraud Review Agent          Customer Recovery Agent
reads order=PAID         reads order=PAID            reads complaint unresolved
decides full refund      decides chargeback          decides full goodwill credit
```

Each decision is locally valid at `order:4821@17`. The race appears when more than one effect is authorized after one of those decisions has already changed the shared order.

## Semantic optimistic concurrency

Shared business resources are part of the Raft state machine:

```json
{
  "resourceId": "order:4821",
  "version": 17,
  "state": {
    "orderValueCents": 899900,
    "compensatedCents": 0,
    "status": "PAID",
    "terminalStates": [],
    "financialOwners": []
  }
}
```

An execution durably records both the versions used for reasoning and the proposed deterministic mutations:

```json
{
  "readSet": [{ "resourceId": "order:4821", "version": 17 }],
  "writeSet": [{
    "resourceId": "order:4821",
    "operations": [
      { "op": "increment", "field": "compensatedCents", "value": 899900 },
      { "op": "append-unique", "field": "financialOwners", "value": "refund-agent" },
      { "op": "append-unique", "field": "terminalStates", "value": "REFUNDED" },
      { "op": "set", "field": "status", "value": "REFUNDED" }
    ]
  }]
}
```

`agent.effect.authorize-resource` is one committed state-machine transition. It validates every read-set version before recording the effect authorization or applying any write. If one resource changed, the entire command has no mutation:

```text
RESOURCE_VERSION_CONFLICT
expected: order:4821@17
actual:   order:4821@18
decision: REVALIDATE
```

The transition language is intentionally small: deterministic `set`, `increment`, and `append-unique` operations over named fields. No clock, randomness, provider I/O, or model inference is admitted into replay.

## Search model

The Stage 5 engine is extended with a multi-agent schedule language:

| Action | Meaning |
|---|---|
| `multi-agent.read` | Capture one durable resource version and state |
| `multi-agent.decide` | Produce a frozen decision plus read/write sets |
| `multi-agent.commit` | Validate the read set and authorize the effect atomically |
| `multi-agent.yield` | Removable scheduler noise |

Every generated schedule contains the refund, fraud-review, and customer-recovery workflows. Random generation preserves each workflow's local read → decide → commit order while varying the global interleaving. Coverage-guided generation targets a specific competing pair. The default schedule contains 29 actions; delta debugging preserves the exact failure fingerprint and reduces a race to six actions.

Run the safe campaign:

```bash
node sim/multi-agent-search.js --runs 1000 --seed 1337 --mutant correct --no-shrink
```

Discover and save the flagship over-compensation race:

```bash
node sim/multi-agent-search.js --runs 100 --seed 1337 --mutant unfenced-compensation
```

Replay its exact trace:

```bash
node sim/multi-agent-search.js --replay artifacts/failures/multi-agent-unfenced-compensation-1337.json
```

Run the complete mutant and corrected-runtime gate:

```bash
node sim/multi-agent-search.js --benchmark --runs 100 --seed 1337
```

## Reusable invariants

| Invariant | Failure class |
|---|---|
| `multi-agent.compensation-cap` | `OVER_COMPENSATION` |
| `multi-agent.terminal-exclusive` | `MUTUALLY_EXCLUSIVE_TERMINALS` |
| `multi-agent.resource-version-fence` | `STALE_SHARED_RESOURCE_READ` |
| `multi-agent.single-financial-owner` | `DOUBLE_FINANCIAL_OWNER` |

Failure identity is structured from the invariant, violation class, resource, and participating agents. Shrinking rejects a smaller trace that fails for a different reason.

## Intentional race mutants

| Mutant | Broken boundary | Expected failure |
|---|---|---|
| `authorize-stale-read` | Authorization is recorded before stale-version rejection | `STALE_SHARED_RESOURCE_READ` |
| `unfenced-compensation` | Recovery applies a full credit from stale order state | `OVER_COMPENSATION` |
| `unfenced-terminal-transition` | Fraud review applies a second terminal state from stale state | `MUTUALLY_EXCLUSIVE_TERMINALS` |
| `split-financial-owner-commit` | Ownership changes before validation completes | `DOUBLE_FINANCIAL_OWNER` |

The benchmark must kill all four, minimize all four to six actions, replay all four byte-identically, and run at least 1,000 corrected schedules with zero violations.

## Live Raft promotion

Boundary G in `tools/agent-raft-compose-test.js` searches and minimizes the over-compensation mutant, then replays its six logical actions against the real three-node Compose cluster. Both agents durably retain `order:4821@17` in their read sets. The refund authorization commits first and advances the order to `@18`; the recovery authorization is rejected with `RESOURCE_VERSION_CONFLICT`, and every replica converges on exactly ₹8,999 of compensation, one terminal state, and one financial owner. A full cluster restart must reconstruct the same resources and plans byte-for-byte from the committed log.

```bash
node tools/agent-raft-compose-test.js
```

Stage 7 can now freeze cognition while varying schedules, then freeze schedules while varying cognition. Stage 6 intentionally keeps both the decisions and state transitions deterministic so distributed execution failure is measurable in isolation.
