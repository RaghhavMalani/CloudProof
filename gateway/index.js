/**
 * Gateway Service — index.js
 *
 * Responsibilities:
 *  - Serve the frontend static files
 *  - Maintain WebSocket connections with browser clients
 *  - Route incoming strokes to the current RAFT leader
 *  - Receive broadcast notifications from the leader (committed strokes)
 *    and fan them out to all connected clients
 *  - Auto-discover a new leader when the current one goes offline
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const path = require('path');
const { createClient } = require('redis');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// Serve the frontend
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// ─── LEADER STATE ─────────────────────────────────────────────────────────────

const REPLICA_URLS = [
    process.env.REPLICA1_URL || 'http://replica1:5001',
    process.env.REPLICA2_URL || 'http://replica2:5002',
    process.env.REPLICA3_URL || 'http://replica3:5003',
];

let currentLeaderUrl = null;
let currentLeaderId = null;

// Connected WebSocket clients
const clients = new Set();

// Optional Redis fan-out lets multiple gateway replicas share one commit
// stream. Without REDIS_URL the service falls back to in-process broadcast.
const REDIS_URL = process.env.REDIS_URL || '';
const COMMIT_CHANNEL = 'cloudproof:commits';
let redisPublisher = null;
let redisSubscriber = null;

async function setupRedis() {
    if (!REDIS_URL) return;
    try {
        redisPublisher = createClient({ url: REDIS_URL });
        redisPublisher.on('error', (error) => console.error(`[Gateway] Redis publisher: ${error.message}`));
        await redisPublisher.connect();
        redisSubscriber = redisPublisher.duplicate();
        redisSubscriber.on('error', (error) => console.error(`[Gateway] Redis subscriber: ${error.message}`));
        await redisSubscriber.connect();
        await redisSubscriber.subscribe(COMMIT_CHANNEL, (payload) => {
            try {
                broadcast(JSON.parse(payload));
            } catch (_) {}
        });
        console.log('[Gateway] Redis commit fan-out connected');
    } catch (error) {
        console.warn(`[Gateway] Redis unavailable; using local fan-out: ${error.message}`);
    }
}

// ─── LEADER DISCOVERY ─────────────────────────────────────────────────────────

async function discoverLeader() {
    for (const url of REPLICA_URLS) {
        try {
            const res = await axios.get(`${url}/status`, { timeout: 400 });
            if (res.data.state === 'LEADER') {
                currentLeaderUrl = url;
                currentLeaderId = res.data.replicaId;
                console.log(`[Gateway] Discovered leader: ${currentLeaderId} at ${currentLeaderUrl}`);
                return true;
            }
        } catch (_) {
            // replica unreachable
        }
    }
    console.warn('[Gateway] No leader found during discovery.');
    return false;
}

// Poll for a leader every 300ms until one is found
async function ensureLeader() {
    if (currentLeaderUrl) return;
    await discoverLeader();
}

// Periodically verify the leader is still alive
setInterval(async () => {
    if (!currentLeaderUrl) {
        await discoverLeader();
        return;
    }
    try {
        const r = await axios.get(`${currentLeaderUrl}/health`, { timeout: 300 });
        // If leader is paused, treat as unreachable
        if (!r.data.ok) {
            throw new Error('leader paused');
        }
    } catch (_) {
        console.warn(`[Gateway] Leader ${currentLeaderId} is unreachable — re-discovering`);
        currentLeaderUrl = null;
        currentLeaderId = null;
        await discoverLeader();
    }
}, 300);

// ─── LEADER REGISTRATION (replica calls us when they win election) ────────────

app.post('/register-leader', (req, res) => {
    const { leaderId, leaderUrl } = req.body;
    currentLeaderId = leaderId;
    currentLeaderUrl = leaderUrl;
    console.log(`[Gateway] New leader registered: ${leaderId} at ${leaderUrl}`);
    // Notify all clients about the leadership change
    broadcast({ type: 'leader-change', leaderId });
    res.json({ ok: true });
});

// ─── BROADCAST (called by leader replica when a stroke is committed) ──────────

app.post('/broadcast', async (req, res) => {
    const { entry } = req.body;
    if (!entry) return res.status(400).json({ error: 'Missing entry' });
    console.log(`[Gateway] Broadcasting committed stroke at index ${entry.index}`);
    const event = { type: 'stroke', data: entry.data, index: entry.index };
    if (redisPublisher?.isReady) {
        try {
            await redisPublisher.publish(COMMIT_CHANNEL, JSON.stringify(event));
        } catch (_) {
            broadcast(event);
        }
    } else {
        broadcast(event);
    }
    res.json({ ok: true });
});

// ─── WEBSOCKET HANDLING ───────────────────────────────────────────────────────

wss.on('connection', async (ws, req) => {
    clients.add(ws);
    console.log(`[Gateway] Client connected. Total: ${clients.size}`);

    // Send current leader info
    ws.send(JSON.stringify({ type: 'connected', leaderId: currentLeaderId }));

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch (_) { return; }

        if (msg.type === 'stroke') {
            await forwardStrokeToLeader(msg.data, ws);
        } else if (msg.type === 'request-log') {
            // Client requests full stroke log on (re)connect
            await sendFullLog(ws);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log(`[Gateway] Client disconnected. Total: ${clients.size}`);
    });

    ws.on('error', (err) => {
        console.error(`[Gateway] WS error: ${err.message}`);
        clients.delete(ws);
    });

    // Replay committed log to new client
    await sendFullLog(ws);
});

// ─── STROKE FORWARDING ────────────────────────────────────────────────────────

async function forwardStrokeToLeader(strokeData, senderWs, retries = 3) {
    await ensureLeader();
    if (!currentLeaderUrl) {
        if (senderWs && senderWs.readyState === WebSocket.OPEN) {
            senderWs.send(JSON.stringify({ type: 'error', message: 'No leader available' }));
        }
        return;
    }

    try {
        const res = await axios.post(`${currentLeaderUrl}/stroke`, { stroke: strokeData }, { timeout: 500 });
        if (!res.data.success) {
            console.warn(`[Gateway] Stroke not committed: ${JSON.stringify(res.data)}`);
        } else if (senderWs && senderWs.readyState === WebSocket.OPEN) {
            senderWs.send(JSON.stringify({
                type: 'ack',
                id: strokeData.id,
                index: res.data.entry?.index,
                duplicate: Boolean(res.data.duplicate),
            }));
        }
    } catch (err) {
        if (err.response && [302, 307].includes(err.response.status)) {
            // Redirected — another node is the leader
            const { leaderUrl } = err.response.data;
            if (leaderUrl) {
                currentLeaderUrl = leaderUrl;
            } else {
                currentLeaderUrl = null;
                currentLeaderId = null;
            }
            if (retries > 0) {
                await forwardStrokeToLeader(strokeData, senderWs, retries - 1);
            }
        } else {
            console.error(`[Gateway] Leader unreachable: ${err.message}`);
            currentLeaderUrl = null;
            currentLeaderId = null;
            if (retries > 0) {
                await new Promise(r => setTimeout(r, 200));
                await forwardStrokeToLeader(strokeData, senderWs, retries - 1);
            }
        }
    }
}

// ─── SEND FULL LOG TO NEW CLIENT ──────────────────────────────────────────────

async function sendFullLog(ws) {
    if (!currentLeaderUrl) return;
    try {
        const res = await axios.get(`${currentLeaderUrl}/log`, { timeout: 500 });
        const { log, commitIndex } = res.data;
        const committed = log.slice(0, commitIndex + 1);
        if (ws.readyState === WebSocket.OPEN && committed.length > 0) {
            ws.send(JSON.stringify({ type: 'full-log', entries: committed }));
        }
    } catch (_) {
        // Leader may not be up yet — client will see strokes once they're drawn
    }
}

// ─── BROADCAST HELPER ─────────────────────────────────────────────────────────

function broadcast(msg) {
    const payload = JSON.stringify(msg);
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(payload);
        }
    }
}

// ─── STATUS ENDPOINT ─────────────────────────────────────────────────────────

app.get('/gateway-status', (req, res) => {
    res.json({
        leaderId: currentLeaderId,
        leaderUrl: currentLeaderUrl,
        connectedClients: clients.size,
    });
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ─── REPLICA STATUS PROXY (for frontend) ─────────────────────────────────────

const REPLICA_URL_MAP = {
    replica1: process.env.REPLICA1_URL || 'http://replica1:5001',
    replica2: process.env.REPLICA2_URL || 'http://replica2:5002',
    replica3: process.env.REPLICA3_URL || 'http://replica3:5003',
};

app.get('/replica-status/:replicaId', async (req, res) => {
    const url = REPLICA_URL_MAP[req.params.replicaId];
    if (!url) return res.status(404).json({ error: 'Unknown replica' });
    try {
        const r = await axios.get(`${url}/status`, { timeout: 500 });
        res.json(r.data);
    } catch (_) {
        res.status(503).json({ state: 'DOWN', replicaId: req.params.replicaId });
    }
});

// ─── REPLICA PAUSE / RESUME PROXY ────────────────────────────────────────────

app.post('/replica-control/:replicaId/pause', async (req, res) => {
    const url = REPLICA_URL_MAP[req.params.replicaId];
    if (!url) return res.status(404).json({ error: 'Unknown replica' });
    try {
        const r = await axios.post(`${url}/pause`, {}, { timeout: 500 });
        // If this was the leader, clear gateway's cached leader so it re-discovers
        if (currentLeaderId === req.params.replicaId) {
            currentLeaderUrl = null;
            currentLeaderId = null;
        }
        res.json(r.data);
    } catch (_) {
        res.status(503).json({ error: 'Could not reach replica' });
    }
});

app.post('/replica-control/:replicaId/resume', async (req, res) => {
    const url = REPLICA_URL_MAP[req.params.replicaId];
    if (!url) return res.status(404).json({ error: 'Unknown replica' });
    try {
        const r = await axios.post(`${url}/resume`, {}, { timeout: 500 });
        res.json(r.data);
    } catch (_) {
        res.status(503).json({ error: 'Could not reach replica' });
    }
});

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '4000');
server.listen(PORT, async () => {
    console.log(`[Gateway] Listening on port ${PORT}`);
    await setupRedis();
    // Attempt initial leader discovery after a short boot delay
    setTimeout(discoverLeader, 1000);
});

async function shutdown(signal) {
    console.log(`[Gateway] ${signal} · draining connections`);
    await Promise.allSettled([
        redisSubscriber?.isOpen ? redisSubscriber.quit() : Promise.resolve(),
        redisPublisher?.isOpen ? redisPublisher.quit() : Promise.resolve(),
    ]);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
