#!/usr/bin/env node
'use strict';

/**
 * raft-sim-fingerprint.js — proves the deterministic simulator still behaves
 * byte-for-byte the same.
 *
 *   node tools/raft-sim-fingerprint.js --runs 60 [--profile <raft profile>] [--out file.json]
 *
 * Materializes the default search-campaign schedules for seeds 1..N, runs each
 * against the real RaftNode under virtual time, and hashes everything a
 * schedule produces: the client history, the linearizability verdict, every
 * replica's final state, the network counters, the runtime decision tape and
 * the flight-recorder trace. Run it on two commits and compare the combined
 * digest: equal digests mean the change did not alter a single scheduling
 * decision, message, or outcome on the default path.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { materializeSchedule, runSchedule } = require('../sim/schedule');

function parse(argv) {
    const options = { runs: 60, first: 1, out: null, profile: null };
    for (let i = 0; i < argv.length; i += 1) {
        const key = argv[i].replace(/^--/, '');
        const value = argv[++i];
        if (key === 'runs' || key === 'first') options[key] = Number(value);
        else options[key] = value;
    }
    return options;
}

function digest(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function main() {
    const options = parse(process.argv.slice(2));
    const log = console.log;
    console.log = () => {};
    const seeds = [];
    try {
        for (let seed = options.first; seed < options.first + options.runs; seed += 1) {
            const scheduleOptions = options.profile ? { raftProfile: options.profile } : {};
            const schedule = materializeSchedule(seed, scheduleOptions);
            const result = await runSchedule(schedule, { recording: true });
            seeds.push({
                seed,
                ok: result.ok,
                failure: result.failure ? result.failure.signature : null,
                history: digest(result.history),
                states: digest(result.states),
                network: digest(result.network),
                decisions: digest(result.schedule.decisions),
                trace: digest(result.trace),
                virtualMs: result.virtualMs,
            });
        }
    } finally {
        console.log = log;
    }
    const combined = digest(seeds);
    const report = {
        schema: 'cloudproof.sim-fingerprint/v1',
        profile: options.profile || 'default',
        seeds: seeds.length,
        failures: seeds.filter((s) => !s.ok).length,
        combined,
        perSeed: seeds,
    };
    if (options.out) {
        fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
        fs.writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.stdout.write(`profile=${report.profile} seeds=${report.seeds} failures=${report.failures} combined=${combined}\n`);
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
});
