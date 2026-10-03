'use strict';

/**
 * disk-sentinel.js — which fsync regime was the disk in for a trial?
 *
 * The benchmark laptop's NVMe/NTFS fsync latency switches between regimes for
 * tens of seconds at a time, with no other writer on the machine: a bare
 * append+fsync has been observed at about 0.35 ms, about 0.75-1.0 ms and about
 * 2-3.5 ms. Every durable
 * configuration inherits whichever regime it lands in, and the configuration
 * under test changes the fsync pattern, so its own fsync timings cannot tell
 * the regimes apart. This probe can: the same fixed pattern (300 appends of
 * 1 100 bytes, each fsynced, over one second, the shape of one baseline
 * replica's log at its knee), in its own file, immediately before each trial
 * with nothing else of the benchmark running, and again after it.
 *
 * The pre-registered regime bins (methodology.json, amendment 1) use the
 * median of the sample taken immediately before the trial, with edges in the
 * gaps between every mode observed so far.
 */

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { LogLinearHistogram } = require('../../replica/perf-histogram');

const SENTINEL = Object.freeze({
    version: 1,
    durationMs: 1000,
    fsyncsPerSecond: 300,
    recordBytes: 1100,
    // median < 0.5 ms: fast; 0.5-1.5 ms: intermediate; >= 1.5 ms: slow
    regimeEdgesMs: Object.freeze([0.5, 1.5]),
    regimes: Object.freeze(['fast', 'intermediate', 'slow']),
});

const round = (value) => Number(value.toFixed(4));

/**
 * Appends + fsyncs `recordBytes` at `fsyncsPerSecond` for `durationMs` and
 * returns the distribution of the individual write+fsync times.
 */
function probeDisk(dir, {
    durationMs = SENTINEL.durationMs, rate = SENTINEL.fsyncsPerSecond, bytes = SENTINEL.recordBytes,
} = {}) {
    return new Promise((resolve) => {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'disk-sentinel.log');
        fs.rmSync(file, { force: true });
        const fd = fs.openSync(file, 'a');
        const payload = `${'s'.repeat(bytes - 1)}\n`;
        const histogram = new LogLinearHistogram();
        const startedAt = new Date().toISOString();
        const start = performance.now();
        const interval = 1000 / rate;
        let next = start;
        const tick = () => {
            const now = performance.now();
            while (next <= now) {
                const t0 = performance.now();
                fs.writeSync(fd, payload);
                fs.fsyncSync(fd);
                histogram.record((performance.now() - t0) * 1000);
                next += interval;
            }
            if (performance.now() - start >= durationMs) {
                fs.closeSync(fd);
                fs.rmSync(file, { force: true });
                resolve({
                    medianFsyncMs: round(histogram.percentile(50) / 1000),
                    p95FsyncMs: round(histogram.percentile(95) / 1000),
                    p99FsyncMs: round(histogram.percentile(99) / 1000),
                    sampleCount: histogram.count,
                    startedAt,
                    finishedAt: new Date().toISOString(),
                });
                return;
            }
            const wait = next - performance.now();
            if (wait > 17) setTimeout(tick, wait - 17); else setImmediate(tick);
        };
        tick();
    });
}

/** 'fast' | 'intermediate' | 'slow' from one sample's median; 'unknown' without a sample. */
function regimeOf(sample) {
    if (!sample || !Number.isFinite(sample.medianFsyncMs) || !sample.sampleCount) return 'unknown';
    const bin = SENTINEL.regimeEdgesMs.filter((edge) => sample.medianFsyncMs >= edge).length;
    return SENTINEL.regimes[bin];
}

/**
 * The record a trial carries. The top-level fields are the sample taken
 * immediately before the trial, which defines the trial's regime; `after` is
 * the same probe once the cluster has stopped, kept to show regime changes
 * during a trial.
 */
function sentinelRecord(before, after, { windowOpenedAt = null } = {}) {
    const regime = regimeOf(before);
    const afterRegime = regimeOf(after);
    return {
        version: SENTINEL.version,
        medianFsyncMs: before ? before.medianFsyncMs : null,
        p95FsyncMs: before ? before.p95FsyncMs : null,
        p99FsyncMs: before ? before.p99FsyncMs : null,
        sampleCount: before ? before.sampleCount : 0,
        sampledImmediatelyBeforeTrial: Boolean(before),
        sampledAt: before ? before.finishedAt : null,
        msFromSampleToWindowOpen: before && windowOpenedAt
            ? Date.parse(windowOpenedAt) - Date.parse(before.finishedAt) : null,
        regime,
        after: after || null,
        afterRegime,
        regimeChangedDuringTrial: regime !== 'unknown' && afterRegime !== 'unknown' && regime !== afterRegime,
    };
}

module.exports = { SENTINEL, probeDisk, regimeOf, sentinelRecord };
