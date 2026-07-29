/**
 * script.js — miniRaft Drawing Board Client (v2)
 *
 * Accuracy:
 *  - Stroke IDs prevent double-count + double-render of own strokes
 *  - Stroke count sourced from leader's commitIndex (ground truth)
 *  - Client count sourced from /gateway-status (polled)
 *  - Elections counted from leader-change WS events
 *  - Rich event log: term changes, log jumps, quorum, replication events
 */

// ─── Elections counter ────────────────────────────────────────────────────────
let electionsCount = 0;
function incElections() {
    electionsCount++;
    const el = document.getElementById('elections-count');
    if (el) el.textContent = electionsCount;
}

// ─── Pending stroke IDs (skip re-render of own echoed strokes) ────────────────
const pendingStrokeIds = new Set();
const pendingCommands = new Map();
const pendingStartedAt = new Map();

const CLIENT_ID_KEY = 'miniraft-client-id';
const CLIENT_SEQ_KEY = 'miniraft-client-sequence';
const fallbackId = `client-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const clientId = localStorage.getItem(CLIENT_ID_KEY) ||
    (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : fallbackId);
localStorage.setItem(CLIENT_ID_KEY, clientId);
document.getElementById('client-id').textContent = clientId;

function nextSequence() {
    const current = Number.parseInt(localStorage.getItem(CLIENT_SEQ_KEY) || '0', 10);
    const next = Number.isFinite(current) ? current + 1 : 1;
    localStorage.setItem(CLIENT_SEQ_KEY, String(next));
    return next;
}

function markCommitted(id) {
    if (!id) return;
    const started = pendingStartedAt.get(id);
    if (started !== undefined) {
        const latency = Math.max(0, Math.round(performance.now() - started));
        const metric = document.getElementById('commit-latency');
        if (metric) metric.textContent = `${latency}ms`;
    }
    pendingStrokeIds.delete(id);
    pendingCommands.delete(id);
    pendingStartedAt.delete(id);
    document.getElementById('canvas-hint')?.classList.add('hidden');
}

// ─── WebSocket ────────────────────────────────────────────────────────────────

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`;
let ws = null;

function connectWS() {
    ws = new WebSocket(WS_URL);

    ws.addEventListener('open', () => {
        setWsStatus('connected');
        logEvent('info', 'WS', 'Connected to Gateway');
        showToast('Connected to Gateway', 'success');
        hideFailoverOverlay();
        ws.send(JSON.stringify({ type: 'request-log' }));
        for (const command of pendingCommands.values()) {
            ws.send(JSON.stringify({ type: 'stroke', data: command }));
        }
    });

    ws.addEventListener('message', (ev) => {
        try { handleMessage(JSON.parse(ev.data)); } catch (_) {}
    });

    ws.addEventListener('close', () => {
        setWsStatus('error');
        logEvent('error', 'WS', 'Disconnected — reconnecting…');
        showToast('Disconnected — reconnecting…', 'error');
        setTimeout(connectWS, 1500);
    });

    ws.addEventListener('error', () => setWsStatus('error'));
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'connected':
            if (msg.leaderId) updateLeader(msg.leaderId);
            break;

        case 'stroke': {
            const id = msg.data && msg.data.id;
            if (id && pendingStrokeIds.has(id)) {
                markCommitted(id);
            } else {
                drawStroke(msg.data, true);
            }
            break;
        }

        case 'ack':
            markCommitted(msg.id);
            if (msg.duplicate) {
                logEvent('commit', 'DEDUP', `Retry resolved to committed entry ${msg.index}`);
            }
            break;

        case 'full-log':
            redrawCanvas(msg.entries);
            if (msg.entries.length > 0) document.getElementById('canvas-hint')?.classList.add('hidden');
            logEvent('info', 'SYNC', `Replayed ${msg.entries.length} committed strokes from leader log`);
            break;

        case 'leader-change':
            if (msg.leaderId !== currentLeaderId) {
                incElections();
                logEvent('leader', 'ELECT', `⚡ Leader elected: ${msg.leaderId}  (election #${electionsCount})`);
                showToast(`⚡ New leader: ${msg.leaderId}`, 'info');
            }
            updateLeader(msg.leaderId);
            hideFailoverOverlay();
            break;

        case 'error':
            logEvent('error', 'ERR', msg.message);
            showToast(msg.message, 'error');
            showFailoverOverlay();
            break;
    }
}

// ─── Canvas Setup ─────────────────────────────────────────────────────────────

