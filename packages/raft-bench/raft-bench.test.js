'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { fork } = require('node:child_process');
const test = require('node:test');

const { LogLinearHistogram } = require('../../replica/perf-histogram');
const { findKnee, summarizePoint } = require('./aggregate');
const { stability, STABILITY_RULE } = require('./run');
const { summarizeProfile, categoryWithContext } = require('./profile');
const { parseDuration } = require('./cli');

const WORKER = path.join(__dirname, 'loadgen-worker.js');

function runWorker(config) {
    return new Promise((resolve, reject) => {
        const child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
        let result = null;
        child.on('message', (message) => { if (message.type === 'result') result = message; });
        child.on('exit', () => (result ? resolve(result) : reject(new Error('worker produced no result'))));
        child.send({ type: 'start', config });
    });
}

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.keepAliveTimeout = 60000;
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

test('open-loop generator charges a server stall to every arrival it delays (no coordinated omission)', async () => {
    // The server answers instantly except during a 400 ms stall, when it holds
    // every request. A closed-loop client with 4 connections would record ~4
    // slow requests. An open-loop client at 200/s must record every arrival
    // scheduled during the stall as slow: ~80 of them.
    let stallUntil = 0;
    const held = [];
    const server = await listen((req, res) => {
        req.resume();
        req.on('end', () => {
            const respond = () => res.end('{"ok":true}');
            const now = Date.now();
            if (now < stallUntil) held.push(respond);
            else respond();
        });
    });
    const { port } = server.address();
    const startEpochMs = Date.now() + 300;
    const warmupMs = 200;
    const durationMs = 2000;
    // Stall 800..1200 ms into the measurement window.
    setTimeout(() => {
        stallUntil = Date.now() + 400;
        setTimeout(() => { for (const respond of held.splice(0)) respond(); }, 400);
    }, startEpochMs - Date.now() + warmupMs + 800);

    const result = await runWorker({
        target: `http://127.0.0.1:${port}`,
        ratePerSecond: 200,
        phaseMs: 0,
        connections: 4,
        payloadBytes: 16,
        keySpace: 10,
        warmupMs,
        durationMs,
        timeoutMs: 5000,
        drainMs: 3000,
        startEpochMs,
        workerIndex: 0,
        workers: 1,
    });
    server.close();

    assert.equal(result.counts.scheduled, 400, 'exactly rate x duration measured arrivals');
    assert.equal(result.counts.ok, 400);
    const latency = LogLinearHistogram.fromJSON(result.histograms.latencyAll);
    const slow = latency.fractionAbove(100 * 1000) * latency.count;
    assert.ok(slow >= 55, `expected ~80 arrivals charged >100 ms, got ${slow}`);
    assert.ok(latency.percentile(100) >= 380 * 1000, 'the first stalled arrival waited ~400 ms');
    const service = LogLinearHistogram.fromJSON(result.histograms.serviceOk);
    // Service time (from socket write) hides the queueing that end-to-end latency shows.
    assert.ok(service.fractionAbove(100 * 1000) * service.count < slow);
    const lag = LogLinearHistogram.fromJSON(result.histograms.generatorLag);
    assert.ok(lag.percentile(99) < 5000, `generator kept its schedule (p99 lag ${lag.percentile(99)} us)`);
});

test('timeouts enter the all-requests distribution at the timeout bound', async () => {
    const server = await listen((req) => { req.resume(); /* never answers */ });
    const { port } = server.address();
    const result = await runWorker({
        target: `http://127.0.0.1:${port}`,
        ratePerSecond: 400,
        phaseMs: 0,
        connections: 1,
        payloadBytes: 8,
        keySpace: 1,
        warmupMs: 0,
        durationMs: 50,
        timeoutMs: 300,
        drainMs: 1000,
        startEpochMs: Date.now() + 100,
        workerIndex: 0,
        workers: 1,
    });
    server.close();
    assert.equal(result.counts.scheduled, 20);
    assert.equal(result.counts.ok, 0);
    assert.equal(result.counts.timeoutsSent + result.counts.timeoutsUnsent, 20);
    // Several deadlines expire in one sweep, before a freed connection can be
    // handed to the next queued arrival, so those were never sent at all.
    assert.ok(result.counts.timeoutsUnsent > 0, 'arrivals that never got a connection are counted');
    const all = LogLinearHistogram.fromJSON(result.histograms.latencyAll);
    assert.equal(all.count, 20);
    assert.equal(all.min, 300000);
});

