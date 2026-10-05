'use strict';

/**
 * run.js — one benchmark trial, end to end.
 *
 *   fresh 3-replica cluster  ->  wait for a leader with a committed no-op
 *   fork G open-loop generator processes aimed at the leader
 *   warmup (excluded)        ->  reset every replica's /perf window
 *   measurement window       ->  collect every replica's /perf window
 *   drain in-flight requests ->  stop the cluster, delete its data
 *
 * The result is one canonical run record (see summarizeTrial). Raw worker
 * histograms are kept in the record so trials can be merged exactly later.
 */

const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { LocalCluster, sleep } = require('./cluster');
const { configEnv } = require('./configs');
const { LogLinearHistogram } = require('../../replica/perf-histogram');
const { probeDisk, sentinelRecord } = require('./disk-sentinel');
const { applyPolicy, PowerPolicyError } = require('./power-throttling');
const fs = require('fs');

const WORKER = path.join(__dirname, 'loadgen-worker.js');

/** Pre-registered stability rule. Changing it invalidates earlier sweeps. */
const STABILITY_RULE = Object.freeze({
    version: 1,
    minAchievedRatio: 0.98,
    maxErrorRate: 0.005,
    maxP99AllMs: 1000,
    maxLatencyGrowth: 2.0,
    latencyGrowthFloorMs: 20,
    text: 'A trial is stable iff (a) OK completions inside the window reach >= 98% of the offered rate, '
        + '(b) errors + timeouts <= 0.5% of measured arrivals, (c) end-to-end p99 over all measured '
        + 'arrivals (timeouts at the timeout bound) < 1000 ms, and (d) the median OK latency of the last '
        + 'fifth of the window is <= 2x that of the first fifth, unless that last-fifth median is <= 20 ms.',
});

function mergeHistograms(list) {
    const merged = new LogLinearHistogram();
    for (const json of list) merged.merge(LogLinearHistogram.fromJSON(json));
    return merged;
}

function summarizeHistogramJson(json, scale = 1000) {
    const histogram = LogLinearHistogram.fromJSON(json);
    return histogram.summary(histogram.unit === 'count' ? 1 : scale);
}

function forkWorker(config) {
    const child = fork(WORKER, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const done = new Promise((resolve, reject) => {
        let result = null;
        child.on('message', (message) => {
            if (message && message.type === 'result') result = message;
        });
        child.on('error', reject);
        child.on('exit', (code) => {
            if (result) resolve(result);
            else reject(new Error(`load generator ${config.workerIndex} exited with ${code} and no result`));
        });
    });
    return { child, done, start: (startConfig) => child.send({ type: 'start', config: { ...config, ...startConfig } }) };
}

/** Whole-machine CPU counters, summed over every logical core. */
function systemCpuTimes() {
    let busy = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
        const { user, nice, sys, irq, idle } = cpu.times;
        busy += user + nice + sys + irq;
        total += user + nice + sys + irq + idle;
    }
    return { busy, total };
}

function num(value, digits = 3) {
    return value === null || value === undefined || !Number.isFinite(value)
        ? null
        : Number(value.toFixed(digits));
}

