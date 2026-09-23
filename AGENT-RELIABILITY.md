# Agent Reliability Lab

## Thesis

An autonomous agent is a distributed workflow with a nondeterministic decision-maker. Reliability therefore depends on more than model quality: the runtime must make tool effects, checkpoints, semantic dependencies, retries, and concurrent workers observable and testable.

CloudProof's job is to answer:

> Under crashes, ambiguous tool results, resource deployments, and concurrency, did the workflow produce each authorized observable effect at most once and in causal order?

## Safety contract

The runtime does not claim exactly-once network delivery. It targets **exactly-once observable effect** when a tool supports either stable idempotency keys or lookup/reconciliation by effect identity.

```text
INTENT_RECORDED
      │ dispatch
      ├──────────── reply received ──> RESULT_RECORDED ──> EFFECT_COMMITTED
      │
      └──────────── outcome unknown ─> RECONCILIATION_REQUIRED
                                             │ provider lookup
                                             └─> RESULT_RECORDED ─> EFFECT_COMMITTED
```

After restart:

- absent effect: execute;
- committed effect: return its recorded result;
- any non-committed effect: reconcile, never blindly retry.

An effect ID is the SHA-256 digest of the workflow execution ID, logical action, and canonical parameters. Workers handling the same logical execution therefore converge on one ledger record.

## Semantic transaction boundary

Every execution pins versioned resources:

```json
{
  "workflow": "refund-agent-v7",
  "model": "model-2026-08-20",
  "prompt": "sha256:a892",
  "policy": "refund-policy-v4",
  "retrievalIndex": "support-index-v81",
  "toolSchemas": {
    "payments": "v2",
    "orders": "v14",
    "crm": "v6",
    "mail": "v3"
  }
}
```

At resume, each changed resource maps to `continue`, `revalidate`, `restart`, `require-approval`, or `abort`. The strictest required disposition wins. The refund workload maps a policy change to human revalidation.

## Flagship invariant set

The refund-agent scenario checks:

1. `provider_refund_effects(order_4821) == 1`.
2. Every committed effect references an authorized semantic snapshot.
3. Policy drift stops execution until an approved snapshot transition exists.
4. `email_sent => crm_refunded => payment_refunded`.
5. Two crashes restore the workflow cursor and complete without repeating prior effects.

## What exists now

- Runtime primitives in `packages/agent-runtime/`.
- Deterministic flagship workload in `packages/workloads/agent-refund.js`.
- Causal browser trace, invariant HUD, and guided replay.
- Existing decision tapes, simulator, schedule search, failure artifacts, and shrinker.
- Live three-node Raft substrate with crash-safe log and state-machine recovery.
- Deterministic AgentState reducer applied exclusively from committed Raft commands.
- Optimistic `expectedStep` fencing and consensus-backed semantic approvals.
- Separate durable refund provider with response-loss injection and effect-ID lookup.
- Automatic three-node Compose campaign covering external-effect boundaries A-E.

## Roadmap

| Stage | Deliverable | Status |
|---|---|---|
| 1 | Portable durable agent checkpoint and effect-ledger model | implemented in deterministic runtime |
| 2 | Autonomous refund workflow with ambiguous-effect reconciliation | implemented |
| 3 | Semantic snapshot comparison and configurable resume policy | implemented |
| 4 | Persist agent checkpoints and ledger entries through the live Raft state machine | implemented |
| 5 | Materialize agent faults in schedule generation and trace shrinking | next |
| 6 | Multi-agent resource fencing and logical race detection | planned |
| 7 | Freeze cognition with recorded model/tool decision tapes while varying schedules | planned |
| 8 | Coverage-guided and RL-guided adversarial fault search benchmark | research stage |

## Honest boundaries

- The live refund provider is an external idempotent test service; CRM and mail remain deterministic workflow state, not production integrations.
- A stable effect identity alone cannot make an arbitrary third-party API exactly once. The provider must accept that identity idempotently or expose a trustworthy reconciliation lookup.
- Semantic compatibility is policy supplied by the application; the runtime detects change and enforces the configured disposition but cannot infer business compatibility on its own.
- Stage 4 is documented in `AGENT-RAFT-PERSISTENCE.md`; Stage 5 should now attack it with generated and shrunk fault schedules.
- Decision tapes already freeze simulator choices; model-response capture is the next extension required to separate cognition failures from schedule failures.
