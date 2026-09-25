'use strict';

/**
 * perf-service.js — process-level measurement endpoints for benchmarking.
 *
 * Mounted only when RAFT_PERF=1. None of it participates in consensus; it
 * samples the process from the outside of the Raft engine:
 *
 *   GET  /perf                  one JSON window: Raft stage histograms, CPU,
 *                               memory, event-loop delay, socket bytes, gauges
 *   POST /perf/reset            starts a new window (used to exclude warmup)
 *   POST /perf/profile/start    starts a V8 CPU profile through the inspector
 *   POST /perf/profile/stop     stops it and returns the .cpuprofile JSON
 *
 * Socket bytes are counted at the TCP layer (net.Socket bytesRead/Written), so
 * they include HTTP headers and framing, and they work the same way for every
 * transport. Inbound sockets are the HTTP server's; outbound sockets are the
 * ones Node's global HTTP agent (used by axios) creates, plus any a transport
 * registers through `trackSocket`.
 */

const http = require('http');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

class SocketAccounting {
    constructor() {
        this.live = new Map(); // socket -> direction
        this.closed = { inbound: { read: 0, written: 0 }, outbound: { read: 0, written: 0 } };
        this.baseline = { inbound: { read: 0, written: 0 }, outbound: { read: 0, written: 0 } };
        this.opened = { inbound: 0, outbound: 0 };
    }

    track(socket, direction) {
        if (this.live.has(socket)) return;
        this.live.set(socket, direction);
        this.opened[direction] += 1;
        socket.once('close', () => {
            this.closed[direction].read += socket.bytesRead;
            this.closed[direction].written += socket.bytesWritten;
            this.live.delete(socket);
        });
    }

    totals() {
        const totals = {
            inbound: { ...this.closed.inbound },
            outbound: { ...this.closed.outbound },
        };
        for (const [socket, direction] of this.live) {
            totals[direction].read += socket.bytesRead;
            totals[direction].written += socket.bytesWritten;
        }
        return totals;
    }

    reset() {
        this.baseline = this.totals();
        this.opened = { inbound: 0, outbound: 0 };
    }

    window() {
        const now = this.totals();
        const delta = (direction, field) => now[direction][field] - this.baseline[direction][field];
        return {
            inboundRead: delta('inbound', 'read'),
            inboundWritten: delta('inbound', 'written'),
            outboundRead: delta('outbound', 'read'),
            outboundWritten: delta('outbound', 'written'),
            socketsOpened: { ...this.opened },
            socketsLive: this.live.size,
        };
    }
}

function histogramFromDelay(delay) {
    // monitorEventLoopDelay reports nanoseconds.
    const ms = (ns) => (Number.isFinite(ns) ? ns / 1e6 : null);
    return {
        count: delay.count,
        min: ms(delay.min),
        mean: ms(delay.mean),
        p50: ms(delay.percentile(50)),
        p90: ms(delay.percentile(90)),
        p99: ms(delay.percentile(99)),
        p999: ms(delay.percentile(99.9)),
        max: ms(delay.max),
    };
}

