'use strict';

const { getDeployment, getHpa, getPdb, getService, isReadyPod, stable } = require('./state');
const { rolloutFloor } = require('./controllers');

function compact(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null));
}

function fingerprint(details) {
    return stable(compact({
        invariant: details.invariant,
        violationClass: details.violationClass,
        resourceId: details.resourceId,
        expected: details.expected,
        observed: details.observed,
    }));
}

function failure(details, summary, evidence = {}) {
    const exact = fingerprint(details);
    return {
        invariant: exact.invariant,
        violationClass: exact.violationClass,
        resourceId: exact.resourceId,
        expected: exact.expected,
        observed: exact.observed,
        fingerprint: exact,
        signature: JSON.stringify(exact),
        summary,
        evidence: stable(evidence),
    };
}

function pass(invariant, summary, evidence = {}) {
    return { invariant, status: 'pass', ok: true, summary, evidence: stable(evidence) };
}

function failed(problem) {
    return {
        invariant: problem.invariant,
        status: 'fail',
        ok: false,
        summary: problem.summary,
        evidence: problem.evidence,
        failure: problem,
    };
}

function serviceAvailability(state) {
    const service = getService(state);
    const observed = service.observed.endpointPodIds.length;
    const expected = service.desired.minimumReady;
    if (observed >= expected) {
        return pass('cloud.service.minimum-availability', `${observed} endpoints satisfy the minimum of ${expected}`, {
            resourceId: service.id, expected, observed,
        });
    }
    return failed(failure({
        invariant: 'cloud.service.minimum-availability',
        violationClass: 'SERVICE_CAPACITY_COLLAPSE',
        resourceId: service.id,
        expected,
        observed,
    }, `service ${service.name} has ${observed} endpoints; ${expected} are required`, {
        endpointPodIds: service.observed.endpointPodIds,
    }));
}

function rolloutSafety(state) {
    const deployment = getDeployment(state);
    const observed = deployment.observed.ready;
    const expected = rolloutFloor(deployment);
    if (!deployment.rollout.active || deployment.rollout.oldPodsTerminated === 0 || observed >= expected) {
        return pass('cloud.deployment.rollout-availability', 'rollout remains inside maxUnavailable', {
            resourceId: deployment.id, expected, observed, active: deployment.rollout.active,
        });
    }
    return failed(failure({
        invariant: 'cloud.deployment.rollout-availability',
        violationClass: 'ROLLOUT_AVAILABILITY_VIOLATION',
        resourceId: deployment.id,
        expected,
        observed,
    }, `rollout left ${observed} ready replicas below its floor of ${expected}`, {
        desiredReplicas: deployment.desired.replicas,
        maxUnavailable: deployment.desired.strategy.maxUnavailable,
    }));
}

function endpointCorrectness(state) {
    const service = getService(state);
    const bad = service.observed.endpointPodIds.find((podId) => {
        const pod = state.resources.pods.find((candidate) => candidate.id === podId);
        return !isReadyPod(pod, state);
    });
    if (!bad) {
        return pass('cloud.service.ready-endpoints-only', 'every traffic target is a ready pod', {
            resourceId: service.id, endpoints: service.observed.endpointPodIds.length,
        });
    }
    return failed(failure({
        invariant: 'cloud.service.ready-endpoints-only',
        violationClass: 'TRAFFIC_TO_UNREADY_POD',
        resourceId: service.id,
        expected: 'READY',
        observed: bad,
    }, `service ${service.name} routes traffic to unready ${bad}`, { podId: bad }));
}

