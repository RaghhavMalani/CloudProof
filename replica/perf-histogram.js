'use strict';

/**
 * perf-histogram.js — a log-linear latency histogram in the HdrHistogram style.
 *
 * Values are non-negative integers in a fixed unit (microseconds everywhere in
 * Phase IV-A). Below 2048 every value has its own bucket, so it is exact. Above
 * that, each power of two is split into 1024 linear sub-buckets, which bounds
 * the relative error at 1/1024 (about 0.1%, three significant digits) up to
 * 2^32 - 1 units, roughly 71 minutes of microseconds. Larger values clamp to
 * the top bucket and are counted in `clamped`, so a clamp is never silent.
 *
 * Percentiles return the *upper* bound of the bucket that holds the requested
 * rank, which is what HdrHistogram calls the highest equivalent value. That is
 * the conservative direction for latency: a reported p99 is never lower than
 * the true p99 by more than the bucket width.
 *
 * Histograms of the same shape merge by adding counts, which is how the load
 * generator workers and repeated trials are combined without keeping every raw
 * sample.
 */

const EXACT_LIMIT = 2048;          // values below this are stored exactly
const SUB_BUCKETS = 1024;          // linear sub-buckets per power of two above it
const MAX_VALUE = 0xffffffff;      // 2^32 - 1
const BUCKET_COUNT = EXACT_LIMIT + 21 * SUB_BUCKETS; // e = 1..21 covers 2^11..2^32-1

function indexFor(value) {
    if (value < EXACT_LIMIT) return value;
    const exponent = (31 - Math.clz32(value)) - 10; // value >>> exponent lands in [1024, 2047]
    return EXACT_LIMIT + (exponent - 1) * SUB_BUCKETS + ((value >>> exponent) - SUB_BUCKETS);
}

/** Smallest and largest value that map to `index`. */
function boundsFor(index) {
    if (index < EXACT_LIMIT) return [index, index];
    const offset = index - EXACT_LIMIT;
    const exponent = Math.floor(offset / SUB_BUCKETS) + 1;
    const mantissa = SUB_BUCKETS + (offset % SUB_BUCKETS);
    const width = 2 ** exponent;
    return [mantissa * width, (mantissa + 1) * width - 1];
}

class LogLinearHistogram {
    constructor({ unit = 'us' } = {}) {
        this.unit = unit;
        this.counts = new Float64Array(BUCKET_COUNT);
        this.reset();
    }

    reset() {
        this.counts.fill(0);
        this.count = 0;
        this.sum = 0;
        this.min = Infinity;
        this.max = -Infinity;
        this.clamped = 0;
    }

    /** Records one value (rounded to an integer, clamped to [0, 2^32 - 1]). */
    record(value, times = 1) {
        let v = Math.round(value);
        if (!Number.isFinite(v) || v < 0) v = 0;
        if (v > MAX_VALUE) { v = MAX_VALUE; this.clamped += times; }
        this.counts[indexFor(v)] += times;
        this.count += times;
        this.sum += v * times;
        if (v < this.min) this.min = v;
        if (v > this.max) this.max = v;
    }

    merge(other) {
        if (!other || other.count === 0) return this;
        for (let i = 0; i < BUCKET_COUNT; i += 1) {
            if (other.counts[i] !== 0) this.counts[i] += other.counts[i];
        }
        this.count += other.count;
        this.sum += other.sum;
        this.clamped += other.clamped;
        if (other.min < this.min) this.min = other.min;
        if (other.max > this.max) this.max = other.max;
        return this;
    }

    /**
     * Value at percentile `q` (0 < q <= 100): the upper bound of the bucket that
     * contains rank ceil(q/100 * count). The top bucket is capped at the exact
     * recorded maximum so p100 equals `max`.
     */
    percentile(q) {
        if (this.count === 0) return null;
        const rank = Math.max(1, Math.ceil((q / 100) * this.count));
        let seen = 0;
        for (let i = 0; i < BUCKET_COUNT; i += 1) {
            seen += this.counts[i];
            if (seen >= rank) return Math.min(boundsFor(i)[1], this.max);
        }
        return this.max;
    }

    mean() {
        return this.count === 0 ? null : this.sum / this.count;
    }

    /** Fraction of recorded values strictly greater than `value`. */
    fractionAbove(value) {
        if (this.count === 0) return 0;
        const limit = indexFor(Math.min(MAX_VALUE, Math.max(0, Math.round(value))));
        let above = 0;
        for (let i = limit + 1; i < BUCKET_COUNT; i += 1) above += this.counts[i];
        return above / this.count;
    }

    summary(scale = 1) {
        const at = (q) => {
            const v = this.percentile(q);
            return v === null ? null : v / scale;
        };
        return {
            count: this.count,
            min: this.count ? this.min / scale : null,
            mean: this.count ? this.mean() / scale : null,
            p50: at(50),
            p90: at(90),
            p95: at(95),
            p99: at(99),
            p999: at(99.9),
            max: this.count ? this.max / scale : null,
        };
    }

    /**
     * Sparse, JSON-safe, lossless export. Non-empty buckets are stored as runs
     * of consecutive indexes, `[firstIndex, count, count, ...]`, because
     * latency distributions occupy contiguous ranges and this halves the size
     * of the committed trial records compared with one pair per bucket.
     */
    toJSON() {
        const runs = [];
        let run = null;
        for (let i = 0; i < BUCKET_COUNT; i += 1) {
            const c = this.counts[i];
            if (c === 0) { run = null; continue; }
            if (!run) { run = [i]; runs.push(run); }
            run.push(c);
        }
        return {
            format: 'log-linear-v2',
            unit: this.unit,
            count: this.count,
            sum: this.sum,
            min: this.count ? this.min : null,
            max: this.count ? this.max : null,
            clamped: this.clamped,
            runs,
        };
    }

    static fromJSON(json) {
        if (!json || (json.format !== 'log-linear-v1' && json.format !== 'log-linear-v2')) {
            throw new TypeError('not a log-linear histogram');
        }
        const histogram = new LogLinearHistogram({ unit: json.unit });
        if (json.format === 'log-linear-v1') {
            for (const [index, count] of json.buckets) histogram.counts[index] = count;
        } else {
            for (const run of json.runs) {
                for (let k = 1; k < run.length; k += 1) histogram.counts[run[0] + k - 1] = run[k];
            }
        }
        histogram.count = json.count;
        histogram.sum = json.sum;
        histogram.min = json.min === null ? Infinity : json.min;
        histogram.max = json.max === null ? -Infinity : json.max;
        histogram.clamped = json.clamped || 0;
        return histogram;
    }
}

module.exports = { LogLinearHistogram, indexFor, boundsFor, BUCKET_COUNT, MAX_VALUE };
