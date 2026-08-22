'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rng, VirtualClock } = require('../../sim/simulator');
const { validateEvent } = require('../protocol/events');
const {
    DELIVERY_MODES,
    EventLog,
    OffsetOutOfRangeError,
} = require('./log');

function makeLog(seed, options = {}) {
    const clock = new VirtualClock(1_700_000_000_000);
    const rng = new Rng(seed);
    return { clock, rng, log: new EventLog({ partitions: 2, clock, rng, ...options }) };
}

function keyForPartition(log, topic, wanted) {
    for (let index = 0; index < 10_000; index += 1) {
        const key = `card-${index}`;
        if (log.partitionFor(topic, key) === wanted) return key;
    }
    throw new Error(`could not find a key for partition ${wanted}`);
}

function transaction(cardId, amountCents, eventTimeMs) {
    return {
        key: cardId,
        eventTimeMs,
        value: {
            cardId,
            merchantId: 'merchant-7',
            amountCents,
            eventTimeMs,
            mcc: '5411',
            country: 'IN',
        },
    };
}

test('seed 11: ordering is append order within a partition, never a global-order promise', () => {
    const { log } = makeLog(11);
    const topic = 'transactions';
    const p0 = keyForPartition(log, topic, 0);
    const p1 = keyForPartition(log, topic, 1);

    assert.deepEqual(log.append(topic, transaction(p0, 300, 30)), { partition: 0, offset: 0 });
    assert.deepEqual(log.append(topic, transaction(p1, 100, 10)), { partition: 1, offset: 0 });
    assert.deepEqual(log.append(topic, transaction(p0, 200, 20)), { partition: 0, offset: 1 });

    assert.deepEqual(log.read(topic, 0, 0).map((record) => record.value.amountCents), [300, 200]);
    assert.deepEqual(log.read(topic, 1, 0).map((record) => record.value.amountCents), [100]);

    const group = log.subscribe(topic, { groupId: 'features', consumers: 2 });
    // Polling walks assigned partitions deterministically. It preserves each
    // partition's offsets but quite deliberately does not reconstruct append
    // order or sort by event time across them.
    assert.deepEqual(group.poll().map((record) => record.value.amountCents), [300, 200, 100]);
});

test('seed 12: consumer groups commit independent next offsets', () => {
    const { log } = makeLog(12, { partitions: 1 });
    log.append('transactions', transaction('card-a', 100, 1));
    log.append('transactions', transaction('card-a', 200, 2));
    const features = log.subscribe('transactions', { groupId: 'features', consumers: 1 });
    const audit = log.subscribe('transactions', { groupId: 'audit', consumers: 1 });

    features.commit(features.poll({ maxRecords: 1 }));
    assert.equal(features.committedOffset(0), 1);
    assert.equal(audit.committedOffset(0), 0);
    assert.deepEqual(audit.poll().map((record) => record.offset), [0, 1]);
});

test('seed 13: a rebalance between processing and commit neither rewinds nor skips committed offsets', () => {
    const { log } = makeLog(13);
    const topic = 'transactions';
    const p0 = keyForPartition(log, topic, 0);
    const p1 = keyForPartition(log, topic, 1);
    for (let index = 0; index < 2; index += 1) {
        log.append(topic, transaction(p0, 100 + index, index));
        log.append(topic, transaction(p1, 200 + index, index));
    }
    const group = log.subscribe(topic, { groupId: 'features', consumers: 2 });
    const processed = group.poll({ maxRecords: 100 });

    group.rebalance({ consumers: 3 });
    group.commit(processed);
    assert.equal(group.committedOffset(0), 2);
    assert.equal(group.committedOffset(1), 2);
    assert.deepEqual(group.poll(), []);

    const { offset } = log.append(topic, transaction(p0, 999, 9));
    const beforeCrash = group.poll();
    assert.equal(beforeCrash[0].offset, offset);
    group.process(beforeCrash, () => {}, { crashBeforeCommit: true });
    group.rebalance({ consumers: 2 });
    assert.equal(group.poll()[0].offset, offset, 'only the uncommitted record is redelivered');
});

test('seed 14: at-least-once exposes the crash gap while exactly-once commits effect and offset atomically', () => {
    const { log } = makeLog(14, { partitions: 1 });
    log.append('transactions', transaction('card-a', 500, 1));
    const increment = (record, effects) => {
        effects.set('count', (effects.get('count') || 0) + 1);
    };

    const atLeastOnce = log.subscribe('transactions', {
        groupId: 'at-least-once', consumers: 1, delivery: DELIVERY_MODES.AT_LEAST_ONCE,
    });
    atLeastOnce.process(atLeastOnce.poll(), increment, { crashBeforeCommit: true });
    assert.equal(atLeastOnce.effect('count'), 1);
    assert.equal(atLeastOnce.committedOffset(0), 0);
    atLeastOnce.process(atLeastOnce.poll(), increment);
    assert.equal(atLeastOnce.effect('count'), 2, 'the visible first effect is applied again on redelivery');

    const exactlyOnce = log.subscribe('transactions', {
        groupId: 'exactly-once', consumers: 1, delivery: DELIVERY_MODES.EXACTLY_ONCE,
    });
    exactlyOnce.process(exactlyOnce.poll(), increment, { crashBeforeCommit: true });
    assert.equal(exactlyOnce.effect('count'), undefined, 'an aborted transaction exposes no effect');
    assert.equal(exactlyOnce.committedOffset(0), 0);
    exactlyOnce.process(exactlyOnce.poll(), increment);
    assert.equal(exactlyOnce.effect('count'), 1);
    exactlyOnce.rebalance({ consumers: 1 });
    assert.deepEqual(exactlyOnce.poll(), [], 'a committed transaction is not redelivered');
});

test('seed 15: count and byte retention make truncated offsets fail loudly', () => {
    const byCount = makeLog(15, { partitions: 1, retention: { maxRecords: 2 } }).log;
    for (let index = 0; index < 3; index += 1) {
        byCount.append('transactions', transaction('card-a', index, index));
    }
    assert.deepEqual(byCount.offsets('transactions', 0), { earliest: 1, latest: 3 });
    assert.throws(
        () => byCount.read('transactions', 0, 0),
        (error) => error instanceof OffsetOutOfRangeError && error.code === 'OFFSET_OUT_OF_RANGE',
    );
    assert.deepEqual(byCount.read('transactions', 0, 1).map((record) => record.offset), [1, 2]);

    const bySize = makeLog(15, { partitions: 1, retention: { maxBytes: 1 } }).log;
    bySize.append('transactions', transaction('card-a', 1, 1));
    assert.deepEqual(bySize.offsets('transactions', 0), { earliest: 1, latest: 1 });
    assert.throws(() => bySize.read('transactions', 0, 0), OffsetOutOfRangeError);
});

test('seed 16: causal traces validate and the same seed is byte-identical', () => {
    function trace(seed) {
        const { log, rng } = makeLog(seed, { partitions: 2, runId: `stream-${seed}` });
        for (let index = 0; index < 6; index += 1) {
            const cardId = `card-${rng.int(4)}`;
            log.append('transactions', transaction(cardId, rng.range(100, 10_000), index * 10));
        }
        const group = log.subscribe('transactions', { groupId: 'features', consumers: 2 });
        group.process(group.poll(), (record, effects) => {
            effects.set(record.key, (effects.get(record.key) || 0) + record.value.amountCents);
        });
        assert.ok(log.events.every((event) => validateEvent(event).ok));
        return JSON.stringify(log.events);
    }

    assert.equal(trace(16), trace(16));
});
