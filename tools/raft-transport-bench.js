#!/usr/bin/env node
'use strict';

/**
 * raft-transport-bench.js — the replica-to-replica transport in isolation:
 * no Raft engine, no log, no fsync (Phase IV-A, gate before the comparison
 * sweep).
 *
 *   node tools/raft-transport-bench.js [--duration 10s] [--warmup 2s] [--repetitions 3] \
 *       [--out artifacts/perf/phase-iv-a/transport-isolation]
 *
 * A client process sends AppendEntries requests, closed loop with C requests
 * in flight, to a server in its own process whose handler decodes the request
 * fully and answers a fixed success. Both processes are fresh for every trial.
 * Transports:
 *
 *   http-plain     Node's http client (keep-alive agent) -> a bare http server
 *                  that parses the JSON body: Node's HTTP stack with no library
 *   http-json      axios -> express + express.json, exactly the replica's
 *                  default path (Node's global agent keeps connections alive)
 *   framed-json    the framed transport's one multiplexed TCP connection, with
 *                  the whole request JSON-encoded in the frame (benchmark-only;
 *                  isolates framing + connection handling from the encoding)
 *   framed-binary  the framed transport as the replica uses it (raft-codec.js)
 *
 * Workloads: 1 KiB entries, 1 or 16 per request (unbatched / batched), C = 1
 * (stop-and-wait) or 8 (pipelined). Entries are encoded once before the window
 * (the log store pays that in the engine), so the window measures transport
 * cost only. Reported per trial: messages/s, entries/s, p50/p99 round trip,
 * client and server CPU (µs per message, % of one core), and wire bytes per
 * message counted on the server's sockets.
 *
 * Two phases per trial, from a per-second timeline of completions: *burst*,
 * the first two seconds of load, and *sustained*, the measurement window,
 * which opens after a 5 s warmup. On the benchmark machine (Windows 11, Node
 * 24) Node's HTTP stack runs several times faster for about the first 3 s of
 * load in a process and then drops, and stays down, for the life of the
 * process. This happens with or without axios/express and over named pipes as
 * well as loopback TCP; the framed transport does not do it. The replicas run
 * for far longer than 3 s, so sustained is the comparison figure; burst is
 * reported so the effect is visible rather than averaged in.
 *
 * The cause is Windows power throttling (EcoQoS) of busy background
 * processes (packages/raft-bench/power-throttling.js). --power-throttling off
 * opts the client and server processes out before load starts;
 * --power-throttling os-default leaves Windows' default behaviour.
 *
 * Internal consistency is checked and recorded, not assumed: Little's law
 * (msg/s x mean RTT ~= C), zero errors, connection reuse, and for the binary
 * codec, wire bytes per message against the encoded frame sizes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { fork } = require('child_process');
const { performance } = require('perf_hooks');
const { parseArgs } = require('../packages/raft-bench/cli');
const { LogLinearHistogram } = require('../replica/perf-histogram');
const { entryJson } = require('../replica/entry-codec');
const { TYPES, encodeRequest, encodeResponse, decodeBody } = require('../replica/raft-codec');
const { disablePowerThrottling } = require('../packages/raft-bench/power-throttling');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
    duration: 10000,
    warmup: 5000,
    repetitions: 3,
    port: 19101,
    transports: ['http-plain', 'http-json', 'framed-json', 'framed-binary'],
    entries: [1, 16],
    concurrency: [1, 8],
    payload: 1024,
    out: path.join(ROOT, 'artifacts', 'perf', 'phase-iv-a', 'transport-isolation'),
    serve: null,
    client: null,
    'power-throttling': 'os-default',
};

// ── server (child process) ──────────────────────────────────────────────────

function answer(body) {
    const count = Array.isArray(body.entries) ? body.entries.length : 0;
    return { term: body.term, success: true, matchIndex: body.prevLogIndex + count };
}

function serve(kind, port) {
    const sockets = new Set();
    let connections = 0;
    const track = (socket) => { connections += 1; sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
    let server;
    if (kind === 'http-plain') {
        server = http.createServer((req, res) => {
            const chunks = [];
            req.on('data', (chunk) => chunks.push(chunk));
            req.on('end', () => {
                const out = JSON.stringify(answer(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
                res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(out) });
                res.end(out);
            });
        });
        server.on('connection', track);
    } else if (kind === 'http-json') {
        const express = require('../replica/node_modules/express');
        const app = express();
        app.use(express.json({ limit: '2mb' }));
        app.post('/append-entries', (req, res) => res.json(answer(req.body)));
        server = http.createServer(app);
        server.on('connection', track);
    } else {
        const { createFramedTcpServer } = require('../replica/raft-transport');
        server = createFramedTcpServer({
            handlers: {
                [TYPES.APPEND_ENTRIES]: (body) => answer(body),
                // framed-json: the AppendEntries body travels as a JSON frame.
                [TYPES.REQUEST_VOTE]: (body) => answer(body),
            },
            onSocket: track,
        });
    }
    let mark = null;
    const snapshot = () => {
        let bytes = 0;
        for (const socket of sockets) bytes += socket.bytesRead + socket.bytesWritten;
        return { cpu: process.cpuUsage(), bytes, connections, at: performance.now() };
    };
    process.on('message', (message) => {
        if (message.type === 'mark') { mark = snapshot(); process.send({ type: 'marked' }); }
        if (message.type === 'measure') {
            const now = snapshot();
            process.send({
                type: 'measured',
                cpuMicros: (now.cpu.user - mark.cpu.user) + (now.cpu.system - mark.cpu.system),
                bytes: now.bytes - mark.bytes,
                wallMs: now.at - mark.at,
                connectionsTotal: now.connections,
                openSockets: sockets.size,
            });
        }
        if (message.type === 'stop') server.close(() => process.exit(0));
    });
    server.listen(port, '127.0.0.1', () => process.send({ type: 'ready' }));
}

// ── client ──────────────────────────────────────────────────────────────────

function startServer(kind, port) {
    const child = fork(__filename, ['--serve', kind, '--port', String(port)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const waitFor = (type) => new Promise((resolve) => {
        const onMessage = (message) => { if (message.type === type) { child.off('message', onMessage); resolve(message); } };
        child.on('message', onMessage);
    });
    return {
        child,
        ready: waitFor('ready'),
        mark: () => { const p = waitFor('marked'); child.send({ type: 'mark' }); return p; },
        measure: () => { const p = waitFor('measured'); child.send({ type: 'measure' }); return p; },
        stop: () => new Promise((resolve) => { child.once('exit', resolve); child.send({ type: 'stop' }); }),
    };
}

function makeEntries(count, payload) {
    const value = 'v'.repeat(payload);
    const pool = Array.from({ length: 4096 }, (_, i) => ({ term: 3, index: 1000 + i, ts: 1790000000000 + i, data: { op: 'set', key: `k${i % 1000}`, value } }));
    for (const entry of pool) entryJson(entry); // encoded once, as the log store would
    let cursor = 0;
    return () => {
        const entries = [];
        for (let i = 0; i < count; i += 1) entries.push(pool[(cursor + i) % pool.length]);
        cursor = (cursor + count) % pool.length;
        return entries;
    };
}

function clientFor(kind, port) {
    const url = `http://127.0.0.1:${port}`;
    if (kind === 'http-plain') {
        const agent = new http.Agent({ keepAlive: true });
        const post = (body) => new Promise((resolve, reject) => {
            const payload = Buffer.from(JSON.stringify(body));
            const req = http.request(`${url}/append-entries`, {
                method: 'POST', agent, headers: { 'content-type': 'application/json', 'content-length': payload.length },
            }, (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => resolve({ data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
            });
            req.setTimeout(5000, () => req.destroy(new Error('ETIMEDOUT')));
            req.on('error', reject);
            req.end(payload);
        });
        return { post, close: () => agent.destroy() };
    }
    if (kind === 'http-json') {
        const axios = require('../replica/node_modules/axios');
        return { post: (body) => axios.post(`${url}/append-entries`, body, { timeout: 5000 }), close: () => {} };
    }
    const { FramedTcpTransport } = require('../replica/raft-transport');
    const transport = new FramedTcpTransport({ portOffset: 0 });
    const route = kind === 'framed-json' ? '/request-vote' : '/append-entries';
    return { post: (body) => transport.post(`${url}${route}`, body, { timeout: 5000 }), close: () => transport.close() };
}

async function trial({ kind, entries: entryCount, concurrency, options, repetition }) {
    const server = startServer(kind, options.port);
    await server.ready;
    const throttling = options['power-throttling'] === 'off'
        ? { mode: 'off', applied: disablePowerThrottling([server.child.pid, process.pid]) }
        : { mode: 'os-default' };
    const client = clientFor(kind, options.port);
    const nextEntries = makeEntries(entryCount, options.payload);
    let prevLogIndex = 999;
    const body = () => {
        const entries = nextEntries();
        const b = { term: 3, leaderId: 'replica1', leaderUrl: 'http://127.0.0.1:17001', prevLogIndex, prevLogTerm: 3, entries, leaderCommit: prevLogIndex };
        prevLogIndex += entries.length;
        return b;
    };
    const histogram = new LogLinearHistogram();
    let measuring = false;
    let stop = false;
    let completed = 0;
    const timeline = [];
    let lastCompleted = 0;
    const ticker = setInterval(() => { timeline.push(completed - lastCompleted); lastCompleted = completed; }, 1000);
    let messages = 0;
    let errors = 0;
    let latencySumMs = 0;
    const loop = async () => {
        while (!stop) {
            const t0 = performance.now();
            try {
                const response = await client.post(body());
                if (!response.data || response.data.success !== true) throw new Error('bad response');
                completed += 1;
                if (measuring) {
                    const ms = performance.now() - t0;
                    histogram.record(ms * 1000);
                    latencySumMs += ms;
                    messages += 1;
                }
            } catch (_) {
                if (measuring) errors += 1;
            }
        }
    };
    const loops = Array.from({ length: concurrency }, loop);
    await new Promise((resolve) => setTimeout(resolve, options.warmup));
    await server.mark();
    const cpuStart = process.cpuUsage();
    const wallStart = performance.now();
    measuring = true;
    await new Promise((resolve) => setTimeout(resolve, options.duration));
    measuring = false;
    const wallMs = performance.now() - wallStart;
    const cpu = process.cpuUsage(cpuStart);
    const serverSide = await server.measure();
    stop = true;
    clearInterval(ticker);
    await Promise.all(loops);
    client.close();
    await server.stop();

    const seconds = wallMs / 1000;
    const summary = histogram.summary(1000);
    const meanMs = messages ? latencySumMs / messages : null;
    const clientCpuMicros = cpu.user + cpu.system;
    const sample = body();
    const expectedFrameBytes = kind === 'framed-binary'
        ? encodeRequest(TYPES.APPEND_ENTRIES, sample, 1).length + encodeResponse(TYPES.APPEND_ENTRIES, answer(sample), 1).length
        : null;
    const record = {
        transport: kind,
        entriesPerMessage: entryCount,
        concurrency,
        repetition,
        payloadBytes: options.payload,
        powerThrottling: throttling,
        messages,
        errors,
        messagesPerSec: messages / seconds,
        entriesPerSec: (messages * entryCount) / seconds,
        burstMessagesPerSec: timeline.length >= 2 ? (timeline[0] + timeline[1]) / 2 : null,
        timeline,
        rttMs: { p50: summary.p50, p99: summary.p99, p999: summary.p999, mean: meanMs },
        clientCpu: { microsPerMessage: messages ? clientCpuMicros / messages : null, percentOfOneCore: (clientCpuMicros / 1000 / wallMs) * 100 },
        serverCpu: { microsPerMessage: messages ? serverSide.cpuMicros / messages : null, percentOfOneCore: (serverSide.cpuMicros / 1000 / serverSide.wallMs) * 100 },
        wireBytesPerMessage: messages ? serverSide.bytes / messages : null,
        connections: { opened: serverSide.connectionsTotal, openAtEnd: serverSide.openSockets },
        checks: {
            littlesLawRatio: meanMs ? ((messages / seconds) * (meanMs / 1000)) / concurrency : null,
            expectedFrameBytesPerMessage: expectedFrameBytes,
        },
    };
    return record;
}

function aggregate(records) {
    const groups = new Map();
    for (const r of records) {
        const key = `${r.transport}|${r.entriesPerMessage}|${r.concurrency}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
    const range = (values) => ({ mean: mean(values), min: Math.min(...values), max: Math.max(...values) });
    return [...groups.values()].map((rs) => ({
        transport: rs[0].transport,
        entriesPerMessage: rs[0].entriesPerMessage,
        concurrency: rs[0].concurrency,
        repetitions: rs.length,
        messagesPerSec: range(rs.map((r) => r.messagesPerSec)),
        burstMessagesPerSec: range(rs.map((r) => r.burstMessagesPerSec)),
        entriesPerSec: range(rs.map((r) => r.entriesPerSec)),
        rttP50Ms: range(rs.map((r) => r.rttMs.p50)),
        rttP99Ms: range(rs.map((r) => r.rttMs.p99)),
        clientCpuMicrosPerMessage: range(rs.map((r) => r.clientCpu.microsPerMessage)),
        serverCpuMicrosPerMessage: range(rs.map((r) => r.serverCpu.microsPerMessage)),
        clientCpuPercent: range(rs.map((r) => r.clientCpu.percentOfOneCore)),
        serverCpuPercent: range(rs.map((r) => r.serverCpu.percentOfOneCore)),
        wireBytesPerMessage: range(rs.map((r) => r.wireBytesPerMessage)),
        errors: rs.reduce((a, r) => a + r.errors, 0),
        connectionsOpened: Math.max(...rs.map((r) => r.connections.opened)),
        littlesLawRatio: range(rs.map((r) => r.checks.littlesLawRatio)),
        expectedFrameBytesPerMessage: rs[0].checks.expectedFrameBytesPerMessage,
    }));
}

const f = (v, d = 0) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));
const fi = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US'));

function markdown(rows) {
    const lines = [
        '| transport | entries/msg | in flight | burst msg/s (first 2 s) | sustained msg/s | sustained entries/s | p50 RTT ms | p99 RTT ms | client CPU µs/msg | server CPU µs/msg | client CPU % | server CPU % | wire bytes/msg | connections | Little ratio |',
        '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ];
    for (const r of rows) {
        lines.push(`| ${r.transport} | ${r.entriesPerMessage} | ${r.concurrency} | ${fi(r.burstMessagesPerSec.mean)} | ${fi(r.messagesPerSec.mean)} | ${fi(r.entriesPerSec.mean)} | `
            + `${f(r.rttP50Ms.mean, 3)} | ${f(r.rttP99Ms.mean, 3)} | ${f(r.clientCpuMicrosPerMessage.mean)} | ${f(r.serverCpuMicrosPerMessage.mean)} | `
            + `${f(r.clientCpuPercent.mean)} | ${f(r.serverCpuPercent.mean)} | ${fi(r.wireBytesPerMessage.mean)} | ${r.connectionsOpened} | ${f(r.littlesLawRatio.mean, 2)} |`);
    }
    return lines.join('\n');
}

/** Runs one trial with its client in a fresh process (and the server in another). */
function runClientProcess(spec, options) {
    const args = ['--client', JSON.stringify(spec), '--duration', `${options.duration}ms`, '--warmup', `${options.warmup}ms`,
        '--port', String(options.port), '--payload', String(options.payload), '--power-throttling', options['power-throttling']];
    return new Promise((resolve, reject) => {
        const child = fork(__filename, args, { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        let record = null;
        child.on('message', (message) => { if (message.type === 'record') record = message.record; });
        child.on('exit', (code) => (record ? resolve(record) : reject(new Error(`client process exited ${code} without a record`))));
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, {
        durations: ['duration', 'warmup'],
        lists: { transports: String, entries: Number, concurrency: Number },
        strings: ['out', 'serve', 'client', 'power-throttling'],
    });
    if (options.serve) { serve(options.serve, options.port); return; }
    if (options.client) {
        const spec = JSON.parse(options.client);
        const record = await trial({ ...spec, options });
        process.send({ type: 'record', record }, () => process.exit(0));
        return;
    }
    const records = [];
    for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
        // Interleaved: every combination once per repetition, rotating the
        // transport order so no transport always runs first.
        const combos = [];
        for (const entries of options.entries) {
            for (const concurrency of options.concurrency) {
                const order = options.transports.map((_, i) => options.transports[(i + repetition) % options.transports.length]);
                for (const kind of order) combos.push({ kind, entries, concurrency });
            }
        }
        for (const combo of combos) {
            const record = await runClientProcess({ ...combo, repetition }, options);
            records.push(record);
            process.stdout.write(`${record.transport} e=${record.entriesPerMessage} c=${record.concurrency} rep=${repetition + 1}: `
                + `${fi(record.messagesPerSec)} msg/s p50=${f(record.rttMs.p50, 3)}ms p99=${f(record.rttMs.p99, 3)}ms `
                + `cpu c/s=${f(record.clientCpu.microsPerMessage)}/${f(record.serverCpu.microsPerMessage)}µs `
                + `bytes=${fi(record.wireBytesPerMessage)} conns=${record.connections.opened} errors=${record.errors}\n`);
        }
    }
    const rows = aggregate(records).sort((a, b) => a.entriesPerMessage - b.entriesPerMessage || a.concurrency - b.concurrency
        || options.transports.indexOf(a.transport) - options.transports.indexOf(b.transport));
    const checks = {
        zeroErrors: rows.every((r) => r.errors === 0),
        littlesLaw: rows.every((r) => Math.abs(r.littlesLawRatio.mean - 1) <= 0.1),
        persistentConnections: rows.every((r) => r.connectionsOpened <= Math.max(1, r.concurrency)),
        binaryWireBytesMatchFrames: rows.filter((r) => r.transport === 'framed-binary')
            .every((r) => Math.abs(r.wireBytesPerMessage.mean / r.expectedFrameBytesPerMessage - 1) <= 0.02),
    };
    const { execSync } = require('child_process');
    const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
    const result = {
        schema: 'cloudproof.raft-transport-bench/v1',
        generatedAt: new Date().toISOString(),
        git: { sha: git('rev-parse HEAD'), dirty: git('status --porcelain --untracked-files=no').length > 0 },
        node: process.version,
        powerThrottling: options['power-throttling'],
        cpu: os.cpus()[0].model,
        options: { ...options, out: undefined, serve: undefined },
        checks,
        rows,
        trials: records,
    };
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
    const md = `# Transport isolation\n\n${markdown(rows)}\n\nChecks: ${JSON.stringify(checks)}\n`;
    fs.writeFileSync(path.join(options.out, 'SUMMARY.md'), md);
    process.stdout.write(`\n${markdown(rows)}\n\nchecks: ${JSON.stringify(checks)}\n`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { answer };
