'use strict';

const { stable } = require('./state');

const EDGE_TYPE = Object.freeze({
    OWNS: 'OWNS',
    RUNS_ON: 'RUNS_ON',
    ROUTES_TO: 'ROUTES_TO',
    LOCATED_IN: 'LOCATED_IN',
    SELECTS: 'SELECTS',
    PROTECTS: 'PROTECTS',
    SCALES: 'SCALES',
});

function graphNode(resource, features) {
    return { id: resource.id, type: resource.type, features: stable(features) };
}

function infrastructureGraph(state) {
    const nodes = [];
    const edges = [];
    for (const zone of state.resources.zones) {
        nodes.push(graphNode(zone, { degraded: zone.degraded }));
    }
    for (const node of state.resources.nodes) {
        nodes.push(graphNode(node, {
            cpuCapacity: node.capacity.cpuMillicores,
            memoryMb: node.capacity.memoryMb,
            ready: node.ready,
            draining: node.draining,
            taints: node.taints,
            zone: node.zoneId,
        }));
        edges.push({ from: node.id, to: node.zoneId, type: EDGE_TYPE.LOCATED_IN });
    }
    for (const deployment of state.resources.deployments) {
        nodes.push(graphNode(deployment, {
            desiredReplicas: deployment.desired.replicas,
            desiredVersion: deployment.desired.version,
            maxSurge: deployment.desired.strategy.maxSurge,
            maxUnavailable: deployment.desired.strategy.maxUnavailable,
            observed: deployment.observed,
            rolloutActive: deployment.rollout.active,
        }));
    }
    for (const pod of state.resources.pods) {
        nodes.push(graphNode(pod, {
            version: pod.version,
            phase: pod.phase,
            ready: pod.ready,
            cpuMillicores: pod.requests.cpuMillicores,
            memoryMb: pod.requests.memoryMb,
        }));
        edges.push({ from: pod.deploymentId, to: pod.id, type: EDGE_TYPE.OWNS });
        if (pod.nodeId) edges.push({ from: pod.id, to: pod.nodeId, type: EDGE_TYPE.RUNS_ON });
    }
    for (const service of state.resources.services) {
        nodes.push(graphNode(service, {
            minimumReady: service.desired.minimumReady,
            endpointCount: service.observed.endpointPodIds.length,
            endpointPodIds: service.observed.endpointPodIds.slice().sort(),
        }));
        edges.push({ from: service.id, to: 'deployment/api', type: EDGE_TYPE.SELECTS });
        for (const podId of service.observed.endpointPodIds) {
            edges.push({ from: service.id, to: podId, type: EDGE_TYPE.ROUTES_TO });
        }
    }
    for (const hpa of state.resources.hpas) {
        nodes.push(graphNode(hpa, {
            minReplicas: hpa.desired.minReplicas,
            maxReplicas: hpa.desired.maxReplicas,
            targetMetric: hpa.desired.targetMetric,
            currentMetric: hpa.observed.currentMetric,
            sampledAtMs: hpa.observed.sampledAtMs,
            recommendation: hpa.observed.recommendation,
            active: hpa.active,
        }));
        edges.push({ from: hpa.id, to: 'deployment/api', type: EDGE_TYPE.SCALES });
    }
    for (const pdb of state.resources.pdbs) {
        nodes.push(graphNode(pdb, {
            minAvailable: pdb.desired.minAvailable,
            disruptionsAllowed: pdb.observed.disruptionsAllowed,
        }));
        edges.push({ from: pdb.id, to: 'deployment/api', type: EDGE_TYPE.PROTECTS });
    }
    nodes.sort((left, right) => left.id.localeCompare(right.id));
    edges.sort((left, right) => (
        left.from.localeCompare(right.from)
        || left.to.localeCompare(right.to)
        || left.type.localeCompare(right.type)
    ));
    return stable({
        schemaVersion: 1,
        kind: 'cloudproof.infrastructure-graph',
        atMs: state.clockMs,
        nodes,
        edges,
    });
}

function canonicalGraphSerialization(graph) {
    if (!graph || graph.kind !== 'cloudproof.infrastructure-graph') {
        throw new TypeError('expected a CloudProof infrastructure graph');
    }
    return JSON.stringify(stable(graph));
}

module.exports = { EDGE_TYPE, canonicalGraphSerialization, infrastructureGraph };
