'use strict';

const { POD_PHASE, RESOURCE_TYPE } = require('./resources');
const {
    getDeployment,
    getHpa,
    getPdb,
    getService,
    isActivePod,
    isReadyPod,
    recomputeObserved,
} = require('./state');

function controllerAvailable(state, name) {
    return (state.controllers[name]?.restartUntilMs || 0) <= state.clockMs;
}

function newPod(state, deployment) {
    const ordinal = state.counters.nextPodOrdinal++;
    return {
        id: `pod/api-${ordinal}`,
        name: `api-${ordinal}`,
        type: RESOURCE_TYPE.POD,
        deploymentId: deployment.id,
        version: deployment.desired.version,
        phase: POD_PHASE.PENDING,
        ready: false,
        nodeId: null,
        requests: { ...deployment.desired.podRequests },
        tolerations: deployment.desired.tolerations.map((item) => ({ ...item })),
        createdAtMs: state.clockMs,
        readyAtMs: null,
        terminationStartedAtMs: null,
    };
}

function terminatePod(state, pod, reason) {
    if (!pod || !isActivePod(pod)) return false;
    pod.phase = POD_PHASE.TERMINATING;
    pod.ready = false;
    pod.terminationStartedAtMs = state.clockMs;
    pod.terminationReason = reason;
    for (const service of state.resources.services) {
        service.observed.endpointPodIds = service.observed.endpointPodIds
            .filter((podId) => podId !== pod.id);
    }
    return true;
}

function rolloutFloor(deployment) {
    const effectiveDesired = Math.min(deployment.desired.replicas, deployment.rollout.startedReady);
    return Math.max(0, effectiveDesired - deployment.desired.strategy.maxUnavailable);
}

function reconcileDeployment(state, mutant = {}) {
    if (!controllerAvailable(state, 'deployment')) return { changed: false, reason: 'controller-restarting' };
    const deployment = getDeployment(state);
    recomputeObserved(state);
    const active = state.resources.pods.filter((pod) => pod.deploymentId === deployment.id && isActivePod(pod));
    const desired = deployment.desired.replicas;
    const result = { changed: false, created: null, terminated: null };

    if (deployment.rollout.active) {
        const targetPods = active.filter((pod) => pod.version === deployment.desired.version);
        const maxTotal = desired + deployment.desired.strategy.maxSurge;
        if (targetPods.length < desired && active.length < maxTotal) {
            const created = newPod(state, deployment);
            state.resources.pods.push(created);
            result.created = created.id;
            result.changed = true;
        }

        recomputeObserved(state);
        const oldPods = state.resources.pods
            .filter((pod) => pod.deploymentId === deployment.id
                && isActivePod(pod)
                && pod.version !== deployment.desired.version)
            .sort((left, right) => right.id.localeCompare(left.id));
        const terminatingReady = state.resources.pods.filter((pod) => (
            pod.deploymentId === deployment.id
            && pod.phase === POD_PHASE.TERMINATING
            && pod.wasReadyWhenTerminated
        )).length;
        const accountedReady = deployment.observed.ready
            + (mutant.ignoreTerminatingForMaxUnavailable ? terminatingReady : 0);
        const candidate = oldPods[0];
        if (candidate && accountedReady - (isReadyPod(candidate, state) ? 1 : 0) >= rolloutFloor(deployment)) {
            candidate.wasReadyWhenTerminated = isReadyPod(candidate, state);
            if (terminatePod(state, candidate, 'rollout')) {
                deployment.rollout.oldPodsTerminated += 1;
                result.terminated = candidate.id;
                result.changed = true;
            }
        }
        const remainingOld = state.resources.pods.some((pod) => (
            pod.deploymentId === deployment.id
            && isActivePod(pod)
            && pod.version !== deployment.desired.version
        ));
        const readyTargets = state.resources.pods.filter((pod) => (
            pod.deploymentId === deployment.id
            && pod.version === deployment.desired.version
            && isReadyPod(pod, state)
        )).length;
        if (!remainingOld && readyTargets >= desired) {
            deployment.rollout.active = false;
            state.operations.rollout = false;
        }
    } else if (active.length < desired) {
        const created = newPod(state, deployment);
        state.resources.pods.push(created);
        result.created = created.id;
        result.changed = true;
    } else if (active.length > desired) {
        const candidate = active.slice().sort((left, right) => right.id.localeCompare(left.id))[0];
        if (terminatePod(state, candidate, 'scale-down')) {
            result.terminated = candidate.id;
            result.changed = true;
        }
    }
    recomputeObserved(state);
    return result;
}