const canvas = document.getElementById('drawing-canvas');
const ctx    = canvas.getContext('2d');
const committedStrokes = [];

function resizeCanvas() {
    const wrap = document.getElementById('canvas-wrap');
    const dpr  = window.devicePixelRatio || 1;
    canvas.width  = wrap.clientWidth  * dpr;
    canvas.height = wrap.clientHeight * dpr;
    canvas.style.width  = wrap.clientWidth  + 'px';
    canvas.style.height = wrap.clientHeight + 'px';
    ctx.scale(dpr, dpr);
    replayAll();
}

function replayAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    committedStrokes.forEach(s => _renderStroke(s));
}

window.addEventListener('resize', resizeCanvas);
resizeCanvas();

// ─── Drawing State ────────────────────────────────────────────────────────────

let currentTool  = 'pen';
let currentColor = '#f2f3ed';
let brushSize    = 4;
let isDrawing    = false;
let currentPath  = [];

function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const src  = e.touches ? e.touches[0] : e;
    return {
        x: (src.clientX - rect.left) / rect.width,
        y: (src.clientY - rect.top)  / rect.height,
    };
}

canvas.addEventListener('mousedown',  startDraw);
canvas.addEventListener('mousemove',  continueDraw);
canvas.addEventListener('mouseup',    endDraw);
canvas.addEventListener('mouseleave', endDraw);
canvas.addEventListener('touchstart', e => { e.preventDefault(); startDraw(e); },    { passive: false });
canvas.addEventListener('touchmove',  e => { e.preventDefault(); continueDraw(e); }, { passive: false });
canvas.addEventListener('touchend',   e => { e.preventDefault(); endDraw(e); },      { passive: false });

function startDraw(e) {
    isDrawing = true;
    currentPath = [];
    const pos = getPos(e);
    currentPath.push(pos);
    ctx.beginPath();
    const dpr = window.devicePixelRatio || 1;
    ctx.moveTo(pos.x * canvas.width / dpr, pos.y * canvas.height / dpr);
}

function continueDraw(e) {
    if (!isDrawing) return;
    const pos = getPos(e);
    currentPath.push(pos);
    const dpr = window.devicePixelRatio || 1;
    const px  = pos.x * (canvas.width  / dpr);
    const py  = pos.y * (canvas.height / dpr);
    ctx.lineWidth   = currentTool === 'eraser' ? brushSize * 4 : brushSize;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.strokeStyle = currentTool === 'eraser' ? '#070b14' : currentColor;
    ctx.globalCompositeOperation = currentTool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(px, py);
}

function endDraw() {
    if (!isDrawing) return;
    isDrawing = false;
    ctx.globalCompositeOperation = 'source-over';
    if (currentPath.length < 2) return;

    // Unique ID so we can identify our own echo from the gateway and skip re-render
    const strokeId = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const stroke = {
        id: strokeId, clientId, seqNo: nextSequence(),
        tool: currentTool, color: currentColor, size: brushSize, points: currentPath,
    };

    committedStrokes.push(stroke);
    pendingStrokeIds.add(strokeId);
    pendingCommands.set(strokeId, stroke);
    pendingStartedAt.set(strokeId, performance.now());
    document.getElementById('canvas-hint')?.classList.add('hidden');

    // Stroke count sourced from server's commitIndex — NOT incremented here
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stroke', data: stroke }));
    }
}

// ─── Stroke Rendering ─────────────────────────────────────────────────────────

function drawStroke(strokeData, addToLog = true) {
    if (addToLog) committedStrokes.push(strokeData);
    _renderStroke(strokeData);
}

// Ground-truth stroke count from leader's commitIndex
function setStrokeCount(n) {
    const el = document.getElementById('stroke-count');
    if (el) el.textContent = n;
}

function _renderStroke(strokeData) {
    if (!strokeData) return;
    if (strokeData.tool === 'clear') {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        return;
    }
    if (!strokeData.points || strokeData.points.length < 2) return;

    const dpr = window.devicePixelRatio || 1;
    const w   = canvas.width  / dpr;
    const h   = canvas.height / dpr;

    ctx.save();
    ctx.beginPath();
    ctx.lineWidth   = strokeData.tool === 'eraser' ? strokeData.size * 4 : strokeData.size;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.strokeStyle = strokeData.tool === 'eraser' ? '#070b14' : strokeData.color;
    ctx.globalCompositeOperation = strokeData.tool === 'eraser' ? 'destination-out' : 'source-over';
    strokeData.points.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.x * w, pt.y * h);
        else         ctx.lineTo(pt.x * w, pt.y * h);
    });
    ctx.stroke();
    ctx.restore();
}

