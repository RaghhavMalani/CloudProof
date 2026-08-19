# miniRaft

**An interactive distributed-consensus lab.** Draw on a shared canvas, kill the leader, and watch a three-node Raft cluster elect, replicate, commit, and recover in real time.

The browser is deliberately more than a whiteboard: it exposes the current term, leader, quorum, per-node log/applied indexes, commit latency, AppendEntries traffic, and a live event stream. The implementation is small enough to whiteboard in an interview, while preserving the safety-critical Raft rules that toy implementations usually skip.

## What this project proves

| Concern | Implementation |
|---|---|
| Crash safety | Term, vote, append-only log, and commit index are durable; applied state is rebuilt deterministically from the committed prefix on restart |
| Correct commit rule | A leader advances to the highest `N` replicated on a majority only when `log[N].term === currentTerm` |
| Dynamic quorum | Majority is `Math.floor(clusterSize / 2) + 1`; the engine is not hard-coded to three nodes |
| Log repair | `nextIndex` / `matchIndex` backtracking repairs divergent or lagging followers |
| Real heartbeats | Heartbeats are empty AppendEntries RPCs carrying `prevLogIndex`, `prevLogTerm`, and `leaderCommit` |
| Retry safety | Browser commands carry stable `clientId + seqNo`; duplicate writes resolve to the existing log entry |
| Failure visibility | The UI can pause/restore replicas and visualizes elections, term changes, catch-up, quorum loss, and recovery |
| Cloud operation | Kubernetes uses a StatefulSet, headless-service DNS, one PVC per replica, liveness/readiness probes, two gateways, and Redis commit fan-out |
| Observability | Every replica exports Prometheus election, term, log, commit, readiness, and commit-latency metrics |
| Election stability | PreVote requires a prospective candidate to reach a majority before it can increase the durable term |
| Serving semantics | Quorum-aware serving and disruption prevention: stale leaders stop safe reads and writes, but do not self-demote solely on quorum loss |

## Executable workload lab

The Flight Deck runs ten deterministic scenarios through one causal event interface. Each workload owns its state transition, trace explanation, measurements, visualization, and execution-scoped invariants.

| Workload | Correctness argument exercised |
|---|---|
| Configuration coordination | Resumable watches, CAS, leases, ReadIndex, and membership overlap |
| Idempotent payments | At-least-once delivery with exactly-once ledger effect |
| Vector search | Deadline-bounded partial results with tenant-filter safety |
| Model rollout | Artifact integrity and version-coherent serving |
| Live streaming | Monotonic playback plus a fenced device-capacity bound |
| Ride dispatch | Offer fencing and authoritative driver assignment |
| Flash-sale inventory | Atomic bounded decrement and no effect before quorum commit |
| Feed fan-out | Read-your-writes over an asynchronously maintained timeline |
| Collaborative editing | Leaderless CRDT convergence under reordering and duplication |
| Two-ledger settlement | Two-phase commit recovery after coordinator failure |

## Architecture

```text
Browser clients
  │ WebSocket
  ▼
Gateway replicas ── Redis pub/sub ── Gateway replicas
  │
  │ client command / committed event
  ▼
┌──────────────────── Raft majority ────────────────────┐
│                                                      │
│  raft-0  ◀──── empty/non-empty AppendEntries ────▶ raft-1
│      ▲                                               │
│      └──────────── AppendEntries ───────────────▶ raft-2
│
│  stable term + vote + log         one PVC per node
└──────────────────────────────────────────────────────┘
```

The gateway discovers the current leader and forwards commands. Only committed entries are published to browsers. In Kubernetes, Redis fans those commits across both gateway replicas so every connected client sees the same stream.

## Run locally

Prerequisite: Docker Desktop with Compose.

```bash
docker compose up --build
```

