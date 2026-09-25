'use strict';

/**
 * aggregate.js — turns raw trial records into saturation curves.
 *
 * Nothing here chooses a "best" trial. Every repetition at a point is kept;
 * latency percentiles for a point are computed from the *merged* histograms of
 * all its repetitions (pooled), and the spread across repetitions is reported
 * next to them as min/max so run-to-run variance is visible.
 */

const fs = require('fs');
const { LogLinearHistogram } = require('../../replica/perf-histogram');

function readTrials(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (value, digits = 3) => (value === null || value === undefined || !Number.isFinite(value)
    ? null : Number(value.toFixed(digits)));

function spread(values) {
    const finite = values.filter((v) => v !== null && Number.isFinite(v));
    if (!finite.length) return { mean: null, min: null, max: null };
    return { mean: round(mean(finite)), min: round(Math.min(...finite)), max: round(Math.max(...finite)) };
}

function pooled(trials, field) {
    const merged = new LogLinearHistogram();
    for (const trial of trials) merged.merge(LogLinearHistogram.fromJSON(trial.rawHistograms[field]));
    return merged.summary(1000);
}

function stageSpread(trials, role, stage, stat = 'p99') {
    return spread(trials.map((t) => {
        const replica = role === 'leader' ? t.server.leader : null;
        return replica && replica.stages[stage] ? replica.stages[stage][stat] : null;
    }));
}

/** One point on a curve: every repetition of (config, payload, rate). */
function summarizePoint(trials) {
    const stableVotes = trials.filter((t) => t.stability.stable).length;
    const leader = (fn) => spread(trials.map((t) => (t.server.leader ? fn(t.server.leader, t) : null)));
    const followerMean = (fn) => spread(trials.map((t) => {
        const values = t.server.followers.map(fn).filter((v) => v !== null && v !== undefined);
        return values.length ? mean(values) : null;
    }));
    return {
        rate: trials[0].load.offeredRate,
        repetitions: trials.length,
        runIds: trials.map((t) => t.runId),
        stableVotes,
        stable: stableVotes * 2 > trials.length,
        instabilityReasons: trials.filter((t) => !t.stability.stable).map((t) => t.stability.reasons),
        generatorSaturated: trials.some((t) => t.generator.saturated),
        leadershipChanged: trials.some((t) => !t.leadershipStable),
        achievedPerSec: spread(trials.map((t) => t.achievedPerSec)),
        achievedRatio: spread(trials.map((t) => t.achievedRatio)),
        errorRate: spread(trials.map((t) => t.errorRate)),
        latencyAllMs: pooled(trials, 'latencyAll'),
        latencyOkMs: pooled(trials, 'latencyOk'),
        p99AllMsPerRep: trials.map((t) => t.latencyAllMs.p99),
        p50AllMsPerRep: trials.map((t) => t.latencyAllMs.p50),
        serviceOkP99Ms: spread(trials.map((t) => t.serviceOkMs.p99)),
        clientQueueDepthP99: spread(trials.map((t) => t.clientQueueDepth.p99)),
        leader: {
            cpuPercentOfOneCore: leader((l) => l.cpuPercentOfOneCore),
            cpuMicrosPerOp: leader((l) => l.cpuMicrosPerOp),
            eventLoopUtilization: leader((l) => l.eventLoopUtilization),
            immediateLagP99Ms: leader((l) => (l.eventLoopImmediateLagMs ? l.eventLoopImmediateLagMs.p99 : null)),
            logFsyncsPerSec: leader((l) => l.rates.logFsyncsPerSec),
            metaSavesPerSec: leader((l) => l.rates.metaSavesPerSec),
            appendEntriesPerSec: leader((l) => l.rates.appendEntriesPerSec),
            heartbeatsPerSec: leader((l) => l.rates.heartbeatsPerSec),
            entriesPerAppendMean: leader((l) => (l.stages['rpc.entriesPerAppend'] ? l.stages['rpc.entriesPerAppend'].mean : null)),
            entriesPerFsyncMean: leader((l) => (l.stages['log.entriesPerFsync'] ? l.stages['log.entriesPerFsync'].mean : null)),
            peakRssBytes: leader((l) => l.memory.peakRss),
            admitToCommitP99Ms: stageSpread(trials, 'leader', 'leader.admitToCommit'),
            uncommittedEntriesP99: leader((l) => (l.stages['gauge.uncommittedEntries'] ? l.stages['gauge.uncommittedEntries'].p99 : null)),
        },
        followers: {
            cpuPercentOfOneCore: followerMean((f) => f.cpuPercentOfOneCore),
            logFsyncsPerSec: followerMean((f) => f.rates.logFsyncsPerSec),
            metaSavesPerSec: followerMean((f) => f.rates.metaSavesPerSec),
        },
        cluster: {
            logFsyncsPerSec: spread(trials.map((t) => t.server.clusterLogFsyncsPerSec)),
            metaSavesPerSec: spread(trials.map((t) => t.server.clusterMetaSavesPerSec)),
            replicationBytesPerOp: spread(trials.map((t) => t.server.replicationBytesPerOp)),
            clientBytesPerOp: spread(trials.map((t) => t.server.clientBytesPerOp)),
        },
    };
}

/**
 * The knee: the highest offered rate that is majority-stable *and* whose every
 * lower rate is majority-stable too. A lucky stable point above an unstable one
 * does not count.
 */
function findKnee(points) {
    const ladder = points.filter((p) => p.phase !== 'knee-fraction').sort((a, b) => a.rate - b.rate);
    let knee = null;
    for (const point of ladder) {
        if (!point.stable) break;
        knee = point;
    }
    const firstUnstable = ladder.find((p) => !p.stable) || null;
    return {
        kneeRate: knee ? knee.rate : null,
        maxStableThroughputPerSec: knee ? knee.achievedPerSec.mean : null,
        p99AtKneeMs: knee ? knee.latencyAllMs.p99 : null,
        firstUnstableRate: firstUnstable ? firstUnstable.rate : null,
        peakAchievedPerSecAnyRate: ladder.length
            ? Math.max(...ladder.map((p) => p.achievedPerSec.mean || 0))
            : null,
    };
}

function groupTrials(trials) {
    const groups = new Map();
    for (const trial of trials) {
        const key = `${trial.config}|${trial.workload.payloadBytes}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(trial);
    }
    const curves = [];
    for (const [key, list] of groups) {
        const [config, payload] = key.split('|');
        const byRate = new Map();
        for (const trial of list) {
            const phase = trial.phase || 'ladder';
            const rateKey = `${phase}|${trial.load.offeredRate}`;
            if (!byRate.has(rateKey)) byRate.set(rateKey, []);
            byRate.get(rateKey).push(trial);
        }
        const points = [...byRate.entries()].map(([rateKey, pointTrials]) => ({
            phase: rateKey.split('|')[0],
            ...summarizePoint(pointTrials),
        })).sort((a, b) => a.rate - b.rate || a.phase.localeCompare(b.phase));
        curves.push({ config, payloadBytes: Number(payload), knee: findKnee(points), points });
    }
    return curves.sort((a, b) => a.config.localeCompare(b.config) || a.payloadBytes - b.payloadBytes);
}

module.exports = { readTrials, summarizePoint, findKnee, groupTrials, spread, round, mean };
