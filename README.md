# miniRaft

**An interactive distributed-consensus lab.** Draw on a shared canvas, kill the leader, and watch a three-node Raft cluster elect, replicate, commit, and recover in real time.

The browser is deliberately more than a whiteboard: it exposes the current term, leader, quorum, per-node log/applied indexes, commit latency, AppendEntries traffic, and a live event stream. The implementation is small enough to whiteboard in an interview, while preserving the safety-critical Raft rules that toy implementations usually skip.

## What this project proves

| Concern | Implementation |
|---|---|
| Crash safety | `currentTerm`, `votedFor`, log, commit index, and applied index are fsynced to per-node storage before dependent RPC responses |
| Correct commit rule | A leader advances to the highest `N` replicated on a majority only when `log[N].term === currentTerm` |
| Dynamic quorum | Majority is `Math.floor(clusterSize / 2) + 1`; the engine is not hard-coded to three nodes |
| Log repair | `nextIndex` / `matchIndex` backtracking repairs divergent or lagging followers |
| Real heartbeats | Heartbeats are empty AppendEntries RPCs carrying `prevLogIndex`, `prevLogTerm`, and `leaderCommit` |
| Retry safety | Browser commands carry stable `clientId + seqNo`; duplicate writes resolve to the existing log entry |
| Failure visibility | The UI can pause/restore replicas and visualizes elections, term changes, catch-up, quorum loss, and recovery |
| Cloud operation | Kubernetes uses a StatefulSet, headless-service DNS, one PVC per replica, liveness/readiness probes, two gateways, and Redis commit fan-out |
| Observability | Every replica exports Prometheus election, term, log, commit, readiness, and commit-latency metrics |

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

## Kubernetes

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
- non-root containers with dropped Linux capabilities and read-only root filesystems.

The gateway deployment runs two replicas behind one Service. Redis pub/sub fans committed entries across both WebSocket client sets.

## Metrics

Each replica exposes Prometheus text format at `/metrics`:

```text
miniraft_elections_total
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
- membership is static while a node is running;
- durable state uses one fsynced JSON file rather than an embedded WAL/database;
- the included failure controls pause processes, while network-partition and linearizability testing remain the next major validation layer.

Those boundaries are explicit so every claim in the repository maps to code you can explain.
