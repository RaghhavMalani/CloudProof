'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
    balancedPodsPerZone,
    concentratedPodsPerZone,
    defaultNodesPerZone,
    normalizePlacement,
    roundRobinPodsPerZone,
} = require('./placement');
const { createCloudState } = require('./state');
const { normalizeTopology } = require('./topology');
const { infrastructureGraph } = require('./graph');

function podsPerZone(state) {
    const zoneOf = new Map(state.resources.nodes.map((node) => [node.id, node.zoneId]));
    const counts = new Map(state.resources.zones.map((zone) => [zone.id, 0]));
    for (const pod of state.resources.pods) counts.set(zoneOf.get(pod.nodeId), counts.get(zoneOf.get(pod.nodeId)) + 1);
    return [...counts.values()];
}

test('a null placement reproduces the historical round-robin state byte for byte', () => {
    const topology = normalizeTopology({ initialReplicas: 6, zones: 3 });
    const before = JSON.stringify(createCloudState({ seed: 7, topology }));
    const after = JSON.stringify(createCloudState({ seed: 7, topology, placement: null }));
    assert.equal(before, after);
    assert.deepEqual(roundRobinPodsPerZone(topology, defaultNodesPerZone(topology)), [2, 2, 2]);
    assert.deepEqual(roundRobinPodsPerZone(normalizeTopology({ initialReplicas: 3, zones: 2 }), [1, 1]), [2, 1]);
});

test('an explicit placement changes only RUNS_ON wiring, never the pod or node multisets', () => {
    const topology = normalizeTopology({ initialReplicas: 6, zones: 3 });
    const balanced = createCloudState({ seed: 7, topology, placement: { podsPerZone: [2, 2, 2] } });
    const concentrated = createCloudState({ seed: 7, topology, placement: { podsPerZone: [4, 1, 1] } });
    assert.deepEqual(podsPerZone(balanced), [2, 2, 2]);
    assert.deepEqual(podsPerZone(concentrated), [4, 1, 1]);
    const strip = (state) => {
        const graph = infrastructureGraph(state);
        return { nodes: graph.nodes, edges: graph.edges.filter((edge) => edge.type !== 'RUNS_ON') };
    };
    assert.deepEqual(strip(balanced), strip(concentrated));
    assert.deepEqual(concentratedPodsPerZone(topology, [1, 1, 1], 0), [6, 0, 0]);
    assert.deepEqual(concentratedPodsPerZone(normalizeTopology({ initialReplicas: 12, zones: 3 }), [1, 1, 1], 1),
        [2, 8, 2]);
    assert.deepEqual(balancedPodsPerZone(7, 3), [3, 2, 2]);
});

test('nodesPerZone moves spare capacity between zones while keeping the node multiset', () => {
    const topology = normalizeTopology({ initialReplicas: 6, zones: 3 });
    const spareInA = createCloudState({ seed: 1, topology,
        placement: { nodesPerZone: [2, 1, 1], podsPerZone: [2, 2, 2] } });
    const spareInC = createCloudState({ seed: 1, topology,
        placement: { nodesPerZone: [1, 1, 2], podsPerZone: [2, 2, 2] } });
    assert.equal(spareInA.resources.nodes.length, 4);
    assert.equal(spareInC.resources.nodes.length, 4);
    assert.deepEqual(podsPerZone(spareInA), [2, 2, 2]);
    assert.deepEqual(podsPerZone(spareInC), [2, 2, 2]);
    assert.notDeepEqual(
        spareInA.resources.nodes.map((node) => node.zoneId),
        spareInC.resources.nodes.map((node) => node.zoneId),
    );
});

test('infeasible placements are rejected before any state exists', () => {
    const topology = normalizeTopology({ initialReplicas: 6, zones: 3 });
    assert.throws(() => normalizePlacement(topology, { podsPerZone: [3, 3, 3] }), /must sum to 6/);
    assert.throws(() => normalizePlacement(topology, { podsPerZone: [6, 0] }), /length 3/);
    assert.throws(() => normalizePlacement(topology, { nodesPerZone: [0, 1, 1] }), /integers >= 1/);
    assert.throws(() => normalizePlacement(normalizeTopology({ initialReplicas: 12, zones: 3 }),
        { podsPerZone: [12, 0, 0] }), /capacity 8/);
    assert.equal(normalizePlacement(topology, null), null);
});

test('podsPerNode and startingPerZone move relations without touching multisets', () => {
    const topology = normalizeTopology({ initialReplicas: 6, zones: 3 });
    const spread = createCloudState({ seed: 1, topology, placement: { nodesPerZone: [2, 1, 1], podsPerNode: [1, 1, 2, 2] } });
    const stacked = createCloudState({ seed: 1, topology, placement: { nodesPerZone: [2, 1, 1], podsPerNode: [2, 0, 2, 2] } });
    assert.deepEqual(podsPerZone(spread), podsPerZone(stacked));
    assert.notDeepEqual(spread.resources.pods.map((pod) => pod.nodeId), stacked.resources.pods.map((pod) => pod.nodeId));
    assert.throws(() => normalizePlacement(topology, { nodesPerZone: [2, 1, 1], podsPerNode: [9, 0, 0, 0] }), /slots/);
    assert.throws(() => normalizePlacement(topology, { podsPerNode: [2, 2, 2], podsPerZone: [3, 3, 0] }), /disagrees/);
    const inside = createCloudState({ seed: 1, topology, placement: { podsPerZone: [2, 2, 2], startingPerZone: [2, 0, 0] } });
    const outside = createCloudState({ seed: 1, topology, placement: { podsPerZone: [2, 2, 2], startingPerZone: [0, 1, 1] } });
    for (const state of [inside, outside]) {
        assert.equal(state.resources.pods.filter((pod) => pod.phase === 'STARTING').length, 2);
        assert.equal(state.resources.services[0].observed.endpointPodIds.length, 4);
        assert.equal(state.resources.deployments[0].observed.ready, 4);
        assert.equal(state.resources.deployments[0].observed.pending, 2);
    }
    const graph = (state) => infrastructureGraph(state);
    const routes = (state) => JSON.stringify(graph(state).edges.filter((edge) => edge.type === 'ROUTES_TO'));
    assert.notEqual(routes(inside), routes(outside));
    assert.throws(() => normalizePlacement(topology, { podsPerZone: [2, 2, 2], startingPerZone: [3, 0, 0] }), /exceeds/);
});
