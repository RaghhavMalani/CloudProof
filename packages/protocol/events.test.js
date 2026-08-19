'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EVENT_SCHEMA_VERSION, createEvent, validateEvent } = require('./events');

test('creates a deterministic, JSON-safe causal envelope', () => {
    const event = createEvent({
        runId: 'run-a', sequence: 7, epochMs: 1050, startedAt: 1000,
        type: 'rpc.sent', data: { bytes: new Uint8Array([1, 2, 3]), missing: undefined },
    });
    assert.equal(event.schemaVersion, EVENT_SCHEMA_VERSION);
    assert.equal(event.id, 'run-a:00000007');
    assert.equal(event.time.elapsedMs, 50);
    assert.deepEqual(event.data.bytes, [1, 2, 3]);
    assert.equal(validateEvent(event).ok, true);
});

test('rejects ambiguous event types', () => {
    assert.throws(() => createEvent({
        runId: 'x', sequence: 1, epochMs: 0, startedAt: 0, type: 'sent',
    }), /invalid event type/);
});
