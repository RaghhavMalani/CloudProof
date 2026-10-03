#!/usr/bin/env node
'use strict';

/**
 * raft-fsync-probe.js — characterizes the benchmark disk's fsync latency over
 * time, independent of Raft.
 *
 *   node tools/raft-fsync-probe.js --seconds 90 --rate 300 --bytes 1100 --out <file.json>
 *
 * Appends `bytes` and fsyncs at a fixed rate (the same pattern as one baseline
 * replica's log), and reports per-second p50/p99 plus the overall
 * distribution. Used to explain run-to-run variance in the Raft benchmarks:
 * if fsync latency itself switches between modes, every durable system on this
 * machine inherits those modes.
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { LogLinearHistogram } = require('../replica/perf-histogram');
const { parseArgs } = require('../packages/raft-bench/cli');

const options = parseArgs(process.argv.slice(2), {
    seconds: 90, rate: 300, bytes: 1100, out: null,
    dir: path.join(__dirname, '..', '.bench-data', 'fsync-probe'),
}, { strings: ['out', 'dir'] });

fs.rmSync(options.dir, { recursive: true, force: true });
fs.mkdirSync(options.dir, { recursive: true });
const fd = fs.openSync(path.join(options.dir, 'probe.log'), 'a');
const payload = `${'x'.repeat(Math.max(1, options.bytes - 1))}\n`;
const overall = new LogLinearHistogram();
const perSecond = [];
const start = performance.now();
const interval = 1000 / options.rate;
let next = start;
let current = new LogLinearHistogram();
let second = 0;

function tick() {
    const now = performance.now();
    while (next <= now) {
        const t0 = performance.now();
        fs.writeSync(fd, payload);
        fs.fsyncSync(fd);
        const us = (performance.now() - t0) * 1000;
        overall.record(us);
        current.record(us);
        next += interval;
    }
    const elapsedSecond = Math.floor((performance.now() - start) / 1000);
    if (elapsedSecond > second) {
        perSecond.push({ second, p50Ms: current.percentile(50) / 1000, p99Ms: current.percentile(99) / 1000, count: current.count });
        current = new LogLinearHistogram();
        second = elapsedSecond;
    }
    if (performance.now() - start >= options.seconds * 1000) return finish();
    const wait = next - performance.now();
    if (wait > 17) setTimeout(tick, wait - 17); else setImmediate(tick);
    return undefined;
}

function finish() {
    fs.closeSync(fd);
    fs.rmSync(options.dir, { recursive: true, force: true });
    const summary = {
        schema: 'cloudproof.raft-bench.fsync-probe/v1',
        capturedAt: new Date().toISOString(),
        rate: options.rate,
        bytes: options.bytes,
        seconds: options.seconds,
        overallMs: overall.summary(1000),
        perSecond,
    };
    if (options.out) fs.writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
    const line = perSecond.map((s) => s.p50Ms.toFixed(2)).join(' ');
    process.stdout.write(`overall p50=${summary.overallMs.p50}ms p99=${summary.overallMs.p99}ms\nper-second p50: ${line}\n`);
}

tick();
