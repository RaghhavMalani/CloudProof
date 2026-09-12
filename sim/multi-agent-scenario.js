'use strict';

const { makeEffectId } = require('../packages/agent-runtime');

const ORDER_RESOURCE_ID = 'order:4821';
const ORDER_VALUE_CENTS = 899900;
const AGENT_IDS = Object.freeze([
    'refund-agent',
    'fraud-review-agent',
    'customer-recovery-agent',
]);

const INITIAL_RESOURCE = Object.freeze({
    resourceId: ORDER_RESOURCE_ID,
    version: 17,
    state: {
        orderValueCents: ORDER_VALUE_CENTS,
        compensatedCents: 0,
        status: 'PAID',
        terminalStates: [],
        financialOwners: [],
        complaintUnresolved: true,
    },
});

function operationsFor({ amountCents = 0, owner = null, terminalStatus = null }) {
    const operations = [];
    if (amountCents !== 0) {
        operations.push({ op: 'increment', field: 'compensatedCents', value: amountCents });
    }
    if (owner) operations.push({ op: 'append-unique', field: 'financialOwners', value: owner });
    if (terminalStatus) {
        operations.push(
            { op: 'append-unique', field: 'terminalStates', value: terminalStatus },
            { op: 'set', field: 'status', value: terminalStatus },
        );
    }
    return operations;
}

function decideAgent(agentId, observed) {
    const state = observed?.state;
    if (!state) return null;
    let decision = null;
    if (agentId === 'refund-agent'
        && state.status === 'PAID'
        && state.compensatedCents === 0) {
        decision = {
            logicalAction: 'refund-payment',
            amountCents: ORDER_VALUE_CENTS,
            owner: 'refund-agent',
            terminalStatus: 'REFUNDED',
        };
    } else if (agentId === 'fraud-review-agent'
        && state.status === 'PAID'
        && (state.terminalStates || []).length === 0) {
        decision = {
            logicalAction: 'settle-chargeback',
            amountCents: 0,
            owner: 'fraud-review-agent',
            terminalStatus: 'CHARGEBACK_SETTLED',
        };
    } else if (agentId === 'customer-recovery-agent'
        && state.complaintUnresolved === true
        && state.compensatedCents === 0) {
        decision = {
            logicalAction: 'grant-goodwill-credit',
            amountCents: ORDER_VALUE_CENTS,
            owner: null,
            terminalStatus: null,
        };
    }
    if (!decision) return null;
    const executionId = `${agentId}:order-4821`;
    const parameters = { orderId: 4821, amountCents: decision.amountCents, currency: 'INR' };
    return {
        ...decision,
        executionId,
        effectId: makeEffectId(executionId, decision.logicalAction, parameters),
        parameters,
        readSet: [{ resourceId: observed.resourceId, version: observed.version }],
        writeSet: [{
            resourceId: observed.resourceId,
            operations: operationsFor(decision),
        }],
    };
}

module.exports = {
    AGENT_IDS,
    INITIAL_RESOURCE,
    ORDER_RESOURCE_ID,
    ORDER_VALUE_CENTS,
    decideAgent,
    operationsFor,
};