function redrawCanvas(entries) {
    committedStrokes.length = 0;
    entries.forEach(e => { if (e.data) committedStrokes.push(e.data); });
    replayAll();
    setStrokeCount(entries.length);
}

// ─── UI Controls – Tools ──────────────────────────────────────────────────────

document.getElementById('tool-group').addEventListener('click', (e) => {
    const btn = e.target.closest('.tool-btn[data-tool]');
    if (!btn) return;
    document.querySelectorAll('.tool-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
    canvas.style.cursor = currentTool === 'eraser' ? 'cell' : 'crosshair';
});

document.getElementById('tool-clear').addEventListener('click', () => {
    if (committedStrokes.length === 0) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const s = { id, clientId, seqNo: nextSequence(), tool: 'clear', points: [] };
    committedStrokes.push(s);
    pendingStrokeIds.add(id);
    pendingCommands.set(id, s);
    pendingStartedAt.set(id, performance.now());
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stroke', data: s }));
    }
});

// ─── UI Controls – Color ──────────────────────────────────────────────────────

document.getElementById('color-palette').addEventListener('click', (e) => {
    const sw = e.target.closest('.color-swatch');
    if (!sw) return;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    sw.classList.add('active');
    currentColor = sw.dataset.color;
});

const colorCustom = document.getElementById('color-custom');
colorCustom.addEventListener('input', () => {
    currentColor = colorCustom.value;
    document.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
    const preview = document.getElementById('custom-preview');
    if (preview) preview.style.background = currentColor;
});
document.querySelector('.color-custom-label').addEventListener('click', () => colorCustom.click());

// ─── UI Controls – Brush Size ─────────────────────────────────────────────────

const brushSlider  = document.getElementById('brush-size');
const sizePreview  = document.getElementById('size-preview');
const sizeValLabel = document.getElementById('size-val');

function updateSizePreview() {
    const val = parseInt(brushSlider.value);
    brushSize = val;
    sizeValLabel.textContent = `${val}px`;
    const px = Math.max(val, 2);
    sizePreview.style.width  = px + 'px';
    sizePreview.style.height = px + 'px';
    const pct = ((val - 1) / 39 * 100).toFixed(1);
    brushSlider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--border) ${pct}%)`;
}
brushSlider.addEventListener('input', updateSizePreview);
updateSizePreview();

// ─── Client Count (from gateway-status polling) ───────────────────────────────

function setClientCount(n) {
    const el = document.getElementById('client-count');
    if (el) el.textContent = n;
}

// ─── Leader Display ───────────────────────────────────────────────────────────

let currentLeaderId = null;

function updateLeader(leaderId) {
    currentLeaderId = leaderId;
    const dot  = document.getElementById('leader-dot');
    const name = document.getElementById('leader-name');
    if (leaderId) {
        name.textContent = leaderId;
        dot.classList.add('online');
    } else {
        name.textContent = 'none';
        dot.classList.remove('online');
    }
}

// ─── WS Status ────────────────────────────────────────────────────────────────

function setWsStatus(state) {
    const ind    = document.getElementById('ws-indicator');
    const status = document.getElementById('ws-status');
    ind.className   = `ws-indicator ${state}`;
    status.textContent = state === 'connected' ? 'Connected' : 'Reconnecting…';
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;
function showToast(msg, type = 'info') {
    const toast = document.getElementById('toast');
    toast.textContent = msg;
    toast.className   = `toast show ${type}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

// ─── Failover Overlay ─────────────────────────────────────────────────────────

function showFailoverOverlay() { document.getElementById('failover-overlay').classList.add('active'); }
function hideFailoverOverlay() { document.getElementById('failover-overlay').classList.remove('active'); }

// ─── Event Log ────────────────────────────────────────────────────────────────

