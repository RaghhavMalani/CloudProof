const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { williamsRow, orderedRound, ORDER_SCHEME } = require('./order');
const { regimeOf, sentinelRecord, SENTINEL } = require('./disk-sentinel');
const { CONFIGS } = require('./configs');
const { PROFILES } = require('../../replica/raft-profiles');

const ROOT = path.join(__dirname, '..', '..');
const PERF = path.join(ROOT, 'artifacts', 'perf', 'phase-iv-a');

test('Williams rows balance positions and first-order carry-over for every round size', () => {
    for (let k = 1; k <= 16; k += 1) {
        const period = k % 2 === 0 ? k : 2 * k;
        const position = Array.from({ length: k }, () => Array(k).fill(0));
        const follows = Array.from({ length: k }, () => Array(k).fill(0));
        for (let round = 0; round < period; round += 1) {
            const row = williamsRow(k, round);
            assert.deepEqual([...row].sort((a, b) => a - b), [...Array(k).keys()], `k=${k} round=${round} is a permutation`);
            row.forEach((item, p) => { position[item][p] += 1; });
            for (let p = 1; p < k; p += 1) follows[row[p - 1]][row[p]] += 1;
        }
        const expected = period / k;
        for (const counts of position) for (const count of counts) assert.equal(count, expected, `k=${k} position balance`);
        for (let a = 0; a < k; a += 1) {
            for (let b = 0; b < k; b += 1) if (a !== b) assert.equal(follows[a][b], k % 2 === 0 ? 1 : 2, `k=${k} ${a}->${b}`);
        }
    }
});

test('the order is a pure function of the round and the items', () => {
    const items = ['a', 'b', 'c', 'd', 'e'];
    assert.deepEqual(orderedRound(items, 7), orderedRound(items, 7));
    assert.deepEqual(orderedRound(items, 7), orderedRound(items, 17));
    assert.equal(ORDER_SCHEME.name, 'williams-latin');
});

test('disk regimes use the pre-registered bins on the pre-trial median', () => {
    const at = (medianFsyncMs) => regimeOf({ medianFsyncMs, sampleCount: 300 });
    assert.deepEqual(SENTINEL.regimeEdgesMs, [0.5, 1.5]);
    assert.equal(at(0.35), 'fast');
    assert.equal(at(0.5), 'intermediate');
    assert.equal(at(0.9), 'intermediate');
    assert.equal(at(1.5), 'slow');
    assert.equal(at(3.2), 'slow');
    assert.equal(regimeOf(null), 'unknown');
    assert.equal(regimeOf({ medianFsyncMs: 0.3, sampleCount: 0 }), 'unknown');
});

test('every trial record carries the five required sentinel fields', () => {
    const before = { medianFsyncMs: 0.4, p95FsyncMs: 0.9, p99FsyncMs: 2.1, sampleCount: 300, finishedAt: '2026-10-03T00:00:00.000Z' };
    const after = { medianFsyncMs: 2.4, p95FsyncMs: 3.0, p99FsyncMs: 4.0, sampleCount: 300, finishedAt: '2026-10-03T00:00:40.000Z' };
    const record = sentinelRecord(before, after, { windowOpenedAt: '2026-10-03T00:00:07.500Z' });
    for (const field of ['medianFsyncMs', 'p95FsyncMs', 'p99FsyncMs', 'sampleCount', 'sampledImmediatelyBeforeTrial']) {
        assert.ok(field in record, field);
    }
    assert.equal(record.sampledImmediatelyBeforeTrial, true);
    assert.equal(record.regime, 'fast');
    assert.equal(record.afterRegime, 'slow');
    assert.equal(record.regimeChangedDuringTrial, true);
    assert.equal(record.msFromSampleToWindowOpen, 7500);
});

test('the frozen plan names exactly the nine configurations, each a replica profile, and matches the amendment', () => {
    const planText = fs.readFileSync(path.join(PERF, 'comparison-plan.json'));
    const plan = JSON.parse(planText);
    const methodology = JSON.parse(fs.readFileSync(path.join(PERF, 'methodology.json'), 'utf8'));
    const amendment = methodology.amendments.find((a) => a.id === 1);
    assert.equal(crypto.createHash('sha256').update(planText).digest('hex'), amendment.changes.plan.sha256);

    const primary = plan.curves.filter((c) => c.payloadBytes === plan.primaryPayloadBytes).map((c) => c.config);
    assert.deepEqual(primary, ['baseline', 'group-commit', 'pipeline-only', 'batch-only', 'group-batch',
        'group-batch-pipeline', 'optimized-http', 'optimized-binary', 'transport-only']);
    assert.deepEqual(Object.keys(CONFIGS), primary);
    for (const name of primary) {
        assert.ok(PROFILES[name], `${name} is a replica profile`);
        assert.deepEqual(CONFIGS[name].env, name === 'baseline' ? {} : { RAFT_PROFILE: name });
    }
    assert.deepEqual(plan.rates, methodology.rateLadder);
    assert.ok(plan.curves.every((c) => c.repetitions === (c.payloadBytes === 1024 ? 5 : 3)));
});

test('optimized-http and optimized-binary differ only in the transport', () => {
    const { wire, ...binary } = PROFILES['optimized-binary'];
    assert.equal(wire, 'framed-tcp');
    assert.deepEqual(binary, { ...PROFILES['optimized-http'] });
    assert.equal(PROFILES['optimized-http'].logHotPath, false);
});
