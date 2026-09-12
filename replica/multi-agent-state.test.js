'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentState } = require('./agent-state');
const { RaftNode } = require('./raft');

const SNAPSHOT = {
    id: 'snapshot:multi-agent-policy-v1',
    resources: { policy: 'refund-v5', model: 'frozen-decision-tape-v1' },
};

function orderOperations({ amountCents, owner, terminalStatus = null }) {
    const operations = [
        { op: 'increment', field: 'compensatedCents', value: amountCents },
        { op: 'append-unique', field: 'financialOwners', value: owner },
    ];
    if (terminalStatus) {
        operations.push(
            { op: 'append-unique', field: 'terminalStates', value: terminalStatus },
            { op: 'set', field: 'status', value: terminalStatus },
        );
    }
    return operations;
}

function createExecution(state, executionId, index) {
    return state.apply({
        op: 'agent.execution.create',
        executionId,
        workflow: executionId.split(':')[0],
        snapshot: SNAPSHOT,
        initialState: { orderId: 4821 },
    }, { index });
}

function recordPlan(state, executionId, operations, index, version = 17) {
    return state.apply({
        op: 'agent.execution.plan',
        executionId,
        readSet: [{ resourceId: 'order:4821', version }],
        writeSet: [{ resourceId: 'order:4821', operations }],
    }, { index });
}

function authorize(state, executionId, effectId, index) {
    return state.apply({
        op: 'agent.effect.authorize-resource',
        executionId,
        effectId,
        logicalAction: 'financial-resolution',
        parameters: { orderId: 4821 },
        snapshotId: SNAPSHOT.id,
    }, { index });
}

