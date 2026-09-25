#!/usr/bin/env node
'use strict';

/**
 * raft-bench-sweep.js — a saturation sweep with a pre-registered stopping rule.
 *
 *   node tools/raft-bench-sweep.js --configs baseline \
 *       --rates 100,200,300,500,750,1000 --payloads 64,1024,16384 --repetitions 3 \
 *       --out artifacts/perf/phase-iv-a/baseline
 *
 * Ladder mode (default) walks each (config, payload) up the given rates, every
 * rate at the full repetition count, and stops that curve after two
 * consecutive majority-unstable rates or one rate whose mean achieved
 * throughput is below half of offered. The rule is written into the sweep
 * output and cannot be changed per curve.
 *
 * Knee mode (--fractions 0.5,0.8,1) re-reads the ladder's knee for each curve
 * and runs those fractions of it, so latency "at 50% / 80% of saturation" is
 * measured at those loads rather than interpolated.
 *
 * Trials append to <out>/trials.jsonl as they finish; rerunning skips trials
 * that are already recorded, so an interrupted sweep resumes. <out>/sweep.json
 * is regenerated from the raw trials after every point.
 */

const fs = require('fs');
const path = require('path');
const { runTrial } = require('../packages/raft-bench/run');
const { parseArgs } = require('../packages/raft-bench/cli');
const { readTrials, groupTrials, mean } = require('../packages/raft-bench/aggregate');
const { captureEnvironment } = require('../packages/raft-bench/environment');
const { formatTrial } = require('./raft-bench');
const { STABILITY_RULE } = require('../packages/raft-bench/run');

const ROOT = path.join(__dirname, '..');

const STOP_RULE = Object.freeze({
    version: 1,
    consecutiveUnstable: 2,
    severeAchievedRatio: 0.5,
    text: 'A curve stops after two consecutive majority-unstable rates, or after any rate whose mean '
        + 'achieved/offered ratio is below 0.5. Every rate that is run uses the full repetition count.',
});

const DEFAULTS = {
    configs: ['baseline'],
    rates: [100, 200, 300, 500, 750, 1000],
    payloads: [1024],
    repetitions: 3,
    duration: 20000,
    warmup: 5000,
    timeout: 10000,
    clients: 128,
    generators: 4,
    keys: 1000,
    port: 17001,
    fractions: null,
    'knee-from': null,
    out: null,
    'data-dir': path.join(ROOT, '.bench-data', 'cluster'),
};

function done(trials, config, payload, rate, repetition, phase) {
    return trials.some((t) => t.config === config && t.workload.payloadBytes === payload
        && t.load.offeredRate === rate && t.repetition === repetition && (t.phase || 'ladder') === phase);
}

function writeSummary(outDir, options, environmentFile) {
    const trials = readTrials(path.join(outDir, 'trials.jsonl'));
    const curves = groupTrials(trials);
    const summary = {
        schema: 'cloudproof.raft-bench.sweep/v1',
        generatedAt: new Date().toISOString(),
        environment: path.relative(outDir, environmentFile).split(path.sep).join('/'),
        parameters: {
            configs: options.configs,
            rates: options.rates,
            payloads: options.payloads,
            repetitions: options.repetitions,
            warmupMs: options.warmup,
            durationMs: options.duration,
            timeoutMs: options.timeout,
            connections: options.clients,
            generators: options.generators,
            keySpace: options.keys,
        },
        stabilityRule: STABILITY_RULE,
        stopRule: STOP_RULE,
        trialCount: trials.length,
        curves,
    };
    fs.writeFileSync(path.join(outDir, 'sweep.json'), `${JSON.stringify(summary, null, 2)}\n`);
    return summary;
}

async function runPoint({ options, outDir, trialsFile, config, payload, rate, phase }) {
    const results = [];
    for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
        const existing = readTrials(trialsFile);
        if (done(existing, config, payload, rate, repetition, phase)) {
            results.push(existing.find((t) => t.config === config && t.workload.payloadBytes === payload
                && t.load.offeredRate === rate && t.repetition === repetition && (t.phase || 'ladder') === phase));
            continue;
        }
        const { record } = await runTrial({
            config,
            rate,
            payloadBytes: payload,
            connections: options.clients,
            generators: options.generators,
            keySpace: options.keys,
            warmupMs: options.warmup,
            durationMs: options.duration,
            timeoutMs: options.timeout,
            basePort: options.port,
            dataRoot: options['data-dir'],
            repetition,
        });
        record.phase = phase;
        fs.appendFileSync(trialsFile, `${JSON.stringify(record)}\n`);
        process.stdout.write(`  [${phase} rep ${repetition + 1}/${options.repetitions}] ${formatTrial(record)}\n`);
        results.push(record);
    }
    return results;
}

async function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, {
        durations: ['duration', 'warmup', 'timeout'],
        lists: { configs: String, rates: Number, payloads: Number, fractions: Number },
        strings: ['out', 'data-dir', 'knee-from'],
    });
    if (!options.out) throw new Error('--out <directory> is required');
    const outDir = path.resolve(options.out);
    fs.mkdirSync(outDir, { recursive: true });
    const trialsFile = path.join(outDir, 'trials.jsonl');

    const environmentFile = path.join(outDir, 'environment.json');
    if (!fs.existsSync(environmentFile)) {
        const environment = captureEnvironment({ root: ROOT, dataDir: options['data-dir'] });
        fs.writeFileSync(environmentFile, `${JSON.stringify(environment, null, 2)}\n`);
    }

    for (const config of options.configs) {
        for (const payload of options.payloads) {
            if (options.fractions) {
                const source = options['knee-from'] ? path.resolve(options['knee-from']) : path.join(outDir, 'sweep.json');
                const sweep = JSON.parse(fs.readFileSync(source, 'utf8'));
                const curve = sweep.curves.find((c) => c.config === config && c.payloadBytes === payload);
                if (!curve || !curve.knee.kneeRate) {
                    process.stdout.write(`${config} ${payload}B: no knee recorded; skipping fractions\n`);
                    continue;
                }
                for (const fraction of options.fractions) {
                    const rate = Math.max(1, Math.round(curve.knee.kneeRate * fraction));
                    process.stdout.write(`${config} ${payload}B knee=${curve.knee.kneeRate}/s -> ${fraction} x = ${rate}/s\n`);
                    await runPoint({ options, outDir, trialsFile, config, payload, rate, phase: 'knee-fraction' });
                    writeSummary(outDir, options, environmentFile);
                }
                continue;
            }

            let unstableStreak = 0;
            for (const rate of options.rates) {
                process.stdout.write(`${config} ${payload}B rate ${rate}/s\n`);
                const trials = await runPoint({ options, outDir, trialsFile, config, payload, rate, phase: 'ladder' });
                writeSummary(outDir, options, environmentFile);
                const stableVotes = trials.filter((t) => t.stability.stable).length;
                const majorityStable = stableVotes * 2 > trials.length;
                const meanRatio = mean(trials.map((t) => t.achievedRatio));
                unstableStreak = majorityStable ? 0 : unstableStreak + 1;
                if (unstableStreak >= STOP_RULE.consecutiveUnstable || meanRatio < STOP_RULE.severeAchievedRatio) {
                    process.stdout.write(`  stop rule reached at ${rate}/s (streak=${unstableStreak}, `
                        + `mean achieved ratio=${meanRatio.toFixed(3)})\n`);
                    break;
                }
            }
        }
    }
    const summary = writeSummary(outDir, options, environmentFile);
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

module.exports = { STOP_RULE };