function summarizeReplica(snapshot, windowSeconds, okOps) {
    const raft = snapshot.raft;
    const counter = (name) => raft.counters[name] || 0;
    const h = (name) => (raft.histograms[name] ? summarizeHistogramJson(raft.histograms[name]) : null);
    const cpuMicros = snapshot.cpu.userMicros + snapshot.cpu.systemMicros;
    return {
        replicaId: snapshot.replicaId,
        state: snapshot.state,
        term: snapshot.status.term,
        electionsTotal: snapshot.status.electionsTotal,
        cpuPercentOfOneCore: num(snapshot.cpu.percentOfOneCore, 1),
        cpuUserMicros: snapshot.cpu.userMicros,
        cpuSystemMicros: snapshot.cpu.systemMicros,
        cpuMicrosPerOp: okOps > 0 ? num(cpuMicros / okOps, 1) : null,
        eventLoopUtilization: num(snapshot.eventLoopUtilization, 3),
        eventLoopImmediateLagMs: raft.histograms['eventLoop.immediateLag']
            ? summarizeHistogramJson(raft.histograms['eventLoop.immediateLag'])
            : null,
        eventLoopDelayTimerMs: snapshot.eventLoopDelayMs,
        memory: snapshot.memory,
        net: snapshot.net,
        rates: {
            logFsyncsPerSec: num(counter('log.fsyncs') / windowSeconds, 1),
            metaSavesPerSec: num(counter('meta.saves') / windowSeconds, 1),
            appendEntriesPerSec: num(counter('rpc.appendEntriesSent') / windowSeconds, 1),
            heartbeatsPerSec: num(counter('rpc.heartbeatsSent') / windowSeconds, 1),
            logBytesPerSec: num(counter('log.bytesWritten') / windowSeconds, 0),
        },
        counters: raft.counters,
        stages: Object.fromEntries(Object.keys(raft.histograms).map((name) => [name, h(name)])),
    };
}

function stability(trial) {
    const rule = STABILITY_RULE;
    const reasons = [];
    if (trial.achievedRatio < rule.minAchievedRatio) reasons.push(`achieved ${num(trial.achievedRatio * 100, 1)}% of offered`);
    if (trial.errorRate > rule.maxErrorRate) reasons.push(`error rate ${num(trial.errorRate * 100, 2)}%`);
    const p99 = trial.latencyAllMs.p99;
    if (p99 === null || p99 >= rule.maxP99AllMs) reasons.push(`p99 ${p99} ms`);
    const growth = trial.latencyGrowth;
    if (growth.ratio !== null && growth.ratio > rule.maxLatencyGrowth && growth.lastFifthP50Ms > rule.latencyGrowthFloorMs) {
        reasons.push(`latency grew ${num(growth.ratio, 2)}x across the window`);
    }
    return { stable: reasons.length === 0, reasons, rule: rule.version };
}

