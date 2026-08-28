'use strict';

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function fingerprint({ invariant, violationClass, executionId, effectId, workerId, resource }) {
    return stable(compact({ invariant, violationClass, executionId, effectId, workerId, resource }));
}

function signatureOf(value) {
    return JSON.stringify(stable(value));
}

function failure(details, summary, evidence = {}) {
    const exact = fingerprint(details);
    return {
        invariant: exact.invariant,
        violationClass: exact.violationClass,
        fingerprint: exact,
        signature: signatureOf(exact),
        summary,
        evidence: stable(evidence),
    };
}

function failureFingerprint(value) {
    if (!value) return null;
    if (value.failure) return failureFingerprint(value.failure);
    if (value.fingerprint) return stable(value.fingerprint);
    if (value.invariant && value.violationClass) return fingerprint(value);
    return null;
}

function sameFailure(original, candidate) {
    const left = failureFingerprint(original);
    const right = failureFingerprint(candidate);
    return left !== null && right !== null && signatureOf(left) === signatureOf(right);
}

function pass(id, summary, evidence = {}) {
    return { id, status: 'pass', ok: true, summary, evidence: stable(evidence) };
}

function failed(id, problem) {
    return { id, status: 'fail', ok: false, summary: problem.summary, evidence: problem.evidence, failure: problem };
}

function atMostOnceObservableEffect(world, effectId) {
    const observed = world.observations.filter((item) => item.effectId === effectId);
    if (observed.length <= 1) {
        return pass('agent.effect.at-most-once', `observable effect ${effectId} occurred ${observed.length} time(s)`, {
            effectId,
            observed: observed.length,
        });
    }
    return failed('agent.effect.at-most-once', failure({
        invariant: 'agent.effect.at-most-once',
        violationClass: 'DUPLICATE_OBSERVABLE_EFFECT',
        executionId: world.executionId,
        effectId,
    }, `observable effect ${effectId} occurred ${observed.length} times`, {
        providerOperationIds: observed.map((item) => item.providerOperationId),
        actionIds: observed.map((item) => item.actionId),
    }));
}

function noMutationWithoutAuthorizedSnapshot(world) {
    const untracked = world.observations.find((item) => !item.intentCommitted);
    if (untracked) {
        return failed('agent.effect.authorized-snapshot', failure({
            invariant: 'agent.effect.authorized-snapshot',
            violationClass: 'UNTRACKED_EXTERNAL_EFFECT',
            executionId: world.executionId,
            effectId: untracked.effectId,
        }, 'an external mutation occurred without a durable effect intent', untracked));
    }

    const unauthorized = world.observations.find((item) => !item.snapshotAuthorized);
    if (unauthorized) {
        return failed('agent.effect.authorized-snapshot', failure({
            invariant: 'agent.effect.authorized-snapshot',
            violationClass: 'UNAUTHORIZED_SNAPSHOT_MUTATION',
            executionId: world.executionId,
            effectId: unauthorized.effectId,
            resource: unauthorized.snapshotId,
        }, 'an external mutation used a semantic snapshot that was never authorized', unauthorized));
    }
    return pass('agent.effect.authorized-snapshot', 'every observable mutation has a durable intent and authorized snapshot', {
        observed: world.observations.length,
    });
}

function semanticConflictBlocksMutation(world) {
    const unsafe = world.semanticMutations.find((item) => item.semanticAuthorized === false);
    if (!unsafe) {
        return pass('agent.semantic-conflict.blocks-mutation', 'semantic drift blocks mutation until an approved snapshot transition', {
            checkedMutations: world.semanticMutations.length,
        });
    }
    return failed('agent.semantic-conflict.blocks-mutation', failure({
        invariant: 'agent.semantic-conflict.blocks-mutation',
        violationClass: 'SEMANTIC_ISOLATION_VIOLATION',
        executionId: world.executionId,
        resource: unsafe.availableSnapshotId,
    }, 'execution mutated state under a stale semantic snapshot', unsafe));
}

function staleWorkerCannotAdvance(world) {
    const stale = world.staleAdvances[0];
    if (!stale) {
        return pass('agent.execution.worker-fence', 'no stale worker advanced the durable execution cursor', {
            workers: Object.keys(world.workers).sort(),
        });
    }
    return failed('agent.execution.worker-fence', failure({
        invariant: 'agent.execution.worker-fence',
        violationClass: 'CONCURRENT_EXECUTION_RACE',
        executionId: world.executionId,
        workerId: stale.workerId,
    }, 'a stale racing worker advanced after its expected step was superseded', stale));
}

function unfinishedEffectSurvivesRecovery(world) {
    const lost = world.lostResults[0];
    if (!lost) {
        return pass('agent.effect.recovery', 'unfinished effects and recorded results survive worker recovery', {
            recoveries: world.recoveries,
        });
    }
    return failed('agent.effect.recovery', failure({
        invariant: 'agent.effect.recovery',
        violationClass: 'UNNECESSARY_RECONCILIATION',
        executionId: world.executionId,
        effectId: lost.effectId,
    }, 'a recorded external result disappeared during worker recovery', lost));
}

function causalEffectOrder(world, expectedOrder = []) {
    const observed = world.observations.map((item) => item.logicalAction);
    let last = -1;
    for (const logicalAction of expectedOrder) {
        const index = observed.indexOf(logicalAction);
        if (index < 0) continue;
        if (index < last) {
            const item = world.observations[index];
            return failed('agent.effect.causal-order', failure({
                invariant: 'agent.effect.causal-order',
                violationClass: 'CAUSAL_EFFECT_ORDER_VIOLATION',
                executionId: world.executionId,
                effectId: item.effectId,
            }, `effect ${logicalAction} occurred outside the required causal order`, {
                expectedOrder,
                observed,
            }));
        }
        last = index;
    }
    return pass('agent.effect.causal-order', 'observable effects respect the workflow causal order', {
        expectedOrder,
        observed,
    });
}

function evaluateAgentInvariants(world, specification) {
    const checks = [
        noMutationWithoutAuthorizedSnapshot(world),
        ...specification.effects.map((effect) => atMostOnceObservableEffect(world, effect.effectId)),
        semanticConflictBlocksMutation(world),
        staleWorkerCannotAdvance(world),
        unfinishedEffectSurvivesRecovery(world),
        causalEffectOrder(world, specification.causalOrder),
    ];
    const firstFailure = checks.find((check) => !check.ok);
    return { ok: !firstFailure, failure: firstFailure ? firstFailure.failure : null, checks };
}

module.exports = {
    atMostOnceObservableEffect,
    causalEffectOrder,
    evaluateAgentInvariants,
    failureFingerprint,
    noMutationWithoutAuthorizedSnapshot,
    sameFailure,
    semanticConflictBlocksMutation,
    staleWorkerCannotAdvance,
    unfinishedEffectSurvivesRecovery,
};
