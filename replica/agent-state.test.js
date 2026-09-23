'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentState, EFFECT_STATUS, EXECUTION_STATUS } = require('./agent-state');
const { RaftNode } = require('./raft');

const snapshotV4 = {
    id: 'snapshot:policy-v4',
    resources: {
        model: 'model-2026-08-20',
        policy: 'refund-policy-v4',
        prompt: 'sha256:a892',
        retrievalIndex: 'support-index-v81',
    },
};

function stream() {
    return [
        {
            op: 'agent.execution.create', executionId: 'refund-4821',
            workflow: 'refund-agent-v7', snapshot: snapshotV4,
        },
        {
            op: 'agent.execution.advance', executionId: 'refund-4821',
            expectedStep: 0, label: 'policy-authorized', patch: { authorized: true },
        },
        {
            op: 'agent.effect.intent', executionId: 'refund-4821', effectId: 'effect:refund-4821',
            logicalAction: 'refund-payment', parameters: { amountCents: 899900, orderId: 4821 },
            snapshotId: snapshotV4.id,
        },
        {
            op: 'agent.effect.dispatch', executionId: 'refund-4821', effectId: 'effect:refund-4821',
        },
        {
            op: 'agent.effect.reconciliation-required', executionId: 'refund-4821',
            effectId: 'effect:refund-4821',
        },
        {
            op: 'agent.effect.result', executionId: 'refund-4821', effectId: 'effect:refund-4821',
            result: { providerRefundId: 'rf_4821', amountCents: 899900 },
        },
        {
            op: 'agent.effect.commit', executionId: 'refund-4821', effectId: 'effect:refund-4821',
        },
        {
            op: 'agent.semantic-conflict.detect', executionId: 'refund-4821',
            availableSnapshot: {
                id: 'snapshot:policy-v5',
                resources: { ...snapshotV4.resources, policy: 'refund-policy-v5' },
            },
            changed: ['policy'], decision: 'require-approval',
        },
    ];
}

test('committed commands replay into byte-equivalent execution and effect state', () => {
    const left = new AgentState();
    const right = new AgentState();
    for (const [index, command] of stream().entries()) left.apply(command, { index });
    for (const [index, command] of stream().entries()) right.apply(command, { index });

    assert.equal(JSON.stringify(left.snapshot()), JSON.stringify(right.snapshot()));
    const execution = left.get('refund-4821');
    assert.equal(execution.step, 1);
    assert.equal(execution.effects[0].attempts, 1);
    assert.equal(execution.status, EXECUTION_STATUS.PAUSED_SEMANTIC_CONFLICT);
    assert.equal(execution.effects[0].status, EFFECT_STATUS.EFFECT_COMMITTED);
});

test('expectedStep fences racing workers', () => {
    const state = new AgentState();
    state.apply(stream()[0], { index: 0 });

    const winner = state.apply({
        op: 'agent.execution.advance', executionId: 'refund-4821',
        expectedStep: 0, label: 'worker-a', patch: { winner: 'a' },
    }, { index: 1 });
    const loser = state.apply({
        op: 'agent.execution.advance', executionId: 'refund-4821',
        expectedStep: 0, label: 'worker-b', patch: { winner: 'b' },
    }, { index: 2 });

    assert.equal(winner.ok, true);
    assert.equal(loser.error, 'STALE_EXECUTION_VERSION');
    assert.equal(loser.actualStep, 1);
    assert.equal(state.get('refund-4821').state.winner, 'a');
});

test('unfinished effects reconcile while recorded results never redispatch', () => {
    const state = new AgentState();
    const commands = stream().slice(0, 4);
    commands.forEach((command, index) => state.apply(command, { index }));
    const unfinished = state.get('refund-4821').effects[0];
    assert.equal(unfinished.status, EFFECT_STATUS.INTENT_RECORDED);

    state.apply(stream()[4], { index: 4 });
    assert.equal(state.get('refund-4821').effects[0].status, EFFECT_STATUS.RECONCILIATION_REQUIRED);
    state.apply(stream()[5], { index: 5 });
    const rejectedDispatch = state.apply(stream()[3], { index: 6 });
    assert.equal(rejectedDispatch.error, 'EFFECT_NOT_DISPATCHABLE');
});

test('semantic conflict and approved transition are consensus state', () => {
    const state = new AgentState();
    state.apply(stream()[0], { index: 0 });
    const snapshotV5 = {
        id: 'snapshot:policy-v5',
        resources: { ...snapshotV4.resources, policy: 'refund-policy-v5' },
    };
    state.apply({
        op: 'agent.semantic-conflict.detect', executionId: 'refund-4821',
        availableSnapshot: snapshotV5, changed: ['policy'], decision: 'require-approval',
    }, { index: 1 });

    assert.equal(state.get('refund-4821').status, EXECUTION_STATUS.PAUSED_SEMANTIC_CONFLICT);
    const denied = state.apply({
        op: 'agent.snapshot.transition', executionId: 'refund-4821',
        fromSnapshotId: snapshotV4.id, toSnapshot: snapshotV5,
    }, { index: 2 });
    assert.equal(denied.error, 'SEMANTIC_APPROVAL_REQUIRED');

    const approved = state.apply({
        op: 'agent.snapshot.transition', executionId: 'refund-4821',
        fromSnapshotId: snapshotV4.id, toSnapshot: snapshotV5,
        approval: { approved: true, approvedBy: 'risk-operator' },
    }, { index: 3 });
    assert.equal(approved.ok, true);
    assert.equal(state.get('refund-4821').snapshot.id, snapshotV5.id);
    assert.equal(state.get('refund-4821').status, EXECUTION_STATUS.RUNNING);
});

test('Raft restart rebuilds AgentExecution entirely from committed entries', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudproof-agent-replay-'));
    const storagePath = path.join(directory, 'state.json');
    try {
        const first = new RaftNode({
            replicaId: 'replica1', peers: [], storagePath, autoStart: false,
        });
        await first._startElection();
        for (const [seqNo, command] of stream().entries()) {
            const outcome = await first.clientAppend({ ...command, clientId: 'agent-test', seqNo });
            assert.equal(outcome.committed, true);
            assert.equal(outcome.result.ok, true);
        }
        const before = first.stateMachine.agentExecution('refund-4821');
        first.stop();

        const restarted = new RaftNode({
            replicaId: 'replica1', peers: [], storagePath, autoStart: false,
        });
        assert.deepEqual(restarted.stateMachine.agentExecution('refund-4821'), before);
        assert.equal(restarted.stateMachine.agentExecution('refund-4821').status, EXECUTION_STATUS.PAUSED_SEMANTIC_CONFLICT);
        assert.equal(restarted.stateMachine.agentExecution('refund-4821').semanticConflict.availableSnapshot.id, 'snapshot:policy-v5');
        assert.equal(restarted.stateMachine.agentExecution('refund-4821').effects[0].attempts, 1);
        restarted.stop();
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
