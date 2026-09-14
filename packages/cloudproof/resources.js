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

function node(name, zoneId, topology = {}) {
    return {
        id: `node/${name}`,
        name,
        type: RESOURCE_TYPE.NODE,
        zoneId: `zone/${zoneId}`,
        capacity: {
            cpuMillicores: topology.nodeCpuMillicores || 4000,
            memoryMb: topology.nodeMemoryMb || 8192,
        },
        ready: true,
        draining: false,
        taints: [{ key: 'cloudproof.io/tier', value: 'workload', effect: 'NoSchedule' }],
    };
}

function pod(ordinal, nodeName, version = 'v41', topology = {}) {
    return {
        id: `pod/api-${ordinal}`,
        name: `api-${ordinal}`,
        type: RESOURCE_TYPE.POD,
        deploymentId: 'deployment/api',
        version,
        phase: POD_PHASE.READY,
        ready: true,
        nodeId: `node/${nodeName}`,
        requests: {
            cpuMillicores: topology.podCpuMillicores || 500,
            memoryMb: topology.podMemoryMb || 512,
        },
        tolerations: [{ key: 'cloudproof.io/tier', value: 'workload', effect: 'NoSchedule' }],
        createdAtMs: 0,
        readyAtMs: 0,
        terminationStartedAtMs: null,
    };
}

function deployment(topology = {}) {
    const replicas = topology.initialReplicas || 6;
    return {
        id: 'deployment/api',
        name: 'api',
        type: RESOURCE_TYPE.DEPLOYMENT,
        desired: {
            replicas,
            version: 'v41',
            strategy: {
                maxSurge: topology.maxSurge ?? 1,
                maxUnavailable: topology.maxUnavailable ?? 1,
            },
            podRequests: {
                cpuMillicores: topology.podCpuMillicores || 500,
                memoryMb: topology.podMemoryMb || 512,
            },
            tolerations: [{ key: 'cloudproof.io/tier', value: 'workload', effect: 'NoSchedule' }],
        },
        observed: { running: replicas, ready: replicas, pending: 0, terminating: 0, replicas },
        rollout: {
            active: false,
            fromVersion: 'v41',
            toVersion: null,
            startedReady: replicas,
            oldPodsTerminated: 0,
        },
    };
}

function service(topology = {}) {
    const replicas = topology.initialReplicas || 6;
    const endpointPodIds = Array.from({ length: replicas }, (_, index) => `pod/api-${index + 1}`);
    return {
        id: 'service/api',
        name: 'api',
        type: RESOURCE_TYPE.SERVICE,
        desired: { selector: { app: 'api' }, minimumReady: topology.serviceMinimumReady ?? 4 },
        observed: { endpointPodIds, lastPropagationAtMs: 0 },
    };
}

function hpa(topology = {}, traffic = {}) {
    const replicas = topology.initialReplicas || 6;
    const currentMetric = traffic.cpuPercent ?? 55;
    return {
        id: 'hpa/api',
        name: 'api',
        type: RESOURCE_TYPE.HPA,
        desired: {
            minReplicas: topology.hpaMinReplicas ?? Math.min(4, replicas),
            maxReplicas: topology.hpaMaxReplicas ?? Math.max(12, replicas),
            targetMetric: topology.hpaTarget ?? 70,
        },
        observed: {
            currentMetric,
            sampledAtMs: 0,
            recommendation: replicas,
            lastScaleAtMs: 0,
            lastReconcileAtMs: -250,
        },
        reconciliationIntervalMs: 250,
        metricCollectionDelayMs: 100,
        stabilizationWindowMs: 500,
        active: false,
    };
}

function pdb(topology = {}) {
    const replicas = topology.initialReplicas || 6;
    const minAvailable = topology.pdbMinAvailable ?? 4;
    return {
        id: 'pdb/api',
        name: 'api',
        type: RESOURCE_TYPE.PDB,
        desired: { minAvailable },
        observed: { disruptionsAllowed: Math.max(0, replicas - minAvailable), decisions: [] },
    };
}

function zoneName(index) {
    return `zone-${String.fromCharCode(97 + index)}`;
}

function nodeNames(topology) {
    const slotsPerNode = Math.max(1, Math.min(
        Math.floor(topology.nodeCpuMillicores / topology.podCpuMillicores),
        Math.floor(topology.nodeMemoryMb / topology.podMemoryMb),
    ));
    const nodesPerZone = Math.max(1, Math.ceil(topology.initialReplicas
        / (slotsPerNode * Math.max(1, topology.zones - 1))));
    const names = [];
    for (let zoneIndex = 0; zoneIndex < topology.zones; zoneIndex += 1) {
        const base = `node-${String.fromCharCode(97 + zoneIndex)}`;
        for (let ordinal = 1; ordinal <= nodesPerZone; ordinal += 1) {
            names.push({ name: ordinal === 1 ? base : `${base}-${ordinal}`, zone: zoneName(zoneIndex) });
        }
    }
    return names;
}

function createCloudResources(topology, traffic = {}) {
    const names = nodeNames(topology);
    const pods = Array.from({ length: topology.initialReplicas }, (_, index) => (
        pod(index + 1, names[index % names.length].name, 'v41', topology)
    ));
    return {
        zones: Array.from({ length: topology.zones }, (_, index) => zone(zoneName(index))),
        nodes: names.map((item) => node(item.name, item.zone, topology)),
        pods,
        deployments: [deployment(topology)],
        services: [service(topology)],
        hpas: [hpa(topology, traffic)],
        pdbs: [pdb(topology)],
    };
}

function createFlagshipResources() {
    return createCloudResources({
        zones: 3,
        initialReplicas: 6,
        maxUnavailable: 1,
        maxSurge: 1,
        pdbMinAvailable: 4,
        hpaMinReplicas: 4,
        hpaMaxReplicas: 12,
        hpaTarget: 70,
        serviceMinimumReady: 4,
        nodeCpuMillicores: 4000,
        nodeMemoryMb: 8192,
        podCpuMillicores: 500,
        podMemoryMb: 512,
    }, { cpuPercent: 55 });
}

module.exports = {
    POD_PHASE,
    RESOURCE_TYPE,
    clone,
    createCloudResources,
    createFlagshipResources,
};
