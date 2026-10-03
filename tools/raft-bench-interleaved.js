#!/usr/bin/env node
'use strict';

/**
 * raft-bench-interleaved.js — the frozen comparison sweep (methodology
 * amendment 1): every configuration's saturation curve, interleaved.
 *
 *   node tools/raft-bench-interleaved.js --plan artifacts/perf/phase-iv-a/comparison-plan.json \
 *       --out artifacts/perf/phase-iv-a/comparison
 *   node tools/raft-bench-interleaved.js --plan ... --out ... --dry-run   # print the schedule only
 *
 * The plan lists curves (config, payload, repetitions). The ladder is walked
 * one rung at a time for *all* active curves together: at each rung, round j
 * runs every active curve that still owes a repetition, in the order of one
 * row of a Williams Latin square (packages/raft-bench/order.js). After a rung,
 * the pre-registered stop rule (the same rule as raft-bench-sweep.js) retires
 * curves independently. When every ladder is done, 0.5x and 0.8x of each
 * curve's knee are run the same way.
 *
 * Every trial carries the disk sentinel sampled immediately before it, its
 * position in the order, and the verified process power policy of every
 * process it started (methodology amendment 2): the comparison runs with
 * Windows power throttling disabled for the replicas, the load generators and
 * this driver. A curve may name its own policy (the Windows-default control
 * runs both); `fixedRates: true` in a plan runs every rate with no stop rule. Trials append to <out>/trials.jsonl as they
 * finish; rerunning with the same plan skips recorded trials, so an
 * interrupted sweep resumes in exactly the same order. Nothing is ever
 * selected or discarded.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runTrial, STABILITY_RULE } = require('../packages/raft-bench/run');
const { parseArgs } = require('../packages/raft-bench/cli');
const { readTrials, groupTrials, mean } = require('../packages/raft-bench/aggregate');
const { captureEnvironment } = require('../packages/raft-bench/environment');
const { CONFIGS } = require('../packages/raft-bench/configs');
const { ORDER_SCHEME, orderedRound } = require('../packages/raft-bench/order');
const { SENTINEL } = require('../packages/raft-bench/disk-sentinel');
const { STOP_RULE } = require('./raft-bench-sweep');
const { formatTrial } = require('./raft-bench');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
    plan: null,
    out: null,
    port: 17001,
    'data-dir': path.join(ROOT, '.bench-data', 'cluster'),
    'dry-run': false,
    // Methodology amendment 2: benchmark-owned processes opt out of Windows
    // power throttling unless a plan curve says otherwise.
    'power-throttling': 'disabled',
};

const policyOf = (trial) => (trial.powerThrottling && trial.powerThrottling.requested) || 'os-default';
const curveKey = (curve) => `${curve.config}|${curve.payloadBytes}|${curve.powerThrottling}`;

function loadPlan(file) {
    const text = fs.readFileSync(file, 'utf8');
    const plan = JSON.parse(text);
    if (plan.schema !== 'cloudproof.raft-bench.comparison-plan/v1') throw new Error(`unexpected plan schema ${plan.schema}`);
    for (const curve of plan.curves) {
        if (!CONFIGS[curve.config]) throw new Error(`plan names unknown config ${curve.config}`);
    }
    return { plan, sha256: crypto.createHash('sha256').update(text).digest('hex') };
}

function findTrial(trials, { config, payloadBytes, rate, repetition, phase, powerThrottling }) {
    return trials.find((t) => t.config === config && t.workload.payloadBytes === payloadBytes
        && t.load.offeredRate === rate && t.repetition === repetition && (t.phase || 'ladder') === phase
        && policyOf(t) === powerThrottling);
}

/** Curves per power policy, so the two arms of a control never merge. */
function curvesByPolicy(trials) {
    const policies = [...new Set(trials.map(policyOf))];
    return policies.flatMap((policy) => groupTrials(trials.filter((t) => policyOf(t) === policy))
        .map((curve) => ({ ...curve, powerThrottling: policy })));
}

