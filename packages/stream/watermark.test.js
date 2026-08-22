'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Rng, VirtualClock } = require('../../sim/simulator');
const { validateEvent } = require('../protocol/events');
const {
    EventTimeWindowProcessor,
    LATE_POLICIES,
} = require('./watermark');

function makeProcessor(seed, options = {}) {
    const clock = new VirtualClock(1_700_000_000_000);
    const rng = new Rng(seed);
    const processor = new EventTimeWindowProcessor({
        partitions: 2,
        clock,
        rng,
        allowedLatenessMs: 0,
        idleTimeoutMs: 10_000,
        window: { type: 'tumbling', sizeMs: 10 },
        ...options,
    });
    return { clock, rng, processor };
}

function record(partition, eventTimeMs, amountCents = 100) {
    return {
        partition,
        key: `card-${partition}`,
        eventTimeMs,
        value: {
            cardId: `card-${partition}`,
            merchantId: 'merchant-7',
            amountCents,
            eventTimeMs,
            mcc: '5411',
            country: 'IN',
        },
    };
}

test('seed 21: a partition and stream watermark never decrease when older data arrives', () => {
    const { processor } = makeProcessor(21, { allowedLatenessMs: 10 });
    processor.ingest(record(0, 100));
    processor.ingest(record(1, 80));
    assert.equal(processor.partitionWatermark(0), 90);
    assert.equal(processor.watermark(), 70);

    processor.ingest(record(0, 5));
    assert.equal(processor.partitionWatermark(0), 90);
    assert.equal(processor.watermark(), 70);
    processor.ingest(record(1, 120));
    assert.equal(processor.watermark(), 90);
    processor.close();
});

test('seed 22: the stream watermark is the minimum across active partitions', () => {
    const { processor } = makeProcessor(22, { allowedLatenessMs: 5 });
    processor.ingest(record(0, 100));
    assert.equal(processor.partitionWatermark(0), 95);
    assert.equal(processor.watermark(), -Infinity, 'the unseen active partition holds progress back');

    processor.ingest(record(1, 30));
    assert.equal(processor.partitionWatermark(1), 25);
    assert.equal(processor.watermark(), 25, 'using max here would close windows seventy milliseconds early');
    processor.ingest(record(1, 80));
    assert.equal(processor.watermark(), 75);
    processor.close();
});

test('seed 23: a tumbling window emits only after the watermark passes its end', () => {
    const { processor } = makeProcessor(23, { partitions: 1 });
    processor.ingest(record(0, 1));
    processor.ingest(record(0, 10));
    assert.deepEqual(processor.drainEmissions(), [], 'watermark equal to the end is not enough');

    processor.ingest(record(0, 11));
    const emissions = processor.drainEmissions();
    assert.equal(emissions.length, 1);
    assert.deepEqual(emissions[0], {
        kind: 'initial',
        window: { startMs: 0, endMs: 10 },
        result: 1,
        watermark: 11,
        processingTimeMs: 1_700_000_000_000,
    });
    processor.close();
});

test('seed 24: every late-data policy counts the record and makes its outcome visible', async (t) => {
    for (const policy of Object.values(LATE_POLICIES)) {
        await t.test(policy, () => {
            const { processor } = makeProcessor(24, {
                partitions: 1,
                latePolicy: policy,
                windowRetentionMs: 100,
            });
            processor.ingest(record(0, 1));
            processor.ingest(record(0, 11));
            processor.drainEmissions();
            const outcome = processor.ingest(record(0, 2));

            assert.equal(outcome.late, true);
            assert.equal(processor.metrics.lateRecords, 1);
            if (policy === LATE_POLICIES.DROP) {
                assert.equal(processor.metrics.droppedLateRecords, 1);
                assert.equal(processor.getWindow(0, 10).result, 1);
            } else if (policy === LATE_POLICIES.SIDE_OUTPUT) {
                assert.equal(processor.metrics.sideOutputRecords, 1);
                assert.equal(processor.sideOutput.length, 1);
                assert.equal(processor.getWindow(0, 10).result, 1);
            } else {
                assert.equal(processor.metrics.updatedLateRecords, 1);
                const correction = processor.drainEmissions();
                assert.equal(correction.length, 1);
                assert.equal(correction[0].kind, 'update');
                assert.equal(correction[0].result, 2);
            }
            processor.close();
        });
    }
});

test('seed 25: update cannot resurrect a window after retention expires', () => {
    const { processor } = makeProcessor(25, {
        partitions: 1,
        latePolicy: LATE_POLICIES.UPDATE,
        windowRetentionMs: 0,
    });
    processor.ingest(record(0, 1));
    processor.ingest(record(0, 11));
    processor.drainEmissions();
    processor.ingest(record(0, 2));
    assert.equal(processor.metrics.lateRecords, 1);
    assert.equal(processor.metrics.updateMisses, 1);
    assert.deepEqual(processor.drainEmissions(), []);
    processor.close();
});

test('seed 26: an idle unseen partition stops stalling the stream watermark', async () => {
    const { clock, processor } = makeProcessor(26, { idleTimeoutMs: 100 });
    processor.ingest(record(0, 11));
    processor.ingest(record(0, 21));
    assert.equal(processor.watermark(), -Infinity);
    assert.deepEqual(processor.drainEmissions(), []);

    await clock.runFor(99);
    assert.equal(processor.watermark(), -Infinity);
    await clock.runFor(1);
    assert.equal(processor.watermark(), 21);
    assert.equal(processor.drainEmissions()[0].window.startMs, 10);
    assert.ok(processor.metrics.idleTransitions >= 1);
    processor.close();
});

test('seed 27: sliding windows use event time while processing time stays separate', () => {
    const { clock, processor } = makeProcessor(27, {
        partitions: 1,
        window: { type: 'sliding', sizeMs: 10, slideMs: 5 },
    });
    const first = processor.ingest(record(0, 12));
    assert.equal(first.processingTimeMs, clock.now());
    assert.deepEqual(first.windows, [
        { startMs: 5, endMs: 15 },
        { startMs: 10, endMs: 20 },
    ]);
    assert.ok(first.windows.every((window) => window.startMs < 100),
        'window bounds must not be derived from the much larger processing clock');

    processor.ingest(record(0, 21));
    assert.deepEqual(
        processor.drainEmissions().map((emission) => emission.window),
        [{ startMs: 5, endMs: 15 }, { startMs: 10, endMs: 20 }],
    );
    processor.close();
});

test('seed 28: watermark traces validate and replay byte-identically', () => {
    function trace(seed) {
        const { processor, rng } = makeProcessor(seed, {
            partitions: 1,
            allowedLatenessMs: 2,
            latePolicy: LATE_POLICIES.SIDE_OUTPUT,
            runId: `watermark-${seed}`,
        });
        for (const eventTimeMs of [3, 12, 5, 24]) {
            processor.ingest(record(0, eventTimeMs, rng.range(100, 500)));
        }
        assert.ok(processor.events.every((event) => validateEvent(event).ok));
        const json = JSON.stringify(processor.events);
        processor.close();
        return json;
    }

    assert.equal(trace(28), trace(28));
});
