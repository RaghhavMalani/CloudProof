#!/usr/bin/env node
'use strict';

/**
 * Reproducible measurements for the report question:
 *
 * Can deterministic simulation and automated failure reduction make
 * distributed-system correctness bugs reproducible and understandable?
 *
 * Diagnosis time is deliberately not fabricated. Supply paired observations
 * through DIAGNOSIS_WITHOUT_MS and DIAGNOSIS_WITH_MS (comma-separated) after a
 * user study; otherwise the report marks that measure as not collected.
 */

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { materializeSchedule, runSchedule } = require('../sim/schedule');
const { CoverageTracker } = require('../packages/simulator/coverage');
const { SimCluster } = require('../sim/cluster');
const { evaluateInvariants } = require('../packages/simulator/invariants');
const { evaluateAll } = require('../sim/bug-museum');
const { getWorkload, runWorkload } = require('../packages/workloads');

const RUNS = Math.max(4, Number(process.env.RESEARCH_RUNS) || 20);
const OUTPUT = process.env.RESEARCH_OUTPUT || path.join(__dirname, '..', 'artifacts', 'research-metrics.json');
const median = (values) => {
    const ordered = values.slice().sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};

function pairedDiagnosis() {
    const parse = (name) => (process.env[name] || '').split(',').filter(Boolean).map(Number).filter(Number.isFinite);
    const without = parse('DIAGNOSIS_WITHOUT_MS');
    const withDeck = parse('DIAGNOSIS_WITH_MS');
    if (without.length === 0 || without.length !== withDeck.length) {
        return { status: 'not-collected', reason: 'supply equal paired DIAGNOSIS_WITHOUT_MS and DIAGNOSIS_WITH_MS samples' };
    }
    return {
        status: 'measured', samples: without.length,
        medianWithoutMs: median(without), medianWithFlightDeckMs: median(withDeck),
        reduction: 1 - median(withDeck) / Math.max(1, median(without)),
    };
}

async function main() {
    const coverage = new CoverageTracker();
    const recordedTimes = [];
    const unrecordedTimes = [];
    const virtualTimes = [];
    let deterministicReplays = 0;
    let replayAttempts = 0;

    const campaignStarted = performance.now();
    for (let seed = 1; seed <= RUNS; seed += 1) {
        const schedule = materializeSchedule(seed, {
            ops: 18, clients: 3, nodes: 3, spares: 1, drop: 0.08,
            membership: seed % 3 === 0, coverageHint: coverage.nextHint(),
        });

        let started = performance.now();
        const recorded = await runSchedule(schedule, { recording: true });
        recordedTimes.push(performance.now() - started);
        virtualTimes.push(recorded.virtualMs);
        coverage.observe(recorded);

        started = performance.now();
        await runSchedule(schedule, { recording: false });
        unrecordedTimes.push(performance.now() - started);

        replayAttempts += 1;
        const replay = await runSchedule(recorded.schedule, { recording: true });
        const signature = (result) => result.failure?.signature || 'pass';
        const decisionsEqual = JSON.stringify(recorded.schedule.decisions) === JSON.stringify(replay.schedule.decisions);
        if (signature(recorded) === signature(replay) && decisionsEqual) deterministicReplays += 1;
    }
    const campaignMs = performance.now() - campaignStarted;

    const cluster = new SimCluster({ size: 3, seed: 991 });
    await cluster.awaitLeader();
    const invariantChecks = 2000;
    const invariantStarted = performance.now();
    for (let index = 0; index < invariantChecks; index += 1) evaluateInvariants(cluster);
    const invariantMs = performance.now() - invariantStarted;
    cluster.stop();

    const shrinkStarted = performance.now();
    const museum = evaluateAll({ seed: 42 });
    const shrinkMs = performance.now() - shrinkStarted;

    const realityPath = path.join(__dirname, '..', 'web', 'reality-run.json');
    const reality = fs.existsSync(realityPath) ? JSON.parse(fs.readFileSync(realityPath, 'utf8')) : null;
    const simulatedRecoveryMs = runWorkload(getWorkload('configuration'))
        .events.find((event) => event.type === 'watch.stream.resumed').time.elapsedMs;

    const recordedMedian = median(recordedTimes);
    const unrecordedMedian = median(unrecordedTimes);
    const report = {
        schemaVersion: 1,
        kind: 'miniraft.research-metrics',
        measuredAt: new Date().toISOString(),
        question: 'Can deterministic simulation and automated failure reduction make distributed-system correctness bugs reproducible and understandable?',
        environment: { node: process.version, platform: process.platform, arch: process.arch, runs: RUNS },
        measures: {
            schedulesExploredPerSecond: RUNS / (campaignMs / 1000),
            virtualTimePerRealSecond: virtualTimes.reduce((sum, value) => sum + value, 0) / (campaignMs / 1000),
            uniqueStateTransitionCoverage: coverage.export(),
            bugsDiscovered: { discovered: museum.discovered, totalSeeded: museum.total },
            shrinkRatio: museum.medianReduction / 100,
            shrinkExecutionTimeMs: shrinkMs,
            deterministicReplaySuccessRate: deterministicReplays / replayAttempts,
            recorderOverhead: {
                recordedMedianMs: recordedMedian,
                unrecordedMedianMs: unrecordedMedian,
                ratio: recordedMedian / Math.max(0.001, unrecordedMedian),
            },
            invariantCheckingCost: { totalMs: invariantMs, checks: invariantChecks, microsecondsPerCheck: invariantMs * 1000 / invariantChecks },
            recoveryTime: {
                simulatedMs: simulatedRecoveryMs,
                deployedMs: reality?.metrics?.recoveryMs ?? null,
                deployedStatus: reality ? 'measured' : 'not-collected: run the Docker research profile',
            },
            userDiagnosisTime: pairedDiagnosis(),
        },
        interpretation: {
            correctness: deterministicReplays === replayAttempts
                ? 'All sampled schedules replayed with the same decision tape and failure signature.'
                : 'At least one sampled schedule did not replay deterministically; investigate before drawing conclusions.',
            understandability: 'Automated shrink evidence is measured; causal diagnosis-time benefit requires the paired user study and is not inferred from UI features alone.',
        },
    };

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`schedules/s:       ${report.measures.schedulesExploredPerSecond.toFixed(1)}`);
    console.log(`virtual/real:      ${report.measures.virtualTimePerRealSecond.toFixed(1)}x`);
    console.log(`coverage:          ${report.measures.uniqueStateTransitionCoverage.target.covered}/${report.measures.uniqueStateTransitionCoverage.target.total}`);
    console.log(`replay success:    ${(report.measures.deterministicReplaySuccessRate * 100).toFixed(1)}%`);
    console.log(`recorder overhead: ${report.measures.recorderOverhead.ratio.toFixed(2)}x`);
    console.log(`invariant cost:    ${report.measures.invariantCheckingCost.microsecondsPerCheck.toFixed(2)}us/check`);
    console.log(`diagnosis time:    ${report.measures.userDiagnosisTime.status}`);
    console.log(`wrote ${OUTPUT}`);
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