function fakeTrial({ rate, stable, achieved = rate, p99 = 5 }) {
    const h = new LogLinearHistogram();
    h.record(p99 * 1000);
    const leader = { cpuPercentOfOneCore: 50, cpuMicrosPerOp: 100, eventLoopUtilization: 0.5, eventLoopImmediateLagMs: null, rates: {}, stages: {}, memory: { peakRss: 1 } };
    return {
        runId: `r${rate}`,
        load: { offeredRate: rate },
        stability: { stable, reasons: stable ? [] : ['x'] },
        generator: { saturated: false },
        leadershipStable: true,
        achievedPerSec: achieved,
        achievedRatio: achieved / rate,
        errorRate: 0,
        latencyAllMs: { p99, p50: p99 },
        serviceOkMs: { p99 },
        clientQueueDepth: { p99: 0 },
        rawHistograms: { latencyAll: h.toJSON(), latencyOk: h.toJSON() },
        server: { leader, followers: [], clusterLogFsyncsPerSec: 1, clusterMetaSavesPerSec: 1, replicationBytesPerOp: 1, clientBytesPerOp: 1 },
    };
}

test('the knee is the top of the unbroken stable prefix, never a lucky point above a failure', () => {
    const point = (rate, votes) => summarizePoint([0, 1, 2].map((i) => fakeTrial({ rate, stable: i < votes })));
    const points = [point(100, 3), point(200, 2), point(400, 1), point(800, 3)];
    const knee = findKnee(points);
    assert.equal(knee.kneeRate, 200, '800 is stable but sits above an unstable 400');
    assert.equal(knee.firstUnstableRate, 400);
    assert.equal(findKnee([point(100, 1)]).kneeRate, null);
});

test('stability rule rejects shortfall, errors, tail latency and in-window growth', () => {
    const base = {
        achievedRatio: 1, errorRate: 0, latencyAllMs: { p99: 10 },
        latencyGrowth: { ratio: 1, lastFifthP50Ms: 5 },
    };
    assert.equal(stability(base).stable, true);
    assert.equal(stability({ ...base, achievedRatio: 0.9 }).stable, false);
    assert.equal(stability({ ...base, errorRate: 0.01 }).stable, false);
    assert.equal(stability({ ...base, latencyAllMs: { p99: STABILITY_RULE.maxP99AllMs } }).stable, false);
    assert.equal(stability({ ...base, latencyGrowth: { ratio: 3, lastFifthP50Ms: 60 } }).stable, false);
    assert.equal(stability({ ...base, latencyGrowth: { ratio: 3, lastFifthP50Ms: 6 } }).stable, true,
        'growth below the floor is noise, not overload');
});

test('native frames are categorized by their caller, so fs and socket writes are told apart', () => {
    const fsCaller = [{ url: 'node:fs', functionName: 'writeSync' }];
    const netCaller = [{ url: 'node:net', functionName: 'Socket._writeGeneric' }];
    assert.equal(categoryWithContext({ url: '', functionName: 'writeBuffer' }, fsCaller), 'fs-sync-io');
    assert.equal(categoryWithContext({ url: '', functionName: 'writeBuffer' }, netCaller), 'streams-net');
    assert.equal(categoryWithContext({ url: '', functionName: 'fsync' }, [{ url: 'D:/x/replica/raft.js', functionName: '_save' }]), 'fs-sync-io');
    assert.equal(categoryWithContext({ url: '', functionName: 'stringify' }, netCaller), 'json');

    const profile = {
        nodes: [
            { id: 1, callFrame: { functionName: '(root)', url: '', lineNumber: -1 }, children: [2, 3] },
            { id: 2, callFrame: { functionName: '(idle)', url: '', lineNumber: -1 }, children: [] },
            { id: 3, callFrame: { functionName: 'append', url: 'D:/p/replica/log-store.js', lineNumber: 150 }, children: [4] },
            { id: 4, callFrame: { functionName: 'fsync', url: '', lineNumber: -1 }, children: [] },
        ],
        samples: [2, 4, 4, 3],
        timeDeltas: [0, 100, 100, 100],
    };
    const summary = summarizeProfile(profile);
    const byCategory = Object.fromEntries(summary.categories.map((c) => [c.category, c.ms]));
    assert.equal(byCategory['fs-sync-io'], 0.2);
    assert.equal(byCategory['raft-log-store'], 0.1);
    assert.equal(summary.busyPercentOfWall, 75);
});

test('durations parse with units', () => {
    assert.equal(parseDuration('30s'), 30000);
    assert.equal(parseDuration('250ms'), 250);
    assert.equal(parseDuration('2m'), 120000);
    assert.equal(parseDuration('10'), 10000);
});
