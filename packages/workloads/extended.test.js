'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WORKLOADS, runWorkload } = require('./index');

test('feed fan-out preserves read-your-writes while ordinary reads remain eventual', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'feed'));
    const authorReads = result.state.reads.filter((read) => read.sessionId === 'session-web');
    const eventualRead = result.state.reads.find((read) => read.sessionId === 'anonymous-session');

    assert.equal(authorReads[0].consistency, 'session-fallback');
    assert.ok(authorReads.every((read) => read.postIds.includes('post-41')));
    assert.deepEqual(eventualRead.postIds, []);
    assert.deepEqual(result.state.timelines.get('home-us').postIds, ['post-41']);
    assert.equal(result.state.duplicateFanout, 1);
});

test('a stale feed cache is bypassed because of the session frontier alone', () => {
    const workload = WORKLOADS.find((item) => item.id === 'feed');
    const state = workload.createState(1);
    workload.applyCommittedEntry(state, {
        op: 'publish', sessionId: 'session-isolation', author: 'author', postId: 'own-post', body: 'mine',
    });

    const read = workload.applyCommittedEntry(state, {
        op: 'read-home', sessionId: 'session-isolation', cacheId: 'home-us',
    });

    assert.equal(read.consistency, 'session-fallback');
    assert.deepEqual(read.missingAtCache, ['own-post']);
    assert.deepEqual(read.postIds, ['own-post']);
});

test('CRDT replicas converge despite child-before-parent and different delivery orders', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'collaboration'));

    assert.deepEqual(result.state.documents, {
        alice: 'RAFT!!?', bob: 'RAFT!!?', relay: 'RAFT!!?',
    });
    assert.equal(result.state.offlineAccepted, 3);
    assert.equal(result.state.orphanDeliveries.length, 2);
    assert.equal(result.state.duplicateDeliveries, 1);

    const operationSets = Object.values(result.state.replicas)
        .map((replica) => [...replica.ops.keys()].sort());
    assert.deepEqual(operationSets[0], operationSets[1]);
    assert.deepEqual(operationSets[1], operationSets[2]);
});

test('concurrent CRDT inserts converge independently of arrival order', () => {
    const workload = WORKLOADS.find((item) => item.id === 'collaboration');
    const state = workload.createState(1);
    const alice = { id: 'alice:9', after: 'base:4', char: 'x', actor: 'alice', counter: 9 };
    const bob = { id: 'bob:9', after: 'base:4', char: 'y', actor: 'bob', counter: 9 };

    workload.applyCommittedEntry(state, { op: 'local-insert', replica: 'alice', operation: alice });
    workload.applyCommittedEntry(state, { op: 'local-insert', replica: 'bob', operation: bob });
    workload.applyCommittedEntry(state, { op: 'deliver', replica: 'relay', operation: bob });
    workload.applyCommittedEntry(state, { op: 'deliver', replica: 'relay', operation: alice });
    workload.applyCommittedEntry(state, { op: 'deliver', replica: 'alice', operation: bob });
    workload.applyCommittedEntry(state, { op: 'deliver', replica: 'bob', operation: alice });

    assert.deepEqual(state.documents, {
        alice: 'RAFTxy', bob: 'RAFTxy', relay: 'RAFTxy',
    });
});

test('2PC recovery completes one durable outcome across both ledgers', () => {
    const result = runWorkload(WORKLOADS.find((item) => item.id === 'settlement'));
    const committed = result.state.transactions.get('transfer-88');
    const aborted = result.state.transactions.get('transfer-89');

    assert.deepEqual(result.state.balances, { 'ledger-a': 5800, 'ledger-b': 6200 });
    assert.equal(committed.decision, 'commit');
    assert.equal(committed.finalized, true);
    assert.deepEqual(
        Object.values(committed.participants).map((participant) => participant.phase),
        ['committed', 'committed'],
    );
    assert.equal(aborted.decision, 'abort');
    assert.equal(aborted.finalized, true);
    assert.equal(result.state.coordinator.recoveries, 1);
    assert.equal(result.state.duplicateDecisions, 1);
    assert.equal(result.state.locked['ledger-a'], 0);
});

test('2PC prepare reserves funds without moving either visible ledger balance', () => {
    const workload = WORKLOADS.find((item) => item.id === 'settlement');
    const state = workload.createState(1);
    workload.applyCommittedEntry(state, {
        op: 'begin', txId: 'isolation-tx', source: 'ledger-a', target: 'ledger-b', amountCents: 4200,
    });
    const before = { ...state.balances };
    const vote = workload.applyCommittedEntry(state, {
        op: 'prepare', txId: 'isolation-tx', participant: 'ledger-a',
    });

    assert.equal(vote.vote, 'yes');
    assert.deepEqual(state.balances, before);
    assert.equal(state.locked['ledger-a'], 4200);
    assert.equal(state.decisionLog.size, 0);
});