function zoneSurvivability(state) {
    const deployment = getDeployment(state);
    const podCpu = deployment.desired.podRequests.cpuMillicores;
    const podMemory = deployment.desired.podRequests.memoryMb;
    let worst = Infinity;
    let worstZone = null;
    for (const zone of state.resources.zones) {
        const remaining = state.resources.nodes.filter((node) => node.zoneId !== zone.id && node.ready);
        const cpuSlots = Math.floor(remaining.reduce((sum, node) => sum + node.capacity.cpuMillicores, 0) / podCpu);
        const memorySlots = Math.floor(remaining.reduce((sum, node) => sum + node.capacity.memoryMb, 0) / podMemory);
        const capacity = Math.min(cpuSlots, memorySlots);
        if (capacity < worst) { worst = capacity; worstZone = zone.id; }
    }
    const expected = deployment.desired.replicas;
    if (worst >= expected) {
        return pass('cloud.zone.survivability', 'every single-zone loss leaves sufficient schedulable capacity', {
            resourceId: worstZone, expected, observed: worst,
        });
    }
    return failed(failure({
        invariant: 'cloud.zone.survivability',
        violationClass: 'ZONE_SURVIVABILITY_VIOLATION',
        resourceId: worstZone,
        expected,
        observed: worst,
    }, `loss of ${worstZone} leaves capacity ${worst} below required ${expected}`));
}

function pdbSemantics(state) {
    const budget = getPdb(state);
    const unsafe = state.history.disruptions.find((decision) => (
        decision.voluntary && decision.allowed && decision.availableAfter < budget.desired.minAvailable
    ));
    if (!unsafe) {
        return pass('cloud.pdb.voluntary-disruption', 'voluntary disruptions preserve minAvailable', {
            resourceId: budget.id,
            minAvailable: budget.desired.minAvailable,
            decisions: state.history.disruptions.length,
        });
    }
    return failed(failure({
        invariant: 'cloud.pdb.voluntary-disruption',
        violationClass: 'PDB_SEMANTICS_VIOLATION',
        resourceId: budget.id,
        expected: budget.desired.minAvailable,
        observed: unsafe.availableAfter,
    }, 'a voluntary disruption was admitted below minAvailable', unsafe));
}

function hpaCapacity(state) {
    const hpa = getHpa(state);
    const deployment = getDeployment(state);
    const metricAge = state.clockMs - hpa.observed.sampledAtMs;
    const expected = Math.max(
        hpa.desired.minReplicas,
        Math.min(hpa.desired.maxReplicas,
            Math.ceil(deployment.desired.replicas * state.traffic.cpuPercent / hpa.desired.targetMetric)),
    );
    const latestSample = state.history.hpaSamples[state.history.hpaSamples.length - 1];
    const staleUnderPressure = latestSample?.stale === true
        && state.traffic.cpuPercent > hpa.desired.targetMetric
        && metricAge > 1000
        && hpa.observed.currentMetric < hpa.desired.targetMetric;
    if (!staleUnderPressure) {
        return pass('cloud.hpa.capacity-alignment', 'autoscaler metrics are fresh enough for current pressure', {
            resourceId: hpa.id, expected, observed: hpa.observed.recommendation, metricAge,
        });
    }
    return failed(failure({
        invariant: 'cloud.hpa.capacity-alignment',
        violationClass: 'AUTOSCALER_CAPACITY_MISMATCH',
        resourceId: hpa.id,
        expected,
        observed: hpa.observed.recommendation,
    }, 'HPA retained an indefinitely stale low metric during sustained pressure', {
        currentTrafficMetric: state.traffic.cpuPercent,
        observedMetric: hpa.observed.currentMetric,
        metricAge,
    }));
}

function evaluateCloudInvariants(state) {
    const checks = [
        endpointCorrectness(state),
        pdbSemantics(state),
        serviceAvailability(state),
        rolloutSafety(state),
        zoneSurvivability(state),
        hpaCapacity(state),
    ];
    const first = checks.find((check) => !check.ok);
    return { ok: !first, failure: first?.failure || null, checks };
}

function failureFingerprint(value) {
    if (!value) return null;
    if (value.failure) return failureFingerprint(value.failure);
    if (value.fingerprint) return stable(value.fingerprint);
    if (value.invariant && value.violationClass) return fingerprint(value);
    return null;
}

function sameCloudFailure(left, right) {
    const a = failureFingerprint(left);
    const b = failureFingerprint(right);
    return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

module.exports = {
    endpointCorrectness,
    evaluateCloudInvariants,
    failureFingerprint,
    hpaCapacity,
    pdbSemantics,
    rolloutSafety,
    sameCloudFailure,
    serviceAvailability,
    zoneSurvivability,
};