function createPerfService({ raft, perf, replicaId, sampleIntervalMs = 50 }) {
    const sockets = new SocketAccounting();
    // Kept for completeness, but on Windows it inherits the coarse timer
    // quantum (an idle loop reports ~10 ms), so the two probes below are the
    // ones the benchmark reports:
    //   - event-loop utilization: fraction of wall time the loop was busy
    //   - immediate lag: time from queueing a setImmediate to it running,
    //     i.e. how long an I/O callback that just became ready waits for the
    //     rest of the current loop iteration. Independent of timer precision.
    const loopDelay = monitorEventLoopDelay({ resolution: 10 });
    loopDelay.enable();
    let eluBaseline = performance.eventLoopUtilization();
    const immediateLagProbe = setInterval(() => {
        const queuedAt = perf.now();
        setImmediate(() => perf.observeMs('eventLoop.immediateLag', perf.now() - queuedAt));
    }, 20);
    immediateLagProbe.unref();

    // Outbound HTTP (axios -> Node's global agent).
    const agent = http.globalAgent;
    const originalCreateConnection = agent.createConnection;
    agent.createConnection = function createConnection(...args) {
        const socket = originalCreateConnection.apply(this, args);
        if (socket) sockets.track(socket, 'outbound');
        return socket;
    };

    let httpInflight = 0;
    let cpuBaseline = process.cpuUsage();
    let wallBaseline = perf.now();
    let peakRss = process.memoryUsage().rss;

    const sampler = setInterval(() => {
        const rss = process.memoryUsage().rss;
        if (rss > peakRss) peakRss = rss;
        perf.observeValue('gauge.httpInflight', httpInflight);
        if (raft.isLeader()) {
            perf.observeValue('gauge.uncommittedEntries', raft.log.length - 1 - raft.commitIndex);
        }
    }, sampleIntervalMs);
    sampler.unref();

    let profilerSession = null;

    function reset() {
        perf.reset();
        sockets.reset();
        loopDelay.reset();
        eluBaseline = performance.eventLoopUtilization();
        cpuBaseline = process.cpuUsage();
        wallBaseline = perf.now();
        peakRss = process.memoryUsage().rss;
    }

    function snapshot() {
        const cpu = process.cpuUsage(cpuBaseline);
        const wallMs = perf.now() - wallBaseline;
        const memory = process.memoryUsage();
        return {
            replicaId,
            pid: process.pid,
            capturedAt: new Date().toISOString(),
            state: raft.getStatus().state,
            status: raft.getStatus(),
            windowMs: wallMs,
            cpu: {
                userMicros: cpu.user,
                systemMicros: cpu.system,
                // Percent of ONE core over the window. Node runs JavaScript on
                // one thread; >100% means libuv/GC/threadpool work in parallel.
                percentOfOneCore: wallMs > 0 ? ((cpu.user + cpu.system) / 1000 / wallMs) * 100 : null,
            },
            memory: {
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                heapTotal: memory.heapTotal,
                external: memory.external,
                peakRss,
            },
            eventLoopUtilization: performance.eventLoopUtilization(eluBaseline).utilization,
            eventLoopDelayMs: histogramFromDelay(loopDelay),
            net: sockets.window(),
            storage: {
                logFsyncsTotal: raft._logStore ? raft._logStore.fsyncCount : null,
                logAppendsTotal: raft._logStore ? raft._logStore.appendCount : null,
                metaSavesTotal: raft._store ? raft._store.saveCount : null,
            },
            raft: perf.snapshot(),
        };
    }

    function mount(app) {
        app.get('/perf', (_req, res) => res.json(snapshot()));
        app.post('/perf/reset', (_req, res) => {
            reset();
            res.json({ ok: true, replicaId });
        });
        app.post('/perf/profile/start', (req, res) => {
            if (profilerSession) return res.status(409).json({ error: 'profile already running' });
            // Loaded lazily: the inspector is only needed when someone profiles.
            // eslint-disable-next-line global-require
            const inspector = require('inspector');
            profilerSession = new inspector.Session();
            profilerSession.connect();
            const interval = Number(req.query.intervalUs) || 250;
            profilerSession.post('Profiler.enable', () => {
                profilerSession.post('Profiler.setSamplingInterval', { interval }, () => {
                    profilerSession.post('Profiler.start', (error) => {
                        if (error) return res.status(500).json({ error: error.message });
                        return res.json({ ok: true, replicaId, samplingIntervalUs: interval });
                    });
                });
            });
            return undefined;
        });
        app.post('/perf/profile/stop', (_req, res) => {
            if (!profilerSession) return res.status(409).json({ error: 'no profile running' });
            const session = profilerSession;
            profilerSession = null;
            session.post('Profiler.stop', (error, result) => {
                session.disconnect();
                if (error) return res.status(500).json({ error: error.message });
                return res.json({ replicaId, profile: result.profile });
            });
            return undefined;
        });
    }

    function attachServer(server) {
        server.on('connection', (socket) => sockets.track(socket, 'inbound'));
    }

    /** First middleware: stamps arrival before the body is read or parsed. */
    function arrivalMiddleware(req, res, next) {
        req.perfArrivalAt = perf.now();
        httpInflight += 1;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            httpInflight -= 1;
        };
        res.once('finish', finish);
        res.once('close', finish);
        next();
    }

    return {
        mount,
        attachServer,
        arrivalMiddleware,
        trackSocket: (socket, direction) => sockets.track(socket, direction),
        reset,
        snapshot,
    };
}

module.exports = { createPerfService, SocketAccounting };
