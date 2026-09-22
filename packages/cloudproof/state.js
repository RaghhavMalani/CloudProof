'use strict';

const { POD_PHASE, clone, createCloudResources, createFlagshipResources } = require('./resources');

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
    }
    return value;
}

function byId(items, id) {
    return items.find((item) => item.id === id) || null;
}

function isActivePod(pod) {
    return ![POD_PHASE.TERMINATING, POD_PHASE.FAILED].includes(pod.phase);
}

function isReadyPod(pod, state = null) {
    if (!pod || pod.phase !== POD_PHASE.READY || !pod.ready) return false;
    if (!state || !pod.nodeId) return true;
    const targetNode = byId(state.resources.nodes, pod.nodeId);
    return Boolean(targetNode?.ready);
}

function recomputeObserved(state) {
    for (const deployment of state.resources.deployments) {
        const pods = state.resources.pods.filter((pod) => pod.deploymentId === deployment.id);
        const active = pods.filter(isActivePod);
        deployment.observed = {
            replicas: active.length,
            running: active.filter((pod) => [POD_PHASE.RUNNING, POD_PHASE.READY].includes(pod.phase)).length,
            ready: active.filter((pod) => isReadyPod(pod, state)).length,
            pending: active.filter((pod) => [POD_PHASE.PENDING, POD_PHASE.STARTING].includes(pod.phase)).length,
            terminating: pods.filter((pod) => pod.phase === POD_PHASE.TERMINATING).length,
        };
    }
    for (const budget of state.resources.pdbs) {
        const deployment = state.resources.deployments[0];
        budget.observed.disruptionsAllowed = Math.max(
            0,
            deployment.observed.ready - budget.desired.minAvailable,
        );
    }
    state.timeMs = state.clockMs;
    return state;
}

function stateEnvelope({ seed, resources, traffic, nextPodOrdinal }) {
    const state = {
        schemaVersion: 1,
        kind: 'cloudproof.cluster-state',
        seed,
        clockMs: 0,
        timeMs: 0,
        resources,
        traffic,
        faults: {
            readinessDelayMs: 0,
            imagePullDelayMs: 0,
            endpointPropagationDelayMs: 100,
            staleMetricUntilMs: 0,
            staleMetricValue: null,
        },
        controllers: {
            deployment: { restartUntilMs: 0 },
            scheduler: { restartUntilMs: 0 },
            kubelet: { restartUntilMs: 0 },
            endpoints: { restartUntilMs: 0 },
            hpa: { restartUntilMs: 0 },
        },
        counters: { nextPodOrdinal },
        operations: { rollout: false, drainNodes: [], crashedNodes: [] },
        history: { disruptions: [], hpaSamples: [] },
    };
    return recomputeObserved(state);
}

function createCloudState({ seed = 1337, topology, traffic = {}, placement = null } = {}) {
    if (!topology) return createFlagshipState({ seed });
    const initialTraffic = {
        cpuPercent: traffic.cpuPercent ?? 55,
        latencyMs: traffic.latencyMs ?? 18,
        requestsPerSecond: traffic.requestsPerSecond ?? 120,
    };
    return stateEnvelope({
        seed,
        resources: createCloudResources(topology, initialTraffic, placement),
        traffic: initialTraffic,
        nextPodOrdinal: topology.initialReplicas + 1,
    });
}

function createFlagshipState({ seed = 1337 } = {}) {
    return stateEnvelope({
        seed,
        resources: createFlagshipResources(),
        traffic: { cpuPercent: 55, latencyMs: 18, requestsPerSecond: 120 },
        nextPodOrdinal: 7,
    });
}

function getDeployment(state, id = 'deployment/api') {
    return byId(state.resources.deployments, id);
}

function getService(state, id = 'service/api') {
    return byId(state.resources.services, id);
}

function getHpa(state, id = 'hpa/api') {
    return byId(state.resources.hpas, id);
}

function getPdb(state, id = 'pdb/api') {
    return byId(state.resources.pdbs, id);
}

function canonicalState(state) {
    return stable(clone(state));
}

module.exports = {
    byId,
    canonicalState,
    clone,
    createCloudState,
    createFlagshipState,
    getDeployment,
    getHpa,
    getPdb,
    getService,
    isActivePod,
    isReadyPod,
    recomputeObserved,
    stable,
};