async function runTrial({
    config = 'baseline',
    env: extraEnv = {},
    rate,
    payloadBytes = 1024,
    connections = 128,
    generators = 4,
    keySpace = 1000,
    warmupMs = 5000,
    durationMs = 20000,
    timeoutMs = 10000,
    drainMs = 12000,
    basePort = 17001,
    dataRoot,
    repetition = 0,
    profile = null,          // { intervalUs } -> CPU-profile the leader for the window
    // Process power policy for every process this trial starts, and for the
    // driver itself: 'os-default' (historical) or 'disabled' (amendment 2).
    powerThrottling = 'os-default',
    onProgress = () => {},
}) {
    if (!rate || rate <= 0) throw new Error('rate must be positive');
    const runId = crypto.randomBytes(6).toString('hex');
    const env = { ...configEnv(config), ...extraEnv };
    const cluster = new LocalCluster({ basePort, dataRoot, env, label: config, powerThrottling });
    const startedAt = new Date().toISOString();
    // Disk-regime covariate (methodology amendment 1): sampled immediately
    // before the cluster starts, with nothing else of the benchmark running.
    const sentinelDir = path.join(dataRoot, 'sentinel');
    const diskBefore = await probeDisk(sentinelDir);
    let windowOpenedAt = null;
    let leader;
    let workers = [];
    let record = null;
    let cpuProfile = null;
    let powerPolicy = null;
    let workerChildren = [];
    try {
        leader = await cluster.start();
        // Let the post-election heartbeat cadence settle.
        await sleep(500);
        const perWorkerRate = rate / generators;
        const perWorkerConnections = Math.max(1, Math.round(connections / generators));
        const forked = Array.from({ length: generators }, (_, workerIndex) => forkWorker({
            target: cluster.leaderUrl,
            ratePerSecond: perWorkerRate,
            phaseMs: (workerIndex * 1000) / rate,
            connections: perWorkerConnections,
            payloadBytes,
            keySpace,
            warmupMs,
            durationMs,
            timeoutMs,
            drainMs,
            workerIndex,
            workers: generators,
        }));
        workers = forked.map((w) => w.done);
        workerChildren = forked.map((w) => w.child);
        // The same policy for the generators and the driver, verified before
        // any load is offered; the replicas got theirs at cluster start.
        const others = applyPolicy(powerThrottling, [
            ...forked.map((w, i) => ({ role: `loadgen${i + 1}`, pid: w.child.pid })),
            { role: 'driver', pid: process.pid },
        ]);
        powerPolicy = { ...others, processes: [...cluster.powerPolicy.processes, ...others.processes] };
        const startEpochMs = Date.now() + 750;
        for (const w of forked) w.start({ startEpochMs });

        const windowStartDelay = startEpochMs + warmupMs - Date.now();
        await sleep(Math.max(0, windowStartDelay));
        await cluster.resetPerf();
        windowOpenedAt = new Date().toISOString();
        const systemAtOpen = systemCpuTimes();
        if (profile) await cluster.startProfile(cluster.leaderUrl, profile.intervalUs || 250);
        onProgress({ phase: 'window-open', runId });
        await sleep(Math.max(0, startEpochMs + warmupMs + durationMs - Date.now()));
        const systemAtClose = systemCpuTimes();
        if (profile) cpuProfile = await cluster.stopProfile(cluster.leaderUrl);
        const serverSnapshots = await cluster.collectPerf();
        const systemCpu = {
            logicalCores: os.cpus().length,
            busyPercentAllCores: num(((systemAtClose.busy - systemAtOpen.busy)
                / Math.max(1, systemAtClose.total - systemAtOpen.total)) * 100, 1),
        };
        const statusesAtEnd = await cluster.statuses();
        onProgress({ phase: 'window-closed', runId });
        const results = await Promise.all(workers);
        const diskBytes = cluster.diskUsage();

        record = summarizeTrial({
            runId, config, env, rate, payloadBytes, connections, generators, keySpace,
            warmupMs, durationMs, timeoutMs, repetition, startedAt,
            leader, statusesAtEnd, results, serverSnapshots, diskBytes, systemCpu,
        });
    } catch (error) {
        // A policy that could not be applied is not a result: the benchmark
        // stops instead of running a mixed environment.
        if (error instanceof PowerPolicyError) {
            for (const child of workerChildren) child.kill();
            await Promise.allSettled(workers);
            await cluster.stop();
            throw error;
        }
        // A replica that dies, or a cluster that never elects a leader, is a
        // result, not a harness crash: it is recorded as a failed, unstable
        // trial, with the replica logs kept for diagnosis.
        const exited = await Promise.all(cluster.processes.map(async (child, index) => ({
            replica: `replica${index + 1}`,
            exitCode: child ? child.exitCode : null,
            signal: child ? child.signalCode : null,
        })));
        await Promise.allSettled(workers);
        const keptLogs = path.join(dataRoot, '..', 'failed-trials', runId);
        try {
            fs.mkdirSync(keptLogs, { recursive: true });
            fs.cpSync(cluster.logRoot, keptLogs, { recursive: true });
        } catch (_) { /* best effort */ }
        record = failedTrial({
            runId, config, env, rate, payloadBytes, connections, generators, keySpace,
            warmupMs, durationMs, timeoutMs, repetition, startedAt, leader,
            error, exited, keptLogs,
        });
    } finally {
        await cluster.stop();
    }
    const diskAfter = await probeDisk(sentinelDir);
    record.diskSentinel = sentinelRecord(diskBefore, diskAfter, { windowOpenedAt });
    record.harness = { controlRetries: cluster.controlRetries };
    record.powerThrottling = powerPolicy || { requested: powerThrottling, applied: false, note: 'trial failed before the policy was applied' };
    return { record, cpuProfile };
}