test('semantic OCC fences two locally valid agents that read the same order version', () => {
    const state = new AgentState();
    state.apply({
        op: 'agent.resource.create',
        resourceId: 'order:4821',
        version: 17,
        state: {
            orderValueCents: 899900,
            compensatedCents: 0,
            status: 'PAID',
            terminalStates: [],
            financialOwners: [],
        },
    }, { index: 1 });
    createExecution(state, 'refund-agent:4821', 2);
    createExecution(state, 'recovery-agent:4821', 3);

    recordPlan(state, 'refund-agent:4821', orderOperations({
        amountCents: 899900,
        owner: 'refund-agent',
        terminalStatus: 'REFUNDED',
    }), 4);
    recordPlan(state, 'recovery-agent:4821', orderOperations({
        amountCents: 899900,
        owner: 'customer-recovery-agent',
    }), 5);

    const refund = authorize(state, 'refund-agent:4821', 'effect:refund:4821', 6);
    const recovery = authorize(state, 'recovery-agent:4821', 'effect:credit:4821', 7);

    assert.equal(refund.ok, true);
    assert.equal(recovery.ok, false);
    assert.equal(recovery.error, 'RESOURCE_VERSION_CONFLICT');
    assert.equal(recovery.resourceId, 'order:4821');
    assert.equal(recovery.expectedVersion, 17);
    assert.equal(recovery.actualVersion, 18);
    assert.equal(recovery.decision, 'REVALIDATE');
    assert.equal(state.get('recovery-agent:4821').effects.length, 0);
    assert.deepEqual(state.getResource('order:4821'), {
        resourceId: 'order:4821',
        version: 18,
        state: {
            compensatedCents: 899900,
            financialOwners: ['refund-agent'],
            orderValueCents: 899900,
            status: 'REFUNDED',
            terminalStates: ['REFUNDED'],
        },
        lastMutation: {
            effectId: 'effect:refund:4821',
            executionId: 'refund-agent:4821',
            index: 6,
            type: 'RESOURCE_EFFECT_AUTHORIZED',
        },
    });

    const duplicate = authorize(state, 'refund-agent:4821', 'effect:refund:4821', 8);
    assert.equal(duplicate.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(state.getResource('order:4821').version, 18);
});

test('all resources in the read set validate before any resource is mutated', () => {
    const state = new AgentState();
    state.apply({
        op: 'agent.resource.create', resourceId: 'order:4821', version: 17,
        state: { compensatedCents: 0 },
    }, { index: 1 });
    state.apply({
        op: 'agent.resource.create', resourceId: 'customer:91', version: 4,
        state: { creditsCents: 0 },
    }, { index: 2 });
    createExecution(state, 'recovery-agent:atomic', 3);
    state.apply({
        op: 'agent.execution.plan',
        executionId: 'recovery-agent:atomic',
        readSet: [
            { resourceId: 'order:4821', version: 17 },
            { resourceId: 'customer:91', version: 3 },
        ],
        writeSet: [
            { resourceId: 'order:4821', operations: [{ op: 'increment', field: 'compensatedCents', value: 100 }] },
            { resourceId: 'customer:91', operations: [{ op: 'increment', field: 'creditsCents', value: 100 }] },
        ],
    }, { index: 4 });

    const rejected = authorize(state, 'recovery-agent:atomic', 'effect:atomic', 5);
    assert.equal(rejected.error, 'RESOURCE_VERSION_CONFLICT');
    assert.equal(rejected.resourceId, 'customer:91');
    assert.equal(state.getResource('order:4821').version, 17);
    assert.equal(state.getResource('order:4821').state.compensatedCents, 0);
    assert.equal(state.getResource('customer:91').version, 4);
    assert.equal(state.getResource('customer:91').state.creditsCents, 0);
});

test('resource state and execution plans replay byte-identically', () => {
    const commands = [
        {
            op: 'agent.resource.create', resourceId: 'order:4821', version: 17,
            state: { compensatedCents: 0, financialOwners: [], terminalStates: [], status: 'PAID' },
        },
        {
            op: 'agent.execution.create', executionId: 'refund-agent:replay',
            workflow: 'refund-agent', snapshot: SNAPSHOT,
        },
        {
            op: 'agent.execution.plan', executionId: 'refund-agent:replay',
            readSet: [{ resourceId: 'order:4821', version: 17 }],
            writeSet: [{
                resourceId: 'order:4821',
                operations: orderOperations({ amountCents: 899900, owner: 'refund-agent', terminalStatus: 'REFUNDED' }),
            }],
        },
        {
            op: 'agent.effect.authorize-resource', executionId: 'refund-agent:replay',
            effectId: 'effect:refund:replay', logicalAction: 'refund', parameters: {}, snapshotId: SNAPSHOT.id,
        },
    ];
    const left = new AgentState();
    const right = new AgentState();
    commands.forEach((command, index) => left.apply(command, { index: index + 1 }));
    commands.forEach((command, index) => right.apply(command, { index: index + 1 }));
    assert.equal(JSON.stringify(left.snapshot()), JSON.stringify(right.snapshot()));
});

test('Raft restart rebuilds versioned resources and their authorizing execution', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miniraft-multi-agent-replay-'));
    const storagePath = path.join(directory, 'state.json');
    const commands = [
        {
            op: 'agent.resource.create', resourceId: 'order:4821', version: 17,
            state: { compensatedCents: 0, financialOwners: [], terminalStates: [], status: 'PAID' },
        },
        {
            op: 'agent.execution.create', executionId: 'refund-agent:raft-replay',
            workflow: 'refund-agent', snapshot: SNAPSHOT,
        },
        {
            op: 'agent.execution.plan', executionId: 'refund-agent:raft-replay',
            readSet: [{ resourceId: 'order:4821', version: 17 }],
            writeSet: [{
                resourceId: 'order:4821',
                operations: orderOperations({ amountCents: 899900, owner: 'refund-agent', terminalStatus: 'REFUNDED' }),
            }],
        },
        {
            op: 'agent.effect.authorize-resource', executionId: 'refund-agent:raft-replay',
            effectId: 'effect:refund:raft-replay', logicalAction: 'refund', parameters: {}, snapshotId: SNAPSHOT.id,
        },
    ];
    try {
        const first = new RaftNode({
            replicaId: 'replica1', peers: [], storagePath, autoStart: false,
        });
        await first._startElection();
        for (const [seqNo, command] of commands.entries()) {
            const outcome = await first.clientAppend({ ...command, clientId: 'multi-agent-test', seqNo });
            assert.equal(outcome.committed, true);
            assert.equal(outcome.result.ok, true);
        }
        const beforeResource = first.stateMachine.agentResource('order:4821');
        const beforeExecution = first.stateMachine.agentExecution('refund-agent:raft-replay');
        first.stop();

        const restarted = new RaftNode({
            replicaId: 'replica1', peers: [], storagePath, autoStart: false,
        });
        assert.deepEqual(restarted.stateMachine.agentResource('order:4821'), beforeResource);
        assert.deepEqual(restarted.stateMachine.agentExecution('refund-agent:raft-replay'), beforeExecution);
        assert.equal(restarted.stateMachine.agentResource('order:4821').version, 18);
        restarted.stop();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