function reconcileEndpoints(state, mutant = {}) {
    if (!controllerAvailable(state, 'endpoints')) return { changed: false, reason: 'controller-restarting' };
    const service = getService(state);
    const targetPods = state.resources.pods.filter((pod) => {
        if (mutant.endpointIncludesUnready) {
            return isActivePod(pod) && pod.nodeId !== null;
        }
        return isReadyPod(pod, state);
    }).map((pod) => pod.id).sort();
    return {
        changed: JSON.stringify(targetPods) !== JSON.stringify(service.observed.endpointPodIds.slice().sort()),
        endpointPodIds: targetPods,
    };
}

function applyEndpointSnapshot(state, endpointPodIds) {
    const service = getService(state);
    service.observed.endpointPodIds = endpointPodIds.slice().sort();
    service.observed.lastPropagationAtMs = state.clockMs;
    return service.observed.endpointPodIds;
}

function reconcileHpa(state, mutant = {}) {
    if (!controllerAvailable(state, 'hpa')) return { changed: false, reason: 'controller-restarting' };
    const hpa = getHpa(state);
    const deployment = getDeployment(state);
    const elapsed = state.clockMs - hpa.observed.lastReconcileAtMs;
    if (elapsed < hpa.reconciliationIntervalMs) {
        return { changed: false, reason: 'reconciliation-interval', retryAfterMs:
            hpa.reconciliationIntervalMs - elapsed };
    }
    hpa.observed.lastReconcileAtMs = state.clockMs;
    const staleFault = state.faults.staleMetricValue !== null
        && (mutant.staleHpaIndefinitely || state.clockMs < state.faults.staleMetricUntilMs);
    const metric = staleFault ? state.faults.staleMetricValue : state.traffic.cpuPercent;
    if (!staleFault) {
        state.faults.staleMetricValue = null;
        state.faults.staleMetricUntilMs = 0;
    }
    hpa.observed.currentMetric = metric;
    if (!staleFault) {
        hpa.observed.sampledAtMs = Math.max(0, state.clockMs - hpa.metricCollectionDelayMs);
    }
    hpa.active = metric !== hpa.desired.targetMetric;
    const current = Math.max(1, deployment.desired.replicas);
    const raw = Math.ceil(current * metric / hpa.desired.targetMetric);
    const recommendation = Math.max(hpa.desired.minReplicas, Math.min(hpa.desired.maxReplicas, raw));
    hpa.observed.recommendation = recommendation;
    state.history.hpaSamples.push({ atMs: state.clockMs, metric, recommendation, stale: staleFault });
    const stabilized = state.clockMs - hpa.observed.lastScaleAtMs >= hpa.stabilizationWindowMs;
    if (recommendation !== deployment.desired.replicas && stabilized) {
        const before = deployment.desired.replicas;
        deployment.desired.replicas = recommendation;
        hpa.observed.lastScaleAtMs = state.clockMs;
        recomputeObserved(state);
        return { changed: true, from: before, to: recommendation, metric, stale: staleFault };
    }
    return { changed: false, recommendation, metric, stale: staleFault };
}

function voluntaryDisruptionAllowed(state, pod) {
    recomputeObserved(state);
    const pdb = getPdb(state);
    const readyCost = isReadyPod(pod, state) ? 1 : 0;
    const availableAfter = getDeployment(state).observed.ready - readyCost;
    return { allowed: availableAfter >= pdb.desired.minAvailable, availableAfter, readyCost };
}

module.exports = {
    applyEndpointSnapshot,
    controllerAvailable,
    reconcileDeployment,
    reconcileEndpoints,
    reconcileHpa,
    rolloutFloor,
    terminatePod,
    voluntaryDisruptionAllowed,
};
