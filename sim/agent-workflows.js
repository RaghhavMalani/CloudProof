'use strict';

const { makeEffectId, makeSemanticSnapshot } = require('../packages/agent-runtime');

const REFUND_CONTEXT = Object.freeze({
    workflow: 'refund-agent-v7',
    model: 'model-2026-08-20',
    prompt: 'sha256:a892',
    policy: 'refund-policy-v4',
    retrievalIndex: 'support-index-v81',
    toolSchemas: { payments: 'v2', orders: 'v14', crm: 'v6', mail: 'v3' },
});

function effect(executionId, key, logicalAction, parameters, result, predecessors = []) {
    return Object.freeze({
        key,
        effectId: makeEffectId(executionId, logicalAction, parameters),
        logicalAction,
        parameters: Object.freeze({ ...parameters }),
        result: Object.freeze({ ...result }),
        predecessors: Object.freeze(predecessors.slice()),
    });
}

function refundWorkflow() {
    const executionId = 'refund:order_4821';
    const snapshot = makeSemanticSnapshot(REFUND_CONTEXT);
    const effects = [
        effect(executionId, 'refund', 'payment.refund', {
            orderId: 4821, amountCents: 899900, currency: 'INR',
        }, {
            providerRefundId: 'rf_4821_01', status: 'refunded',
        }),
        effect(executionId, 'crm', 'crm.refunded', { orderId: 4821 }, {
            status: 'refunded',
        }, ['payment.refund']),
        effect(executionId, 'email', 'email.confirmation', {
            orderId: 4821, template: 'refund-confirmed-v3',
        }, {
            messageId: 'msg_4821_01',
        }, ['payment.refund', 'crm.refunded']),
    ];
    return Object.freeze({
        id: 'refund',
        executionId,
        workflow: REFUND_CONTEXT.workflow,
        snapshot,
        nextSnapshot: makeSemanticSnapshot({ ...REFUND_CONTEXT, policy: 'refund-policy-v5' }),
        effects: Object.freeze(effects),
        causalOrder: Object.freeze(effects.map((item) => item.logicalAction)),
    });
}

const WORKFLOWS = Object.freeze({ refund: refundWorkflow() });

function getAgentWorkflow(id = 'refund') {
    const workflow = WORKFLOWS[id];
    if (!workflow) throw new TypeError(`unknown agent workflow: ${id}`);
    return workflow;
}

module.exports = { REFUND_CONTEXT, WORKFLOWS, getAgentWorkflow };
