#!/usr/bin/env node
'use strict';

/**
 * raft-power-throttling-probe.js — does this machine throttle a busy
 * background process, and does the per-process opt-out remove it?
 *
 *   node tools/raft-power-throttling-probe.js [--out artifacts/perf/phase-iv-a/power-throttling-probe.json]
 *   node tools/raft-power-throttling-probe.js --conditions default,opted-out --repeat 3 --out <file>
 *
 * Each condition runs a pure CPU loop (SHA-256 of 1 KiB, no I/O) in a fresh
 * child process for 8 s and records hashes per 500 ms. Conditions: Windows
 * default; pinned to one performance core; pinned to one efficiency core;
 * high process priority; opted out of power throttling
 * (packages/raft-bench/power-throttling.js). Windows only; elsewhere it records
 * the default condition alone.
 *
 * Per run: initial = mean of 0-2.5 s, after3s = the 3.5-4.0 s sample, steady =
 * mean from 4 s to the end, ratio = steady / initial. The policy of the probed
 * process is read back from Windows and recorded (verified opt-out, or
 * system-managed). With --repeat N the conditions are run N times in rotating
 * order.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { parseArgs } = require('../packages/raft-bench/cli');
const { applyPolicy, queryPowerThrottling } = require('../packages/raft-bench/power-throttling');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = {
    out: path.join(ROOT, 'artifacts', 'perf', 'phase-iv-a', 'power-throttling-probe.json'),
    loop: null,
    seconds: 8,
    repeat: 1,
    conditions: null,
};

function loop(seconds) {
    const crypto = require('crypto');
    if (process.env.PROBE_HIGH_PRIORITY === '1') os.setPriority(process.pid, os.constants.priority.PRIORITY_HIGH);
    const buffer = Buffer.alloc(1024, 7);
    const series = [];
    const start = Date.now();
    let mark = start;
    let count = 0;
    while (Date.now() - start < seconds * 1000) {
        for (let i = 0; i < 200; i += 1) crypto.createHash('sha256').update(buffer).digest();
        count += 200;
        const now = Date.now();
        if (now - mark >= 500) { series.push(count); count = 0; mark = now; }
    }
    process.stdout.write(JSON.stringify(series));
}

const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

function runCondition({ id, label, affinity = null, highPriority = false, optOut = false }, seconds) {
    return new Promise((resolve, reject) => {
        const args = [__filename, '--loop', '1', '--seconds', String(seconds)];
        const env = { ...process.env, PROBE_HIGH_PRIORITY: highPriority ? '1' : '0' };
        let child;
        if (affinity) {
            // cmd's start /affinity sets the mask before the process runs.
            const command = `start "" /b /wait /affinity ${affinity} "${process.execPath}" ${args.map((a) => `"${a}"`).join(' ')}`;
            child = spawn('cmd.exe', ['/d', '/s', '/c', command], { env, windowsHide: true, windowsVerbatimArguments: true });
        } else {
            child = spawn(process.execPath, args, { env, windowsHide: true });
        }
        // For an affinity run the pid is cmd.exe's; its node child is not
        // separately addressable here, so only direct children are verified.
        let policy = null;
        if (optOut) policy = applyPolicy('disabled', [{ role: 'probe', pid: child.pid }]).processes[0];
        else if (!affinity && process.platform === 'win32') policy = queryPowerThrottling([child.pid])[0];
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('exit', () => {
            try {
                const series = JSON.parse(out.trim());
                const initial = mean(series.slice(0, 5));
                const steady = mean(series.slice(8));
                resolve({
                    id, label, affinity, highPriority, optOut, policy, series,
                    beforeMean: initial,
                    afterMean: mean(series.slice(7)),
                    initial,
                    after3s: series[7] ?? null,
                    steady,
                    ratio: initial ? steady / initial : null,
                });
            } catch (error) {
                reject(new Error(`${label}: no series (${out.slice(0, 200)})`));
            }
        });
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, { strings: ['out'], lists: { conditions: String } });
    if (options.loop) { loop(options.seconds); return; }
    const windows = process.platform === 'win32';
    const all = windows ? [
        { id: 'default', label: 'Windows default' },
        { id: 'p-core', label: 'pinned to P-core (logical CPU 2)', affinity: '4' },
        { id: 'e-core', label: 'pinned to E-core (logical CPU 23)', affinity: '800000' },
        { id: 'high-priority', label: 'high process priority', highPriority: true },
        { id: 'opted-out', label: 'power throttling opted out', optOut: true },
    ] : [{ id: 'default', label: 'default' }];
    const conditions = options.conditions ? all.filter((c) => options.conditions.includes(c.id)) : all;
    const results = [];
    for (let run = 0; run < options.repeat; run += 1) {
        const order = conditions.map((_, i) => conditions[(i + run) % conditions.length]);
        for (const condition of order) {
            const result = { run, ...(await runCondition(condition, options.seconds)) };
            results.push(result);
            process.stdout.write(`run ${run + 1} ${result.label.padEnd(36)} initial=${Math.round(result.initial)} `
                + `after3s=${result.after3s} steady=${Math.round(result.steady)} ratio=${result.ratio.toFixed(2)}\n`);
        }
    }
    const summary = conditions.map((c) => {
        const runs = results.filter((r) => r.id === c.id);
        return {
            id: c.id, label: c.label, runs: runs.length,
            initial: mean(runs.map((r) => r.initial)),
            after3s: mean(runs.map((r) => r.after3s)),
            steady: mean(runs.map((r) => r.steady)),
            ratio: mean(runs.map((r) => r.ratio)),
            ratioMin: Math.min(...runs.map((r) => r.ratio)),
            ratioMax: Math.max(...runs.map((r) => r.ratio)),
        };
    });
    const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
    const record = {
        schema: 'cloudproof.power-throttling-probe/v1',
        capturedAt: new Date().toISOString(),
        git: { sha: git('rev-parse HEAD'), dirty: git('status --porcelain --untracked-files=no').length > 0 },
        node: process.version,
        cpu: os.cpus()[0].model,
        logicalCores: os.cpus().length,
        method: 'SHA-256 of 1 KiB in a fresh child process; hashes per 500 ms over the run; beforeMean = first five samples (0-2.5 s), afterMean = samples from 3.5 s on; initial = 0-2.5 s, after3s = 3.5-4.0 s sample, steady = 4 s to end, ratio = steady / initial',
        repeat: options.repeat,
        summary,
        conditions: results,
    };
    fs.mkdirSync(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(record, null, 2)}\n`);
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    });
}
