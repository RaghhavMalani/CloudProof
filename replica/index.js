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
    onCommit: async (entry, { isLeader }) => {
        if (!isLeader) return;
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
        '# HELP miniraft_elections_total Elections started by this replica.',
        '# TYPE miniraft_elections_total counter',
        `miniraft_elections_total{${labels}} ${raft.metrics.electionsTotal}`,
        '# HELP miniraft_current_term Current Raft term.',
        '# TYPE miniraft_current_term gauge',
        `miniraft_current_term{${labels}} ${status.term}`,
        '# HELP miniraft_log_length Entries currently stored in the Raft log.',
        '# TYPE miniraft_log_length gauge',
        `miniraft_log_length{${labels}} ${status.logLength}`,
        '# HELP miniraft_commit_index Highest committed log index.',
        '# TYPE miniraft_commit_index gauge',
        `miniraft_commit_index{${labels}} ${status.commitIndex}`,
        '# HELP miniraft_ready Whether the node has a fresh leader/quorum lease.',
        '# TYPE miniraft_ready gauge',
        `miniraft_ready{${labels}} ${status.ready ? 1 : 0}`,
        '# HELP miniraft_commit_latency_ms Client commit latency.',
        '# TYPE miniraft_commit_latency_ms histogram',
    ];
    for (const [boundary, count] of Object.entries(raft.metrics.commitLatencyBuckets)) {
        lines.push(`miniraft_commit_latency_ms_bucket{${labels},le="${boundary}"} ${count}`);
    }
    lines.push(
        `miniraft_commit_latency_ms_bucket{${labels},le="+Inf"} ${raft.metrics.commitLatencyCount}`,
        `miniraft_commit_latency_ms_sum{${labels}} ${raft.metrics.commitLatencySumMs}`,
        `miniraft_commit_latency_ms_count{${labels}} ${raft.metrics.commitLatencyCount}`,
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