function logEvent(type, category, msg) {
    const body = document.getElementById('event-log-body');
    const now  = new Date();
    const time = `${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;

    const line = document.createElement('div');
    line.className = 'log-line';
    const timeEl = document.createElement('span');
    timeEl.className = 'log-time';
    timeEl.textContent = time;
    const typeEl = document.createElement('span');
    typeEl.className = `log-type ${type}`;
    typeEl.textContent = category;
    const messageEl = document.createElement('span');
    messageEl.className = 'log-msg';
    messageEl.textContent = msg;
    line.append(timeEl, typeEl, messageEl);
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
    while (body.children.length > 300) body.removeChild(body.firstChild);
}

document.getElementById('clear-log').addEventListener('click', () => {
    document.getElementById('event-log-body').innerHTML = '';
});

// ─── Topology Visualizer ──────────────────────────────────────────────────────

const REPLICAS = ['replica1', 'replica2', 'replica3'];

const NODE_POS = {
    replica1: { x: 130, y: 42  },
    replica2: { x: 218, y: 150 },
    replica3: { x: 42,  y: 150 },
};

const replicaState = { replica1: null, replica2: null, replica3: null };

function updateTopologyNode(id, state) {
    const g = document.getElementById(`topo-node-${id}`);
    if (!g) return;
    g.className.baseVal = `topo-node ${state.toLowerCase()}`;
}

function updateReplicaCard(id, data) {
    const card      = document.getElementById(`card-${id}`);
    const badge     = document.getElementById(`badge-${id}`);
    const termEl    = document.getElementById(`term-${id}`);
    const logEl     = document.getElementById(`log-${id}`);
    const commitEl  = document.getElementById(`commit-${id}`);
    const killBtn   = document.getElementById(`kill-${id}`);
    const reviveBtn = document.getElementById(`revive-${id}`);
    if (!card) return;

    const state    = (data.state || 'down').toLowerCase();
    const isPaused = state === 'paused';

    card.className        = `replica-card ${state}`;
    badge.textContent     = data.state || 'DOWN';
    termEl.textContent    = data.term       !== undefined ? data.term       : '–';
    logEl.textContent     = data.logLength  !== undefined ? data.logLength  : '–';
    if (commitEl) {
        const applied = data.lastApplied !== undefined ? data.lastApplied : data.commitIndex;
        commitEl.textContent = applied !== undefined ? applied + 1 : '–';
    }

    killBtn.disabled   = isPaused;
    reviveBtn.disabled = !isPaused;
}

function setLineActive(id, active) {
    const el = document.getElementById(id);
    if (!el) return;
    if (active) el.classList.add('active');
    else        el.classList.remove('active');
}

function startHeartbeatPulse(leaderId) {
    stopAllPulses();
    const svgNS   = 'http://www.w3.org/2000/svg';
    const pulsesG = document.getElementById('pulses');
    if (!pulsesG) return;
    pulsesG.innerHTML = '';

    const leaderPos = NODE_POS[leaderId];
    if (!leaderPos) return;

    REPLICAS.filter(r => r !== leaderId).forEach(followerId => {
        const fPos = NODE_POS[followerId];
        if (!fPos) return;
        [0, 0.5].forEach(offset => {
            const circle = document.createElementNS(svgNS, 'circle');
            circle.setAttribute('r', '3');
            circle.classList.add('hb-pulse');
            const animX = document.createElementNS(svgNS, 'animate');
            animX.setAttribute('attributeName', 'cx');
            animX.setAttribute('values', `${leaderPos.x};${fPos.x}`);
            animX.setAttribute('dur', '1.2s');
            animX.setAttribute('begin', `${offset}s`);
            animX.setAttribute('repeatCount', 'indefinite');
            const animY = document.createElementNS(svgNS, 'animate');
            animY.setAttribute('attributeName', 'cy');
            animY.setAttribute('values', `${leaderPos.y};${fPos.y}`);
            animY.setAttribute('dur', '1.2s');
            animY.setAttribute('begin', `${offset}s`);
            animY.setAttribute('repeatCount', 'indefinite');
            const animO = document.createElementNS(svgNS, 'animate');
            animO.setAttribute('attributeName', 'opacity');
            animO.setAttribute('values', '0;1;1;0');
            animO.setAttribute('keyTimes', '0;0.1;0.85;1');
            animO.setAttribute('dur', '1.2s');
            animO.setAttribute('begin', `${offset}s`);
            animO.setAttribute('repeatCount', 'indefinite');
            circle.appendChild(animX);
            circle.appendChild(animY);
            circle.appendChild(animO);
            pulsesG.appendChild(circle);
        });
    });
}

function stopAllPulses() {
    const g = document.getElementById('pulses');
    if (g) g.innerHTML = '';
}

// ─── Cluster Status Polling ───────────────────────────────────────────────────

const prevSnapshot = {}; // per-node previous state snapshot for change detection

async function refreshClusterStatus() {
    let leaderFound     = null;
    let aliveCount      = 0;
    let leaderCommitIdx = -1;
    let clusterSize     = REPLICAS.length;
    let quorumSize      = Math.floor(clusterSize / 2) + 1;
    let highestTerm     = 0;
    let durableNodes    = 0;

    for (const id of REPLICAS) {
        let data;
        try {
            const res = await fetch(`/replica-status/${id}`, { signal: AbortSignal.timeout(900) });
            data = await res.json();
        } catch (_) {
            data = { state: 'DOWN', replicaId: id };
        }

        const prev     = prevSnapshot[id] || {};
        const newState = data.state || 'DOWN';
        const newTerm  = data.term;
        const newLog   = data.logLength;
        const newCI    = data.commitIndex;
        const isPaused = newState === 'PAUSED';
        if (Number.isInteger(data.clusterSize)) clusterSize = data.clusterSize;
        if (Number.isInteger(data.quorumSize)) quorumSize = data.quorumSize;
        if (Number.isInteger(newTerm)) highestTerm = Math.max(highestTerm, newTerm);
        if (data.durable) durableNodes++;

        // ── State transition logging ────────────────────────────────────────
        if (prev.state !== undefined && prev.state !== newState) {
            if (newState === 'LEADER') {
                logEvent('leader', 'RAFT', `${id} → LEADER  (term ${newTerm}, log=${newLog})`);
                hideFailoverOverlay();
            } else if (newState === 'CANDIDATE') {
                logEvent('election', 'RAFT', `${id} → CANDIDATE  🗳 requesting votes (term ${newTerm})`);
            } else if (newState === 'FOLLOWER' && prev.state === 'CANDIDATE') {
                logEvent('info', 'RAFT', `${id} lost election — back to FOLLOWER`);
            } else if (newState === 'FOLLOWER' && prev.state === 'PAUSED') {
                logEvent('resume', 'SYNC', `${id} rejoined as FOLLOWER — syncing log…`);
                const card = document.getElementById(`card-${id}`);
                if (card) { card.classList.add('syncing'); setTimeout(() => card.classList.remove('syncing'), 2500); }
            } else if (newState === 'DOWN') {
                logEvent('error', 'NODE', `${id} is unreachable`);
            }
        }

        // ── Term change ─────────────────────────────────────────────────────
        if (prev.term !== undefined && newTerm !== undefined && newTerm > prev.term) {
            logEvent('election', 'TERM', `${id} term: ${prev.term} → ${newTerm}  (new election round)`);
        }

        // ── Log length jump (catch-up detection) ────────────────────────────
        if (prev.logLength !== undefined && newLog !== undefined) {
            const jump = newLog - prev.logLength;
            if (jump >= 3) {
                logEvent('resume', 'SYNC', `${id} log jumped +${jump} entries (${prev.logLength}→${newLog}) — catch-up`);
            } else if (jump === 1 && (newState === 'FOLLOWER' || newState === 'LEADER')) {
                logEvent('commit', 'REPL', `${id} replicated entry — log=${newLog}, committed=${(newCI !== undefined ? newCI + 1 : '?')}`);
            }
        }

        // ── Leader commit advance ───────────────────────────────────────────
        if (newState === 'LEADER' && prev.commitIndex !== undefined && newCI !== undefined && newCI > prev.commitIndex) {
            logEvent('commit', 'CMIT', `${id} committed up to index ${newCI}  (quorum ✓)  [strokes: ${newCI + 1}]`);
        }

        // Save snapshot
        prevSnapshot[id] = { state: newState, term: newTerm, logLength: newLog, commitIndex: newCI };
        replicaState[id] = newState;

        updateTopologyNode(id, newState);
        updateReplicaCard(id, data);

        if (newState === 'LEADER') { leaderFound = id; leaderCommitIdx = (newCI !== undefined) ? newCI : -1; }
        if (newState !== 'DOWN' && !isPaused) aliveCount++;
    }

    // ── Quorum status ───────────────────────────────────────────────────────
    const quorumEl = document.getElementById('quorum-status');
    if (quorumEl) {
        quorumEl.textContent = `${aliveCount}/${clusterSize}`;
        quorumEl.className = aliveCount >= quorumSize ? 'quorum-ok' : 'quorum-fail';
    }
    const termEl = document.getElementById('cluster-term');
    if (termEl) termEl.textContent = highestTerm || '—';
    const formulaEl = document.getElementById('quorum-formula');
    if (formulaEl) formulaEl.textContent = `⌊${clusterSize} / 2⌋ + 1 = ${quorumSize}`;
    const proofEl = document.getElementById('safety-proof');
    if (proofEl) {
        if (leaderFound && aliveCount >= quorumSize && durableNodes >= quorumSize) {
            proofEl.textContent = 'Durable majority · current-term commit rule active';
        } else if (aliveCount >= quorumSize) {
            proofEl.textContent = 'Majority available · waiting for a stable leader';
        } else {
            proofEl.textContent = `Quorum lost · ${quorumSize - aliveCount} node(s) needed`;
        }
    }

    // ── Accurate stroke count (leader's commitIndex) ────────────────────────
    if (leaderFound && leaderCommitIdx >= 0) {
        setStrokeCount(leaderCommitIdx + 1);
    }

    // ── Accurate client count (gateway-status) ──────────────────────────────
    try {
        const gw = await fetch('/gateway-status', { signal: AbortSignal.timeout(500) });
        const gwData = await gw.json();
        if (gwData.connectedClients !== undefined) setClientCount(gwData.connectedClients);
    } catch (_) {}

    // ── Topology lines & heartbeat pulses ───────────────────────────────────
    if (leaderFound) {
        const pairs = [
            ['line-12', 'replica1', 'replica2'],
            ['line-13', 'replica1', 'replica3'],
            ['line-23', 'replica2', 'replica3'],
        ];
        pairs.forEach(([lineId, a, b]) => {
            const active = (a === leaderFound || b === leaderFound) &&
                           replicaState[a] !== 'PAUSED' && replicaState[b] !== 'PAUSED' &&
                           replicaState[a] !== 'DOWN'   && replicaState[b] !== 'DOWN';
            setLineActive(lineId, active);
        });
        if (leaderFound !== currentLeaderId) startHeartbeatPulse(leaderFound);
        updateLeader(leaderFound);
    } else {
        stopAllPulses();
        ['line-12', 'line-13', 'line-23'].forEach(l => setLineActive(l, false));
    }
}

setInterval(refreshClusterStatus, 2000);
setTimeout(refreshClusterStatus, 800);

// ─── Kill / Revive Controls ───────────────────────────────────────────────────

async function killReplica(id) {
    logEvent('pause', 'KILL', `Sending pause signal to ${id}…`);
    showToast(`🔴 Killing ${id}…`, 'warn');
    showFailoverOverlay();
    try {
        const res  = await fetch(`/replica-control/${id}/pause`, { method: 'POST' });
        const data = await res.json();
        if (data.ok || data.paused) {
            logEvent('pause', 'KILL', `${id} is now PAUSED — election may trigger`);
            showToast(`${id} killed — election in progress`, 'error');
            replicaState[id] = 'PAUSED';
            updateTopologyNode(id, 'PAUSED');
            updateReplicaCard(id, { state: 'PAUSED' });
        }
    } catch (err) {
        logEvent('error', 'ERR', `Failed to kill ${id}: ${err.message}`);
        showToast(`Failed to reach ${id}`, 'error');
    }
    setTimeout(refreshClusterStatus, 400);
}

async function reviveReplica(id) {
    logEvent('resume', 'REVIVE', `Sending resume signal to ${id}…`);
    showToast(`🟢 Reviving ${id}…`, 'info');
    try {
        const res  = await fetch(`/replica-control/${id}/resume`, { method: 'POST' });
        const data = await res.json();
        if (data.ok || !data.paused) {
            logEvent('resume', 'REVIVE', `${id} resumed — rejoining cluster, syncing log`);
            showToast(`${id} rejoined cluster!`, 'success');
            replicaState[id] = 'FOLLOWER';
        }
    } catch (err) {
        logEvent('error', 'ERR', `Failed to revive ${id}: ${err.message}`);
        showToast(`Failed to reach ${id}`, 'error');
    }
    setTimeout(refreshClusterStatus, 600);
}

REPLICAS.forEach(id => {
    document.getElementById(`kill-${id}`).addEventListener('click',   () => killReplica(id));
    document.getElementById(`revive-${id}`).addEventListener('click', () => reviveReplica(id));
});

// ─── Keyboard controls ───────────────────────────────────────────────────────

document.addEventListener('keydown', (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (key === 'p') document.getElementById('tool-pen').click();
    if (key === 'e') document.getElementById('tool-eraser').click();
    if (key === 'c') document.getElementById('tool-clear').click();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

setWsStatus('error');
logEvent('info', 'BOOT', 'miniRaft consensus lab initialized · restoring durable cluster state');
connectWS();
