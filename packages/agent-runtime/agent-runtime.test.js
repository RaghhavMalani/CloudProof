'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    AgentExecution,
    EffectLedger,
    EFFECT_STATUS,
    RESUME_DECISION,
    decideResume,
    makeEffectId,
    makeSemanticSnapshot,
} = require('./index');

const context = {
    workflow: 'refund-agent-v7',
    model: 'model-2026-08-20',
    prompt: 'sha256:a892',
    policy: 'refund-policy-v4',
    retrievalIndex: 'support-index-v81',
    toolSchemas: { payments: 'v2', orders: 'v14' },
};

test('effect identity is stable across object key order and retries', () => {
    const first = makeEffectId('refund-4821', 'refund-payment', { orderId: 4821, amountCents: 899900 });
    const retry = makeEffectId('refund-4821', 'refund-payment', { amountCents: 899900, orderId: 4821 });
    assert.equal(first, retry);
});

test('a committed effect returns its recorded result instead of executing again', () => {
    const ledger = new EffectLedger();
    const intent = ledger.recordIntent({
        executionId: 'refund-4821', logicalAction: 'refund-payment',
        parameters: { orderId: 4821, amountCents: 899900 }, snapshotId: 'snapshot-1',
    });
    ledger.markDispatched(intent.record.effectId);
    ledger.recordResult(intent.record.effectId, { providerRefundId: 'rf_4821' });
    ledger.commit(intent.record.effectId);

    const resolution = ledger.resolve(intent.record.effectId);
    assert.equal(resolution.action, 'return-recorded-result');
    assert.equal(resolution.record.status, EFFECT_STATUS.EFFECT_COMMITTED);
    assert.equal(resolution.record.attempts, 1);
});

test('an ambiguous remote effect requires reconciliation after restart', () => {
    const execution = new AgentExecution({
        executionId: 'refund-4821', workflow: 'refund-agent-v7', snapshot: makeSemanticSnapshot(context),
    });
    execution.advance('policy-authorized', { authorized: true });
    const intent = execution.ledger.recordIntent({
        executionId: execution.executionId, logicalAction: 'refund-payment',
        parameters: { orderId: 4821, amountCents: 899900 }, snapshotId: execution.snapshot.id,
        atStep: execution.step,
    });
    execution.ledger.markDispatched(intent.record.effectId);
    execution.ledger.requireReconciliation(intent.record.effectId);

    const resumed = AgentExecution.resume(execution.checkpoint());
    assert.equal(resumed.step, 1);
    assert.equal(resumed.version, 2);
    assert.equal(resumed.semanticConflict, null);
    assert.equal(resumed.ledger.resolve(intent.record.effectId).action, 'reconcile');
});

test('resume preserves Raft checkpoint version and semantic-conflict evidence', () => {
    const execution = AgentExecution.resume({
        executionId: 'refund-4821',
        workflow: 'refund-agent-v7',
        snapshot: makeSemanticSnapshot(context),
        step: 4,
        version: 12,
        state: { authorized: true },
        status: 'PAUSED_SEMANTIC_CONFLICT',
        semanticConflict: { decision: 'require-approval', changed: ['policy'] },
        history: [],
        effects: [],
    });

    assert.equal(execution.checkpoint().version, 12);
    assert.deepEqual(execution.checkpoint().semanticConflict.changed, ['policy']);
});

test('semantic snapshot changes force the configured resume policy', () => {
    const pinned = makeSemanticSnapshot(context);
    const available = makeSemanticSnapshot({ ...context, policy: 'refund-policy-v5', model: 'model-2026-08-21' });
    const result = decideResume({
        pinned,
        available,
        compatibility: { policy: RESUME_DECISION.REQUIRE_APPROVAL, model: RESUME_DECISION.REVALIDATE },
    });

    assert.equal(result.decision, RESUME_DECISION.REQUIRE_APPROVAL);
    assert.deepEqual(result.changed, ['model', 'policy']);
});

test('removing a semantic resource is detected instead of crashing comparison', () => {
    const pinned = makeSemanticSnapshot(context);
    const withoutIndex = { ...context };
    delete withoutIndex.retrievalIndex;
    const result = decideResume({ pinned, available: makeSemanticSnapshot(withoutIndex) });

    assert.equal(result.decision, RESUME_DECISION.REVALIDATE);
    assert.deepEqual(result.changed, ['retrievalIndex']);
});
