#!/usr/bin/env node
'use strict';

/**
 * raft-power-throttling-probe.js — does this machine throttle a busy
 * background process, and does the per-process opt-out remove it?
 *
 *   node tools/raft-power-throttling-probe.js [--out artifacts/perf/phase-iv-a/power-throttling-probe.json]
 *
 * Each condition runs a pure CPU loop (SHA-256 of 1 KiB, no I/O) in a fresh
 * child process for 8 s and records hashes per 500 ms. Conditions: Windows
 * default; pinned to one performance core; pinned to one efficiency core;
 * high process priority; opted out of power throttling
 * (packages/raft-bench/power-throttling.js). Windows only; elsewhere it records
 * the default condition alone.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execSync } = require('child_process');
const { parseArgs } = require('../packages/raft-bench/cli');
const { disablePowerThrottling } = require('../packages/raft-bench/power-throttling');

const ROOT = path.join(__dirname, '..');
const DEFAULTS = { out: path.join(ROOT, 'artifacts', 'perf', 'phase-iv-a', 'power-throttling-probe.json'), loop: null, seconds: 8 };

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

function runCondition({ label, affinity = null, highPriority = false, optOut = false }, seconds) {
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
        let applied = null;
        if (optOut) applied = disablePowerThrottling([child.pid]);
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('exit', () => {
            try {
                const series = JSON.parse(out.trim());
                const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
                resolve({
                    label, affinity, highPriority, optOut, optOutApplied: applied, series,
                    beforeMean: mean(series.slice(0, 5)),
                    afterMean: mean(series.slice(7)),
                });
            } catch (error) {
                reject(new Error(`${label}: no series (${out.slice(0, 200)})`));
            }
        });
    });
}

async function main() {
    const options = parseArgs(process.argv.slice(2), DEFAULTS, { strings: ['out'] });
    if (options.loop) { loop(options.seconds); return; }
    const windows = process.platform === 'win32';
    const conditions = windows ? [
        { label: 'Windows default' },
        { label: 'pinned to P-core (logical CPU 2)', affinity: '4' },
        { label: 'pinned to E-core (logical CPU 23)', affinity: '800000' },
        { label: 'high process priority', highPriority: true },
        { label: 'power throttling opted out', optOut: true },
    ] : [{ label: 'default' }];
    const results = [];
    for (const condition of conditions) {
        const result = await runCondition(condition, options.seconds);
        results.push(result);
        process.stdout.write(`${result.label.padEnd(36)} ${result.series.join(' ')}\n`);
    }
    const git = (args) => execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8' }).trim();
    const record = {
        schema: 'cloudproof.power-throttling-probe/v1',
        capturedAt: new Date().toISOString(),
        git: { sha: git('rev-parse HEAD'), dirty: git('status --porcelain --untracked-files=no').length > 0 },
        node: process.version,
        cpu: os.cpus()[0].model,
        logicalCores: os.cpus().length,
        method: 'SHA-256 of 1 KiB in a fresh child process; hashes per 500 ms over the run; beforeMean = first five samples (0-2.5 s), afterMean = samples from 3.5 s on',
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
