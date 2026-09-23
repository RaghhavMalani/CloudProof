/**
 * Replica HTTP service.
 *
 * The Raft engine owns durable state and consensus. This layer exposes the two
 * Raft RPCs (RequestVote and AppendEntries), client writes, health, and the
 * soft-failure controls used by the interactive lab.
 */

const express = require('express');
const axios = require('axios');
const { RaftNode } = require('./raft');
const { decodeVector } = require('./state-machine');

const app = express();
app.use(express.json({ limit: '2mb' }));

const REPLICA_ID = process.env.REPLICA_ID || 'replica1';
const PORT = Number.parseInt(process.env.PORT || '5001', 10);
const PEERS = (process.env.PEERS || '').split(',').filter(Boolean);
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://gateway:4000';
const NODE_URL = process.env.NODE_URL || `http://${REPLICA_ID}:${PORT}`;

const raft = new RaftNode({
    replicaId: REPLICA_ID,
    peers: PEERS,
    nodeUrl: NODE_URL,

    // Every node applies committed entries. Only the leader publishes the
    // client-visible event, preventing follower echo duplicates.
    onCommit: async (entry, { isLeader, replay }) => {
        // Replay happens on boot to rebuild the keyspace. The state machine
        // mutation has already occurred; re-broadcasting history that clients
        // saw before the restart has not.
        if (replay || !isLeader) return;
        if (entry.data && entry.data.op && entry.data.op !== 'append') return;
        try {
            await axios.post(`${GATEWAY_URL}/broadcast`, { entry }, { timeout: 500 });
        } catch (error) {
            console.error(
                `[${REPLICA_ID}] Commit ${entry.index} applied; gateway notification failed: ` +
                error.message,
            );
        }
    },

    onLeaderChange: async (leaderId, leaderUrl) => {
        if (leaderId !== REPLICA_ID) return;
        try {
            await axios.post(
                `${GATEWAY_URL}/register-leader`,
                { leaderId: REPLICA_ID, leaderUrl: leaderUrl || NODE_URL },
                { timeout: 500 },
            );
        } catch (_) {
            // The gateway discovers the leader by polling if it boots later.
        }
    },
});

app.post('/request-vote', (req, res) => {
    res.json(raft.handleRequestVote(req.body));
});
app.post('/pre-vote', (req, res) => {
    res.json(raft.handlePreVote(req.body));
});


// Empty entries are heartbeats. The same consistency checks therefore repair a
// lagging follower and propagate leaderCommit even when no client is drawing.
app.post('/append-entries', (req, res) => {
    res.json(raft.handleAppendEntries(req.body));
});

