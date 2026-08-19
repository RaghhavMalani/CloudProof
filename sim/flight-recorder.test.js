'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SimCluster } = require('./cluster');
const { validateEvent } = require('../packages/protocol/events');

test('records protocol traffic, transitions, invariants, and faults in one schema', async () => {
    const cluster = new SimCluster({ seed: 17, recording: true });
    assert.ok(await cluster.awaitLeader());
    cluster.recorder.captureCluster(cluster);
    cluster.isolate(0);
    await cluster.tick(450);
    const trace = cluster.recorder.export();
    assert.ok(trace.events.length > 10);
    assert.equal(trace.events.every((event) => validateEvent(event).ok), true);
    for (const type of ['rpc.sent', 'node.role.changed', 'invariant.checked', 'fault.applied']) {
        assert.ok(trace.events.some((event) => event.type === type), `missing ${type}`);
    }
    cluster.stop();
});

test('pause-and-step advances one virtual callback', async () => {
    const cluster = new SimCluster({ seed: 3, recording: true });
    const before = cluster.clock.fired;
    assert.equal(await cluster.step(), true);
    assert.equal(cluster.clock.fired, before + 1);
    cluster.stop();
});
