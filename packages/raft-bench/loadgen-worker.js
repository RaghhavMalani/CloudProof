'use strict';

/**
 * loadgen-worker.js — one open-loop load-generator process.
 *
 * ── Why open loop ────────────────────────────────────────────────────────────
 * A closed-loop client (send, wait, send the next) slows down exactly when the
 * system does, so it never offers more load than the system can absorb and it
 * never records the delay a real arrival would have suffered while the client
 * was stuck waiting. That is coordinated omission: the benchmark stops asking
 * during the stall and therefore never measures it.
 *
 * Here arrivals are fixed in advance. Request k is *intended* to arrive at
 * `startAt + phase + k * interval`, whatever happened to request k-1. Latency is
 * measured from that intended time, so time spent queued in this client
 * because every connection was busy counts against the system, as it would for
 * a real caller. Four timestamps are kept per request:
 *
 *   scheduledAt   intended arrival (the open-loop schedule)
 *   dispatchedAt  when this process got to it (generator lag = dispatched - scheduled)
 *   sentAt        when a connection was assigned and the request written
 *   completedAt   when the full response arrived
 *
 *   end-to-end latency = completedAt - scheduledAt   (reported as `latencyAll` / `latencyOk`)
 *   service latency    = completedAt - sentAt        (reported as `serviceOk`)
 *
 * A request that has no response `timeoutMs` after its intended arrival is
 * abandoned and counted as a timeout; it enters `latencyAll` at exactly
 * `timeoutMs`, a lower bound, so overload cannot hide in a missing sample.
 *
 * The parent sends one `start` message and receives one `result` message.
 */

const http = require('http');
const { performance } = require('perf_hooks');
const { LogLinearHistogram } = require('../../replica/perf-histogram');

function makeValue(bytes, seed) {
    // Deterministic, incompressible-looking ASCII so every run writes the same
    // bytes; JSON-safe (no quotes or backslashes).
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let x = (seed >>> 0) || 1;
    let out = '';
    for (let i = 0; i < bytes; i += 1) {
        x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
        out += alphabet[x & 63];
    }
    return out;
}

/**
 * Wire format of one write, per target system. Both store the same key
 * (k<i>) and the same value bytes; only the request differs.
 *
 *   cloudproof-kv  PUT <prefix>k<i>   {"value": "<value>"}
 *   etcd-v3-json   POST /v3/kv/put    {"key": base64(k<i>), "value": base64(<value>)}
 *
 * etcd's HTTP/JSON gateway carries protobuf `bytes` fields as base64, so its
 * body is about a third larger for the same stored value (disclosed in
 * methodology amendment 4). Bodies are built once, never per request.
 * Returns keyIndex -> { method, path, body }.
 */
function requestBuilder({ protocol = 'cloudproof-kv', routePrefix = '/kv/', value, keySpace }) {
    if (protocol === 'cloudproof-kv') {
        const body = Buffer.from(JSON.stringify({ value }), 'utf8');
        return (keyIndex) => ({ method: 'PUT', path: `${routePrefix}k${keyIndex}`, body });
    }
    if (protocol === 'etcd-v3-json') {
        const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
        const valueB64 = b64(value);
        const requests = Array.from({ length: keySpace }, (_, keyIndex) => ({
            method: 'POST',
            path: '/v3/kv/put',
            body: Buffer.from(JSON.stringify({ key: b64(`k${keyIndex}`), value: valueB64 }), 'utf8'),
        }));
        return (keyIndex) => requests[keyIndex];
    }
    throw new Error(`unknown load-generator protocol ${protocol}`);
}