function failedTrial({
    runId, config, env, rate, payloadBytes, connections, generators, keySpace,
    warmupMs, durationMs, timeoutMs, repetition, startedAt, leader, error, exited, keptLogs,
}) {
    const empty = new LogLinearHistogram().toJSON();
    const nulls = new LogLinearHistogram().summary(1000);
    return {
        schema: 'cloudproof.raft-bench.trial/v1',
        runId,
        startedAt,
        config,
        env,
        repetition,
        failed: true,
        failure: { message: error.message, replicas: exited, logs: keptLogs },
        workload: { payloadBytes, keySpace },
        load: { offeredRate: rate, connections, generators, warmupMs, durationMs, timeoutMs },
        leader: leader ? { replicaId: leader.replicaId, term: leader.term } : null,
        leadershipStable: false,
        scheduled: 0,
        ok: 0,
        offeredPerSec: rate,
        achievedPerSec: 0,
        achievedRatio: 0,
        errorRate: 1,
        errors: { total: null },
        latencyAllMs: nulls,
        latencyOkMs: nulls,
        serviceOkMs: nulls,
        clientQueueDepth: new LogLinearHistogram().summary(1),
        latencyGrowth: { firstFifthP50Ms: null, lastFifthP50Ms: null, ratio: null },
        generator: { lagMs: nulls, cpu: [], saturated: false },
        server: { leader: null, followers: [], replicationBytesPerOp: null, clientBytesPerOp: null,
            clusterLogFsyncsPerSec: null, clusterMetaSavesPerSec: null },
        perSecond: [],
        rawHistograms: { latencyAll: empty, latencyOk: empty },
        stability: { stable: false, reasons: [`trial failed: ${error.message}`], rule: STABILITY_RULE.version },
    };
}

