#!/usr/bin/env node
'use strict';

/**
 * raft-power-control-report.js — the Windows-default power-policy control
 * (methodology amendment 2): baseline and optimized-binary at 1 KiB, each
 * under Windows' default process power policy and with throttling disabled,
 * at the control plan's fixed rates.
 *
 *   node tools/raft-power-control-report.js [--dir artifacts/perf/phase-iv-a/windows-power-control]
 *
 * Environment analysis only; it is not part of the optimization ranking.
 * Per (config, policy, rate): repetitions, stable votes, achieved throughput,
 * pooled p50/p99, leader CPU and event-loop utilization, leader event-loop
 * lag (setImmediate turnaround p99), generator send lag p99 and client queue
 * wait p99 (send delay), and the disk regimes the trials ran in. Then the
 * disabled/os-default ratios, and coherence checks.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('../packages/raft-bench/cli');
const { readTrials, mean } = require('../packages/raft-bench/aggregate');
const { LogLinearHistogram } = require('../replica/perf-histogram');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = { dir: path.join(ROOT, 'artifacts', 'perf', 'phase-iv-a', 'windows-power-control') };

const policyOf = (t) => (t.powerThrottling && t.powerThrottling.requested) || 'os-default';
const f = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Number(v).toFixed(d));
const fi = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : Math.round(v).toLocaleString('en-US'));
const meanOf = (values) => {
    const finite = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
    return finite.length ? mean(finite) : null;
};

function pooled(trials) {
    const merged = new LogLinearHistogram();
    for (const t of trials) merged.merge(LogLinearHistogram.fromJSON(t.rawHistograms.latencyAll));
    return merged.summary(1000);
}

function point(trials) {
    const leader = (fn) => meanOf(trials.map((t) => (t.server && t.server.leader ? fn(t.server.leader) : null)));
    const latency = pooled(trials);
    const regimes = {};
    for (const t of trials) {
        const regime = t.diskSentinel ? t.diskSentinel.regime : 'unknown';
        regimes[regime] = (regimes[regime] || 0) + 1;
    }
    return {
        repetitions: trials.length,
        stableVotes: trials.filter((t) => t.stability.stable).length,
        achievedPerSec: meanOf(trials.map((t) => t.achievedPerSec)),
        achievedRatio: meanOf(trials.map((t) => t.achievedRatio)),
        p50Ms: latency.p50,
        p99Ms: latency.p99,
        leaderCpuPercent: leader((l) => l.cpuPercentOfOneCore),
        leaderCpuMicrosPerOp: leader((l) => l.cpuMicrosPerOp),
        leaderElu: leader((l) => l.eventLoopUtilization),
        leaderLoopLagP99Ms: leader((l) => (l.eventLoopImmediateLagMs ? l.eventLoopImmediateLagMs.p99 : null)),
        generatorLagP99Ms: meanOf(trials.map((t) => (t.generator && t.generator.lagMs ? t.generator.lagMs.p99 : null))),
        clientQueueWaitP99Ms: meanOf(trials.map((t) => (t.clientQueueWaitMs ? t.clientQueueWaitMs.p99 : null))),
        regimes,
        policiesVerified: trials.every((t) => t.powerThrottling && t.powerThrottling.applied === true),
    };
}

function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, { strings: ['dir'] });
    const dir = path.resolve(options.dir);
    const plan = JSON.parse(fs.readFileSync(path.join(dir, 'plan.json'), 'utf8'));
    const trials = readTrials(path.join(dir, 'trials.jsonl'));
    const rows = [];
    for (const config of [...new Set(plan.curves.map((c) => c.config))]) {
        for (const rate of plan.rates) {
            for (const policy of ['os-default', 'disabled']) {
                const own = trials.filter((t) => t.config === config && policyOf(t) === policy && t.load.offeredRate === rate);
                if (own.length) rows.push({ config, policy, rate, ...point(own) });
            }
        }
    }
    const ratios = [];
    for (const config of [...new Set(rows.map((r) => r.config))]) {
        for (const rate of plan.rates) {
            const def = rows.find((r) => r.config === config && r.rate === rate && r.policy === 'os-default');
            const off = rows.find((r) => r.config === config && r.rate === rate && r.policy === 'disabled');
            if (!def || !off) continue;
            const ratio = (a, b) => (a !== null && b ? a / b : null);
            ratios.push({
                config, rate,
                achievedOffOverDefault: ratio(off.achievedPerSec, def.achievedPerSec),
                p99DefaultOverOff: ratio(def.p99Ms, off.p99Ms),
                cpuUsPerOpDefaultOverOff: ratio(def.leaderCpuMicrosPerOp, off.leaderCpuMicrosPerOp),
                loopLagDefaultOverOff: ratio(def.leaderLoopLagP99Ms, off.leaderLoopLagP99Ms),
                stable: { 'os-default': `${def.stableVotes}/${def.repetitions}`, disabled: `${off.stableVotes}/${off.repetitions}` },
            });
        }
    }
    const expected = plan.curves.reduce((n, c) => n + c.repetitions * plan.rates.length, 0);
    const checks = {
        allTrialsRecorded: trials.length === expected,
        everyPolicyVerified: trials.every((t) => t.powerThrottling && t.powerThrottling.applied === true),
        everyProcessInRequestedState: trials.every((t) => t.powerThrottling && t.powerThrottling.processes
            .every((p) => p.inRequestedState === true)),
        noFailedTrials: trials.every((t) => !t.failed),
        sentinelOnEveryTrial: trials.every((t) => t.diskSentinel && t.diskSentinel.sampledImmediatelyBeforeTrial),
    };

    const table = [
        '| config | policy | offered/s | stable | achieved/s | p50 ms | p99 ms | leader CPU % | CPU µs/op | ELU | loop lag p99 ms | send lag p99 ms | client queue p99 ms | disk regimes |',
        '|---|---|---:|:---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|',
        ...rows.map((r) => `| ${r.config} | ${r.policy} | ${fi(r.rate)} | ${r.stableVotes}/${r.repetitions} | ${fi(r.achievedPerSec)} | `
            + `${f(r.p50Ms, 2)} | ${f(r.p99Ms, 2)} | ${f(r.leaderCpuPercent, 0)} | ${f(r.leaderCpuMicrosPerOp, 0)} | ${f(r.leaderElu, 2)} | `
            + `${f(r.leaderLoopLagP99Ms, 2)} | ${f(r.generatorLagP99Ms, 2)} | ${f(r.clientQueueWaitP99Ms, 2)} | `
            + `${Object.entries(r.regimes).map(([k, v]) => `${k} ${v}`).join(', ')} |`),
    ].join('\n');
    const ratioTable = [
        '| config | offered/s | achieved: disabled ÷ default | p99: default ÷ disabled | leader CPU µs/op: default ÷ disabled | loop lag p99: default ÷ disabled | stable (default / disabled) |',
        '|---|---:|---:|---:|---:|---:|---|',
        ...ratios.map((r) => `| ${r.config} | ${fi(r.rate)} | ${f(r.achievedOffOverDefault, 2)} | ${f(r.p99DefaultOverOff, 2)} | `
            + `${f(r.cpuUsPerOpDefaultOverOff, 2)} | ${f(r.loopLagDefaultOverOff, 2)} | ${r.stable['os-default']} / ${r.stable.disabled} |`),
    ].join('\n');

    const summary = { schema: 'cloudproof.power-control/v1', generatedAt: new Date().toISOString(), plan: plan.purpose, checks, rows, ratios };
    fs.writeFileSync(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'REPORT.md'), [
        '# Windows-default power-policy control', '',
        '_Environment analysis (methodology amendment 2), not part of the optimization ranking. Generated by `node tools/raft-power-control-report.js`._', '',
        table, '', '## Policy effect', '', ratioTable, '', `Checks: ${JSON.stringify(checks)}`, '',
    ].join('\n'));
    process.stdout.write(`${table}\n\n${ratioTable}\n\nchecks: ${JSON.stringify(checks)}\n`);
}

if (require.main === module) main();