function run(config) {
    const {
        target,              // e.g. http://127.0.0.1:17001
        ratePerSecond,       // this worker's share of the offered rate
        phaseMs,             // offset of this worker's first arrival
        connections,         // keep-alive sockets owned by this worker
        payloadBytes,        // size of the value field
        keySpace,
        warmupMs,
        durationMs,
        timeoutMs,
        drainMs,
        startEpochMs,        // shared wall-clock start, so workers line up
        workerIndex,
        workers,
        path: routePrefix = '/kv/',
        protocol = 'cloudproof-kv',
        precisionSpinMs = 17,
    } = config;

    const url = new URL(target);
    const agent = new http.Agent({
        keepAlive: true,
        maxSockets: connections,
        maxFreeSockets: connections,
        scheduling: 'fifo',
    });
    const value = makeValue(payloadBytes, 0x9e3779b9);
    const requestFor = requestBuilder({ protocol, routePrefix, value, keySpace });
    const intervalMs = 1000 / ratePerSecond;
    const totalMs = warmupMs + durationMs;
    const windowStart = warmupMs;
    const windowEnd = warmupMs + durationMs;

    const hist = {
        latencyAll: new LogLinearHistogram(),
        latencyOk: new LogLinearHistogram(),
        latencyError: new LogLinearHistogram(),
        serviceOk: new LogLinearHistogram(),
        generatorLag: new LogLinearHistogram(),
        clientQueueWait: new LogLinearHistogram(),
        firstFifthOk: new LogLinearHistogram(),
        lastFifthOk: new LogLinearHistogram(),
        clientQueueDepth: new LogLinearHistogram({ unit: 'count' }),
        clientInflight: new LogLinearHistogram({ unit: 'count' }),
    };
    const counts = {
        scheduled: 0,         // measured-window arrivals
        scheduledWarmup: 0,
        ok: 0,
        httpErrors: {},       // status -> count
        networkErrors: {},    // code -> count
        timeoutsSent: 0,
        timeoutsUnsent: 0,
        // Connection attempts that failed before the request reached the
        // server and were retried after a backoff (see sendRecord).
        connectRetries: 0,
        completedInWindow: 0, // any response whose completion falls in the window
        okCompletedInWindow: 0,
        bytesRequestBody: 0,
    };
    const perSecond = []; // [second] -> { ok, errors, sumLatencyUs, maxLatencyUs }

    // Requests in dispatch order; deadlines are monotonic in that order, so a
    // front-to-back sweep expires them in O(expired).
    const inflight = new Map();
    let queued = 0;           // dispatched, no socket yet
    let sent = 0;             // on a socket, awaiting response
    let nextArrival = 0;
    let sequence = 0;
    let t0 = 0;               // performance.now() at the shared start
    let schedulingDone = false;
    let finished = false;

    const relative = () => performance.now() - t0;

    function secondBucket(ms) {
        const second = Math.floor((ms - windowStart) / 1000);
        if (second < 0 || ms >= windowEnd) return null;
        if (!perSecond[second]) perSecond[second] = { ok: 0, errors: 0, sumLatencyUs: 0, maxLatencyUs: 0 };
        return perSecond[second];
    }

    function complete(record, outcome, status) {
        if (record.done) return;
        record.done = true;
        inflight.delete(record.id);
        const completedAt = relative();
        if (record.sentAt === null) queued -= 1; else sent -= 1;

        const inWindow = completedAt >= windowStart && completedAt < windowEnd;
        if (inWindow) {
            counts.completedInWindow += 1;
            if (outcome === 'ok') counts.okCompletedInWindow += 1;
        }
        if (!record.measured) return;

        if (outcome === 'timeout') {
            hist.latencyAll.record(timeoutMs * 1000);
            if (record.sentAt === null) counts.timeoutsUnsent += 1; else counts.timeoutsSent += 1;
            const bucket = secondBucket(record.scheduledAt);
            if (bucket) bucket.errors += 1;
            return;
        }

        const latencyUs = (completedAt - record.scheduledAt) * 1000;
        hist.latencyAll.record(latencyUs);
        const bucket = secondBucket(record.scheduledAt);
        if (outcome === 'ok') {
            counts.ok += 1;
            hist.latencyOk.record(latencyUs);
            hist.serviceOk.record((completedAt - record.sentAt) * 1000);
            const offset = record.scheduledAt - windowStart;
            if (offset < durationMs / 5) hist.firstFifthOk.record(latencyUs);
            else if (offset >= (durationMs * 4) / 5) hist.lastFifthOk.record(latencyUs);
            if (bucket) {
                bucket.ok += 1;
                bucket.sumLatencyUs += latencyUs;
                if (latencyUs > bucket.maxLatencyUs) bucket.maxLatencyUs = latencyUs;
            }
        } else {
            hist.latencyError.record(latencyUs);
            if (outcome === 'http') counts.httpErrors[status] = (counts.httpErrors[status] || 0) + 1;
            else counts.networkErrors[status] = (counts.networkErrors[status] || 0) + 1;
            if (bucket) bucket.errors += 1;
        }
    }

    // Connection-establishment failures (the server refused, or this machine
    // ran out of local ports) mean the request never reached the server, so
    // it is safe to retry, and retrying at once only feeds a connect storm.
    // Such a request stays queued in the client and is re-sent after a
    // per-worker exponential backoff (10 ms doubling to 1 s, reset by any
    // response); its latency is still charged from its intended arrival, and
    // past its deadline it is a timeout like any other.
    const CONNECT_ERRORS = new Set(['ECONNREFUSED', 'EADDRINUSE', 'EADDRNOTAVAIL']);
    let connectBackoffMs = 0;

    function sendRecord(record, request) {
        const req = http.request({
            agent,
            host: url.hostname,
            port: url.port,
            method: request.method,
            path: request.path,
            headers: { 'content-type': 'application/json', 'content-length': request.body.length },
        });
        record.req = req;
        const markSent = () => {
            if (record.done || record.sentAt !== null) return;
            record.sentAt = relative();
            queued -= 1;
            sent += 1;
            if (record.measured) hist.clientQueueWait.record((record.sentAt - record.dispatchedAt) * 1000);
        };
        req.on('socket', (socket) => {
            if (socket.connecting) socket.once('connect', markSent);
            else markSent();
        });
        req.on('response', (res) => {
            connectBackoffMs = 0;
            res.resume();
            res.on('end', () => {
                if (record.sentAt === null) markSent();
                const ok = res.statusCode >= 200 && res.statusCode < 300;
                complete(record, ok ? 'ok' : 'http', res.statusCode);
            });
            res.on('error', () => complete(record, 'network', 'ERESPONSE'));
        });
        req.on('error', (error) => {
            if (record.done) return;
            if (record.sentAt === null && CONNECT_ERRORS.has(error.code)) {
                connectBackoffMs = Math.min(1000, Math.max(10, connectBackoffMs * 2));
                counts.connectRetries += 1;
                setTimeout(() => {
                    if (!record.done && relative() < record.deadline) sendRecord(record, request);
                }, connectBackoffMs);
                return;
            }
            complete(record, 'network', error.code || 'ERROR');
        });
        req.end(request.body);
    }

    function dispatch(k) {
        const scheduledAt = phaseMs + k * intervalMs;
        const dispatchedAt = relative();
        const measured = scheduledAt >= windowStart && scheduledAt < windowEnd;
        if (measured) {
            counts.scheduled += 1;
            hist.generatorLag.record((dispatchedAt - scheduledAt) * 1000);
        } else {
            counts.scheduledWarmup += 1;
        }
        const globalIndex = k * workers + workerIndex;
        const record = {
            id: sequence += 1,
            scheduledAt,
            dispatchedAt,
            deadline: scheduledAt + timeoutMs,
            sentAt: null,
            measured,
            done: false,
            req: null,
        };
        inflight.set(record.id, record);
        queued += 1;
        const request = requestFor(globalIndex % keySpace);
        sendRecord(record, request);
        if (measured) counts.bytesRequestBody += request.body.length;
    }

    function sweepDeadlines() {
        const now = relative();
        for (const record of inflight.values()) {
            if (record.deadline > now) break;
            complete(record, 'timeout');
            record.req.destroy();
        }
    }

    function sampleGauges() {
        const now = relative();
        if (now >= windowStart && now < windowEnd) {
            hist.clientQueueDepth.record(queued);
            hist.clientInflight.record(sent);
        }
    }

    const sweeper = setInterval(sweepDeadlines, 20);
    const gaugeSampler = setInterval(sampleGauges, 50);

    function pump() {
        if (schedulingDone) return;
        const now = relative();
        while (nextArrival * intervalMs + phaseMs <= now) {
            const scheduledAt = phaseMs + nextArrival * intervalMs;
            if (scheduledAt >= totalMs) { schedulingDone = true; break; }
            dispatch(nextArrival);
            nextArrival += 1;
        }
        if (schedulingDone || phaseMs + nextArrival * intervalMs >= totalMs) {
            schedulingDone = true;
            drain();
            return;
        }
        const wait = phaseMs + nextArrival * intervalMs - relative();
        // Timers are coarse (and on Windows can overshoot by a full scheduler
        // tick), so the last couple of milliseconds are covered by yielding
        // with setImmediate instead of sleeping. Generator lag is recorded, so
        // if this ever falls behind the report says so.
        if (wait > precisionSpinMs) setTimeout(pump, wait - precisionSpinMs);
        else setImmediate(pump);
    }

    function drain() {
        const deadline = performance.now() + Math.max(drainMs, 0);
        const check = () => {
            if (inflight.size === 0 || performance.now() >= deadline) {
                for (const record of inflight.values()) {
                    complete(record, 'timeout');
                    record.req.destroy();
                }
                finish();
                return;
            }
            setTimeout(check, 20);
        };
        check();
    }

    function finish() {
        if (finished) return;
        finished = true;
        clearInterval(sweeper);
        clearInterval(gaugeSampler);
        agent.destroy();
        const cpu = process.cpuUsage(cpuAtStart);
        process.send({
            type: 'result',
            workerIndex,
            cpu: { userMicros: cpu.user, systemMicros: cpu.system, wallMs: relative() },
            counts,
            perSecond,
            histograms: Object.fromEntries(Object.entries(hist).map(([name, h]) => [name, h.toJSON()])),
            dispatched: nextArrival,
        }, () => process.exit(0));
    }

    let cpuAtStart = process.cpuUsage();
    const startDelay = startEpochMs - Date.now();
    setTimeout(() => {
        t0 = performance.now();
        cpuAtStart = process.cpuUsage();
        pump();
    }, Math.max(0, startDelay));
}

if (require.main === module) {
    process.on('message', (message) => {
        if (message && message.type === 'start') run(message.config);
    });
}

module.exports = { makeValue, requestBuilder };
