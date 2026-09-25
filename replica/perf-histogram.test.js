const assert = require('node:assert/strict');
const test = require('node:test');

const { LogLinearHistogram, indexFor, boundsFor, BUCKET_COUNT, MAX_VALUE } = require('./perf-histogram');

test('values below 2048 are stored exactly', () => {
    const h = new LogLinearHistogram();
    for (let v = 0; v < 2048; v += 1) h.record(v);
    assert.equal(h.count, 2048);
    assert.equal(h.percentile(50), 1023);
    assert.equal(h.percentile(100), 2047);
    assert.equal(h.min, 0);
    assert.equal(h.max, 2047);
});

test('bucket bounds are contiguous and relative error stays under 0.1%', () => {
    let previousUpper = -1;
    for (let index = 0; index < BUCKET_COUNT; index += 1) {
        const [lower, upper] = boundsFor(index);
        assert.equal(lower, previousUpper + 1, `bucket ${index} starts where ${index - 1} ended`);
        assert.ok(upper >= lower);
        assert.ok((upper - lower) / Math.max(1, lower) <= 1 / 1024 + 1e-12);
        previousUpper = upper;
    }
    assert.equal(previousUpper, MAX_VALUE);
    for (const value of [0, 1, 2047, 2048, 2049, 4095, 4096, 123456, 999999, 2 ** 31, MAX_VALUE]) {
        const [lower, upper] = boundsFor(indexFor(value));
        assert.ok(value >= lower && value <= upper, `${value} lies in its own bucket`);
    }
});

test('percentiles report the conservative bucket upper bound, capped at max', () => {
    const h = new LogLinearHistogram();
    for (let i = 1; i <= 1000; i += 1) h.record(i * 1000); // 1..1000 ms in us
    const p99 = h.percentile(99);
    assert.ok(p99 >= 990000 && p99 <= 990000 * (1 + 1 / 1024), `p99=${p99}`);
    assert.equal(h.percentile(100), 1000000);
    assert.equal(h.summary(1000).p50 >= 500, true);
    assert.equal(new LogLinearHistogram().percentile(99), null);
});

test('merge equals recording everything into one histogram', () => {
    const a = new LogLinearHistogram();
    const b = new LogLinearHistogram();
    const all = new LogLinearHistogram();
    for (let i = 0; i < 5000; i += 1) {
        const v = (i * 7919) % 250000;
        (i % 2 ? a : b).record(v);
        all.record(v);
    }
    a.merge(b);
    assert.deepEqual(a.toJSON(), all.toJSON());
});

test('JSON round trip is lossless and clamps are counted, not hidden', () => {
    const h = new LogLinearHistogram();
    h.record(42);
    h.record(5e9); // beyond 2^32 - 1
    h.record(-3);  // negative rounds to 0
    const back = LogLinearHistogram.fromJSON(JSON.parse(JSON.stringify(h.toJSON())));
    assert.deepEqual(back.toJSON(), h.toJSON());
    assert.equal(back.clamped, 1);
    assert.equal(back.max, MAX_VALUE);
    assert.equal(back.min, 0);
    assert.equal(back.fractionAbove(100), 1 / 3);
});