app.post('/stroke', async (req, res) => {
    const { stroke } = req.body;
    if (!stroke) return res.status(400).json({ error: 'Missing stroke data' });

    if (!raft.isLeader()) {
        return res.status(307).json({
            error: 'Not leader',
            leaderId: raft.leaderId,
            leaderUrl: raft.leaderUrl,
        });
    }

    try {
        const result = await raft.clientAppend(stroke);
        if (!result.committed) {
            return res.status(503).json({
                error: `Write persisted but not committed: quorum ${raft.quorumSize}/${raft.clusterSize} unavailable`,
                entry: result.entry,
                retryable: true,
            });
        }
        return res.json({
            success: true,
            entry: result.entry,
            duplicate: result.duplicate,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
});

// ── keyspace ─────────────────────────────────────────────────────────────────

/**
 * Every mutating command takes the same road: propose, replicate, commit,
 * apply, then return the result the state machine produced. The HTTP layer
 * never touches the keyspace directly.
 */
async function propose(res, command) {
    if (!raft.isLeader()) {
        return res.status(307).json({
            error: 'Not leader',
            leaderId: raft.leaderId,
            leaderUrl: raft.leaderUrl,
        });
    }

    try {
        const outcome = await raft.clientAppend(command);
        if (!outcome.committed) {
            return res.status(503).json({
                error: `Write persisted but not committed: quorum ${raft.quorumSize}/${raft.clusterSize} unavailable`,
                index: outcome.entry.index,
                retryable: true,
            });
        }

        const result = outcome.result || { ok: true };
        // A rejected CAS or a contested lease is a legitimate answer, not a
        // server fault — 409 lets a client distinguish "you lost the race" from
        // "the cluster is broken", which matters because only one is worth
        // retrying immediately.
        return res.status(result.ok ? 200 : 409).json({
            ...result,
            committed: true,
            index: outcome.entry.index,
            duplicate: outcome.duplicate,
        });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}

// -- Raft-backed agent execution --------------------------------------------

/**
 * Submit one explicit agent state transition. A 200 response means the entry
 * reached a majority and was applied; callers must never contact an external
 * provider before receiving that committed acknowledgement.
 */
app.post('/agent/commands', (req, res) => {
    const command = req.body || {};
    if (typeof command.op !== 'string' || !command.op.startsWith('agent.')) {
        return res.status(400).json({ error: 'an explicit agent.* op is required' });
    }
    return propose(res, command);
});

app.post('/agent/executions', (req, res) => propose(res, {
    op: 'agent.execution.create',
    executionId: req.body?.executionId,
    workflow: req.body?.workflow,
    snapshot: req.body?.snapshot,
    initialState: req.body?.initialState,
    clientId: req.body?.clientId,
    seqNo: req.body?.seqNo,
}));

app.get('/agent/executions', (req, res) => {
    const local = req.query.stale === '1';
    try {
        const executions = local
            ? raft.stateMachine.agentExecutions()
            : raft.read((sm) => sm.agentExecutions());
        return res.json({ executions, linearizable: !local });
    } catch (error) {
        return res.status(503).json({ error: error.message, leaderId: raft.leaderId });
    }
});

app.get('/agent/executions/:executionId', (req, res) => {
    const local = req.query.stale === '1';
    try {
        const execution = local
            ? raft.stateMachine.agentExecution(req.params.executionId)
            : raft.read((sm) => sm.agentExecution(req.params.executionId));
        if (!execution) {
            return res.status(404).json({
                error: 'execution not found', executionId: req.params.executionId,
            });
        }
        return res.json({ execution, linearizable: !local });
    } catch (error) {
        return res.status(503).json({ error: error.message, leaderId: raft.leaderId });
    }
});

app.get('/agent/resources', (req, res) => {
    const local = req.query.stale === '1';
    try {
        const resources = local
            ? raft.stateMachine.agentResources()
            : raft.read((sm) => sm.agentResources());
        return res.json({ resources, linearizable: !local });
    } catch (error) {
        return res.status(503).json({ error: error.message, leaderId: raft.leaderId });
    }
});

app.get('/agent/resources/:resourceId', (req, res) => {
    const local = req.query.stale === '1';
    try {
        const resource = local
            ? raft.stateMachine.agentResource(req.params.resourceId)
            : raft.read((sm) => sm.agentResource(req.params.resourceId));
        if (!resource) {
            return res.status(404).json({
                error: 'resource not found', resourceId: req.params.resourceId,
            });
        }
        return res.json({ resource, linearizable: !local });
    } catch (error) {
        return res.status(503).json({ error: error.message, leaderId: raft.leaderId });
    }
});

app.get('/kv/:key', (req, res) => {
    const local = req.query.stale === '1';
    try {
        const record = local
            ? raft.stateMachine.get(req.params.key)
            : raft.read((sm) => sm.get(req.params.key));
        if (!record) return res.status(404).json({ error: 'not found', key: req.params.key });
        return res.json({ ...record, linearizable: !local });
    } catch (error) {
        return res.status(503).json({ error: error.message, leaderId: raft.leaderId });
    }
});

app.get('/kv', (req, res) => {
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : '';
    const local = req.query.stale === '1';
    try {
        const keys = local
            ? raft.stateMachine.list(prefix)
            : raft.read((sm) => sm.list(prefix));
        return res.json({ keys, revision: raft.stateMachine.revision, linearizable: !local });
    } catch (error) {
        return res.status(503).json({ error: error.message, leaderId: raft.leaderId });
    }
});

app.put('/kv/:key', (req, res) => propose(res, {
    op: 'set',
    key: req.params.key,
    value: req.body.value,
    clientId: req.body.clientId,
    seqNo: req.body.seqNo,
}));

app.delete('/kv/:key', (req, res) => propose(res, {
    op: 'delete',
    key: req.params.key,
    clientId: req.body?.clientId,
    seqNo: req.body?.seqNo,
}));

/**
 * Compare-and-swap. Send `expectRev: 0` to claim a key that must not already
 * exist; send the revision you last read to implement optimistic concurrency.
 * `value: null` makes a successful swap delete the key.
 */
app.post('/cas/:key', (req, res) => {
    const { expectRev, expect, value = null, clientId, seqNo } = req.body || {};
    if (expectRev === undefined && expect === undefined) {
        return res.status(400).json({ error: 'cas requires expectRev or expect' });
    }
    return propose(res, { op: 'cas', key: req.params.key, expectRev, expect, value, clientId, seqNo });
});

// ── leases ───────────────────────────────────────────────────────────────────

app.post('/lease/:key/acquire', (req, res) => {
    const { holder, ttlMs = 5000, clientId, seqNo } = req.body || {};
    if (!holder) return res.status(400).json({ error: 'holder is required' });
    return propose(res, { op: 'lease-acquire', key: req.params.key, holder, ttlMs, clientId, seqNo });
});

app.post('/lease/:key/renew', (req, res) => {
    const { holder, ttlMs } = req.body || {};
    if (!holder) return res.status(400).json({ error: 'holder is required' });
    return propose(res, { op: 'lease-renew', key: req.params.key, holder, ttlMs });
});

app.post('/lease/:key/release', (req, res) => {
    const { holder } = req.body || {};
    if (!holder) return res.status(400).json({ error: 'holder is required' });
    return propose(res, { op: 'lease-release', key: req.params.key, holder });
});

app.get('/lease/:key', (_req, res) => {
    const info = raft.stateMachine.leaseInfo(_req.params.key);
    if (!info) return res.status(404).json({ error: 'no lease', key: _req.params.key });
    return res.json(info);
});

// ── watch ────────────────────────────────────────────────────────────────────

const WATCH_TIMEOUT_MS = 25000;
const waiters = new Set();

// Watches are served from local applied state, so any replica can answer —
// a follower is a perfectly good place to watch from, and spreading watchers
// across followers keeps fan-out off the leader.
raft.stateMachine.subscribe((event) => {
    for (const waiter of [...waiters]) {
        if (!event.key.startsWith(waiter.prefix)) continue;
        // The revision filter matters as much here as it does in the backlog
        // check. A follower that is behind may apply an event the watcher has
        // already seen elsewhere; waking on it would hand back a duplicate and
        // make the same cursor behave differently depending on which replica
        // answered.
        if (event.rev <= waiter.fromRev) continue;
        waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve([event]);
    }
});

app.get('/watch', async (req, res) => {
    const prefix = typeof req.query.prefix === 'string'
        ? req.query.prefix
        : (typeof req.query.key === 'string' ? req.query.key : '');
    const fromRev = Number.parseInt(req.query.fromRev ?? '0', 10) || 0;

    // Catch up first. A watcher that reconnects must not miss events that
    // landed while it was away, so it resumes from the revision it last saw
    // rather than from "now".
    const backlog = raft.stateMachine.eventsSince(fromRev, { prefix });
    if (backlog.length > 0) {
        return res.json({ events: backlog, revision: raft.stateMachine.revision });
    }

    const events = await new Promise((resolve) => {
        const waiter = { prefix, fromRev, resolve, timer: null };
        waiter.timer = setTimeout(() => {
            waiters.delete(waiter);
            resolve([]);
        }, WATCH_TIMEOUT_MS);
        waiters.add(waiter);
        req.on('close', () => {
            waiters.delete(waiter);
            clearTimeout(waiter.timer);
            resolve([]);
        });
    });

    if (res.writableEnded) return undefined;
    if (events.length === 0) {
        // 204 means "nothing yet, ask again" — long polling without pretending
        // an empty result is data.
        return res.status(204).end();
    }
    return res.json({ events, revision: raft.stateMachine.revision });
});

// ── vector index ─────────────────────────────────────────────────────────────

app.post('/index', (req, res) => propose(res, {
    op: 'index-create',
    dim: req.body?.dim,
    M: req.body?.M,
    efConstruction: req.body?.efConstruction,
    seed: req.body?.seed,
}));

/**
 * Upsert. The caller supplies a vector; the embedding of text to vector happens
 * one layer up, on whichever node received the request, and only the resulting
 * vector is replicated. See the note on `_applyVectorUpsert`.
 */
app.put('/vectors/:id', (req, res) => propose(res, {
    op: 'vector-upsert',
    id: req.params.id,
    vector: req.body?.vector,
    payload: req.body?.payload ?? null,
    clientId: req.body?.clientId,
    seqNo: req.body?.seqNo,
}));

app.delete('/vectors/:id', (req, res) => propose(res, {
    op: 'vector-delete',
    id: req.params.id,
    clientId: req.body?.clientId,
    seqNo: req.body?.seqNo,
}));

/**
 * Search.
 *
 * Linearizable by default: the leader confirms it still holds a quorum lease
 * before answering, so a partitioned former leader returns 503 rather than
 * results from a log it has stopped receiving. `?stale=1` opts into a local
 * read from any replica, which is the right trade for most retrieval traffic
 * and keeps fan-out off the leader.
 *
 * `exact=1` runs a brute-force scan instead of the graph search. That is what
 * recall is measured against, and having it on the same endpoint means the
 * comparison is against this index rather than a separate reimplementation.
 */
app.post('/search', (req, res) => {
    const { vector, k = 10, ef, exact = false, stale = false } = req.body || {};
    if (!vector) return res.status(400).json({ error: 'vector is required' });

    const run = (sm) => {
        if (!sm.index) throw new Error('no index has been created');
        const query = decodeVector(vector);
        if (query.length !== sm.index.dim) {
            throw new Error(`dimension mismatch: index is ${sm.index.dim}, query is ${query.length}`);
        }
        const startedAt = process.hrtime.bigint();
        const results = exact ? sm.index.searchExact(query, k) : sm.index.search(query, k, ef);
        return {
            results,
            exact: Boolean(exact),
            tookMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
            size: sm.index.size,
        };
    };

    try {
        const body = stale ? run(raft.stateMachine) : raft.read(run);
        return res.json({ ...body, linearizable: !stale, replicaId: REPLICA_ID });
    } catch (error) {
        return res.status(503).json({ error: error.message, leaderId: raft.leaderId });
    }
});

app.get('/index', (_req, res) => {
    const sm = raft.stateMachine;
    if (!sm.index) return res.status(404).json({ error: 'no index' });
    res.json({ ...sm.index.stats(), replicaId: REPLICA_ID });
});

app.get('/state', (_req, res) => {
    res.json(raft.stateMachine.snapshot());
});

app.get('/status', (_req, res) => {
    res.json(raft.getStatus());
});

app.get('/log', (_req, res) => {
    res.json({
        log: raft.log,
        commitIndex: raft.commitIndex,
        lastApplied: raft.lastApplied,
    });
});

app.get('/health', (_req, res) => {
    res.json({ ok: true, replicaId: REPLICA_ID });
});

app.get('/ready', (_req, res) => {
    const status = raft.getStatus();
    res.status(status.ready ? 200 : 503).json({
        ready: status.ready,
        replicaId: REPLICA_ID,
        state: status.state,
        leaderId: status.leaderId,
    });
});

app.get('/metrics', (_req, res) => {
    const status = raft.getStatus();
    const labels = `replica="${REPLICA_ID}"`;
    const lines = [
        '# HELP cloudproof_prevotes_total PreVote rounds started by this replica.',
        '# TYPE cloudproof_prevotes_total counter',
        'cloudproof_prevotes_total{' + labels + '} ' + raft.metrics.preVotesTotal,
        '# HELP cloudproof_elections_total Elections started by this replica.',
        '# TYPE cloudproof_elections_total counter',
        `cloudproof_elections_total{${labels}} ${raft.metrics.electionsTotal}`,
        '# HELP cloudproof_current_term Current Raft term.',
        '# TYPE cloudproof_current_term gauge',
        `cloudproof_current_term{${labels}} ${status.term}`,
        '# HELP cloudproof_log_length Entries currently stored in the Raft log.',
        '# TYPE cloudproof_log_length gauge',
        `cloudproof_log_length{${labels}} ${status.logLength}`,
        '# HELP cloudproof_commit_index Highest committed log index.',
        '# TYPE cloudproof_commit_index gauge',
        `cloudproof_commit_index{${labels}} ${status.commitIndex}`,
        '# HELP cloudproof_ready Whether the node has a fresh leader/quorum lease.',
        '# TYPE cloudproof_ready gauge',
        `cloudproof_ready{${labels}} ${status.ready ? 1 : 0}`,
        '# HELP cloudproof_keys Keys in the applied state machine.',
        '# TYPE cloudproof_keys gauge',
        `cloudproof_keys{${labels}} ${status.keys}`,
        '# HELP cloudproof_leases_active Leases currently held.',
        '# TYPE cloudproof_leases_active gauge',
        `cloudproof_leases_active{${labels}} ${status.leases}`,
        '# HELP cloudproof_state_revision Monotonic state machine revision.',
        '# TYPE cloudproof_state_revision gauge',
        `cloudproof_state_revision{${labels}} ${status.revision}`,
        '# HELP cloudproof_logical_clock Replicated logical clock driving lease expiry.',
        '# TYPE cloudproof_logical_clock gauge',
        `cloudproof_logical_clock{${labels}} ${status.logicalClock}`,
        '# HELP cloudproof_replayed_entries Entries replayed into the state machine at boot.',
        '# TYPE cloudproof_replayed_entries gauge',
        `cloudproof_replayed_entries{${labels}} ${status.replayedEntries}`,
        '# HELP cloudproof_commit_latency_ms Client commit latency.',
        '# TYPE cloudproof_commit_latency_ms histogram',
    ];
    for (const [boundary, count] of Object.entries(raft.metrics.commitLatencyBuckets)) {
        lines.push(`cloudproof_commit_latency_ms_bucket{${labels},le="${boundary}"} ${count}`);
    }
    lines.push(
        `cloudproof_commit_latency_ms_bucket{${labels},le="+Inf"} ${raft.metrics.commitLatencyCount}`,
        `cloudproof_commit_latency_ms_sum{${labels}} ${raft.metrics.commitLatencySumMs}`,
        `cloudproof_commit_latency_ms_count{${labels}} ${raft.metrics.commitLatencyCount}`,
    );
    res.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
});

app.post('/pause', (_req, res) => {
    raft.pause();
    res.json({ ok: true, paused: true });
});

app.post('/resume', (_req, res) => {
    raft.resume();
    res.json({ ok: true, paused: false });
});

const server = app.listen(PORT, () => {
    console.log(`[${REPLICA_ID}] Listening on ${PORT}`);
    console.log(`[${REPLICA_ID}] Peers: ${PEERS.join(', ') || '(single node)'}`);
});

function shutdown(signal) {
    console.log(`[${REPLICA_ID}] ${signal} · flushing and stopping`);
    raft.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
