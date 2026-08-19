'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REQUIRED_INTERFACE, WORKLOADS, validateWorkload, runWorkload } = require('./index');
const { validateEvent } = require('../protocol/events');

test('every workload implements the same executable interface', () => {
    assert.equal(WORKLOADS.length, 7);
    assert.deepEqual(WORKLOADS.map((workload) => workload.id).sort(), [
        'configuration', 'dispatch', 'inventory', 'payment', 'rollout', 'streaming', 'vector-search',
    ]);
    for (const workload of WORKLOADS) {
        assert.equal(validateWorkload(workload), workload);
        for (const member of REQUIRED_INTERFACE) {
            if (member === 'actions') assert.ok(Array.isArray(workload[member]));
            else assert.equal(typeof workload[member], 'function');
        }
    }
});

test('every workload produces valid causal events and execution-scoped checks', () => {
    for (const workload of WORKLOADS) {
        const result = runWorkload(workload, { seed: 42 });
        assert.ok(result.events.length > workload.actions.length);
        assert.ok(result.events.every((event) => validateEvent(event).ok));
        assert.ok(result.invariants.length >= 3);
        assert.ok(result.invariants.every((invariant) => invariant.status !== 'fail'),
            `${workload.id}: ${result.invariants.map((item) => item.summary).join('; ')}`);
        assert.ok(result.metrics.length >= 4);
        assert.ok(result.visualization.nodes.length >= 4);
    }
});

test('lost payment reply causes two deliveries and one ledger effect', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'payment'));
    assert.equal(result.state.deliveryAttempts.get('pay-7'), 2);
    assert.equal(result.state.results.size, 1);
    assert.equal(result.state.ledgerCents, 4200);
});

test('watch resume covers every revision written during disconnect', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'configuration'));
    assert.deepEqual(result.state.controller.observed.map((change) => change.rev), [7, 8, 9]);
    assert.deepEqual(result.state.controller.reconciled, [7, 8, 9]);
});

test('slow vector shard is disclosed and HNSW filters are enforced', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'vector-search'));
    assert.deepEqual([...result.state.timedOut], [1]);
    assert.ok(result.state.merged.every((hit) => hit.payload.tenant === 'acme'));
});

test('corrupt rollout artifact never produces a mixed-version response', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'rollout'));
    assert.equal(result.state.corruptRejected, true);
    assert.equal(result.state.rollbacks, 1);
    assert.ok(result.state.responses.every((r) => r.embeddingVersion === r.indexVersion));
});

test('streaming keeps playback monotonic and the device limit intact across failover', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'streaming'));

    // Playback only ever moves forward, even though a heartbeat stamped 12 s
    // arrived after 30 s had been committed.
    const history = result.state.positionHistory.get('tv');
    assert.deepEqual(history, [0, 30000, 62000]);
    assert.equal(result.state.staleHeartbeats, 1);

    // The two-device plan is never exceeded, and the deposed leader's attempt to
    // admit a third stream is rejected on epoch rather than on capacity.
    assert.equal(result.state.peakConcurrent, 2);
    assert.deepEqual(result.state.refused.map((item) => item.reason), ['device-limit', 'stale-epoch']);
    assert.equal(result.state.leaderEpoch, 2);
});

test('a stale-epoch admission is refused even when capacity is available', () => {
    // Isolating the fencing rule from the capacity rule: with a free slot, an
    // admission authored under an old epoch must still fail. Otherwise the
    // scenario above would pass for the wrong reason.
    const workload = WORKLOADS.find((item) => item.id === 'streaming');
    const state = workload.createState(1);
    workload.applyCommittedEntry(state, { op: 'leaderepoch', epoch: 4 });
    const result = workload.applyCommittedEntry(state, {
        op: 'admit', sessionId: 'ghost', device: 'ghost', epoch: 3,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'stale-epoch');
    assert.equal(state.sessions.size, 0, 'no session may exist from a fenced admission');
});

test('dispatch fences a late accept from a superseded offer', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'dispatch'));

    assert.equal(result.state.assignments.get('ride-9').driver, 'driver-b');
    assert.equal(result.state.assignments.get('ride-12').driver, 'driver-c');

    const reasons = result.state.rejectedAccepts.map((item) => item.reason);
    assert.ok(reasons.includes('stale-offer-epoch'), 'the late accept must be fenced');
    assert.ok(reasons.includes('driver-already-assigned'), 'a busy driver must not be double booked');

    // No driver appears in two assignments.
    const drivers = [...result.state.assignments.values()].map((item) => item.driver);
    assert.equal(new Set(drivers).size, drivers.length);
});

test('inventory never oversells and an uncommitted reservation has no effect', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'inventory'));

    // The partitioned leader accepted order-3 and could not commit it. Stock at
    // that moment must be unchanged by the attempt.
    assert.equal(result.state.uncommittedAttempts.length, 1);
    assert.equal(result.state.uncommittedAttempts[0].orderId, 'order-3');

    // Conservation: nothing is created or destroyed.
    const held = [...result.state.reservations.values()]
        .filter((item) => item.state !== 'released')
        .reduce((sum, item) => sum + item.units, 0);
    assert.equal(held + result.state.stock, result.state.initialStock);
    assert.ok(result.state.stock >= 0);
    assert.deepEqual(result.state.rejected.map((item) => item.orderId), ['order-4']);
});

test('a retried reservation returns the existing hold instead of taking a second unit', () => {
    const workload = WORKLOADS.find((item) => item.id === 'inventory');
    const state = workload.createState(1);

    const first = workload.applyCommittedEntry(state, { op: 'reserve', orderId: 'o', units: 1 });
    const retry = workload.applyCommittedEntry(state, { op: 'reserve', orderId: 'o', units: 1 });

    assert.equal(first.stock, 2);
    assert.equal(retry.duplicate, true);
    assert.equal(state.stock, 2, 'the retry must not consume a second unit');
});
