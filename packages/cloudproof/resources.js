'use strict';

const { nodeNameList, normalizePlacement, zoneName } = require('./placement');

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


// Without a placement, pods are dealt round-robin over the node list exactly as
// before Phase II-A.2, which keeps every earlier replay fingerprint intact. With
// one, pod ordinals are still assigned in order but each zone receives its
// requested share, dealt round-robin over that zone's own nodes.
function podNodeNames(topology, names, placement) {
    if (!placement) return names.map((item) => item.name);
    if (placement.podsPerNode) {
        const assignments = [];
        placement.podsPerNode.forEach((count, nodeIndex) => {
            for (let local = 0; local < count; local += 1) assignments.push(names[nodeIndex].name);
        });
        return assignments;
    }
    const byZone = Array.from({ length: topology.zones }, (_, zoneIndex) => (
        names.filter((item) => item.zone === zoneName(zoneIndex)).map((item) => item.name)
    ));
    const assignments = [];
    placement.podsPerZone.forEach((count, zoneIndex) => {
        for (let local = 0; local < count; local += 1) {
            assignments.push(byZone[zoneIndex][local % byZone[zoneIndex].length]);
        }
    });
    return assignments;
}

// The first `startingPerZone[z]` pods dealt to zone z begin STARTING: running
// on their node but not ready and not an endpoint. The pod multiset is the
// same whichever zone holds them; only the readiness-to-zone wiring moves.
function applyStartingPods(pods, names, placement) {
    if (!placement?.startingPerZone) return new Set();
    const zoneOf = new Map(names.map((item) => [`node/${item.name}`, item.zone]));
    const remaining = placement.startingPerZone.slice();
    const starting = new Set();
    for (const item of pods) {
        const zoneIndex = zoneOf.get(item.nodeId).charCodeAt(5) - 97;
        if (remaining[zoneIndex] <= 0) continue;
        remaining[zoneIndex] -= 1;
        item.phase = POD_PHASE.STARTING;
        item.ready = false;
        item.readyAtMs = null;
        starting.add(item.id);
    }
    return starting;
}

function createCloudResources(topology, traffic = {}, placement = null) {
    const normalized = normalizePlacement(topology, placement);
    const names = nodeNameList(topology, normalized?.nodesPerZone || null);
    const podNodes = podNodeNames(topology, names, normalized);
    const pods = Array.from({ length: topology.initialReplicas }, (_, index) => (
        pod(index + 1, podNodes[index % podNodes.length], 'v41', topology)
    ));
    const starting = applyStartingPods(pods, names, normalized);
    const api = service(topology);
    api.observed.endpointPodIds = api.observed.endpointPodIds.filter((podId) => !starting.has(podId));
    return {
        zones: Array.from({ length: topology.zones }, (_, index) => zone(zoneName(index))),
        nodes: names.map((item) => node(item.name, item.zone, topology)),
        pods,
        deployments: [deployment(topology)],
        services: [api],
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
