#!/usr/bin/env node
'use strict';

/**
 * raft-profile.js — CPU-profiles the leader during a benchmark window.
 *
 *   node tools/raft-profile.js --config baseline --payload 1024 \
 *       --rates 150,300,700 --labels A-sub-saturation,B-near-knee,C-overloaded \
 *       --out artifacts/perf/phase-iv-a/profiles/baseline
 *
 * For each rate: one trial with a V8 CPU profile of the leader covering exactly
 * the measurement window. The processed summary (categories, top self and
 * inclusive frames, key paths) is written to --out; the raw .cpuprofile and
 * the folded stacks (flame-graph input) go to .bench-data/profiles and are
 * referenced from the summary by SHA-256.
 *
 * --power-throttling disabled (default; methodology amendment 2) or os-default
 * selects the process power policy of every process of each trial; the
 * verified policy is recorded in each summary.
 */

const fs = require('fs');
const path = require('path');
const { runTrial } = require('../packages/raft-bench/run');
const { parseArgs } = require('../packages/raft-bench/cli');
const { summarizeProfile, sha256 } = require('../packages/raft-bench/profile');
const { formatTrial } = require('./raft-bench');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
    config: 'baseline',
    payload: 1024,
    rates: [],
    labels: [],
    duration: 15000,
    warmup: 5000,
    timeout: 10000,
    clients: 128,
    generators: 4,
    keys: 1000,
    port: 17001,
    interval: 250,
    out: null,
    raw: path.join(ROOT, '.bench-data', 'profiles'),
    'data-dir': path.join(ROOT, '.bench-data', 'cluster'),
    'power-throttling': 'disabled',
};

async function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, {
        durations: ['duration', 'warmup', 'timeout'],
        lists: { rates: Number, labels: String },
        strings: ['config', 'out', 'raw', 'data-dir', 'power-throttling'],
    });
    if (!options.out) throw new Error('--out is required');
    if (options.labels.length !== options.rates.length) throw new Error('--labels must match --rates');
    fs.mkdirSync(options.out, { recursive: true });
    fs.mkdirSync(options.raw, { recursive: true });

    for (let i = 0; i < options.rates.length; i += 1) {
        const rate = options.rates[i];
        const label = options.labels[i];
        const { record, cpuProfile } = await runTrial({
            config: options.config,
            rate,
            payloadBytes: options.payload,
            connections: options.clients,
            generators: options.generators,
            keySpace: options.keys,
            warmupMs: options.warmup,
            durationMs: options.duration,
            timeoutMs: options.timeout,
            basePort: options.port,
            dataRoot: options['data-dir'],
            profile: { intervalUs: options.interval },
            powerThrottling: options['power-throttling'],
        });
        process.stdout.write(`${label}: ${formatTrial(record)}\n`);
        const rawText = JSON.stringify(cpuProfile);
        const stem = `${options.config}-${options.payload}B-${label}`;
        const rawFile = path.join(options.raw, `${stem}.cpuprofile`);
        fs.writeFileSync(rawFile, rawText);
        const summary = summarizeProfile(cpuProfile, { label });
        const foldedText = summary.foldedStacks
            .map(([stack, micros]) => `${stack.replace(/ /g, '_')} ${Math.round(micros)}`)
            .join('\n');
        const foldedFile = path.join(options.raw, `${stem}.folded`);
        fs.writeFileSync(foldedFile, `${foldedText}\n`);
        const { foldedStacks, ...rest } = summary;
        const output = {
            ...rest,
            config: options.config,
            payloadBytes: options.payload,
            offeredRate: rate,
            samplingIntervalUs: options.interval,
            leaderReplica: record.leader.replicaId,
            trial: {
                runId: record.runId,
                achievedPerSec: record.achievedPerSec,
                latencyAllMs: record.latencyAllMs,
                stable: record.stability.stable,
                leaderCpuPercentOfOneCore: record.server.leader ? record.server.leader.cpuPercentOfOneCore : null,
                leaderEventLoopUtilization: record.server.leader ? record.server.leader.eventLoopUtilization : null,
                powerThrottling: { requested: record.powerThrottling.requested, applied: record.powerThrottling.applied },
                diskRegime: record.diskSentinel ? record.diskSentinel.regime : null,
            },
            topFoldedStacks: foldedStacks.slice(0, 40).map(([stack, micros]) => ({ stack, ms: Number((micros / 1000).toFixed(1)) })),
            raw: {
                cpuprofile: path.relative(ROOT, rawFile).split(path.sep).join('/'),
                cpuprofileSha256: sha256(rawText),
                folded: path.relative(ROOT, foldedFile).split(path.sep).join('/'),
                foldedSha256: sha256(`${foldedText}\n`),
                note: 'raw profiles are kept out of git (size); the hashes identify them',
            },
        };
        fs.writeFileSync(path.join(options.out, `${stem}.json`), `${JSON.stringify(output, null, 2)}\n`);
        fs.appendFileSync(path.join(options.out, 'trials.jsonl'), `${JSON.stringify({ ...record, phase: 'profile', profileLabel: label })}\n`);
        const top = output.categories.slice(0, 6).map((c) => `${c.category} ${c.percentOfWall}%`).join(', ');
        process.stdout.write(`  categories: ${top}\n`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}