function summarizeTrial({
    runId, config, env, rate, payloadBytes, connections, generators, keySpace,
    warmupMs, durationMs, timeoutMs, repetition, startedAt,
    leader, statusesAtEnd, results, serverSnapshots, diskBytes, systemCpu = null,
}) {
    const windowSeconds = durationMs / 1000;
    const sum = (field) => results.reduce((total, r) => total + r.counts[field], 0);
    const mergeCounts = (field) => {
        const merged = {};
        for (const r of results) {
            for (const [key, value] of Object.entries(r.counts[field])) merged[key] = (merged[key] || 0) + value;
        }
        return merged;
    };
    const histogram = (name) => mergeHistograms(results.map((r) => r.histograms[name]));

    const scheduled = sum('scheduled');
    const ok = sum('ok');
    const httpErrors = mergeCounts('httpErrors');
    const networkErrors = mergeCounts('networkErrors');
    const timeoutsSent = sum('timeoutsSent');
    const timeoutsUnsent = sum('timeoutsUnsent');
    const errorCount = Object.values(httpErrors).reduce((a, b) => a + b, 0)
        + Object.values(networkErrors).reduce((a, b) => a + b, 0)
        + timeoutsSent + timeoutsUnsent;
    const okCompletedInWindow = sum('okCompletedInWindow');

    const latencyAll = histogram('latencyAll');
    const latencyOk = histogram('latencyOk');
    const firstFifth = histogram('firstFifthOk');
    const lastFifth = histogram('lastFifthOk');
    const firstP50 = firstFifth.percentile(50);
    const lastP50 = lastFifth.percentile(50);

    const perSecond = [];
    for (const r of results) {
        r.perSecond.forEach((bucket, second) => {
            if (!bucket) return;
            const target = perSecond[second] || (perSecond[second] = { second, ok: 0, errors: 0, sumLatencyUs: 0, maxLatencyUs: 0 });
            target.ok += bucket.ok;
            target.errors += bucket.errors;
            target.sumLatencyUs += bucket.sumLatencyUs;
            target.maxLatencyUs = Math.max(target.maxLatencyUs, bucket.maxLatencyUs);
        });
    }

    const generatorCpu = results.map((r) => ({
        worker: r.workerIndex,
        percentOfOneCore: num(((r.cpu.userMicros + r.cpu.systemMicros) / 1000 / r.cpu.wallMs) * 100, 1),
    }));
    const generatorLag = histogram('generatorLag').summary(1000);

    const replicas = serverSnapshots.map((snapshot) => summarizeReplica(snapshot, windowSeconds, okCompletedInWindow));
    const leaderAtEnd = statusesAtEnd.filter((s) => s.state === 'LEADER');
    const leaderSnapshot = replicas.find((r) => r.state === 'LEADER') || null;
    const followerSnapshots = replicas.filter((r) => r.state !== 'LEADER');
    const replicationBytes = followerSnapshots.reduce((total, r) => total + r.net.inboundRead + r.net.inboundWritten, 0);
    const clientBytes = leaderSnapshot ? leaderSnapshot.net.inboundRead + leaderSnapshot.net.inboundWritten : null;

    const trial = {
        schema: 'cloudproof.raft-bench.trial/v1',
        runId,
        startedAt,
        config,
        env,
        repetition,
        workload: {
            operation: 'PUT /kv/:key {"value": <payloadBytes ASCII>} (op=set, no clientId/seqNo)',
            payloadBytes,
            keySpace,
            arrival: 'open-loop, constant spacing (1/rate), interleaved across generator processes',
        },
        load: { offeredRate: rate, connections, generators, warmupMs, durationMs, timeoutMs },
        leader: { replicaId: leader.replicaId, term: leader.term },
        leadershipStable: leaderAtEnd.length === 1 && leaderAtEnd[0].replicaId === leader.replicaId
            && leaderAtEnd[0].term === leader.term,
        scheduled,
        ok,
        offeredPerSec: num(scheduled / windowSeconds, 1),
        achievedPerSec: num(okCompletedInWindow / windowSeconds, 1),
        achievedRatio: scheduled > 0 ? okCompletedInWindow / scheduled : 0,
        errorRate: scheduled > 0 ? errorCount / scheduled : 0,
        errors: { http: httpErrors, network: networkErrors, timeoutsSent, timeoutsUnsent, total: errorCount },
        latencyAllMs: latencyAll.summary(1000),
        latencyOkMs: latencyOk.summary(1000),
        serviceOkMs: histogram('serviceOk').summary(1000),
        clientQueueWaitMs: histogram('clientQueueWait').summary(1000),
        clientQueueDepth: histogram('clientQueueDepth').summary(1),
        clientInflight: histogram('clientInflight').summary(1),
        latencyGrowth: {
            firstFifthP50Ms: firstP50 === null ? null : firstP50 / 1000,
            lastFifthP50Ms: lastP50 === null ? null : lastP50 / 1000,
            ratio: firstP50 && lastP50 ? lastP50 / firstP50 : null,
        },
        generator: {
            lagMs: generatorLag,
            cpu: generatorCpu,
            // A generator that cannot keep its own schedule would inflate
            // latency with its own delay. Flagged, never silently accepted.
            saturated: generatorLag.p99 !== null && generatorLag.p99 > 5,
        },
        server: {
            leader: leaderSnapshot,
            followers: followerSnapshots,
            replicationBytesPerOp: okCompletedInWindow > 0 ? num(replicationBytes / okCompletedInWindow, 1) : null,
            clientBytesPerOp: okCompletedInWindow > 0 && clientBytes !== null ? num(clientBytes / okCompletedInWindow, 1) : null,
            clusterLogFsyncsPerSec: num(replicas.reduce((t, r) => t + (r.rates.logFsyncsPerSec || 0), 0), 1),
            clusterMetaSavesPerSec: num(replicas.reduce((t, r) => t + (r.rates.metaSavesPerSec || 0), 0), 1),
            diskBytesAtEnd: diskBytes,
        },
        // Everything on the machine, including the cluster and generators;
        // other applications show up as the remainder.
        systemCpu,
        perSecond: perSecond.filter(Boolean).map((b) => ({
            second: b.second,
            ok: b.ok,
            errors: b.errors,
            meanLatencyMs: b.ok ? num(b.sumLatencyUs / b.ok / 1000, 3) : null,
            maxLatencyMs: num(b.maxLatencyUs / 1000, 3),
        })),
        rawHistograms: {
            latencyAll: latencyAll.toJSON(),
            latencyOk: latencyOk.toJSON(),
        },
    };
    trial.stability = stability(trial);
    return trial;
}

module.exports = { runTrial, summarizeTrial, stability, STABILITY_RULE, mergeHistograms, summarizeHistogramJson };
