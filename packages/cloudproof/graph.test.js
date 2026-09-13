'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { infrastructureGraph } = require('./graph');
const { evaluateCloudInvariants, sameCloudFailure } = require('./invariants');
const { POD_PHASE } = require('./resources');
const { chooseNode } = require('./scheduler');
const { createFlagshipState, recomputeObserved } = require('./state');

test('flagship state separates desired and observed deployment state', () => {
    const state = createFlagshipState({ seed: 1337 });
    const deployment = state.resources.deployments[0];
    assert.deepEqual(deployment.desired.strategy, { maxSurge: 1, maxUnavailable: 1 });
    assert.equal(deployment.desired.replicas, 6);
    assert.deepEqual(deployment.observed, {
        replicas: 6, running: 6, ready: 6, pending: 0, terminating: 0,
    });
    deployment.desired.replicas = 8;
    assert.equal(deployment.observed.replicas, 6);
});

test('heterogeneous graph contains the bounded resource and edge vocabularies', () => {
    const graph = infrastructureGraph(createFlagshipState({ seed: 1337 }));
    assert.deepEqual([...new Set(graph.nodes.map((node) => node.type))].sort(), [
        'Deployment', 'HPA', 'Node', 'PDB', 'Pod', 'Service', 'Zone',
    ]);
    assert.deepEqual([...new Set(graph.edges.map((edge) => edge.type))].sort(), [
        'LOCATED_IN', 'OWNS', 'PROTECTS', 'ROUTES_TO', 'RUNS_ON', 'SCALES', 'SELECTS',
    ]);
    assert.deepEqual(graph, infrastructureGraph(createFlagshipState({ seed: 1337 })));
});

test('scheduler enforces readiness, capacity, taints, tolerations, and deterministic zone spreading', () => {
    const state = createFlagshipState();
    const pod = {
        requests: { cpuMillicores: 500, memoryMb: 512 },
        tolerations: [],
    };
    assert.equal(chooseNode(state, pod), null, 'untolerated NoSchedule taint blocks placement');
    pod.tolerations.push({ key: 'cloudproof.io/tier', value: 'workload', effect: 'NoSchedule' });
    assert.equal(chooseNode(state, pod).id, 'node/node-a');
    state.resources.nodes[0].ready = false;
    assert.equal(chooseNode(state, pod).id, 'node/node-b');
});

test('cloud failure identity includes invariant, class, resource, expected, and observed', () => {
    const state = createFlagshipState();
    state.resources.pods.slice(0, 3).forEach((pod) => {
        pod.phase = POD_PHASE.FAILED;
        pod.ready = false;
    });
    state.resources.services[0].observed.endpointPodIds = state.resources.pods.slice(3).map((pod) => pod.id);
    recomputeObserved(state);
    const result = evaluateCloudInvariants(state);
    assert.equal(result.failure.violationClass, 'SERVICE_CAPACITY_COLLAPSE');
    assert.deepEqual(result.failure.fingerprint, {
        expected: 4,
        invariant: 'cloud.service.minimum-availability',
        observed: 3,
        resourceId: 'service/api',
        violationClass: 'SERVICE_CAPACITY_COLLAPSE',
    });
    assert.equal(sameCloudFailure(result, JSON.parse(JSON.stringify(result))), true);
    assert.equal(sameCloudFailure(result, { failure: { ...result.failure, observed: 2,
        fingerprint: { ...result.failure.fingerprint, observed: 2 } } }), false);
});
