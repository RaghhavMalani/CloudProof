'use strict';

const POD_PHASE = Object.freeze({
    PENDING: 'PENDING',
    STARTING: 'STARTING',
    RUNNING: 'RUNNING',
    READY: 'READY',
    TERMINATING: 'TERMINATING',
    FAILED: 'FAILED',
});

const RESOURCE_TYPE = Object.freeze({
    NODE: 'Node',
    POD: 'Pod',
    DEPLOYMENT: 'Deployment',
    SERVICE: 'Service',
    HPA: 'HPA',
    PDB: 'PDB',
    ZONE: 'Zone',
});

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function zone(id) {
    return { id: `zone/${id}`, name: id, type: RESOURCE_TYPE.ZONE, degraded: false };
}

function node(name, zoneId) {
    return {
        id: `node/${name}`,
        name,
        type: RESOURCE_TYPE.NODE,
        zoneId: `zone/${zoneId}`,
        capacity: { cpuMillicores: 4000, memoryMb: 8192 },
        ready: true,
        draining: false,
        taints: [{ key: 'cloudproof.io/tier', value: 'workload', effect: 'NoSchedule' }],
    };
}

function pod(ordinal, nodeName, version = 'v41') {
    return {
        id: `pod/api-${ordinal}`,
        name: `api-${ordinal}`,
        type: RESOURCE_TYPE.POD,
        deploymentId: 'deployment/api',
        version,
        phase: POD_PHASE.READY,
        ready: true,
        nodeId: `node/${nodeName}`,
        requests: { cpuMillicores: 500, memoryMb: 512 },
        tolerations: [{ key: 'cloudproof.io/tier', value: 'workload', effect: 'NoSchedule' }],
        createdAtMs: 0,
        readyAtMs: 0,
        terminationStartedAtMs: null,
    };
}

function deployment() {
    return {
        id: 'deployment/api',
        name: 'api',
        type: RESOURCE_TYPE.DEPLOYMENT,
        desired: {
            replicas: 6,
            version: 'v41',
            strategy: { maxSurge: 1, maxUnavailable: 1 },
            podRequests: { cpuMillicores: 500, memoryMb: 512 },
            tolerations: [{ key: 'cloudproof.io/tier', value: 'workload', effect: 'NoSchedule' }],
        },
        observed: { running: 6, ready: 6, pending: 0, terminating: 0, replicas: 6 },
        rollout: {
            active: false,
            fromVersion: 'v41',
            toVersion: null,
            startedReady: 6,
            oldPodsTerminated: 0,
        },
    };
}

function service() {
    const endpointPodIds = Array.from({ length: 6 }, (_, index) => `pod/api-${index + 1}`);
    return {
        id: 'service/api',
        name: 'api',
        type: RESOURCE_TYPE.SERVICE,
        desired: { selector: { app: 'api' }, minimumReady: 4 },
        observed: { endpointPodIds, lastPropagationAtMs: 0 },
    };
}

function hpa() {
    return {
        id: 'hpa/api',
        name: 'api',
        type: RESOURCE_TYPE.HPA,
        desired: { minReplicas: 4, maxReplicas: 12, targetMetric: 70 },
        observed: {
            currentMetric: 55,
            sampledAtMs: 0,
            recommendation: 6,
            lastScaleAtMs: 0,
            lastReconcileAtMs: -250,
        },
        reconciliationIntervalMs: 250,
        metricCollectionDelayMs: 100,
        stabilizationWindowMs: 500,
        active: false,
    };
}

function pdb() {
    return {
        id: 'pdb/api',
        name: 'api',
        type: RESOURCE_TYPE.PDB,
        desired: { minAvailable: 4 },
        observed: { disruptionsAllowed: 2, decisions: [] },
    };
}

function createFlagshipResources() {
    return {
        zones: [zone('zone-a'), zone('zone-b'), zone('zone-c')],
        nodes: [node('node-a', 'zone-a'), node('node-b', 'zone-b'), node('node-c', 'zone-c')],
        pods: [
            pod(1, 'node-a'), pod(2, 'node-b'), pod(3, 'node-c'),
            pod(4, 'node-a'), pod(5, 'node-b'), pod(6, 'node-c'),
        ],
        deployments: [deployment()],
        services: [service()],
        hpas: [hpa()],
        pdbs: [pdb()],
    };
}

module.exports = {
    POD_PHASE,
    RESOURCE_TYPE,
    clone,
    createFlagshipResources,
};
