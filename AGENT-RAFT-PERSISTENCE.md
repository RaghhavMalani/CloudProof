# Stage 4: Raft-backed agent execution

`AgentExecution` is now replicated application state. The committed Raft log is
the only source of truth for workflow checkpoints, semantic conflicts, and the
effect ledger; there is no second agent database or post-commit JSON write.

```text
worker cognition
      │ explicit transition
      ▼
Raft leader ── AppendEntries ── majority commit
      │
      ▼
deterministic AgentState reducer
      │
      ├─ execution step + optimistic fence
      ├─ pinned semantic snapshot + approval pause
      └─ intent → dispatch → reconciliation → result → commit

separate refund-provider volume
      ▲
      └─ RPC only after committed intent and dispatch authorization
```

## Replicated commands

The endpoint `POST /agent/commands` accepts these explicit state transitions:

| Command | Durable meaning |
|---|---|
| `agent.execution.create` | Create a pinned execution checkpoint |
| `agent.execution.advance` | Advance only when `expectedStep` matches |
| `agent.execution.complete` | Complete only with no unfinished effects |
| `agent.effect.intent` | Record stable effect identity before external I/O |
| `agent.effect.dispatch` | Count and authorize one provider attempt |
| `agent.effect.reconciliation-required` | Persist an ambiguous/unfinished outcome |
| `agent.effect.result` | Persist the provider result |
| `agent.effect.commit` | Mark the logical effect complete |
| `agent.semantic-conflict.detect` | Persist a policy/resource conflict and pause |
| `agent.snapshot.transition` | Move snapshots with explicit approval evidence |

A successful mutation response includes `committed: true`. A lost step race is a
`409` with `STALE_EXECUTION_VERSION`, `expectedStep`, and `actualStep`. Reads are
available at `GET /agent/executions/:executionId`; add `?stale=1` to inspect a
specific replica's locally applied checkpoint.

## External-effect ordering

The reference client in `tools/agent-raft-client.js` enforces:

```text
INTENT_RECORDED (majority committed)
       ↓
EFFECT_DISPATCH_AUTHORIZED (majority committed)
       ↓
POST /refund with effectId
```

On recovery, a known unfinished effect is reconciled with
`GET /refund/:effectId` before another dispatch can be authorized. A recorded
result is committed locally without any provider request. A committed effect
returns its recorded result without provider activity.

The provider is a separate process with a separate Docker volume. It persists
`effectId → refund`, treats retries as duplicates, and can destroy the socket
after persisting a refund to create a real ambiguous RPC result.

## One-command acceptance campaign

Prerequisite: Docker Desktop/Engine with Compose is running.

```bash
node tools/agent-raft-compose-test.js
```

The command creates an isolated Compose project on ports 14000, 15001–15003,
and 16000. It automatically tests:

1. uncommitted intent plus leader death: zero provider activity;
2. committed intent plus pre-call death: reconcile-not-found, then one refund;
3. provider success plus lost response and leader death: lookup, never refund twice;
4. committed result plus leader death: finish with no provider contact;
5. committed effect plus leader death: return the recorded result;
6. simultaneous `expectedStep` workers: exactly one advances;
7. semantic conflict across failover and approved snapshot transition;
8. byte-equivalent checkpoints on all three replicas;
9. full `docker compose down` / `up` recovery from the Raft logs and provider volume.

The runner deletes only its test-specific project and volumes on exit. Set
`KEEP_AGENT_RAFT_CLUSTER=1` to leave it running for inspection.

## Guarantee boundary

This proves exactly-once **observable refund**, not exactly-once packet delivery.
The guarantee depends on the provider accepting a stable effect ID idempotently
or supporting authoritative lookup by that ID. An arbitrary non-idempotent API
without reconciliation cannot provide the same guarantee.
