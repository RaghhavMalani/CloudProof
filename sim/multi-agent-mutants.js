'use strict';

const CORRECT_MULTI_AGENT_RUNTIME = Object.freeze({
    id: 'correct',
    description: 'Atomically validates every resource version before authorizing effects.',
    targetAgents: ['refund-agent', 'customer-recovery-agent'],
    flags: Object.freeze({}),
    expectedViolationClass: null,
});

const MULTI_AGENT_MUTANTS = Object.freeze([
    Object.freeze({
        id: 'authorize-stale-read',
        description: 'Marks an effect authorized before discovering that its read set is stale.',
        targetAgents: ['refund-agent', 'customer-recovery-agent'],
        flags: Object.freeze({ authorizeStaleRead: true }),
        expectedViolationClass: 'STALE_SHARED_RESOURCE_READ',
    }),
    Object.freeze({
        id: 'unfenced-compensation',
        description: 'Lets the recovery agent apply a stale compensation decision.',
        targetAgents: ['refund-agent', 'customer-recovery-agent'],
        flags: Object.freeze({ applyStaleAgent: 'customer-recovery-agent' }),
        expectedViolationClass: 'OVER_COMPENSATION',
    }),
    Object.freeze({
        id: 'unfenced-terminal-transition',
        description: 'Lets fraud review commit a terminal state from a stale order read.',
        targetAgents: ['refund-agent', 'fraud-review-agent'],
        flags: Object.freeze({ applyStaleAgent: 'fraud-review-agent' }),
        expectedViolationClass: 'MUTUALLY_EXCLUSIVE_TERMINALS',
    }),
    Object.freeze({
        id: 'split-financial-owner-commit',
        description: 'Writes financial ownership before version validation completes.',
        targetAgents: ['refund-agent', 'fraud-review-agent'],
        flags: Object.freeze({ partialOwnerBeforeFence: 'fraud-review-agent' }),
        expectedViolationClass: 'DOUBLE_FINANCIAL_OWNER',
    }),
]);

function getMultiAgentMutant(id = 'correct') {
    if (id === 'correct') return CORRECT_MULTI_AGENT_RUNTIME;
    const mutant = MULTI_AGENT_MUTANTS.find((candidate) => candidate.id === id);
    if (!mutant) throw new TypeError(`unknown multi-agent runtime mutant: ${id}`);
    return mutant;
}

module.exports = {
    CORRECT_MULTI_AGENT_RUNTIME,
    MULTI_AGENT_MUTANTS,
    getMultiAgentMutant,
};
