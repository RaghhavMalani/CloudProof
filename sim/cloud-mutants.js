'use strict';

const CORRECT_CLOUD_MODEL = Object.freeze({
    id: 'correct',
    description: 'Defensible simplified Kubernetes reconciliation semantics.',
    expectedViolationClass: null,
    flags: Object.freeze({}),
});

const CLOUD_MUTANTS = Object.freeze([
    Object.freeze({
        id: 'endpoint-includes-unready',
        label: 'M1 endpoint bug',
        description: 'The endpoint controller publishes scheduled pods before readiness succeeds.',
        expectedViolationClass: 'TRAFFIC_TO_UNREADY_POD',
        flags: Object.freeze({ endpointIncludesUnready: true }),
    }),
    Object.freeze({
        id: 'rollout-ignores-terminating',
        label: 'M2 rollout accounting bug',
        description: 'Terminating replicas are counted as available while enforcing maxUnavailable.',
        expectedViolationClass: 'ROLLOUT_AVAILABILITY_VIOLATION',
        flags: Object.freeze({ ignoreTerminatingForMaxUnavailable: true }),
    }),
    Object.freeze({
        id: 'hpa-stale-indefinitely',
        label: 'M3 stale HPA bug',
        description: 'An old low metric remains authoritative indefinitely during pressure.',
        expectedViolationClass: 'AUTOSCALER_CAPACITY_MISMATCH',
        flags: Object.freeze({ staleHpaIndefinitely: true }),
    }),
]);

function getCloudMutant(id = 'correct') {
    if (!id || id === 'correct') return CORRECT_CLOUD_MODEL;
    const mutant = CLOUD_MUTANTS.find((candidate) => candidate.id === id);
    if (!mutant) throw new TypeError(`unknown cloud controller mutant: ${id}`);
    return mutant;
}

module.exports = { CLOUD_MUTANTS, CORRECT_CLOUD_MODEL, getCloudMutant };
