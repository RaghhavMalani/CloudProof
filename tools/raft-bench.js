#!/usr/bin/env node
'use strict';

/**
 * raft-bench.js — one open-loop benchmark trial against a fresh local
 * three-replica CloudProof Raft cluster.
 *
 *   node tools/raft-bench.js --config baseline --rate 500 --duration 20s \
 *       --warmup 5s --payload 1024 --clients 128
 *
 * Prints a one-line summary and, with --out, appends the canonical run record
 * as one JSON line. See CLOUDPROOF-PHASE-IV-A.md for the methodology.
 */

const fs = require('fs');
const path = require('path');
const { runTrial } = require('../packages/raft-bench/run');
const { parseArgs } = require('../packages/raft-bench/cli');

const DEFAULTS = {
    config: 'baseline',
    rate: 500,
    duration: 20000,
    warmup: 5000,
    timeout: 10000,
    payload: 1024,
    clients: 128,
    generators: 4,
    keys: 1000,
    port: 17001,
    'data-dir': path.join(__dirname, '..', '.bench-data', 'cluster'),
    out: null,
    'profile-out': null,
};

function formatTrial(trial) {
    const l = trial.latencyAllMs;
    const leader = trial.server.leader;
    return [
        `${trial.config} rate=${trial.load.offeredRate}/s payload=${trial.workload.payloadBytes}B`,
        `achieved=${trial.achievedPerSec}/s (${(trial.achievedRatio * 100).toFixed(1)}%)`,
        `err=${(trial.errorRate * 100).toFixed(2)}%`,
        `p50=${l.p50}ms p99=${l.p99}ms p99.9=${l.p999}ms max=${l.max}ms`,
        leader ? `leaderCPU=${leader.cpuPercentOfOneCore}% ELU=${leader.eventLoopUtilization} fsync/s=${leader.rates.logFsyncsPerSec} meta/s=${leader.rates.metaSavesPerSec} AE/s=${leader.rates.appendEntriesPerSec}` : 'leader=?',
        `genLagP99=${trial.generator.lagMs.p99}ms`,
        trial.stability.stable ? 'STABLE' : `UNSTABLE(${trial.stability.reasons.join('; ')})`,
    ].join(' | ');
}

async function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, {
        durations: ['duration', 'warmup', 'timeout'],
        strings: ['config', 'data-dir', 'out', 'profile-out'],
    });
    const { record, cpuProfile } = await runTrial({
        config: options.config,
        rate: options.rate,
        payloadBytes: options.payload,
        connections: options.clients,
        generators: options.generators,
        keySpace: options.keys,
        warmupMs: options.warmup,
        durationMs: options.duration,
        timeoutMs: options.timeout,
        basePort: options.port,
        dataRoot: options['data-dir'],
        profile: options['profile-out'] ? { intervalUs: 250 } : null,
    });
    process.stdout.write(`${formatTrial(record)}\n`);
    if (options.out) {
        fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
        fs.appendFileSync(options.out, `${JSON.stringify(record)}\n`);
    }
    if (options['profile-out'] && cpuProfile) {
        fs.mkdirSync(path.dirname(path.resolve(options['profile-out'])), { recursive: true });
        fs.writeFileSync(options['profile-out'], JSON.stringify(cpuProfile));
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}

module.exports = { formatTrial };
