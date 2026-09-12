'use strict';

const MUTANTS = Object.freeze([
    Object.freeze({
        id: 'blind-retry',
        label: 'M1 blind retry',
        description: 'An ambiguous external effect is dispatched again with a fresh provider key.',
        expectedViolationClass: 'DUPLICATE_OBSERVABLE_EFFECT',
        flags: Object.freeze({ blindRetry: true }),
    }),
    Object.freeze({
        id: 'dispatch-before-intent',
        label: 'M2 dispatch before intent',
        description: 'The provider mutation happens before durable dispatch authorization exists.',
        expectedViolationClass: 'UNTRACKED_EXTERNAL_EFFECT',
        flags: Object.freeze({ dispatchBeforeIntent: true }),
    }),
    Object.freeze({
        id: 'no-worker-fence',
        label: 'M3 no worker fence',
        description: 'A stale racing worker bypasses the expected-step compare-and-set.',
        expectedViolationClass: 'CONCURRENT_EXECUTION_RACE',
        flags: Object.freeze({ noWorkerFence: true }),
    }),
    Object.freeze({
        id: 'volatile-semantic-conflict',
        label: 'M4 volatile semantic conflict',
        description: 'Policy drift is remembered only by the leader and disappears on failover.',
        expectedViolationClass: 'SEMANTIC_ISOLATION_VIOLATION',
        flags: Object.freeze({ volatileSemanticConflict: true }),
    }),
    Object.freeze({
        id: 'result-forgotten-on-resume',
        label: 'M5 result forgotten on resume',
        description: 'A recorded provider result is lost when a worker resumes.',
        expectedViolationClass: 'UNNECESSARY_RECONCILIATION',
        flags: Object.freeze({ forgetResultOnResume: true }),
    }),
]);

const CORRECT_RUNTIME = Object.freeze({
    id: 'correct',
    label: 'Stage 4 correct runtime',
    description: 'The Raft-backed agent state machine without injected mutations.',
    expectedViolationClass: null,
    flags: Object.freeze({}),
});

function getMutant(id = 'correct') {
    if (!id || id === 'correct') return CORRECT_RUNTIME;
    const mutant = MUTANTS.find((candidate) => candidate.id === id);
    if (!mutant) throw new TypeError(`unknown agent runtime mutant: ${id}`);
    return mutant;
}

module.exports = { CORRECT_RUNTIME, MUTANTS, getMutant };