Open [http://localhost:4000](http://localhost:4000). The first election normally completes within the randomized 500–800 ms election window.

Replica state survives normal container restarts in named volumes:

```bash
docker compose restart replica1
```

To stop the stack without deleting its durable state:

```bash
docker compose down
```

## Try the failure demo

1. Draw several strokes and confirm the three applied indexes converge.
2. Click **Kill node** on the current leader.
3. Watch the event stream advance the term and elect a replacement.
4. Keep drawing after quorum returns.
5. Click **Restore** on the failed node and watch its log catch up through AppendEntries.

With only one healthy node, the UI reports quorum loss and writes cannot commit. Restoring a second node re-establishes the majority.

## Correctness tests

The focused tests exercise the failure modes called out in the Raft paper:

```bash
cd replica
npm ci
npm test
```

They verify:

- a granted vote is already durable on disk;
- a committed log and applied index survive restart;
- retried `clientId + seqNo` commands do not append twice;
- a five-node cluster requires three votes;
- replica count alone cannot commit an older-term entry;
- an empty AppendEntries heartbeat rejects divergence and advances follower commit state.

## Search, shrink, explain

The flagship verification loop searches concrete schedules rather than hoping
that a real-time fault happens twice in the same way:

1. A seed generates client operations, faults, membership changes, and timing.
2. The generator materializes those choices as a portable JSON schedule.
3. A coverage tracker returns unseen workload, fault, RPC, role, and invariant
   features to the next generator while keeping each output schedule concrete.
4. Domain-separated decision tapes record every election, packet-drop, and
   latency draw used by the deterministic runner.
5. Invariant and linearizability checkers classify an exact failure predicate.
6. Delta-debugging passes remove chunks and individual actions, reduce clients,
   writes, partitions, loss, membership churn, payloads, node names, and gaps.
7. The minimized trace carries a causal explanation and a generated regression test.

Search a bounded schedule space:

    node sim/search.js --runs 100

Replay one seed verbosely, materialize its runtime decisions, and shrink any
violation:

    node sim/search.js --seed 1337 --verbose

Replay a saved failure artifact without sampling new randomness:

    node sim/search.js --replay artifacts/failures/seed-1337.json

The shrink predicate is intentionally exact. A log-matching failure must remain
a log-matching failure; a non-linearizable history must remain
non-linearizable; rollout skew must remain rollout skew. A smaller schedule that
fails for a different reason is rejected.

### CheckQuorum: the important distinction

miniRaft does not claim full CheckQuorum semantics. An isolated leader retains
its LEADER role until it sees a higher term. Quorum-aware readiness, leader
leases, ReadIndex, and commit rules still prevent it from safely serving reads
or committing writes after majority contact is lost. PreVote and the recent-
leader vote rule prevent isolated or removed followers from needlessly
disrupting a healthy term.

That behavior is safe for the interfaces exposed here, but it is observably
different from an implementation that automatically demotes a leader after a
quorum timeout. The status API labels it accurately as quorum-aware serving and
disruption prevention.

## Kubernetes

For a complete local Kubernetes deployment, use the checked-in kind harness:

```bash
bash tools/kind-up.sh
```

It builds and side-loads local images, creates three consensus worker nodes,
adapts the production storage class, deploys the system, and waits for the
StatefulSets and Deployments. It requires Docker, `kind`, `kubectl`, and Bash.
This is the easiest way to see stable pod identities, PVC recovery, required
anti-affinity, readiness gating, and quorum-safe PodDisruptionBudgets working
without a cloud account. See [README-DEPLOY.md](README-DEPLOY.md) for the exact
difference between the browser simulator, Compose cluster, and Kubernetes.

The checked-in manifest expects the two images produced by the GitHub Actions workflow:

- `ghcr.io/raghhavmalani/miniraft-replica:latest`
- `ghcr.io/raghhavmalani/miniraft-gateway:latest`

Deploy:

```bash
kubectl apply -f k8s/miniraft.yaml
kubectl -n miniraft get pods
kubectl -n miniraft get service gateway
```

The replica StatefulSet provides:

- stable identities such as `raft-0.raft`;
- headless-service peer discovery;
- a dedicated 1 Gi PVC per node;
- `/health` liveness and `/ready` quorum-lease readiness probes;
- Prometheus scrape annotations on `/metrics`;
- a PodDisruptionBudget that preserves the two-member quorum during voluntary maintenance;
- non-root containers with dropped Linux capabilities and read-only root filesystems.

The gateway deployment runs two replicas behind one Service. Redis pub/sub fans committed entries across both WebSocket client sets.

## Metrics

Each replica exposes Prometheus text format at `/metrics`:

```text
miniraft_elections_total
miniraft_prevotes_total
miniraft_current_term
miniraft_log_length
miniraft_commit_index
miniraft_ready
miniraft_commit_latency_ms
```

For the local Compose network, a ready-to-use scrape configuration is in `monitoring/prometheus.yml`.

Useful endpoints:

| Endpoint | Purpose |
|---|---|
| `GET /status` | Node state, term, log length, commit/applied indexes, quorum, durability |
| `GET /log` | Stored log and committed boundary |
| `GET /health` | Process liveness |
| `GET /ready` | Fresh leader/quorum lease |
| `GET /metrics` | Prometheus metrics |
| `POST /pre-vote` | Read-only Raft PreVote RPC; never changes durable term or vote |
| `POST /request-vote` | Raft RequestVote RPC |
| `POST /append-entries` | Replication, catch-up, heartbeat, and commit propagation |

## Production containers and CI

Both images:

- install with `npm ci --omit=dev`;
- run as the non-root `node` user;
- contain only runtime files;
- include container health checks;
- are built and scanned for high/critical vulnerabilities in GitHub Actions.

On pushes to `main`, CI runs the Raft tests, builds both images, scans them with Trivy, and publishes commit-pinned plus `latest` tags to GHCR.

## Project layout

```text
miniRaft/
├── .github/workflows/ci.yml
├── docker-compose.yml
├── frontend/                  # cinematic consensus-lab UI
├── gateway/                   # HTTP/WebSocket routing + Redis fan-out
├── k8s/miniraft.yaml          # StatefulSet, PVCs, gateways, Redis, Services
├── monitoring/prometheus.yml
└── replica/
    ├── raft.js                # consensus engine
    ├── raft.test.js           # protocol-focused tests
    ├── index.js               # RPC, health, readiness, metrics
    └── docker-entrypoint.sh   # StatefulSet peer discovery
```

## Scope and honest limits

This is a defensible educational Raft implementation, not a replacement for etcd:

- it does not yet implement snapshots or log compaction;
- membership uses learner promotion and one-server-at-a-time changes, not joint consensus;
- durable metadata is rewritten in place and the log is append-only rather than using an embedded database;
- quorum loss fences safe serving but does not implement automatic CheckQuorum leader demotion;
- deterministic faults cover partitions, packet loss, crashes, restarts, and membership churn, while the browser remains an educational lab rather than a production operator console.

Those boundaries are explicit so every claim in the repository maps to code you can explain.