function writeSummary(outDir, plan, planSha) {
    const trials = readTrials(path.join(outDir, 'trials.jsonl'));
    const summary = {
        schema: 'cloudproof.raft-bench.sweep/v1',
        generatedAt: new Date().toISOString(),
        environment: 'environment.json',
        plan: { sha256: planSha, curves: plan.curves, rates: plan.rates, fractions: plan.fractions, trial: plan.trial },
        order: ORDER_SCHEME,
        sentinel: SENTINEL,
        stabilityRule: STABILITY_RULE,
        stopRule: STOP_RULE,
        trialCount: trials.length,
        curves: curvesByPolicy(trials),
    };
    fs.writeFileSync(path.join(outDir, 'sweep.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
}

/**
 * Runs (or, in a dry run, lists) one rung for a set of curves. `jobs` are
 * { curve, rate, phase }. Returns trials grouped by curve key.
 */
async function runRung({ jobs, phase, state, context }) {
    const byCurve = new Map(jobs.map((job) => [curveKey(job.curve), []]));
    const maxReps = Math.max(...jobs.map((job) => job.curve.repetitions));
    for (let repetition = 0; repetition < maxReps; repetition += 1) {
        const due = jobs.filter((job) => job.curve.repetitions > repetition);
        const round = state.round;
        state.round += 1;
        const ordered = orderedRound(due, round);
        for (let position = 0; position < ordered.length; position += 1) {
            const job = ordered[position];
            const spec = {
                config: job.curve.config, payloadBytes: job.curve.payloadBytes, rate: job.rate, repetition, phase,
                powerThrottling: job.curve.powerThrottling,
            };
            if (context.dryRun) {
                context.schedule.push({ round, position, ...spec });
                byCurve.get(curveKey(job.curve)).push(null);
                continue;
            }
            let record = findTrial(readTrials(context.trialsFile), spec);
            if (!record) {
                ({ record } = await runTrial({
                    config: spec.config,
                    rate: spec.rate,
                    payloadBytes: spec.payloadBytes,
                    connections: context.plan.trial.connections,
                    generators: context.plan.trial.generators,
                    keySpace: context.plan.trial.keySpace,
                    warmupMs: context.plan.trial.warmupMs,
                    durationMs: context.plan.trial.durationMs,
                    timeoutMs: context.plan.trial.timeoutMs,
                    basePort: context.port,
                    dataRoot: context.dataDir,
                    repetition,
                    powerThrottling: spec.powerThrottling,
                }));
                record.phase = phase;
                record.order = { scheme: ORDER_SCHEME.name, version: ORDER_SCHEME.version, round, position, roundSize: ordered.length };
                record.planSha256 = context.planSha;
                fs.appendFileSync(context.trialsFile, `${JSON.stringify(record)}\n`);
                const disk = record.diskSentinel || {};
                process.stdout.write(`  r${round}.${position} ${spec.config} ${spec.payloadBytes}B ${spec.powerThrottling} rep ${repetition + 1} `
                    + `disk=${disk.regime}(${disk.medianFsyncMs}ms) ${formatTrial(record)}\n`);
            }
            byCurve.get(curveKey(job.curve)).push(record);
        }
    }
    return byCurve;
}

async function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, {
        strings: ['plan', 'out', 'data-dir', 'power-throttling'], flags: ['dry-run'],
    });
    if (!options.plan) throw new Error('--plan <file> is required');
    const { plan, sha256: planSha } = loadPlan(path.resolve(options.plan));
    const dryRun = Boolean(options['dry-run']);
    const outDir = options.out ? path.resolve(options.out) : null;
    if (!dryRun && !outDir) throw new Error('--out <directory> is required');

    const context = {
        plan, planSha, dryRun, schedule: [],
        port: options.port, dataDir: options['data-dir'],
        trialsFile: outDir ? path.join(outDir, 'trials.jsonl') : null,
    };
    if (!dryRun) {
        fs.mkdirSync(outDir, { recursive: true });
        const environmentFile = path.join(outDir, 'environment.json');
        if (!fs.existsSync(environmentFile)) {
            const environment = captureEnvironment({ root: ROOT, dataDir: options['data-dir'] });
            fs.writeFileSync(environmentFile, `${JSON.stringify(environment, null, 2)}\n`);
        }
        const recordedPlan = path.join(outDir, 'plan.json');
        if (fs.existsSync(recordedPlan)) {
            const previous = crypto.createHash('sha256').update(fs.readFileSync(recordedPlan)).digest('hex');
            if (previous !== planSha) throw new Error('this output directory was started with a different plan');
        } else {
            fs.copyFileSync(path.resolve(options.plan), recordedPlan);
        }
    }

    const state = { round: 0 };
    const curves = plan.curves.map((curve) => ({
        ...curve, powerThrottling: curve.powerThrottling || plan.powerThrottling || options['power-throttling'],
        active: true, unstableStreak: 0, rungs: [],
    }));
    if (!dryRun) {
        // The driver itself is a benchmark-owned process: it takes the
        // policy of the comparison (it only orchestrates and runs the disk
        // sentinel; runTrial re-applies the trial's policy to it).
        const { applyPolicy } = require('../packages/raft-bench/power-throttling');
        applyPolicy(curves[0].powerThrottling, [{ role: 'driver', pid: process.pid }]);
    }
    for (const rate of plan.rates) {
        const active = curves.filter((curve) => curve.active);
        if (!active.length) break;
        process.stdout.write(`rung ${rate}/s: ${active.map((c) => `${c.config}@${c.payloadBytes}B`).join(', ')}\n`);
        const results = await runRung({ jobs: active.map((curve) => ({ curve, rate })), phase: 'ladder', state, context });
        for (const curve of active) {
            const trials = results.get(curveKey(curve));
            curve.rungs.push(rate);
            if (dryRun) {
                // The schedule beyond this point depends on results; a dry run
                // assumes every curve keeps going until the plan's dry-run cap.
                if (curve.rungs.length >= (plan.dryRunRungs || 3)) curve.active = false;
                continue;
            }
            if (plan.fixedRates) continue;
            const stableVotes = trials.filter((t) => t.stability.stable).length;
            const majorityStable = stableVotes * 2 > trials.length;
            const meanRatio = mean(trials.map((t) => t.achievedRatio));
            curve.unstableStreak = majorityStable ? 0 : curve.unstableStreak + 1;
            if (curve.unstableStreak >= STOP_RULE.consecutiveUnstable || meanRatio < STOP_RULE.severeAchievedRatio) {
                curve.active = false;
                process.stdout.write(`  ${curve.config}@${curve.payloadBytes}B stops at ${rate}/s `
                    + `(streak=${curve.unstableStreak}, mean achieved ratio=${meanRatio.toFixed(3)})\n`);
            }
        }
        if (!dryRun) writeSummary(outDir, plan, planSha);
    }

    if (!dryRun && plan.fractions && plan.fractions.length) {
        const summary = writeSummary(outDir, plan, planSha);
        for (const fraction of plan.fractions) {
            const jobs = [];
            for (const curve of curves) {
                const recorded = summary.curves.find((c) => c.config === curve.config && c.payloadBytes === curve.payloadBytes
                    && c.powerThrottling === curve.powerThrottling);
                if (!recorded || !recorded.knee.kneeRate) continue;
                jobs.push({ curve, rate: Math.max(1, Math.round(recorded.knee.kneeRate * fraction)) });
            }
            if (!jobs.length) continue;
            process.stdout.write(`fraction ${fraction} of each knee: ${jobs.map((j) => `${j.curve.config}@${j.curve.payloadBytes}B=${j.rate}/s`).join(', ')}\n`);
            await runRung({ jobs, phase: 'knee-fraction', state, context });
            writeSummary(outDir, plan, planSha);
        }
    }

    if (dryRun) {
        process.stdout.write(`${JSON.stringify({ planSha256: planSha, order: ORDER_SCHEME.name, trials: context.schedule.length, schedule: context.schedule })}\n`);
        return;
    }
    const summary = writeSummary(outDir, plan, planSha);
    for (const curve of summary.curves) {
        process.stdout.write(`${curve.config} ${curve.payloadBytes}B: knee=${curve.knee.kneeRate}/s `
            + `maxStable=${curve.knee.maxStableThroughputPerSec}/s p99@knee=${curve.knee.p99AtKneeMs}ms\n`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { loadPlan, runRung };
